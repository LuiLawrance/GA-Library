"""One-time JSON -> Postgres importer for every DATA_GA/DATA_GENERAL domain.

Run manually (not part of app startup):

    .venv/Scripts/python.exe scripts/migrate_json_to_pg.py

Safe to re-run: every phase either upserts by the table's natural primary key
(sqlalchemy.dialects.postgresql.insert(...).on_conflict_do_update) or, for
tables that are pure historical logs with no natural key (card_rules is a
per-card full-replace list, card_errors/price_listings/price_sales are
append-only logs), clears and re-inserts from the current JSON each run.

Admin settings are never read from Postgres — SETTINGS.json is their sole
source of truth in every mode (see settings.py). `users` and the card
catalog / pricing domains are read from Postgres in DB mode; this run is
also a first integrity check of the schema (every foreign key below is
enforced by Postgres, not just assumed).
"""

from db.catalog_sync import (
    _chunked, _set_slug, _split_speed, build_card_row, build_edition_row, build_foil_rows, build_rule_rows,
    build_thema_rows, upsert as _upsert,
)
from db.models import (
    Card, CardError, CardRule, CardSlug, Deck, DeckCard, DeckSection, Edition, FeaturedSetGroup, Foil,
    FoilTcgOverride, InventoryBin, InventoryCard, InventorySection, MarketplaceScrapeClock, PriceListing, PriceSale,
    Set, ThemaScore, User, WatchlistEntry, WishlistEntry,
)
from db.session import get_session
from dotenv import load_dotenv
from pathlib import Path
from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

import argparse
import contextlib
import io
import json
import os

load_dotenv(".env" if os.path.exists(".env") else "env")

DIR_CARDS = Path("DATA_GA/CARDS_GA")
DIR_SETS = Path("DATA_GA/SETS_GA")
DIR_PRICING = Path("DATA_GA/PRICING_GA")
DIR_GENERAL = Path("DATA_GENERAL")
DIR_INV = Path("DATA_GA/INV_GA")
DIR_DECK_INDEX = Path("DATA_GA/DECK_GA")
DIR_DECKS = Path("DATA_GA/DECKS_GA")
DIR_WATCHLIST = Path("DATA_GA/WATCHLIST_GA")
DIR_WISH = Path("DATA_GA/WISH_GA")

# Confirmed no-listings sentinel from api_tcgplayer.py's NO_LISTINGS_SENTINEL
# ("admin confirmed this card has no TCGPlayer listings", distinct from a
# genuinely-unset product_id) — folded here into the tcg_is_no_listings /
# is_no_listings boolean columns instead of staying a magic string value.
NO_LISTINGS_SENTINEL = "~"


def _load(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


class SyncSafetyError(Exception):
    """Raised when a full-replace phase's source JSON looks suspiciously
    smaller than what's already in Postgres — see _guard_full_replace."""


def _guard_full_replace(session: Session, model, new_count: int, label: str, force: bool) -> None:
    """price_listings/price_sales/card_errors are wiped and fully re-inserted
    from JSON every run (see their migrate_* functions) — correct as long as
    the JSON is trustworthy, but an emptied or partially-written source file
    (this happened for real on 2026-08-27: an emptied LISTINGS.json/
    SALES.json silently deleted 13,797 real price rows with no way back)
    would otherwise wipe Postgres too, with no source left to recover from.

    Refuses to proceed when the new count looks like a drastic, likely-wrong
    shrink from what's already stored. force=True (only ever passed via the
    CLI's --force flag, never scripts.migrate_json_to_pg.run_migration() —
    see its own docstring) skips this check for a genuinely expected shrink
    (e.g. an admin deliberately deleted a bunch of bad sales entries)."""
    if force:
        return

    existing_count = session.execute(select(func.count()).select_from(model)).scalar()

    if existing_count > 10 and new_count < existing_count * 0.5:
        raise SyncSafetyError(
            f"{label}: source JSON has {new_count} entries but Postgres currently has {existing_count} — "
            f"refusing to wipe and replace (the JSON source may be missing, empty, or corrupted). "
            f"Re-run from the CLI with --force if this shrink is actually expected."
        )


# _chunked / _upsert / _set_slug / _split_speed and the build_*_row helpers
# now live in db/catalog_sync.py — shared with api_ga.py's live per-card
# writer so the JSON/API-payload -> row mapping can't drift between the bulk
# import and the live sync. _upsert here is catalog_sync.upsert (its extra
# update_cols arg defaults to "every non-key column", unchanged for this file).


# ── Users & settings ─────────────────────────────────────────────────────────

def migrate_users() -> set[str]:
    users_data = _load(DIR_GENERAL / "USERS.json")

    rows = [
        {
            "username": username,
            "password_hash": info["password"],
            "auth_type": info.get("auth_type", "user"),
            "notes": info.get("notes", []),
            "bio": info.get("bio", ""),
            "omnidex_id": info.get("omnidex_id"),
            "admin_note": info.get("admin_note", ""),
        }
        for username, info in users_data.items()
    ]

    with get_session() as session:
        _upsert(session, User, rows, index_elements=["username"])

    print(f"users: {len(rows)}")
    return set(users_data.keys())


def find_owner_username() -> str | None:
    """The username whose auth_type is "owner" in USERS.json (the first account
    ever created — see user.py's RANK_ORDER note), or None if there is no owner
    account yet."""
    users_data = _load(DIR_GENERAL / "USERS.json")
    return next(
        (username for username, info in users_data.items() if info.get("auth_type") == "owner"),
        None,
    )


def port_owner_to_database() -> dict:
    """Upsert just the auth_type=="owner" account from USERS.json into Postgres.

    Backs the Admin -> System panel's "turn Use JSON off" confirmation: in DB
    mode every request re-checks Postgres for the caller's account and rank
    (get_current_user / require_admin in app.py) and USERS.json is never
    consulted — so if the owner isn't already a row in Postgres, the admin who
    flips the switch 403-locks themselves out of the very panel that could fix
    it. Needs DATABASE_URL set and reachable; does NOT require is_db_mode().

    Returns {"ok": bool, "owner": str | None, "error": str | None}.
    """
    users_data = _load(DIR_GENERAL / "USERS.json")
    owner = next(
        (username for username, info in users_data.items() if info.get("auth_type") == "owner"),
        None,
    )

    if owner is None:
        return {"ok": False, "owner": None, "error": "No owner account found in USERS.json."}

    info = users_data[owner]
    row = {
        "username": owner,
        "password_hash": info["password"],
        "auth_type": "owner",
        "notes": info.get("notes", []),
        "bio": info.get("bio", ""),
        "omnidex_id": info.get("omnidex_id"),
        "admin_note": info.get("admin_note", ""),
    }

    try:
        with get_session() as session:
            _upsert(session, User, [row], index_elements=["username"])
    except Exception as exc:
        return {"ok": False, "owner": owner, "error": str(exc)}

    return {"ok": True, "owner": owner, "error": None}


# Admin settings are not migrated — SETTINGS.json is the sole source of truth
# for them in every mode (see settings.py). The app_settings table was
# dropped in migration a1b2c3d4e5f6.


# ── Card catalog ──────────────────────────────────────────────────────────────

def migrate_sets(info_data: dict) -> None:
    featured_data = _load(DIR_CARDS / "FEATURED_SETS.json")
    search_data = _load(DIR_CARDS / "SET_SEARCHES.json")

    sets_by_slug: dict[str, dict] = {}

    def ensure(slug: str) -> dict:
        return sets_by_slug.setdefault(slug, {
            "slug": slug, "prefix": None, "name": None, "featured_group": None, "featured_position": None,
            "image_path": None, "last_searched": None, "tcgplayer_group_id": None,
        })

    # Source A: every set actually referenced by a card edition (the only
    # place set_prefix/set_name live today — see the plan's normalization note)
    for card in info_data.values():
        for edition in card.get("editions", {}).values():
            prefix = edition.get("set_prefix")
            if not prefix:
                continue
            entry = ensure(_set_slug(prefix))
            entry["prefix"] = prefix
            entry["name"] = entry["name"] or edition.get("set_name")

    # Source B: set files that exist locally even if currently card-less
    for path in DIR_SETS.glob("*.json"):
        ensure(path.stem)

    # Source C: set-search bookkeeping
    for slug, entry_data in search_data.items():
        entry = ensure(slug)
        entry["last_searched"] = entry_data.get("last_searched")
        entry["tcgplayer_group_id"] = entry_data.get("tcgplayer_group_id")

    # Source D: featured groups + membership
    group_rows = [
        {"group_name": group_name, "image_path": group_data.get("image_path")}
        for group_name, group_data in featured_data.items()
    ]

    for group_name, group_data in featured_data.items():
        for position, member in enumerate(group_data.get("sets", [])):
            if not member.get("slug"):
                continue
            entry = ensure(member["slug"])
            entry["prefix"] = entry["prefix"] or member.get("prefix")
            entry["featured_group"] = group_name
            entry["featured_position"] = position

    with get_session() as session:
        _upsert(session, FeaturedSetGroup, group_rows, index_elements=["group_name"])
        # sets.prefix is NOT NULL — a slug with no prefix from any source (a
        # SETS_GA file for a set with zero synced cards and no set-search
        # entry) can't be inserted; fall back to the slug itself so the row
        # still exists rather than silently dropping that set's collector
        # data out of the schema.
        rows = [
            {**entry, "prefix": entry["prefix"] or entry["slug"]}
            for entry in sets_by_slug.values()
        ]

        # last_searched / tcgplayer_group_id are owned by the running app's
        # set-search bookkeeping: in DB mode app.py writes them straight to
        # sets.* and never back to SET_SEARCHES.json (see api_ga.set_group_id).
        # So a re-sync must SEED them onto brand-new rows (they're still in
        # `rows`, applied on INSERT) but must NOT overwrite an existing row's
        # live value from this now-stale JSON — hence they're dropped from the
        # on-conflict update here. The one exception: a value that IS present
        # in the JSON (an admin who set a Group ID while still in JSON mode,
        # now migrating it in) is re-applied to its row below.
        bookkeeping = ("last_searched", "tcgplayer_group_id")
        catalog_cols = [c for c in rows[0] if c not in ("slug", *bookkeeping)] if rows else []
        _upsert(session, Set, rows, index_elements=["slug"], update_cols=catalog_cols)

        # Each bookkeeping column re-applied on its own, only for the rows the
        # JSON actually has a value for — so a JSON entry that carries just
        # last_searched can't null out a Group ID the running app wrote, and
        # vice versa.
        for col in bookkeeping:
            seeded = [
                {"slug": r["slug"], "prefix": r["prefix"], col: r[col]}
                for r in rows if r[col] is not None
            ]
            _upsert(session, Set, seeded, index_elements=["slug"], update_cols=[col])

    print(f"featured_set_groups: {len(group_rows)}, sets: {len(rows)}")


def migrate_cards(info_data: dict) -> None:
    slugs_data = _load(DIR_CARDS / "SLUGS.json")
    update_data = _load(DIR_CARDS / "UPDATE.json")

    name_by_card_id = {data["card_id"]: data["name"] for data in slugs_data.values()}

    rows = [
        build_card_row(card_id, card, name_by_card_id.get(card_id), update_data.get(card_id))
        for card_id, card in info_data.items()
    ]

    with get_session() as session:
        _upsert(session, Card, rows, index_elements=["card_id"])

    print(f"cards: {len(rows)}")


def migrate_card_slugs(info_data: dict) -> None:
    slugs_data = _load(DIR_CARDS / "SLUGS.json")
    known_card_ids = set(info_data.keys())

    rows = []
    skipped = 0
    for slug, data in slugs_data.items():
        if data["card_id"] not in known_card_ids:
            skipped += 1
            continue
        rows.append({"slug": slug, "card_id": data["card_id"], "name": data["name"]})

    with get_session() as session:
        _upsert(session, CardSlug, rows, index_elements=["slug"])

    print(f"card_slugs: {len(rows)}" + (f" ({skipped} skipped, unknown card_id)" if skipped else ""))


def migrate_card_rules(info_data: dict) -> None:
    rules_data = _load(DIR_CARDS / "RULES.json")
    known_card_ids = set(info_data.keys())

    rows = [
        row
        for card_id, rules in rules_data.items() if card_id in known_card_ids
        for row in build_rule_rows(card_id, rules)
    ]

    with get_session() as session:
        # No natural unique key per rule — RULES.json is a full-replace list
        # per card each sync (see api_ga.py::_update_rule), so mirror that:
        # wipe and re-insert rather than trying to diff.
        session.execute(delete(CardRule).where(CardRule.card_id.in_(rules_data.keys())))
        for batch in _chunked(rows):
            session.execute(CardRule.__table__.insert(), batch)

    print(f"card_rules: {len(rows)}")


def migrate_editions_and_foils(info_data: dict) -> set[tuple[str, str]]:
    id_tcg_data = _load(DIR_PRICING / "ID_TCGPLAYER.json")
    known_card_ids = set(info_data.keys())

    edition_rows = []
    for card_id, card in info_data.items():
        for edition_id, edition in card.get("editions", {}).items():
            tcg = id_tcg_data.get(edition_id, {})
            product_id = tcg.get("product_id")
            is_no_listings = product_id == NO_LISTINGS_SENTINEL

            edition_rows.append({
                # catalog columns (shared with the live per-card sync);
                # collector_number is None here — migrate_collector_numbers()
                # fills it from the per-set files right after this phase.
                **build_edition_row(card_id, edition_id, edition),
                "tcg_product_id": None if is_no_listings else product_id,
                "tcg_is_no_listings": is_no_listings,
            })

    with get_session() as session:
        _upsert(session, Edition, edition_rows, index_elements=["edition_id"])

    known_edition_ids = {row["edition_id"] for row in edition_rows}
    print(f"editions: {len(edition_rows)}")

    # Foils: two passes so a variant's parent_foil_id FK always already
    # exists (INFO.json only nests one level of variants under each
    # top-level foil, so two passes fully cover it).
    #
    # Keyed by (edition_id, foil_id), NOT foil_id alone — confirmed against
    # the real local data that foil_id/variant_id strings repeat across many
    # unrelated editions (up to 100+ times for some ids, not just the "temp"
    # TEMP_FOIL_ID sentinel) and are only unique within their own edition.
    top_level_rows = []
    variant_rows = []
    known_foil_pairs: set[tuple[str, str]] = set()

    for card in info_data.values():
        for edition_id, edition in card.get("editions", {}).items():
            if edition_id not in known_edition_ids:
                continue
            top, variants = build_foil_rows(edition_id, edition.get("foils", {}))
            top_level_rows.extend(top)
            variant_rows.extend(variants)
            known_foil_pairs.update((r["edition_id"], r["foil_id"]) for r in top + variants)

    with get_session() as session:
        _upsert(session, Foil, top_level_rows, index_elements=["edition_id", "foil_id"])
        session.flush()
        _upsert(session, Foil, variant_rows, index_elements=["edition_id", "foil_id"])

    print(f"foils: {len(top_level_rows) + len(variant_rows)} "
          f"({len(top_level_rows)} top-level, {len(variant_rows)} variants)")

    # Sparse per-foil TCGPlayer overrides (Curio Foils etc.) — already
    # naturally scoped by edition_id in ID_TCGPLAYER.json's own structure.
    override_rows = []
    skipped = 0
    for edition_id, tcg in id_tcg_data.items():
        for foil_id, override in tcg.get("foils", {}).items():
            if (edition_id, foil_id) not in known_foil_pairs:
                skipped += 1
                continue
            product_id = override.get("product_id")
            is_no_listings = product_id == NO_LISTINGS_SENTINEL
            override_rows.append({
                "edition_id": edition_id,
                "foil_id": foil_id,
                "product_id": None if is_no_listings else product_id,
                "is_no_listings": is_no_listings,
            })

    with get_session() as session:
        _upsert(session, FoilTcgOverride, override_rows, index_elements=["edition_id", "foil_id"])

    print(f"foil_tcg_overrides: {len(override_rows)}" + (f" ({skipped} skipped, unknown foil_id)" if skipped else ""))

    # Per-marketplace "Last Sales" / "Last Listings" clocks. ID_TCGPLAYER.json's
    # last_sales / last_listings (edition-level and nested under foils) may be a
    # bare "YYYY-MM-DD" string (legacy — read as {"TCGPlayer": <string>}) or a
    # {marketplace: date} dict. foil_id "" == the edition-level (main) clock.
    def _clock_map(value) -> dict:
        if isinstance(value, str):
            return {"TCGPlayer": value}
        if isinstance(value, dict):
            return {mkt: iso for mkt, iso in value.items() if iso}
        return {}

    clock_rows = []
    for edition_id, tcg in id_tcg_data.items():
        if edition_id not in known_edition_ids:
            continue
        scopes = [("", tcg)] + [
            (foil_id, override) for foil_id, override in tcg.get("foils", {}).items()
            if (edition_id, foil_id) in known_foil_pairs
        ]
        for foil_id, entry in scopes:
            for field, key in (("sales", "last_sales"), ("listings", "last_listings")):
                for marketplace, iso in _clock_map(entry.get(key)).items():
                    clock_rows.append({
                        "edition_id": edition_id, "foil_id": foil_id,
                        "marketplace": marketplace, "field": field, "last_date": iso,
                    })

    with get_session() as session:
        _upsert(session, MarketplaceScrapeClock, clock_rows,
                index_elements=["edition_id", "foil_id", "marketplace", "field"])

    print(f"marketplace_scrape_clocks: {len(clock_rows)}")

    return known_foil_pairs


def migrate_collector_numbers() -> None:
    """DATA_GA/SETS_GA/{slug}.json: collector_number -> [edition_id, ...]."""
    updated = 0

    with get_session() as session:
        for path in DIR_SETS.glob("*.json"):
            set_data = _load(path)
            for collector_number, edition_ids in set_data.items():
                if isinstance(edition_ids, str):
                    edition_ids = [edition_ids]
                for edition_id in edition_ids:
                    result = session.execute(
                        Edition.__table__.update()
                        .where(Edition.edition_id == edition_id)
                        .values(collector_number=collector_number)
                    )
                    updated += result.rowcount

    print(f"editions.collector_number set on {updated} rows")


def migrate_thema(info_data: dict) -> None:
    thema_data = _load(DIR_CARDS / "THEMA.json")
    known_edition_ids = {
        edition_id
        for card in info_data.values()
        for edition_id in card.get("editions", {})
    }

    rows = build_thema_rows({
        edition_id: foil_types
        for edition_id, foil_types in thema_data.items()
        if edition_id in known_edition_ids
    })

    with get_session() as session:
        _upsert(session, ThemaScore, rows, index_elements=["edition_id", "foil_type"])

    print(f"thema_scores: {len(rows)}")


def migrate_card_errors(force: bool = False) -> None:
    errors_data = _load(DIR_CARDS / "ERRORS.json")

    rows = [
        {
            "occurred_at": entry.get("timestamp"),
            "identifier": entry.get("identifier"),
            "error": entry.get("error"),
        }
        for entry in errors_data.values()
    ]

    with get_session() as session:
        # Append-only log with no natural key — full replace each run.
        _guard_full_replace(session, CardError, len(rows), "card_errors", force)
        session.execute(delete(CardError))
        for batch in _chunked(rows):
            session.execute(CardError.__table__.insert(), batch)

    print(f"card_errors: {len(rows)}")


# ── Pricing ───────────────────────────────────────────────────────────────────

def _flatten_price_records(data: dict, known_foil_pairs: set[tuple[str, str]]) -> tuple[list[dict], int]:
    rows = []
    skipped = 0
    for editions in data.values():
        for edition_id, foils in editions.items():
            for foil_id, records in foils.items():
                if (edition_id, foil_id) not in known_foil_pairs:
                    skipped += len(records)
                    continue
                for record in records:
                    rows.append({
                        "edition_id": edition_id,
                        "foil_id": foil_id,
                        "date": record["date"],
                        "marketplace": record.get("marketplace"),
                        "price": record.get("price"),
                        "quantity": record.get("quantity", 1),
                        "condition": record.get("condition"),
                    })
    return rows, skipped


def migrate_pricing(known_foil_pairs: set[tuple[str, str]], force: bool = False) -> None:
    listings_rows, listings_skipped = _flatten_price_records(_load(DIR_PRICING / "LISTINGS.json"), known_foil_pairs)
    sales_rows, sales_skipped = _flatten_price_records(_load(DIR_PRICING / "SALES.json"), known_foil_pairs)

    with get_session() as session:
        # Pure historical logs sourced 1:1 from JSON, nothing DB-only writes
        # to them yet (pricing isn't wired to the toggle until a later
        # stage) — full replace each run is simplest and always correct...
        # as long as the JSON source is trustworthy, which _guard_full_replace
        # checks first (see its docstring for why that's not hypothetical).
        _guard_full_replace(session, PriceListing, len(listings_rows), "price_listings", force)
        _guard_full_replace(session, PriceSale, len(sales_rows), "price_sales", force)

        session.execute(delete(PriceListing))
        for batch in _chunked(listings_rows):
            session.execute(PriceListing.__table__.insert(), batch)

        session.execute(delete(PriceSale))
        for batch in _chunked(sales_rows):
            # ON CONFLICT DO NOTHING dedups on the full row tuple
            # (date, marketplace, price, quantity, condition) per foil.
            stmt = pg_insert(PriceSale).values(batch).on_conflict_do_nothing(
                index_elements=["edition_id", "foil_id", "date", "marketplace", "price", "quantity", "condition"]
            )
            session.execute(stmt)

    print(f"price_listings: {len(listings_rows)}" + (f" ({listings_skipped} skipped, unknown foil_id)" if listings_skipped else ""))
    print(f"price_sales: {len(sales_rows)}" + (f" ({sales_skipped} skipped, unknown foil_id)" if sales_skipped else ""))


# ── Inventory / decks / watchlist / wishlist (schema exists, app not wired yet) ─

def migrate_inventory(known_usernames: set[str], known_foil_pairs: set[tuple[str, str]]) -> None:
    bin_count = section_count = card_count = 0
    skipped_users = []

    with get_session() as session:
        for path in DIR_INV.glob("*.json"):
            username = path.stem
            if username not in known_usernames:
                skipped_users.append(username)
                continue

            for bin_name, bin_data in _load(path).items():
                bin_row = {
                    "username": username,
                    "name": bin_name,
                    "desc": bin_data.get("desc", ""),
                    "banner": bin_data.get("banner"),
                    "symbol": bin_data.get("symbol"),
                    "tags": bin_data.get("tags"),
                    "is_default": bool(bin_data.get("default")),
                }
                stmt = pg_insert(InventoryBin).values(bin_row).on_conflict_do_update(
                    index_elements=["username", "name"],
                    set_={k: v for k, v in bin_row.items() if k not in ("username", "name")},
                )
                bin_id = session.execute(stmt.returning(InventoryBin.id)).scalar_one()
                bin_count += 1

                for position, (section_name, cards) in enumerate(bin_data.get("sections", {}).items()):
                    stmt = pg_insert(InventorySection).values(
                        bin_id=bin_id, name=section_name, position=position
                    ).on_conflict_do_update(
                        index_elements=["bin_id", "name"], set_={"position": position},
                    )
                    section_id = session.execute(stmt.returning(InventorySection.id)).scalar_one()
                    section_count += 1

                    for card_id, editions in cards.items():
                        for edition_id, foils in editions.items():
                            for foil_id, quantity in foils.items():
                                if (edition_id, foil_id) not in known_foil_pairs:
                                    continue
                                stmt = pg_insert(InventoryCard).values(
                                    section_id=section_id, card_id=card_id, edition_id=edition_id,
                                    foil_id=foil_id, quantity=quantity,
                                ).on_conflict_do_update(
                                    index_elements=["section_id", "card_id", "edition_id", "foil_id"],
                                    set_={"quantity": quantity},
                                )
                                session.execute(stmt)
                                card_count += 1

    print(f"inventory_bins: {bin_count}, inventory_sections: {section_count}, inventory_cards: {card_count}"
          + (f" (skipped users with no account: {skipped_users})" if skipped_users else ""))


def migrate_decks(known_usernames: set[str], known_card_ids: set[str]) -> None:
    deck_count = section_count = card_count = 0
    skipped_users = []

    with get_session() as session:
        for index_path in DIR_DECK_INDEX.glob("*.json"):
            username = index_path.stem
            if username not in known_usernames:
                skipped_users.append(username)
                continue

            index_data = _load(index_path)
            deck_dir = DIR_DECKS / username

            for deck_name, entry in index_data.items():
                deck_path = deck_dir / f"{deck_name}.json"
                deck_data = _load(deck_path) if deck_path.exists() else {}

                deck_row = {
                    "username": username,
                    "name": deck_name,
                    "desc": deck_data.get("desc", entry.get("desc", "")),
                    "format": deck_data.get("format", entry.get("format", "")),
                    "banner": entry.get("banner"),
                    "symbol": entry.get("symbol"),
                    "tags": entry.get("tags"),
                    "created_at": entry.get("created"),
                    "modified_at": entry.get("modified"),
                }
                stmt = pg_insert(Deck).values(deck_row).on_conflict_do_update(
                    index_elements=["username", "name"],
                    set_={k: v for k, v in deck_row.items() if k not in ("username", "name")},
                )
                deck_id = session.execute(stmt.returning(Deck.id)).scalar_one()
                deck_count += 1

                for position, (section_name, cards) in enumerate(deck_data.get("sections", {}).items()):
                    stmt = pg_insert(DeckSection).values(
                        deck_id=deck_id, name=section_name, position=position
                    ).on_conflict_do_update(
                        index_elements=["deck_id", "name"], set_={"position": position},
                    )
                    section_id = session.execute(stmt.returning(DeckSection.id)).scalar_one()
                    section_count += 1

                    for card_position, (card_id, quantity) in enumerate(cards.items()):
                        if card_id not in known_card_ids:
                            continue
                        stmt = pg_insert(DeckCard).values(
                            section_id=section_id, card_id=card_id, quantity=quantity, position=card_position,
                        ).on_conflict_do_update(
                            index_elements=["section_id", "card_id"],
                            set_={"quantity": quantity, "position": card_position},
                        )
                        session.execute(stmt)
                        card_count += 1

    print(f"decks: {deck_count}, deck_sections: {section_count}, deck_cards: {card_count}"
          + (f" (skipped users with no account: {skipped_users})" if skipped_users else ""))


def _migrate_watch_or_wish(
    model, directory: Path, known_usernames: set[str], known_foil_pairs: set[tuple[str, str]]
) -> int:
    rows = []
    for path in directory.glob("*.json"):
        username = path.stem
        if username not in known_usernames:
            continue

        for card_id, editions in _load(path).items():
            for edition_id, foils in editions.items():
                for foil_id, foil_entry in foils.items():
                    if (edition_id, foil_id) not in known_foil_pairs:
                        continue
                    rows.append({
                        "username": username,
                        "edition_id": edition_id,
                        "foil_id": foil_id,
                        "added_date": foil_entry.get("added"),
                    })

    with get_session() as session:
        _upsert(session, model, rows, index_elements=["username", "edition_id", "foil_id"])

    return len(rows)


def migrate_watchlist_and_wishlist(known_usernames: set[str], known_foil_pairs: set[tuple[str, str]]) -> None:
    watch_count = _migrate_watch_or_wish(WatchlistEntry, DIR_WATCHLIST, known_usernames, known_foil_pairs)
    wish_count = _migrate_watch_or_wish(WishlistEntry, DIR_WISH, known_usernames, known_foil_pairs)
    print(f"watchlist_entries: {watch_count}, wishlist_entries: {wish_count}")


# ── Entry point ───────────────────────────────────────────────────────────────

def main(force: bool = False) -> None:
    with get_session() as session:
        session.execute(text("SELECT 1"))
    print("Connected to Postgres.\n")

    known_usernames = migrate_users()

    info_data = _load(DIR_CARDS / "INFO.json")
    known_card_ids = set(info_data.keys())

    migrate_sets(info_data)
    migrate_cards(info_data)
    migrate_card_slugs(info_data)
    migrate_card_rules(info_data)
    known_foil_pairs = migrate_editions_and_foils(info_data)
    migrate_collector_numbers()
    migrate_thema(info_data)
    migrate_card_errors(force=force)
    migrate_pricing(known_foil_pairs, force=force)
    migrate_inventory(known_usernames, known_foil_pairs)
    migrate_decks(known_usernames, known_card_ids)
    migrate_watchlist_and_wishlist(known_usernames, known_foil_pairs)

    print("\nDone.")


# Every table except `users` — see wipe_database's own docstring for why
# users is deliberately left out. Order doesn't matter here (TRUNCATE ...
# CASCADE below works it out), but every table needs to be listed since
# CASCADE only pulls in tables NOT already named that reference the ones
# that are — it won't silently miss one, but it also won't silently add one
# outside this list that isn't actually FK-connected to it.
_WIPE_TABLE_NAMES = [
    "price_listings", "price_sales", "foil_tcg_overrides", "thema_scores", "card_errors",
    "inventory_cards", "inventory_sections", "inventory_bins",
    "deck_cards", "deck_sections", "decks",
    "watchlist_entries", "wishlist_entries",
    "foils", "editions", "card_rules", "card_slugs", "cards", "sets", "featured_set_groups",
]


def wipe_database() -> dict:
    """Deletes every row from every Postgres table EXCEPT `users` — the admin
    System panel's Wipe Database button (see /api/admin/system/wipe-database
    in app.py). Deliberately never touches `users`: wiping it out from under
    a currently-logged-in DB-mode admin would 403-lock them out of the very
    button they just clicked (get_current_user/get_user_auth_type re-check
    Postgres on every request in DB mode), with no way back in short of
    editing the database by hand or switching back to JSON mode.

    Unlike run_migration() above, this has no safety guard of its own to
    skip — wiping IS the whole point here, unlike the sync's full-replace
    phases where destruction is an accidental side effect of bad source
    data. The confirmation step lives in the UI instead (typing DELETE —
    see runAdminSystemWipe in admin.js), matching how differently the two
    actions are meant to be reached: Sync should never destroy data without
    warning, Wipe is supposed to and just needs to not be a misclick.

    One TRUNCATE ... CASCADE across every table in _WIPE_TABLE_NAMES at
    once, rather than row-by-row DELETEs in dependency order — CASCADE lets
    Postgres work out the correct order itself (including the
    self-referential FK on foils.parent_foil_id) instead of this needing to
    get that right by hand. RESTART IDENTITY resets the surrogate-key
    sequences (rules, errors, price rows, bins, sections, decks, deck
    cards, watchlist/wishlist entries) back to 1, so a subsequent Sync
    starts from a clean slate instead of picking up wherever the old ids
    left off."""
    table_list = ", ".join(_WIPE_TABLE_NAMES)

    try:
        with get_session() as session:
            session.execute(text(f"TRUNCATE TABLE {table_list} RESTART IDENTITY CASCADE"))
        return {
            "ok": True,
            "log": f"Wiped {len(_WIPE_TABLE_NAMES)} tables. User accounts were kept.",
            "error": None,
        }
    except Exception as e:
        return {"ok": False, "log": "", "error": str(e)}


def run_migration() -> dict:
    """Callable entry point for the admin System panel's Sync button (see
    /api/admin/system/sync-to-database in app.py) — runs the exact same
    migration as the CLI (force=False always; the safety guard in
    _guard_full_replace can't be overridden from the UI, only from a human
    running --force at a terminal on purpose) and returns
    {"ok", "log", "error"} instead of printing straight to stdout/raising.

    "ok": False with a SyncSafetyError means the guard tripped — "log" still
    has everything that completed before it did. "ok": False from any other
    exception means something else went wrong (e.g. Postgres unreachable)."""
    buf = io.StringIO()

    try:
        with contextlib.redirect_stdout(buf):
            main(force=False)
        return {"ok": True, "log": buf.getvalue(), "error": None}
    except Exception as e:
        return {"ok": False, "log": buf.getvalue(), "error": str(e)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force", action="store_true",
        help="Skip the safety guard on price_listings/price_sales/card_errors that refuses to wipe "
             "them when the JSON source looks suspiciously smaller than what's already in Postgres.",
    )
    args = parser.parse_args()
    main(force=args.force)

"""One-time JSON -> Postgres importer for every DATA_GA/DATA_GENERAL domain.

Run manually (not part of app startup):

    .venv/Scripts/python.exe scripts/migrate_json_to_pg.py

Safe to re-run: every phase either upserts by the table's natural primary key
(sqlalchemy.dialects.postgresql.insert(...).on_conflict_do_update) or, for
tables that are pure historical logs with no natural key (card_rules is a
per-card full-replace list, card_errors/price_listings/price_sales are
append-only logs), clears and re-inserts from the current JSON each run.

Only `users` and `app_settings` are actually read from Postgres by the app
yet (Stage 1 — see the migration plan). Every other table here is populated
so later stages have real data to build their routes against, and so this
run itself is a first integrity check of the schema (every foreign key below
is enforced by Postgres, not just assumed).
"""

from db.models import (
    AppSetting, Card, CardError, CardRule, CardSlug, Deck, DeckCard, DeckSection, Edition, FeaturedSetGroup, Foil,
    FoilTcgOverride, InventoryBin, InventoryCard, InventorySection, PriceListing, PriceSale, Set, ThemaScore, User,
    WatchlistEntry, WishlistEntry,
)
from db.session import get_session
from dotenv import load_dotenv
from pathlib import Path
from sqlalchemy import delete, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

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


def _chunked(rows: list, size: int = 1000):
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


def _upsert(session: Session, model, rows: list[dict], index_elements: list[str]) -> None:
    """Batch INSERT ... ON CONFLICT (index_elements) DO UPDATE for every other column."""
    if not rows:
        return

    columns = [c.name for c in model.__table__.columns]
    update_cols = [c for c in columns if c not in index_elements]

    for batch in _chunked(rows):
        stmt = pg_insert(model).values(batch)
        stmt = stmt.on_conflict_do_update(
            index_elements=index_elements,
            set_={col: getattr(stmt.excluded, col) for col in update_cols},
        )
        session.execute(stmt)


def _set_slug(prefix: str) -> str:
    """Mirrors api_ga.py's _set_slug: lowercase, spaces -> underscores."""
    return prefix.lower().replace(" ", "_")


def _split_speed(value) -> tuple[int | None, bool | None]:
    """INFO.json's stats.speed is usually a number, but some cards (confirmed
    in the real local data) carry a boolean "Fast" keyword under the same
    key instead — see Card.speed_fast's comment in db/models.py."""
    if isinstance(value, bool):
        return None, value
    return value, None


# ── Users & settings ─────────────────────────────────────────────────────────

def migrate_users() -> set[str]:
    users_data = _load(DIR_GENERAL / "USERS.json")

    rows = [
        {
            "username": username,
            "password_hash": info["password"],
            "auth_type": info.get("auth_type", "user"),
            "notes": info.get("notes", []),
        }
        for username, info in users_data.items()
    ]

    with get_session() as session:
        _upsert(session, User, rows, index_elements=["username"])

    print(f"users: {len(rows)}")
    return set(users_data.keys())


def migrate_settings() -> None:
    settings_data = _load(DIR_GENERAL / "SETTINGS.json")

    # local_database itself never migrates — see db_mode.py.
    rows = [
        {"key": key, "value": bool(value)}
        for key, value in settings_data.items()
        if key != "local_database"
    ]

    with get_session() as session:
        _upsert(session, AppSetting, rows, index_elements=["key"])

    print(f"app_settings: {len(rows)}")


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
        _upsert(session, Set, rows, index_elements=["slug"])

    print(f"featured_set_groups: {len(group_rows)}, sets: {len(rows)}")


def migrate_cards(info_data: dict) -> None:
    slugs_data = _load(DIR_CARDS / "SLUGS.json")
    update_data = _load(DIR_CARDS / "UPDATE.json")

    name_by_card_id = {data["card_id"]: data["name"] for data in slugs_data.values()}

    rows = []
    for card_id, card in info_data.items():
        legality = card.get("legality", {})
        stats = card.get("stats", {})
        speed, speed_fast = _split_speed(stats.get("speed"))
        rows.append({
            "card_id": card_id,
            "name": name_by_card_id.get(card_id),
            "element": card.get("element"),
            "effect": card.get("effect"),
            "effect_html": card.get("effect_html"),
            "effect_raw": card.get("effect_raw"),
            "legality_draft": legality.get("draft"),
            "legality_pantheon": legality.get("pantheon"),
            "legality_standard": legality.get("standard"),
            "cost_memory": stats.get("cost_memory"),
            "cost_reserve": stats.get("cost_reserve"),
            "durability": stats.get("durability"),
            "level": stats.get("level"),
            "life": stats.get("life"),
            "power": stats.get("power"),
            "speed": speed,
            "speed_fast": speed_fast,
            "types": card.get("types", []),
            "last_synced": update_data.get(card_id),
        })

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

    rows = []
    for card_id, rules in rules_data.items():
        if card_id not in known_card_ids:
            continue
        for rule in rules:
            rows.append({
                "card_id": card_id,
                "date": rule.get("date") or None,
                "title": rule.get("title"),
                "description": rule.get("description", ""),
            })

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
            set_prefix = edition.get("set_prefix")

            edition_rows.append({
                "edition_id": edition_id,
                "card_id": card_id,
                "set_slug": _set_slug(set_prefix) if set_prefix else None,
                "collector_number": None,  # filled in by migrate_collector_numbers()
                "rarity": edition.get("rarity"),
                "illustrator": edition.get("illustrator"),
                "flavor": edition.get("flavor"),
                "date_created": edition.get("date_created"),
                "date_release": edition.get("date_release"),
                "date_update": edition.get("date_update"),
                "tcg_product_id": None if is_no_listings else product_id,
                "tcg_is_no_listings": is_no_listings,
                "tcg_last_sales": tcg.get("last_sales"),
                "tcg_last_listings": tcg.get("last_listings"),
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
            for foil_id, foil in edition.get("foils", {}).items():
                top_level_rows.append({
                    "foil_id": foil_id,
                    "edition_id": edition_id,
                    "parent_foil_id": None,
                    "kind": foil.get("kind"),
                    "population": foil.get("population"),
                    "printing": foil.get("printing"),
                })
                known_foil_pairs.add((edition_id, foil_id))

                for variant_id, variant in foil.get("variants", {}).items():
                    variant_rows.append({
                        "foil_id": variant_id,
                        "edition_id": edition_id,
                        "parent_foil_id": foil_id,
                        "kind": variant.get("kind"),
                        "population": variant.get("population"),
                        "printing": variant.get("printing"),
                    })
                    known_foil_pairs.add((edition_id, variant_id))

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
                "last_sales": override.get("last_sales"),
                "last_listings": override.get("last_listings"),
            })

    with get_session() as session:
        _upsert(session, FoilTcgOverride, override_rows, index_elements=["edition_id", "foil_id"])

    print(f"foil_tcg_overrides: {len(override_rows)}" + (f" ({skipped} skipped, unknown foil_id)" if skipped else ""))

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

    rows = []
    for edition_id, foil_types in thema_data.items():
        if edition_id not in known_edition_ids:
            continue
        for foil_type, scores in foil_types.items():
            rows.append({
                "edition_id": edition_id,
                "foil_type": foil_type,
                "charm": scores.get("charm"),
                "ferocity": scores.get("ferocity"),
                "grace": scores.get("grace"),
                "mystique": scores.get("mystique"),
                "valor": scores.get("valor"),
                "dynamic": scores.get("dynamic"),
            })

    with get_session() as session:
        _upsert(session, ThemaScore, rows, index_elements=["edition_id", "foil_type"])

    print(f"thema_scores: {len(rows)}")


def migrate_card_errors() -> None:
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


def migrate_pricing(known_foil_pairs: set[tuple[str, str]]) -> None:
    listings_rows, listings_skipped = _flatten_price_records(_load(DIR_PRICING / "LISTINGS.json"), known_foil_pairs)
    sales_rows, sales_skipped = _flatten_price_records(_load(DIR_PRICING / "SALES.json"), known_foil_pairs)

    with get_session() as session:
        # Pure historical logs sourced 1:1 from JSON, nothing DB-only writes
        # to them yet (pricing isn't wired to the toggle until a later
        # stage) — full replace each run is simplest and always correct.
        session.execute(delete(PriceListing))
        for batch in _chunked(listings_rows):
            session.execute(PriceListing.__table__.insert(), batch)

        session.execute(delete(PriceSale))
        for batch in _chunked(sales_rows):
            # ON CONFLICT DO NOTHING mirrors _entry_key's existing dedup
            # tuple (date, marketplace, price, quantity, condition) per foil.
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

def main() -> None:
    with get_session() as session:
        session.execute(text("SELECT 1"))
    print("Connected to Postgres.\n")

    known_usernames = migrate_users()
    migrate_settings()

    info_data = _load(DIR_CARDS / "INFO.json")
    known_card_ids = set(info_data.keys())

    migrate_sets(info_data)
    migrate_cards(info_data)
    migrate_card_slugs(info_data)
    migrate_card_rules(info_data)
    known_foil_pairs = migrate_editions_and_foils(info_data)
    migrate_collector_numbers()
    migrate_thema(info_data)
    migrate_card_errors()
    migrate_pricing(known_foil_pairs)
    migrate_inventory(known_usernames, known_foil_pairs)
    migrate_decks(known_usernames, known_card_ids)
    migrate_watchlist_and_wishlist(known_usernames, known_foil_pairs)

    print("\nDone.")


if __name__ == "__main__":
    main()

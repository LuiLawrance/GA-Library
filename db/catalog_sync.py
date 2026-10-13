"""Shared JSON/API-payload -> Postgres row mapping for the card catalog.

Two callers build catalog rows and must not drift:

  * scripts/migrate_json_to_pg.py — the bulk one-shot import from the
    DATA_GA/CARDS_GA/*.json files (admin "Sync to Database").
  * api_ga.py::_persist_card — the live per-card write that runs on every
    API card fetch when is_db_mode() is true (a fresh Postgres-only install
    builds its whole catalog this way, never touching the JSON files).

The shared contract is the INFO.json *entry* shape — `info_data[card_id]`,
i.e. `{effect, effect_html, effect_raw, element, legality, stats, types,
editions: {edition_id: {..., foils: {foil_id: {..., variants: {...}}}}}}`.
The migration already has this shape from the file; the live path builds the
same shape from the raw API payload via api_ga._card_data_to_info_entry().

Every function here takes an already-open Session and leaves the
transaction (commit/rollback) to the caller — the live path wraps one
card's whole write in a single get_session() block so a failure can't leave
a half-written card behind.
"""

from db.models import (
    Card, CardRule, CardSlug, DeckCard, Edition, Foil, InventoryCard, PriceListing, PriceSale, Set, ThemaScore,
    WatchlistEntry, WishlistEntry,
)
from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

# Synthetic "stand-in" foils for an edition the API hasn't reported
# circulation data for yet (no foils, no population) — mostly brand-new promos.
# Two of them, one per printing kind, so sales/inventory of EITHER kind have
# somewhere to land (promos are usually Foil-only, so a lone Nonfoil stand-in
# left foil sales unrecognized). Population stays None (unknown). Once the API
# reports real foils, each stand-in is swapped for the real foil of the same
# kind — see promote_temp_foils / migrate_temp_foil_db here and
# api_ga._migrate_temp_foil (JSON). api_ga imports these from here.
TEMP_FOIL_ID = "temp"
TEMP_FOIL_FOIL_ID = "temp-foil"
TEMP_FOIL_KINDS = {TEMP_FOIL_ID: "NONFOIL", TEMP_FOIL_FOIL_ID: "FOIL"}


def temp_placeholder_foils() -> dict:
    """The stand-in foils dict (INFO.json foils shape) for an edition the API
    reported no circulations for."""
    return {
        foil_id: {"kind": kind, "population": None, "printing": None, "variants": {}}
        for foil_id, kind in TEMP_FOIL_KINDS.items()
    }


def real_foil_for_temp(temp_foil_id: str, foils: dict) -> str | None:
    """Which real top-level foil a stand-in should move onto now that the API
    reports real ones: the first real foil of the stand-in's own kind, falling
    back to the first real foil of any kind (e.g. a Foil-only promo absorbs the
    Nonfoil stand-in too). None if there are no real foils yet."""
    real_ids = [fid for fid in foils if fid not in TEMP_FOIL_KINDS]
    if not real_ids:
        return None
    kind = TEMP_FOIL_KINDS[temp_foil_id]
    return next(
        (fid for fid in real_ids if (foils[fid].get("kind") or "").upper() == kind),
        real_ids[0],
    )

# cards.is_custom is owned by custom_cards.py — every other cards column is
# catalog data a sync may overwrite.
CARD_UPDATE_COLS = [c.name for c in Card.__table__.columns if c.name not in ("card_id", "is_custom")]

# editions.tcg_* is owned by the TCGPlayer sync (api_tcgplayer.py), NOT the
# card catalog — a live card fetch or a re-run migrate must never null it
# out. sets.featured_* / image_path / *_searched / tcgplayer_group_id are
# likewise owned by sync_featured_sets / the set-search bookkeeping.
EDITION_CATALOG_COLS = [
    "card_id", "set_slug", "collector_number", "rarity", "illustrator", "flavor",
    "date_created", "date_release", "date_update",
]
SET_CATALOG_COLS = ["prefix", "name"]


def _chunked(rows: list, size: int = 1000):
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


def _set_slug(prefix: str) -> str:
    """Mirrors api_ga.py's _set_slug: lowercase, spaces -> underscores."""
    return prefix.lower().replace(" ", "_")


def _split_speed(value) -> tuple[int | None, bool | None]:
    """INFO.json's stats.speed is usually a number, but some cards carry a
    boolean "Fast" keyword under the same key instead — see Card.speed_fast
    in db/models.py."""
    if isinstance(value, bool):
        return None, value
    return value, None


def upsert(session: Session, model, rows: list[dict], index_elements: list[str],
           update_cols: list[str] | None = None) -> None:
    """Batch INSERT ... ON CONFLICT (index_elements) DO UPDATE. `update_cols`
    defaults to every non-key column; pass an explicit subset to leave the
    other columns untouched on conflict (still inserted for brand-new rows).
    An empty `update_cols` degrades to ON CONFLICT DO NOTHING."""
    if not rows:
        return

    if update_cols is None:
        columns = [c.name for c in model.__table__.columns]
        update_cols = [c for c in columns if c not in index_elements]

    for batch in _chunked(rows):
        stmt = pg_insert(model).values(batch)
        if update_cols:
            stmt = stmt.on_conflict_do_update(
                index_elements=index_elements,
                set_={col: getattr(stmt.excluded, col) for col in update_cols},
            )
        else:
            stmt = stmt.on_conflict_do_nothing(index_elements=index_elements)
        session.execute(stmt)


# ── Row builders (pure) ───────────────────────────────────────────────────────

def build_card_row(card_id: str, info_entry: dict, name: str | None, last_synced) -> dict:
    legality = info_entry.get("legality") or {}
    stats = info_entry.get("stats") or {}
    speed, speed_fast = _split_speed(stats.get("speed"))
    return {
        "card_id": card_id,
        "name": name,
        "element": info_entry.get("element"),
        "effect": info_entry.get("effect"),
        "effect_html": info_entry.get("effect_html"),
        "effect_raw": info_entry.get("effect_raw"),
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
        "types": info_entry.get("types", []),
        "last_synced": last_synced,
    }


def build_edition_row(card_id: str, edition_id: str, edition_entry: dict) -> dict:
    """Catalog columns only — tcg_* stay out (see EDITION_CATALOG_COLS).
    `collector_number` is None from the migration (INFO.json has none — it
    comes from the per-set files via migrate_collector_numbers) but present
    on the live path (the raw API payload carries it per edition)."""
    set_prefix = edition_entry.get("set_prefix")
    return {
        "edition_id": edition_id,
        "card_id": card_id,
        "set_slug": _set_slug(set_prefix) if set_prefix else None,
        "collector_number": edition_entry.get("collector_number"),
        "rarity": edition_entry.get("rarity"),
        "illustrator": edition_entry.get("illustrator"),
        "flavor": edition_entry.get("flavor"),
        "date_created": edition_entry.get("date_created"),
        "date_release": edition_entry.get("date_release"),
        "date_update": edition_entry.get("date_update"),
    }


def build_foil_rows(edition_id: str, foils_dict: dict) -> tuple[list[dict], list[dict]]:
    """(top_level_rows, variant_rows). Two lists so the caller can insert
    top-level foils first — a variant's parent_foil_id FK points back into
    the same table. Keyed by (edition_id, foil_id): foil_id strings are only
    unique within their own edition (see db/models.py Foil)."""
    top_level, variants = [], []
    for foil_id, foil in foils_dict.items():
        top_level.append({
            "edition_id": edition_id,
            "foil_id": foil_id,
            "parent_foil_id": None,
            "kind": foil.get("kind"),
            "population": foil.get("population"),
            "printing": foil.get("printing"),
        })
        for variant_id, variant in foil.get("variants", {}).items():
            variants.append({
                "edition_id": edition_id,
                "foil_id": variant_id,
                "parent_foil_id": foil_id,
                "kind": variant.get("kind"),
                "population": variant.get("population"),
                "printing": variant.get("printing"),
            })
    return top_level, variants


def build_thema_rows(thema_by_edition: dict) -> list[dict]:
    rows = []
    for edition_id, foil_types in thema_by_edition.items():
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
    return rows


def build_rule_rows(card_id: str, rules_list: list[dict]) -> list[dict]:
    return [
        {
            "card_id": card_id,
            "date": rule.get("date") or None,
            "title": rule.get("title"),
            "description": rule.get("description", ""),
        }
        for rule in rules_list
    ]


# ── Writers ───────────────────────────────────────────────────────────────────

def replace_card_rules(session: Session, card_id: str, rules_list: list[dict]) -> None:
    """RULES.json is a full-replace list per card each sync (see
    api_ga._update_rule) — mirror that: wipe this card's rules and reinsert.
    An empty list still clears stale rows."""
    session.execute(delete(CardRule).where(CardRule.card_id == card_id))
    rows = build_rule_rows(card_id, rules_list)
    for batch in _chunked(rows):
        session.execute(CardRule.__table__.insert(), batch)


def migrate_temp_foil_db(session: Session, card_id: str, edition_id: str, real_foil_id: str,
                         temp_foil_id: str = TEMP_FOIL_ID) -> None:
    """DB equivalent of api_ga._migrate_temp_foil: the API just reported real
    foils for an edition that until now only had stand-ins, so move every row
    that points at stand-in `temp_foil_id` onto `real_foil_id`, then drop the
    stand-in foil row.

    Every table with a foreign key to foils has to be moved first, or the
    final delete fails and rolls the whole card write back — on every sync,
    forever. That's prices, inventory, deck cards and the watch/wish lists.
    Tables with a uniqueness rule that includes foil_id merge instead of
    colliding: inventory and deck quantities add up; a watch/wish entry the
    user already has on the real foil just drops the stand-in's."""
    for model in (PriceSale, PriceListing):
        session.execute(
            update(model)
            .where(model.edition_id == edition_id, model.foil_id == temp_foil_id)
            .values(foil_id=real_foil_id)
        )

    # Inventory / deck rows: one row per (section, card, edition, foil) — fold
    # into an existing real-foil row in the same section, else repoint.
    for model in (InventoryCard, DeckCard):
        temp_rows = session.execute(
            select(model).where(model.edition_id == edition_id, model.foil_id == temp_foil_id)
        ).scalars().all()
        for rec in temp_rows:
            existing = session.execute(
                select(model).where(
                    model.section_id == rec.section_id,
                    model.card_id == rec.card_id,
                    model.edition_id == edition_id,
                    model.foil_id == real_foil_id,
                )
            ).scalar_one_or_none()
            if existing is not None:
                existing.quantity += rec.quantity
                session.delete(rec)
            else:
                rec.foil_id = real_foil_id
        session.flush()

    # Watch / wish lists: one row per (user, edition, foil) — keep the
    # user's existing real-foil entry if they have one, else repoint.
    for model in (WatchlistEntry, WishlistEntry):
        temp_rows = session.execute(
            select(model).where(model.edition_id == edition_id, model.foil_id == temp_foil_id)
        ).scalars().all()
        for rec in temp_rows:
            has_real = session.execute(
                select(model.id).where(
                    model.user_id == rec.user_id, model.edition_id == edition_id, model.foil_id == real_foil_id,
                )
            ).first()
            if has_real is not None:
                session.delete(rec)
            else:
                rec.foil_id = real_foil_id
        session.flush()

    session.execute(
        delete(Foil).where(Foil.edition_id == edition_id, Foil.foil_id == temp_foil_id)
    )


def persist_card(
    session: Session,
    *,
    card_id: str,
    slug: str,
    name: str | None,
    info_entry: dict,
    rules_list: list[dict],
    thema_by_edition: dict,
    last_synced,
) -> None:
    """Write one card's full catalog footprint to Postgres, FK-safe order:
    sets -> cards -> card_slugs -> card_rules -> editions -> foils ->
    thema_scores. Caller owns the transaction."""
    editions = info_entry.get("editions", {})

    set_rows = {}
    for edition in editions.values():
        prefix = edition.get("set_prefix")
        if prefix:
            set_rows[_set_slug(prefix)] = {
                "slug": _set_slug(prefix), "prefix": prefix, "name": edition.get("set_name"),
            }
    upsert(session, Set, list(set_rows.values()), ["slug"], update_cols=SET_CATALOG_COLS)

    upsert(session, Card, [build_card_row(card_id, info_entry, name, last_synced)], ["card_id"],
           update_cols=CARD_UPDATE_COLS)
    upsert(session, CardSlug, [{"slug": slug, "card_id": card_id, "name": name}], ["slug"])
    replace_card_rules(session, card_id, rules_list)

    upsert(
        session, Edition,
        [build_edition_row(card_id, eid, e) for eid, e in editions.items()],
        ["edition_id"], update_cols=EDITION_CATALOG_COLS,
    )

    top_level, variants = [], []
    for eid, e in editions.items():
        foils = e.get("foils", {})
        # Still no real foils from the API: keep whichever stand-ins this edition
        # already has — an admin may have switched one off (custom_cards.
        # set_standin_kinds) — rather than re-adding both. Brand-new editions
        # (none stored yet) get both.
        if foils and all(fid in TEMP_FOIL_KINDS for fid in foils):
            kept = set(session.execute(
                select(Foil.foil_id).where(Foil.edition_id == eid, Foil.foil_id.in_(list(TEMP_FOIL_KINDS)))
            ).scalars().all())
            if kept:
                foils = {fid: f for fid, f in foils.items() if fid in kept}
        t, v = build_foil_rows(eid, foils)
        top_level += t
        variants += v
    upsert(session, Foil, top_level, ["edition_id", "foil_id"])
    session.flush()
    upsert(session, Foil, variants, ["edition_id", "foil_id"])

    # An edition that until now only had stand-in foils but now has real
    # one(s) — promote each stand-in onto the real foil of its kind (moving
    # everything that points at it), then drop it.
    for eid, e in editions.items():
        foils = e.get("foils", {})
        if not any(fid not in TEMP_FOIL_KINDS for fid in foils):
            continue
        present = session.execute(
            select(Foil.foil_id).where(Foil.edition_id == eid, Foil.foil_id.in_(list(TEMP_FOIL_KINDS)))
        ).scalars().all()
        for temp_id in present:
            migrate_temp_foil_db(session, card_id, eid, real_foil_for_temp(temp_id, foils), temp_id)

    upsert(session, ThemaScore, build_thema_rows(thema_by_edition), ["edition_id", "foil_type"])

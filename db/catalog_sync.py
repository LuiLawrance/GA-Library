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
    Card, CardRule, CardSlug, Edition, Foil, InventoryCard, PriceListing, PriceSale, Set, ThemaScore,
)
from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

# Must match api_ga.TEMP_FOIL_ID (api_ga imports it from here). Synthetic
# foil for an edition the API hasn't reported circulation data for yet — see
# api_ga._card_data_to_info_entry / _migrate_temp_foil.
TEMP_FOIL_ID = "temp"

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


def migrate_temp_foil_db(session: Session, card_id: str, edition_id: str, real_foil_id: str) -> None:
    """DB equivalent of api_ga._migrate_temp_foil: the API just reported a
    real foil for an edition that previously only had the TEMP_FOIL_ID
    placeholder, so move every price / inventory row off the placeholder and
    onto the real foil, then drop the placeholder foil row.

    Best-effort on price rows: a bulk foil_id reassign can in principle
    collide with price_sales' (edition_id, foil_id, date, marketplace,
    price, quantity, condition) unique constraint if an identical real-foil
    row already exists — vanishingly unlikely for a card that until now had
    no real foil at all, and a collision just raises and rolls the whole
    card write back, same as any other sync error."""
    for model in (PriceSale, PriceListing):
        session.execute(
            update(model)
            .where(model.edition_id == edition_id, model.foil_id == TEMP_FOIL_ID)
            .values(foil_id=real_foil_id)
        )

    temp_inv = session.execute(
        select(InventoryCard).where(
            InventoryCard.edition_id == edition_id, InventoryCard.foil_id == TEMP_FOIL_ID
        )
    ).scalars().all()
    for rec in temp_inv:
        existing = session.execute(
            select(InventoryCard).where(
                InventoryCard.section_id == rec.section_id,
                InventoryCard.card_id == rec.card_id,
                InventoryCard.edition_id == edition_id,
                InventoryCard.foil_id == real_foil_id,
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.quantity += rec.quantity
            session.delete(rec)
        else:
            rec.foil_id = real_foil_id
    session.flush()

    session.execute(
        delete(Foil).where(Foil.edition_id == edition_id, Foil.foil_id == TEMP_FOIL_ID)
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

    upsert(session, Card, [build_card_row(card_id, info_entry, name, last_synced)], ["card_id"])
    upsert(session, CardSlug, [{"slug": slug, "card_id": card_id, "name": name}], ["slug"])
    replace_card_rules(session, card_id, rules_list)

    upsert(
        session, Edition,
        [build_edition_row(card_id, eid, e) for eid, e in editions.items()],
        ["edition_id"], update_cols=EDITION_CATALOG_COLS,
    )

    top_level, variants = [], []
    for eid, e in editions.items():
        t, v = build_foil_rows(eid, e.get("foils", {}))
        top_level += t
        variants += v
    upsert(session, Foil, top_level, ["edition_id", "foil_id"])
    session.flush()
    upsert(session, Foil, variants, ["edition_id", "foil_id"])

    # An edition that until now only had the placeholder foil but now has
    # real one(s) — promote it (move pricing/inventory over, drop the temp).
    for eid, e in editions.items():
        real_ids = [fid for fid in e.get("foils", {}) if fid != TEMP_FOIL_ID]
        if not real_ids:
            continue
        has_temp = session.execute(
            select(Foil.foil_id).where(Foil.edition_id == eid, Foil.foil_id == TEMP_FOIL_ID)
        ).first()
        if has_temp:
            real = next(
                (fid for fid in real_ids if (e["foils"][fid].get("kind") or "").upper() == "NONFOIL"),
                real_ids[0],
            )
            migrate_temp_foil_db(session, card_id, eid, real)

    upsert(session, ThemaScore, build_thema_rows(thema_by_edition), ["edition_id", "foil_type"])

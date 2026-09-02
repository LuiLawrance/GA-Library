from datetime import date, datetime
from db import catalog_sync
from db.catalog_sync import TEMP_FOIL_ID
from db.models import Card, CardError, CardSlug, Edition, FeaturedSetGroup, Foil, Set, ThemaScore
from db.session import get_session
from db_mode import is_db_mode
from pricing_ga import _sync_info
from settings import load_settings
from sqlalchemy import or_, select
from tqdm import tqdm
from util_file import new_dir, new_json

import copy
import db_cache
import json
import os
import re
import requests

API_CARD = "https://api.gatcg.com/cards/"
API_FEATURED_SETS = "https://api.gatcg.com/featured-sets"
API_HOST = "https://api.gatcg.com"
API_IMAGE = "https://api.gatcg.com/cards/images/"
API_SET = "https://api.gatcg.com/cards/search"

DIR_SETS = "DATA_GA/SETS_GA"
DIR_IMAGES = "DATA_GA/IMAGES_GA"
DIR_SET_IMAGES = "DATA_GA/IMAGES_SETS_GA"

JSON_EDITIONS = "DATA_GA/CARDS_GA/EDITIONS.json"
JSON_ERRORS = "DATA_GA/CARDS_GA/ERRORS.json"
JSON_FEATURED_SETS = "DATA_GA/CARDS_GA/FEATURED_SETS.json"
JSON_INFO = "DATA_GA/CARDS_GA/INFO.json"
JSON_RULES = "DATA_GA/CARDS_GA/RULES.json"
JSON_SET_SEARCHES = "DATA_GA/CARDS_GA/SET_SEARCHES.json"
JSON_SLUGS = "DATA_GA/CARDS_GA/SLUGS.json"
JSON_THEMA = "DATA_GA/CARDS_GA/THEMA.json"
JSON_UPDATE = "DATA_GA/CARDS_GA/UPDATE.json"

UPDATE_THRESHOLD = 30

# Synthetic foil_id for an edition whose API payload has no circulation data
# yet (typically a very recently released, low-print special/promo card).
# Lets the edition stay selectable everywhere a real foil_id normally would
# be required; _migrate_temp_foil() (JSON) / catalog_sync.migrate_temp_foil_db
# (Postgres) swaps it for the real one once the API reports it on a later
# sync. Defined in db/catalog_sync.py and re-exported here — both storage
# paths need the same sentinel.


def _api_search(slug: str, debug: bool = False) -> dict:
    try:
        if debug:
            print(f"Searching API: {slug}")

        response = requests.get(
            f"{API_CARD}{slug}",
            timeout=10
        )

        response.raise_for_status()
        card_data = response.json()

        if debug:
            print(
                f"Found card: "
                f"{card_data['name']}"
            )

        _persist_card(slug, card_data, debug)

        return card_data

    except requests.exceptions.HTTPError:
        print(
            f"Error: Card not found "
            f"({slug})"
        )

    except requests.exceptions.RequestException as e:
        print(
            f"Error: API request failed "
            f"({e})"
        )

    return {}


def _check_local(slug: str, debug: bool = False) -> bool:
    if is_db_mode():
        with get_session() as session:
            row = session.execute(
                select(Card.last_synced)
                .join(CardSlug, CardSlug.card_id == Card.card_id)
                .where(CardSlug.slug == slug)
            ).first()

        if row is None or row[0] is None:
            if debug:
                print(f"Not found locally: {slug}")
            return False

        days_since_update = (date.today() - row[0]).days

        if days_since_update > UPDATE_THRESHOLD:
            if debug:
                print(
                    f"Update needed: {slug} | "
                    f"last_updated={row[0].isoformat()} | "
                    f"days={days_since_update}"
                )
            return False

        if debug:
            print(
                f"Found locally: {slug} | "
                f"last_updated={row[0].isoformat()} | "
                f"days={days_since_update}"
            )
        return True

    slug_file = new_json(JSON_SLUGS)
    update_file = new_json(JSON_UPDATE)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    with update_file.open("r", encoding="utf-8") as f:
        update_data = json.load(f)

    if slug not in slug_data:
        if debug:
            print(f"Not found locally: {slug}")

        return False

    card_id = slug_data[slug]["card_id"]
    last_updated = update_data.get(card_id)

    if not last_updated:
        if debug:
            print(f"No update date found: {slug}")

        return False

    days_since_update = (
            date.today() - date.fromisoformat(last_updated)
    ).days

    if days_since_update > UPDATE_THRESHOLD:
        if debug:
            print(
                f"Update needed: {slug} | "
                f"last_updated={last_updated} | "
                f"days={days_since_update}"
            )

        return False

    if debug:
        print(
            f"Found locally: {slug} | "
            f"last_updated={last_updated} | "
            f"days={days_since_update}"
        )

    return True


def _format_search(card_name: str, debug: bool = False) -> str:
    slug = card_name.strip().lower()

    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = re.sub(r"\s+", "-", slug)
    slug = re.sub(r"-+", "-", slug)

    slug = slug.strip("-")

    if debug:
        print(f"Formatted search: '{card_name}' -> '{slug}'")

    return slug


# Downloads one edition's card art straight to DIR_IMAGES/{edition_id}.jpg,
# on demand — called by get_image (app.py) only once that specific image is
# actually requested, rather than eagerly for every edition a card search or
# set sync turns up. This also means a card searched while store_images_locally
# was off (so nothing got cached, and _check_local now short-circuits future
# re-searches of it) still fills in the moment its image is next requested
# with the setting on, without needing a re-search to trigger it.
# The API's own image filename is always exactly "{edition_id}.jpg" (verified
# against its /cards/{slug} responses — same fact get_image's redirect branch
# relies on), so this needs no edition/card lookup, just the id. Returns
# whether the file is present locally afterward (True if it was already
# cached), so the caller knows whether it's safe to serve.
def _download_card_image(edition_id: str, debug: bool = False) -> bool:
    image_dir = new_dir(DIR_IMAGES)
    image_file = image_dir / f"{edition_id}.jpg"

    if image_file.exists() and image_file.stat().st_size > 0:
        return True

    try:
        response = requests.get(
            f"{API_IMAGE}{edition_id}.jpg",
            timeout=10
        )

        response.raise_for_status()

        with image_file.open("wb") as f:
            f.write(response.content)

        if debug:
            print(
                f"Downloaded image: "
                f"{edition_id}.jpg"
            )

        return True

    except requests.exceptions.RequestException as e:
        _log_error(
            edition_id,
            e,
            debug
        )

        print(
            f"Image Request Error | "
            f"edition_id={edition_id} | "
            f"{e}"
        )

    except Exception as e:
        _log_error(
            edition_id,
            e,
            debug
        )

        print(
            f"Image Save Error | "
            f"edition_id={edition_id} | "
            f"{e}"
        )

    return False


def _log_error(identifier: str, error: Exception | str, debug: bool = False) -> None:
    timestamp = datetime.now().isoformat()

    if is_db_mode():
        # Never let error logging itself raise — it runs inside except: blocks.
        try:
            with get_session() as session:
                session.execute(CardError.__table__.insert().values(
                    occurred_at=timestamp, identifier=str(identifier), error=str(error),
                ))
        except Exception as e:
            print(f"Error log to Postgres failed | identifier={identifier} | {e}")

        if debug:
            print(f"Logged error | {identifier}")
        return

    error_file = new_json(JSON_ERRORS)

    with error_file.open("r", encoding="utf-8") as f:
        error_data = json.load(f)

    error_data[f"{timestamp}_{identifier}"] = {
        "timestamp": timestamp,
        "identifier": identifier,
        "error": str(error)
    }

    with error_file.open("w", encoding="utf-8") as f:
        json.dump(error_data, f, indent=4)

    if debug:
        print(
            f"Logged error | "
            f"{identifier}"
        )


def _sort_collector_number(collector_number: str, debug: bool = False) -> tuple:
    match = re.match(
        r"(\d+)([A-Z]*)",
        collector_number.upper()
    )

    if match:
        number = int(match.group(1))
        suffix = match.group(2)

        if debug:
            print(
                f"Collector sort: "
                f"{collector_number} -> "
                f"({number}, '{suffix}')"
            )

        return number, suffix

    if debug:
        print(
            f"Collector sort: "
            f"{collector_number} -> "
            f"(fallback)"
        )

    return float("inf"), collector_number


def _build_collector_map() -> dict:
    """edition_id → collector_number, across all set files."""
    if is_db_mode():
        cached = db_cache.peek("collector_map")
        if cached is not None:
            return cached

        with get_session() as session:
            rows = session.execute(
                select(Edition.edition_id, Edition.collector_number).where(Edition.collector_number.isnot(None))
            ).all()
            result = {row.edition_id: row.collector_number for row in rows}

        db_cache.put("collector_map", result)
        return result

    result = {}
    if os.path.exists(DIR_SETS):
        for f in os.scandir(DIR_SETS):
            if not f.name.endswith(".json"):
                continue
            with open(f.path, "r", encoding="utf-8") as fh:
                set_data = json.load(fh)
            for num, eids in set_data.items():
                if isinstance(eids, str):
                    eids = [eids]
                for eid in eids:
                    result[eid] = num
    return result


# ── Catalog readers — Postgres in DB mode, JSON otherwise ──────────────────────
#
# Each of these returns the exact same shape as json.load()-ing the matching
# JSON_* file, so every read call site across the app can swap a 2-3 line
# `with new_json(JSON_X).open(...) as f: data = json.load(f)` for one line
# (`data = load_x_data()`) with no other changes needed downstream.
#
# These are the READ side. The catalog WRITE side is storage-aware too:
# _persist_card (used by _api_search / set_search) and sync_featured_sets
# write Postgres directly in DB mode via db/catalog_sync.py — a card found
# by a live API search shows up here on the very next read (the write path
# calls db_cache.bust()), no migrate_json_to_pg.py run needed. Only the
# _update_* helpers themselves stay JSON-only; they're the JSON branch of
# _persist_card now, not called directly. Still JSON-only in every mode:
# card/set image files and the pricing-scrape writers (see pricing_ga.py /
# api_tcgplayer.py Stage 6 notes).

def _json_load(path: str) -> dict:
    with new_json(path).open("r", encoding="utf-8") as f:
        return json.load(f)


# ── DB-mode read cache ────────────────────────────────────────────────────────
#
# Every whole-table reader below caches its DB-mode result (see db_cache.py for
# why that's safe — the data only moves on an explicit admin sync). JSON mode
# is never cached: it reads files directly, which is already fast and keeps
# api_cards_search's read-after-write correct. _db_cached wraps the
# peek/build/put dance so each reader stays a two-line change.

def _db_cached(key: str, build):
    cached = db_cache.peek(key)
    if cached is not None:
        return cached
    result = build()
    db_cache.put(key, result)
    return result


def load_info_data() -> dict:
    if not is_db_mode():
        return _json_load(JSON_INFO)
    return _db_cached("info_data", _load_info_data_db)


def _shape_db_foils(edition_foils: list) -> dict:
    """[Foil rows for one edition] → INFO.json-style {foil_id: {...}} dict,
    folding each variant row in under its parent foil's `variants`."""
    def foil_shape(f) -> dict:
        return {"kind": f.kind, "population": f.population, "printing": f.printing}

    variants_by_parent: dict[str, dict] = {}
    for f in edition_foils:
        if f.parent_foil_id is not None:
            variants_by_parent.setdefault(f.parent_foil_id, {})[f.foil_id] = foil_shape(f)

    return {
        f.foil_id: {**foil_shape(f), "variants": variants_by_parent.get(f.foil_id, {})}
        for f in edition_foils if f.parent_foil_id is None
    }


def _shape_db_edition(edition, set_name, set_prefix, foils_dict: dict, *, with_collector: bool) -> dict:
    shaped = {
        "date_created": edition.date_created.isoformat() if edition.date_created else None,
        "date_release": edition.date_release.isoformat() if edition.date_release else None,
        "date_update": edition.date_update.isoformat() if edition.date_update else None,
        "flavor": edition.flavor,
        "illustrator": edition.illustrator,
        "rarity": edition.rarity,
        "set_name": set_name or edition.set_slug,
        "set_prefix": set_prefix or edition.set_slug,
        "foils": foils_dict,
    }
    if with_collector:
        # load_info_data() leaves this to callers (JSON mode only has it in
        # the per-set files); load_card_detail_data() fills it in since the
        # column is right there on the row.
        shaped["collector_number"] = edition.collector_number or "?"
    return shaped


def _shape_db_card(card, editions_dict: dict, *, with_name: bool) -> dict:
    shaped = {
        "effect": card.effect,
        "effect_html": card.effect_html,
        "effect_raw": card.effect_raw,
        "element": card.element,
        "legality": {
            "draft": card.legality_draft, "pantheon": card.legality_pantheon, "standard": card.legality_standard,
        },
        "stats": {
            "cost_memory": card.cost_memory, "cost_reserve": card.cost_reserve, "durability": card.durability,
            "level": card.level, "life": card.life, "power": card.power,
            # See Card.speed_fast's comment — a boolean "Fast" keyword some
            # cards carry instead of a numeric Speed stat.
            "speed": card.speed if card.speed_fast is None else card.speed_fast,
        },
        "types": card.types or [],
        "editions": editions_dict,
    }
    if with_name:
        # load_info_data() omits name (INFO.json has none — it's resolved
        # from SLUGS.json); the DB row carries it, so the scoped single-card
        # reader can skip that lookup.
        shaped["name"] = card.name
    return shaped


def _load_info_data_db() -> dict:
    with get_session() as session:
        cards = session.execute(select(Card)).scalars().all()
        editions = session.execute(
            select(Edition, Set.name, Set.prefix).outerjoin(Set, Set.slug == Edition.set_slug)
        ).all()
        foils = session.execute(select(Foil)).scalars().all()

    editions_by_card: dict[str, list] = {}
    for edition, set_name, set_prefix in editions:
        editions_by_card.setdefault(edition.card_id, []).append((edition, set_name, set_prefix))

    foils_by_edition: dict[str, list] = {}
    for f in foils:
        foils_by_edition.setdefault(f.edition_id, []).append(f)

    result = {}
    for card in cards:
        editions_dict = {
            edition.edition_id: _shape_db_edition(
                edition, set_name, set_prefix,
                _shape_db_foils(foils_by_edition.get(edition.edition_id, [])),
                with_collector=False,
            )
            for edition, set_name, set_prefix in editions_by_card.get(card.card_id, [])
        }
        result[card.card_id] = _shape_db_card(card, editions_dict, with_name=False)

    return result


def load_card_detail_data(card_id: str) -> dict | None:
    """Everything GET /api/cards/{card_id} needs about ONE card: the same
    shape as load_info_data()[card_id], plus the card `name` and each
    edition's `collector_number` already filled in — or None if there's no
    such card.

    DB mode runs a few card-scoped indexed queries instead of
    load_info_data()'s whole-catalog hydration; this is the hot path behind
    the card drawer. JSON mode slices the bulk readers, matching what
    api_card_detail did inline before."""
    if not is_db_mode():
        info = load_info_data().get(card_id)
        if not info:
            return None

        # Deep-copied because the caller mutates editions (adds thema,
        # pricing, product_id, ...) and load_info_data()'s result can be
        # shared with other readers in the same request.
        info = copy.deepcopy(info)

        slug_data = load_slugs_data()
        info["name"] = next(
            (data["name"] for data in slug_data.values() if data.get("card_id") == card_id),
            None,
        )

        for edition_id, edition_info in info.get("editions", {}).items():
            set_slug = edition_info.get("set_prefix", "").lower().replace(" ", "_")
            set_data = load_set_collector_data(set_slug)
            edition_info["collector_number"] = next(
                (num for num, eids in set_data.items()
                 if edition_id in (eids if isinstance(eids, list) else [eids])),
                "?",
            )
        return info

    with get_session() as session:
        card = session.get(Card, card_id)
        if card is None:
            return None

        edition_rows = session.execute(
            select(Edition, Set.name, Set.prefix)
            .outerjoin(Set, Set.slug == Edition.set_slug)
            .where(Edition.card_id == card_id)
        ).all()
        edition_ids = [edition.edition_id for edition, _, _ in edition_rows]
        foils = (
            session.execute(select(Foil).where(Foil.edition_id.in_(edition_ids))).scalars().all()
            if edition_ids else []
        )

    foils_by_edition: dict[str, list] = {}
    for f in foils:
        foils_by_edition.setdefault(f.edition_id, []).append(f)

    editions_dict = {
        edition.edition_id: _shape_db_edition(
            edition, set_name, set_prefix,
            _shape_db_foils(foils_by_edition.get(edition.edition_id, [])),
            with_collector=True,
        )
        for edition, set_name, set_prefix in edition_rows
    }
    return _shape_db_card(card, editions_dict, with_name=True)


def load_editions_data() -> dict:
    if not is_db_mode():
        return _json_load(JSON_EDITIONS)
    return _db_cached("editions_data", _load_editions_data_db)


def _load_editions_data_db() -> dict:
    with get_session() as session:
        rows = session.execute(select(Edition.edition_id, Edition.card_id)).all()
        return {row.edition_id: {"card_id": row.card_id} for row in rows}


def load_slugs_data() -> dict:
    if not is_db_mode():
        return _json_load(JSON_SLUGS)
    return _db_cached("slugs_data", _load_slugs_data_db)


def _load_slugs_data_db() -> dict:
    with get_session() as session:
        rows = session.execute(select(CardSlug)).scalars().all()
        return {row.slug: {"name": row.name, "card_id": row.card_id} for row in rows}


def load_thema_data() -> dict:
    if not is_db_mode():
        return _json_load(JSON_THEMA)
    return _db_cached("thema_data", _load_thema_data_db)


def _load_thema_data_db() -> dict:
    with get_session() as session:
        rows = session.execute(select(ThemaScore)).scalars().all()

    result: dict[str, dict] = {}
    for row in rows:
        result.setdefault(row.edition_id, {})[row.foil_type] = {
            "charm": row.charm, "ferocity": row.ferocity, "grace": row.grace,
            "mystique": row.mystique, "valor": row.valor, "dynamic": row.dynamic,
        }
    return result


def load_thema_for_editions(edition_ids: list[str]) -> dict:
    """load_thema_data() sliced to just `edition_ids` — the drawer only ever
    needs one card's editions, so DB mode queries those rows directly instead
    of hydrating the whole thema_scores table."""
    if not is_db_mode():
        data = load_thema_data()
        return {eid: data.get(eid, {}) for eid in edition_ids}

    if not edition_ids:
        return {}

    with get_session() as session:
        rows = session.execute(
            select(ThemaScore).where(ThemaScore.edition_id.in_(edition_ids))
        ).scalars().all()

    result: dict[str, dict] = {}
    for row in rows:
        result.setdefault(row.edition_id, {})[row.foil_type] = {
            "charm": row.charm, "ferocity": row.ferocity, "grace": row.grace,
            "mystique": row.mystique, "valor": row.valor, "dynamic": row.dynamic,
        }
    return result


def load_update_data() -> dict:
    if not is_db_mode():
        return _json_load(JSON_UPDATE)
    return _db_cached("update_data", _load_update_data_db)


def _load_update_data_db() -> dict:
    with get_session() as session:
        rows = session.execute(
            select(Card.card_id, Card.last_synced).where(Card.last_synced.isnot(None))
        ).all()
        return {row.card_id: row.last_synced.isoformat() for row in rows}


def load_featured_sets_data() -> dict:
    if not is_db_mode():
        return _json_load(JSON_FEATURED_SETS)
    return _db_cached("featured_sets_data", _load_featured_sets_data_db)


def _load_featured_sets_data_db() -> dict:
    with get_session() as session:
        groups = session.execute(select(FeaturedSetGroup)).scalars().all()
        sets = session.execute(
            select(Set).where(Set.featured_group.isnot(None))
            .order_by(Set.featured_group, Set.featured_position)
        ).scalars().all()

    sets_by_group: dict[str, list] = {}
    for s in sets:
        sets_by_group.setdefault(s.featured_group, []).append({"prefix": s.prefix, "slug": s.slug})

    return {
        group.group_name: {"sets": sets_by_group.get(group.group_name, []), "image_path": group.image_path}
        for group in groups
    }


# ── Set-search bookkeeping (last set-searched date + admin-entered tcgcsv
# Group ID) ─────────────────────────────────────────────────────────────────
#
# JSON mode keeps this in DATA_GA/CARDS_GA/SET_SEARCHES.json — app.py owns the
# in-memory _set_search_cache mirror of that file and every write to it. DB
# mode instead stores both on the set's own row (sets.last_searched /
# sets.tcgplayer_group_id) so an admin's manually-entered Group ID lands in
# the real backing store rather than only in a JSON file the DB-mode app
# never reads back. catalog_sync and sync_featured_sets both deliberately
# leave these two columns untouched (see db/catalog_sync.py) so the writers
# here are their sole owner; migrate_json_to_pg.migrate_sets seeds them onto
# new rows only, never nulls a live value.

def load_set_searches_data() -> dict:
    """slug -> {"last_searched": ISO str, "tcgplayer_group_id": str}, carrying
    only the keys that actually have a value — mirrors SET_SEARCHES.json's
    normalized shape (see app.py's _set_search_cache back-compat pass). DB
    mode only; JSON mode reads _set_search_cache in app.py directly."""
    return _db_cached("set_searches_data", _load_set_searches_data_db)


def _load_set_searches_data_db() -> dict:
    with get_session() as session:
        rows = session.execute(
            select(Set.slug, Set.last_searched, Set.tcgplayer_group_id).where(
                or_(Set.last_searched.isnot(None), Set.tcgplayer_group_id.isnot(None))
            )
        ).all()

    result: dict[str, dict] = {}
    for slug, last_searched, group_id in rows:
        entry: dict = {}
        if last_searched is not None:
            entry["last_searched"] = last_searched.isoformat()
        if group_id is not None:
            entry["tcgplayer_group_id"] = group_id
        result[slug] = entry
    return result


def _persist_set_bookkeeping(slug: str, values: dict) -> None:
    """Upsert one sets row, touching only the given bookkeeping column(s).
    Creates a bare row — prefix falls back to the slug, matching
    migrate_json_to_pg.migrate_sets — for a set with no catalog or featured
    data yet, so a Group ID can be entered before the set is ever searched.
    Busts the DB read cache."""
    with get_session() as session:
        catalog_sync.upsert(
            session, Set,
            [{"slug": slug, "prefix": slug, **values}],
            ["slug"],
            update_cols=list(values),
        )
    db_cache.bust()


def set_group_id(slug: str, group_id: str | None) -> None:
    """DB-mode writer for the admin-entered tcgcsv Group ID (JSON mode: see
    api_admin_set_group_id in app.py)."""
    _persist_set_bookkeeping(slug, {"tcgplayer_group_id": group_id})


def mark_set_searched(slug: str, when: str) -> None:
    """DB-mode writer for a set's last-searched date — `when` is an ISO date
    string (JSON mode: see api_sets_search_start in app.py)."""
    _persist_set_bookkeeping(slug, {"last_searched": when})


def load_set_names() -> list[str]:
    """Sorted list of set prefixes with at least one synced card, e.g. for
    the /api/sets route. DB mode deliberately excludes sets.rows that exist
    only as FEATURED_SETS.json membership metadata for a not-yet-searched
    set (see migrate_json_to_pg.py's migrate_sets) — those aren't
    searchable yet, matching JSON mode only ever listing sets that have a
    real DATA_GA/SETS_GA/{slug}.json file."""
    if not is_db_mode():
        if not os.path.exists(DIR_SETS):
            return []
        return sorted([
            os.path.splitext(f.name)[0].upper().replace("_", " ")
            for f in os.scandir(DIR_SETS) if f.name.endswith(".json")
        ])
    return _db_cached("set_names", _load_set_names_db)


def _load_set_names_db() -> list[str]:
    with get_session() as session:
        rows = session.execute(
            select(Set.prefix).where(Set.slug.in_(select(Edition.set_slug).distinct()))
        ).scalars().all()
        return sorted(rows)


def load_set_collector_data(set_slug: str) -> dict:
    """collector_number → [edition_id, ...] for ONE set — mirrors a single
    DATA_GA/SETS_GA/{slug}.json file's shape. Result order matches
    _sort_collector_number, same as the JSON file's own on-disk order
    (_update_sets re-sorts it after every write) — callers that just
    iterate the dict (rather than re-sorting themselves) depend on that."""
    if not is_db_mode():
        path = f"{DIR_SETS}/{set_slug}.json"
        return _json_load(path) if os.path.exists(path) else {}
    return _db_cached(f"set_collector:{set_slug}", lambda: _load_set_collector_data_db(set_slug))


def _load_set_collector_data_db(set_slug: str) -> dict:
    with get_session() as session:
        rows = session.execute(
            select(Edition.edition_id, Edition.collector_number)
            .where(Edition.set_slug == set_slug, Edition.collector_number.isnot(None))
        ).all()

    result: dict[str, list] = {}
    for row in sorted(rows, key=lambda r: _sort_collector_number(r.collector_number)):
        result.setdefault(row.collector_number, []).append(row.edition_id)
    return result


def load_all_set_collector_data() -> dict:
    """set_prefix → {collector_number → [edition_id, ...]} across every set,
    each set's inner dict ordered the same way as load_set_collector_data."""
    if not is_db_mode():
        result = {}
        if os.path.exists(DIR_SETS):
            for f in os.scandir(DIR_SETS):
                if not f.name.endswith(".json"):
                    continue
                prefix = f.name[:-5].upper().replace("_", " ")
                result[prefix] = _json_load(f.path)
        return result
    return _db_cached("all_set_collector_data", _load_all_set_collector_data_db)


def _load_all_set_collector_data_db() -> dict:
    with get_session() as session:
        rows = session.execute(
            select(Set.prefix, Edition.edition_id, Edition.collector_number)
            .join(Edition, Edition.set_slug == Set.slug)
            .where(Edition.collector_number.isnot(None))
        ).all()

    result: dict[str, dict] = {}
    for prefix, edition_id, collector_number in sorted(rows, key=lambda r: _sort_collector_number(r[2])):
        result.setdefault(prefix, {}).setdefault(collector_number, []).append(edition_id)
    return result


def _update_edition(card_data: dict, debug: bool = False) -> None:
    edition_file = new_json(JSON_EDITIONS)

    with edition_file.open("r", encoding="utf-8") as f:
        edition_data = json.load(f)

    edition_count = 0

    for edition in card_data["editions"]:
        edition_id = edition["uuid"]
        card_id = edition["card_id"]

        edition_data[edition_id] = {
            "card_id": card_id
        }

        edition_count += 1

    with edition_file.open("w", encoding="utf-8") as f:
        json.dump(edition_data, f, indent=4)

    if debug:
        print(
            f"Updated EDITIONS.json | "
            f"editions={edition_count}"
        )


def _migrate_temp_foil(card_id: str, edition_id: str, real_foil_id: str, debug: bool = False) -> None:
    """Moves sales, listings, and every user's inventory data for this edition
    off the TEMP_FOIL_ID placeholder and onto the real foil_id the API just
    reported. Called once per edition, right as the placeholder is about to
    be dropped from INFO.json."""
    from pricing_ga import JSON_LISTINGS, JSON_SALES

    moved_records = 0

    for json_path in (JSON_SALES, JSON_LISTINGS):
        target_file = new_json(json_path)

        with target_file.open("r", encoding="utf-8") as f:
            data = json.load(f)

        temp_records = data.get(card_id, {}).get(edition_id, {}).pop(TEMP_FOIL_ID, None)

        if temp_records:
            data.setdefault(card_id, {}).setdefault(edition_id, {}).setdefault(real_foil_id, [])
            data[card_id][edition_id][real_foil_id].extend(temp_records)
            moved_records += len(temp_records)

            with target_file.open("w", encoding="utf-8") as f:
                json.dump(data, f, indent=4, ensure_ascii=False)

    inv_dir = "DATA_GA/INV_GA"
    moved_inventory = 0

    if os.path.exists(inv_dir):
        for entry in os.scandir(inv_dir):
            if not entry.name.endswith(".json"):
                continue

            with open(entry.path, "r", encoding="utf-8") as f:
                inv_data = json.load(f)

            changed = False

            for bin_info in inv_data.values():
                for cards in bin_info.get("sections", {}).values():
                    qty = cards.get(card_id, {}).get(edition_id, {}).pop(TEMP_FOIL_ID, None)

                    if qty:
                        cards.setdefault(card_id, {}).setdefault(edition_id, {})
                        cards[card_id][edition_id][real_foil_id] = (
                                cards[card_id][edition_id].get(real_foil_id, 0) + qty
                        )
                        changed = True
                        moved_inventory += 1

                    if card_id in cards and edition_id in cards[card_id] and not cards[card_id][edition_id]:
                        del cards[card_id][edition_id]
                    if card_id in cards and not cards[card_id]:
                        del cards[card_id]

            if changed:
                with open(entry.path, "w", encoding="utf-8") as f:
                    json.dump(inv_data, f, indent=4, ensure_ascii=False)

    if debug:
        print(
            f"Migrated temp foil | "
            f"card_id={card_id} | "
            f"edition_id={edition_id} | "
            f"real_foil_id={real_foil_id} | "
            f"sales/listings_records={moved_records} | "
            f"inventory_entries={moved_inventory}"
        )


def _card_data_to_info_entry(card_data: dict) -> dict:
    """Build the INFO.json-style entry (`info_data[card_id]`) for one card
    straight from a raw Grand Archive API payload.

    This is the shape db/catalog_sync.py consumes in DB mode, and the same
    shape _update_info merges into INFO.json in JSON mode — the per-card /
    per-edition field handling here is deliberately parallel to _update_info
    below; change both together. One addition: `collector_number` per
    edition (the editions table carries it as a column; _update_info leaves
    collector numbers to the per-set files via _update_sets)."""
    legality = {"draft": True, "pantheon": True, "standard": True}
    for format_name, format_data in (card_data.get("legality") or {}).items():
        if format_data.get("limit") == 0:
            legality[format_name.lower()] = False

    combined_types = []
    for value in card_data.get("types", []) + card_data.get("subtypes", []):
        if value not in combined_types:
            combined_types.append(value)

    def _date(value):
        return value.split("T")[0] if value else value

    entry = {
        "effect": card_data.get("effect"),
        "effect_html": card_data.get("effect_html"),
        "effect_raw": card_data.get("effect_raw"),
        "element": card_data.get("element"),
        "legality": legality,
        "stats": {
            "cost_memory": card_data.get("cost_memory"),
            "cost_reserve": card_data.get("cost_reserve"),
            "durability": card_data.get("durability"),
            "level": card_data.get("level"),
            "life": card_data.get("life"),
            "power": card_data.get("power"),
            "speed": card_data.get("speed"),
        },
        "types": combined_types,
        "editions": {},
    }

    for edition in card_data["editions"]:
        foils = {}
        for foil in edition.get("circulationTemplates", []) + edition.get("circulations", []):
            foils[foil["uuid"]] = {
                "kind": foil["kind"],
                "population": foil.get("population"),
                "printing": foil.get("printing"),
                "variants": {
                    variant["uuid"]: {
                        "kind": variant.get("description", variant["kind"]),
                        "population": variant.get("population"),
                        "printing": variant.get("printing"),
                    }
                    for variant in foil.get("variants", [])
                },
            }

        # No circulation data yet — synthetic foil so the edition stays
        # selectable. A real foil arriving on a later sync is promoted off
        # the placeholder by catalog_sync.persist_card (DB) / _update_info's
        # merge branch + _migrate_temp_foil (JSON).
        if not foils:
            foils[TEMP_FOIL_ID] = {"kind": "NONFOIL", "population": None, "printing": None, "variants": {}}

        entry["editions"][edition["uuid"]] = {
            "collector_number": edition.get("collector_number"),
            "date_created": _date(edition.get("created_at")),
            "date_release": _date(edition["set"].get("release_date")),
            "date_update": _date(edition.get("last_update")),
            "flavor": edition.get("flavor") or None,
            "illustrator": edition["illustrator"],
            "rarity": edition["rarity"],
            "set_name": edition["set"]["name"],
            "set_prefix": edition["set"]["prefix"],
            "foils": foils,
        }

    return entry


def _card_data_to_rules(card_data: dict) -> list[dict]:
    """RULES.json-style list for one card from a raw API payload — shared by
    _update_rule (JSON) and catalog_sync.replace_card_rules (DB)."""
    rules = [
        {
            "date": rule.get("date_added"),
            "title": rule.get("title") or None,
            "description": rule.get("description"),
        }
        for rule in (card_data.get("rule") or [])
    ]
    rules.sort(key=lambda rule: rule.get("date") or "")
    return rules


def _card_data_to_thema(card_data: dict) -> dict:
    """THEMA.json-style {edition_id: {foil_type: scores}} for one card from a
    raw API payload — shared by _update_thema (JSON) and
    catalog_sync.build_thema_rows (DB). Only editions that actually carry
    thema scores appear."""
    result = {}

    for edition in card_data["editions"]:
        edition_thema = {}

        for foil_type in ["foil", "nonfoil"]:
            scores = {}

            for key, value in edition.items():
                if not key.startswith("thema_"):
                    continue

                if key in {"thema_foil", "thema_nonfoil", "thema_foil_dynamic", "thema_nonfoil_dynamic"}:
                    continue

                if not key.endswith(f"_{foil_type}"):
                    continue

                if value is None:
                    continue

                category = key.replace("thema_", "").replace(f"_{foil_type}", "")
                scores[category] = value

            if scores:
                scores["dynamic"] = edition.get(f"thema_{foil_type}_dynamic", False)
                edition_thema[foil_type] = scores

        if edition_thema:
            result[edition["uuid"]] = edition_thema

    return result


def _update_info(card_data: dict, debug: bool = False) -> None:
    card_id = card_data["editions"][0]["card_id"]

    effect = card_data.get("effect")
    effect_html = card_data.get("effect_html")
    effect_raw = card_data.get("effect_raw")

    legality_data = card_data.get("legality") or {}

    legality = {
        "draft": True,
        "pantheon": True,
        "standard": True
    }

    for format_name, format_data in legality_data.items():
        if format_data.get("limit") == 0:
            legality[format_name.lower()] = False

    types = card_data.get("types", [])
    subtypes = card_data.get("subtypes", [])

    combined_types = []

    for value in types + subtypes:
        if value not in combined_types:
            combined_types.append(value)

    stats = {
        "cost_memory": card_data.get("cost_memory"),
        "cost_reserve": card_data.get("cost_reserve"),
        "durability": card_data.get("durability"),
        "level": card_data.get("level"),
        "life": card_data.get("life"),
        "power": card_data.get("power"),
        "speed": card_data.get("speed")
    }

    info_file = new_json(JSON_INFO)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    if card_id not in info_data:
        info_data[card_id] = {}

        if debug:
            print(f"Added new card_id: {card_id}")

    info_data[card_id]["effect"] = effect
    info_data[card_id]["effect_html"] = effect_html
    info_data[card_id]["effect_raw"] = effect_raw
    info_data[card_id]["element"] = card_data.get("element")
    info_data[card_id]["legality"] = legality
    info_data[card_id]["stats"] = stats
    info_data[card_id]["types"] = combined_types

    if "editions" not in info_data[card_id]:
        info_data[card_id]["editions"] = {}

    if debug:
        print(
            f"Card metadata | "
            f"types={len(combined_types)}"
        )

    edition_count = 0
    foil_count = 0
    variant_count = 0

    for edition in card_data["editions"]:
        edition_id = edition["uuid"]

        rarity = edition["rarity"]

        set_name = edition["set"]["name"]
        set_prefix = edition["set"]["prefix"]

        illustrator = edition["illustrator"]

        date_created = edition.get("created_at")

        if date_created:
            date_created = date_created.split("T")[0]

        flavor = edition.get("flavor")

        if not flavor:
            flavor = None

        date_update = edition.get("last_update")

        if date_update:
            date_update = date_update.split("T")[0]

        date_release = edition["set"].get("release_date")

        if date_release:
            date_release = date_release.split("T")[0]

        editions = info_data[card_id]["editions"]

        if edition_id not in editions:
            editions[edition_id] = {}

        if "foil_ids" in editions[edition_id]:
            editions[edition_id]["foils"] = (
                editions[edition_id].pop("foil_ids")
            )

        editions[edition_id].pop("last_update", None)
        editions[edition_id].pop("release_date", None)

        editions[edition_id]["date_created"] = date_created
        editions[edition_id]["date_release"] = date_release
        editions[edition_id]["date_update"] = date_update
        editions[edition_id]["flavor"] = flavor
        editions[edition_id]["illustrator"] = illustrator
        editions[edition_id]["rarity"] = rarity
        editions[edition_id]["set_name"] = set_name
        editions[edition_id]["set_prefix"] = set_prefix

        if "foils" not in editions[edition_id]:
            editions[edition_id]["foils"] = {}

        edition_count += 1

        foil_entries = (
                edition.get("circulationTemplates", [])
                + edition.get("circulations", [])
        )

        for foil in foil_entries:
            foil_id = foil["uuid"]

            editions[edition_id]["foils"][foil_id] = {
                "kind": foil["kind"],
                "population": foil.get("population"),
                "printing": foil.get("printing"),
                "variants": {}
            }

            foil_count += 1

            for variant in foil.get("variants", []):
                variant_id = variant["uuid"]

                variant_kind = variant.get(
                    "description",
                    variant["kind"]
                )

                editions[edition_id]["foils"][foil_id]["variants"][variant_id] = {
                    "kind": variant_kind,
                    "population": variant.get("population"),
                    "printing": variant.get("printing")
                }

                variant_count += 1

        # No circulation data yet from the API (common for a very recently
        # released special/promo card) — give it a synthetic foil so it's
        # still selectable. If real foil(s) show up on a later sync, migrate
        # anything stored under the placeholder over and drop it.
        foils = editions[edition_id]["foils"]

        if not foils:
            foils[TEMP_FOIL_ID] = {"kind": "NONFOIL", "population": None, "printing": None, "variants": {}}
        elif TEMP_FOIL_ID in foils and len(foils) > 1:
            real_foil_id = next(
                (fid for fid, finfo in foils.items()
                 if fid != TEMP_FOIL_ID and (finfo.get("kind") or "").upper() == "NONFOIL"),
                next(fid for fid in foils if fid != TEMP_FOIL_ID)
            )
            _migrate_temp_foil(card_id, edition_id, real_foil_id, debug)
            del foils[TEMP_FOIL_ID]

        if debug:
            print(
                f"Processed edition: "
                f"{edition_id} "
                f"(rarity={rarity}, "
                f"set={set_prefix}, "
                f"illustrator='{illustrator}')"
            )

    with info_file.open("w", encoding="utf-8") as f:
        json.dump(info_data, f, indent=4)

    if debug:
        print(
            f"Updated INFO.json | "
            f"card_id={card_id} "
            f"| editions={edition_count} "
            f"| foils={foil_count} "
            f"| variants={variant_count}"
        )


def _update_rule(card_data: dict, debug: bool = False) -> None:
    card_id = card_data["editions"][0]["card_id"]
    rules = _card_data_to_rules(card_data)

    rule_file = new_json(JSON_RULES)

    with rule_file.open("r", encoding="utf-8") as f:
        rule_json = json.load(f)

    rule_json[card_id] = rules

    with rule_file.open("w", encoding="utf-8") as f:
        json.dump(rule_json, f, indent=4)

    if debug:
        print(
            f"Updated RULES.json | "
            f"card_id={card_id} | "
            f"rules={len(rules)}"
        )


# Filename slug for a set prefix's own JSON file under DIR_SETS (e.g. "DOA 1st"
# -> "doa_1st.json") — shared with sync_featured_sets so its recorded keys line
# up with these same files without a caller having to re-derive the slug.
def _set_slug(set_prefix: str) -> str:
    return set_prefix.lower().replace(" ", "_")


# Filename slug for a featured-set release's own banner image (e.g.
# ".asphodel/paradise" -> "asphodel_paradise") — shared between
# _download_set_image (which saves DIR_SET_IMAGES/{slug}.png) and
# GET /api/sets/featured (app.py), which builds the /set-images/{slug}.png
# URL every group's banner is fetched through without needing its own
# image_path — that's only looked up from JSON_FEATURED_SETS by
# get_set_image (app.py) itself, once a request for one of these URLs
# actually comes in.
def _group_slug(group_name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", group_name.lower()).strip("_")


def _update_sets(card_data: dict, debug: bool = False) -> None:
    set_count = 0

    for edition in card_data["editions"]:
        collector_number = edition["collector_number"]
        edition_id = edition["uuid"]
        set_prefix = edition["set"]["prefix"]

        set_file_name = _set_slug(set_prefix)

        set_file = new_json(
            f"{DIR_SETS}/{set_file_name}.json"
        )

        with set_file.open("r", encoding="utf-8") as f:
            set_data = json.load(f)

        if collector_number not in set_data:
            set_data[collector_number] = []

        if edition_id not in set_data[collector_number]:
            set_data[collector_number].append(edition_id)

        sorted_set_data = dict(
            sorted(
                set_data.items(),
                key=lambda item: _sort_collector_number(item[0], debug)
            )
        )

        with set_file.open("w", encoding="utf-8") as f:
            json.dump(sorted_set_data, f, indent=4)

        set_count += 1

        if debug:
            print(
                f"Added edition "
                f"{edition_id} "
                f"to {set_file_name}.json "
                f"as #{collector_number}"
            )

    if debug:
        print(
            f"Updated SETS directory | "
            f"editions={set_count}"
        )


def _update_slug(slug: str, card_data: dict, debug: bool = False) -> None:
    slug_file = new_json(JSON_SLUGS)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    card_id = card_data["editions"][0]["card_id"]
    card_name = card_data["name"]

    slug_data[slug] = {
        "name": card_name,
        "card_id": card_id
    }

    with slug_file.open("w", encoding="utf-8") as f:
        json.dump(slug_data, f, indent=4)

    if debug:
        print(
            f"Updated SLUGS.json | "
            f"slug='{slug}' | "
            f"name='{card_name}' | "
            f"card_id={card_id}"
        )


def _update_thema(card_data: dict, debug: bool = False) -> None:
    thema_file = new_json(JSON_THEMA)

    with thema_file.open("r", encoding="utf-8") as f:
        thema_data = json.load(f)

    new_thema = _card_data_to_thema(card_data)
    thema_data.update(new_thema)

    with thema_file.open("w", encoding="utf-8") as f:
        json.dump(thema_data, f, indent=4)

    if debug:
        print(
            f"Updated THEMA.json | "
            f"editions={len(new_thema)}"
        )


def _update_update(card_data: dict, debug: bool = False) -> None:
    card_id = card_data["editions"][0]["card_id"]

    update_file = new_json(JSON_UPDATE)

    with update_file.open("r", encoding="utf-8") as f:
        update_data = json.load(f)

    update_data[card_id] = date.today().isoformat()

    with update_file.open("w", encoding="utf-8") as f:
        json.dump(update_data, f, indent=4)

    if debug:
        print(
            f"Updated UPDATE.json | "
            f"card_id={card_id} | "
            f"date={update_data[card_id]}"
        )


def _persist_card(slug: str, card_data: dict, debug: bool = False, bust: bool = True) -> None:
    """Store one freshly-fetched card. DB mode writes the whole card's
    catalog footprint to Postgres in a single transaction (so a failure
    can't leave it half-written); JSON mode runs the per-file writer chain
    as before. Called by _api_search and set_search — the only two paths
    that turn a raw API payload into stored catalog data.

    `bust` drops the DB-mode read cache so the write is visible on the next
    read; set_search passes bust=False and busts once after its whole run
    instead of once per card."""
    if is_db_mode():
        card_id = card_data["editions"][0]["card_id"]

        with get_session() as session:
            catalog_sync.persist_card(
                session,
                card_id=card_id,
                slug=slug,
                name=card_data["name"],
                info_entry=_card_data_to_info_entry(card_data),
                rules_list=_card_data_to_rules(card_data),
                thema_by_edition=_card_data_to_thema(card_data),
                last_synced=date.today().isoformat(),
            )

        # Live writers now move Postgres directly, so the whole-table read
        # cache (load_info_data, load_slugs_data, ...) is stale — drop it so
        # api_cards_search's Step-1 re-read sees this card immediately.
        if bust:
            db_cache.bust()

        if debug:
            print(f"Persisted card to Postgres | card_id={card_id}")
        return

    _update_edition(card_data, debug)
    _update_info(card_data, debug)
    _update_rule(card_data, debug)
    _update_sets(card_data, debug)
    _update_slug(slug, card_data, debug)
    _update_thema(card_data, debug)
    _update_update(card_data, debug)

    _sync_info(card_data, debug)


def _existing_edition_ids(slug: str) -> list[str]:
    """edition_ids already stored for the card behind `slug`, or [] if it's
    unknown locally — used only to clear cached images on card_reset."""
    if is_db_mode():
        with get_session() as session:
            row = session.execute(
                select(Card.card_id)
                .join(CardSlug, CardSlug.card_id == Card.card_id)
                .where(CardSlug.slug == slug)
            ).first()
            if row is None:
                return []
            return list(session.execute(
                select(Edition.edition_id).where(Edition.card_id == row[0])
            ).scalars().all())

    with new_json(JSON_SLUGS).open("r", encoding="utf-8") as f:
        slug_data = json.load(f)
    if slug not in slug_data:
        return []
    with new_json(JSON_INFO).open("r", encoding="utf-8") as f:
        info_data = json.load(f)
    return list(info_data.get(slug_data[slug]["card_id"], {}).get("editions", {}).keys())


def card_reset(card_name: str, debug: bool = False) -> dict:
    """Force re-fetch a card from the API, overriding all local data and images."""
    slug = _format_search(card_name, debug)

    # Delete cached images for the card's existing editions — _download_card_image
    # refills each one lazily the next time GET /images/{edition_id}.jpg is
    # actually requested, rather than this eagerly re-downloading them.
    image_dir = new_dir(DIR_IMAGES)
    existing_editions = _existing_edition_ids(slug)

    if existing_editions:
        deleted = 0
        for edition_id in existing_editions:
            image_file = image_dir / f"{edition_id}.jpg"
            if image_file.exists():
                image_file.unlink()
                deleted += 1

        if debug or deleted:
            print(f"Deleted {deleted} existing image(s) for '{card_name}'")
    else:
        if debug:
            print(f"No local data found for '{card_name}' — fetching fresh")

    # Bypass _check_local and force a full API fetch
    result = _api_search(slug, debug)

    if result:
        print(f"Reset complete: {result.get('name', card_name)}")
    else:
        print(f"Reset failed: card not found on API ({slug})")

    return result


def card_search(card_names: list[str], debug: bool = False) -> dict[str, dict]:
    results = {}

    for card_name in card_names:
        slug = _format_search(card_name, debug)

        if _check_local(slug, debug):
            continue

        results[card_name] = _api_search(slug, debug)

    return results


def set_search(set_prefix: str, debug: bool = False, progress_callback=None) -> dict:
    """
    progress_callback, if provided, is called as progress_callback(done, total, card_name)
    after each card is processed (or fails), so callers can report live progress
    (e.g. a background job polled by a web frontend) without duplicating this logic.
    """
    results = {}

    page = 1
    total_pages = 1

    progress = None
    done = 0
    total = 0

    while page <= total_pages:
        response = requests.get(
            API_SET,
            params={
                "prefix": set_prefix,
                "page": page
            },
            timeout=10
        )

        response.raise_for_status()

        search_data = response.json()

        total_pages = search_data.get("total_pages", 1)

        if progress is None:
            total = search_data.get("total_cards", 0)
            progress = tqdm(
                total=total,
                desc=set_prefix.upper(),
                unit="card"
            )
            if progress_callback:
                progress_callback(done, total, None)

        cards = (
                search_data.get("data")
                or search_data.get("cards")
                or search_data.get("results")
                or []
        )

        if debug:
            print(
                f"Processing "
                f"{set_prefix.upper()} "
                f"page {page}/{total_pages}"
            )

            print(
                f"Cards found: "
                f"{len(cards)}"
            )

        for card_data in cards:
            card_name = card_data.get("name", "unknown")

            try:
                slug = _format_search(card_name, debug)

                if _check_local(slug, debug):
                    continue

                _persist_card(slug, card_data, debug, bust=False)

                results[card_name] = card_data

            except Exception as e:
                _log_error(
                    card_data.get("name", "unknown"),
                    e,
                    debug
                )

                print(
                    f"Card processing failed: "
                    f"{card_data.get('name', 'unknown')} | "
                    f"{e}"
                )

            finally:
                progress.update(1)
                done += 1
                if progress_callback:
                    progress_callback(done, total, card_name)

        page += 1

    if progress:
        progress.close()

    # One cache bust for the whole run (see _persist_card's bust arg) rather
    # than one per card — a set search touches hundreds of cards.
    if is_db_mode() and results:
        db_cache.bust()

    if debug:
        print(
            f"Completed set search: "
            f"{set_prefix.upper()} | "
            f"updated={len(results)}"
        )

    return results


# Downloads one featured-set release's banner straight to
# DIR_SET_IMAGES/{filename}, on demand — called by get_set_image (app.py)
# only once that specific banner is actually requested, mirroring
# _download_card_image's lazy, cache-and-skip-if-present behavior for card
# art. filename is {_group_slug(group_name)}.png — the group's own name
# rather than the API's own filename (e.g. "RDO.png"), since that naming
# doesn't reliably correspond to any of the group's own prefixes (Dawn of
# Ashes' banner is "DOA.png" even though no set in that group is prefixed
# "DOA") — so unlike _download_card_image, the caller has to pass image_path
# in rather than this deriving a download URL from filename alone. image_path
# is relative to API_HOST (e.g. "/featured-sets/images/RDO.png"), exactly as
# the Featured Sets API returns it and as sync_featured_sets records it per
# group in JSON_FEATURED_SETS. Returns whether the file is present locally
# afterward (True if it was already cached).
def _download_set_image(filename: str, image_path: str, debug: bool = False) -> bool:
    image_dir = new_dir(DIR_SET_IMAGES)
    image_file = image_dir / filename

    if image_file.exists() and image_file.stat().st_size > 0:
        return True

    try:
        response = requests.get(f"{API_HOST}{image_path}", timeout=10)
        response.raise_for_status()

        with image_file.open("wb") as f:
            f.write(response.content)

        if debug:
            print(f"Downloaded set image: {filename}")

        return True

    except requests.exceptions.RequestException as e:
        _log_error(f"featured-set-image:{filename}", e, debug)

        print(
            f"Set Image Request Error | "
            f"filename={filename} | "
            f"{e}"
        )

    return False


def sync_featured_sets(debug: bool = False) -> dict:
    """
    Fetches the Grand Archive API's Featured Sets list and records which local
    sets belong to one in JSON_FEATURED_SETS, keyed by release name (e.g.
    "Radiant Origins") rather than per-prefix — each entry lists every set in
    that release under "sets", as {"prefix": ..., "slug": ...} pairs. slug is
    _set_slug(prefix) — the same slug DIR_SETS/_update_sets uses for that
    set's own JSON filename (e.g. "DOA 1st" -> "doa_1st") — so a caller can go
    straight from one to DATA_GA/SETS_GA/{slug}.json without re-deriving it.

    Records each group's raw "image" path (relative to API_HOST) as
    "image_path" — GET /api/sets/featured (app.py) re-derives the actual
    /set-images/{filename} URL from group_name alone via _group_slug, so this
    isn't needed for that; it's what get_set_image (app.py) looks up to
    lazily download a group's banner (via _download_set_image) the first time
    it's actually requested, or to redirect straight to the API when
    store_images_locally is off. Doesn't reliably correspond to any of the
    group's own prefixes (see _download_set_image's own comment), so it can't
    be re-derived from the cached filename the way get_image's redirect
    branch re-derives a card's own image URL from its edition_id.

    Used by the Admin Cards Info panel (Featured/Other grouping) and by
    GET /api/sets/featured (app.py), which now reads this grouped shape
    directly rather than having to regroup a flat prefix-keyed one itself.
    """
    response = requests.get(API_FEATURED_SETS, timeout=10)
    response.raise_for_status()

    groups = response.json()

    featured = {}
    for group in groups:
        group_name = group.get("name")

        if not group_name:
            continue

        image_path = group.get("image")

        sets = []
        for set_entry in group.get("sets", []):
            prefix = set_entry.get("prefix")

            if not prefix:
                continue

            sets.append({"prefix": prefix, "slug": _set_slug(prefix)})

        featured[group_name] = {"sets": sets, "image_path": image_path}

    if is_db_mode():
        # featured_set_groups holds each group's image_path; sets.featured_*
        # carries membership + the deliberate per-group ordering. Mirrors
        # migrate_json_to_pg.migrate_sets sources A & D. update_cols is
        # scoped so an already-synced set keeps its prefix/name/catalog data.
        set_rows = [
            {
                "slug": member["slug"],
                "prefix": member["prefix"],
                "featured_group": group_name,
                "featured_position": position,
            }
            for group_name, data in featured.items()
            for position, member in enumerate(data["sets"])
        ]

        with get_session() as session:
            catalog_sync.upsert(
                session, FeaturedSetGroup,
                [{"group_name": g, "image_path": d["image_path"]} for g, d in featured.items()],
                ["group_name"],
            )
            catalog_sync.upsert(
                session, Set, set_rows, ["slug"],
                update_cols=["featured_group", "featured_position"],
            )

        db_cache.bust()
    else:
        featured_file = new_json(JSON_FEATURED_SETS)

        with featured_file.open("w", encoding="utf-8") as f:
            json.dump(featured, f, indent=4)

    if debug:
        print(
            f"Synced featured sets: "
            f"{len(featured)} releases | "
            f"{sum(len(v['sets']) for v in featured.values())} sets"
        )

    return featured

"""Admin-created ("custom") cards and printings — ones the Grand Archive API
doesn't have, so they can be catalogued, priced, collected and deck-built like
any other card.

Two shapes:
  * a whole new card (create_card) — built as an API-shaped payload and stored
    through api_ga._persist_card, so it lands in exactly the same places a
    synced card does (cards / editions / foils / sets / slugs, or the JSON
    files) in either storage mode;
  * a missing printing on an existing card (add_printing), e.g. a new promo —
    only the edition and its foils are written, so the real card's own data is
    never touched, and later API syncs of that card merge their editions in
    around it (neither mode drops editions missing from the payload).

Custom editions get the same two stand-in foils (Nonfoil + Foil, population
unknown) as an API edition with no circulation data — see
catalog_sync.TEMP_FOIL_KINDS — so sales of either kind can be imported.

Marked custom (cards/editions.is_custom in DB mode, CUSTOM.json in JSON mode)
so API syncs leave them alone: api_ga._check_local treats a custom card as
always fresh, and the catalog upserts never touch is_custom.

Art: uploaded by an admin. In DB mode the bytes go in custom_images, so every
instance sharing the database (local and Railway each have their own disk) can
serve it — each caches it to its own DATA_GA/IMAGES_GA/{edition_id}.jpg on
first view and re-caches when the upload is newer. JSON mode just keeps the
file on disk. Served by app.get_image regardless of store_images_locally (the
API has no copy to redirect to).
"""

from datetime import date, datetime, timezone
from pathlib import Path

import json
import os
import secrets
import string

from db.catalog_sync import TEMP_FOIL_KINDS, build_edition_row, build_foil_rows, temp_placeholder_foils, upsert, _set_slug
from db.models import (
    Card, CardRule, CardSlug, CustomImage, DeckCard, Edition, Foil, FoilTcgOverride, InventoryCard,
    MarketplaceScrapeClock, PriceListing, PriceSale, PricingFlag, Set, ThemaScore, WatchlistEntry, WishlistEntry,
)
from db.session import get_session
from db_mode import is_db_mode
from sqlalchemy import delete, func, select, update
from util_file import new_dir, new_json

import db_cache

JSON_CUSTOM = "DATA_GA/CARDS_GA/CUSTOM.json"
DIR_IMAGES = "DATA_GA/IMAGES_GA"

MAX_IMAGE_BYTES = 8 * 1024 * 1024

# Rarity codes the API uses (pricing_ga.RARITY_MAP) — validated on input.
VALID_RARITIES = set(range(1, 10))

_ID_ALPHABET = string.ascii_letters + string.digits


class CustomCardError(ValueError):
    """A request the admin can fix (bad input, name taken, ...) — the message is
    shown to them as-is."""


# ── Image helpers ─────────────────────────────────────────────────────────────

def sniff_image_type(data: bytes) -> str | None:
    """Content type from the file's own magic bytes (never trust the upload's
    claimed type or extension). None if it isn't a supported image."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _image_path(edition_id: str) -> Path:
    # Same filename the API-image cache uses, whatever the real format —
    # app.get_image serves it with the sniffed content type.
    return new_dir(DIR_IMAGES) / f"{edition_id}.jpg"


def _validate_image(data: bytes) -> str:
    if not data:
        raise CustomCardError("Choose an image to upload.")
    if len(data) > MAX_IMAGE_BYTES:
        raise CustomCardError(f"Image is too large (max {MAX_IMAGE_BYTES // (1024 * 1024)} MB).")
    content_type = sniff_image_type(data)
    if content_type is None:
        raise CustomCardError("Image must be a JPEG, PNG or WebP file.")
    return content_type


def _write_image(session, edition_id: str, data: bytes, content_type: str) -> None:
    """Store the art (inside the caller's session in DB mode) and refresh this
    instance's disk cache."""
    if session is not None:
        row = session.get(CustomImage, edition_id)
        now = datetime.now(timezone.utc)
        if row is None:
            session.add(CustomImage(edition_id=edition_id, content_type=content_type, data=data, updated_at=now))
        else:
            row.content_type, row.data, row.updated_at = content_type, data, now

    _image_path(edition_id).write_bytes(data)


def custom_image_path(edition_id: str) -> tuple[Path, str] | None:
    """(file, content_type) to serve for a custom edition's art, refreshing this
    instance's disk cache from Postgres when the stored upload is newer (or the
    cache is missing). Falls back to a file already on disk (JSON mode, or art
    from before a JSON -> DB switch). None if there's no art at all."""
    path = _image_path(edition_id)

    if is_db_mode():
        with get_session() as session:
            updated_at = session.execute(
                select(CustomImage.updated_at).where(CustomImage.edition_id == edition_id)
            ).scalar_one_or_none()

            if updated_at is not None:
                stale = not path.exists() or path.stat().st_mtime < updated_at.timestamp()
                if stale:
                    row = session.get(CustomImage, edition_id)
                    path.write_bytes(row.data)
                    os.utime(path, (updated_at.timestamp(), updated_at.timestamp()))

    if not path.exists():
        return None

    with path.open("rb") as f:
        content_type = sniff_image_type(f.read(16)) or "image/jpeg"
    return path, content_type


# ── Custom membership ─────────────────────────────────────────────────────────

def _load_custom_json() -> dict:
    with new_json(JSON_CUSTOM).open("r", encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("cards", [])
    data.setdefault("editions", [])
    return data


def _save_custom_json(data: dict) -> None:
    with new_json(JSON_CUSTOM).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)


def custom_ids() -> dict[str, set[str]]:
    """{"cards": {card_id, ...}, "editions": {edition_id, ...}} — cached in DB
    mode (bust on every custom write)."""
    if is_db_mode():
        cached = db_cache.peek("custom_ids")
        if cached is not None:
            return cached
        with get_session() as session:
            result = {
                "cards": set(session.execute(select(Card.card_id).where(Card.is_custom)).scalars().all()),
                "editions": set(session.execute(select(Edition.edition_id).where(Edition.is_custom)).scalars().all()),
            }
        db_cache.put("custom_ids", result)
        return result

    data = _load_custom_json()
    return {"cards": set(data["cards"]), "editions": set(data["editions"])}


def is_custom_edition(edition_id: str) -> bool:
    return edition_id in custom_ids()["editions"]


def is_custom_card(card_id: str) -> bool:
    return card_id in custom_ids()["cards"]


# ── Input normalization ───────────────────────────────────────────────────────

def _new_id(taken: set[str]) -> str:
    """10 random letters/digits, the same shape as the API's own ids."""
    while True:
        candidate = "".join(secrets.choice(_ID_ALPHABET) for _ in range(10))
        if candidate not in taken:
            return candidate


def _int_or_none(value, label: str) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise CustomCardError(f"{label} must be a whole number.")


def _clean_printing(printing: dict) -> dict:
    set_prefix = (printing.get("set_prefix") or "").strip()
    collector_number = (printing.get("collector_number") or "").strip()
    if not set_prefix:
        raise CustomCardError("Set is required.")
    if not collector_number:
        raise CustomCardError("Collector number is required.")

    rarity = _int_or_none(printing.get("rarity"), "Rarity")
    if rarity not in VALID_RARITIES:
        raise CustomCardError("Choose a rarity.")

    release = (printing.get("release_date") or "").strip() or None
    if release:
        try:
            date.fromisoformat(release)
        except ValueError:
            raise CustomCardError("Release date must be YYYY-MM-DD.")

    kinds = {str(k).upper() for k in (printing.get("kinds") or ["NONFOIL", "FOIL"])}
    if not kinds or not kinds <= {"NONFOIL", "FOIL"}:
        raise CustomCardError("Choose Nonfoil, Foil or both.")

    return {
        "kinds": sorted(kinds),
        "set_prefix": set_prefix,
        "set_name": (printing.get("set_name") or "").strip() or None,
        "collector_number": collector_number,
        "rarity": rarity,
        "illustrator": (printing.get("illustrator") or "").strip() or None,
        "flavor": (printing.get("flavor") or "").strip() or None,
        "release_date": release,
    }


def _set_name_for(prefix: str, given: str | None) -> str:
    """An existing set keeps its own name; a brand-new prefix needs one."""
    from api_ga import load_info_data

    if is_db_mode():
        with get_session() as session:
            existing = session.execute(select(Set.name).where(Set.slug == _set_slug(prefix))).scalar_one_or_none()
    else:
        existing = next(
            (e.get("set_name") for c in load_info_data().values() for e in (c.get("editions") or {}).values()
             if (e.get("set_prefix") or "").lower() == prefix.lower()),
            None,
        )

    if existing:
        return existing
    if not given:
        raise CustomCardError(f"'{prefix}' is a new set — give it a name.")
    return given


def _collector_taken(prefix: str, collector_number: str, rarity: int) -> bool:
    """Same set + collector number + rarity is almost certainly a duplicate
    (the API itself reuses a number across rarities, e.g. PR vs CPR)."""
    from api_ga import load_editions_data, load_info_data, load_set_collector_data

    edition_ids = load_set_collector_data(_set_slug(prefix)).get(collector_number, [])
    if isinstance(edition_ids, str):
        edition_ids = [edition_ids]
    if not edition_ids:
        return False

    editions = load_editions_data()
    info = load_info_data()
    for eid in edition_ids:
        card_id = editions.get(eid, {}).get("card_id")
        if info.get(card_id, {}).get("editions", {}).get(eid, {}).get("rarity") == rarity:
            return True
    return False


# ── Create ────────────────────────────────────────────────────────────────────

def create_card(card: dict, printing: dict, image: bytes) -> dict:
    """A whole new card with one printing. Returns {card_id, edition_id, slug}."""
    from api_ga import _format_search, _persist_card, load_editions_data, load_info_data, load_slugs_data

    name = (card.get("name") or "").strip()
    if not name:
        raise CustomCardError("Card name is required.")

    slug = _format_search(name)
    if not slug:
        raise CustomCardError("Card name needs at least one letter or number.")
    if slug in load_slugs_data():
        raise CustomCardError(f"A card named '{name}' already exists — add a printing to it instead.")

    p = _clean_printing(printing)
    content_type = _validate_image(image)
    set_name = _set_name_for(p["set_prefix"], p["set_name"])
    if _collector_taken(p["set_prefix"], p["collector_number"], p["rarity"]):
        raise CustomCardError(f"{p['set_prefix']} #{p['collector_number']} at that rarity already exists.")

    card_id = _new_id(set(load_info_data()))
    edition_id = _new_id(set(load_editions_data()))
    types = [t.strip() for t in (card.get("types") or "").split(",") if t.strip()]
    effect = (card.get("effect") or "").strip() or None
    now = datetime.now(timezone.utc).isoformat()

    # API-shaped payload, so _persist_card stores it exactly like a synced
    # card in either mode (and its empty circulations become the stand-in
    # Nonfoil + Foil foils).
    card_data = {
        "uuid": card_id,
        "name": name,
        "slug": slug,
        "element": (card.get("element") or "").strip().upper() or None,
        "types": types,
        "subtypes": [],
        "effect": effect,
        "effect_raw": effect,
        "effect_html": None,
        "legality": {},
        "cost_memory": _int_or_none(card.get("cost_memory"), "Memory cost"),
        "cost_reserve": _int_or_none(card.get("cost_reserve"), "Reserve cost"),
        "durability": _int_or_none(card.get("durability"), "Durability"),
        "level": _int_or_none(card.get("level"), "Level"),
        "life": _int_or_none(card.get("life"), "Life"),
        "power": _int_or_none(card.get("power"), "Power"),
        "speed": _int_or_none(card.get("speed"), "Speed"),
        "rule": [],
        "editions": [{
            "uuid": edition_id,
            "card_id": card_id,
            "collector_number": p["collector_number"],
            "rarity": p["rarity"],
            "illustrator": p["illustrator"],
            "flavor": p["flavor"],
            "created_at": now,
            "last_update": now,
            "set": {"prefix": p["set_prefix"], "name": set_name, "release_date": p["release_date"]},
            "circulationTemplates": [],
            "circulations": [],
        }],
    }

    _persist_card(slug, card_data, bust=False)

    if is_db_mode():
        with get_session() as session:
            session.execute(update(Card).where(Card.card_id == card_id).values(is_custom=True))
            session.execute(update(Edition).where(Edition.edition_id == edition_id).values(is_custom=True))
            _write_image(session, edition_id, image, content_type)
        db_cache.bust()
    else:
        data = _load_custom_json()
        data["cards"].append(card_id)
        data["editions"].append(edition_id)
        _save_custom_json(data)
        _write_image(None, edition_id, image, content_type)

    # _persist_card gave it both stand-ins; trim to the kinds asked for.
    if len(p["kinds"]) < 2:
        set_standin_kinds(edition_id, p["kinds"])

    return {"card_id": card_id, "edition_id": edition_id, "slug": slug}


def add_printing(card_id: str, printing: dict, image: bytes) -> dict:
    """A missing printing on an existing card (custom or from the API). Only the
    edition + its foils are written. Returns {card_id, edition_id}."""
    from api_ga import DIR_SETS, JSON_EDITIONS, JSON_INFO, _sort_collector_number, load_editions_data, load_info_data

    info = load_info_data()
    if card_id not in info:
        raise CustomCardError("That card doesn't exist.")

    p = _clean_printing(printing)
    content_type = _validate_image(image)
    set_name = _set_name_for(p["set_prefix"], p["set_name"])
    if _collector_taken(p["set_prefix"], p["collector_number"], p["rarity"]):
        raise CustomCardError(f"{p['set_prefix']} #{p['collector_number']} at that rarity already exists.")

    edition_id = _new_id(set(load_editions_data()))
    today = date.today().isoformat()
    edition_entry = {
        "collector_number": p["collector_number"],
        "date_created": today,
        "date_release": p["release_date"],
        "date_update": today,
        "flavor": p["flavor"],
        "illustrator": p["illustrator"],
        "rarity": p["rarity"],
        "set_name": set_name,
        "set_prefix": p["set_prefix"],
        "foils": {fid: f for fid, f in temp_placeholder_foils().items() if TEMP_FOIL_KINDS[fid] in p["kinds"]},
    }

    if is_db_mode():
        with get_session() as session:
            # A new prefix gets its sets row; an existing one is left exactly
            # as the API/featured-set bookkeeping has it.
            upsert(session, Set, [{"slug": _set_slug(p["set_prefix"]), "prefix": p["set_prefix"], "name": set_name}],
                   ["slug"], update_cols=[])
            session.add(Edition(**build_edition_row(card_id, edition_id, edition_entry), is_custom=True))
            session.flush()
            top_level, _ = build_foil_rows(edition_id, edition_entry["foils"])
            for row in top_level:
                session.add(Foil(**row))
            _write_image(session, edition_id, image, content_type)
        db_cache.bust()
        return {"card_id": card_id, "edition_id": edition_id}

    # JSON mode: the three places a synced edition is recorded.
    with new_json(JSON_EDITIONS).open("r", encoding="utf-8") as f:
        editions_data = json.load(f)
    editions_data[edition_id] = {"card_id": card_id}
    with new_json(JSON_EDITIONS).open("w", encoding="utf-8") as f:
        json.dump(editions_data, f, indent=4)

    with new_json(JSON_INFO).open("r", encoding="utf-8") as f:
        info_data = json.load(f)
    json_entry = {k: v for k, v in edition_entry.items() if k != "collector_number"}
    info_data[card_id].setdefault("editions", {})[edition_id] = json_entry
    with new_json(JSON_INFO).open("w", encoding="utf-8") as f:
        json.dump(info_data, f, indent=4)

    set_file = new_json(f"{DIR_SETS}/{_set_slug(p['set_prefix'])}.json")
    with set_file.open("r", encoding="utf-8") as f:
        set_data = json.load(f)
    set_data.setdefault(p["collector_number"], [])
    set_data[p["collector_number"]].append(edition_id)
    set_data = dict(sorted(set_data.items(), key=lambda item: _sort_collector_number(item[0])))
    with set_file.open("w", encoding="utf-8") as f:
        json.dump(set_data, f, indent=4)

    data = _load_custom_json()
    data["editions"].append(edition_id)
    _save_custom_json(data)
    _write_image(None, edition_id, image, content_type)

    return {"card_id": card_id, "edition_id": edition_id}


def replace_image(edition_id: str, image: bytes) -> None:
    if not is_custom_edition(edition_id):
        raise CustomCardError("Only custom printings have uploaded art.")
    content_type = _validate_image(image)

    if is_db_mode():
        with get_session() as session:
            _write_image(session, edition_id, image, content_type)
    else:
        _write_image(None, edition_id, image, content_type)


# ── Delete ────────────────────────────────────────────────────────────────────

def delete_printing(edition_id: str) -> dict:
    """Removes a custom printing (and its card too, if that was a custom card's
    last printing). Refuses while any user's inventory, decks or watch/wish list
    still holds it — those are other people's data. Its own sales, listings and
    Needs Action flags go with it. Returns {card_deleted: bool}."""
    if not is_custom_edition(edition_id):
        raise CustomCardError("Only custom printings can be deleted here.")

    if is_db_mode():
        with get_session() as session:
            edition = session.get(Edition, edition_id)
            if edition is None:
                raise CustomCardError("That printing no longer exists.")
            card_id = edition.card_id

            in_use = sum(
                session.execute(select(func.count()).select_from(m).where(m.edition_id == edition_id)).scalar()
                for m in (InventoryCard, DeckCard, WatchlistEntry, WishlistEntry)
            )
            if in_use:
                raise CustomCardError(
                    f"It's in {in_use} inventory/deck/watchlist entr{'y' if in_use == 1 else 'ies'} — "
                    "remove those first.")

            for model in (PriceSale, PriceListing, PricingFlag, MarketplaceScrapeClock, ThemaScore,
                          FoilTcgOverride, CustomImage):
                session.execute(delete(model).where(model.edition_id == edition_id))
            session.execute(delete(Foil).where(Foil.edition_id == edition_id, Foil.parent_foil_id.isnot(None)))
            session.execute(delete(Foil).where(Foil.edition_id == edition_id))
            session.execute(delete(Edition).where(Edition.edition_id == edition_id))

            card_deleted = False
            card = session.get(Card, card_id)
            remaining = session.execute(select(func.count()).select_from(Edition).where(Edition.card_id == card_id)).scalar()
            if card is not None and card.is_custom and remaining == 0:
                in_decks = session.execute(select(func.count()).select_from(DeckCard).where(DeckCard.card_id == card_id)).scalar()
                if in_decks == 0:
                    session.execute(delete(CardRule).where(CardRule.card_id == card_id))
                    session.execute(delete(CardSlug).where(CardSlug.card_id == card_id))
                    session.execute(delete(Card).where(Card.card_id == card_id))
                    card_deleted = True
        db_cache.bust()
    else:
        card_deleted = _delete_printing_json(edition_id)

    path = _image_path(edition_id)
    if path.exists():
        path.unlink()

    return {"card_deleted": card_deleted}


def _delete_printing_json(edition_id: str) -> bool:
    from api_ga import DIR_SETS, JSON_EDITIONS, JSON_INFO, JSON_SLUGS, JSON_UPDATE, JSON_RULES, JSON_THEMA
    from pricing_ga import JSON_LISTINGS, JSON_SALES

    with new_json(JSON_EDITIONS).open("r", encoding="utf-8") as f:
        editions_data = json.load(f)
    card_id = editions_data.get(edition_id, {}).get("card_id")
    if card_id is None:
        raise CustomCardError("That printing no longer exists.")

    in_use = 0
    for directory in ("DATA_GA/INV_GA", "DATA_GA/WATCHLIST_GA", "DATA_GA/WISH_GA"):
        if not os.path.isdir(directory):
            continue
        for entry in os.scandir(directory):
            if entry.name.endswith(".json") and f'"{edition_id}"' in Path(entry.path).read_text(encoding="utf-8"):
                in_use += 1
    if in_use:
        raise CustomCardError("It's still in someone's inventory or watch/wish list — remove those first.")

    def edit(path, fn):
        with new_json(path).open("r", encoding="utf-8") as f:
            data = json.load(f)
        fn(data)
        with new_json(path).open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)

    editions_data.pop(edition_id, None)
    with new_json(JSON_EDITIONS).open("w", encoding="utf-8") as f:
        json.dump(editions_data, f, indent=4)

    set_prefix = None

    def drop_info(data):
        nonlocal set_prefix
        entry = data.get(card_id, {}).get("editions", {}).pop(edition_id, None) or {}
        set_prefix = entry.get("set_prefix")
    edit(JSON_INFO, drop_info)

    for price_path in (JSON_SALES, JSON_LISTINGS):
        edit(price_path, lambda data: data.get(card_id, {}).pop(edition_id, None))
    edit(JSON_THEMA, lambda data: data.pop(edition_id, None))

    if set_prefix:
        def drop_collector(data):
            for number in list(data):
                ids = data[number] if isinstance(data[number], list) else [data[number]]
                ids = [i for i in ids if i != edition_id]
                if ids:
                    data[number] = ids
                else:
                    del data[number]
        edit(f"{DIR_SETS}/{_set_slug(set_prefix)}.json", drop_collector)

    custom = _load_custom_json()
    custom["editions"] = [e for e in custom["editions"] if e != edition_id]

    card_deleted = False
    with new_json(JSON_INFO).open("r", encoding="utf-8") as f:
        info_data = json.load(f)
    if card_id in custom["cards"] and not info_data.get(card_id, {}).get("editions"):
        edit(JSON_INFO, lambda data: data.pop(card_id, None))
        edit(JSON_SLUGS, lambda data: [data.pop(s) for s in [s for s, v in data.items() if v.get("card_id") == card_id]])
        edit(JSON_UPDATE, lambda data: data.pop(card_id, None))
        edit(JSON_RULES, lambda data: data.pop(card_id, None))
        for price_path in (JSON_SALES, JSON_LISTINGS):
            edit(price_path, lambda data: data.pop(card_id, None))
        custom["cards"] = [c for c in custom["cards"] if c != card_id]
        card_deleted = True

    _save_custom_json(custom)
    return card_deleted


# ── Form options ──────────────────────────────────────────────────────────────

def form_options() -> dict:
    """What the admin form offers: elements already in use (so casing matches
    the existing asset filenames — see the Railway case-sensitivity note), the
    known sets, and the rarity codes."""
    from api_ga import load_info_data
    from pricing_ga import RARITY_MAP

    info = load_info_data()
    elements = sorted({c.get("element") for c in info.values() if c.get("element")})
    sets = {}
    for c in info.values():
        for e in (c.get("editions") or {}).values():
            prefix = e.get("set_prefix")
            if prefix and prefix not in sets:
                sets[prefix] = e.get("set_name") or prefix

    return {
        "elements": elements,
        "sets": [{"prefix": k, "name": v} for k, v in sorted(sets.items(), key=lambda kv: kv[0].lower())],
        "rarities": [{"value": k, "label": v} for k, v in sorted(RARITY_MAP.items())],
    }


# ── Stand-in kinds (Nonfoil / Foil) ───────────────────────────────────────────
# An edition with no real circulation data (an API promo the database hasn't
# filled in, or any custom printing) has one stand-in foil per printing kind it
# offers. Both by default; an admin can switch either off — or back on — since
# TCGPlayer sometimes sells a kind the official database doesn't list, or
# doesn't sell one it does. At least one has to stay.

KIND_TO_STANDIN = {kind: fid for fid, kind in TEMP_FOIL_KINDS.items()}   # "NONFOIL" -> "temp", "FOIL" -> "temp-foil"


def _standin_refs_db(session, edition_id: str, foil_id: str) -> int:
    return sum(
        session.execute(select(func.count()).select_from(m).where(m.edition_id == edition_id, m.foil_id == foil_id)).scalar()
        for m in (PriceSale, PriceListing, InventoryCard, DeckCard, WatchlistEntry, WishlistEntry, FoilTcgOverride)
    )


def _standin_refs_json(card_id: str, edition_id: str, foil_id: str) -> int:
    from pricing_ga import JSON_LISTINGS, JSON_SALES

    refs = 0
    for price_path in (JSON_SALES, JSON_LISTINGS):
        with new_json(price_path).open("r", encoding="utf-8") as f:
            refs += len(json.load(f).get(card_id, {}).get(edition_id, {}).get(foil_id) or [])

    for directory, nested in (("DATA_GA/INV_GA", True), ("DATA_GA/WATCHLIST_GA", False), ("DATA_GA/WISH_GA", False)):
        if not os.path.isdir(directory):
            continue
        for entry in os.scandir(directory):
            if not entry.name.endswith(".json"):
                continue
            with open(entry.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            trees = [cards for b in data.values() for cards in (b.get("sections") or {}).values()] if nested else [data]
            refs += sum(1 for t in trees if foil_id in t.get(card_id, {}).get(edition_id, {}))
    return refs


def set_standin_kinds(edition_id: str, kinds: list[str]) -> list[str]:
    """Makes `edition_id`'s stand-in foils exactly `kinds` ("NONFOIL" / "FOIL").
    Only for editions with no real foils. Refuses to remove a stand-in that
    still has sales, listings, inventory, deck or watch/wish entries on it.
    Returns the kinds it now has."""
    wanted = {k.upper() for k in kinds}
    if not wanted or not wanted <= set(KIND_TO_STANDIN):
        raise CustomCardError("Keep at least one of Nonfoil / Foil.")

    if is_db_mode():
        with get_session() as session:
            foils = set(session.execute(select(Foil.foil_id).where(Foil.edition_id == edition_id)).scalars().all())
            if not foils:
                raise CustomCardError("That printing doesn't exist.")
            if foils - set(TEMP_FOIL_KINDS):
                raise CustomCardError("This printing has real foils from the database — nothing to set.")

            for kind, foil_id in KIND_TO_STANDIN.items():
                if kind in wanted and foil_id not in foils:
                    session.add(Foil(edition_id=edition_id, foil_id=foil_id, kind=kind, population=None, printing=None))
                elif kind not in wanted and foil_id in foils:
                    refs = _standin_refs_db(session, edition_id, foil_id)
                    if refs:
                        raise CustomCardError(
                            f"{kind.title()} still has {refs} sale/listing/inventory/deck entr{'y' if refs == 1 else 'ies'} "
                            "— move or delete those first.")
                    session.execute(delete(Foil).where(Foil.edition_id == edition_id, Foil.foil_id == foil_id))
        db_cache.bust()
        return sorted(wanted)

    from api_ga import JSON_INFO, load_editions_data
    card_id = load_editions_data().get(edition_id, {}).get("card_id")
    with new_json(JSON_INFO).open("r", encoding="utf-8") as f:
        info_data = json.load(f)
    foils = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {}).get("foils")
    if foils is None:
        raise CustomCardError("That printing doesn't exist.")
    if set(foils) - set(TEMP_FOIL_KINDS):
        raise CustomCardError("This printing has real foils from the database — nothing to set.")

    for kind, foil_id in KIND_TO_STANDIN.items():
        if kind in wanted and foil_id not in foils:
            foils[foil_id] = temp_placeholder_foils()[foil_id]
        elif kind not in wanted and foil_id in foils:
            refs = _standin_refs_json(card_id, edition_id, foil_id)
            if refs:
                raise CustomCardError(f"{kind.title()} still has entries on it — move or delete those first.")
            del foils[foil_id]

    with new_json(JSON_INFO).open("w", encoding="utf-8") as f:
        json.dump(info_data, f, indent=4)
    return sorted(wanted)


# ── Convert a custom printing into the real one ────────────────────────────────
# Once Grand Archive adds a card/printing an admin created by hand, everything
# recorded against the custom printing moves onto the real one and the custom
# printing is removed (and its card too, if that was a custom card's last one).

def conversion_targets(edition_id: str, name: str) -> dict:
    """Fetches the real card called `name` from the API (adding it to the
    catalog, same as any card search) and lists its printings to convert
    `edition_id` into."""
    from api_ga import _api_search, _format_search
    from pricing_ga import RARITY_MAP

    if not is_db_mode():
        raise CustomCardError("Converting a custom card needs database mode.")
    if not is_custom_edition(edition_id):
        raise CustomCardError("Only custom printings can be converted.")

    slug = _format_search(name or "")
    if not slug:
        raise CustomCardError("Enter the real card's name.")

    card_data = _api_search(slug)
    if not card_data:
        raise CustomCardError(f"'{name}' isn't on the Grand Archive API yet.")

    real_card_id = card_data["editions"][0]["card_id"]

    printings = []
    with get_session() as session:
        rows = session.execute(
            select(Edition.edition_id, Edition.collector_number, Edition.rarity, Set.prefix, Set.name)
            .join(Set, Set.slug == Edition.set_slug, isouter=True)
            .where(Edition.card_id == real_card_id, Edition.is_custom.is_(False))
        ).all()
        for r in rows:
            foils = session.execute(select(Foil.foil_id, Foil.kind).where(
                Foil.edition_id == r.edition_id, Foil.parent_foil_id.is_(None))).all()
            printings.append({
                "edition_id": r.edition_id,
                "set_prefix": r.prefix,
                "set_name": r.name,
                "collector_number": r.collector_number,
                "rarity": RARITY_MAP.get(r.rarity, "?"),
                "kinds": sorted({(f.kind or "").title() for f in foils}),
                "placeholder": all(f.foil_id in TEMP_FOIL_KINDS for f in foils),
            })
    printings.sort(key=lambda p: (p["set_prefix"] or "", p["collector_number"] or ""))

    return {"card_id": real_card_id, "name": card_data.get("name"), "printings": printings}


def convert_printing(edition_id: str, target_edition_id: str) -> dict:
    """Moves everything on custom printing `edition_id` onto real printing
    `target_edition_id`, then deletes the custom one. Each stand-in's rows go to
    the target's foil of the same kind (Nonfoil -> Nonfoil, Foil -> Foil),
    falling back to its first foil. Returns counts of what moved."""
    if not is_db_mode():
        raise CustomCardError("Converting a custom card needs database mode.")
    if not is_custom_edition(edition_id):
        raise CustomCardError("Only custom printings can be converted.")
    if edition_id == target_edition_id or is_custom_edition(target_edition_id):
        raise CustomCardError("Pick a real printing from the database.")

    moved = {"sales": 0, "listings": 0, "inventory": 0, "decks": 0, "watch_wish": 0, "flags": 0}

    with get_session() as session:
        src = session.get(Edition, edition_id)
        tgt = session.get(Edition, target_edition_id)
        if src is None or tgt is None:
            raise CustomCardError("That printing no longer exists.")

        src_foils = dict(session.execute(
            select(Foil.foil_id, Foil.kind).where(Foil.edition_id == edition_id)).all())
        tgt_foils = dict(session.execute(
            select(Foil.foil_id, Foil.kind).where(Foil.edition_id == target_edition_id, Foil.parent_foil_id.is_(None))).all())
        if not tgt_foils:
            raise CustomCardError("That printing has no foils to move onto.")

        def target_foil(foil_id: str) -> str:
            kind = (src_foils.get(foil_id) or "").upper()
            return next((f for f, k in tgt_foils.items() if (k or "").upper() == kind), next(iter(tgt_foils)))

        for src_foil in src_foils:
            dst_foil = target_foil(src_foil)

            for model, key in ((PriceSale, "sales"), (PriceListing, "listings")):
                moved[key] += session.execute(
                    update(model).where(model.edition_id == edition_id, model.foil_id == src_foil)
                    .values(edition_id=target_edition_id, foil_id=dst_foil)
                ).rowcount

            # One row per (section, card, edition, foil): fold into the
            # target's row in the same section, else repoint (card_id too —
            # a custom card's rows move to the real card).
            for model, key in ((InventoryCard, "inventory"), (DeckCard, "decks")):
                for rec in session.execute(
                    select(model).where(model.edition_id == edition_id, model.foil_id == src_foil)
                ).scalars().all():
                    existing = session.execute(select(model).where(
                        model.section_id == rec.section_id, model.card_id == tgt.card_id,
                        model.edition_id == target_edition_id, model.foil_id == dst_foil,
                    )).scalar_one_or_none()
                    if existing is not None:
                        existing.quantity += rec.quantity
                        session.delete(rec)
                    else:
                        rec.card_id, rec.edition_id, rec.foil_id = tgt.card_id, target_edition_id, dst_foil
                    moved[key] += 1
                session.flush()

            for model in (WatchlistEntry, WishlistEntry):
                for rec in session.execute(
                    select(model).where(model.edition_id == edition_id, model.foil_id == src_foil)
                ).scalars().all():
                    has = session.execute(select(model.id).where(
                        model.user_id == rec.user_id, model.edition_id == target_edition_id, model.foil_id == dst_foil,
                    )).first()
                    if has is not None:
                        session.delete(rec)
                    else:
                        rec.edition_id, rec.foil_id = target_edition_id, dst_foil
                    moved["watch_wish"] += 1
                session.flush()

        # Needs Action flags (main page = foil_id ""): merge into an open flag
        # the target already has for the same page, else repoint.
        for flag in session.execute(select(PricingFlag).where(PricingFlag.edition_id == edition_id)).scalars().all():
            clash = None
            if flag.resolved_at is None:
                clash = session.execute(select(PricingFlag).where(
                    PricingFlag.edition_id == target_edition_id, PricingFlag.foil_id == flag.foil_id,
                    PricingFlag.marketplace == flag.marketplace, PricingFlag.reason == flag.reason,
                    PricingFlag.resolved_at.is_(None),
                )).scalar_one_or_none()
            if clash is not None:
                clash.new_sales += flag.new_sales
                clash.scrape_count += flag.scrape_count
                clash.gaps = [*(clash.gaps or []), *(flag.gaps or [])]
                clash.last_flagged_at = max(clash.last_flagged_at, flag.last_flagged_at)
                session.delete(flag)
            else:
                flag.edition_id = target_edition_id
            moved["flags"] += 1
        session.flush()

        # Scrape clocks: keep the later date per (foil, marketplace, field).
        for clock in session.execute(
            select(MarketplaceScrapeClock).where(MarketplaceScrapeClock.edition_id == edition_id)
        ).scalars().all():
            other = session.get(MarketplaceScrapeClock, (target_edition_id, clock.foil_id, clock.marketplace, clock.field))
            if other is not None:
                other.last_date = max(other.last_date, clock.last_date)
                session.delete(clock)
            else:
                clock.edition_id = target_edition_id
        session.flush()

        # TCGPlayer product ID: carry it over unless the target already has one.
        if not tgt.tcg_product_id and not tgt.tcg_is_no_listings and (src.tcg_product_id or src.tcg_is_no_listings):
            tgt.tcg_product_id, tgt.tcg_is_no_listings = src.tcg_product_id, src.tcg_is_no_listings
            tgt.tcg_foil_kind_swapped = src.tcg_foil_kind_swapped

        src_card_id = src.card_id
        for model in (ThemaScore, FoilTcgOverride, CustomImage):
            session.execute(delete(model).where(model.edition_id == edition_id))
        session.execute(delete(Foil).where(Foil.edition_id == edition_id))
        session.execute(delete(Edition).where(Edition.edition_id == edition_id))
        session.flush()

        # A custom card with no printings left: its unpinned deck rows (no
        # edition) move to the real card, then the card goes.
        card_deleted = False
        src_card = session.get(Card, src_card_id)
        remaining = session.execute(select(func.count()).select_from(Edition).where(Edition.card_id == src_card_id)).scalar()
        if src_card is not None and src_card.is_custom and remaining == 0:
            for rec in session.execute(select(DeckCard).where(DeckCard.card_id == src_card_id)).scalars().all():
                existing = session.execute(select(DeckCard).where(
                    DeckCard.section_id == rec.section_id, DeckCard.card_id == tgt.card_id,
                    DeckCard.edition_id.is_(None), DeckCard.foil_id.is_(None),
                )).scalar_one_or_none() if rec.edition_id is None else None
                if existing is not None:
                    existing.quantity += rec.quantity
                    session.delete(rec)
                else:
                    rec.card_id = tgt.card_id
                moved["decks"] += 1
            session.flush()
            session.execute(delete(CardRule).where(CardRule.card_id == src_card_id))
            session.execute(delete(CardSlug).where(CardSlug.card_id == src_card_id))
            session.execute(delete(Card).where(Card.card_id == src_card_id))
            card_deleted = True

    db_cache.bust()
    path = _image_path(edition_id)
    if path.exists():
        path.unlink()

    return {**moved, "card_deleted": card_deleted, "target_edition_id": target_edition_id}

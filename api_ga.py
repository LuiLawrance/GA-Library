from datetime import date, datetime
from pricing_ga import _sync_info
from settings import load_settings
from tqdm import tqdm
from util_file import new_dir, new_json

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
# be required; _migrate_temp_foil() swaps it for the real one once the API
# reports it on a later sync.
TEMP_FOIL_ID = "temp"


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

        _update_edition(card_data, debug)
        _update_info(card_data, debug)
        _update_rule(card_data, debug)
        _update_sets(card_data, debug)
        _update_slug(slug, card_data, debug)
        _update_thema(card_data, debug)
        _update_update(card_data, debug)

        _sync_info(card_data, debug)

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
    error_file = new_json(JSON_ERRORS)

    with error_file.open("r", encoding="utf-8") as f:
        error_data = json.load(f)

    timestamp = datetime.now().isoformat()

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
    rule_data = card_data.get("rule") or []

    rules = []

    for rule in rule_data:
        rules.append({
            "date": rule.get("date_added"),
            "title": rule.get("title") or None,
            "description": rule.get("description")
        })

    rules.sort(
        key=lambda rule: rule.get("date") or ""
    )

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

    edition_count = 0

    for edition in card_data["editions"]:
        edition_id = edition["uuid"]
        edition_thema = {}

        for foil_type in ["foil", "nonfoil"]:
            scores = {}

            for key, value in edition.items():
                if not key.startswith("thema_"):
                    continue

                if key in {
                    "thema_foil",
                    "thema_nonfoil",
                    "thema_foil_dynamic",
                    "thema_nonfoil_dynamic"
                }:
                    continue

                if not key.endswith(f"_{foil_type}"):
                    continue

                if value is None:
                    continue

                category = key.replace("thema_", "").replace(f"_{foil_type}", "")

                scores[category] = value

            if scores:
                scores["dynamic"] = edition.get(
                    f"thema_{foil_type}_dynamic",
                    False
                )

                edition_thema[foil_type] = scores

        if edition_thema:
            thema_data[edition_id] = edition_thema
            edition_count += 1

    with thema_file.open("w", encoding="utf-8") as f:
        json.dump(thema_data, f, indent=4)

    if debug:
        print(
            f"Updated THEMA.json | "
            f"editions={edition_count}"
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


def card_reset(card_name: str, debug: bool = False) -> dict:
    """Force re-fetch a card from the API, overriding all local data and images."""
    slug = _format_search(card_name, debug)

    # Look up existing edition IDs so we can delete their cached images —
    # _download_card_image (api_ga.py) refills each one lazily the next time
    # GET /images/{edition_id}.jpg (app.py) is actually requested, rather than
    # this eagerly re-downloading them itself.
    slug_file = new_json(JSON_SLUGS)
    info_file = new_json(JSON_INFO)
    image_dir = new_dir(DIR_IMAGES)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    if slug in slug_data:
        card_id = slug_data[slug]["card_id"]
        existing_editions = info_data.get(card_id, {}).get("editions", {}).keys()

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

                _update_edition(card_data, debug)
                _update_info(card_data, debug)
                _update_rule(card_data, debug)
                _update_sets(card_data, debug)
                _update_slug(slug, card_data, debug)
                _update_thema(card_data, debug)
                _update_update(card_data, debug)

                _sync_info(card_data, debug)

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

from datetime import datetime
import file
import json
import re
import requests

TIMEOUT = 10
UPDATE_THRESHOLD_DAYS = 30

LINK_API = "https://api.gatcg.com/cards/"

PATH_CARDS = "DATA_CLIENT/GA_CARDS/GA_CARDS.json"
PATH_COLLECTIONS = "DATA_CLIENT/GA_COLLECTIONS/GA_COLLECTIONS.json"
PATH_NAMES = "DATA_CLIENT/GA_CARDS/GA_NAMES.json"
PATH_USERS = "DATA_CLIENT/GA_USERS/GA_USERS.json"


def _format_card_name(card_name: str) -> str:
    name = card_name.lower().strip()
    name = re.sub(r"[^a-z0-9\s]", "", name)
    name = re.sub(r"\s+", "-", name)
    return name.strip("-")


def _write_cards(data: dict):
    if not data:
        print("No data to save.")
        return None

    editions = data.get("editions", [])

    if not editions:
        print("No editions found in API response.")
        return None

    card_id = editions[0].get("card_id")

    if not card_id:
        print("No card_id found in editions.")
        return None

    trimmed_editions = []

    for edition in editions:
        set_data = edition.get("set", {})

        templates = edition.get("circulationTemplates", [])
        circulations = edition.get("circulations", [])

        circulation_entries = []

        if isinstance(templates, list):
            circulation_entries.extend(templates)

        if isinstance(circulations, list):
            circulation_entries.extend(circulations)

        circulation_data = {}

        for entry in circulation_entries:
            if not isinstance(entry, dict):
                continue

            kind = entry.get("kind")
            population = entry.get("population")
            printing = entry.get("printing")
            uuid_foil = entry.get("uuid")

            if not kind:
                continue

            key = str(kind).lower()

            if key not in circulation_data:
                circulation_data[key] = {
                    "uuid_foil": uuid_foil,
                    "population": population,
                    "printing": printing,
                    "variants": []
                }

            if population is not None:
                circulation_data[key]["population"] = population

            if printing is not None:
                circulation_data[key]["printing"] = printing

            if uuid_foil:
                circulation_data[key]["uuid_foil"] = uuid_foil

            variants = entry.get("variants", [])

            if isinstance(variants, list):
                for variant in variants:
                    if not isinstance(variant, dict):
                        continue

                    circulation_data[key]["variants"].append({
                        "uuid_variant": variant.get("uuid"),
                        "description": variant.get("description"),
                        "population": variant.get("population"),
                        "printing": variant.get("printing")
                    })

        trimmed_editions.append({
            "uuid": edition.get("uuid"),
            "collector_number": edition.get("collector_number"),
            "rarity": edition.get("rarity"),
            "set_name": set_data.get("name"),
            "set_prefix": set_data.get("prefix"),
            "circulation": circulation_data
        })

    # --- Build final card structure ---
    cost_data = data.get("cost", {})

    selected_data = {
        "name": data.get("name"),
        "updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "level": data.get("level"),
        "life": data.get("life"),
        "power": data.get("power"),
        "cost": {
            "type": cost_data.get("type"),
            "value": cost_data.get("value")
        },
        "classes": data.get("classes", []),
        "elements": data.get("elements", []),
        "effect": data.get("effect"),
        "effect_raw": data.get("effect_raw"),
        "editions": trimmed_editions
    }

    path = file.new_json(PATH_CARDS)

    try:
        with open(path, "r", encoding="utf-8") as f:
            existing_data = json.load(f)
    except json.JSONDecodeError:
        existing_data = {}

    existing_data[card_id] = selected_data

    with open(path, "w", encoding="utf-8") as f:
        json.dump(existing_data, f, indent=4)

    print(f"Saved '{data.get('name')}' as card ID '{card_id}'")
    return card_id


def card_search(card_name: str):
    path = file.new_json(PATH_CARDS)

    try:
        with open(path, "r", encoding="utf-8") as f:
            existing_data = json.load(f)
    except json.JSONDecodeError:
        existing_data = {}

    # --- Check local storage ---
    for stored_card_id, stored_card in existing_data.items():
        if stored_card.get("name", "").lower() == card_name.lower():
            updated_str = stored_card.get("updated")

            if updated_str:
                try:
                    last_updated = datetime.strptime(updated_str, "%Y-%m-%d %H:%M:%S")
                    days_since = (datetime.now() - last_updated).days

                    if days_since < UPDATE_THRESHOLD_DAYS:
                        print(f"Using cached data for '{card_name}' (updated {updated_str})")
                        return stored_card_id

                    print(f"Cached data is old. Refreshing from API.")
                    break

                except ValueError:
                    print("Invalid timestamp. Refreshing from API.")
                    break

    slug = _format_card_name(card_name)
    url = LINK_API + slug

    try:
        response = requests.get(url, timeout=TIMEOUT)
        response.raise_for_status()
        data = response.json()

        return _write_cards(data)

    except requests.exceptions.RequestException as e:
        print(f"Error fetching card '{card_name}': {e}")
        return None

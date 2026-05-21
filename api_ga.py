from datetime import datetime
from pathlib import Path
import file
import json
import re
import requests

TIMEOUT = 10

LINK_API = "https://api.gatcg.com/cards/"

PATH_CARDS = "DATA_CLIENT/GA_CARDS/GA_CARDS.json"
PATH_COLLECTIONS = "DATA_CLIENT/GA_COLLECTIONS/GA_COLLECTIONS.json"
PATH_FOILS = "DATA_CLIENT/GA_CARDS/GA_FOILS.json"
PATH_IMAGES = "DATA_CLIENT/GA_CARDS/GA_IMAGES/"
PATH_NAMES = "DATA_CLIENT/GA_CARDS/GA_NAMES.json"
PATH_USERS = "DATA_CLIENT/GA_USERS/GA_USERS.json"


def _download_image(uuid: str):
    file.new_dir(PATH_IMAGES)

    file_path = Path(PATH_IMAGES) / f"{uuid}.jpg"

    if file_path.exists():
        print(f"Image already exists: {uuid}.jpg")
        return

    # Build URL from LINK_API
    url = f"{LINK_API}images/{uuid}.jpg"

    try:
        response = requests.get(url, timeout=TIMEOUT)

        if response.status_code == 200:
            with open(file_path, "wb") as f:
                f.write(response.content)

            print(f"Downloaded image: {uuid}.jpg")
        else:
            print(f"Failed to download image ({response.status_code}): {uuid}")

    except requests.exceptions.RequestException:
        print(f"Error downloading image: {uuid}")


def _download_image_all(card_data: dict):
    for edition in card_data.get("editions", []):
        uuid = edition.get("uuid")

        if uuid:
            _download_image(uuid)


def _format_card_name(card_name: str) -> str:
    name = card_name.lower().strip()
    name = re.sub(r"[^a-z0-9\s]", "", name)
    name = re.sub(r"\s+", "-", name)
    return name.strip("-")


def _get_latest_api_update(data: dict):
    latest = None

    for edition in data.get("editions", []):
        if not isinstance(edition, dict):
            continue

        parsed = _parse_api_datetime(edition.get("last_update"))

        if parsed and (latest is None or parsed > latest):
            latest = parsed

    return latest


def _parse_api_datetime(value: str | None):
    if not value:
        return None

    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _write_cards_foils(card_id: str, edition: dict):
    path = file.new_json(PATH_FOILS)

    try:
        with open(path, "r", encoding="utf-8") as f:
            foil_data = json.load(f)
    except json.JSONDecodeError:
        foil_data = {}

    edition_id = edition.get("uuid")

    circulation = edition.get("circulation", {})

    if not isinstance(circulation, dict):
        return

    for finish_data in circulation.values():
        if not isinstance(finish_data, dict):
            continue

        foil_id = finish_data.get("uuid_foil")

        if foil_id:
            foil_data[foil_id] = {
                "id": card_id,
                "edition_id": edition_id
            }

        variants = finish_data.get("variants", [])

        if not isinstance(variants, list):
            continue

        for variant in variants:
            if not isinstance(variant, dict):
                continue

            variant_id = variant.get("uuid_variant")

            if variant_id:
                foil_data[variant_id] = {
                    "id": card_id,
                    "edition_id": edition_id
                }

    with open(path, "w", encoding="utf-8") as f:
        json.dump(foil_data, f, indent=4)


def _write_cards_id(data: dict):
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
            "last_update": edition.get("last_update"),
            "circulation": circulation_data
        })

    # --- Build final card structure ---
    cost_data = data.get("cost", {})

    selected_data = {
        "name": data.get("name"),
        "last_update": _get_latest_api_update(data).isoformat() if _get_latest_api_update(data) else None,
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

    for edition in trimmed_editions:
        _write_cards_foils(card_id, edition)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(existing_data, f, indent=4)

    _download_image_all(data)

    card_name = data.get("name")

    if not isinstance(card_name, str):
        card_name = "Unknown Card"

    print(f"Saved '{card_name}' as card ID '{card_id}'")
    _write_cards_name(card_name, card_id)
    return card_id


def _write_cards_name(card_name: str, card_id: str):
    path = file.new_json(PATH_NAMES)

    try:
        with open(path, "r", encoding="utf-8") as f:
            name_data = json.load(f)
    except json.JSONDecodeError:
        name_data = {}

    # Normalized key for lookup
    key = _format_card_name(card_name)

    # Store BOTH display + id
    name_data[key] = {
        "name": card_name,  # preserves capitalization + punctuation
        "id": card_id
    }

    with open(path, "w", encoding="utf-8") as f:
        json.dump(name_data, f, indent=4)

    print(f"Indexed '{card_name}' → {card_id}")


def card_search(card_name: str):
    path = file.new_json(PATH_CARDS)

    try:
        with open(path, "r", encoding="utf-8") as f:
            existing_data = json.load(f)
    except json.JSONDecodeError:
        existing_data = {}

    slug = _format_card_name(card_name)
    url = LINK_API + slug

    try:
        response = requests.get(url, timeout=TIMEOUT)
        response.raise_for_status()
        api_data = response.json()

    except requests.exceptions.RequestException as e:
        print(f"Error fetching card '{card_name}': {e}")
        return None

    api_editions = api_data.get("editions", [])

    if not api_editions:
        print("No editions found in API response.")
        return None

    card_id = api_editions[0].get("card_id")

    if not card_id:
        print("No card_id found in API response.")
        return None

    api_last_update = _get_latest_api_update(api_data)

    cached_card = existing_data.get(card_id)

    if cached_card:
        cached_last_update = _parse_api_datetime(cached_card.get("last_update"))

        if api_last_update and cached_last_update and api_last_update <= cached_last_update:
            print(f"Using cached data for '{card_name}'")
            return card_id

        print(f"API data is newer. Updating '{card_name}'.")

    return _write_cards_id(api_data)


def inv_add(username: str, foil_id: str):
    path_users = file.new_json(PATH_USERS)

    try:
        with open(path_users, "r", encoding="utf-8") as f:
            users = json.load(f)
    except json.JSONDecodeError:
        users = {}

    if username not in users:
        print(f"User '{username}' does not exist.")
        return False

    user_data = users[username]

    inventory = user_data.get("inventory", {})

    if not isinstance(inventory, dict):
        inventory = {}

    current_count = inventory.get(foil_id, 0)

    if not isinstance(current_count, int):
        current_count = 0

    inventory[foil_id] = current_count + 1

    user_data["inventory"] = inventory
    users[username] = user_data

    with open(path_users, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=4)

    print(f"Added 1x '{foil_id}' to '{username}' inventory.")
    return True


def inv_backend(username: str, card_id: str):
    path_cards = file.new_json(PATH_CARDS)

    try:
        with open(path_cards, "r", encoding="utf-8") as f:
            cards = json.load(f)
    except json.JSONDecodeError:
        print("Failed to load card database.")
        return False

    card_data = cards.get(card_id)

    if not card_data:
        print(f"Card ID '{card_id}' not found.")
        return False

    path_users = file.new_json(PATH_USERS)

    try:
        with open(path_users, "r", encoding="utf-8") as f:
            users = json.load(f)
    except json.JSONDecodeError:
        users = {}

    if username not in users:
        print(f"User '{username}' does not exist.")
        return False

    print_card(card_id, username)

    options = []

    rarity_map = {
        1: "C",
        2: "U",
        3: "R",
        4: "SR",
        5: "UR",
        6: "PR",
        7: "CSR",
        8: "CUR",
        9: "CPR"
    }

    for edition in card_data.get("editions", []):
        if not isinstance(edition, dict):
            continue

        set_prefix = edition.get("set_prefix", "UNK")
        collector_number = edition.get("collector_number", "?")
        rarity_value = edition.get("rarity")
        circulation = edition.get("circulation", {})

        if isinstance(rarity_value, int):
            rarity_display = rarity_map.get(rarity_value, str(rarity_value))
        else:
            rarity_display = "?"

        if not isinstance(circulation, dict):
            continue

        for finish_name, finish_data in circulation.items():
            if not isinstance(finish_data, dict):
                continue

            finish_display = str(finish_name).replace("_", " ").title()
            foil_id = finish_data.get("uuid_foil")

            if foil_id:
                options.append({
                    "label": f"{set_prefix} #{collector_number} {rarity_display} | {finish_display}",
                    "foil_id": foil_id
                })

            variants = finish_data.get("variants", [])

            if not isinstance(variants, list):
                continue

            for variant in variants:
                if not isinstance(variant, dict):
                    continue

                variant_id = variant.get("uuid_variant")

                if variant_id:
                    options.append({
                        "label": f"{set_prefix} #{collector_number} {rarity_display} | {variant.get('description') or finish_display}",
                        "foil_id": variant_id
                    })

    if not options:
        print("No inventory options available.")
        return False

    inventory = users[username].get("inventory", {})

    if not isinstance(inventory, dict):
        inventory = {}

    print("\nInventory Options:")
    print("-" * 80)

    index_width = len(str(len(options)))
    label_width = max(len(option["label"]) for option in options)
    foil_width = max(len(option["foil_id"]) for option in options)

    for index, option in enumerate(options, start=1):
        number = str(index).rjust(index_width)
        label = option["label"].ljust(label_width)
        foil_id = option["foil_id"].ljust(foil_width)
        quantity = inventory.get(option["foil_id"], 0)

        print(f"{number}. {label} | {foil_id} | You Have: {quantity}")

    choice = input("\nSelect an option number, or 0 to cancel: ").strip()

    if choice == "0":
        print("Cancelled.")
        return False

    if not choice.isdigit():
        print("Invalid option.")
        return False

    choice_index = int(choice)

    if choice_index < 1 or choice_index > len(options):
        print("Invalid option.")
        return False

    selected = options[choice_index - 1]
    foil_id = selected["foil_id"]

    action = input(
        "Enter '+', '-', or a number to set quantity (blank to cancel): "
    ).strip()

    if not action:
        print("Cancelled.")
        return False

    if action == "+":
        return inv_add(username, foil_id)

    if action == "-":
        return inv_sub(username, foil_id)

    if action.isdigit():
        return inv_set(username, foil_id, int(action))

    print("Invalid input. Cancelled.")
    return False


def inv_set(username: str, foil_id: str, count: int):
    path_users = file.new_json(PATH_USERS)

    try:
        with open(path_users, "r", encoding="utf-8") as f:
            users = json.load(f)
    except json.JSONDecodeError:
        users = {}

    if username not in users:
        print(f"User '{username}' does not exist.")
        return False

    if not isinstance(count, int):
        print("Count must be an integer.")
        return False

    user_data = users[username]

    inventory = user_data.get("inventory", {})

    if not isinstance(inventory, dict):
        inventory = {}

    if count <= 0:
        inventory.pop(foil_id, None)
        print(f"Removed '{foil_id}' from '{username}' inventory.")
    else:
        inventory[foil_id] = count
        print(f"Set '{foil_id}' to {count} for '{username}'.")

    user_data["inventory"] = inventory
    users[username] = user_data

    with open(path_users, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=4)

    return True


def inv_sub(username: str, foil_id: str):
    path_users = file.new_json(PATH_USERS)

    try:
        with open(path_users, "r", encoding="utf-8") as f:
            users = json.load(f)
    except json.JSONDecodeError:
        users = {}

    if username not in users:
        print(f"User '{username}' does not exist.")
        return False

    user_data = users[username]

    inventory = user_data.get("inventory", {})

    if not isinstance(inventory, dict):
        inventory = {}

    current_count = inventory.get(foil_id, 0)

    if not isinstance(current_count, int):
        current_count = 0

    if current_count <= 1:
        inventory.pop(foil_id, None)
        print(f"Removed '{foil_id}' from '{username}' inventory.")
    else:
        inventory[foil_id] = current_count - 1
        print(f"Removed 1x '{foil_id}' from '{username}' inventory.")

    user_data["inventory"] = inventory
    users[username] = user_data

    with open(path_users, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=4)

    return True


def print_card(card_id: str, username: str = ""):
    path_cards = file.new_json(PATH_CARDS)

    try:
        with open(path_cards, "r", encoding="utf-8") as f:
            existing_data = json.load(f)
    except json.JSONDecodeError:
        print("Failed to load card database.")
        return

    card_data = existing_data.get(card_id)

    if not card_data:
        print(f"Card ID '{card_id}' not found.")
        return

    user_data = None

    if username:
        path_users = file.new_json(PATH_USERS)

        try:
            with open(path_users, "r", encoding="utf-8") as f:
                users = json.load(f)
        except json.JSONDecodeError:
            users = {}

        if username not in users:
            print(f"User '{username}' does not exist.")
            return

        user_data = users[username]

    rarity_map = {
        1: "C",
        2: "U",
        3: "R",
        4: "SR",
        5: "UR",
        6: "PR",
        7: "CSR",
        8: "CUR",
        9: "CPR"
    }

    print("\n" + "=" * 80)
    print(f"{card_data.get('name', 'Unknown Card')}")
    print("=" * 80)

    print("\nEditions:")
    print("-" * 80)

    raw_lines = []

    for edition in card_data.get("editions", []):
        if not isinstance(edition, dict):
            continue

        edition_id = edition.get("uuid")
        set_prefix = edition.get("set_prefix", "UNK")
        collector_number = edition.get("collector_number", "?")
        rarity_value = edition.get("rarity")
        circulation = edition.get("circulation", {})

        if isinstance(rarity_value, int):
            rarity_display = rarity_map.get(rarity_value, str(rarity_value))
        else:
            rarity_display = "?"

        if not isinstance(circulation, dict):
            continue

        for finish_name, finish_data in circulation.items():
            if not isinstance(finish_data, dict):
                continue

            finish_display = str(finish_name).replace("_", " ").title()
            foil_id = finish_data.get("uuid_foil")
            population = finish_data.get("population")

            if foil_id:
                raw_lines.append({
                    "prefix": str(set_prefix),
                    "number": f"#{collector_number}",
                    "rarity": rarity_display,
                    "finish": finish_display,
                    "uuid": foil_id,
                    "population": population
                })

            variants = finish_data.get("variants", [])

            if not isinstance(variants, list):
                continue

            for variant in variants:
                if not isinstance(variant, dict):
                    continue

                variant_id = variant.get("uuid_variant")

                if not variant_id:
                    continue

                raw_lines.append({
                    "prefix": str(set_prefix),
                    "number": f"#{collector_number}",
                    "rarity": rarity_display,
                    "finish": variant.get("description") or finish_display,
                    "uuid": variant_id,
                    "population": variant.get("population")
                })

    if not raw_lines:
        print("No edition UUIDs available.")
        return

    prefix_width = max(len(o["prefix"]) for o in raw_lines)
    number_width = max(len(o["number"]) for o in raw_lines)
    rarity_width = max(len(o["rarity"]) for o in raw_lines)
    finish_width = max(len(o["finish"]) for o in raw_lines)
    uuid_width = max(len(o["uuid"]) for o in raw_lines)

    inventory = {}

    if user_data:
        inventory = user_data.get("inventory", {})

        if not isinstance(inventory, dict):
            inventory = {}

    formatted_lines = []

    for o in raw_lines:
        prefix = o["prefix"].ljust(prefix_width)
        number = o["number"].rjust(number_width)
        rarity = o["rarity"].ljust(rarity_width)
        finish = o["finish"].ljust(finish_width)
        uuid = o["uuid"].ljust(uuid_width)

        line = f"{prefix} {number} {rarity} | {finish} | {uuid}"

        if o["population"] is not None:
            line += f" [≈{o['population']}]"

        formatted_lines.append((line, o))

    line_width = max(len(line) for line, _ in formatted_lines)

    for line, o in formatted_lines:
        final_line = line.ljust(line_width)

        if user_data:
            quantity = inventory.get(o["uuid"], 0)
            final_line += f"  | You Have: {quantity}"

        print(final_line)

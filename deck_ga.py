from pathlib import Path
from util_file import new_dir, new_json

import json
import random

DIR_DECK = "DATA_GA/DECK_GA"
DIR_DECKS = "DATA_GA/DECKS_GA"

DEFAULT_SECTIONS = ["Material Deck", "Main Deck"]


# ── Internal helpers ──────────────────────────────────────────────────────────

def _index_path(username: str) -> Path:
    return Path(f"{DIR_DECK}/{username}.json")


def _deck_path(username: str, deck_name: str) -> Path:
    return Path(f"{DIR_DECKS}/{username}/{deck_name}.json")


def _deck_dir(username: str) -> Path:
    return Path(f"{DIR_DECKS}/{username}")


def _load_index(username: str) -> dict:
    index_file = new_json(f"{DIR_DECK}/{username}.json")
    with index_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def _save_index(username: str, index_data: dict) -> None:
    with _index_path(username).open("w", encoding="utf-8") as f:
        json.dump(index_data, f, indent=4, ensure_ascii=False)


def _load_deck(username: str, deck_name: str) -> dict | None:
    path = _deck_path(username, deck_name)
    if not path.exists():
        print(f"Deck file not found: {deck_name}")
        return None
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _save_deck(username: str, deck_name: str, deck_data: dict) -> None:
    new_dir(str(_deck_dir(username)))
    with _deck_path(username, deck_name).open("w", encoding="utf-8") as f:
        json.dump(deck_data, f, indent=4, ensure_ascii=False)


def _make_deck(desc: str = "", fmt: str = "") -> dict:
    return {
        "desc": desc,
        "format": fmt,
        "sections": {s: {} for s in DEFAULT_SECTIONS}
    }


def _make_index_entry(desc: str = "", fmt: str = "") -> dict:
    from datetime import date
    return {"desc": desc, "format": fmt, "created": date.today().isoformat()}


def _card_count(sections: dict) -> int:
    """Return total card quantity across all sections."""
    total = 0
    for cards in sections.values():
        for qty in cards.values():
            total += qty
    return total


def _unique_card_count(sections: dict) -> int:
    """Return unique card count across all sections."""
    seen = set()
    for cards in sections.values():
        seen.update(cards.keys())
    return len(seen)


def _select_deck(index_data: dict, prompt: str = "Select deck") -> str | None:
    deck_names = list(index_data.keys())
    if not deck_names:
        print("No decks found.")
        return None
    for i, name in enumerate(deck_names, 1):
        fmt = index_data[name].get("format", "")
        fmt_label = f" [{fmt}]" if fmt else ""
        print(f"{i}. {name}{fmt_label}")
    choice = input(f"\n{prompt} (or 0 to cancel): ").strip()
    if choice == "0" or not choice:
        return None
    if not choice.isdigit() or not (1 <= int(choice) <= len(deck_names)):
        print("Invalid selection.")
        return None
    return deck_names[int(choice) - 1]


def _select_section(deck_data: dict, prompt: str = "Select section") -> str | None:
    sections = list(deck_data["sections"].keys())
    if not sections:
        print("No sections found.")
        return None
    for i, name in enumerate(sections, 1):
        count = sum(deck_data["sections"][name].values())
        print(f"{i}. {name} ({count} cards)")
    choice = input(f"\n{prompt} (or 0 to cancel): ").strip()
    if choice == "0" or not choice:
        return None
    if not choice.isdigit() or not (1 <= int(choice) <= len(sections)):
        print("Invalid selection.")
        return None
    return sections[int(choice) - 1]


# ── Public functions — init ───────────────────────────────────────────────────

def deck_init(username: str, debug: bool = False) -> None:
    """Initialise the deck index file for a new user."""
    new_dir(DIR_DECK)
    index_file = _index_path(username)
    with index_file.open("w", encoding="utf-8") as f:
        json.dump({}, f, indent=4)
    if debug:
        print(f"Initialised deck index | user={username}")


# ── Public functions — decks ──────────────────────────────────────────────────

def deck_create(username: str, debug: bool = False) -> None:
    """Create a new deck."""
    index_data = _load_index(username)

    name = input("\nDeck name: ").strip()
    if not name:
        print("Cancelled.")
        return
    if name in index_data:
        print(f"Deck already exists: {name}")
        return

    desc = input("Description (optional): ").strip()
    fmt = input("Format (Standard/Draft/Pantheon or blank): ").strip()

    index_data[name] = _make_index_entry(desc, fmt)
    _save_index(username, index_data)
    _save_deck(username, name, _make_deck(desc, fmt))

    if debug:
        print(f"Created deck | user={username} | deck={name}")
    else:
        print(f"\nCreated deck: {name}")


def deck_delete(username: str, debug: bool = False) -> None:
    """Delete a deck."""
    index_data = _load_index(username)

    print("\nDecks")
    deck_name = _select_deck(index_data, "Select deck to delete")
    if not deck_name:
        return

    confirm = input(f"Delete deck '{deck_name}'? (y/n): ").strip().lower()
    if confirm != "y":
        print("Cancelled.")
        return

    del index_data[deck_name]
    _save_index(username, index_data)

    deck_file = _deck_path(username, deck_name)
    if deck_file.exists():
        deck_file.unlink()

    if debug:
        print(f"Deleted deck | user={username} | deck={deck_name}")
    else:
        print(f"\nDeleted deck: {deck_name}")


def deck_edit(username: str, debug: bool = False) -> None:
    """Rename a deck or edit its description and format."""
    index_data = _load_index(username)

    print("\nDecks")
    deck_name = _select_deck(index_data, "Select deck to edit")
    if not deck_name:
        return

    entry = index_data[deck_name]

    print(f"\nEditing: {deck_name}")
    print("0. Back")
    print("1. Rename")
    print("2. Edit description")
    print("3. Edit format")

    choice = input("\nSelect option: ").strip()

    match choice:
        case "0":
            return

        case "1":
            new_name = input("New name: ").strip()
            if not new_name:
                print("Cancelled.")
                return
            if new_name in index_data:
                print(f"Deck already exists: {new_name}")
                return
            index_data[new_name] = index_data.pop(deck_name)
            _save_index(username, index_data)
            old_path = _deck_path(username, deck_name)
            new_path = _deck_path(username, new_name)
            if old_path.exists():
                old_path.rename(new_path)
            if debug:
                print(f"Renamed deck | user={username} | {deck_name} → {new_name}")
            else:
                print(f"\nRenamed deck: {deck_name} → {new_name}")

        case "2":
            new_desc = input(f"Description [{entry.get('desc', '')}]: ").strip()
            entry["desc"] = new_desc
            _save_index(username, index_data)
            deck_data = _load_deck(username, deck_name)
            if deck_data:
                deck_data["desc"] = new_desc
                _save_deck(username, deck_name, deck_data)
            if debug:
                print(f"Updated desc | user={username} | deck={deck_name}")
            else:
                print(f"\nUpdated description for: {deck_name}")

        case "3":
            new_fmt = input(f"Format [{entry.get('format', '')}]: ").strip()
            entry["format"] = new_fmt
            _save_index(username, index_data)
            deck_data = _load_deck(username, deck_name)
            if deck_data:
                deck_data["format"] = new_fmt
                _save_deck(username, deck_name, deck_data)
            if debug:
                print(f"Updated format | user={username} | deck={deck_name}")
            else:
                print(f"\nUpdated format for: {deck_name}")

        case _:
            print("Invalid option.")


def deck_list(username: str, debug: bool = False) -> None:
    """List all decks with card counts."""
    index_data = _load_index(username)

    if not index_data:
        print("\nNo decks found.")
        return

    print(f"\nDecks — [ {username} ]")
    name_w = max(len(name) for name in index_data)

    for name, entry in index_data.items():
        fmt = entry.get("format", "")
        desc = entry.get("desc", "")
        created = entry.get("created", "")
        deck_data = _load_deck(username, name)
        count = _card_count(deck_data["sections"]) if deck_data else 0
        fmt_label = f" [{fmt}]" if fmt else ""
        desc_label = f" — {desc}" if desc else ""
        print(f"  {name:<{name_w}}{fmt_label}{desc_label}  ({count} cards, created {created})")


def deck_view(username: str, debug: bool = False) -> None:
    """Select a deck and view its sections and cards."""
    index_data = _load_index(username)

    print("\nDecks")
    deck_name = _select_deck(index_data, "Select deck to view")
    if not deck_name:
        return

    deck_data = _load_deck(username, deck_name)
    if not deck_data:
        return

    entry = index_data[deck_name]
    fmt = entry.get("format", "")
    desc = entry.get("desc", "")

    fmt_label = f" [{fmt}]" if fmt else ""
    desc_label = f"\n  {desc}" if desc else ""
    print(f"\n[ {deck_name}{fmt_label} ]{desc_label}")

    for section_name, cards in deck_data["sections"].items():
        print(f"\n  # {section_name}")
        if not cards:
            print("    (empty)")
        for card_id, qty in cards.items():
            print(f"    {qty} {card_id}")


def deck_card_add(username: str, debug: bool = False) -> None:
    """Add a card to a section in a deck."""
    index_data = _load_index(username)

    print("\nDecks")
    deck_name = _select_deck(index_data, "Select deck")
    if not deck_name:
        return

    deck_data = _load_deck(username, deck_name)
    if not deck_data:
        return

    print("\nSections")
    section = _select_section(deck_data, "Select section")
    if not section:
        return

    card_name = input("\nEnter card name: ").strip()
    if not card_name:
        print("Cancelled.")
        return

    # Resolve name → card_id via slugs
    from api_ga import JSON_SLUGS
    slug_file = new_json(JSON_SLUGS)
    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    name_to_id = {data["name"].lower(): data["card_id"] for data in slug_data.values()}
    card_id = name_to_id.get(card_name.lower())

    if not card_id:
        # Fuzzy match
        from rapidfuzz import process, fuzz
        matches = process.extract(card_name, list(name_to_id.keys()), scorer=fuzz.WRatio, score_cutoff=70, limit=5)
        if not matches:
            print(f"No card found for '{card_name}'.")
            return
        print(f"\nDid you mean:")
        for i, (name, score, _) in enumerate(matches, 1):
            print(f"  {i}. {name}")
        choice = input("Select (or 0 to cancel): ").strip()
        if not choice.isdigit() or int(choice) == 0 or int(choice) > len(matches):
            print("Cancelled.")
            return
        card_id = name_to_id[matches[int(choice) - 1][0]]

    cards = deck_data["sections"][section]
    current_qty = cards.get(card_id, 0)

    qty_input = input(f"Quantity [{current_qty}] (+, -, or integer): ").strip()

    if qty_input == "+":
        new_qty = current_qty + 1
    elif qty_input == "-":
        new_qty = current_qty - 1
    elif qty_input.lstrip("-").isdigit():
        new_qty = int(qty_input)
    else:
        print("Invalid input.")
        return

    if new_qty <= 0:
        if card_id in cards:
            del cards[card_id]
        print(f"\nRemoved from '{section}': {card_id}")
    else:
        cards[card_id] = new_qty
        print(f"\nUpdated '{section}': {card_id} x{new_qty}")

    _save_deck(username, deck_name, deck_data)


def deck_section_add(username: str, debug: bool = False) -> None:
    """Add a new section to a deck."""
    index_data = _load_index(username)

    print("\nDecks")
    deck_name = _select_deck(index_data, "Select deck")
    if not deck_name:
        return

    deck_data = _load_deck(username, deck_name)
    if not deck_data:
        return

    section = input("Section name: ").strip()
    if not section:
        print("Cancelled.")
        return

    if section in deck_data["sections"]:
        print(f"Section already exists: {section}")
        return

    deck_data["sections"][section] = {}
    _save_deck(username, deck_name, deck_data)
    print(f"\nAdded section '{section}' to '{deck_name}'.")


def deck_section_delete(username: str, debug: bool = False) -> None:
    """Delete a section from a deck."""
    index_data = _load_index(username)

    print("\nDecks")
    deck_name = _select_deck(index_data, "Select deck")
    if not deck_name:
        return

    deck_data = _load_deck(username, deck_name)
    if not deck_data:
        return

    print("\nSections")
    section = _select_section(deck_data, "Select section to delete")
    if not section:
        return

    confirm = input(f"Delete section '{section}' and all its cards? (y/n): ").strip().lower()
    if confirm != "y":
        print("Cancelled.")
        return

    del deck_data["sections"][section]
    _save_deck(username, deck_name, deck_data)
    print(f"\nDeleted section '{section}' from '{deck_name}'.")

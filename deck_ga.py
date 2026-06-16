from pathlib import Path
from inv_ga import _flatten_cards, _print_inv_table, _resolve_display, _prune_cards
from pricing_ga import _select_foil, JSON_INFO
from util_file import new_dir, new_json

import json

DIR_DECK = "DATA_GA/DECK_GA"
DIR_DECKS = "DATA_GA/DECKS_GA"
JSON_EDITIONS = "DATA_GA/CARDS_GA/EDITIONS.json"


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
    return {"desc": desc, "format": fmt, "cards": {}}


def _make_index_entry(desc: str = "", fmt: str = "") -> dict:
    from datetime import date
    return {"desc": desc, "format": fmt, "created": date.today().isoformat()}


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


def _card_count(cards: dict) -> int:
    """Return total card quantity across all entries in a cards dict."""
    total = 0
    for editions in cards.values():
        for foils in editions.values():
            for qty in foils.values():
                total += qty
    return total


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
    fmt = input("Format (optional): ").strip()

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

            # Rename index entry
            index_data[new_name] = index_data.pop(deck_name)
            _save_index(username, index_data)

            # Rename deck file
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
        count = _card_count(deck_data["cards"]) if deck_data else 0

        fmt_label = f" [{fmt}]" if fmt else ""
        desc_label = f" — {desc}" if desc else ""

        print(f"  {name:<{name_w}}{fmt_label}{desc_label}  ({count} cards, created {created})")


def deck_view(username: str, debug: bool = False) -> None:
    """Select a deck and view its full card list."""
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

    rows = _flatten_cards(deck_data["cards"])
    _print_inv_table(rows)


def deck_card_add(username: str, debug: bool = False) -> None:
    """Add a card to a deck."""
    index_data = _load_index(username)

    print("\nDecks")
    deck_name = _select_deck(index_data, "Select deck")

    if not deck_name:
        return

    deck_data = _load_deck(username, deck_name)

    if not deck_data:
        return

    card_name = input("\nEnter card name: ").strip()
    result = _select_foil(card_name)

    if not result:
        return

    edition_id, foil_id = result

    editions_file = new_json(JSON_EDITIONS)

    with editions_file.open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    card_id = editions_data.get(edition_id, {}).get("card_id")

    if not card_id:
        print("Error: Could not resolve card ID.")
        return

    cards = deck_data["cards"]
    current_qty = cards.get(card_id, {}).get(edition_id, {}).get(foil_id, 0)

    qty_input = input(f"Quantity [{current_qty}] (+, -, or integer): ").strip()

    if qty_input == "+":
        new_qty = current_qty + 1
    elif qty_input == "-":
        new_qty = current_qty - 1
    elif qty_input.lstrip("-").isdigit():
        new_qty = int(qty_input)
    else:
        print("Invalid input, no changes made.")
        return

    card_name_resolved, set_prefix, collector_number, rarity, foil_kind = _resolve_display(
        card_id, edition_id, foil_id
    )

    label = (
        f"{card_name_resolved} | "
        f"{set_prefix} #{collector_number} | "
        f"{rarity} | {foil_kind}"
    )

    if new_qty <= 0:
        if current_qty == 0:
            print("No changes made.")
            return

        _prune_cards(cards, card_id, edition_id, foil_id)
        _save_deck(username, deck_name, deck_data)

        if debug:
            print(f"Removed from deck | user={username} | deck={deck_name} | card_id={card_id}")
        else:
            print(f"\nRemoved from '{deck_name}': {label}")

        return

    cards.setdefault(card_id, {}).setdefault(edition_id, {})
    cards[card_id][edition_id][foil_id] = new_qty

    _save_deck(username, deck_name, deck_data)

    if debug:
        print(f"Updated deck | user={username} | deck={deck_name} | card_id={card_id} | quantity={new_qty}")
    else:
        print(f"\nUpdated '{deck_name}': {label} | x{new_qty}")

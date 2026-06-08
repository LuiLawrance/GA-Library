from pathlib import Path
from pricing_ga import _select_foil, JSON_INFO, JSON_SLUGS
from util_file import new_dir, new_json

import json

DIR_INV = "DATA_GA/INV_GA"
JSON_EDITIONS = "DATA_GA/CARDS_GA/EDITIONS.json"

DEFAULT_BIN = "Inventory"


# ── Internal helpers ──────────────────────────────────────────────────────────

def _flatten_cards(cards: dict) -> list[tuple[str, str, str, int]]:
    """Return a flat list of (card_id, edition_id, foil_id, quantity) from a bin's cards dict."""
    rows = []

    for card_id, editions in cards.items():
        for edition_id, foils in editions.items():
            for foil_id, quantity in foils.items():
                rows.append((card_id, edition_id, foil_id, quantity))

    return rows


def _inv_path(username: str) -> Path:
    return Path(f"{DIR_INV}/{username}.json")


def _load_inv(username: str) -> dict:
    inv_file = new_json(f"{DIR_INV}/{username}.json")

    with inv_file.open("r", encoding="utf-8") as f:
        raw = json.load(f)

    # Migrate: empty file from old user_create
    if not raw:
        data = _make_default_structure()
        _save_inv(username, data)
        return data

    # Migrate: old { "cards": {}, "bins": {} } structure
    if "cards" in raw or "bins" in raw:
        cards = raw.get("cards", {})
        old_bins = raw.get("bins", {})

        data = {DEFAULT_BIN: {"default": True, "cards": cards}}

        for bin_name, bin_cards in old_bins.items():
            data[bin_name] = {"default": False, "cards": bin_cards}

        _save_inv(username, data)
        return data

    return raw


def _make_default_structure() -> dict:
    return {DEFAULT_BIN: {"default": True, "desc": "", "public": False, "cards": {}}}


def _print_inv_table(rows: list[tuple[str, str, str, int]]) -> None:
    """Print a formatted inventory table from flattened rows."""
    if not rows:
        print("  (empty)")
        return

    resolved = []

    for card_id, edition_id, foil_id, quantity in rows:
        card_name, set_prefix, collector_number, rarity, foil_kind = _resolve_display(
            card_id, edition_id, foil_id
        )

        resolved.append((card_name, set_prefix, collector_number, rarity, foil_kind, str(quantity)))

    idx_w = len(str(len(resolved)))
    name_w = max(len(r[0]) for r in resolved)
    prefix_w = max(len(r[1]) for r in resolved)
    num_w = max(len(r[2]) for r in resolved)
    rarity_w = max(len(r[3]) for r in resolved)
    foil_w = max(len(r[4]) for r in resolved)
    qty_w = max(len(r[5]) for r in resolved)

    for i, (name, prefix, num, rarity, foil, qty) in enumerate(resolved, 1):
        print(
            f"{str(i).rjust(idx_w)}. "
            f"{name:<{name_w}} | "
            f"{prefix:<{prefix_w}} | "
            f"#{num:>{num_w}} | "
            f"{rarity:<{rarity_w}} | "
            f"{foil:<{foil_w}} | "
            f"x{qty:>{qty_w}}"
        )


def _prune_cards(cards: dict, card_id: str, edition_id: str, foil_id: str) -> None:
    """Remove a foil entry from a cards dict and clean up empty parents in place."""
    cards.get(card_id, {}).get(edition_id, {}).pop(foil_id, None)

    if card_id in cards and edition_id in cards[card_id] and not cards[card_id][edition_id]:
        del cards[card_id][edition_id]

    if card_id in cards and not cards[card_id]:
        del cards[card_id]


def _resolve_display(card_id: str, edition_id: str, foil_id: str) -> tuple[str, str, str, str, str]:
    """Return (card_name, set_prefix, collector_number, rarity, foil_kind) for display."""
    rarity_map = {
        1: "C", 2: "U", 3: "R", 4: "SR",
        5: "UR", 6: "PR", 7: "CSR", 8: "CUR", 9: "CPR"
    }

    info_file = new_json(JSON_INFO)
    slug_file = new_json(JSON_SLUGS)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    card_name = next(
        (d["name"] for d in slug_data.values() if d["card_id"] == card_id),
        card_id
    )

    card_info = info_data.get(card_id, {})
    edition_info = card_info.get("editions", {}).get(edition_id, {})

    set_prefix = edition_info.get("set_prefix", "?")
    rarity = rarity_map.get(edition_info.get("rarity"), "?")

    set_file_name = set_prefix.lower().replace(" ", "_")
    set_path = Path(f"DATA_GA/SETS_GA/{set_file_name}.json")
    collector_number = "?"

    if set_path.exists():
        with set_path.open("r", encoding="utf-8") as f:
            set_data = json.load(f)

        collector_number = next(
            (num for num, eids in set_data.items()
             if edition_id in (eids if isinstance(eids, list) else [eids])),
            "?"
        )

    foils = edition_info.get("foils", {})
    foil_kind = "?"

    if foil_id in foils:
        foil_kind = foils[foil_id].get("kind", "?").title()
    else:
        for foil_info in foils.values():
            if foil_id in foil_info.get("variants", {}):
                foil_kind = foil_info["variants"][foil_id].get("kind", "?")
                break

    return card_name, set_prefix, collector_number, rarity, foil_kind


def _save_inv(username: str, inv_data: dict) -> None:
    with _inv_path(username).open("w", encoding="utf-8") as f:
        json.dump(inv_data, f, indent=4, ensure_ascii=False)


def _select_bin(inv_data: dict, prompt: str = "Select bin") -> str | None:
    """Prompt the user to pick a bin by number. Returns bin name or None."""
    bin_names = list(inv_data.keys())

    for i, name in enumerate(bin_names, 1):
        default_marker = " *" if inv_data[name].get("default") else ""
        print(f"{i}. {name}{default_marker}")

    choice = input(f"\n{prompt} (or 0 to cancel): ").strip()

    if choice == "0" or not choice:
        return None

    if not choice.isdigit() or not (1 <= int(choice) <= len(bin_names)):
        print("Invalid selection.")
        return None

    return bin_names[int(choice) - 1]


# ── Public functions — inventory init ─────────────────────────────────────────

def inv_init(username: str, debug: bool = False) -> None:
    """Write the default inventory structure for a new user."""
    new_dir(DIR_INV)
    inv_file = _inv_path(username)

    with inv_file.open("w", encoding="utf-8") as f:
        json.dump(_make_default_structure(), f, indent=4, ensure_ascii=False)

    if debug:
        print(f"Initialised inventory | user={username}")


def inv_edit(username: str, card_name: str, debug: bool = False) -> None:
    """Edit a card's quantity in the default bin using +, -, or an integer."""
    inv_data = _load_inv(username)

    default_bin = next((name for name, info in inv_data.items() if info.get("default")), None)

    if not default_bin:
        print("Error: No default bin found.")
        return

    cards = inv_data[default_bin]["cards"]

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
        _save_inv(username, inv_data)

        if debug:
            print(f"Removed from default bin | user={username} | card_id={card_id}")
        else:
            print(f"\nRemoved from '{default_bin}': {label}")

        return

    cards.setdefault(card_id, {}).setdefault(edition_id, {})
    cards[card_id][edition_id][foil_id] = new_qty

    _save_inv(username, inv_data)

    if debug:
        print(
            f"Updated default bin | "
            f"user={username} | "
            f"bin={default_bin} | "
            f"card_id={card_id} | "
            f"quantity={new_qty}"
        )
    else:
        print(f"\nUpdated '{default_bin}': {label} | x{new_qty}")


# ── Public functions — bins ───────────────────────────────────────────────────

def bin_create(username: str, debug: bool = False) -> None:
    """Create a new named bin."""
    inv_data = _load_inv(username)

    name = input("\nBin name: ").strip()

    if not name:
        print("Cancelled.")
        return

    if name in inv_data:
        print(f"Bin already exists: {name}")
        return

    inv_data[name] = {"default": False, "desc": "", "public": False, "cards": {}}

    _save_inv(username, inv_data)

    if debug:
        print(f"Created bin | user={username} | bin={name}")
    else:
        print(f"\nCreated bin: {name}")


def bin_delete(username: str, debug: bool = False) -> None:
    """Delete a bin. The default bin cannot be deleted."""
    inv_data = _load_inv(username)

    print("\nBins")
    bin_name = _select_bin(inv_data, "Select bin to delete")

    if not bin_name:
        return

    if inv_data[bin_name].get("default"):
        print("Cannot delete the default bin.")
        return

    confirm = input(f"Delete bin '{bin_name}'? (y/n): ").strip().lower()

    if confirm != "y":
        print("Cancelled.")
        return

    del inv_data[bin_name]

    _save_inv(username, inv_data)

    if debug:
        print(f"Deleted bin | user={username} | bin={bin_name}")
    else:
        print(f"\nDeleted bin: {bin_name}")


def bin_edit(username: str, debug: bool = False) -> None:
    """Select a bin then edit a card's quantity within it."""
    inv_data = _load_inv(username)

    print("\nBins")
    bin_name = _select_bin(inv_data, "Select bin")

    if not bin_name:
        return

    cards = inv_data[bin_name]["cards"]

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
        _save_inv(username, inv_data)

        if debug:
            print(f"Removed from bin | user={username} | bin={bin_name} | card_id={card_id}")
        else:
            print(f"\nRemoved from '{bin_name}': {label}")

        return

    cards.setdefault(card_id, {}).setdefault(edition_id, {})
    cards[card_id][edition_id][foil_id] = new_qty

    _save_inv(username, inv_data)

    if debug:
        print(
            f"Updated bin | "
            f"user={username} | "
            f"bin={bin_name} | "
            f"card_id={card_id} | "
            f"quantity={new_qty}"
        )
    else:
        print(f"\nUpdated '{bin_name}': {label} | x{new_qty}")


def bin_list(username: str, debug: bool = False) -> None:
    """List all bins and their contents."""
    inv_data = _load_inv(username)

    for bin_name, bin_info in inv_data.items():
        rows = _flatten_cards(bin_info["cards"])
        default_marker = " *" if bin_info.get("default") else ""
        print(f"\n[ {bin_name}{default_marker} ] ({len(rows)} entries)")
        _print_inv_table(rows)

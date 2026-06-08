from pathlib import Path
from pricing_ga import _select_foil, JSON_INFO, JSON_SLUGS
from util_file import new_json

import json

DIR_INV = "DATA_GA/INV_GA"
JSON_EDITIONS = "DATA_GA/CARDS_GA/EDITIONS.json"


# ── Internal helpers ──────────────────────────────────────────────────────────

def _flatten_inv(inv_data: dict) -> list[tuple[str, str, str, int]]:
    """Return a flat list of (card_id, edition_id, foil_id, quantity) from nested inventory."""
    rows = []

    for card_id, editions in inv_data.items():
        for edition_id, foils in editions.items():
            for foil_id, quantity in foils.items():
                rows.append((card_id, edition_id, foil_id, quantity))

    return rows


def _inv_path(username: str) -> Path:
    return Path(f"{DIR_INV}/{username}.json")


def _load_inv(username: str) -> dict:
    inv_file = new_json(f"{DIR_INV}/{username}.json")

    with inv_file.open("r", encoding="utf-8") as f:
        return json.load(f)


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

    idx_w    = len(str(len(resolved)))
    name_w   = max(len(r[0]) for r in resolved)
    prefix_w = max(len(r[1]) for r in resolved)
    num_w    = max(len(r[2]) for r in resolved)
    rarity_w = max(len(r[3]) for r in resolved)
    foil_w   = max(len(r[4]) for r in resolved)
    qty_w    = max(len(r[5]) for r in resolved)

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


# ── Public functions ──────────────────────────────────────────────────────────

def inv_edit(username: str, card_name: str, debug: bool = False) -> None:
    """Select a foil then adjust quantity with +, -, or an integer. Removes entry if quantity reaches 0."""
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

    inv_data = _load_inv(username)
    current_qty = inv_data.get(card_id, {}).get(edition_id, {}).get(foil_id, 0)

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

        if card_id in inv_data and edition_id in inv_data[card_id]:
            inv_data[card_id][edition_id].pop(foil_id, None)

            if not inv_data[card_id][edition_id]:
                del inv_data[card_id][edition_id]

            if not inv_data[card_id]:
                del inv_data[card_id]

        _save_inv(username, inv_data)

        if debug:
            print(
                f"Removed entry | "
                f"user={username} | "
                f"card_id={card_id} | "
                f"edition_id={edition_id} | "
                f"foil_id={foil_id}"
            )
        else:
            print(f"\nRemoved: {label}")

        return

    inv_data.setdefault(card_id, {}).setdefault(edition_id, {})
    inv_data[card_id][edition_id][foil_id] = new_qty

    _save_inv(username, inv_data)

    if debug:
        print(
            f"Updated entry | "
            f"user={username} | "
            f"card_id={card_id} | "
            f"edition_id={edition_id} | "
            f"foil_id={foil_id} | "
            f"quantity={new_qty}"
        )
    else:
        print(f"\nUpdated: {label} | x{new_qty}")


def inv_list(username: str, debug: bool = False) -> None:
    """Print all inventory entries for a user."""
    inv_data = _load_inv(username)
    rows = _flatten_inv(inv_data)

    print(f"\nInventory — {username} ({len(rows)} entries)")

    _print_inv_table(rows)
from datetime import date, datetime
from util_file import new_json

import api_tcgplayer
import json
import re

JSON_LISTINGS = "DATA_GA/PRICING_GA/LISTINGS.json"
JSON_SALES = "DATA_GA/PRICING_GA/SALES.json"

RARITY_MAP = {
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


def _add_listing(edition_id: str, foil_id: str, marketplace: str, price: float, info: str, debug: bool = False) -> None:
    entry = {
        "date": date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "info": info,
    }

    card_id = _append_entry(JSON_LISTINGS, edition_id, foil_id, entry)

    if debug:
        print(
            f"Added listing | "
            f"card_id={card_id} | "
            f"edition_id={edition_id} | "
            f"foil_id={foil_id} | "
            f"marketplace={marketplace} | "
            f"price={price} | "
            f"info={info}"
        )


def _add_sale(edition_id: str, foil_id: str, marketplace: str, price: float, info: str, debug: bool = False) -> None:
    entry = {
        "date": date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "info": info,
    }

    card_id = _append_entry(JSON_SALES, edition_id, foil_id, entry)

    if debug:
        print(
            f"Added sale | "
            f"card_id={card_id} | "
            f"edition_id={edition_id} | "
            f"foil_id={foil_id} | "
            f"marketplace={marketplace} | "
            f"price={price} | "
            f"info={info}"
        )


def _append_entry(file_path: str, edition_id: str, foil_id: str, entry: dict) -> str:
    from api_ga import JSON_EDITIONS
    editions_file = new_json(JSON_EDITIONS)
    target_file = new_json(file_path)

    with editions_file.open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    card_id = editions_data[edition_id]["card_id"]

    with target_file.open("r", encoding="utf-8") as f:
        target_data = json.load(f)

    target_data[card_id][edition_id][foil_id].append(entry)

    with target_file.open("w", encoding="utf-8") as f:
        json.dump(target_data, f, indent=4, ensure_ascii=False)

    return card_id


def delete_entry(edition_id: str, foil_id: str, entry_type: str, index: int) -> dict:
    """Removes a single sale/listing record by its position within its own
    foil's list — the position an admin sees it at in the flattened, sorted
    /history response, since raw entries have no id of their own."""
    from api_ga import JSON_EDITIONS

    if entry_type not in ("sales", "listings"):
        return {"ok": False, "error": "entry_type must be 'sales' or 'listings'."}

    editions_file = new_json(JSON_EDITIONS)
    with editions_file.open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    if edition_id not in editions_data:
        return {"ok": False, "error": "Edition not found."}

    card_id = editions_data[edition_id]["card_id"]
    file_path = JSON_SALES if entry_type == "sales" else JSON_LISTINGS
    target_file = new_json(file_path)

    with target_file.open("r", encoding="utf-8") as f:
        target_data = json.load(f)

    records = target_data.get(card_id, {}).get(edition_id, {}).get(foil_id)

    if records is None or not (0 <= index < len(records)):
        return {"ok": False, "error": "Entry not found."}

    records.pop(index)

    with target_file.open("w", encoding="utf-8") as f:
        json.dump(target_data, f, indent=4, ensure_ascii=False)

    return {"ok": True}


def _build_edition_options(info_data: dict, card_id: str) -> list[tuple[str, str, str, str]]:
    options = []

    for edition_id, edition_info in info_data[card_id]["editions"].items():
        set_prefix, rarity, collector_number = _edition_display(edition_id, edition_info)
        options.append((edition_id, set_prefix, rarity, collector_number))

    return options


def _build_foil_options(info_data: dict, card_id: str) -> list[tuple[str, str, str, str, str, str]]:
    options = []

    for edition_id, edition_info in info_data[card_id]["editions"].items():
        set_prefix, rarity, collector_number = _edition_display(edition_id, edition_info)

        for foil_id, foil_info in edition_info["foils"].items():
            variant_population = sum(v["population"] for v in foil_info["variants"].values())
            remaining_population = foil_info["population"] - variant_population

            if remaining_population > 0:
                options.append((edition_id, foil_id, set_prefix, rarity, foil_info["kind"].title(), collector_number))

            for variant_id, variant_info in foil_info["variants"].items():
                options.append((edition_id, variant_id, set_prefix, rarity, variant_info["kind"], collector_number))

    return options


def _edition_display(edition_id: str, edition_info: dict) -> tuple[str, str, str]:
    set_prefix = edition_info["set_prefix"]
    rarity = RARITY_MAP.get(edition_info["rarity"], "?")

    from api_ga import _format_search, DIR_SETS
    set_file_name = _format_search(set_prefix).replace("-", "_")
    set_file = new_json(f"{DIR_SETS}/{set_file_name}.json")

    with set_file.open("r", encoding="utf-8") as f:
        set_data = json.load(f)

    collector_number = next(
        (num for num, eids in set_data.items()
         if edition_id in (eids if isinstance(eids, list) else [eids])),
        "?"
    )

    return set_prefix, rarity, collector_number


def _parse_tcg_date(date_str: str) -> str:
    return datetime.strptime(date_str, "%m/%d/%y").date().isoformat()


def _prompt_entry(card_name: str, file_path: str, debug: bool = False) -> None:
    result = _select_foil(card_name)

    if not result:
        return

    edition_id, foil_id = result

    marketplace = input("Enter marketplace: ").strip()
    price = float(input("Enter price: ").strip())
    quantity_input = input("Enter quantity: ").strip()
    quantity = int(quantity_input) if quantity_input else 1
    info = input("Enter info: ").strip()

    entry = {
        "date": date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "quantity": quantity,
        "info": info,
    }

    card_id = _append_entry(file_path, edition_id, foil_id, entry)

    if debug:
        print(
            f"Added entry | "
            f"card_id={card_id} | "
            f"edition_id={edition_id} | "
            f"foil_id={foil_id} | "
            f"marketplace={marketplace} | "
            f"price={price} | "
            f"info={info}"
        )


def _resolve_card(card_name: str) -> tuple[dict, str] | None:
    from api_ga import _api_search, _format_search, JSON_INFO, JSON_SLUGS

    info_file = new_json(JSON_INFO)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    slug_file = new_json(JSON_SLUGS)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    slug = _format_search(card_name)

    if slug not in slug_data:
        card_data = _api_search(slug)

        if not card_data:
            print(f"Card not found: {card_name}")
            return None

        with info_file.open("r", encoding="utf-8") as f:
            info_data = json.load(f)

        with slug_file.open("r", encoding="utf-8") as f:
            slug_data = json.load(f)

    print(f"\n{slug_data[slug]['name']}")

    return info_data, slug_data[slug]["card_id"]


def _select_edition(card_name: str) -> str | None:
    resolved = _resolve_card(card_name)

    if not resolved:
        return None

    info_data, card_id = resolved
    options = _build_edition_options(info_data, card_id)
    product_ids = [api_tcgplayer.get_product_id(edition_id) or "-" for edition_id, _, _, _ in options]

    prefix_width = max(len(o[1]) for o in options)
    number_width = max(len(o[3]) for o in options)
    rarity_width = max(len(o[2]) for o in options)
    product_id_width = max(len(p) for p in product_ids)

    total = len(options)
    index_width = len(str(total))

    for i, ((_, set_prefix, rarity, collector_number), product_id) in enumerate(zip(options, product_ids), 1):
        print(
            f"{str(i).rjust(index_width)}. "
            f"{set_prefix:<{prefix_width}} | "
            f"{collector_number:>{number_width}} | "
            f"{rarity:<{rarity_width}} | "
            f"TCG: {product_id:<{product_id_width}}"
        )

    choice = input("\nSelect option: ").strip()

    if not choice.isdigit() or not (1 <= int(choice) <= len(options)):
        print("\nInvalid option.")
        return None

    edition_id, _, _, _ = options[int(choice) - 1]

    return edition_id


def _select_foil(card_name: str) -> tuple[str, str] | None:
    resolved = _resolve_card(card_name)

    if not resolved:
        return None

    info_data, card_id = resolved
    options = _build_foil_options(info_data, card_id)

    prefix_width = max(len(o[2]) for o in options)
    number_width = max(len(o[5]) for o in options)
    rarity_width = max(len(o[3]) for o in options)
    foil_width = max(len(o[4]) for o in options)

    total = len(options)
    index_width = len(str(total))

    for i, (_, _, set_prefix, rarity, foil_kind, collector_number) in enumerate(options, 1):
        print(
            f"{str(i).rjust(index_width)}. "
            f"{set_prefix:<{prefix_width}} | "
            f"{collector_number:>{number_width}} | "
            f"{rarity:<{rarity_width}} | "
            f"{foil_kind:<{foil_width}}"
        )

    choice = input("\nSelect option: ").strip()

    if not choice.isdigit() or not (1 <= int(choice) <= len(options)):
        print("\nInvalid option.")
        return None

    edition_id, foil_id, _, _, _, _ = options[int(choice) - 1]

    return edition_id, foil_id


def _store_listings_tcg(edition_id: str, listings: list[dict], debug: bool = False) -> tuple[int, int]:
    from api_ga import JSON_EDITIONS, JSON_INFO

    editions_file = new_json(JSON_EDITIONS)
    info_file = new_json(JSON_INFO)
    listings_file = new_json(JSON_LISTINGS)

    with editions_file.open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    card_id = editions_data[edition_id]["card_id"]

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    foils = info_data[card_id]["editions"][edition_id]["foils"]
    foil_ids_by_kind = {foil_info["kind"]: foil_id for foil_id, foil_info in foils.items()}

    with listings_file.open("r", encoding="utf-8") as f:
        listings_data = json.load(f)

    stored = 0
    skipped_unrecognized = 0

    for listing in listings:
        foil_id = foil_ids_by_kind.get(listing["foil_kind"]) if listing["foil_kind"] else None

        if not foil_id:
            skipped_unrecognized += 1
            continue

        entry = {
            "date": listing["date"],
            "marketplace": "TCGPlayer",
            "price": listing["price"],
            "quantity": listing["quantity"],
            "info": listing["condition"],
        }

        listings_data.setdefault(card_id, {}).setdefault(edition_id, {}).setdefault(foil_id, []).append(entry)
        stored += 1

    with listings_file.open("w", encoding="utf-8") as f:
        json.dump(listings_data, f, indent=4, ensure_ascii=False)

    if debug:
        print(
            f"Stored TCG listings | "
            f"card_id={card_id} | "
            f"edition_id={edition_id} | "
            f"stored={stored} | "
            f"skipped_unrecognized={skipped_unrecognized}"
        )

    return stored, skipped_unrecognized


def _store_sales_tcg(edition_id: str, sales: list[dict], debug: bool = False) -> tuple[int, int, int, int]:
    from api_ga import JSON_EDITIONS, JSON_INFO

    editions_file = new_json(JSON_EDITIONS)
    info_file = new_json(JSON_INFO)
    sales_file = new_json(JSON_SALES)

    with editions_file.open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    card_id = editions_data[edition_id]["card_id"]

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    foils = info_data[card_id]["editions"][edition_id]["foils"]
    foil_ids_by_kind = {foil_info["kind"]: foil_id for foil_id, foil_info in foils.items()}

    with sales_file.open("r", encoding="utf-8") as f:
        sales_data = json.load(f)

    today = date.today().isoformat()
    stored = 0
    skipped_today = 0
    skipped_duplicate = 0
    skipped_unrecognized = 0

    # Dates already present before this run, per foil_id. A non-today date is
    # treated as settled — once it's been captured once, it never changes, so
    # any further sale reported for that date this run is a re-scraped repeat.
    existing_dates_by_foil = {}

    for sale in sales:
        foil_id = foil_ids_by_kind.get(sale["foil_kind"]) if sale["foil_kind"] else None

        if not foil_id:
            skipped_unrecognized += 1
            continue

        sale_date = _parse_tcg_date(sale["date"])

        if sale_date == today:
            skipped_today += 1
            continue

        if foil_id not in existing_dates_by_foil:
            existing_entries = sales_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])
            existing_dates_by_foil[foil_id] = {entry["date"] for entry in existing_entries}

        if sale_date in existing_dates_by_foil[foil_id]:
            skipped_duplicate += 1
            continue

        entry = {
            "date": sale_date,
            "marketplace": "TCGPlayer",
            "price": sale["price"],
            "quantity": sale["quantity"],
            "info": sale["condition"],
        }

        sales_data.setdefault(card_id, {}).setdefault(edition_id, {}).setdefault(foil_id, []).append(entry)
        stored += 1

    with sales_file.open("w", encoding="utf-8") as f:
        json.dump(sales_data, f, indent=4, ensure_ascii=False)

    if debug:
        print(
            f"Stored TCG sales | "
            f"card_id={card_id} | "
            f"edition_id={edition_id} | "
            f"stored={stored} | "
            f"skipped_today={skipped_today} | "
            f"skipped_duplicate={skipped_duplicate} | "
            f"skipped_unrecognized={skipped_unrecognized}"
        )

    return stored, skipped_today, skipped_duplicate, skipped_unrecognized


def _sync_info(card_data: dict, debug: bool = False) -> None:
    from api_ga import JSON_INFO

    info_file = new_json(JSON_INFO)
    listings_file = new_json(JSON_LISTINGS)
    sales_file = new_json(JSON_SALES)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    with listings_file.open("r", encoding="utf-8") as f:
        listings_data = json.load(f)

    with sales_file.open("r", encoding="utf-8") as f:
        sales_data = json.load(f)

    card_id = card_data["editions"][0]["card_id"]
    card_info = info_data.get(card_id, {})

    added_editions = 0
    added_foils = 0

    for data in (listings_data, sales_data):
        if card_id not in data:
            data[card_id] = {}

    for edition_id, edition_info in card_info.get("editions", {}).items():
        for data in (listings_data, sales_data):
            if edition_id not in data[card_id]:
                data[card_id][edition_id] = {}
                added_editions += 1

        for foil_id, foil_info in edition_info.get("foils", {}).items():
            variant_population = sum(v["population"] for v in foil_info.get("variants", {}).values())
            remaining_population = foil_info["population"] - variant_population

            if remaining_population > 0:
                for data in (listings_data, sales_data):
                    if foil_id not in data[card_id][edition_id]:
                        data[card_id][edition_id][foil_id] = []
                        added_foils += 1

            for variant_id in foil_info.get("variants", {}):
                for data in (listings_data, sales_data):
                    if variant_id not in data[card_id][edition_id]:
                        data[card_id][edition_id][variant_id] = []
                        added_foils += 1

    with listings_file.open("w", encoding="utf-8") as f:
        json.dump(listings_data, f, indent=4, ensure_ascii=False)

    with sales_file.open("w", encoding="utf-8") as f:
        json.dump(sales_data, f, indent=4, ensure_ascii=False)

    if debug:
        print(
            f"Synced pricing structure | "
            f"card_id={card_id} | "
            f"editions={added_editions} | "
            f"foils={added_foils}"
        )


def add_listing(card_name: str, debug: bool = False) -> None:
    _prompt_entry(card_name, JSON_LISTINGS, debug)


def add_sale(card_name: str, debug: bool = False) -> None:
    _prompt_entry(card_name, JSON_SALES, debug)


def _foil_kind_for_id(foils: dict, foil_id: str) -> str | None:
    for fid, finfo in foils.items():
        if fid == foil_id:
            return finfo.get("kind")
        for vid, vinfo in finfo.get("variants", {}).items():
            if vid == foil_id:
                return vinfo.get("kind")
    return None


def add_manual_entry(edition_id: str, foil_id: str, entry_type: str, price: float, quantity: int = 1,
                      info: str = "", marketplace: str = "Manual", entry_date: str | None = None,
                      debug: bool = False) -> dict:
    """Web-safe core: appends a single sale/listing entry without interactive
    prompts, for the admin console's manual-entry form."""
    from api_ga import JSON_EDITIONS, JSON_INFO

    file_path = JSON_SALES if entry_type == "sales" else JSON_LISTINGS

    # Match the "<condition> Foil" convention scraped/pasted entries already use
    # (see _store_sales_tcg / parse_pasted_sales) — otherwise a manually-added
    # foil sale is stored under the right foil_id but reads identically to a
    # nonfoil one in the combined history list, since "info" is all that's shown.
    editions_file = new_json(JSON_EDITIONS)
    with editions_file.open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    info_file = new_json(JSON_INFO)
    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    card_id_lookup = editions_data.get(edition_id, {}).get("card_id")
    foils = info_data.get(card_id_lookup, {}).get("editions", {}).get(edition_id, {}).get("foils", {})
    foil_kind = _foil_kind_for_id(foils, foil_id)

    if foil_kind and foil_kind.strip().upper() == "FOIL" and not info.strip().lower().endswith("foil"):
        info = f"{info} Foil".strip()

    entry = {
        "date": entry_date or date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "quantity": quantity,
        "info": info,
    }

    card_id = _append_entry(file_path, edition_id, foil_id, entry)

    # A manual entry is us recording pricing data for this edition just as much
    # as a scrape or pasted import is — count it the same way so the admin
    # console's "last updated" badge (and, for listings, the refresh gate)
    # reflect it.
    if entry_type == "sales":
        api_tcgplayer.set_last_sales(edition_id, debug)
    else:
        api_tcgplayer.set_last_listings(edition_id, debug)

    if debug:
        print(
            f"Added manual {entry_type} entry | "
            f"card_id={card_id} | "
            f"edition_id={edition_id} | "
            f"foil_id={foil_id} | "
            f"date={entry['date']} | "
            f"marketplace={marketplace} | "
            f"price={price} | "
            f"quantity={quantity} | "
            f"info={info}"
        )

    return entry


_PASTE_CONDITION_RE = re.compile(r"^(NM|LP|MP|HP|DMG)(\s+Foil)?$", re.IGNORECASE)
_PASTE_QTY_PRICE_RE = re.compile(r"^(\d+)\s+\$?([\d,]+\.?\d*)$")
_PASTE_FULL_CONDITION_NAMES = {name.lower() for name in api_tcgplayer.CONDITION_MAP.values()}


def _is_full_condition_line(line: str) -> bool:
    """True for a bare condition name like "Near Mint" or "Near Mint Foil" —
    TCGPlayer's copy sometimes repeats the abbreviation's full name on its own
    line right after it (e.g. "NM" then "Near Mint")."""
    base = line[:-5].strip().lower() if line.lower().endswith(" foil") else line.strip().lower()
    return base in _PASTE_FULL_CONDITION_NAMES


def parse_pasted_sales(text: str) -> tuple[list[dict], list[str]]:
    """Parses sales data copy-pasted directly from TCGPlayer's sales history
    table — a workaround for the scraper being capped at ~5 rows while logged
    out. Expects date / condition / qty+price repeating in groups, exactly as
    it appears when the table is selected and copied — TCGPlayer sometimes
    inserts an extra line repeating the condition's full name (e.g. "NM" then
    "Near Mint") right before the qty+price line, which is skipped if present.
    Returns (parsed_entries, error_lines) — error_lines holds any input that
    didn't fit the expected shape, for surfacing back to the admin."""
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").split("\n")]
    lines = [ln for ln in lines if ln]

    entries = []
    errors = []
    i = 0

    while i < len(lines):
        date_line = lines[i]

        try:
            datetime.strptime(date_line, "%m/%d/%y")
        except ValueError:
            errors.append(date_line)
            i += 1
            continue

        if i + 2 >= len(lines):
            errors.append(date_line)
            break

        condition_line = lines[i + 1]
        condition_match = _PASTE_CONDITION_RE.match(condition_line)

        if not condition_match:
            errors.append(f"{date_line} / {condition_line}")
            i += 1
            continue

        qty_price_index = i + 2
        if qty_price_index < len(lines) and _is_full_condition_line(lines[qty_price_index]):
            qty_price_index += 1

        if qty_price_index >= len(lines):
            errors.append(f"{date_line} / {condition_line}")
            break

        qty_price_line = lines[qty_price_index]
        qty_price_match = _PASTE_QTY_PRICE_RE.match(qty_price_line)

        if not qty_price_match:
            errors.append(f"{date_line} / {condition_line} / {qty_price_line}")
            i += 1
            continue

        condition_abbr = condition_match.group(1).upper()
        is_foil = bool(condition_match.group(2))
        condition = api_tcgplayer.CONDITION_MAP.get(condition_abbr, condition_abbr)

        if is_foil:
            condition += " Foil"
            foil_kind = "FOIL"
        else:
            foil_kind = "NONFOIL"

        quantity_str, price_str = qty_price_match.groups()

        entries.append({
            "date": date_line,
            "condition": condition,
            "foil_kind": foil_kind,
            "quantity": int(quantity_str),
            "price": float(price_str.replace(",", "")),
        })

        i = qty_price_index + 1

    return entries, errors


def import_pasted_sales_tcg_by_edition(edition_id: str, raw_text: str, debug: bool = False) -> dict:
    """Stores sales data an admin copy-pasted directly from TCGPlayer's sales
    history table, exactly like a scrape would — a workaround for the scraper
    being capped at ~5 rows while logged out of TCGPlayer."""
    entries, errors = parse_pasted_sales(raw_text)

    if not entries:
        return {"ok": False, "error": "Could not parse any sales entries from the pasted text."}

    stored, skipped_today, skipped_duplicate, skipped_unrecognized = _store_sales_tcg(edition_id, entries, debug)
    api_tcgplayer.set_last_sales(edition_id, debug)

    return {
        "ok": True,
        "stored": stored,
        "skipped_today": skipped_today,
        "skipped_duplicate": skipped_duplicate,
        "skipped_unrecognized": skipped_unrecognized,
        "parse_errors": errors,
    }


def _listings_gate_result(edition_id: str) -> dict | None:
    """None if listings are safe to refresh, otherwise the gated result dict
    to return as-is."""
    last_listings = api_tcgplayer.get_last_listings(edition_id)

    if not last_listings:
        return None

    days_since = (date.today() - date.fromisoformat(last_listings)).days

    if days_since <= 7:
        return {
            "ok": True,
            "gated": True,
            "gated_message": f"Listings last updated {days_since} day(s) ago (on {last_listings}) — need more than 7 days between updates.",
            "listings": [],
            "stored": 0,
            "skipped_unrecognized": 0,
        }

    return None


def _process_sales_result(edition_id: str, sales: list[dict] | None, debug: bool = False) -> dict:
    if sales is None:
        return {"ok": False, "error": "Fetch failed. See server logs for details."}

    api_tcgplayer.set_last_sales(edition_id, debug)

    if not sales:
        return {"ok": True, "sales": [], "stored": 0, "skipped_today": 0, "skipped_duplicate": 0, "skipped_unrecognized": 0}

    stored, skipped_today, skipped_duplicate, skipped_unrecognized = _store_sales_tcg(edition_id, sales, debug)

    return {
        "ok": True,
        "sales": sales,
        "stored": stored,
        "skipped_today": skipped_today,
        "skipped_duplicate": skipped_duplicate,
        "skipped_unrecognized": skipped_unrecognized,
    }


def _process_listings_result(edition_id: str, listings: list[dict] | None, debug: bool = False) -> dict:
    if listings is None:
        return {"ok": False, "error": "Fetch failed. See server logs for details."}

    api_tcgplayer.set_last_listings(edition_id, debug)

    if not listings:
        return {"ok": True, "gated": False, "listings": [], "stored": 0, "skipped_unrecognized": 0}

    cheapest_by_condition = {}

    for listing in listings:
        condition = listing["condition"]
        current_cheapest = cheapest_by_condition.get(condition)

        if current_cheapest is None or listing["price"] < current_cheapest["price"]:
            cheapest_by_condition[condition] = listing

    condition_order = list(api_tcgplayer.CONDITION_MAP.values())

    def condition_rank(condition: str) -> float:
        is_foil = condition.endswith(" Foil")
        base = condition.removesuffix(" Foil") if is_foil else condition
        rank = condition_order.index(base) if base in condition_order else len(condition_order)
        return rank + (0.5 if is_foil else 0)

    cheapest = sorted(cheapest_by_condition.values(), key=lambda listing: condition_rank(listing["condition"]))

    stored, skipped_unrecognized = _store_listings_tcg(edition_id, cheapest, debug)

    return {
        "ok": True,
        "gated": False,
        "listings": cheapest,
        "stored": stored,
        "skipped_unrecognized": skipped_unrecognized,
    }


def _no_product_id_error(product_id: str | None) -> dict:
    """Shared "can't scrape" result for a missing or '~'-marked product ID —
    either way there's no real product page to open a browser and visit."""
    if product_id == api_tcgplayer.NO_LISTINGS_SENTINEL:
        return {"ok": False, "error": 'Marked as having no TCGPlayer listings ("~").'}

    return {"ok": False, "error": "No TCGPlayer product ID configured for this edition."}


def scrape_listings_tcg_by_edition(edition_id: str, debug: bool = False, headless: bool = False, page=None) -> dict:
    """Web-safe core: no interactive prompts, requires a product_id to already
    be stored. Returns a result dict rather than printing, so both the CLI
    and the web admin-refresh endpoint can share this logic. Pass an existing
    Playwright `page` to reuse a shared browser instead of opening a new one."""
    gated = _listings_gate_result(edition_id)

    if gated is not None:
        return gated

    product_id = api_tcgplayer.get_product_id(edition_id)

    if not product_id or product_id == api_tcgplayer.NO_LISTINGS_SENTINEL:
        return _no_product_id_error(product_id)

    url = api_tcgplayer._build_url(product_id)
    listings = api_tcgplayer.fetch_listings(url, debug, headless, page=page)

    return _process_listings_result(edition_id, listings, debug)


def scrape_listings_tcg(card_name: str, debug: bool = False) -> None:
    edition_id = _select_edition(card_name)

    if not edition_id:
        return

    api_tcgplayer.prompt_product_id(edition_id, debug)

    result = scrape_listings_tcg_by_edition(edition_id, debug)

    if not result["ok"]:
        print(f"\n{result['error']}")
        return

    if result.get("gated"):
        print(f"\n{result['gated_message']}")
        return

    cheapest = result["listings"]

    if not cheapest:
        return

    print()

    total = len(cheapest)
    index_width = len(str(total))
    condition_width = max(len(listing["condition"]) for listing in cheapest)
    quantity_width = max(len(str(listing["quantity"])) for listing in cheapest)
    price_width = max(len(f"{listing['price']:.2f}") for listing in cheapest)

    for i, listing in enumerate(cheapest, 1):
        print(
            f"{str(i).rjust(index_width)}. "
            f"{listing['condition']:<{condition_width}} | "
            f"x{str(listing['quantity']).rjust(quantity_width)} | "
            f"${listing['price']:>{price_width}.2f}"
        )

    summary = f"\nStored {result['stored']} listing(s)"

    if result["skipped_unrecognized"]:
        summary += f", skipped {result['skipped_unrecognized']} unrecognized variant(s)"

    print(summary)


def scrape_sales_tcg_by_edition(edition_id: str, debug: bool = False, headless: bool = False, page=None) -> dict:
    """Web-safe core: no interactive prompts, requires a product_id to already
    be stored. Returns a result dict rather than printing, so both the CLI
    and the web admin-refresh endpoint can share this logic. Pass an existing
    Playwright `page` to reuse a shared browser instead of opening a new one."""
    product_id = api_tcgplayer.get_product_id(edition_id)

    if not product_id or product_id == api_tcgplayer.NO_LISTINGS_SENTINEL:
        return _no_product_id_error(product_id)

    url = api_tcgplayer._build_url(product_id)
    sales = api_tcgplayer.fetch_sales(url, debug, headless, page=page)

    return _process_sales_result(edition_id, sales, debug)


def scrape_sales_and_listings_tcg_by_edition(edition_id: str, debug: bool = False, headless: bool = False,
                                              page=None) -> dict:
    """Combined web-safe core for a full ('both') refresh — scrapes sales and
    listings in a single shared browser session instead of opening and closing
    a separate browser for each. Returns {"sales": ..., "listings": ...}, each
    shaped exactly like the respective solo scrape_*_tcg_by_edition() result.
    Pass an existing Playwright `page` to reuse an even-wider shared browser
    (e.g. one spanning multiple editions in a batch refresh)."""
    product_id = api_tcgplayer.get_product_id(edition_id)

    if not product_id or product_id == api_tcgplayer.NO_LISTINGS_SENTINEL:
        error = _no_product_id_error(product_id)
        return {"sales": error, "listings": error}

    gated = _listings_gate_result(edition_id)
    url = api_tcgplayer._build_url(product_id)

    sales, listings = api_tcgplayer.fetch_sales_and_listings(
        url, debug, headless, want_sales=True, want_listings=gated is None, page=page
    )

    sales_result = _process_sales_result(edition_id, sales, debug)
    listings_result = gated if gated is not None else _process_listings_result(edition_id, listings, debug)

    return {"sales": sales_result, "listings": listings_result}


def scrape_batch_tcg_by_editions(edition_ids: list[str], target: str, debug: bool = False,
                                  headless: bool = False, progress_callback=None) -> dict[str, dict]:
    """Runs a full refresh — sales, listings, or both — across many editions
    using a single shared browser session, instead of opening and closing a
    browser per edition (or per edition per target). progress_callback(edition_id,
    result), if given, is called after each edition finishes so callers (e.g. the
    admin console's job-status endpoint) can report incremental progress.

    `result` is always shaped {"sales": ... | None, "listings": ... | None},
    matching scrape_sales_and_listings_tcg_by_edition()'s return value, with
    whichever side wasn't requested left as None."""
    from playwright.sync_api import sync_playwright

    results = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page()

        for edition_id in edition_ids:
            try:
                if target == "both":
                    result = scrape_sales_and_listings_tcg_by_edition(edition_id, debug, headless, page=page)
                elif target == "sales":
                    result = {"sales": scrape_sales_tcg_by_edition(edition_id, debug, headless, page=page), "listings": None}
                else:
                    result = {"sales": None, "listings": scrape_listings_tcg_by_edition(edition_id, debug, headless, page=page)}
            except Exception as e:
                # One edition failing unexpectedly (e.g. a page-structure change
                # mid-batch) shouldn't abort the rest of the batch.
                error = {"ok": False, "error": f"Unexpected error: {e}"}
                result = {
                    "sales": error if target in ("both", "sales") else None,
                    "listings": error if target in ("both", "listings") else None,
                }

            results[edition_id] = result

            if progress_callback:
                progress_callback(edition_id, result)

        browser.close()

    return results


def find_product_ids_by_editions(edition_ids: list[str], debug: bool = False,
                                  headless: bool = False, progress_callback=None) -> dict[str, dict]:
    """Looks up TCGPlayer product IDs for many editions using a single shared
    browser session, matching each edition's card name + collector number
    against TCGPlayer's search results. Persists any confident match via
    api_tcgplayer.set_product_id(). progress_callback(edition_id, result), if
    given, is called after each edition finishes.

    `result` is {"ok": bool, "product_id": str | None, "error": str | None}."""
    from api_ga import _build_collector_map, JSON_EDITIONS, JSON_INFO, JSON_SLUGS
    from playwright.sync_api import sync_playwright

    editions_file = new_json(JSON_EDITIONS)
    with editions_file.open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    slug_file = new_json(JSON_SLUGS)
    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)
    name_by_card_id = {entry["card_id"]: entry["name"] for entry in slug_data.values()}

    info_file = new_json(JSON_INFO)
    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    collector_map = _build_collector_map()

    results = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page()

        for edition_id in edition_ids:
            card_id = editions_data.get(edition_id, {}).get("card_id")
            card_name = name_by_card_id.get(card_id)
            collector_number = collector_map.get(edition_id)
            set_name = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {}).get("set_name", "")

            if not card_name or not collector_number:
                result = {"ok": False, "product_id": None, "error": "Missing card name or collector number."}
            else:
                try:
                    product_id = api_tcgplayer.find_product_id(
                        card_name, collector_number, set_name, debug=debug, headless=headless, page=page
                    )
                except Exception as e:
                    product_id = None
                    result = {"ok": False, "product_id": None, "error": f"Unexpected error: {e}"}
                else:
                    if product_id:
                        api_tcgplayer.set_product_id(edition_id, product_id, debug)
                        result = {"ok": True, "product_id": product_id, "error": None}
                    else:
                        result = {"ok": False, "product_id": None, "error": "No confident match found."}

            results[edition_id] = result

            if progress_callback:
                progress_callback(edition_id, result)

        browser.close()

    return results


def scrape_sales_tcg(card_name: str, debug: bool = False) -> None:
    edition_id = _select_edition(card_name)

    if not edition_id:
        return

    api_tcgplayer.prompt_product_id(edition_id, debug)

    result = scrape_sales_tcg_by_edition(edition_id, debug)

    if not result["ok"]:
        print(f"\n{result['error']}")
        return

    sales = result["sales"]

    if not sales:
        return

    print()

    total = len(sales)
    index_width = len(str(total))
    date_width = max(len(sale["date"]) for sale in sales)
    condition_width = max(len(sale["condition"]) for sale in sales)
    quantity_width = max(len(str(sale["quantity"])) for sale in sales)
    price_width = max(len(f"{sale['price']:.2f}") for sale in sales)

    for i, sale in enumerate(sales, 1):
        print(
            f"{str(i).rjust(index_width)}. "
            f"{sale['date']:<{date_width}} | "
            f"{sale['condition']:<{condition_width}} | "
            f"x{str(sale['quantity']).rjust(quantity_width)} | "
            f"${sale['price']:>{price_width}.2f}"
        )

    summary = f"\nStored {result['stored']} sale(s)"

    if result["skipped_today"]:
        summary += f", excluded {result['skipped_today']} from today"

    if result["skipped_duplicate"]:
        summary += f", skipped {result['skipped_duplicate']} already-recorded date(s)"

    if result["skipped_unrecognized"]:
        summary += f", skipped {result['skipped_unrecognized']} unrecognized variant(s)"

    print(summary)

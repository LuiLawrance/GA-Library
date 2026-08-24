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

# tcgcsv.com's extendedData "Rarity" field spells out Grand Archive's full
# rarity names (e.g. "Collector Super Rare") rather than our own RARITY_MAP
# abbreviations — same numeric scheme, just the other direction, used to
# cross-check a tcgcsv product's rarity against a local candidate edition's
# own recorded one (see import_product_ids_from_tcgcsv). A Collector-rarity
# card (CSR/CUR/CPR) keeps its base printing's collector number, so without
# this check a same-numbered regular/Collector pair — which Grand Archive
# sometimes models as two editions in two different local sets (e.g. "MRC"
# and "MRC 1st") sharing one tcgcsv Group ID — silently cross-matches: a
# product looked up by number alone would blindly accept whichever single
# edition its own set/slug happens to have at that number, regular or
# Collector, without ever checking they're the same rarity.
TCGCSV_RARITY_CODE = {
    "Common": 1,
    "Uncommon": 2,
    "Rare": 3,
    "Super Rare": 4,
    "Ultra Rare": 5,
    "Prime Rare": 6,
    "Collector Super Rare": 7,
    "Collector Ultra Rare": 8,
    "Collector Prime Rare": 9
}


def _add_listing(edition_id: str, foil_id: str, marketplace: str, price: float, condition: str, debug: bool = False) -> None:
    entry = {
        "date": date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "condition": condition,
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
            f"condition={condition}"
        )


def _add_sale(edition_id: str, foil_id: str, marketplace: str, price: float, condition: str, debug: bool = False) -> None:
    entry = {
        "date": date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "condition": condition,
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
            f"condition={condition}"
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


def _entry_key(entry: dict) -> tuple:
    return (entry.get("date"), entry.get("marketplace"), entry.get("price"), entry.get("quantity"), entry.get("condition"))


def _import_price_records(file_path: str, import_data: dict) -> dict:
    """Backfills SALES.json/LISTINGS.json from a JSON blob shaped exactly
    like the file itself (card_id -> edition_id -> foil_id -> [entries]) —
    the admin console's Import Sales/Import Listings buttons, for
    re-merging a prior export (e.g. after a local hard reset) back in.

    An entry is added only if no EXACT match (same date, marketplace,
    price, quantity, condition) already exists for that card/edition/foil —
    so re-running the same import twice never creates duplicates, while two
    genuinely distinct sales/listings that happen to share a date (a normal,
    valid occurrence — see any card with more than one sale in a day) both
    come through untouched. Deliberately not scoped to known
    cards/editions/foils, matching import_ids()'s own reasoning: this only
    needs to guarantee no duplicates, not that every key already exists
    elsewhere, so a foil_id (or edition/card) missing from the current data
    entirely still gets its own fresh entry here rather than being skipped.

    Unlike the scrape/paste path's _store_sales_tcg/_store_listings_tcg,
    this doesn't gate on "already have a sale from today" or do any
    foil_kind lookup — import_data is already in stored form, one row per
    real entry, keyed directly by foil_id, not raw scraped rows that still
    need attributing to one."""
    target_file = new_json(file_path)

    with target_file.open("r", encoding="utf-8") as f:
        current = json.load(f)

    added = 0

    for card_id, editions in import_data.items():
        if not isinstance(editions, dict):
            continue

        for edition_id, foils in editions.items():
            if not isinstance(foils, dict):
                continue

            for foil_id, entries in foils.items():
                if not isinstance(entries, list):
                    continue

                existing = current.setdefault(card_id, {}).setdefault(edition_id, {}).setdefault(foil_id, [])
                existing_keys = {_entry_key(e) for e in existing if isinstance(e, dict)}

                for entry in entries:
                    if not isinstance(entry, dict):
                        continue

                    key = _entry_key(entry)
                    if key in existing_keys:
                        continue

                    existing.append({
                        "date": entry.get("date"),
                        "marketplace": entry.get("marketplace"),
                        "price": entry.get("price"),
                        "quantity": entry.get("quantity"),
                        "condition": entry.get("condition"),
                    })
                    existing_keys.add(key)
                    added += 1

    with target_file.open("w", encoding="utf-8") as f:
        json.dump(current, f, indent=4, ensure_ascii=False)

    return {"added": added}


def import_sales(import_data: dict) -> dict:
    return _import_price_records(JSON_SALES, import_data)


def import_listings(import_data: dict) -> dict:
    return _import_price_records(JSON_LISTINGS, import_data)


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
            population = foil_info["population"]
            variant_population = sum(v["population"] for v in foil_info["variants"].values())
            remaining_population = None if population is None else population - variant_population

            # A None population means the API hasn't reported circulation data yet
            # (a TEMP_FOIL_ID placeholder edition) — still offer it, matching
            # _sync_info elsewhere in this module.
            if remaining_population is None or remaining_population > 0:
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
    condition = input("Enter condition: ").strip()

    entry = {
        "date": date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "quantity": quantity,
        "condition": condition,
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
            f"condition={condition}"
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


def _store_listings_tcg(edition_id: str, listings: list[dict], debug: bool = False,
                         foil_id_override: str | None = None) -> tuple[int, int]:
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
        # foil_id_override is set when scraping a foil-specific product page
        # (e.g. a Curio Foil's own separate TCGPlayer listing) — every row on
        # that page belongs to that one foil, so the kind-based lookup below
        # (meant for the edition's shared nonfoil+foil product page) doesn't
        # apply.
        foil_id = foil_id_override or (foil_ids_by_kind.get(listing["foil_kind"]) if listing["foil_kind"] else None)

        if not foil_id:
            skipped_unrecognized += 1
            continue

        entry = {
            "date": listing["date"],
            "marketplace": "TCGPlayer",
            "price": listing["price"],
            "quantity": listing["quantity"],
            "condition": listing["condition"],
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


def _store_sales_tcg(edition_id: str, sales: list[dict], debug: bool = False,
                      foil_id_override: str | None = None) -> tuple[int, int, int, int]:
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
        # See the matching comment in _store_listings_tcg — a foil_id_override
        # means every row belongs to that one foil-specific product page.
        foil_id = foil_id_override or (foil_ids_by_kind.get(sale["foil_kind"]) if sale["foil_kind"] else None)

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
            "condition": sale["condition"],
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
            population = foil_info.get("population")
            variant_population = sum(v["population"] for v in foil_info.get("variants", {}).values())
            remaining_population = None if population is None else population - variant_population

            # A None population means the API hasn't reported circulation data yet
            # (a TEMP_FOIL_ID placeholder edition) — still create the entry so the
            # foil stays selectable everywhere a real foil_id normally would be.
            if remaining_population is None or remaining_population > 0:
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


def _foil_print_kind_for_id(foils: dict, foil_id: str) -> str | None:
    """Like _foil_kind_for_id(), but for a variant (e.g. a Curio Foil)
    returns its PARENT foil's NONFOIL/FOIL kind instead of the variant's own
    descriptive name ("Aurora Curio Foil" isn't "FOIL" or "NONFOIL", so
    comparing it against those directly always fails). A variant doesn't
    have its own independent print kind — it's nested under, and inherits,
    whichever top-level foil it belongs to (mirrors the same parent-lookup
    _curio_foil_id_for_edition's caller does in app.py's /foils endpoint)."""
    for fid, finfo in foils.items():
        if fid == foil_id:
            return finfo.get("kind")
        if foil_id in finfo.get("variants", {}):
            return finfo.get("kind")
    return None


def add_manual_entry(edition_id: str, foil_id: str, entry_type: str, price: float, quantity: int = 1,
                      condition: str = "", marketplace: str = "Manual", entry_date: str | None = None,
                      debug: bool = False) -> dict:
    """Web-safe core: appends a single sale/listing entry without interactive
    prompts, for the admin console's manual-entry form."""
    from api_ga import JSON_EDITIONS, JSON_INFO

    file_path = JSON_SALES if entry_type == "sales" else JSON_LISTINGS

    # Match the "<condition> Foil" convention scraped/pasted entries already use
    # (see _store_sales_tcg / parse_pasted_sales) — otherwise a manually-added
    # foil sale is stored under the right foil_id but reads identically to a
    # nonfoil one in the combined history list, since "condition" is all that's
    # shown.
    editions_file = new_json(JSON_EDITIONS)
    with editions_file.open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    info_file = new_json(JSON_INFO)
    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    card_id_lookup = editions_data.get(edition_id, {}).get("card_id")
    foils = info_data.get(card_id_lookup, {}).get("editions", {}).get(edition_id, {}).get("foils", {})
    foil_kind = _foil_print_kind_for_id(foils, foil_id)

    if foil_kind and foil_kind.strip().upper() == "FOIL" and not condition.strip().lower().endswith("foil"):
        condition = f"{condition} Foil".strip()

    entry = {
        "date": entry_date or date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "quantity": quantity,
        "condition": condition,
    }

    card_id = _append_entry(file_path, edition_id, foil_id, entry)

    # A manual entry is us recording pricing data for this edition just as much
    # as a scrape or pasted import is — count it the same way so the admin
    # console's "last updated" badge (and, for listings, the refresh gate)
    # reflect it. A variant foil_id (e.g. a Curio Foil's) gets its own
    # foil-scoped clock stamped instead of the edition's main one — same
    # distinction the scrape/paste-import paths already make. Checked
    # structurally against the card data (is foil_id nested as a variant
    # under any of this edition's foils?) rather than via
    # get_foil_overrides(), which would still be empty if this is the very
    # first thing ever recorded for that variant (e.g. before its product ID
    # has been entered).
    is_variant = any(foil_id in finfo.get("variants", {}) for finfo in foils.values())

    if entry_type == "sales":
        if is_variant:
            api_tcgplayer.set_foil_last_sales(edition_id, foil_id, debug)
        else:
            api_tcgplayer.set_last_sales(edition_id, debug)
    else:
        if is_variant:
            api_tcgplayer.set_foil_last_listings(edition_id, foil_id, debug)
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
            f"condition={condition}"
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


def import_pasted_sales_tcg_by_edition(edition_id: str, raw_text: str, debug: bool = False,
                                        foil_id: str | None = None) -> dict:
    """Stores sales data an admin copy-pasted directly from TCGPlayer's sales
    history table, exactly like a scrape would — a workaround for the scraper
    being capped at ~5 rows while logged out of TCGPlayer.

    Pass foil_id (e.g. a Curio Foil's) to attribute every pasted row to that
    one foil directly instead of matching each row's Nonfoil/Foil condition
    text against the edition's top-level foils — the pasted text comes from
    that foil's own separate TCGPlayer page, which has no mixed nonfoil/foil
    rows to disambiguate in the first place (mirrors foil_id_override in
    _store_sales_tcg / the scrape path's per-foil scoping)."""
    entries, errors = parse_pasted_sales(raw_text)

    if not entries:
        return {"ok": False, "error": "Could not parse any sales entries from the pasted text."}

    stored, skipped_today, skipped_duplicate, skipped_unrecognized = _store_sales_tcg(
        edition_id, entries, debug, foil_id_override=foil_id
    )

    if foil_id:
        api_tcgplayer.set_foil_last_sales(edition_id, foil_id, debug)
    else:
        api_tcgplayer.set_last_sales(edition_id, debug)

    return {
        "ok": True,
        "stored": stored,
        "skipped_today": skipped_today,
        "skipped_duplicate": skipped_duplicate,
        "skipped_unrecognized": skipped_unrecognized,
        "parse_errors": errors,
    }


def _listings_gate_result(edition_id: str, foil_id: str | None = None) -> dict | None:
    """None if listings are safe to refresh, otherwise the gated result dict
    to return as-is. Pass foil_id to check a foil override's own gate
    (independent clock from the edition's main listings) instead."""
    last_listings = (
        api_tcgplayer.get_foil_last_listings(edition_id, foil_id)
        if foil_id else api_tcgplayer.get_last_listings(edition_id)
    )

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


def _process_sales_result(edition_id: str, sales: list[dict] | None, debug: bool = False,
                           foil_id: str | None = None) -> dict:
    if sales is None:
        return {"ok": False, "error": "Fetch failed. See server logs for details."}

    if foil_id:
        api_tcgplayer.set_foil_last_sales(edition_id, foil_id, debug)
    else:
        api_tcgplayer.set_last_sales(edition_id, debug)

    if not sales:
        return {"ok": True, "sales": [], "stored": 0, "skipped_today": 0, "skipped_duplicate": 0, "skipped_unrecognized": 0}

    stored, skipped_today, skipped_duplicate, skipped_unrecognized = _store_sales_tcg(
        edition_id, sales, debug, foil_id_override=foil_id
    )

    return {
        "ok": True,
        "sales": sales,
        "stored": stored,
        "skipped_today": skipped_today,
        "skipped_duplicate": skipped_duplicate,
        "skipped_unrecognized": skipped_unrecognized,
    }


def _process_listings_result(edition_id: str, listings: list[dict] | None, debug: bool = False,
                              foil_id: str | None = None) -> dict:
    if listings is None:
        return {"ok": False, "error": "Fetch failed. See server logs for details."}

    if foil_id:
        api_tcgplayer.set_foil_last_listings(edition_id, foil_id, debug)
    else:
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

    stored, skipped_unrecognized = _store_listings_tcg(edition_id, cheapest, debug, foil_id_override=foil_id)

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


def _merge_target_results(main: dict, override_results: list[dict], list_key: str) -> dict:
    """Merges a main-product scrape result with zero or more foil-override
    scrape results of the same shape (all "sales" or all "listings", e.g. a
    Curio Foil's own separate product page). Returns `main` completely
    unchanged when there are no overrides — the vast majority of editions
    have none, and this guarantees zero behavior change for them. Otherwise
    sums stored/skipped_* counts, concatenates the row lists, requires every
    part to have succeeded for the merged "ok", joins error messages, and
    only reports "gated" when every applicable part was gated (if even one
    part actually fetched fresh data, the whole result isn't just a no-op)."""
    if not override_results:
        return main

    parts = [main] + override_results
    merged = dict(main)

    merged["ok"] = all(part.get("ok") for part in parts)
    merged["stored"] = sum(part.get("stored", 0) for part in parts)
    merged["skipped_unrecognized"] = sum(part.get("skipped_unrecognized", 0) for part in parts)

    if list_key == "sales":
        merged["skipped_today"] = sum(part.get("skipped_today", 0) for part in parts)
        merged["skipped_duplicate"] = sum(part.get("skipped_duplicate", 0) for part in parts)
    else:
        merged["gated"] = all(part.get("gated", False) for part in parts)

    merged[list_key] = [row for part in parts for row in (part.get(list_key) or [])]

    errors = [part["error"] for part in parts if not part.get("ok") and part.get("error")]
    if errors:
        merged["error"] = "; ".join(errors)
    elif "error" in merged:
        del merged["error"]

    return merged


def _scrape_target_listings(edition_id: str, foil_id: str | None, debug: bool, headless: bool, page) -> dict:
    """Scrapes+processes listings for either the edition's main product
    (foil_id=None) or one foil override — never raises or short-circuits;
    every outcome (gated, no product ID, fetch failure, success) comes back
    as a result dict so the main and override scrapes can always both run
    and be merged afterward regardless of what happened to either one."""
    gated = _listings_gate_result(edition_id, foil_id)

    if gated is not None:
        return gated

    product_id = api_tcgplayer.get_foil_product_id(edition_id, foil_id) if foil_id else api_tcgplayer.get_product_id(edition_id)

    if not product_id or product_id == api_tcgplayer.NO_LISTINGS_SENTINEL:
        return _no_product_id_error(product_id)

    url = api_tcgplayer._build_url(product_id)
    listings = api_tcgplayer.fetch_listings(url, debug, headless, page=page)

    return _process_listings_result(edition_id, listings, debug, foil_id=foil_id)


def scrape_listings_tcg_by_edition(edition_id: str, debug: bool = False, headless: bool = False, page=None,
                                    foil_scope: str | None = None) -> dict:
    """Web-safe core: no interactive prompts, requires a product_id to already
    be stored. Returns a result dict rather than printing, so both the CLI
    and the web admin-refresh endpoint can share this logic. Pass an existing
    Playwright `page` to reuse a shared browser instead of opening a new one.

    By default (foil_scope=None) also scrapes any foil-specific product
    overrides for this edition (e.g. a Curio Foil's own separate TCGPlayer
    product) and merges their results in — see _merge_target_results().
    Overrides are scraped before the main product (not that it affects the
    merged result either way) so a shared browser page doesn't sit on the
    main product's page for however many listing pages it has before ever
    visiting the override's.

    Pass foil_scope="main" to scrape ONLY the main product, or a specific
    foil_id to scrape ONLY that one override — skipping the other side
    entirely rather than merging. Used by the admin UI's per-row Curio Foil
    toggle so a refresh only touches whichever product (main or the toggled
    override) the admin is currently looking at, not both at once."""
    if foil_scope == "main":
        return _scrape_target_listings(edition_id, None, debug, headless, page)

    if foil_scope is not None:
        return _scrape_target_listings(edition_id, foil_scope, debug, headless, page)

    overrides = api_tcgplayer.get_foil_overrides(edition_id)
    override_results = [
        _scrape_target_listings(edition_id, foil_id, debug, headless, page)
        for foil_id, entry in overrides.items() if entry.get("product_id")
    ]

    main = _scrape_target_listings(edition_id, None, debug, headless, page)

    return _merge_target_results(main, override_results, "listings")


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


def _scrape_target_sales(edition_id: str, foil_id: str | None, debug: bool, headless: bool, page) -> dict:
    """Sales counterpart to _scrape_target_listings() — see its docstring."""
    product_id = api_tcgplayer.get_foil_product_id(edition_id, foil_id) if foil_id else api_tcgplayer.get_product_id(edition_id)

    if not product_id or product_id == api_tcgplayer.NO_LISTINGS_SENTINEL:
        return _no_product_id_error(product_id)

    url = api_tcgplayer._build_url(product_id)
    sales = api_tcgplayer.fetch_sales(url, debug, headless, page=page)

    return _process_sales_result(edition_id, sales, debug, foil_id=foil_id)


def scrape_sales_tcg_by_edition(edition_id: str, debug: bool = False, headless: bool = False, page=None,
                                 foil_scope: str | None = None) -> dict:
    """Web-safe core: no interactive prompts, requires a product_id to already
    be stored. Returns a result dict rather than printing, so both the CLI
    and the web admin-refresh endpoint can share this logic. Pass an existing
    Playwright `page` to reuse a shared browser instead of opening a new one.
    Also scrapes any foil-specific product overrides, or scopes to just the
    main product or just one override — see scrape_listings_tcg_by_edition()
    for foil_scope's meaning (including why overrides go first by default)."""
    if foil_scope == "main":
        return _scrape_target_sales(edition_id, None, debug, headless, page)

    if foil_scope is not None:
        return _scrape_target_sales(edition_id, foil_scope, debug, headless, page)

    overrides = api_tcgplayer.get_foil_overrides(edition_id)
    override_results = [
        _scrape_target_sales(edition_id, foil_id, debug, headless, page)
        for foil_id, entry in overrides.items() if entry.get("product_id")
    ]

    main = _scrape_target_sales(edition_id, None, debug, headless, page)

    return _merge_target_results(main, override_results, "sales")


def _scrape_target_both(edition_id: str, foil_id: str | None, debug: bool, headless: bool, page) -> tuple[dict, dict]:
    """Scrapes sales+listings together in a single page visit (see
    fetch_sales_and_listings) for either the edition's main product
    (foil_id=None) or one foil override. Like _scrape_target_listings(), never
    short-circuits — always returns (sales_result, listings_result)."""
    product_id = api_tcgplayer.get_foil_product_id(edition_id, foil_id) if foil_id else api_tcgplayer.get_product_id(edition_id)

    if not product_id or product_id == api_tcgplayer.NO_LISTINGS_SENTINEL:
        error = _no_product_id_error(product_id)
        return error, error

    gated = _listings_gate_result(edition_id, foil_id)
    url = api_tcgplayer._build_url(product_id)

    sales, listings = api_tcgplayer.fetch_sales_and_listings(
        url, debug, headless, want_sales=True, want_listings=gated is None, page=page
    )

    sales_result = _process_sales_result(edition_id, sales, debug, foil_id=foil_id)
    listings_result = gated if gated is not None else _process_listings_result(edition_id, listings, debug, foil_id=foil_id)

    return sales_result, listings_result


def scrape_sales_and_listings_tcg_by_edition(edition_id: str, debug: bool = False, headless: bool = False,
                                              page=None, foil_scope: str | None = None) -> dict:
    """Combined web-safe core for a full ('both') refresh — scrapes sales and
    listings in a single shared browser session instead of opening and closing
    a separate browser for each. Returns {"sales": ..., "listings": ...}, each
    shaped exactly like the respective solo scrape_*_tcg_by_edition() result.
    Pass an existing Playwright `page` to reuse an even-wider shared browser
    (e.g. one spanning multiple editions in a batch refresh).

    By default (foil_scope=None) also scrapes any foil-specific product
    overrides for this edition (each gets its own single-visit sales+listings
    scrape) and merges their results in — see _merge_target_results().
    Overrides are scraped before the main product (not that it affects the
    merged result either way) so a shared browser page doesn't sit on the
    main product's page for however many listing pages it has before ever
    visiting the override's.

    Pass foil_scope="main" to scrape ONLY the main product, or a specific
    foil_id to scrape ONLY that one override — see
    scrape_listings_tcg_by_edition() for the full rationale (the admin UI's
    per-row Curio Foil toggle)."""
    if foil_scope == "main":
        sales, listings = _scrape_target_both(edition_id, None, debug, headless, page)
        return {"sales": sales, "listings": listings}

    if foil_scope is not None:
        sales, listings = _scrape_target_both(edition_id, foil_scope, debug, headless, page)
        return {"sales": sales, "listings": listings}

    overrides = api_tcgplayer.get_foil_overrides(edition_id)
    override_sales = []
    override_listings = []

    for foil_id, entry in overrides.items():
        if not entry.get("product_id"):
            continue

        sales_result, listings_result = _scrape_target_both(edition_id, foil_id, debug, headless, page)
        override_sales.append(sales_result)
        override_listings.append(listings_result)

    main_sales, main_listings = _scrape_target_both(edition_id, None, debug, headless, page)

    return {
        "sales": _merge_target_results(main_sales, override_sales, "sales"),
        "listings": _merge_target_results(main_listings, override_listings, "listings"),
    }


def scrape_batch_tcg_by_editions(edition_ids: list[str], target: str, debug: bool = False,
                                  headless: bool = False, progress_callback=None,
                                  foil_scopes: dict[str, str] | None = None) -> dict[str, dict]:
    """Runs a full refresh — sales, listings, or both — across many editions
    using a single shared browser session, instead of opening and closing a
    browser per edition (or per edition per target). progress_callback(edition_id,
    result), if given, is called after each edition finishes so callers (e.g. the
    admin console's job-status endpoint) can report incremental progress.

    `result` is always shaped {"sales": ... | None, "listings": ... | None},
    matching scrape_sales_and_listings_tcg_by_edition()'s return value, with
    whichever side wasn't requested left as None.

    foil_scopes optionally maps edition_id -> foil_scope ("main", a specific
    foil_id, or absent/None for the default merged main+overrides behavior) —
    see scrape_listings_tcg_by_edition() for what foil_scope does. Used by the
    admin UI's per-row Curio Foil toggle so each edition in a batch refresh
    can be scoped independently to whichever product (main or its toggled
    override) the admin has selected for that row."""
    from playwright.sync_api import sync_playwright

    results = {}
    foil_scopes = foil_scopes or {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page()

        for edition_id in edition_ids:
            scope = foil_scopes.get(edition_id)

            try:
                if target == "both":
                    result = scrape_sales_and_listings_tcg_by_edition(edition_id, debug, headless, page=page, foil_scope=scope)
                elif target == "sales":
                    result = {"sales": scrape_sales_tcg_by_edition(edition_id, debug, headless, page=page, foil_scope=scope), "listings": None}
                else:
                    result = {"sales": None, "listings": scrape_listings_tcg_by_edition(edition_id, debug, headless, page=page, foil_scope=scope)}
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


def _curio_variant_id(foils: dict) -> str | None:
    """Mirrors app.py's _curio_foil_id: exactly one variant across all of an
    edition's foils is TCGPlayer's separate "Curio Foil" product (its own
    business rule — more or fewer than one variant means there's no single
    slot to attribute a tcgcsv "(Curio Foil)" product to). Duplicated here
    rather than imported since app.py imports FROM this module, not the other
    way around."""
    variant_ids = [vid for finfo in foils.values() for vid in finfo.get("variants", {})]
    return variant_ids[0] if len(variant_ids) == 1 else None


def _edition_rarity_code(edition_id: str, editions_data: dict, info_data: dict) -> int | None:
    card_id = editions_data.get(edition_id, {}).get("card_id")
    return info_data.get(card_id, {}).get("editions", {}).get(edition_id, {}).get("rarity")


def import_product_ids_from_tcgcsv(set_slug: str, group_id: str, debug: bool = False) -> dict:
    """Backfills product IDs for every edition in one local set from
    tcgcsv.com (see api_tcgplayer.fetch_tcgcsv_products), matched by collector
    number instead of the fuzzy name-based Playwright search
    find_product_ids_by_editions() falls back to. A tcgcsv product whose name
    contains "Curio Foil" is that edition's special foil variant (see
    _curio_variant_id above); everything else is the edition's own regular
    product. Matched as a substring rather than an exact "(Curio Foil)" suffix
    since TCGPlayer doesn't keep the label consistent — Asphodel Paradise's
    products are named "(Interference Curio Foil)" instead, and there's no
    telling what future sets will call theirs; "Curio Foil" itself is the one
    constant across all of them.

    Number alone isn't always a safe key: Collector-rarity cards (CSR/CUR/
    CPR) keep their base printing's collector number, and Grand Archive
    sometimes models the Collector print as an edition in a DIFFERENT local
    set/slug than the regular one (e.g. "MRC" vs "MRC 1st") that nonetheless
    shares the same tcgcsv Group ID — so a number that's unambiguous within
    THIS slug's own file can still collide with the wrong rarity's product.
    Whenever tcgcsv's own Rarity field is one this app recognizes (see
    TCGCSV_RARITY_CODE), a candidate whose own recorded rarity doesn't match
    is filtered out before anything is written, rather than accepted on
    number alone.

    Only ever fills in a product_id that's currently missing, same
    duplicate-safety as import_ids() — an admin-confirmed ID already on file
    is never overwritten by this.

    A collector number tcgcsv reports with no local match, whose only local
    candidate(s) don't share its rarity, or that (even after the rarity
    filter) still maps to more than one edition, is skipped and counted
    rather than guessed at."""
    from api_ga import DIR_SETS, JSON_EDITIONS, JSON_INFO

    set_file = new_json(f"{DIR_SETS}/{set_slug}.json")
    with set_file.open("r", encoding="utf-8") as f:
        set_data = json.load(f)  # collector_number -> [edition_id, ...]

    with new_json(JSON_EDITIONS).open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    with new_json(JSON_INFO).open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    ids_data = api_tcgplayer.get_all_ids()

    products = api_tcgplayer.fetch_tcgcsv_products(group_id, debug)

    matched_main = 0
    matched_foil = 0
    skipped_already_set = 0
    skipped_no_match = 0
    skipped_rarity_mismatch = 0
    skipped_ambiguous = 0

    for product in products:
        ext = {e.get("name"): e.get("value") for e in product.get("extendedData", [])}
        number = (ext.get("Number") or "").strip()
        product_id = str(product.get("productId") or "").strip()
        tcgcsv_rarity = (ext.get("Rarity") or "").strip()

        if not number or not product_id:
            continue

        candidate_edition_ids = set_data.get(number, [])
        if isinstance(candidate_edition_ids, str):
            candidate_edition_ids = [candidate_edition_ids]

        if not candidate_edition_ids:
            skipped_no_match += 1
            continue

        # Only filter when tcgcsv's Rarity string is one this app recognizes
        # — an unrecognized string means no contradicting evidence either
        # way, so it falls back to trusting the number-only match rather than
        # rejecting it over a rarity this app just doesn't have a code for.
        expected_rarity_code = TCGCSV_RARITY_CODE.get(tcgcsv_rarity)

        if expected_rarity_code is not None:
            rarity_matched_ids = [
                eid for eid in candidate_edition_ids
                if _edition_rarity_code(eid, editions_data, info_data) == expected_rarity_code
            ]

            if not rarity_matched_ids:
                skipped_rarity_mismatch += 1
                continue

            candidate_edition_ids = rarity_matched_ids

        if len(candidate_edition_ids) > 1:
            skipped_ambiguous += 1
            continue

        edition_id = candidate_edition_ids[0]
        is_curio = "Curio Foil" in (product.get("name") or "")

        if is_curio:
            card_id = editions_data.get(edition_id, {}).get("card_id")
            foils = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {}).get("foils", {})
            foil_id = _curio_variant_id(foils)

            if not foil_id:
                skipped_no_match += 1
                continue

            if ids_data.get(edition_id, {}).get("foils", {}).get(foil_id, {}).get("product_id"):
                skipped_already_set += 1
                continue

            api_tcgplayer.set_foil_product_id(edition_id, foil_id, product_id, debug)
            ids_data.setdefault(edition_id, {}).setdefault("foils", {}).setdefault(foil_id, {})["product_id"] = product_id
            matched_foil += 1
        else:
            if ids_data.get(edition_id, {}).get("product_id"):
                skipped_already_set += 1
                continue

            api_tcgplayer.set_product_id(edition_id, product_id, debug)
            ids_data.setdefault(edition_id, {})["product_id"] = product_id
            matched_main += 1

    result = {
        "total_products": len(products),
        "matched_main": matched_main,
        "matched_foil": matched_foil,
        "skipped_already_set": skipped_already_set,
        "skipped_no_match": skipped_no_match,
        "skipped_rarity_mismatch": skipped_rarity_mismatch,
        "skipped_ambiguous": skipped_ambiguous
    }

    if debug:
        print(f"tcgcsv import | set={set_slug} | group_id={group_id} | {result}")

    return result


def clear_product_ids_for_set(set_slug: str, debug: bool = False) -> dict:
    """Clears every product_id (main and Curio Foil override alike) recorded
    for editions in one local set — an admin's way to wipe a bad batch of
    TCGPlayer IDs (from a tcgcsv mismatch, a stale Playwright auto-detect, a
    manual typo, whatever the cause) so the set can be rechecked from
    scratch, without also touching that edition's last_sales/last_listings
    scrape-history clocks (see api_tcgplayer.clear_product_id/
    clear_foil_product_id) — those stay meaningful bookkeeping even once the
    ID that produced them is cleared, same as the existing per-card Clear
    buttons elsewhere in the admin console leave product_id alone."""
    from api_ga import DIR_SETS

    set_file = new_json(f"{DIR_SETS}/{set_slug}.json")
    with set_file.open("r", encoding="utf-8") as f:
        set_data = json.load(f)  # collector_number -> [edition_id, ...]

    edition_ids = set()
    for eids in set_data.values():
        edition_ids.update([eids] if isinstance(eids, str) else eids)

    ids_data = api_tcgplayer.get_all_ids()

    cleared_main = 0
    cleared_foil = 0

    for edition_id in edition_ids:
        entry = ids_data.get(edition_id, {})

        if entry.get("product_id"):
            api_tcgplayer.clear_product_id(edition_id, debug)
            cleared_main += 1

        for foil_id, foil_entry in entry.get("foils", {}).items():
            if foil_entry.get("product_id"):
                api_tcgplayer.clear_foil_product_id(edition_id, foil_id, debug)
                cleared_foil += 1

    result = {"cleared_main": cleared_main, "cleared_foil": cleared_foil}

    if debug:
        print(f"tcgcsv clear | set={set_slug} | {result}")

    return result


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

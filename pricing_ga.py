from datetime import date, datetime
from util_file import new_json

import api_tcgplayer
import json

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


def _store_sales_tcg(edition_id: str, sales: list[dict], debug: bool = False) -> tuple[int, int, int]:
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
    skipped_unrecognized = 0

    for sale in sales:
        foil_id = foil_ids_by_kind.get(sale["foil_kind"]) if sale["foil_kind"] else None

        if not foil_id:
            skipped_unrecognized += 1
            continue

        sale_date = _parse_tcg_date(sale["date"])

        if sale_date == today:
            skipped_today += 1
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
            f"skipped_unrecognized={skipped_unrecognized}"
        )

    return stored, skipped_today, skipped_unrecognized


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


def scrape_sales_tcg(card_name: str, debug: bool = False) -> None:
    edition_id = _select_edition(card_name)

    if not edition_id:
        return

    product_id = api_tcgplayer.prompt_product_id(edition_id, debug)
    url = api_tcgplayer._build_url(product_id)

    sales = api_tcgplayer.fetch_sales(url, debug)

    if sales is None:
        return

    api_tcgplayer.set_last_scraped(edition_id, debug)

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

    stored, skipped_today, skipped_unrecognized = _store_sales_tcg(edition_id, sales, debug)

    summary = f"\nStored {stored} sale(s)"

    if skipped_today:
        summary += f", excluded {skipped_today} from today"

    if skipped_unrecognized:
        summary += f", skipped {skipped_unrecognized} unrecognized variant(s)"

    print(summary)

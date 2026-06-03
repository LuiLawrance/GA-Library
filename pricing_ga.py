from datetime import date
from util_file import new_json

import json

API_TCG = "https://www.tcgplayer.com/search/grand-archive/product?productLineName=grand-archive&q="

DIR_SETS = "DATA_GA/SETS_GA"

JSON_EDITIONS = "DATA_GA/CARDS_GA/EDITIONS.json"  # Mirrors JSON_EDITIONS from api_ga.py — update both if path changes
JSON_INFO = "DATA_GA/CARDS_GA/INFO.json"  # Mirrors JSON_INFO path from api_ga.py — update both if path changes
JSON_SLUGS = "DATA_GA/CARDS_GA/SLUGS.json"

JSON_LISTINGS = "DATA_GA/PRICING_GA/LISTINGS.json"
JSON_SALES = "DATA_GA/PRICING_GA/SALES.json"


def _add_listing(edition_id: str, foil_id: str, marketplace: str, price: float, info: str, debug: bool = False) -> None:
    entry = {
        "date": date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "info": info,
    }

    card_id = _append_entry(JSON_LISTINGS, edition_id, foil_id, entry, debug)

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

    card_id = _append_entry(JSON_SALES, edition_id, foil_id, entry, debug)

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


def _build_foil_options(info_data: dict, card_id: str) -> list[tuple[str, str, str, str, str, str]]:
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

    for edition_id, edition_info in info_data[card_id]["editions"].items():
        set_prefix = edition_info["set_prefix"]
        rarity = rarity_map.get(edition_info["rarity"], "?")

        set_file_name = set_prefix.lower().replace(" ", "_")
        set_file = new_json(f"{DIR_SETS}/{set_file_name}.json")

        with set_file.open("r", encoding="utf-8") as f:
            set_data = json.load(f)

        collector_number = next(
            (num for num, eid in set_data.items() if eid == edition_id),
            "?"
        )

        for foil_id, foil_info in edition_info["foils"].items():
            variant_population = sum(v["population"] for v in foil_info["variants"].values())
            remaining_population = foil_info["population"] - variant_population

            if remaining_population > 0:
                options.append((edition_id, foil_id, set_prefix, rarity, foil_info["kind"].title(), collector_number))

            for variant_id, variant_info in foil_info["variants"].items():
                options.append((edition_id, variant_id, set_prefix, rarity, variant_info["kind"], collector_number))

    return options


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


def _select_foil(card_name: str) -> tuple[str, str] | None:
    info_file = new_json(JSON_INFO)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    slug_file = new_json(JSON_SLUGS)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    from api_ga import _format_search, _api_search
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

    card_id = slug_data[slug]["card_id"]
    options = _build_foil_options(info_data, card_id)

    print(f"\n{slug_data[slug]['name']}")

    prefix_width = max(len(o[2]) for o in options)
    rarity_width = max(len(o[3]) for o in options)
    foil_width = max(len(o[4]) for o in options)
    number_width = max(len(o[5]) for o in options)

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


def _sync_info(card_data: dict, debug: bool = False) -> None:
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

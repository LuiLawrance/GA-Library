from datetime import date
from util_file import new_json

import json

API_TCG = "https://www.tcgplayer.com/search/grand-archive/product?productLineName=grand-archive&q="

JSON_EDITIONS = "DATA_GA/CARDS_GA/EDITIONS.json"  # Mirrors JSON_EDITIONS from api_ga.py — update both if path changes
JSON_INFO = "DATA_GA/CARDS_GA/INFO.json"  # Mirrors JSON_INFO path from api_ga.py — update both if path changes
JSON_LISTINGS = "DATA_GA/PRICING_GA/LISTINGS.json"
JSON_SALES = "DATA_GA/PRICING_GA/SALES.json"


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


def add_listing(edition_id: str, foil_id: str, marketplace: str, price: float, info: str, debug: bool = False) -> None:
    editions_file = new_json(JSON_EDITIONS)
    listings_file = new_json(JSON_LISTINGS)

    with editions_file.open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    card_id = editions_data[edition_id]["card_id"]

    with listings_file.open("r", encoding="utf-8") as f:
        listings_data = json.load(f)

    entry = {
        "date": date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "info": info,
    }

    listings_data[card_id][edition_id][foil_id].append(entry)

    with listings_file.open("w", encoding="utf-8") as f:
        json.dump(listings_data, f, indent=4, ensure_ascii=False)

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


def add_sale(edition_id: str, foil_id: str, marketplace: str, price: float, info: str, debug: bool = False) -> None:
    editions_file = new_json(JSON_EDITIONS)
    sales_file = new_json(JSON_SALES)

    with editions_file.open("r", encoding="utf-8") as f:
        editions_data = json.load(f)

    card_id = editions_data[edition_id]["card_id"]

    with sales_file.open("r", encoding="utf-8") as f:
        sales_data = json.load(f)

    entry = {
        "date": date.today().isoformat(),
        "marketplace": marketplace,
        "price": price,
        "info": info,
    }

    sales_data[card_id][edition_id][foil_id].append(entry)

    with sales_file.open("w", encoding="utf-8") as f:
        json.dump(sales_data, f, indent=4, ensure_ascii=False)

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

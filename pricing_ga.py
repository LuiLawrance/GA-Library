from util_file import new_json

import json

API_TCG = "https://www.tcgplayer.com/search/grand-archive/product?productLineName=grand-archive&q="

JSON_INFO = "DATA_GA/CARDS_GA/INFO.json" # Mirrors JSON_INFO path from api_ga.py — update both if path changes
JSON_PRICES = "DATA_GA/PRICING_GA/PRICES.json"


def _sync_info(card_data: dict, debug: bool = False) -> None:
    info_file = new_json(JSON_INFO)
    pricing_file = new_json(JSON_PRICES)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    with pricing_file.open("r", encoding="utf-8") as f:
        pricing_data = json.load(f)

    card_id = card_data["editions"][0]["card_id"]
    card_info = info_data.get(card_id, {})

    added_editions = 0
    added_foils = 0

    if card_id not in pricing_data:
        pricing_data[card_id] = {}

    for edition_id, edition_info in card_info.get("editions", {}).items():
        if edition_id not in pricing_data[card_id]:
            pricing_data[card_id][edition_id] = {}
            added_editions += 1

        for foil_id, foil_info in edition_info.get("foils", {}).items():
            if foil_id not in pricing_data[card_id][edition_id]:
                pricing_data[card_id][edition_id][foil_id] = []
                added_foils += 1

            for variant_id in foil_info.get("variants", {}):
                if variant_id not in pricing_data[card_id][edition_id]:
                    pricing_data[card_id][edition_id][variant_id] = []
                    added_foils += 1

    with pricing_file.open("w", encoding="utf-8") as f:
        json.dump(pricing_data, f, indent=4, ensure_ascii=False)

    if debug:
        print(
            f"Synced pricing structure | "
            f"card_id={card_id} | "
            f"editions={added_editions} | "
            f"foils={added_foils}"
        )

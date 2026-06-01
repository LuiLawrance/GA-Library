from util_file import new_json

import json
import requests

API_CARD = "https://api.gatcg.com/cards/"

JSON_CARDS = "DATA_GA/RAW/cards.json"


def api_search(card_name: str) -> dict:
    slug = "-".join(card_name.strip().lower().split())

    response = requests.get(f"{API_CARD}{slug}", timeout=10)
    response.raise_for_status()

    card_data = response.json()

    output_file = new_json(JSON_CARDS)

    with output_file.open("w", encoding="utf-8") as f:
        json.dump(card_data, f, indent=4)

    return card_data

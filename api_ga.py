from datetime import datetime
import file
import json
import re
import requests

TIMEOUT = 10
UPDATE_THRESHOLD_DAYS = 30

LINK_API = "https://api.gatcg.com/cards/"

PATH_CARDS = "DATA_CLIENT/GA_CARDS/GA_CARDS.json"
PATH_COLLECTIONS = "DATA_CLIENT/GA_COLLECTIONS/"
PATH_USERS = "DATA_CLIENT/GA_USERS/GA_USERS.json"


def _format_card_name(card_name: str) -> str:
    name = card_name.lower().strip()
    name = re.sub(r"[^a-z0-9\s]", "", name)
    name = re.sub(r"\s+", "-", name)
    return name.strip("-")


def card_search(card_name: str):
    slug = _format_card_name(card_name)
    url = LINK_API + slug

    try:
        response = requests.get(url)
        response.raise_for_status()
        return response.json()

    except requests.exceptions.RequestException as e:
        print(f"Error fetching card '{card_name}': {e}")
        return None

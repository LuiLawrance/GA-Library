from util_file import new_json

import json
import re
import requests

API_CARD = "https://api.gatcg.com/cards/"

JSON_FOILS = "DATA_GA/CARDS_GA/FOILS.json"  # Stores which CARD ID + EDITION ID each FOILD ID belongs to
JSON_INFO = "DATA_GA/CARDS_GA/INFO.json"  # Stores the effects, artist, legality, and accompanying EDITION IDs
JSON_SLUGS = "DATA_GA/CARDS_GA/SLUGS.json"  # Stores the slugs of each card and which CARD ID it belongs to


def _api_search(slug: str, debug: bool = False) -> dict:
    try:
        if debug:
            print(f"Searching API: {slug}")

        response = requests.get(
            f"{API_CARD}{slug}",
            timeout=10
        )

        response.raise_for_status()
        card_data = response.json()

        if debug:
            print(
                f"Found card: "
                f"{card_data['name']}"
            )

        _update_foil(card_data, debug)
        _update_info(card_data, debug)
        _update_slug(slug, card_data, debug)

        return card_data

    except requests.exceptions.HTTPError:
        print(
            f"Error: Card not found "
            f"({slug})"
        )

    except requests.exceptions.RequestException as e:
        print(
            f"Error: API request failed "
            f"({e})"
        )

    return {}


def _check_local(slug: str, debug: bool = False) -> bool:
    slug_file = new_json(JSON_SLUGS)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    exists_locally = slug in slug_data

    if debug:
        if exists_locally:
            print(f"Found locally: {slug}")
        else:
            print(f"Not found locally: {slug}")

    return exists_locally


def _format_search(card_name: str, debug: bool = False) -> str:
    slug = card_name.strip().lower()

    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = re.sub(r"\s+", "-", slug)
    slug = re.sub(r"-+", "-", slug)

    slug = slug.strip("-")

    if debug:
        print(f"Formatted search: '{card_name}' -> '{slug}'")

    return slug


def _update_foil(card_data: dict, debug: bool = False) -> None:
    foil_file = new_json(JSON_FOILS)

    with foil_file.open("r", encoding="utf-8") as f:
        foil_data = json.load(f)

    foil_count = 0
    variant_count = 0

    for edition in card_data["editions"]:
        card_id = edition["card_id"]
        edition_id = edition["uuid"]

        foil_entries = (
                edition.get("circulationTemplates", [])
                + edition.get("circulations", [])
        )

        for foil in foil_entries:
            foil_id = foil["uuid"]

            foil_data[foil_id] = {
                "card_id": card_id,
                "edition_id": edition_id
            }

            foil_count += 1

            for variant in foil.get("variants", []):
                variant_id = variant["uuid"]

                foil_data[variant_id] = {
                    "card_id": card_id,
                    "edition_id": edition_id,
                    "parent_foil_id": foil_id
                }

                variant_count += 1

    with foil_file.open("w", encoding="utf-8") as f:
        json.dump(foil_data, f, indent=4)

    if debug:
        print(
            f"Updated FOILS.json | "
            f"foils={foil_count} | "
            f"variants={variant_count}"
        )


def _update_info(card_data: dict, debug: bool = False) -> None:
    card_id = card_data["editions"][0]["card_id"]

    info_file = new_json(JSON_INFO)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    if card_id not in info_data:
        info_data[card_id] = {}

        if debug:
            print(f"Added new card_id: {card_id}")

    edition_count = 0
    foil_count = 0
    variant_count = 0

    for edition in card_data["editions"]:
        edition_id = edition["uuid"]

        if edition_id not in info_data[card_id]:
            info_data[card_id][edition_id] = {}

        if "foil_ids" in info_data[card_id][edition_id]:
            info_data[card_id][edition_id]["foils"] = (
                info_data[card_id][edition_id].pop("foil_ids")
            )

        if "foils" not in info_data[card_id][edition_id]:
            info_data[card_id][edition_id]["foils"] = {}

        edition_count += 1

        foil_entries = (
                edition.get("circulationTemplates", [])
                + edition.get("circulations", [])
        )

        for foil in foil_entries:
            foil_id = foil["uuid"]

            info_data[card_id][edition_id]["foils"][foil_id] = {
                "kind": foil["kind"],
                "variants": {}
            }

            foil_count += 1

            for variant in foil.get("variants", []):
                variant_id = variant["uuid"]
                variant_kind = variant.get("description", variant["kind"])

                info_data[card_id][edition_id]["foils"][foil_id]["variants"][variant_id] = {
                    "kind": variant_kind
                }

                variant_count += 1

    with info_file.open("w", encoding="utf-8") as f:
        json.dump(info_data, f, indent=4)

    if debug:
        print(
            f"Updated INFO.json | card_id={card_id} "
            f"| editions={edition_count} "
            f"| foils={foil_count} "
            f"| variants={variant_count}"
        )


def _update_slug(slug: str, card_data: dict, debug: bool = False) -> None:
    slug_file = new_json(JSON_SLUGS)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    card_id = card_data["editions"][0]["card_id"]
    card_name = card_data["name"]

    slug_data[slug] = {
        "name": card_name,
        "card_id": card_id
    }

    with slug_file.open("w", encoding="utf-8") as f:
        json.dump(slug_data, f, indent=4)

    if debug:
        print(
            f"Updated SLUGS.json | "
            f"slug='{slug}' | "
            f"name='{card_name}' | "
            f"card_id={card_id}"
        )


def card_search(card_names: list[str], debug: bool = False) -> dict[str, dict]:
    results = {}

    for card_name in card_names:
        slug = _format_search(card_name, debug)

        if _check_local(slug, debug):
            continue

        results[card_name] = _api_search(slug, debug)

    return results

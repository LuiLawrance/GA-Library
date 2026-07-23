from datetime import date
from playwright.sync_api import sync_playwright
from util_file import new_json

import json

BASE_URL = "https://www.tcgplayer.com/product/"

JSON_IDS = "DATA_GA/PRICING_GA/ID_TCGPLAYER.json"

CONDITION_MAP = {
    "NM": "Near Mint",
    "LP": "Lightly Played",
    "MP": "Moderately Played",
    "HP": "Heavily Played",
    "DMG": "Damaged"
}


def _build_url(product_id: str, page: int = 1) -> str:
    return f"{BASE_URL}{product_id}?page={page}"


def get_product_id(edition_id: str) -> str | None:
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    return ids_data.get(edition_id, {}).get("product_id")


def get_last_scraped(edition_id: str) -> str | None:
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    return ids_data.get(edition_id, {}).get("last_scraped")


def _set_product_id(edition_id: str, product_id: str, debug: bool = False) -> None:
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    ids_data.setdefault(edition_id, {})["product_id"] = product_id

    with ids_file.open("w", encoding="utf-8") as f:
        json.dump(ids_data, f, indent=4)

    if debug:
        print(
            f"Updated ID_TCGPLAYER.json | "
            f"edition_id={edition_id} | "
            f"product_id={product_id}"
        )


def set_last_scraped(edition_id: str, debug: bool = False) -> None:
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    last_scraped = date.today().isoformat()
    ids_data.setdefault(edition_id, {})["last_scraped"] = last_scraped

    with ids_file.open("w", encoding="utf-8") as f:
        json.dump(ids_data, f, indent=4)

    if debug:
        print(
            f"Updated ID_TCGPLAYER.json | "
            f"edition_id={edition_id} | "
            f"last_scraped={last_scraped}"
        )


def fetch_sales(url: str, debug: bool = False) -> list[dict] | None:
    from api_ga import _log_error

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            page = browser.new_page()
            page.goto(url)
            page.wait_for_load_state("networkidle")

            page.get_by_text("View More Data").first.click()
            page.wait_for_load_state("networkidle")

            if page.get_by_text("No sales data available").count() > 0:
                if debug:
                    print(f"No sales data available | url={url}")

                browser.close()
                return []

            rows = page.locator(".latest-sales-table__tbody tr")
            sales = []

            for i in range(rows.count()):
                row = rows.nth(i)

                date = row.locator(".latest-sales-table__tbody__date").inner_text().strip()
                quantity = row.locator(".latest-sales-table__tbody_quantity").inner_text().strip()
                price = row.locator(".latest-sales-table__tbody__price").inner_text().strip()

                condition_text = row.locator(".latest-sales-table__tbody__condition").inner_text().strip()
                condition_line = condition_text.splitlines()[0].strip()

                is_foil = condition_line.endswith(" Foil")
                condition_abbr = condition_line.removesuffix(" Foil") if is_foil else condition_line
                condition = CONDITION_MAP.get(condition_abbr, condition_abbr)

                if is_foil:
                    condition += " Foil"
                    # Only a recognized abbreviation + "Foil" (e.g. "NM Foil") is treated as
                    # the regular foil variant. Anything else (e.g. a future "Special Foil"
                    # suffix) is left unclassified rather than guessed at.
                    foil_kind = "FOIL" if condition_abbr in CONDITION_MAP else None
                else:
                    foil_kind = "NONFOIL"

                sales.append({
                    "date": date,
                    "condition": condition,
                    "foil_kind": foil_kind,
                    "quantity": int(quantity),
                    "price": float(price.replace("$", "").replace(",", ""))
                })

            browser.close()

    except Exception as e:
        _log_error(url, e, debug)

        print(
            f"Fetch Error | "
            f"url={url} | "
            f"{e}"
        )

        return None

    if debug:
        print(
            f"Fetched sales | "
            f"url={url} | "
            f"count={len(sales)}"
        )

    return sales


def fetch_listings(url: str, debug: bool = False) -> list[dict] | None:
    from api_ga import _log_error

    base_url = url.split("?")[0]

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            page = browser.new_page()
            page.goto(url)
            page.wait_for_load_state("networkidle")

            # Page-number buttons are the only role="link" buttons whose visible
            # text is a bare number — "tcg-standard-button" itself is too generic
            # (Add to Cart, Filter Sales, etc. all share it) to scope to directly.
            page_number_texts = page.locator("a[role='link'] .tcg-standard-button__content").all_inner_texts()
            page_numbers = [int(t.strip()) for t in page_number_texts if t.strip().isdigit()]
            total_pages = max(page_numbers) if page_numbers else 1

            listings = []

            for page_num in range(1, total_pages + 1):
                if page_num > 1:
                    page.goto(f"{base_url}?page={page_num}")
                    page.wait_for_load_state("networkidle")

                rows = page.locator(".listing-item")

                for i in range(rows.count()):
                    row = rows.nth(i)

                    condition = row.locator(".listing-item__condition").inner_text().strip()
                    price = row.locator(".listing-item__listing-data__info__price").inner_text().strip()
                    available = row.locator(".add-to-cart__available").inner_text().strip()
                    quantity = int(available.replace("of", "").strip())

                    listings.append({
                        "date": date.today().isoformat(),
                        "condition": condition,
                        "quantity": quantity,
                        "price": float(price.replace("$", "").replace(",", ""))
                    })

            browser.close()

    except Exception as e:
        _log_error(url, e, debug)

        print(
            f"Fetch Error | "
            f"url={url} | "
            f"{e}"
        )

        return None

    if debug:
        print(
            f"Fetched listings | "
            f"url={url} | "
            f"pages={total_pages} | "
            f"count={len(listings)}"
        )

    return listings


def prompt_product_id(edition_id: str, debug: bool = False) -> str:
    product_id = get_product_id(edition_id)

    if not product_id:
        product_id = input("Enter TCGPlayer product ID: ").strip()
        _set_product_id(edition_id, product_id, debug)

    return product_id

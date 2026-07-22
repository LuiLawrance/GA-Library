from playwright.sync_api import sync_playwright
from util_file import new_json

import json

BASE_URL = "https://www.tcgplayer.com/product/"

JSON_IDS = "DATA_GA/PRICING_GA/ID_TCGPLAYER.json"


def _build_url(product_id: str, page: int = 1) -> str:
    return f"{BASE_URL}{product_id}?page={page}"


def _get_product_id(edition_id: str) -> str | None:
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    return ids_data.get(edition_id)


def _set_product_id(edition_id: str, product_id: str, debug: bool = False) -> None:
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    ids_data[edition_id] = product_id

    with ids_file.open("w", encoding="utf-8") as f:
        json.dump(ids_data, f, indent=4)

    if debug:
        print(
            f"Updated ID_TCGPLAYER.json | "
            f"edition_id={edition_id} | "
            f"product_id={product_id}"
        )


def fetch_sales(url: str, debug: bool = False) -> list[dict]:
    from api_ga import _log_error

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            page = browser.new_page()
            page.goto(url)
            page.wait_for_load_state("networkidle")

            page.get_by_text("View More Data").first.click()
            page.wait_for_load_state("networkidle")

            rows = page.locator(".latest-sales-table__tbody tr")
            sales = []

            for i in range(rows.count()):
                row = rows.nth(i)

                date = row.locator(".latest-sales-table__tbody__date").inner_text().strip()
                quantity = row.locator(".latest-sales-table__tbody_quantity").inner_text().strip()
                price = row.locator(".latest-sales-table__tbody__price").inner_text().strip()

                sales.append({
                    "date": date,
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

        return []

    if debug:
        print(
            f"Fetched sales | "
            f"url={url} | "
            f"count={len(sales)}"
        )

    return sales


def prompt_product_id(edition_id: str, debug: bool = False) -> str:
    product_id = _get_product_id(edition_id)

    if not product_id:
        product_id = input("Enter TCGPlayer product ID: ").strip()
        _set_product_id(edition_id, product_id, debug)

    return product_id

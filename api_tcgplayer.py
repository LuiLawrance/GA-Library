from datetime import date
from playwright.sync_api import sync_playwright
from util_file import new_json

import json
import re
import urllib.parse

BASE_URL = "https://www.tcgplayer.com/product/"
SEARCH_URL = "https://www.tcgplayer.com/search/grand-archive/product"

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


def _get_ids_field(edition_id: str, field: str) -> str | None:
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    return ids_data.get(edition_id, {}).get(field)


def get_all_ids() -> dict:
    """Reads the whole ID_TCGPLAYER.json store in one go, for callers building
    a view across many editions (e.g. the admin product-ID list) — avoids
    re-opening and re-parsing the file once per edition per field the way
    get_product_id()/get_last_sales()/get_last_listings() do when called
    individually in a loop."""
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def _set_ids_field(edition_id: str, field: str, value: str, debug: bool = False) -> None:
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    ids_data.setdefault(edition_id, {})[field] = value

    with ids_file.open("w", encoding="utf-8") as f:
        json.dump(ids_data, f, indent=4)

    if debug:
        print(
            f"Updated ID_TCGPLAYER.json | "
            f"edition_id={edition_id} | "
            f"{field}={value}"
        )


def get_last_sales(edition_id: str) -> str | None:
    return _get_ids_field(edition_id, "last_sales")


def set_last_sales(edition_id: str, debug: bool = False) -> None:
    _set_ids_field(edition_id, "last_sales", date.today().isoformat(), debug)


def get_last_listings(edition_id: str) -> str | None:
    return _get_ids_field(edition_id, "last_listings")


def set_last_listings(edition_id: str, debug: bool = False) -> None:
    _set_ids_field(edition_id, "last_listings", date.today().isoformat(), debug)


def get_product_id(edition_id: str) -> str | None:
    return _get_ids_field(edition_id, "product_id")


def set_product_id(edition_id: str, product_id: str, debug: bool = False) -> None:
    _set_ids_field(edition_id, "product_id", product_id, debug)


def _open_sales_popup(page) -> None:
    """Clicks 'View More Data' to open the sales popup on the currently-loaded
    product page. Caller must have already navigated there."""
    page.get_by_text("View More Data").first.click()
    page.wait_for_load_state("networkidle")


def _parse_sales_rows(page, url: str, debug: bool = False) -> list[dict]:
    """Parses the sales popup rows on the currently-loaded page. Caller must
    have already opened the popup via _open_sales_popup()."""
    if page.get_by_text("No sales data available").count() > 0:
        if debug:
            print(f"No sales data available | url={url}")

        return []

    rows = page.locator(".latest-sales-table__tbody tr")
    sales = []

    for i in range(rows.count()):
        row = rows.nth(i)

        sale_date = row.locator(".latest-sales-table__tbody__date").inner_text().strip()
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
            "date": sale_date,
            "condition": condition,
            "foil_kind": foil_kind,
            "quantity": int(quantity),
            "price": float(price.replace("$", "").replace(",", ""))
        })

    if debug:
        print(
            f"Fetched sales | "
            f"url={url} | "
            f"count={len(sales)}"
        )

    return sales


def _scrape_sales_page(page, url: str, debug: bool = False) -> list[dict]:
    """Runs the sales scrape against an already-open Playwright page. Caller
    owns the browser/page lifecycle."""
    page.goto(url)
    page.wait_for_load_state("networkidle")

    _open_sales_popup(page)

    return _parse_sales_rows(page, url, debug)


def _listing_page_count(page) -> int:
    """Reads the highest page number shown on the currently-loaded listings
    page. Page-number buttons are the only role="link" buttons whose visible
    text is a bare number — "tcg-standard-button" itself is too generic
    (Add to Cart, Filter Sales, etc. all share it) to scope to directly."""
    page_number_texts = page.locator("a[role='link'] .tcg-standard-button__content").all_inner_texts()
    page_numbers = [int(t.strip()) for t in page_number_texts if t.strip().isdigit()]
    return max(page_numbers) if page_numbers else 1


def _parse_listing_rows(page) -> list[dict]:
    """Parses the listing rows on the currently-loaded listings page."""
    condition_names = set(CONDITION_MAP.values())
    rows = page.locator(".listing-item")
    listings = []

    for i in range(rows.count()):
        row = rows.nth(i)

        condition = row.locator(".listing-item__condition").inner_text().strip()
        price = row.locator(".listing-item__listing-data__info__price").inner_text().strip()
        available = row.locator(".add-to-cart__available").inner_text().strip()
        quantity = int(available.replace("of", "").strip())

        # Listings already show the full condition name (e.g. "Near Mint"),
        # unlike the sales popup's abbreviations, so no CONDITION_MAP lookup
        # is needed here — just the same Foil-suffix classification.
        is_foil = condition.endswith(" Foil")
        base_condition = condition.removesuffix(" Foil") if is_foil else condition

        if is_foil:
            foil_kind = "FOIL" if base_condition in condition_names else None
        else:
            foil_kind = "NONFOIL"

        listings.append({
            "date": date.today().isoformat(),
            "condition": condition,
            "foil_kind": foil_kind,
            "quantity": quantity,
            "price": float(price.replace("$", "").replace(",", ""))
        })

    return listings


def _scrape_listings_page(page, url: str, debug: bool = False) -> list[dict]:
    """Runs the listings scrape against an already-open Playwright page. Caller
    owns the browser/page lifecycle."""
    base_url = url.split("?")[0]

    page.goto(url)
    page.wait_for_load_state("networkidle")

    total_pages = _listing_page_count(page)
    listings = _parse_listing_rows(page)

    for page_num in range(2, total_pages + 1):
        page.goto(f"{base_url}?page={page_num}")
        page.wait_for_load_state("networkidle")
        listings.extend(_parse_listing_rows(page))

    if debug:
        print(
            f"Fetched listings | "
            f"url={url} | "
            f"pages={total_pages} | "
            f"count={len(listings)}"
        )

    return listings


def fetch_sales(url: str, debug: bool = False, headless: bool = False, page=None) -> list[dict] | None:
    """If `page` is given, scrapes against it directly and leaves its browser
    lifecycle to the caller (used when batching many editions through one
    shared browser). Otherwise opens and closes its own browser as before."""
    from api_ga import _log_error

    if page is not None:
        try:
            return _scrape_sales_page(page, url, debug)
        except Exception as e:
            _log_error(url, e, debug)
            print(f"Fetch Error | url={url} | {e}")
            return None

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless)
            owned_page = browser.new_page()
            sales = _scrape_sales_page(owned_page, url, debug)
            browser.close()

    except Exception as e:
        _log_error(url, e, debug)

        print(
            f"Fetch Error | "
            f"url={url} | "
            f"{e}"
        )

        return None

    return sales


def fetch_listings(url: str, debug: bool = False, headless: bool = False, page=None) -> list[dict] | None:
    """If `page` is given, scrapes against it directly and leaves its browser
    lifecycle to the caller (used when batching many editions through one
    shared browser). Otherwise opens and closes its own browser as before."""
    from api_ga import _log_error

    if page is not None:
        try:
            return _scrape_listings_page(page, url, debug)
        except Exception as e:
            _log_error(url, e, debug)
            print(f"Fetch Error | url={url} | {e}")
            return None

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless)
            owned_page = browser.new_page()
            listings = _scrape_listings_page(owned_page, url, debug)
            browser.close()

    except Exception as e:
        _log_error(url, e, debug)

        print(
            f"Fetch Error | "
            f"url={url} | "
            f"{e}"
        )

        return None

    return listings


def _scrape_sales_and_listings_page(page, url: str, debug: bool, want_sales: bool,
                                     want_listings: bool) -> tuple[list[dict] | None, list[dict] | None]:
    """Scrapes sales and/or listings against an already-open Playwright page.
    When both are wanted, page 1 is visited once: its listings are read, then
    the sales popup is opened on that same load, before moving on to any
    further listing pages — instead of visiting page 1 separately for each."""
    from api_ga import _log_error

    base_url = url.split("?")[0]
    sales = None
    listings = None
    total_pages = 1
    page1_loaded = False

    if want_listings:
        try:
            page.goto(url)
            page.wait_for_load_state("networkidle")
            page1_loaded = True
            total_pages = _listing_page_count(page)
            listings = _parse_listing_rows(page)
        except Exception as e:
            _log_error(url, e, debug)
            print(f"Fetch Error (listings) | url={url} | {e}")

    if want_sales:
        try:
            if not page1_loaded:
                page.goto(url)
                page.wait_for_load_state("networkidle")

            _open_sales_popup(page)
            sales = _parse_sales_rows(page, url, debug)
        except Exception as e:
            _log_error(url, e, debug)
            print(f"Fetch Error (sales) | url={url} | {e}")

    if want_listings and listings is not None and total_pages > 1:
        try:
            for page_num in range(2, total_pages + 1):
                page.goto(f"{base_url}?page={page_num}")
                page.wait_for_load_state("networkidle")
                listings.extend(_parse_listing_rows(page))
        except Exception as e:
            _log_error(url, e, debug)
            print(f"Fetch Error (listings) | url={url} | {e}")

    if debug and listings is not None:
        print(
            f"Fetched listings | "
            f"url={url} | "
            f"pages={total_pages} | "
            f"count={len(listings)}"
        )

    return sales, listings


def fetch_sales_and_listings(url: str, debug: bool = False, headless: bool = False,
                              want_sales: bool = True, want_listings: bool = True, page=None
                              ) -> tuple[list[dict] | None, list[dict] | None]:
    """Scrapes sales and/or listings for the same product URL using a single
    shared browser session, instead of opening and closing a separate browser
    for each. If `page` is given, scrapes against it directly and leaves its
    browser lifecycle to the caller (used when batching many editions through
    one shared browser)."""
    from api_ga import _log_error

    if page is not None:
        return _scrape_sales_and_listings_page(page, url, debug, want_sales, want_listings)

    sales = listings = None

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless)
            owned_page = browser.new_page()
            sales, listings = _scrape_sales_and_listings_page(owned_page, url, debug, want_sales, want_listings)
            browser.close()

    except Exception as e:
        _log_error(url, e, debug)
        print(f"Fetch Error | url={url} | {e}")

    return sales, listings


def _search_product_id_page(page, card_name: str, collector_number: str, set_name: str = "",
                             debug: bool = False) -> str | None:
    """Runs a TCGPlayer product search for `card_name` and picks the result
    whose collector number matches. Collector number alone isn't a safe
    disambiguator — different sets reuse the same number (e.g. "Dawn of Ashes
    1st Edition #081" and "Dawn of Ashes Alter Edition #081" are different
    cards) — so when more than one candidate shares the number, `set_name` is
    used as a fuzzy tiebreaker, since TCGPlayer's set names don't always match
    our own wording exactly (e.g. "1st Edition" vs our "First Edition")."""
    from rapidfuzz import fuzz

    url = f"{SEARCH_URL}?q={urllib.parse.quote(card_name)}&productLineName=grand-archive"
    page.goto(url)
    page.wait_for_load_state("networkidle")

    target_num = collector_number.strip().upper().lstrip("#")
    target_name = card_name.strip().lower()

    results = page.locator(".product-card__content")
    candidates = []  # (product_id, tcg_set_name)

    for i in range(results.count()):
        result = results.nth(i)

        title = result.locator(".product-card__title").inner_text().strip()
        if not title.lower().startswith(target_name):
            continue

        rarity_text = result.locator(".product-card__rarity__variant").inner_text().strip()
        num_match = re.search(r"#(\S+)", rarity_text)
        if not num_match or num_match.group(1).upper() != target_num:
            continue

        href = result.locator("a[href*='/product/']").first.get_attribute("href") or ""
        pid_match = re.search(r"/product/(\d+)", href)
        if not pid_match:
            continue

        tcg_set_name = result.locator(".product-card__set-name__variant").inner_text().strip()
        candidates.append((pid_match.group(1), tcg_set_name))

    if debug:
        print(f"Product ID search | name={card_name} | num={collector_number} | candidates={candidates}")

    if len(candidates) == 1:
        return candidates[0][0]

    if len(candidates) > 1 and set_name:
        scored = sorted(
            ((fuzz.token_sort_ratio(set_name.lower(), tcg_set.lower()), pid, tcg_set) for pid, tcg_set in candidates),
            key=lambda t: t[0], reverse=True
        )

        if debug:
            print(f"Product ID disambiguation | set_name={set_name} | scored={scored}")

        best_score = scored[0][0]
        if best_score >= 60 and (len(scored) == 1 or scored[1][0] < best_score):
            return scored[0][1]

    return None


def find_product_id(card_name: str, collector_number: str, set_name: str = "", debug: bool = False,
                     headless: bool = False, page=None) -> str | None:
    """If `page` is given, searches against it directly and leaves its browser
    lifecycle to the caller (used when batching many editions through one
    shared browser). Otherwise opens and closes its own browser as before."""
    from api_ga import _log_error

    if page is not None:
        try:
            return _search_product_id_page(page, card_name, collector_number, set_name, debug)
        except Exception as e:
            _log_error(SEARCH_URL, e, debug)
            print(f"Fetch Error | url={SEARCH_URL} | {e}")
            return None

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless)
            owned_page = browser.new_page()
            result = _search_product_id_page(owned_page, card_name, collector_number, set_name, debug)
            browser.close()

    except Exception as e:
        _log_error(SEARCH_URL, e, debug)
        print(f"Fetch Error | url={SEARCH_URL} | {e}")
        return None

    return result


def prompt_product_id(edition_id: str, debug: bool = False) -> str:
    product_id = get_product_id(edition_id)

    if not product_id:
        product_id = input("Enter TCGPlayer product ID: ").strip()
        set_product_id(edition_id, product_id, debug)

    return product_id

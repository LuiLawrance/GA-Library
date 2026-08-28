from datetime import date
from db.models import Edition, FoilTcgOverride
from db.session import get_session
from db_mode import is_db_mode
from playwright.sync_api import sync_playwright
from sqlalchemy import or_, select
from util_file import new_json

import json
import re
import requests
import urllib.parse

BASE_URL = "https://www.tcgplayer.com/product/"
SEARCH_URL = "https://www.tcgplayer.com/search/grand-archive/product"

# tcgcsv.com mirrors TCGPlayer's own official API — given a game's category ID
# (74 is Grand Archive, same ID TCGPlayer itself uses) and a set's Group ID
# (admin-entered per set, see api_admin_set_group_id in app.py), this lists
# every product TCGPlayer has for that set in one JSON call: regular editions
# and Curio Foil variants alike, each with the numeric productId our own
# product IDs are keyed by. See fetch_tcgcsv_products below.
TCGCSV_CATEGORY_ID = 74
TCGCSV_PRODUCTS_URL = "https://tcgcsv.com/tcgplayer/{category_id}/{group_id}/products"

# tcgcsv.com blocks requests with no identifying User-Agent (see
# https://tcgcsv.com/docs#usage-guidelines) — requests' own default UA gets a
# blanket 401 regardless of credentials, so this has to be set explicitly.
TCGCSV_USER_AGENT = "GA-Library/1.0"

JSON_IDS = "DATA_GA/PRICING_GA/ID_TCGPLAYER.json"

# Admins enter this as the product ID for cards confirmed to have no
# TCGPlayer listings at all, instead of leaving it blank — it marks the
# absence as deliberate rather than "not yet looked up". Scrape entry points
# must treat it exactly like a missing product ID: no product page exists to
# open a browser and navigate to.
NO_LISTINGS_SENTINEL = "~"

CONDITION_MAP = {
    "NM": "Near Mint",
    "LP": "Lightly Played",
    "MP": "Moderately Played",
    "HP": "Heavily Played",
    "DMG": "Damaged"
}


def _build_url(product_id: str, page: int = 1) -> str:
    return f"{BASE_URL}{product_id}?page={page}"


# Scope note (Stage 6 of the migration plan): only these READS branch on
# local_database — get_all_ids/get_product_id/get_last_sales/etc. and their
# foil-scoped counterparts below. Every WRITE in this file (_set_ids_field,
# import_ids, set_product_id, clear_last_sales, ...) always writes JSON,
# same as the card-catalog sync functions in api_ga.py. That means a getter
# in DB mode can read a value slightly staler than what a write just put in
# JSON (e.g. the 7-day listings-refresh gate, which reads via
# get_last_listings/get_foil_last_listings, might under-throttle until the
# next scripts/migrate_json_to_pg.py run) — the same staleness trade-off
# already accepted for the card catalog, not a new one.

def _get_ids_field(edition_id: str, field: str) -> str | None:
    if is_db_mode():
        with get_session() as session:
            edition = session.get(Edition, edition_id)

            if edition is None:
                return None

            if field == "product_id":
                return NO_LISTINGS_SENTINEL if edition.tcg_is_no_listings else edition.tcg_product_id
            if field == "last_sales":
                return edition.tcg_last_sales.isoformat() if edition.tcg_last_sales else None
            if field == "last_listings":
                return edition.tcg_last_listings.isoformat() if edition.tcg_last_listings else None

            return None

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
    if is_db_mode():
        with get_session() as session:
            editions = session.execute(
                select(Edition).where(or_(
                    Edition.tcg_product_id.isnot(None), Edition.tcg_is_no_listings,
                    Edition.tcg_last_sales.isnot(None), Edition.tcg_last_listings.isnot(None),
                ))
            ).scalars().all()
            overrides = session.execute(select(FoilTcgOverride)).scalars().all()

        result = {}

        for edition in editions:
            entry = {
                "product_id": NO_LISTINGS_SENTINEL if edition.tcg_is_no_listings else edition.tcg_product_id,
            }
            if edition.tcg_last_sales:
                entry["last_sales"] = edition.tcg_last_sales.isoformat()
            if edition.tcg_last_listings:
                entry["last_listings"] = edition.tcg_last_listings.isoformat()
            result[edition.edition_id] = entry

        for override in overrides:
            entry = {
                "product_id": NO_LISTINGS_SENTINEL if override.is_no_listings else override.product_id,
            }
            if override.last_sales:
                entry["last_sales"] = override.last_sales.isoformat()
            if override.last_listings:
                entry["last_listings"] = override.last_listings.isoformat()
            result.setdefault(override.edition_id, {}).setdefault("foils", {})[override.foil_id] = entry

        return result

    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def import_ids(import_data: dict) -> dict:
    """Backfills ID_TCGPLAYER.json from a JSON blob shaped exactly like the
    file itself — the admin console's Import Product IDs button, for
    reloading product IDs after a local hard reset wipes this file (sales/
    listings data and the rest of DATA_GA aren't part of it; this only ever
    restores product_id mappings), or more generally for re-merging any
    prior export back in.

    Deliberately narrow, on request: only ADDS a product_id where the
    edition (or foil override) doesn't already have one — an already-stored
    ID is never overwritten, so re-running the same import twice (or
    importing an old export over a newer store) can't clobber anything
    entered since; that's the only duplicate-safety this needs, so an
    edition_id doesn't have to already exist elsewhere (e.g. in
    EDITIONS.json) to be imported here — creates a fresh entry for one that
    isn't in the current store at all, same as backfilling one that already
    has a partial entry. last_sales/last_listings are never read from
    import_data at all, even if present in it — those clocks should start
    fresh rather than carry over dates from before whatever prompted the
    import, which would otherwise misrepresent data that may not exist
    locally as already scraped.

    Single bulk read + write regardless of how many editions are in
    import_data, matching get_all_ids()'s reasoning above — not one file
    round-trip per edition via _set_ids_field/_set_foil_ids_field."""
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        current = json.load(f)

    added_main = 0
    added_foil = 0

    for edition_id, entry in import_data.items():
        if not isinstance(entry, dict):
            continue

        current_entry = current.setdefault(edition_id, {})

        product_id = entry.get("product_id")
        if product_id and not current_entry.get("product_id"):
            current_entry["product_id"] = product_id
            added_main += 1

        for foil_id, foil_entry in (entry.get("foils") or {}).items():
            if not isinstance(foil_entry, dict):
                continue

            foil_product_id = foil_entry.get("product_id")
            if not foil_product_id:
                continue

            current_foils = current_entry.setdefault("foils", {})
            current_foil_entry = current_foils.setdefault(foil_id, {})

            if not current_foil_entry.get("product_id"):
                current_foil_entry["product_id"] = foil_product_id
                added_foil += 1

    with ids_file.open("w", encoding="utf-8") as f:
        json.dump(current, f, indent=4)

    return {"added_main": added_main, "added_foil": added_foil}


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


def clear_last_sales(edition_id: str, debug: bool = False) -> None:
    """Resets last_sales back to never-scraped — lets an admin force past the
    "recently updated" state (e.g. to immediately re-run Refresh Sales)
    without waiting it out, from the admin console's Last Sales badge."""
    _set_ids_field(edition_id, "last_sales", None, debug)


def clear_last_listings(edition_id: str, debug: bool = False) -> None:
    """Listings counterpart to clear_last_sales() — also lifts the 7-day
    listings-refresh gate (_listings_gate_result), since that's keyed off
    this same field."""
    _set_ids_field(edition_id, "last_listings", None, debug)


def get_product_id(edition_id: str) -> str | None:
    return _get_ids_field(edition_id, "product_id")


def set_product_id(edition_id: str, product_id: str, debug: bool = False) -> None:
    _set_ids_field(edition_id, "product_id", product_id, debug)


def clear_product_id(edition_id: str, debug: bool = False) -> None:
    """Resets edition_id's own product_id back to unset — e.g. an admin
    wiping a bad match (mismatched tcgcsv sync, stale Playwright auto-detect,
    manual typo) so it can be rechecked from scratch. Leaves
    last_sales/last_listings untouched, same as clear_last_sales/
    clear_last_listings leave product_id untouched — they're independent
    clocks, not tied to each other."""
    _set_ids_field(edition_id, "product_id", None, debug)


# ── Foil-scoped overrides ──
# A card's regular nonfoil + foil printings share the edition-level fields
# above, but some cards also have a special foil variant (TCGPlayer's "Curio
# Foil" umbrella — Aurora/Interference/Fractured Curio Foil, Quicksilver
# Foil, etc., named differently per set) that TCGPlayer lists under its own,
# separate product page. These mirror the edition-level get/set functions
# exactly, just nested one level under "foils" in the same JSON store, and
# are absent entirely for the vast majority of editions that have no such
# variant.

def _get_foil_ids_field(edition_id: str, foil_id: str, field: str) -> str | None:
    if is_db_mode():
        with get_session() as session:
            override = session.get(FoilTcgOverride, (edition_id, foil_id))

            if override is None:
                return None

            if field == "product_id":
                return NO_LISTINGS_SENTINEL if override.is_no_listings else override.product_id
            if field == "last_sales":
                return override.last_sales.isoformat() if override.last_sales else None
            if field == "last_listings":
                return override.last_listings.isoformat() if override.last_listings else None

            return None

    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    return ids_data.get(edition_id, {}).get("foils", {}).get(foil_id, {}).get(field)


def _set_foil_ids_field(edition_id: str, foil_id: str, field: str, value: str, debug: bool = False) -> None:
    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    ids_data.setdefault(edition_id, {}).setdefault("foils", {}).setdefault(foil_id, {})[field] = value

    with ids_file.open("w", encoding="utf-8") as f:
        json.dump(ids_data, f, indent=4)

    if debug:
        print(
            f"Updated ID_TCGPLAYER.json | "
            f"edition_id={edition_id} | "
            f"foil_id={foil_id} | "
            f"{field}={value}"
        )


def get_foil_overrides(edition_id: str) -> dict:
    """edition_id's foil-level overrides ({foil_id: {product_id, last_sales,
    last_listings}}), or {} if it has none."""
    if is_db_mode():
        with get_session() as session:
            overrides = session.execute(
                select(FoilTcgOverride).where(FoilTcgOverride.edition_id == edition_id)
            ).scalars().all()

        result = {}
        for override in overrides:
            entry = {"product_id": NO_LISTINGS_SENTINEL if override.is_no_listings else override.product_id}
            if override.last_sales:
                entry["last_sales"] = override.last_sales.isoformat()
            if override.last_listings:
                entry["last_listings"] = override.last_listings.isoformat()
            result[override.foil_id] = entry
        return result

    ids_file = new_json(JSON_IDS)

    with ids_file.open("r", encoding="utf-8") as f:
        ids_data = json.load(f)

    return ids_data.get(edition_id, {}).get("foils", {})


def get_foil_last_sales(edition_id: str, foil_id: str) -> str | None:
    return _get_foil_ids_field(edition_id, foil_id, "last_sales")


def set_foil_last_sales(edition_id: str, foil_id: str, debug: bool = False) -> None:
    _set_foil_ids_field(edition_id, foil_id, "last_sales", date.today().isoformat(), debug)


def get_foil_last_listings(edition_id: str, foil_id: str) -> str | None:
    return _get_foil_ids_field(edition_id, foil_id, "last_listings")


def set_foil_last_listings(edition_id: str, foil_id: str, debug: bool = False) -> None:
    _set_foil_ids_field(edition_id, foil_id, "last_listings", date.today().isoformat(), debug)


def clear_foil_last_sales(edition_id: str, foil_id: str, debug: bool = False) -> None:
    """Foil-scoped counterpart to clear_last_sales() — e.g. resets a Curio
    Foil's own separate clock without touching the edition's main one."""
    _set_foil_ids_field(edition_id, foil_id, "last_sales", None, debug)


def clear_foil_last_listings(edition_id: str, foil_id: str, debug: bool = False) -> None:
    _set_foil_ids_field(edition_id, foil_id, "last_listings", None, debug)


def get_foil_product_id(edition_id: str, foil_id: str) -> str | None:
    return _get_foil_ids_field(edition_id, foil_id, "product_id")


def set_foil_product_id(edition_id: str, foil_id: str, product_id: str, debug: bool = False) -> None:
    _set_foil_ids_field(edition_id, foil_id, "product_id", product_id, debug)


def clear_foil_product_id(edition_id: str, foil_id: str, debug: bool = False) -> None:
    """Foil-scoped counterpart to clear_product_id() — e.g. resets a Curio
    Foil's own separate product_id without touching the edition's main one."""
    _set_foil_ids_field(edition_id, foil_id, "product_id", None, debug)


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


def _goto_product_page(page, url: str) -> None:
    """Navigates to a product's page 1 URL and waits until the browser has
    actually landed on it. Batch scrapes reuse one Playwright page across many
    products in sequence (including a Curio Foil override right after its
    edition's main product) — networkidle can fire while TCGPlayer's page is
    still showing the PREVIOUS product's content (its listing/sales data
    loads via a client-side fetch after the initial navigation settles), so a
    parse immediately after goto() can silently read stale data from whatever
    was open before. Confirming the product ID is actually in page.url first
    (retrying the navigation once if not) catches that before it happens,
    rather than only self-correcting once a later page.goto() (e.g. page 2)
    gives the fetch enough time to catch up."""
    product_id = url.removeprefix(BASE_URL).split("?")[0]

    for attempt in range(2):
        page.goto(url)
        page.wait_for_load_state("networkidle")

        if product_id in page.url:
            return

    # Last resort: give the client-side fetch a little longer to catch up
    # rather than parsing whatever's on screen right now.
    page.wait_for_timeout(1500)


def _scrape_sales_page(page, url: str, debug: bool = False) -> list[dict]:
    """Runs the sales scrape against an already-open Playwright page. Caller
    owns the browser/page lifecycle."""
    _goto_product_page(page, url)

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

    _goto_product_page(page, url)

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
            _goto_product_page(page, url)
            page1_loaded = True
            total_pages = _listing_page_count(page)
            listings = _parse_listing_rows(page)
        except Exception as e:
            _log_error(url, e, debug)
            print(f"Fetch Error (listings) | url={url} | {e}")

    if want_sales:
        try:
            if not page1_loaded:
                _goto_product_page(page, url)

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


def fetch_tcgcsv_products(group_id: str, debug: bool = False) -> list[dict]:
    """Every product tcgcsv.com has recorded under a set's Group ID — one
    entry per product, main editions and Curio Foil variants alike (a Curio
    Foil's own `name` has "Curio Foil" in it somewhere — TCGPlayer doesn't
    keep the exact phrasing consistent between sets, e.g. Asphodel Paradise's
    are "(Interference Curio Foil)" rather than plain "(Curio Foil)"; there's
    no separate flag for it either way).
    Each entry's `extendedData` list carries a "Number" field matching our own
    collector_number, and `productId` is the numeric TCGPlayer product ID —
    together enough to match against local editions without the per-card
    Playwright search find_product_id() falls back to."""
    url = TCGCSV_PRODUCTS_URL.format(category_id=TCGCSV_CATEGORY_ID, group_id=group_id)
    response = requests.get(url, headers={"User-Agent": TCGCSV_USER_AGENT}, timeout=15)
    response.raise_for_status()

    data = response.json()
    if not data.get("success"):
        raise ValueError(f"tcgcsv.com reported failure for group {group_id}: {data.get('errors')}")

    results = data.get("results", [])

    if debug:
        print(f"tcgcsv fetch | group_id={group_id} | products={len(results)}")

    return results


def prompt_product_id(edition_id: str, debug: bool = False) -> str:
    product_id = get_product_id(edition_id)

    if not product_id:
        product_id = input("Enter TCGPlayer product ID: ").strip()
        set_product_id(edition_id, product_id, debug)

    return product_id

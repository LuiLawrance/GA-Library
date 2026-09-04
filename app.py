from api_ga import _api_search, _build_collector_map, _download_card_image, _download_set_image, \
    _format_search, _group_slug, _sort_collector_number, _update_slug, API_HOST, API_IMAGE, card_reset, \
    DIR_SETS, JSON_SET_SEARCHES, load_all_set_collector_data, load_card_detail_data, load_editions_data, \
    load_featured_sets_data, load_info_data, load_set_collector_data, load_set_names, load_set_searches_data, \
    load_slugs_data, load_thema_for_editions, load_update_data, mark_set_searched, set_group_id, set_search, \
    sync_featured_sets, UPDATE_THRESHOLD
from api_tcgplayer import clear_foil_last_scraped, clear_last_scraped, MARKETPLACES, \
    NO_LISTINGS_SENTINEL, get_all_ids, get_foil_last_scraped_map, get_foil_overrides, get_last_scraped_map, \
    set_foil_product_id, set_product_id
from datetime import date, datetime, timedelta, timezone
from db.connection_url import compose as compose_database_url, parse as parse_database_url
from db.models import Deck, DeckCard, DeckSection, InventoryBin, InventoryCard, InventorySection, User
from db.session import get_session, reset_engine
from db_connection import resolved_database_url, save_database_url
from db_mode import is_db_mode
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from pricing_ga import RARITY_MAP, _foil_kind_for_id, add_manual_entry, \
    clear_product_ids_for_set, delete_entry, find_product_ids_by_editions, import_gal_pricing, \
    import_pasted_sales_tcg_by_edition, import_product_ids_from_tcgcsv, load_listings_data, \
    load_price_data_for_card, load_sales_data, scrape_batch_tcg_by_editions, scrape_listings_tcg_by_edition, \
    scrape_sales_and_listings_tcg_by_edition, scrape_sales_tcg_by_edition
from rapidfuzz import fuzz, process
from settings import load_settings, save_settings, SETTINGS_DEFAULTS
from sqlalchemy import create_engine, delete, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from user import (
    RANK_ORDER,
    user_admin_reset_omnidex,
    user_admin_reset_password,
    user_create,
    user_delete,
    user_find_by_omnidex,
    user_get_auth_type,
    user_get_id,
    user_get_profile,
    user_list,
    user_login,
    user_needs_setup,
    user_reset,
    user_set_admin_note,
    user_set_bio,
    user_set_omnidex_id,
    user_set_role,
)
from util_file import new_json
from watchlist_ga import watchlist_add, watchlist_list, watchlist_remove

import asyncio
import contextlib
import db_cache
import io
import json
import os
import random
import re
import requests
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

load_dotenv(".env" if os.path.exists(".env") else "env")

SECRET_KEY = os.getenv("SECRET_KEY")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", 480))

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/elements", StaticFiles(directory="assets/GA_ELEMENTS"), name="elements")
app.mount("/marketplaces", StaticFiles(directory="assets/MARKETPLACES"), name="marketplaces")

# Which sets have already been set-searched (see set_search in api_ga.py) and
# when, keyed by the same slug _set_slug() there derives a set's own
# DATA_GA/SETS_GA/*.json filename from — set_filter below computes the same
# transformation inline rather than importing that private helper. Loaded
# from JSON_SET_SEARCHES once at startup so this survives a server restart
# (a bare in-memory dict here previously didn't); api_sets_search_start
# re-persists it on every write, and GET /api/admin/set-searches (further
# down) exposes it read-only for the Admin Cards Info panel's per-set
# "already searched" indicator.
#
# JSON mode only: in DB mode last_searched / tcgplayer_group_id live on the
# sets table instead (api_ga.load_set_searches_data / set_group_id /
# mark_set_searched), and the readers/writers below branch on is_db_mode()
# so this dict is loaded-but-unused there.
with new_json(JSON_SET_SEARCHES).open(encoding="utf-8") as f:
    _set_search_cache = json.load(f)

# Back-compat: older SET_SEARCHES.json entries are bare ISO-date strings (just
# the "last set-searched" date) — normalize to dicts so a set can also carry
# tcgplayer_group_id (see api_admin_set_group_id) without needing a separate
# file or a one-off migration script.
_set_search_cache = {
    slug: ({"last_searched": entry} if isinstance(entry, str) else entry)
    for slug, entry in _set_search_cache.items()
}

# ── Set search background jobs ──
# job_id → {status: "running"|"done"|"error", done, total, current_card, error, set_prefix}
_set_search_jobs = {}
_set_search_jobs_lock = threading.Lock()

# ── Pricing refresh background jobs (admin-only) ──
# job_id → {status: "running"|"done"|"error", edition_id, sales: {...}|None, listings: {...}|None, error}
_pricing_jobs = {}
_pricing_jobs_lock = threading.Lock()

# ── Pricing refresh BATCH jobs (admin-only) — one shared browser across many editions ──
# job_id → {status, target, total, done, current_edition_id, results: {edition_id: {sales, listings}}, error}
_pricing_batch_jobs = {}
_pricing_batch_jobs_lock = threading.Lock()

# ── Product ID auto-detect jobs (admin-only) — one shared browser across many editions ──
# job_id → {status, total, done, current_edition_id, results: {edition_id: {ok, product_id, error}}, error}
_product_id_jobs = {}
_product_id_jobs_lock = threading.Lock()

# ── JSON -> Postgres sync jobs (admin-only, System panel's Sync button) ──
# job_id → {status: "running"|"done"|"error", ok, log, error}
_sync_jobs = {}
_sync_jobs_lock = threading.Lock()


def create_token(username: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)

    payload = {
        "sub": username,
        "exp": expire
    }

    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)


def get_current_user(request: Request) -> str | None:
    token = request.cookies.get("token")

    if not token:
        return None

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return payload.get("sub")

    except JWTError:
        return None


def get_user_auth_type(username: str) -> str | None:
    return user_get_auth_type(username)


# Ranks that can reach the admin console at all. Finer-grained permissions
# between these three (e.g. what a moderator can't do that an admin can)
# aren't split out yet — for now they get equal access once inside.
ADMIN_CONSOLE_RANKS = {"owner", "admin", "moderator"}


def require_admin(request: Request) -> str:
    user = get_current_user(request)

    if not user or get_user_auth_type(user) not in ADMIN_CONSOLE_RANKS:
        raise HTTPException(status_code=403, detail="Admin access required")

    return user


# API paths a user with a pending account-setup (Omnidex / password cleared by
# an admin) may still call — everything they need to complete the setup, plus
# session basics. Everything else under /api/ is 403'd until they're done.
_SETUP_ALLOWED_API = (
    "/api/me",
    "/api/logout",
    "/api/login",
    "/api/register",
    "/api/profile/omnidex",
    "/api/profile/set-password",
)


@app.middleware("http")
async def enforce_account_setup(request: Request, call_next):
    path = request.url.path

    # Only gate API calls; the SPA shell, fragments and static assets must
    # load so the blocking setup modal can render.
    if path.startswith("/api/") and not path.startswith(_SETUP_ALLOWED_API):
        user = get_current_user(request)
        if user:
            flags = user_needs_setup(user)
            if flags["must_set_omnidex"] or flags["must_set_password"]:
                return JSONResponse({"detail": "Account setup required"}, status_code=403)

    return await call_next(request)


_STATIC_ASSET_RE = re.compile(r'(src|href)="(/static/[^"]+)"')


def _bust_static_cache(html: str) -> str:
    # Appends each asset's own mtime as a query string so the browser treats
    # an edited file as a new URL and re-fetches it, instead of relying on
    # HTTP heuristic caching (no explicit Cache-Control is set for /static)
    # and silently serving a stale JS/CSS file after a code change.
    def replace(match: re.Match) -> str:
        attr, path = match.group(1), match.group(2)
        try:
            mtime = int(os.path.getmtime(path.lstrip("/")))
        except OSError:
            return match.group(0)
        return f'{attr}="{path}?v={mtime}"'

    return _STATIC_ASSET_RE.sub(replace, html)


def serve_index():
    with open("templates/index.html", encoding="utf-8") as f:
        html = f.read()
    return HTMLResponse(_bust_static_cache(html))


@app.get("/", response_class=HTMLResponse)
async def main_menu():
    return serve_index()


@app.get("/cards", response_class=HTMLResponse)
async def cards_page():
    return serve_index()


@app.get("/collection", response_class=HTMLResponse)
async def collection_page():
    return serve_index()


@app.get("/decks", response_class=HTMLResponse)
async def decks_page():
    return serve_index()


@app.get("/login", response_class=HTMLResponse)
async def login_page():
    return serve_index()


@app.get("/prices", response_class=HTMLResponse)
async def prices_page():
    return serve_index()


def _pick_default_foil(foils: dict):
    """Nonfoil/normal > foil > anything else — mirrors tiles.js pickDefaultFoil."""
    if not foils:
        return None

    def priority(finfo):
        kind = (finfo.get("kind") or "").lower()
        if kind in ("normal", "nonfoil"):
            return 0
        if kind == "foil":
            return 1
        return 2

    return min(foils.items(), key=lambda kv: priority(kv[1]))[0]


def _curio_foil_id(foils: dict) -> str | None:
    # See _curio_foil_id_for_edition's comment for the "exactly one variant
    # across all foils" business rule this relies on.
    variant_ids = [variant_id for foil_info in foils.values() for variant_id in foil_info.get("variants", {})]
    return variant_ids[0] if len(variant_ids) == 1 else None


def _last_sale_price_from_records(records: list):
    return max(records, key=lambda r: r["date"])["price"] if records else None


def _lowest_listing_price_from_records(records: list):
    """Lowest price among listings from the most recent scrape date only.
    Listings accumulate forever (each scrape appends that day's snapshot
    rather than replacing the last one), so pooling min() across every date
    ever recorded can surface a stale price from a listing that's long gone."""
    if not records:
        return None
    latest_date = max(r["date"] for r in records)
    return min(r["price"] for r in records if r["date"] == latest_date)


def _last_listing_price_from_records(records: list):
    return max(records, key=lambda r: r["date"])["price"] if records else None


def _last_sale_price(sales_data: dict, card_id: str, edition_id: str, foils: dict):
    foil_id = _pick_default_foil(foils)
    price = None
    if foil_id:
        records = sales_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])
        price = _last_sale_price_from_records(records)

    if price is not None:
        return price

    # Nonfoil/Foil have no sale of their own — fall back to this edition's
    # Curio Foil (e.g. Aurora/Interference Curio Foil), a separate TCGPlayer
    # product nested as a variant under one of the foils, so its own price
    # history isn't otherwise reachable from the default-foil pick above.
    curio_foil_id = _curio_foil_id(foils)
    if curio_foil_id:
        curio_records = sales_data.get(card_id, {}).get(edition_id, {}).get(curio_foil_id, [])
        return _last_sale_price_from_records(curio_records)

    return None


def _lowest_listing_price(listings_data: dict, card_id: str, edition_id: str, foils: dict):
    foil_id = _pick_default_foil(foils)
    price = None
    if foil_id:
        records = listings_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])
        price = _lowest_listing_price_from_records(records)

    if price is not None:
        return price

    # See _last_sale_price's matching fallback — same reasoning, for listings.
    curio_foil_id = _curio_foil_id(foils)
    if curio_foil_id:
        curio_records = listings_data.get(card_id, {}).get(edition_id, {}).get(curio_foil_id, [])
        return _lowest_listing_price_from_records(curio_records)

    return None


@app.get("/api/cards/search")
async def api_cards_search(request: Request, q: str = "", all_prints: bool = False):
    set_params = request.query_params.getlist("set")
    set_filters = [s.strip().lower().replace(" ", "_") for s in set_params]

    slug_data = load_slugs_data()
    info_data = load_info_data()
    sales_data = load_sales_data()
    listings_data = load_listings_data()

    def enrich(cards):
        set_file_cache = {}
        for card in cards:
            card_info = info_data.get(card["card_id"], {})
            edition_info = card_info.get("editions", {}).get(card["edition_id"], {})
            card["element"] = card_info.get("element") or ""
            set_prefix = edition_info.get("set_prefix", "")
            card["set_prefix"] = set_prefix
            key = set_prefix.lower().replace(" ", "_")
            if key not in set_file_cache:
                set_file_cache[key] = load_set_collector_data(key)
            set_data = set_file_cache[key]
            card["collector_number"] = next(
                (num for num, eids in set_data.items()
                 if card["edition_id"] in (eids if isinstance(eids, list) else [eids])),
                ""
            )
            card["last_price"] = _last_sale_price(
                sales_data, card["card_id"], card["edition_id"], edition_info.get("foils", {})
            )
            card["lowest_listing"] = _lowest_listing_price(
                listings_data, card["card_id"], card["edition_id"], edition_info.get("foils", {})
            )
        return cards

    query = q.strip().lower()
    cards = []

    if query:
        # ── Step 0: Exact match ──
        exact_matches = {
            slug: data for slug, data in slug_data.items()
            if data["name"].lower() == query
        }

        if exact_matches:
            for slug, data in exact_matches.items():
                card_id = data["card_id"]
                card_info = info_data.get(card_id, {})
                all_editions = card_info.get("editions", {})

                if set_filters:
                    candidate_editions = [
                        eid for eid, einfo in all_editions.items()
                        if einfo.get("set_prefix", "").lower().replace(" ", "_") in set_filters
                    ]
                else:
                    candidate_editions = list(all_editions.keys())

                for edition_id in (candidate_editions if (set_filters or all_prints) else [
                    random.choice(candidate_editions)] if candidate_editions else []):
                    rarity = all_editions.get(edition_id, {}).get("rarity")
                    cards.append({
                        "card_id": card_id,
                        "edition_id": edition_id,
                        "name": data["name"],
                        "rarity": rarity,
                    })

            if not set_filters:
                return JSONResponse({"cards": enrich(cards), "message": None, "fuzzy": False})

        # ── Step 1: API call ──
        already_found = {c["card_id"] for c in cards}
        card_data = _api_search_variants(q)

        if card_data:
            # Re-read to pick up what _api_search_variants (via _api_search)
            # just synced. Correct in both modes: JSON mode re-reads the
            # files that were just written; DB mode re-reads Postgres, which
            # _persist_card wrote directly and then db_cache.bust()-ed, so a
            # brand-new card is visible here immediately.
            slug_data = load_slugs_data()
            info_data = load_info_data()

            slug = _format_search(q)

            if slug in slug_data:
                card_id = slug_data[slug]["card_id"]

                if card_id not in already_found:
                    card_info = info_data.get(card_id, {})
                    all_editions = card_info.get("editions", {})

                    if set_filters:
                        candidate_editions = [
                            eid for eid, einfo in all_editions.items()
                            if einfo.get("set_prefix", "").lower().replace(" ", "_") in set_filters
                        ]
                    else:
                        candidate_editions = list(all_editions.keys())

                    for edition_id in (candidate_editions if (set_filters or all_prints) else [
                        random.choice(candidate_editions)] if candidate_editions else []):
                        rarity = all_editions.get(edition_id, {}).get("rarity")
                        cards.append({
                            "card_id": card_id,
                            "edition_id": edition_id,
                            "name": slug_data[slug]["name"],
                            "rarity": rarity,
                        })

    # ── Step 2: Substring match ──
    substring_matches = {
        slug: data for slug, data in slug_data.items()
        if (not query or query in data["name"].lower())
    }

    if set_filters:
        filtered = {}
        for slug, data in substring_matches.items():
            card_id = data["card_id"]
            card_info = info_data.get(card_id, {})
            for edition_info in card_info.get("editions", {}).values():
                if edition_info.get("set_prefix", "").lower().replace(" ", "_") in set_filters:
                    filtered[slug] = data
                    break
        substring_matches = filtered

    if substring_matches:
        existing_card_ids = {c["card_id"] for c in cards}

        for slug, data in substring_matches.items():
            card_id = data["card_id"]

            if card_id in existing_card_ids:
                continue

            card_info = info_data.get(card_id, {})

            if set_filters:
                matching_editions = [
                    eid for eid, einfo in card_info.get("editions", {}).items()
                    if einfo.get("set_prefix", "").lower().replace(" ", "_") in set_filters
                ]

                for edition_id in matching_editions:
                    rarity = card_info.get("editions", {}).get(edition_id, {}).get("rarity")
                    cards.append({
                        "card_id": card_id,
                        "edition_id": edition_id,
                        "name": data["name"],
                        "rarity": rarity,
                    })

                if matching_editions:
                    existing_card_ids.add(card_id)
            else:
                editions = list(card_info.get("editions", {}).keys())

                for edition_id in (editions if all_prints else [
                    random.choice(editions)] if editions else []):
                    rarity = card_info.get("editions", {}).get(edition_id, {}).get("rarity")
                    cards.append({
                        "card_id": card_id,
                        "edition_id": edition_id,
                        "name": data["name"],
                        "rarity": rarity,
                    })

                if editions:
                    existing_card_ids.add(card_id)

        if set_filters and cards:
            collector_order = {}
            for set_filter in set_filters:
                set_data = load_set_collector_data(set_filter)
                for num, eids in set_data.items():
                    if isinstance(eids, list):
                        for eid in eids:
                            collector_order[eid] = (set_filter, num)
                    else:
                        collector_order[eids] = (set_filter, num)

            cards.sort(key=lambda c: (
                collector_order.get(c["edition_id"], ("zzz", "ZZZ"))[0],
                _sort_collector_number(collector_order.get(c["edition_id"], ("zzz", "ZZZ"))[1])
            ))

        if cards:
            return JSONResponse({"cards": enrich(cards), "message": None, "fuzzy": False})

    if not query:
        return JSONResponse({"cards": [], "message": "No cards found.", "fuzzy": False})

    # ── Step 3: Fuzzy match ──
    existing_card_ids = {c["card_id"] for c in cards}
    name_to_slug = {data["name"]: slug for slug, data in slug_data.items()}
    names = list(name_to_slug.keys())

    fuzzy_matches = process.extract(q, names, scorer=fuzz.WRatio, score_cutoff=80)
    fuzzy_added = False

    if fuzzy_matches:
        for name, score, _ in fuzzy_matches:
            slug = name_to_slug[name]
            card_id = slug_data[slug]["card_id"]

            if card_id in existing_card_ids:
                continue

            card_info = info_data.get(card_id, {})
            editions = list(card_info.get("editions", {}).keys())

            for edition_id in (editions if all_prints else [
                random.choice(editions)] if editions else []):
                rarity = card_info.get("editions", {}).get(edition_id, {}).get("rarity")
                cards.append({
                    "card_id": card_id,
                    "edition_id": edition_id,
                    "name": name,
                    "rarity": rarity,
                })
                fuzzy_added = True

    if cards:
        return JSONResponse({"cards": enrich(cards), "message": None, "fuzzy": fuzzy_added})

    return JSONResponse({"cards": [], "message": f"No card found for '{q}'.", "fuzzy": False})


@app.get("/api/cards/suggest")
async def api_cards_suggest(q: str):
    slug_data = load_slugs_data()

    query = q.strip().lower()

    if len(query) < 2:
        return JSONResponse({"suggestions": []})

    suggestions = sorted(
        {data["name"] for slug, data in slug_data.items()
         if query in data["name"].lower()}
    )

    return JSONResponse({"suggestions": suggestions[:10]})


@app.get("/api/cards/{card_id}")
async def api_card_detail(card_id: str):
    # One card, not the whole catalog: load_card_detail_data / the *_for_card
    # / *_for_editions readers below each hit only this card's rows in DB
    # mode, instead of hydrating every table just to throw all but one card
    # away. See the drawer perf note — this handler is the hot path behind it.
    card_info = load_card_detail_data(card_id)

    if not card_info:
        raise HTTPException(status_code=404, detail="Card not found")

    # load_card_detail_data already resolves `name` (from the DB row in DB
    # mode, from a SLUGS.json scan in JSON mode) and each edition's
    # `collector_number` — needed so callers that only have a card_id (e.g.
    # restoring a bookmarked ?card_id= URL, see the Prices page) can show a
    # name without a separate search round-trip.

    edition_ids = list(card_info.get("editions", {}).keys())
    thema_data = load_thema_for_editions(edition_ids)
    sales_data, listings_data = load_price_data_for_card(card_id)
    # All TCGPlayer product IDs (edition-level and per-foil-variant) in one
    # read instead of two calls per edition — the drawer's pricing tab uses
    # them to link each graph's "View on TCGPlayer" button.
    tcg_ids = get_all_ids()

    card_listings = listings_data.get(card_id, {})
    card_sales = sales_data.get(card_id, {})

    for edition_id, edition_info in card_info.get("editions", {}).items():
        edition_info["thema"] = thema_data.get(edition_id, {})
        edition_info["last_price"] = _last_sale_price(
            sales_data, card_id, edition_id, edition_info.get("foils", {})
        )
        edition_info["lowest_listing"] = _lowest_listing_price(
            listings_data, card_id, edition_id, edition_info.get("foils", {})
        )

        # Regular nonfoil/foil printings share the edition's own TCGPlayer
        # product; a Curio Foil (or other variant) may have its own separate
        # product page instead.
        edition_ids_entry = tcg_ids.get(edition_id, {})
        edition_info["product_id"] = edition_ids_entry.get("product_id")
        foil_overrides = edition_ids_entry.get("foils", {})
        for foil_info in edition_info.get("foils", {}).values():
            for variant_id, variant_info in foil_info.get("variants", {}).items():
                variant_info["product_id"] = foil_overrides.get(variant_id, {}).get("product_id")

        edition_listings = card_listings.get(edition_id, {})
        edition_sales = card_sales.get(edition_id, {})
        foil_ids = list(edition_info.get("foils", {}).keys()) + [
            variant_id
            for foil_info in edition_info.get("foils", {}).values()
            for variant_id in foil_info.get("variants", {})
        ]

        edition_info["pricing"] = {
            foil_id: {
                "listings": edition_listings.get(foil_id, []),
                "sales": edition_sales.get(foil_id, [])
            }
            for foil_id in foil_ids
        }

    return JSONResponse({"card_id": card_id, "card": card_info})


@app.get("/api/me")
async def api_me(request: Request):
    user = get_current_user(request)
    auth_type = get_user_auth_type(user) if user else None

    # `user` is just the JWT subject — it can name an account that no longer
    # exists (a stale cookie after a data wipe). Treat that as logged out.
    if not user or auth_type is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return JSONResponse({
        "username": user,
        "auth_type": auth_type,
        **user_needs_setup(user),
    })


# ── Self-service profile (any signed-in user, about their own account) ──

def _require_login(request: Request) -> str:
    user = get_current_user(request)

    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return user


PROFILE_BIO_MAX = 2000

# An Omnidex ID is a plain number the user copies from their Omnidex account.
_OMNIDEX_ID_RE = re.compile(r"^\d{1,20}$")


def _profile_payload(username: str) -> dict | None:
    """The profile blob shared by the self page (/api/profile) and the public
    page (/api/users/{omnidex_id}) — identity, bio, Omnidex ID, stats, and the
    deck / bin lists. Contains nothing account-sensitive (no password hash,
    no settings), so it's safe to serve publicly."""
    profile = user_get_profile(username)

    if profile is None:
        return None

    bins = _user_bins_list(username)
    decks = _user_decks_list(username)

    profile["bins"] = bins
    profile["decks"] = decks
    profile["stats"] = {
        "bins": len(bins),
        "cards": sum(b["card_count"] for b in bins),
        "decks": len(decks),
    }

    return profile


@app.get("/api/profile")
async def api_profile(request: Request):
    user = _require_login(request)

    profile = _profile_payload(user)

    if profile is None:
        raise HTTPException(status_code=404, detail="User not found")

    return JSONResponse(profile)


@app.get("/api/users/{omnidex_id}")
async def api_public_profile(omnidex_id: str):
    """Read-only public view of a user's profile, looked up by Omnidex ID —
    no auth required, no account-management surface (see _profile_payload)."""
    username = user_find_by_omnidex(omnidex_id.strip())

    if username is None:
        raise HTTPException(status_code=404, detail="No user with that Omnidex ID")

    profile = _profile_payload(username)

    if profile is None:
        raise HTTPException(status_code=404, detail="No user with that Omnidex ID")

    return JSONResponse(profile)


@app.get("/api/omnidex-taken/{omnidex_id}")
async def api_omnidex_taken(omnidex_id: str):
    """Whether an Omnidex ID is already registered — the sign-up form checks
    this before submitting. (user_create re-checks server-side regardless.)"""
    return JSONResponse({"taken": user_find_by_omnidex(omnidex_id.strip()) is not None})


@app.post("/api/profile/bio")
async def api_profile_set_bio(request: Request):
    user = _require_login(request)

    body = await request.json()
    bio = (body.get("bio") or "").strip()

    if len(bio) > PROFILE_BIO_MAX:
        raise HTTPException(status_code=400, detail=f"Bio must be {PROFILE_BIO_MAX} characters or fewer")

    user_set_bio(user, bio)

    return JSONResponse({"bio": bio})


@app.post("/api/profile/omnidex")
async def api_profile_set_omnidex(request: Request):
    """Set the caller's Omnidex ID — only while it's currently unset (chosen at
    registration, or cleared by an admin). Backs the account-setup gate."""
    user = _require_login(request)

    body = await request.json()
    omnidex_id = (body.get("omnidex_id") or "").strip()

    if not _OMNIDEX_ID_RE.match(omnidex_id):
        raise HTTPException(status_code=400, detail="Omnidex ID must be a number (up to 20 digits)")

    profile = user_get_profile(user)
    if profile and profile.get("omnidex_id"):
        raise HTTPException(status_code=400, detail="Your Omnidex ID is already set")

    try:
        user_set_omnidex_id(user, omnidex_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return JSONResponse({"omnidex_id": omnidex_id})


@app.post("/api/profile/password")
async def api_profile_change_password(request: Request):
    user = _require_login(request)

    body = await request.json()
    current_password = body.get("current_password") or ""
    new_password = body.get("new_password") or ""

    if not new_password:
        raise HTTPException(status_code=400, detail="New password cannot be empty")

    if user_login(user, current_password) is None:
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    user_reset(user, new_password)

    return JSONResponse({"message": "Password updated"})


@app.post("/api/profile/set-password")
async def api_profile_set_password(request: Request):
    """First-time password set for an account whose password an admin cleared —
    no current-password check (there isn't one). Backs the account-setup gate."""
    user = _require_login(request)

    if not user_needs_setup(user)["must_set_password"]:
        raise HTTPException(status_code=400, detail="Password is already set")

    body = await request.json()
    new_password = body.get("new_password") or ""

    if not new_password:
        raise HTTPException(status_code=400, detail="Password cannot be empty")

    user_reset(user, new_password)

    return JSONResponse({"message": "Password set"})


@app.delete("/api/profile")
async def api_profile_delete(request: Request):
    user = _require_login(request)

    if get_user_auth_type(user) == "owner":
        raise HTTPException(status_code=400, detail="The owner account cannot be self-deleted")

    user_delete(user)

    resp = JSONResponse({"deleted": user})
    resp.delete_cookie("token")
    return resp


@app.get("/api/sets")
async def api_sets():
    return JSONResponse({"sets": load_set_names()})


# Public counterpart to /api/admin/featured-sets — feeds the Cards page's
# featured-set tiles shown before a search is made (see loadFeaturedSets in
# cards.js). JSON_FEATURED_SETS is keyed by release name with each one's
# member sets listed underneath (see sync_featured_sets in api_ga.py), so this
# just reshapes it into a list — carrying every prefix in the release (not
# just one), matching index.gatcg.com's own featured tiles, which list and
# search every prefix in a release together (e.g. "RDO • RDO 1st • RDOA •
# RDOP • RDOPD") rather than picking one to stand in for the rest.
#
# The URL itself is always /set-images/{slug}.png — re-derived from
# group_name via _group_slug, the same slug _download_set_image (api_ga.py)
# saves the cached banner under — regardless of store_images_locally; that
# route (below) is what actually branches on the setting, lazily downloading
# and serving the cached file or redirecting to api.gatcg.com as appropriate,
# so this endpoint doesn't need to know which mode is active.
@app.get("/api/sets/featured")
async def api_sets_featured():
    featured = load_featured_sets_data()

    groups = [
        {
            "group_name": group_name,
            "prefixes": [s["prefix"] for s in group_data.get("sets", []) if s.get("prefix")],
            "image": f"/set-images/{_group_slug(group_name)}.png",
        }
        for group_name, group_data in featured.items()
    ]

    return JSONResponse({"groups": groups})


def _run_set_search_job(job_id: str, set_prefix: str) -> None:
    def on_progress(done, total, card_name):
        with _set_search_jobs_lock:
            job = _set_search_jobs.get(job_id)
            if job is None:
                return
            job["done"] = done
            job["total"] = total
            job["current_card"] = card_name

    try:
        set_search(set_prefix, False, progress_callback=on_progress)
        with _set_search_jobs_lock:
            job = _set_search_jobs.get(job_id)
            if job is not None:
                job["status"] = "done"
    except Exception as e:
        with _set_search_jobs_lock:
            job = _set_search_jobs.get(job_id)
            if job is not None:
                job["status"] = "error"
                job["error"] = str(e)


@app.post("/api/sets/search/start")
async def api_sets_search_start(prefix: str):
    set_filter = prefix.strip().lower().replace(" ", "_")

    if is_db_mode():
        last_searched = load_set_searches_data().get(set_filter, {}).get("last_searched")
    else:
        last_searched = _set_search_cache.get(set_filter, {}).get("last_searched")
    needs_fetch = last_searched is None
    if not needs_fetch:
        last_sync = date.fromisoformat(last_searched)
        needs_fetch = (date.today() - last_sync).days > UPDATE_THRESHOLD

    if not needs_fetch:
        # Local data is fresh enough — no job needed, frontend can fetch results immediately
        return JSONResponse({"job_id": None, "cached": True})

    today_iso = date.today().isoformat()
    if is_db_mode():
        mark_set_searched(set_filter, today_iso)
    else:
        # setdefault rather than a plain assignment — preserves tcgplayer_group_id
        # (see api_admin_set_group_id) if an admin already set one for this slug.
        _set_search_cache.setdefault(set_filter, {})["last_searched"] = today_iso
        with new_json(JSON_SET_SEARCHES).open("w", encoding="utf-8") as f:
            json.dump(_set_search_cache, f, indent=4)

    job_id = uuid.uuid4().hex
    with _set_search_jobs_lock:
        _set_search_jobs[job_id] = {
            "status": "running",
            "done": 0,
            "total": 0,
            "current_card": None,
            "error": None,
            "set_prefix": prefix.strip().upper()
        }

    thread = threading.Thread(
        target=_run_set_search_job,
        args=(job_id, prefix.strip().upper()),
        daemon=True
    )
    thread.start()

    return JSONResponse({"job_id": job_id, "cached": False})


@app.get("/api/sets/search/status/{job_id}")
async def api_sets_search_status(job_id: str):
    with _set_search_jobs_lock:
        job = _set_search_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        snapshot = dict(job)

    if snapshot["status"] in ("done", "error"):
        with _set_search_jobs_lock:
            _set_search_jobs.pop(job_id, None)

    return JSONResponse(snapshot)


def _run_pricing_refresh_job(job_id: str, edition_id: str, target: str = "both") -> None:
    try:
        if target == "both":
            # Shares a single browser session for both scrapes instead of
            # opening and closing a separate one for each.
            combined = scrape_sales_and_listings_tcg_by_edition(edition_id, debug=False, headless=False)
            sales_result = combined["sales"]
            listings_result = combined["listings"]
        else:
            sales_result = scrape_sales_tcg_by_edition(edition_id, debug=False, headless=False) \
                if target == "sales" else None
            listings_result = scrape_listings_tcg_by_edition(edition_id, debug=False, headless=False) \
                if target == "listings" else None

        with _pricing_jobs_lock:
            job = _pricing_jobs.get(job_id)
            if job is not None:
                job["status"] = "done"
                job["sales"] = sales_result
                job["listings"] = listings_result
    except Exception as e:
        with _pricing_jobs_lock:
            job = _pricing_jobs.get(job_id)
            if job is not None:
                job["status"] = "error"
                job["error"] = str(e)


@app.post("/api/pricing/{edition_id}/refresh/start")
async def api_pricing_refresh_start(edition_id: str, request: Request, target: str = "both"):
    require_admin(request)

    if target not in ("both", "sales", "listings"):
        raise HTTPException(status_code=400, detail="target must be 'both', 'sales', or 'listings'")

    job_id = uuid.uuid4().hex
    with _pricing_jobs_lock:
        _pricing_jobs[job_id] = {
            "status": "running",
            "edition_id": edition_id,
            "sales": None,
            "listings": None,
            "error": None
        }

    thread = threading.Thread(
        target=_run_pricing_refresh_job,
        args=(job_id, edition_id, target),
        daemon=True
    )
    thread.start()

    return JSONResponse({"job_id": job_id})


@app.get("/api/pricing/refresh/status/{job_id}")
async def api_pricing_refresh_status(job_id: str, request: Request):
    require_admin(request)

    with _pricing_jobs_lock:
        job = _pricing_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        snapshot = dict(job)

    if snapshot["status"] in ("done", "error"):
        with _pricing_jobs_lock:
            _pricing_jobs.pop(job_id, None)

    return JSONResponse(snapshot)


def _run_pricing_batch_job(job_id: str, edition_ids: list, target: str, foil_scopes: dict) -> None:
    def on_progress(edition_id, result):
        with _pricing_batch_jobs_lock:
            job = _pricing_batch_jobs.get(job_id)
            if job is None:
                return
            job["results"][edition_id] = result
            job["done"] += 1
            job["current_edition_id"] = edition_id

    try:
        scrape_batch_tcg_by_editions(
            edition_ids, target, debug=False, headless=False, progress_callback=on_progress, foil_scopes=foil_scopes
        )

        with _pricing_batch_jobs_lock:
            job = _pricing_batch_jobs.get(job_id)
            if job is not None:
                job["status"] = "done"
                job["current_edition_id"] = None
    except Exception as e:
        with _pricing_batch_jobs_lock:
            job = _pricing_batch_jobs.get(job_id)
            if job is not None:
                job["status"] = "error"
                job["error"] = str(e)


@app.post("/api/pricing/refresh/batch/start")
async def api_pricing_refresh_batch_start(request: Request):
    require_admin(request)

    body = await request.json()
    edition_ids = body.get("edition_ids", [])
    target = body.get("target", "both")
    # Maps edition_id -> "main" or a specific foil_id (e.g. a Curio Foil's),
    # scoping that edition's refresh to ONLY that one product instead of the
    # default merged main+overrides behavior — set by the admin UI's per-row
    # Curio Foil toggle so refreshing only ever touches whichever product
    # (main or the toggled override) is currently selected for that row.
    # Editions with no entry here keep the default (unscoped) behavior.
    foil_scopes = body.get("foil_scopes", {})

    if target not in ("both", "sales", "listings"):
        raise HTTPException(status_code=400, detail="target must be 'both', 'sales', or 'listings'")

    if not edition_ids:
        raise HTTPException(status_code=400, detail="edition_ids is required")

    if not isinstance(foil_scopes, dict) or not all(isinstance(v, str) for v in foil_scopes.values()):
        raise HTTPException(status_code=400, detail="foil_scopes must be a mapping of edition_id to string")

    job_id = uuid.uuid4().hex
    with _pricing_batch_jobs_lock:
        _pricing_batch_jobs[job_id] = {
            "status": "running",
            "target": target,
            "total": len(edition_ids),
            "done": 0,
            "current_edition_id": None,
            "results": {},
            "error": None,
        }

    thread = threading.Thread(
        target=_run_pricing_batch_job,
        args=(job_id, edition_ids, target, foil_scopes),
        daemon=True
    )
    thread.start()

    return JSONResponse({"job_id": job_id})


@app.get("/api/pricing/refresh/batch/status/{job_id}")
async def api_pricing_refresh_batch_status(job_id: str, request: Request):
    require_admin(request)

    with _pricing_batch_jobs_lock:
        job = _pricing_batch_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        snapshot = dict(job)
        snapshot["results"] = dict(job["results"])

    if snapshot["status"] in ("done", "error"):
        with _pricing_batch_jobs_lock:
            _pricing_batch_jobs.pop(job_id, None)

    return JSONResponse(snapshot)


def _run_product_id_job(job_id: str, edition_ids: list) -> None:
    def on_progress(edition_id, result):
        with _product_id_jobs_lock:
            job = _product_id_jobs.get(job_id)
            if job is None:
                return
            job["results"][edition_id] = result
            job["done"] += 1
            job["current_edition_id"] = edition_id

    try:
        find_product_ids_by_editions(edition_ids, debug=False, headless=False, progress_callback=on_progress)

        with _product_id_jobs_lock:
            job = _product_id_jobs.get(job_id)
            if job is not None:
                job["status"] = "done"
                job["current_edition_id"] = None
    except Exception as e:
        with _product_id_jobs_lock:
            job = _product_id_jobs.get(job_id)
            if job is not None:
                job["status"] = "error"
                job["error"] = str(e)


@app.post("/api/admin/pricing/find-product-ids/start")
async def api_find_product_ids_start(request: Request):
    require_admin(request)

    body = await request.json()
    edition_ids = body.get("edition_ids") or []

    if not edition_ids:
        # No specific editions given — default to every edition currently missing one
        editions_data = load_editions_data()
        ids_data = get_all_ids()
        edition_ids = [eid for eid in editions_data if not ids_data.get(eid, {}).get("product_id")]

    if not edition_ids:
        raise HTTPException(status_code=400, detail="No editions to look up")

    job_id = uuid.uuid4().hex
    with _product_id_jobs_lock:
        _product_id_jobs[job_id] = {
            "status": "running",
            "total": len(edition_ids),
            "done": 0,
            "current_edition_id": None,
            "results": {},
            "error": None,
        }

    thread = threading.Thread(
        target=_run_product_id_job,
        args=(job_id, edition_ids),
        daemon=True
    )
    thread.start()

    return JSONResponse({"job_id": job_id})


@app.get("/api/admin/pricing/find-product-ids/status/{job_id}")
async def api_find_product_ids_status(job_id: str, request: Request):
    require_admin(request)

    with _product_id_jobs_lock:
        job = _product_id_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        snapshot = dict(job)
        snapshot["results"] = dict(job["results"])

    if snapshot["status"] in ("done", "error"):
        with _product_id_jobs_lock:
            _product_id_jobs.pop(job_id, None)

    return JSONResponse(snapshot)


# A full run touches every DATA_GA/DATA_GENERAL domain (~7s against the real
# local dataset) — long enough to freeze every other request for that whole
# stretch if run directly in this async route, so it gets the same
# background-thread-plus-job-polling treatment as the scrape/product-ID jobs
# above rather than a synchronous call.
def _run_sync_job(job_id: str) -> None:
    from scripts.migrate_json_to_pg import run_migration

    result = run_migration()

    # The sync just replaced every catalog/pricing row — drop the DB-mode
    # read cache so the next request reflects it instead of serving stale
    # rows for up to the cache TTL (see db_cache.py).
    if result["ok"]:
        db_cache.bust()

    with _sync_jobs_lock:
        job = _sync_jobs.get(job_id)
        if job is not None:
            job["status"] = "done" if result["ok"] else "error"
            job["ok"] = result["ok"]
            job["log"] = result["log"]
            job["error"] = result["error"]


@app.post("/api/admin/system/sync-to-database/start")
async def api_admin_sync_to_database_start(request: Request):
    require_admin(request)

    job_id = uuid.uuid4().hex
    with _sync_jobs_lock:
        _sync_jobs[job_id] = {"status": "running", "ok": None, "log": "", "error": None}

    thread = threading.Thread(target=_run_sync_job, args=(job_id,), daemon=True)
    thread.start()

    return JSONResponse({"job_id": job_id})


@app.get("/api/admin/system/sync-to-database/status/{job_id}")
async def api_admin_sync_to_database_status(job_id: str, request: Request):
    require_admin(request)

    with _sync_jobs_lock:
        job = _sync_jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        snapshot = dict(job)

    if snapshot["status"] in ("done", "error"):
        with _sync_jobs_lock:
            _sync_jobs.pop(job_id, None)

    return JSONResponse(snapshot)


# TRUNCATE is near-instant even across every row in every table (unlike the
# sync job, it isn't scanning/inserting anything) — synchronous, no
# background-job-plus-polling needed here.
@app.post("/api/admin/system/wipe-database")
async def api_admin_wipe_database(request: Request):
    require_admin(request)

    from scripts.migrate_json_to_pg import wipe_database

    result = wipe_database()

    if result["ok"]:
        # Every table the wipe just emptied is exactly what db_cache.py
        # memoizes — without this, DB-mode reads would keep serving the
        # pre-wipe rows out of cache for up to its TTL.
        db_cache.bust()
        return JSONResponse(result)

    raise HTTPException(status_code=500, detail=result["error"] or "Wipe failed.")


# ── Database Connection panel ────────────────────────────────────────────
# Reads/edits the pieces of the connection string (host, port, db, user,
# password, sslmode). A save persists the reassembled string to SETTINGS.json
# (save_database_url) and resets the engine so the next query reconnects — the
# .env file / platform DATABASE_URL is a read-only default and is never
# written. resolved_database_url() (db_connection.py) is what everything
# actually connects with: the SETTINGS.json override if one has been saved,
# otherwise the env default.
#
# The override persists (locally in DATA_GENERAL/SETTINGS.json, on Railway on
# the volume it's symlinked onto), so a saved connection now sticks across a
# redeploy and takes priority over the platform's own DATABASE_URL. To fall
# back to the env default again, delete the "database_url" key from
# SETTINGS.json (db_connection.clear_database_url()).


def _test_database_connection(url: str | None) -> tuple[bool, str | None]:
    """(ok, error) for a plain `SELECT 1` against `url` on a short-lived,
    always-disposed engine — shared by the Test button, the DB-mode precheck,
    and the settings guard so they all probe the connection the same way."""
    if not url:
        return False, "No connection configured."

    engine = None
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 5})
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True, None
    except Exception as exc:
        return False, str(exc)
    finally:
        if engine is not None:
            engine.dispose()


def _owner_in_database(url: str, owner_username: str) -> bool:
    """Whether a row for `owner_username` already exists in the `users` table of
    the Postgres at `url`. Raw SQL on a throwaway engine — this has to work
    against a database that isn't the one the app's own engine is bound to yet
    (the switch into DB mode hasn't happened). False on any connection error
    OR if the `users` table doesn't exist yet (fresh, unmigrated database)."""
    engine = None
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 5})
        with engine.connect() as conn:
            row = conn.execute(
                text("SELECT 1 FROM users WHERE username = :u LIMIT 1"),
                {"u": owner_username},
            ).first()
        return row is not None
    except Exception:
        return False
    finally:
        if engine is not None:
            engine.dispose()


def _schema_ready(url: str) -> bool:
    """Whether the Postgres at `url` has this app's schema — checked by the
    presence of the `users` table, which every DB-mode path needs and which a
    brand-new Railway/managed database won't have until `alembic upgrade head`
    has run against it. False on any connection error."""
    engine = None
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 5})
        with engine.connect() as conn:
            return conn.execute(text("SELECT to_regclass('public.users')")).scalar() is not None
    except Exception:
        return False
    finally:
        if engine is not None:
            engine.dispose()


def run_schema_migration() -> dict:
    """`alembic upgrade head` against the currently-configured connection,
    run in-process. The resolved URL is passed straight to Alembic's Config
    below, so this doesn't rely on alembic/env.py's own lookup. Creates the
    schema on a fresh database and is a no-op when it's already at head.
    Blocking — call from a thread. Returns {"ok", "log", "error"}."""
    url = resolved_database_url()
    if not url:
        return {"ok": False, "log": "", "error": "No database connection configured."}

    from alembic import command
    from alembic.config import Config

    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", url)
    # alembic/env.py runs fileConfig(config.config_file_name) when it's set,
    # which would reconfigure this whole process's logging. The .ini's other
    # settings (script_location etc.) are already parsed into cfg; drop the
    # filename so only the logging step is skipped.
    cfg.config_file_name = None

    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            command.upgrade(cfg, "head")
        return {"ok": True, "log": buf.getvalue().strip() or "Schema is already up to date.", "error": None}
    except Exception as exc:
        return {"ok": False, "log": buf.getvalue().strip(), "error": str(exc)}


def _db_mode_switch_blocker() -> str | None:
    """None if it's safe to switch the app into DB mode right now, otherwise a
    message naming what to fix. Ports the owner account into Postgres as a side
    effect when it's reachable but missing — see port_owner_to_database and the
    guard in api_admin_set_settings for why the owner must be there first."""
    from scripts.migrate_json_to_pg import find_owner_username, port_owner_to_database

    url = resolved_database_url()
    if not url:
        return "Set and save the database connection before turning Use JSON off."

    ok, err = _test_database_connection(url)
    if not ok:
        return f"Database connection failed: {err}. Save a working connection before turning Use JSON off."

    if not _schema_ready(url):
        return (
            "The database has no schema yet — click \"Set Up Database\" in the Database Connection "
            "panel (or run `alembic upgrade head`) before turning Use JSON off."
        )

    owner_username = find_owner_username()
    if not owner_username:
        return None  # no owner account anywhere ⇒ nobody to lock out

    if _owner_in_database(url, owner_username):
        return None

    result = port_owner_to_database()
    if not result["ok"] or not _owner_in_database(url, owner_username):
        detail = f": {result['error']}" if result.get("error") else ""
        return (
            f"Could not copy the owner account '{owner_username}' into the database{detail}. "
            f"It must exist there or you will be locked out of the admin console."
        )

    return None


@app.get("/api/admin/system/database-url")
async def api_admin_get_database_url(request: Request):
    require_admin(request)

    return JSONResponse(parse_database_url(resolved_database_url()))


@app.post("/api/admin/system/database-url")
async def api_admin_set_database_url(request: Request):
    require_admin(request)

    body = await request.json()

    try:
        url = compose_database_url(body, base_url=resolved_database_url())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Persist the override to SETTINGS.json only — .env is never touched.
    save_database_url(url)

    # Different database ⇒ different rows: drop the pooled engine and every
    # memoized whole-table read (same reason the wipe handler above busts).
    reset_engine()
    db_cache.bust()

    return JSONResponse(parse_database_url(url))


@app.post("/api/admin/system/database-url/test")
async def api_admin_test_database_url(request: Request):
    require_admin(request)

    body = await request.json()

    # Test the posted fields if any were sent, otherwise whatever is resolved.
    if any((body or {}).get(k) for k in ("host", "database", "username", "password", "port", "sslmode")):
        try:
            url = compose_database_url(body, base_url=resolved_database_url())
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)})
    else:
        url = resolved_database_url()

    ok, err = _test_database_connection(url)
    return JSONResponse({"ok": True} if ok else {"ok": False, "error": err})


# ── DB-mode switch: precheck + schema + owner port ───────────────────────
# Turning Use JSON off flips the whole app onto Postgres — auth then
# re-checks it every request and never reads USERS.json, so the schema must
# exist and the owner must already be a row there. These endpoints back the
# staged confirmation on the System page (see admin.js beginUseJsonStaging):
# the precheck drives its checklist, "Set up database" runs the migrations
# and copies the owner across. The real enforcement is
# _db_mode_switch_blocker, called from api_admin_set_settings below.
@app.get("/api/admin/system/db-mode-precheck")
async def api_admin_db_mode_precheck(request: Request):
    require_admin(request)

    from scripts.migrate_json_to_pg import find_owner_username

    url = resolved_database_url()
    owner_username = find_owner_username()

    connection_ok, connection_error = _test_database_connection(url) if url else (False, None)
    schema_ready = bool(connection_ok and _schema_ready(url))
    owner_in_db = bool(schema_ready and owner_username and _owner_in_database(url, owner_username))

    return JSONResponse({
        "database_url_set": bool(url),
        "connection_ok": connection_ok,
        "connection_error": connection_error,
        "schema_ready": schema_ready,
        "owner_username": owner_username,
        "owner_in_db": owner_in_db,
    })


@app.post("/api/admin/system/port-owner-to-database")
async def api_admin_port_owner_to_database(request: Request):
    require_admin(request)

    from scripts.migrate_json_to_pg import port_owner_to_database

    result = port_owner_to_database()

    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"] or "Could not port the owner account.")

    return JSONResponse(result)


# "Set up database" button, step 1 — `alembic upgrade head` against the saved
# connection, so a fresh Railway/managed database gets its tables before the
# owner copy / the switch into DB mode need them. Idempotent. Run in a thread so the (few-second,
# network-bound) DDL doesn't block the event loop.
@app.post("/api/admin/system/init-schema")
async def api_admin_init_schema(request: Request):
    require_admin(request)

    result = await asyncio.to_thread(run_schema_migration)

    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"] or "Schema setup failed.")

    return JSONResponse(result)


def _scrape_clocks(ids_entry: dict) -> dict:
    """{"sales": {marketplace: iso}, "listings": {...}} for a get_all_ids()
    entry (edition-level or a foils.<id> sub-entry), omitting an empty field.
    The frontend picks the marketplace the pill is on and computes days-since."""
    out = {}
    for field, key in (("sales", "last_sales"), ("listings", "last_listings")):
        clock_map = ids_entry.get(key)
        if clock_map:
            out[field] = clock_map
    return out


def _curio_foil_id_for_edition(edition_info: dict) -> str | None:
    # A "Curio Foil" (TCGPlayer's umbrella term — Aurora/Interference/
    # Fractured Curio Foil, Quicksilver Foil, etc.) has its own separate
    # TCGPlayer product page/ID from the edition's regular nonfoil+foil
    # product. Confirmed business rule: a card has at most one such special
    # foil, always modeled as a lone `variant` under one of the edition's
    # foils — multi-stamp tournament promos instead have 3-4 variants, so
    # "exactly one variant across all foils" distinguishes a true Curio Foil
    # from those without needing to match on name (which varies by set).
    foils = edition_info.get("foils", {})
    curio_foil_id = _curio_foil_id(foils)

    if not curio_foil_id:
        return None

    # But that alone isn't enough to be admin-UI curio-eligible: some cards
    # (e.g. "Lunar Conduit", RDOA) are printed ONLY as their special foil —
    # no separate nonfoil/foil product exists at all, so the curio variant's
    # own parent foil has nothing left after its population is entirely
    # consumed by the variant (same "remaining_population > 0" check the
    # /foils endpoint below uses to decide whether a top-level Nonfoil/Foil
    # option even exists). With no regular product to toggle back to, a
    # Curio Foil toggle would just be two buttons pointing at the same one
    # product — so treat these as ordinary (non-curio) editions instead,
    # using their single product ID field like any other card.
    has_regular_printing = any(
        finfo.get("population", 0) - sum(v.get("population", 0) for v in finfo.get("variants", {}).values()) > 0
        for finfo in foils.values()
    )

    return curio_foil_id if has_regular_printing else None


@app.get("/api/admin/settings")
async def api_admin_get_settings(request: Request):
    require_admin(request)
    # The DB connection string (with its password) lives in SETTINGS.json too
    # but has its own dedicated endpoint — don't ship it in this toggle blob.
    return JSONResponse({k: v for k, v in load_settings().items() if k != "database_url"})


@app.post("/api/admin/settings")
async def api_admin_set_settings(request: Request):
    require_admin(request)

    body = await request.json()

    settings_data = load_settings()

    # Mirrors db_mode.is_db_mode(): the database is the backing store whenever
    # Use JSON is off.
    was_db_mode = not settings_data.get("use_json", True)

    for key in SETTINGS_DEFAULTS:
        if key in body:
            settings_data[key] = bool(body[key])

    will_be_db_mode = not settings_data.get("use_json", True)

    # This change would newly flip the app into DB mode — refuse unless
    # Postgres is reachable and the owner account exists there (the blocker
    # ports it across first when it can). Without this, an admin turning Use
    # JSON off 403-locks themselves out: DB mode re-checks Postgres for the
    # caller's rank every request and never falls back to USERS.json.
    if will_be_db_mode and not was_db_mode:
        blocker = _db_mode_switch_blocker()
        if blocker:
            raise HTTPException(status_code=400, detail=blocker)

    save_settings(settings_data)

    return JSONResponse(settings_data)


@app.get("/api/admin/users")
async def api_admin_users(request: Request):
    require_admin(request)

    results = user_list()
    results.sort(key=lambda r: r["username"].lower())

    return JSONResponse({"users": results})


@app.post("/api/admin/users/{username}/role")
async def api_admin_set_user_role(username: str, request: Request):
    admin = require_admin(request)

    body = await request.json()
    auth_type = body.get("auth_type")

    if auth_type not in RANK_ORDER:
        raise HTTPException(status_code=400, detail=f"auth_type must be one of {', '.join(RANK_ORDER)}")

    if username == admin:
        raise HTTPException(status_code=400, detail="Cannot change your own role")

    target_auth_type = user_get_auth_type(username)

    if target_auth_type is None:
        raise HTTPException(status_code=404, detail="User not found")

    admin_rank = RANK_ORDER.index(user_get_auth_type(admin))
    target_rank = RANK_ORDER.index(target_auth_type)
    new_rank = RANK_ORDER.index(auth_type)

    # A lower index means higher privilege — you can only act on someone
    # already below you, and can only grant a rank below your own.
    if target_rank <= admin_rank:
        raise HTTPException(status_code=400, detail="Cannot change the role of a user at or above your own rank")

    if new_rank <= admin_rank:
        raise HTTPException(status_code=400, detail="Cannot grant a rank at or above your own")

    user_set_role(username, auth_type)

    return JSONResponse({"username": username, "auth_type": auth_type})


@app.delete("/api/admin/users/{username}")
async def api_admin_delete_user(username: str, request: Request):
    admin = require_admin(request)

    target_auth_type = user_get_auth_type(username)

    if target_auth_type is None:
        raise HTTPException(status_code=404, detail="User not found")

    if username == admin:
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    admin_rank = RANK_ORDER.index(user_get_auth_type(admin))
    target_rank = RANK_ORDER.index(target_auth_type)

    if target_rank <= admin_rank:
        raise HTTPException(status_code=400, detail="Cannot delete a user at or above your own rank")

    user_delete(username)

    return JSONResponse({"deleted": username})


def _require_manageable_target(request: Request, username: str, verb: str) -> None:
    """Shared guard for the per-user admin actions (delete / reset omni /
    reset password): caller must be an admin, target must exist, must not be
    the caller, and must rank strictly below the caller."""
    admin = require_admin(request)

    target_auth_type = user_get_auth_type(username)
    if target_auth_type is None:
        raise HTTPException(status_code=404, detail="User not found")

    if username == admin:
        raise HTTPException(status_code=400, detail=f"Cannot {verb} your own account")

    if RANK_ORDER.index(target_auth_type) <= RANK_ORDER.index(user_get_auth_type(admin)):
        raise HTTPException(status_code=400, detail=f"Cannot {verb} a user at or above your own rank")


ADMIN_NOTE_MAX = 4000


@app.post("/api/admin/users/{username}/note")
async def api_admin_user_note(username: str, request: Request):
    require_admin(request)
    _require_existing_user(username)

    body = await request.json()
    note = (body.get("note") or "")

    if len(note) > ADMIN_NOTE_MAX:
        raise HTTPException(status_code=400, detail=f"Note must be {ADMIN_NOTE_MAX} characters or fewer")

    user_set_admin_note(username, note)

    return JSONResponse({"note": note})


@app.post("/api/admin/users/{username}/reset-omnidex")
async def api_admin_reset_omnidex(username: str, request: Request):
    _require_manageable_target(request, username, "reset the Omni ID of")
    user_admin_reset_omnidex(username)
    return JSONResponse({"username": username, "omnidex_id": None})


@app.post("/api/admin/users/{username}/reset-password")
async def api_admin_reset_password(username: str, request: Request):
    _require_manageable_target(request, username, "reset the password of")
    user_admin_reset_password(username)
    return JSONResponse({"username": username, "password_reset": True})


def _require_existing_user(username: str) -> None:
    if user_get_auth_type(username) is None:
        raise HTTPException(status_code=404, detail="User not found")


def _bin_card_count(bin_info: dict) -> int:
    total = 0
    for section in bin_info.get("sections", {}).values():
        for card in section.values():
            for edition in card.values():
                total += sum(edition.values())
    return total


def _user_bins_list(username: str) -> list[dict]:
    """Every inventory bin for a user as {name, section_count, card_count, desc,
    banner, default}, name-sorted — feeds both the admin profile panel and the
    self-service Profile page's Bins menu."""
    bins = [
        {
            "name": name,
            "section_count": len(bin_info.get("sections", {})),
            "card_count": _bin_card_count(bin_info),
            "desc": bin_info.get("desc", ""),
            "banner": bin_info.get("banner"),
            "default": bool(bin_info.get("default")),
        }
        for name, bin_info in _inv_load(username).items()
    ]
    bins.sort(key=lambda b: b["name"].lower())
    return bins


def _user_decks_list(username: str) -> list[dict]:
    """Every deck for a user as {name, format, desc, banner, card_count},
    name-sorted — feeds both the admin profile panel and the self-service
    Profile page's Decks menu."""
    decks = []
    for name, entry in _deck_index_load(username).items():
        deck_data = _deck_load(username, name)
        count = _deck_card_count(deck_data["sections"]) if deck_data and "sections" in deck_data else 0
        decks.append({
            "name": name,
            "format": (deck_data or {}).get("format", entry.get("format", "")),
            "desc": (deck_data or {}).get("desc", entry.get("desc", "")),
            "banner": entry.get("banner"),
            "card_count": count,
        })
    decks.sort(key=lambda d: d["name"].lower())
    return decks


@app.get("/api/admin/users/{username}")
async def api_admin_user(username: str, request: Request):
    """Identity fields for the Admin → Users profile panel — role, Omnidex ID,
    bio, join date. (Inventory / decks have their own endpoints below.)"""
    require_admin(request)

    profile = user_get_profile(username)

    if profile is None:
        raise HTTPException(status_code=404, detail="User not found")

    return JSONResponse(profile)


@app.get("/api/admin/users/{username}/inventory")
async def api_admin_user_inventory(username: str, request: Request):
    require_admin(request)
    _require_existing_user(username)

    return JSONResponse({"bins": _user_bins_list(username)})


@app.get("/api/admin/users/{username}/decks")
async def api_admin_user_decks(username: str, request: Request):
    require_admin(request)
    _require_existing_user(username)

    return JSONResponse({"decks": _user_decks_list(username)})


@app.get("/api/admin/pricing/product-ids")
async def api_admin_pricing_product_ids(request: Request):
    require_admin(request)

    editions_data = load_editions_data()
    info_data = load_info_data()
    slugs_data = load_slugs_data()

    # card_id -> ISO date this app last pulled fresh data for that card from
    # the Grand Archive API (see _update_update/_check_local in api_ga.py) —
    # distinct from an edition's own date_update below (that's the API's
    # metadata about the EDITION itself, not when WE last synced it).
    system_update_data = load_update_data()

    name_by_card_id = {entry["card_id"]: entry["name"] for entry in slugs_data.values()}
    collector_map = _build_collector_map()
    ids_data = get_all_ids()

    results = []

    for edition_id, edition_ref in editions_data.items():
        card_id = edition_ref.get("card_id")
        edition_info = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {})
        edition_ids = ids_data.get(edition_id, {})

        curio_foil_id = _curio_foil_id_for_edition(edition_info)
        # A card printed ONLY as its special foil (e.g. "Lunar Conduit",
        # RDOA — see _curio_foil_id_for_edition's comment) has no toggle
        # (curio above stays None, same as an ordinary edition), but its one
        # and only product ID still IS that Curio Foil's — flagging it lets
        # the frontend label the (single, non-toggled) product ID field and
        # Sales/Listings the same way toggled-on curio view would, without
        # actually offering anything to toggle.
        curio_only = bool(_curio_foil_id(edition_info.get("foils", {}))) and not curio_foil_id
        curio = None
        if curio_foil_id:
            foil_info = next(
                f for f in edition_info.get("foils", {}).values() if curio_foil_id in f.get("variants", {})
            )
            curio_override = edition_ids.get("foils", {}).get(curio_foil_id, {})
            curio = {
                "foil_id": curio_foil_id,
                "kind": foil_info["variants"][curio_foil_id].get("kind", ""),
                "product_id": curio_override.get("product_id"),
                # The Curio Foil's own product page is scraped independently
                # from the edition's regular one, with its own separate
                # per-marketplace clocks — sourced from the same get_all_ids()
                # read already loaded above, no extra I/O.
                "clocks": _scrape_clocks(curio_override),
            }

        results.append({
            "edition_id": edition_id,
            "card_id": card_id,
            "name": name_by_card_id.get(card_id, "Unknown"),
            "rarity": RARITY_MAP.get(edition_info.get("rarity")),
            "set_prefix": edition_info.get("set_prefix"),
            "set_name": edition_info.get("set_name"),
            "collector_number": collector_map.get(edition_id),
            "product_id": edition_ids.get("product_id"),
            "clocks": _scrape_clocks(edition_ids),
            # The edition's own release/last-synced dates (from the Grand
            # Archive API, cached in JSON_INFO — see the sync logic in
            # api_ga.py) — shown in the Cards section's Info sub-view instead
            # of the pricing-scrape timestamps above (see
            # renderAdminPricingImageCol in admin.js).
            "release_date": edition_info.get("date_release"),
            "last_updated": edition_info.get("date_update"),
            "created_date": edition_info.get("date_created"),
            "illustrator": edition_info.get("illustrator"),
            "system_updated": system_update_data.get(card_id),
            "curio": curio,
            "curio_only": curio_only,
        })

    results.sort(key=lambda r: (r["name"], r["set_prefix"] or ""))

    # local_db drives whether the Pricing page shows its live TCGPlayer
    # controls (Refresh Sales/Listings/Selected and the per-row 🔍 auto
    # product-ID buttons) — those need a headless Chromium that hosted boxes
    # like Railway can't provide, independent of the storage mode. Gated
    # client-side (see updateAdminPidRefreshButton / adminPidProductIdFieldHtml
    # in admin.js). database_mode is still sent for the other mode-dependent
    # bits of the Pricing UI.
    return JSONResponse({
        "editions": results,
        "database_mode": is_db_mode(),
        "local_db": bool(load_settings().get("local_db", True)),
    })


# Plain read of whatever was last recorded (see the /refresh endpoint below)
# — no live call to api.gatcg.com. Used to group the Cards section's Info
# sub-view's Sets panel by Featured/Other on load, without re-checking the
# external API every time an admin just opens the page.
@app.get("/api/admin/featured-sets")
async def api_admin_featured_sets(request: Request):
    require_admin(request)

    featured = load_featured_sets_data()

    return JSONResponse({"featured": featured})


# Read-only view of _set_search_cache (kept in sync with JSON_SET_SEARCHES —
# see its own comment near _set_search_cache's definition) — feeds the Admin
# Cards Info panel's per-set "already searched" indicator. The actual search
# itself reuses /api/sets/search/start (the same job the Cards page's own
# "$prefix" search already starts), not a separate admin-only endpoint.
@app.get("/api/admin/set-searches")
async def api_admin_set_searches(request: Request):
    require_admin(request)

    searches = load_set_searches_data() if is_db_mode() else _set_search_cache
    return JSONResponse({"searches": searches})


# Admin-entered tcgcsv.com Group ID for a set (see api_tcgplayer.py's
# scraping — this is manual for now, no group-id-based lookup wired up yet).
# JSON mode stores it in the same SET_SEARCHES.json entry as last_searched
# (per-slug, so it's set even for a slug that hasn't been set-searched yet);
# DB mode writes sets.tcgplayer_group_id directly (see set_group_id in
# api_ga.py) so it lands in the actual backing store, not a file the DB-mode
# app never reads.
@app.patch("/api/admin/set-searches/{slug}")
async def api_admin_set_group_id(slug: str, request: Request):
    require_admin(request)

    body = await request.json()
    group_id = body.get("tcgplayer_group_id", "").strip()

    if group_id and not group_id.isdigit():
        raise HTTPException(status_code=400, detail="TCGplayer Group ID must be numeric")

    slug = slug.strip().lower().replace(" ", "_")

    if is_db_mode():
        set_group_id(slug, group_id or None)
    else:
        entry = _set_search_cache.setdefault(slug, {})
        if group_id:
            entry["tcgplayer_group_id"] = group_id
        else:
            entry.pop("tcgplayer_group_id", None)

        with new_json(JSON_SET_SEARCHES).open("w", encoding="utf-8") as f:
            json.dump(_set_search_cache, f, indent=4)

    return JSONResponse({"slug": slug, "tcgplayer_group_id": group_id or None})


# Backfills product IDs for every edition in one set from tcgcsv.com (see
# import_product_ids_from_tcgcsv in pricing_ga.py), using its admin-entered
# Group ID (see api_admin_set_group_id above). Runs synchronously rather than
# as a background job like set-search/find-product-ids — it's a single tcgcsv
# fetch plus local catalog matching, no Playwright browser involved, so it's
# fast enough not to need polling.
@app.post("/api/admin/set-searches/{slug}/import-tcgcsv")
async def api_admin_import_tcgcsv(slug: str, request: Request):
    require_admin(request)

    slug = slug.strip().lower().replace(" ", "_")
    if is_db_mode():
        group_id = load_set_searches_data().get(slug, {}).get("tcgplayer_group_id")
    else:
        group_id = _set_search_cache.get(slug, {}).get("tcgplayer_group_id")

    if not group_id:
        raise HTTPException(status_code=400, detail="No TCGplayer Group ID set for this set")

    has_local_set = bool(load_set_collector_data(slug)) if is_db_mode() \
        else os.path.exists(f"{DIR_SETS}/{slug}.json")
    if not has_local_set:
        raise HTTPException(status_code=400, detail="This set hasn't been set-searched locally yet")

    try:
        result = import_product_ids_from_tcgcsv(slug, group_id)
    except requests.exceptions.RequestException:
        raise HTTPException(status_code=502, detail="Failed to reach tcgcsv.com")
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))

    return JSONResponse(result)


# Wipes every saved TCGPlayer product ID (main and Curio Foil override alike)
# for editions in one set (see clear_product_ids_for_set in pricing_ga.py) —
# the "start over" counterpart to the Import button above, for when a batch
# of IDs turns out wrong (a tcgcsv mismatch, a stale Playwright auto-detect,
# a manual typo) and needs to be rechecked from scratch rather than fixed one
# card at a time. Doesn't require a Group ID or even a set-searched local
# copy — there's nothing here that depends on either, just whatever's
# already in ID_TCGPLAYER.json for this set's editions.
@app.post("/api/admin/set-searches/{slug}/clear-product-ids")
async def api_admin_clear_set_product_ids(slug: str, request: Request):
    require_admin(request)

    slug = slug.strip().lower().replace(" ", "_")

    if not os.path.exists(f"{DIR_SETS}/{slug}.json"):
        raise HTTPException(status_code=400, detail="This set hasn't been set-searched locally yet")

    result = clear_product_ids_for_set(slug)
    return JSONResponse(result)


# Fetches api.gatcg.com's current Featured Sets list and records which local
# set prefixes belong to one (see sync_featured_sets in api_ga.py) — a manual
# admin-triggered check rather than something run automatically, since
# Featured Sets change infrequently (new set releases).
@app.post("/api/admin/featured-sets/refresh")
async def api_admin_featured_sets_refresh(request: Request):
    require_admin(request)

    try:
        featured = sync_featured_sets()
    except requests.exceptions.RequestException:
        raise HTTPException(status_code=502, detail="Failed to reach the Grand Archive API.")

    return JSONResponse({"featured": featured})


@app.post("/api/admin/pricing/product-id")
async def api_admin_set_product_id(request: Request):
    require_admin(request)

    body = await request.json()
    edition_id = body.get("edition_id", "").strip()
    foil_id = body.get("foil_id", "").strip() or None
    product_id = body.get("product_id", "").strip()

    if not edition_id:
        raise HTTPException(status_code=400, detail="edition_id is required")

    if product_id and product_id != NO_LISTINGS_SENTINEL and not product_id.isdigit():
        raise HTTPException(status_code=400, detail=f'Product ID must be numeric, or "{NO_LISTINGS_SENTINEL}" for no listings')

    editions_data = load_editions_data()

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    # foil_id is present when this saves a foil-specific override (e.g. a
    # Curio Foil's own separate TCGPlayer product) rather than the edition's
    # main product ID.
    if foil_id:
        set_foil_product_id(edition_id, foil_id, product_id)
    else:
        set_product_id(edition_id, product_id)

    return JSONResponse({"edition_id": edition_id, "foil_id": foil_id, "product_id": product_id})


@app.post("/api/admin/pricing/clear-last-updated")
async def api_admin_clear_last_updated(request: Request):
    require_admin(request)

    body = await request.json()
    edition_id = body.get("edition_id", "").strip()
    foil_id = body.get("foil_id", "").strip() or None
    field = body.get("field", "")
    marketplace = body.get("marketplace", "").strip()

    if not edition_id:
        raise HTTPException(status_code=400, detail="edition_id is required")

    if field not in ("sales", "listings"):
        raise HTTPException(status_code=400, detail="field must be 'sales' or 'listings'")

    if marketplace not in MARKETPLACES:
        raise HTTPException(status_code=400, detail=f"marketplace must be one of {list(MARKETPLACES)}")

    editions_data = load_editions_data()

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    # foil_id present clears a Curio Foil's own separate clock instead of the
    # edition's main one — mirrors the product-id endpoint above. Only the
    # given marketplace's clock is cleared.
    if foil_id:
        clear_foil_last_scraped(edition_id, foil_id, field, marketplace)
    else:
        clear_last_scraped(edition_id, field, marketplace)

    return JSONResponse({"ok": True})


@app.get("/api/admin/pricing/{edition_id}/history")
async def api_admin_pricing_history(edition_id: str, request: Request):
    require_admin(request)

    editions_data = load_editions_data()

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    card_id = editions_data[edition_id]["card_id"]

    info_data = load_info_data()

    foils = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {}).get("foils", {})
    foil_kind_by_id = {}

    for foil_id, foil_info in foils.items():
        foil_kind_by_id[foil_id] = foil_info.get("kind")

        for variant_id, variant_info in foil_info.get("variants", {}).items():
            foil_kind_by_id[variant_id] = variant_info.get("kind")

    def _flatten(store):
        by_foil = store.get(card_id, {}).get(edition_id, {})
        entries = []

        for foil_id, records in by_foil.items():
            for index, record in enumerate(records):
                entries.append({
                    **record,
                    "foil_kind": foil_kind_by_id.get(foil_id, ""),
                    "foil_id": foil_id,
                    "index": index,
                })

        entries.sort(key=lambda r: r["date"], reverse=True)
        return entries

    edition_info = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {})
    curio_foil_id = _curio_foil_id_for_edition(edition_info)

    # Per-marketplace {marketplace: "YYYY-MM-DD"} maps — the frontend shows the
    # value for whichever marketplace the scope pill is on.
    return JSONResponse({
        "sales": _flatten(load_sales_data()),
        "listings": _flatten(load_listings_data()),
        "last_sales": get_last_scraped_map(edition_id, "sales"),
        "last_listings": get_last_scraped_map(edition_id, "listings"),
        "curio_last_sales": get_foil_last_scraped_map(edition_id, curio_foil_id, "sales") if curio_foil_id else {},
        "curio_last_listings": get_foil_last_scraped_map(edition_id, curio_foil_id, "listings") if curio_foil_id else {},
    })


# Forces a full re-fetch of the card an edition belongs to (see card_reset in
# api_ga.py) — bypasses UPDATE_THRESHOLD's normal "don't re-check for 30
# days" staleness window entirely, deletes its cached images first so stale
# ones can't linger if the API's own art changed, and re-syncs everything
# (rarity/dates/illustrator/rules/thema/etc.), not just pricing. Routed by
# edition_id (matching this file's other per-edition admin endpoints) rather
# than trusting a client-supplied card name, since card_reset needs one to
# look up the card by slug.
@app.post("/api/admin/pricing/{edition_id}/refresh-card")
async def api_admin_refresh_card(edition_id: str, request: Request):
    require_admin(request)

    editions_data = load_editions_data()

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    card_id = editions_data[edition_id]["card_id"]

    slugs_data = load_slugs_data()

    card_name = next((entry["name"] for entry in slugs_data.values() if entry["card_id"] == card_id), None)

    if not card_name:
        raise HTTPException(status_code=404, detail="Card not found")

    result = card_reset(card_name)

    if not result:
        raise HTTPException(status_code=502, detail="Card not found on the Grand Archive API.")

    return JSONResponse({"ok": True, "name": result.get("name", card_name)})


@app.get("/api/admin/pricing/{edition_id}/foils")
async def api_admin_pricing_foils(edition_id: str, request: Request):
    require_admin(request)

    editions_data = load_editions_data()

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    card_id = editions_data[edition_id]["card_id"]

    info_data = load_info_data()

    foils = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {}).get("foils", {})
    overrides = get_foil_overrides(edition_id)
    options = []

    for foil_id, foil_info in foils.items():
        population = foil_info.get("population")
        variant_population = sum(v.get("population", 0) for v in foil_info.get("variants", {}).values())
        remaining_population = None if population is None else population - variant_population

        # A None population means the API hasn't reported circulation data yet
        # (a TEMP_FOIL_ID placeholder edition) — still offer it, matching
        # _sync_info in pricing_ga.py and the inventory foil picker.
        if remaining_population is None or remaining_population > 0:
            options.append({
                "foil_id": foil_id,
                "kind": foil_info.get("kind", "").title(),
                "is_variant": False,
                "product_id": None,
                "population": remaining_population,
            })

        for variant_id, variant_info in foil_info.get("variants", {}).items():
            options.append({
                "foil_id": variant_id,
                "kind": variant_info.get("kind", ""),
                "is_variant": True,
                "product_id": overrides.get(variant_id, {}).get("product_id"),
                # A variant (e.g. a Curio Foil) nests under exactly one
                # top-level foil — its printing is whatever THAT parent's
                # kind is (almost always FOIL in practice, but this reads
                # the real data rather than assuming), not something the
                # variant has its own independent Nonfoil/Foil split for.
                "parent_kind": foil_info.get("kind", "").title(),
                "population": variant_info.get("population", 0),
            })

    return JSONResponse({"foils": options})


@app.post("/api/admin/pricing/{edition_id}/entry")
async def api_admin_pricing_add_entry(edition_id: str, request: Request):
    require_admin(request)

    editions_data = load_editions_data()

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    body = await request.json()
    entry_type = body.get("type")
    foil_id = body.get("foil_id", "").strip()
    marketplace = body.get("marketplace", "").strip() or "Manual"
    condition = body.get("condition", "").strip()
    entry_date = body.get("date", "").strip()

    if entry_type not in ("sales", "listings"):
        raise HTTPException(status_code=400, detail="type must be 'sales' or 'listings'")

    if marketplace not in MARKETPLACES:
        raise HTTPException(status_code=400, detail=f"marketplace must be one of {list(MARKETPLACES)}")

    if not foil_id:
        raise HTTPException(status_code=400, detail="foil_id is required")

    try:
        price = float(body.get("price"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="price must be a number")

    try:
        quantity = int(body.get("quantity") or 1)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="quantity must be a whole number")

    if price < 0 or quantity < 1:
        raise HTTPException(status_code=400, detail="price must be non-negative and quantity at least 1")

    if entry_date:
        try:
            parsed_date = date.fromisoformat(entry_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")

        if parsed_date > date.today():
            raise HTTPException(status_code=400, detail="date cannot be in the future")
    else:
        entry_date = None

    try:
        entry = add_manual_entry(edition_id, foil_id, entry_type, price, quantity, condition, marketplace, entry_date)
    except KeyError:
        raise HTTPException(status_code=400, detail="Invalid foil_id for this edition")

    return JSONResponse({"ok": True, "entry": entry})


@app.delete("/api/admin/pricing/{edition_id}/entry")
async def api_admin_pricing_delete_entry(edition_id: str, request: Request):
    require_admin(request)

    body = await request.json()
    entry_type = body.get("entry_type")
    foil_id = body.get("foil_id", "").strip()
    index = body.get("index")

    if not foil_id or index is None:
        raise HTTPException(status_code=400, detail="foil_id and index are required")

    try:
        index = int(index)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="index must be a whole number")

    result = delete_entry(edition_id, foil_id, entry_type, index)

    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])

    return JSONResponse({"ok": True})


@app.post("/api/admin/pricing/{edition_id}/import-sales")
async def api_admin_pricing_import_sales(edition_id: str, request: Request):
    require_admin(request)

    editions_data = load_editions_data()

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    body = await request.json()
    raw_text = body.get("text", "")
    foil_id = body.get("foil_id", "").strip() or None

    if not raw_text.strip():
        raise HTTPException(status_code=400, detail="Pasted text is required")

    result = import_pasted_sales_tcg_by_edition(edition_id, raw_text, foil_id=foil_id)

    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])

    return JSONResponse(result)


@app.post("/api/admin/pricing/{edition_id}/import-gal")
async def api_admin_pricing_import_gal(edition_id: str, request: Request):
    require_admin(request)

    editions_data = load_editions_data()

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    body = await request.json()
    doc = body.get("data")

    if not isinstance(doc, dict):
        raise HTTPException(status_code=400, detail="data must be a GAL pricing document")

    result = import_gal_pricing(edition_id, doc)

    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])

    return JSONResponse(result)


@app.get("/api/sets/search")
async def api_sets_search(prefix: str):
    set_filter = prefix.strip().lower().replace(" ", "_")
    set_data = load_set_collector_data(set_filter)

    if not set_data:
        return JSONResponse({"cards": []})

    slug_data = load_slugs_data()
    edition_data = load_editions_data()
    info_data = load_info_data()
    sales_data = load_sales_data()

    cards = []

    for collector_number, eids in set_data.items():
        if isinstance(eids, str):
            eids = [eids]

        for edition_id in eids:
            card_id = edition_data.get(edition_id, {}).get("card_id")

            if not card_id:
                continue

            slug_entry = next(
                (data for data in slug_data.values() if data["card_id"] == card_id),
                None
            )

            if not slug_entry:
                continue

            card_info = info_data.get(card_id, {})
            edition_info = card_info.get("editions", {}).get(edition_id, {})
            rarity = edition_info.get("rarity")

            cards.append({
                "card_id": card_id,
                "edition_id": edition_id,
                "name": slug_entry["name"],
                "rarity": rarity,
                "element": card_info.get("element") or "",
                "collector_number": collector_number,
                "last_price": _last_sale_price(sales_data, card_id, edition_id, edition_info.get("foils", {})),
            })

    return JSONResponse({"cards": cards})


@app.post("/api/login")
async def api_login(username: str = Form(...), password: str = Form("")):
    # password defaults to "" — FastAPI's Form(...) rejects an empty field as
    # missing, and an account whose password an admin reset logs in blank.
    user = user_login(username, password)

    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = create_token(username)

    resp = JSONResponse({
        "username": username,
        "auth_type": get_user_auth_type(username),
        **user_needs_setup(username),
    })
    resp.set_cookie(
        key="token",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=JWT_EXPIRE_MINUTES * 60
    )
    return resp


@app.post("/api/logout")
async def api_logout():
    resp = JSONResponse({"message": "Logged out"})
    resp.delete_cookie("token")
    return resp


@app.post("/api/register")
async def api_register(
    username: str = Form(...),
    password: str = Form(...),
    omnidex_id: str = Form(...),
):
    omnidex_id = omnidex_id.strip()

    if not _OMNIDEX_ID_RE.match(omnidex_id):
        raise HTTPException(status_code=400, detail="Omnidex ID must be a number (up to 20 digits)")

    try:
        user_create(username, password, omnidex_id=omnidex_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return await api_login(username=username, password=password)


# _download_card_image/_download_set_image (api_ga.py) hit api.gatcg.com with
# a plain synchronous `requests` call — calling either directly from an async
# route handler runs that blocking network wait right on the single asyncio
# event loop thread, freezing EVERY other request the server is handling
# (unrelated ones included) for as long as that one download takes. A burst of
# lazy image loads sharing one uncached page (e.g. opening the drawer with
# several editions never fetched before) serializes completely and reads as
# the whole app stalling. Routed through a small dedicated thread pool
# instead: two workers so a slow download doesn't queue behind a single lane,
# but still bounded rather than one thread per request (an unbounded burst
# could otherwise fork off dozens of simultaneous outbound connections) —
# anything beyond two just waits its turn in the pool's own queue.
_IMAGE_DOWNLOAD_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="image-download")


async def _run_blocking(func, *args):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_IMAGE_DOWNLOAD_EXECUTOR, func, *args)


@app.get("/images/{edition_id}.jpg")
async def get_image(edition_id: str):
    # The API's own image filename is always just "{edition_id}.jpg" (verified
    # against its /cards/{slug} responses), so this redirect needs no lookup —
    # with store_images_locally off, every card's image is served straight
    # from the API instead of the (in that mode, never-populated) local cache.
    if not load_settings().get("store_images_locally", False):
        return RedirectResponse(f"{API_IMAGE}{edition_id}.jpg")

    path = f"DATA_GA/IMAGES_GA/{edition_id}.jpg"

    # Card search/sync no longer download images themselves (see
    # _download_card_image's own comment in api_ga.py) — the first request
    # for a given edition's image is what fills DIR_IMAGES in, here.
    if not os.path.exists(path) and not await _run_blocking(_download_card_image, edition_id):
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(path)


# Serves a featured-set release banner, downloaded on demand by
# _download_set_image (api_ga.py) the first time it's requested — filename is
# whatever _group_slug(group_name) resolves to (e.g. "RDO.png"), same as
# get_image above keys off the edition_id filename. Unlike card art, this
# filename doesn't reliably map back to the API's own image path (see
# _download_set_image's own comment), so it's looked up from
# JSON_FEATURED_SETS's "image_path" (recorded by sync_featured_sets) by
# matching each group's own slug against this filename — needed either way,
# whether that lookup ends up feeding a redirect or a download.
@app.get("/set-images/{filename}")
async def get_set_image(filename: str):
    featured = load_featured_sets_data()

    image_path = next(
        (
            group_data["image_path"]
            for group_name, group_data in featured.items()
            if group_data.get("image_path") and f"{_group_slug(group_name)}.png" == filename
        ),
        None,
    )

    if not load_settings().get("store_images_locally", False):
        if not image_path:
            raise HTTPException(status_code=404, detail="Image not found")

        return RedirectResponse(f"{API_HOST}{image_path}")

    path = f"DATA_GA/IMAGES_SETS_GA/{filename}"

    if not os.path.exists(path) and not (image_path and await _run_blocking(_download_set_image, filename, image_path)):
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(path)


@app.get("/decks_ga", response_class=HTMLResponse)
async def decks_ga_page():
    return serve_index()


@app.get("/inventory", response_class=HTMLResponse)
async def inventory_page():
    return serve_index()


@app.get("/profile", response_class=HTMLResponse)
async def profile_page():
    return serve_index()


# The public profile is a client-side hash route — /#<omnidex_id> — so it
# needs no server route: the "#" fragment never reaches the server, and any
# "/" load already serves the SPA shell. app.js reads the hash and renders it.


@app.get("/admin", response_class=HTMLResponse)
async def admin_page():
    return serve_index()


# Deep links into the Admin page's own section/sub-view (see the routes
# table in app.js and initAdmin() in admin.js, which reads the pathname back
# out to land on the right one) — same shell as /admin above, the client
# router picks the actual state up from the URL once index.html loads.
@app.get("/admin/cards", response_class=HTMLResponse)
async def admin_cards_page():
    return serve_index()


@app.get("/admin/cards/info", response_class=HTMLResponse)
async def admin_cards_info_page():
    return serve_index()


@app.get("/admin/cards/pricing", response_class=HTMLResponse)
async def admin_cards_pricing_page():
    return serve_index()


@app.get("/admin/users", response_class=HTMLResponse)
async def admin_users_page():
    return serve_index()


@app.get("/admin/system", response_class=HTMLResponse)
async def admin_system_page():
    return serve_index()


@app.get("/fragments/cards", response_class=HTMLResponse)
async def fragment_cards():
    with open("templates/cards.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/collection", response_class=HTMLResponse)
async def fragment_collection():
    with open("templates/collection.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/decks", response_class=HTMLResponse)
async def fragment_decks():
    with open("templates/decks.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/decks_ga", response_class=HTMLResponse)
async def fragment_decks_ga():
    with open("templates/decks_ga.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/home", response_class=HTMLResponse)
async def fragment_home():
    with open("templates/home.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/inventory", response_class=HTMLResponse)
async def fragment_inventory():
    with open("templates/inventory.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/admin", response_class=HTMLResponse)
async def fragment_admin():
    with open("templates/admin.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/login", response_class=HTMLResponse)
async def fragment_login():
    with open("templates/login.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/prices", response_class=HTMLResponse)
async def fragment_prices():
    with open("templates/prices.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/profile", response_class=HTMLResponse)
async def fragment_profile():
    with open("templates/profile.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


# ════════════════════════════════════════
# ── Watchlist API ──
# ════════════════════════════════════════

def _price_and_change(sales_data: dict, card_id: str, edition_id: str, foil_id: str):
    """Returns (last_price, change_pct, last_sale_date) from a foil's sale
    history — change_pct compares the latest sale to the one before it, like
    a stock's move since its previous trade."""
    records = sales_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])

    if not records:
        return None, None, None

    ordered = sorted(records, key=lambda r: r["date"], reverse=True)
    last_price = ordered[0]["price"]
    last_sale_date = ordered[0]["date"]
    change_pct = None

    if len(ordered) > 1 and ordered[1]["price"]:
        change_pct = round((last_price - ordered[1]["price"]) / ordered[1]["price"] * 100, 2)

    return last_price, change_pct, last_sale_date


@app.get("/api/watchlist")
async def api_watchlist_list(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    rows = watchlist_list(user)

    editions_data = load_editions_data()
    info_data = load_info_data()
    slugs_data = load_slugs_data()

    sales_data = load_sales_data()
    listings_data = load_listings_data()

    name_by_card_id = {entry["card_id"]: entry["name"] for entry in slugs_data.values()}
    collector_map = _build_collector_map()

    results = []

    for card_id, edition_id, foil_id, added in rows:
        if edition_id not in editions_data:
            continue

        edition_info = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {})
        foils = edition_info.get("foils", {})

        last_price, change_pct, last_sale_date = _price_and_change(sales_data, card_id, edition_id, foil_id)
        listing_records = listings_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])
        lowest_listing = _lowest_listing_price_from_records(listing_records)

        results.append({
            "card_id": card_id,
            "edition_id": edition_id,
            "foil_id": foil_id,
            "name": name_by_card_id.get(card_id, "Unknown"),
            "set_prefix": edition_info.get("set_prefix"),
            "set_name": edition_info.get("set_name"),
            "collector_number": collector_map.get(edition_id),
            "rarity": edition_info.get("rarity"),
            "foil_kind": _foil_kind_for_id(foils, foil_id),
            "price": last_price,
            "change_pct": change_pct,
            "last_sale_date": last_sale_date,
            "lowest_listing": lowest_listing,
            "added": added,
        })

    results.sort(key=lambda r: (r["name"], r["set_prefix"] or ""))

    return JSONResponse({"watchlist": results})


@app.post("/api/watchlist")
async def api_watchlist_add(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    card_id = (body.get("card_id") or "").strip()
    edition_id = (body.get("edition_id") or "").strip()
    foil_id = (body.get("foil_id") or "").strip()

    if not card_id or not edition_id or not foil_id:
        raise HTTPException(status_code=400, detail="card_id, edition_id, and foil_id are required")

    added = watchlist_add(user, card_id, edition_id, foil_id)
    return JSONResponse({"ok": True, "added": added})


@app.delete("/api/watchlist")
async def api_watchlist_delete(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    card_id = (body.get("card_id") or "").strip()
    edition_id = (body.get("edition_id") or "").strip()
    foil_id = (body.get("foil_id") or "").strip()

    if not card_id or not edition_id or not foil_id:
        raise HTTPException(status_code=400, detail="card_id, edition_id, and foil_id are required")

    removed = watchlist_remove(user, card_id, edition_id, foil_id)
    return JSONResponse({"ok": True, "removed": removed})


# ════════════════════════════════════════
# ── Inventory API ──
# ════════════════════════════════════════

DEFAULT_BIN = "Inventory"


def _inv_default_structure() -> dict:
    return {DEFAULT_BIN: {"banner": None, "default": True, "desc": "", "symbol": None, "tags": None, "sections": {}}}


def _inv_load(username: str) -> dict:
    if is_db_mode():
        return _inv_load_db(username)

    inv_file = new_json(f"DATA_GA/INV_GA/{username}.json")
    with inv_file.open("r", encoding="utf-8") as f:
        raw = json.load(f)

    # Empty file → init default structure
    if not raw:
        data = _inv_default_structure()
        _inv_save(username, data)
        return data

    # Old flat UUID-keyed structure → migrate to default bin
    first_val = next(iter(raw.values()), {})
    if isinstance(first_val, dict) and "card_id" in first_val:
        data = _inv_default_structure()
        _inv_save(username, data)
        return data

    # Defensive: every bin must expose a sections dict. Bins from the
    # pre-section schema get an empty one (their legacy "cards" data is
    # intentionally not migrated — the schema cutover was a clean wipe).
    for b in raw.values():
        if isinstance(b, dict) and "sections" not in b:
            b["sections"] = {}

    return raw


def _inv_save(username: str, data: dict) -> None:
    if is_db_mode():
        _inv_save_db(username, data)
        return

    inv_file = new_json(f"DATA_GA/INV_GA/{username}.json")
    with inv_file.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


# DB-mode _inv_load/_inv_save reconstruct/persist the EXACT same nested dict
# shape as the JSON branch ({bin_name: {..., sections: {section_name:
# {card_id: {edition_id: {foil_id: quantity}}}}}}), so every inventory route
# below can keep mutating that plain dict and calling _inv_save — none of
# them need to know which backend is active. _inv_save_db does a full
# delete-and-reinsert of this user's bins on every call rather than diffing,
# mirroring the JSON branch's own "rewrite the whole file every save"
# behavior — bins/sections/cards cascade-delete together (see the FKs in
# db/models.py) so this is one DELETE plus a handful of INSERTs, not N
# separate deletes.
#
# Note: inserting a card here requires that card_id/edition_id/foil_id
# already exist in Postgres's cards/editions/foils tables — which are only
# as fresh as the last scripts/migrate_json_to_pg.py run, since the card
# catalog itself isn't DB-wired yet (a later stage). Adding a card that was
# only just synced into INFO.json via a live API search won't have a row in
# Postgres yet and will fail with a foreign key error until that stage lands
# or the import script is re-run.
def _inv_load_db(username: str) -> dict:
    user_id = user_get_id(username)

    with get_session() as session:
        bins = session.execute(
            select(InventoryBin).where(InventoryBin.user_id == user_id)
        ).scalars().all()

        if not bins:
            data = _inv_default_structure()
            _inv_save_db(username, data)
            return data

        result = {}
        for bin_row in bins:
            sections = session.execute(
                select(InventorySection).where(InventorySection.bin_id == bin_row.id)
                .order_by(InventorySection.position)
            ).scalars().all()

            sections_data = {}
            for section_row in sections:
                cards_data = {}
                inv_cards = session.execute(
                    select(InventoryCard).where(InventoryCard.section_id == section_row.id)
                ).scalars().all()
                for c in inv_cards:
                    cards_data.setdefault(c.card_id, {}).setdefault(c.edition_id, {})[c.foil_id] = c.quantity
                sections_data[section_row.name] = cards_data

            result[bin_row.name] = {
                "banner": bin_row.banner,
                "default": bin_row.is_default,
                "desc": bin_row.desc or "",
                "symbol": bin_row.symbol,
                "tags": bin_row.tags,
                "sections": sections_data,
            }

    return result


def _inv_save_db(username: str, data: dict) -> None:
    user_id = user_get_id(username)

    with get_session() as session:
        session.execute(delete(InventoryBin).where(InventoryBin.user_id == user_id))
        session.flush()

        for bin_name, bin_data in data.items():
            bin_row = InventoryBin(
                user_id=user_id,
                name=bin_name,
                desc=bin_data.get("desc", ""),
                banner=bin_data.get("banner"),
                symbol=bin_data.get("symbol"),
                tags=bin_data.get("tags"),
                is_default=bool(bin_data.get("default")),
            )
            session.add(bin_row)
            session.flush()

            for position, (section_name, cards) in enumerate(bin_data.get("sections", {}).items()):
                section_row = InventorySection(bin_id=bin_row.id, name=section_name, position=position)
                session.add(section_row)
                session.flush()

                for card_id, editions in cards.items():
                    for edition_id, foils in editions.items():
                        for foil_id, quantity in foils.items():
                            session.add(InventoryCard(
                                section_id=section_row.id,
                                card_id=card_id,
                                edition_id=edition_id,
                                foil_id=foil_id,
                                quantity=quantity,
                            ))


@app.get("/api/inventory")
async def api_inventory_get(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return JSONResponse({"bins": _inv_load(user)})


@app.get("/api/inventory/bins/{bin_name}/value")
async def api_bin_value(bin_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    sales_data = load_sales_data()
    listings_data = load_listings_data()

    total = 0.0
    sale_quantity = 0
    listing_quantity = 0
    unpriced_quantity = 0
    total_quantity = 0

    for cards in inv[bin_name].get("sections", {}).values():
        for card_id, editions in cards.items():
            for edition_id, foils in editions.items():
                for foil_id, quantity in foils.items():
                    if quantity <= 0:
                        continue

                    total_quantity += quantity
                    records = sales_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])

                    price = _last_sale_price_from_records(records)
                    if price is not None:
                        sale_quantity += quantity
                    else:
                        listing_records = listings_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])
                        price = _last_listing_price_from_records(listing_records)
                        if price is not None:
                            listing_quantity += quantity

                    if price is None:
                        unpriced_quantity += quantity
                        continue

                    total += price * quantity

    return JSONResponse({
        "total": round(total, 2),
        "priced_quantity": sale_quantity + listing_quantity,
        "total_quantity": total_quantity,
        "sale_quantity": sale_quantity,
        "listing_quantity": listing_quantity,
        "unpriced_quantity": unpriced_quantity,
    })


@app.get("/api/inventory/bins/{bin_name}/prices")
async def api_bin_prices(bin_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    sales_data = load_sales_data()
    listings_data = load_listings_data()

    prices: dict = {}

    for cards in inv[bin_name].get("sections", {}).values():
        for card_id, editions in cards.items():
            for edition_id, foils in editions.items():
                for foil_id in foils:
                    sale_records = sales_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])
                    listing_records = listings_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])
                    last_price = _last_sale_price_from_records(sale_records)
                    lowest_listing = _lowest_listing_price_from_records(listing_records)
                    if last_price is None and lowest_listing is None:
                        continue

                    prices.setdefault(card_id, {}).setdefault(edition_id, {})[foil_id] = {
                        "price": last_price,
                        "lowest_listing": lowest_listing,
                    }

    return JSONResponse(prices)


@app.get("/api/inv/info")
async def api_inv_info():
    return JSONResponse(load_info_data())


@app.get("/api/inv/slugs")
async def api_inv_slugs():
    return JSONResponse(load_slugs_data())


def _api_search_variants(card_name: str):
    """Live API lookup trying slug variants. Our slugs keep intra-word
    hyphens (throne-keeper-bullfrog) but some official GATCG slugs drop
    them (thronekeeper-bullfrog), so retry with hyphens stripped from
    the name before formatting.

    When an alternate slug hits, the card must ALSO be registered under
    our canonical slug — api_ga stores whichever slug the fetch used, and
    every local lookup afterward searches by the canonical one."""
    canonical = _format_search(card_name)
    candidates = [canonical]
    dehyphenated = _format_search(card_name.replace("-", ""))
    if dehyphenated not in candidates:
        candidates.append(dehyphenated)
    for slug in candidates:
        result = _api_search(slug)
        if result:
            if slug != canonical:
                _update_slug(canonical, result)
            return result
    return None


@app.get("/api/inv/collector")
async def api_inv_collector():
    return JSONResponse(_build_collector_map())


# ── Import / Export ──

@app.get("/api/inventory/bins/{bin_name}/export")
async def api_bin_export(bin_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    info_data = load_info_data()
    slug_data = load_slugs_data()

    # Build edition_id → collector_number map
    collector_map = _build_collector_map()

    # Build card_id → name map
    name_map = {data["card_id"]: data["name"] for data in slug_data.values()}

    lines = []
    for section_name, cards in inv[bin_name].get("sections", {}).items():
        if not cards:
            continue
        lines.append(f"# {section_name}")
        lines.extend(_bin_export_section_lines(cards, info_data, name_map, collector_map))
        lines.append("")

    return JSONResponse({"lines": [ln for ln in lines[:-1]] if lines else []})


def _bin_export_section_lines(cards: dict, info_data: dict, name_map: dict, collector_map: dict) -> list:
    lines = []
    for card_id, editions in cards.items():
        card_name = name_map.get(card_id, card_id)
        card_info = info_data.get(card_id, {})

        for edition_id, foils in editions.items():
            edition_info = card_info.get("editions", {}).get(edition_id, {})
            set_prefix = edition_info.get("set_prefix", "?")
            collector_number = collector_map.get(edition_id, "?")
            foils_info = edition_info.get("foils", {})

            for foil_id, quantity in foils.items():
                if quantity <= 0:
                    continue

                # Resolve foil kind label
                foil_kind = "Nonfoil"
                if foil_id in foils_info:
                    foil_kind = toFoilLabel(foils_info[foil_id].get("kind", "nonfoil"))
                else:
                    for finfo in foils_info.values():
                        if foil_id in finfo.get("variants", {}):
                            foil_kind = toFoilLabel(finfo["variants"][foil_id].get("kind", ""))
                            break

                lines.append(f"{quantity}x {card_name} ({set_prefix}) #{collector_number} {foil_kind}")

    return lines


def toFoilLabel(s: str) -> str:
    return s.lower().replace("_", " ").title() if s else ""


_BIN_IMPORT_LINE_RE = re.compile(
    r'^(\d+)[xX]\s+(.+?)\s+\(([^)]+)\)(?:\s+#(\S+))?\s*(.*)?$'
)


def _bin_import_build_set_collector_map() -> dict:
    """set_prefix → { collector_number → [edition_id] }"""
    return load_all_set_collector_data()


def _bin_import_resolve_line(raw_line: str, info_data: dict, slug_data: dict, set_collector_map: dict) -> dict:
    """
    Attempt to resolve a single bin-import line against already-loaded local data.
    Returns a dict describing either a resolved insert (card_id/edition_id/foil_id/quantity)
    or a failure (error), or a "needs_lookup" case where the card name isn't known locally yet.
    """
    line = raw_line.strip()
    if not line:
        return {"line": raw_line, "ok": False, "error": "Empty line"}

    m = _BIN_IMPORT_LINE_RE.match(line)
    if not m:
        return {"line": raw_line, "ok": False, "error": "Could not parse line"}

    qty_str, card_name, set_prefix, collector_number, foil_kind_raw = m.groups()
    quantity = int(qty_str)
    card_name = card_name.strip()
    set_prefix = set_prefix.strip().upper()
    foil_kind_raw = (foil_kind_raw or "").strip().lower()
    if not foil_kind_raw:
        foil_kind_raw = "nonfoil"

    slug = _format_search(card_name)
    card_id = slug_data[slug]["card_id"] if slug in slug_data else None
    if not card_id:
        return {
            "line": raw_line, "ok": False, "needs_lookup": True,
            "name": card_name, "slug": slug, "quantity": quantity,
            "set_prefix": set_prefix, "collector_number": collector_number,
            "foil_kind_raw": foil_kind_raw
        }

    card_info = info_data.get(card_id, {})
    all_editions = card_info.get("editions", {})

    # Resolve edition_id
    edition_id = None
    if collector_number and set_prefix in set_collector_map:
        eids = set_collector_map[set_prefix].get(collector_number, [])
        for eid in eids:
            if eid in all_editions:
                edition_id = eid
                break

    if not edition_id:
        for eid, einfo in all_editions.items():
            if einfo.get("set_prefix", "").upper() == set_prefix:
                edition_id = eid
                break

    if not edition_id:
        return {"line": raw_line, "ok": False, "error": f"Edition not found: {set_prefix}"}

    # Resolve foil_id — normalize underscores/spaces so kinds like
    # "ghost_foil" match their exported "Ghost Foil" label round-trip
    def _norm_kind(s):
        return (s or "").strip().lower().replace("_", " ")

    foil_kind_norm = _norm_kind(foil_kind_raw)
    edition_foils = all_editions[edition_id].get("foils", {})
    foil_id = None

    for fid, finfo in edition_foils.items():
        kind = _norm_kind(finfo.get("kind"))
        if foil_kind_norm in ("nonfoil", "normal") and kind in ("nonfoil", "normal"):
            foil_id = fid
            break
        if kind == foil_kind_norm:
            foil_id = fid
            break
        for vid, vinfo in finfo.get("variants", {}).items():
            if _norm_kind(vinfo.get("kind")) == foil_kind_norm:
                foil_id = vid
                break
        if foil_id:
            break

    if not foil_id and edition_foils:
        def foil_priority(item):
            k = item[1].get("kind", "").lower()
            if k in ("nonfoil", "normal"):
                return 0
            if k == "foil":
                return 1
            return 2

        foil_id = sorted(edition_foils.items(), key=foil_priority)[0][0]

    if not foil_id:
        return {"line": raw_line, "ok": False, "error": "No foil type found"}

    return {
        "line": raw_line, "ok": True,
        "card_id": card_id, "edition_id": edition_id, "foil_id": foil_id,
        "quantity": quantity
    }


@app.post("/api/inventory/bins/{bin_name}/import/parse")
async def api_bin_import_parse(bin_name: str, request: Request):
    """Parse import text. Returns resolved inserts (local match) and unresolved (need API lookup)."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    lines = body.get("lines", [])

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    info_data = load_info_data()
    slug_data = load_slugs_data()

    set_collector_map = _bin_import_build_set_collector_map()

    resolved = []
    unresolved = []
    failed = []
    current_section = "Imported"

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            current_section = line.lstrip("#").strip() or current_section
            continue
        result = _bin_import_resolve_line(raw_line, info_data, slug_data, set_collector_map)
        result["section"] = current_section
        if result.get("ok"):
            resolved.append(result)
        elif result.get("needs_lookup"):
            unresolved.append(result)
        else:
            failed.append(result)

    return JSONResponse({"resolved": resolved, "unresolved": unresolved, "failed": failed})


@app.post("/api/inventory/bins/{bin_name}/import/commit")
async def api_bin_import_commit(bin_name: str, request: Request):
    """Add a batch of already-resolved inserts to the bin."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    inserts = body.get("inserts", [])  # [{card_id, edition_id, foil_id, quantity}]

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    sections = inv[bin_name]["sections"]

    for item in inserts:
        card_id = item.get("card_id")
        edition_id = item.get("edition_id")
        foil_id = item.get("foil_id")
        quantity = int(item.get("quantity", 1))
        section = item.get("section", "Imported").strip() or "Imported"
        if not card_id or not edition_id or not foil_id:
            continue
        cards = sections.setdefault(section, {})
        cards.setdefault(card_id, {}).setdefault(edition_id, {})
        existing = cards[card_id][edition_id].get(foil_id, 0)
        cards[card_id][edition_id][foil_id] = existing + quantity

    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.post("/api/inventory/bins/{bin_name}/import/resolve")
async def api_bin_import_resolve(bin_name: str, request: Request):
    """Resolve a single unrecognized card name via API search, then re-attempt full line resolution."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    raw_line = body.get("line", "")
    slug = body.get("slug", "").strip()

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    if not slug:
        return JSONResponse({"ok": False, "found": False, "line": raw_line, "error": "Missing slug"})

    # Look up by name (with slug variants) — the local store still keys the
    # card under OUR canonical slug regardless of which variant the API needed
    line_match = _BIN_IMPORT_LINE_RE.match(raw_line.strip())
    lookup_name = line_match.group(2).strip() if line_match else slug
    api_result = _api_search_variants(lookup_name)

    info_data = load_info_data()
    slug_data = load_slugs_data()

    if not api_result or slug not in slug_data:
        return JSONResponse({"ok": False, "found": False, "line": raw_line, "error": f"Card not found: {raw_line}"})

    set_collector_map = _bin_import_build_set_collector_map()
    result = _bin_import_resolve_line(raw_line, info_data, slug_data, set_collector_map)

    if not result.get("ok"):
        return JSONResponse(
            {"ok": False, "found": True, "line": raw_line, "error": result.get("error", "Resolution failed")})

    # Commit immediately, same as a single-item resolve
    section = body.get("section", "Imported").strip() or "Imported"
    cards = inv[bin_name]["sections"].setdefault(section, {})
    cards.setdefault(result["card_id"], {}).setdefault(result["edition_id"], {})
    existing = cards[result["card_id"]][result["edition_id"]].get(result["foil_id"], 0)
    cards[result["card_id"]][result["edition_id"]][result["foil_id"]] = existing + result["quantity"]
    _inv_save(user, inv)

    return JSONResponse({"ok": True, "found": True, "line": raw_line})


# ── Bin CRUD ──

@app.post("/api/inventory/bins")
async def api_bin_create(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    name = body.get("name", "").strip()
    desc = body.get("desc", "").strip()

    if not name:
        raise HTTPException(status_code=400, detail="Name is required")

    inv = _inv_load(user)
    if name in inv:
        raise HTTPException(status_code=400, detail="Bin already exists")

    inv[name] = {"banner": None, "default": False, "desc": desc, "symbol": None, "tags": None,
                 "sections": {}}
    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.patch("/api/inventory/bins/{bin_name}")
async def api_bin_patch(bin_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    new_name = body.get("name", "").strip()

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    if new_name and new_name != bin_name:
        if new_name in inv:
            raise HTTPException(status_code=400, detail="Bin name already taken")
        inv[new_name] = inv.pop(bin_name)
        bin_name = new_name

    if "desc" in body:
        inv[bin_name]["desc"] = body.get("desc", "").strip()
    if "banner" in body:
        banner = body["banner"]
        inv[bin_name]["banner"] = banner.strip() if isinstance(banner, str) and banner.strip() else None
    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.post("/api/inventory/bins/{bin_name}/default")
async def api_bin_set_default(bin_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    for name in inv:
        inv[name]["default"] = (name == bin_name)

    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.delete("/api/inventory/bins/{bin_name}")
async def api_bin_delete(bin_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")
    if inv[bin_name].get("default"):
        raise HTTPException(status_code=400, detail="Cannot delete the default bin")

    del inv[bin_name]
    _inv_save(user, inv)
    return JSONResponse({"ok": True})


# ── Card CRUD ──

# ── Bin sections ──

@app.post("/api/inventory/bins/{bin_name}/section")
async def api_bin_section_add(bin_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    section = body.get("section", "").strip()
    if not section:
        raise HTTPException(status_code=400, detail="Section name required")
    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")
    if section in inv[bin_name]["sections"]:
        raise HTTPException(status_code=400, detail="Section already exists")
    inv[bin_name]["sections"][section] = {}
    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.delete("/api/inventory/bins/{bin_name}/section/{section_name}")
async def api_bin_section_delete(bin_name: str, section_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")
    if section_name not in inv[bin_name]["sections"]:
        raise HTTPException(status_code=404, detail="Section not found")
    del inv[bin_name]["sections"][section_name]
    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.patch("/api/inventory/bins/{bin_name}/section/{section_name}/rename")
async def api_bin_section_rename(bin_name: str, section_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    new_name = body.get("name", "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name required")
    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")
    sections = inv[bin_name]["sections"]
    if section_name not in sections:
        raise HTTPException(status_code=404, detail="Section not found")
    if new_name in sections:
        raise HTTPException(status_code=400, detail="Section name already taken")
    # Rebuild dict preserving insertion order
    inv[bin_name]["sections"] = {new_name if k == section_name else k: v for k, v in sections.items()}
    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.post("/api/inventory/card/move")
async def api_inv_card_move(request: Request):
    """Move a card entry (card+edition+foil) between sections of a bin.
    Quantities merge if the same entry already exists in the target."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    bin_name = body.get("bin")
    card_id = body.get("card_id")
    edition_id = body.get("edition_id")
    foil_id = body.get("foil_id")
    from_section = body.get("from_section", "")
    to_section = body.get("to_section", "")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")
    sections = inv[bin_name]["sections"]
    if from_section not in sections or to_section not in sections:
        raise HTTPException(status_code=404, detail="Section not found")

    try:
        src_cards = sections[from_section]
        qty = src_cards[card_id][edition_id].pop(foil_id)
        if not src_cards[card_id][edition_id]: del src_cards[card_id][edition_id]
        if not src_cards[card_id]: del src_cards[card_id]
    except KeyError:
        raise HTTPException(status_code=404, detail="Card entry not found")

    dst = sections[to_section]
    dst.setdefault(card_id, {}).setdefault(edition_id, {})
    dst[card_id][edition_id][foil_id] = dst[card_id][edition_id].get(foil_id, 0) + qty

    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.post("/api/inventory/card")
async def api_card_add(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    bin_name = body.get("bin")
    section = body.get("section", "").strip()
    card_id = body.get("card_id")
    edition_id = body.get("edition_id")
    foil_id = body.get("foil_id")
    quantity = int(body.get("quantity", 1))

    if not all([bin_name, section, card_id, edition_id, foil_id]):
        raise HTTPException(status_code=400, detail="Missing required fields")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    # Section is auto-created so flows like move-to-bin can land cards
    # in a matching section of the target bin without a separate call
    cards = inv[bin_name]["sections"].setdefault(section, {})
    cards.setdefault(card_id, {}).setdefault(edition_id, {})
    existing = cards[card_id][edition_id].get(foil_id, 0)
    cards[card_id][edition_id][foil_id] = existing + quantity

    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.patch("/api/inventory/card")
async def api_card_patch(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    bin_name = body.get("bin")
    section = body.get("section", "").strip()
    card_id = body.get("card_id")
    edition_id = body.get("edition_id")
    foil_id = body.get("foil_id")
    quantity = int(body.get("quantity", 1))

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    try:
        inv[bin_name]["sections"][section][card_id][edition_id][foil_id] = quantity
    except KeyError:
        raise HTTPException(status_code=404, detail="Card entry not found")

    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.delete("/api/inventory/card")
async def api_card_delete(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    bin_name = body.get("bin")
    section = body.get("section", "").strip()
    card_id = body.get("card_id")
    edition_id = body.get("edition_id")
    foil_id = body.get("foil_id")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    try:
        cards = inv[bin_name]["sections"][section]
        del cards[card_id][edition_id][foil_id]
        if not cards[card_id][edition_id]: del cards[card_id][edition_id]
        if not cards[card_id]: del cards[card_id]
        # Empty sections are kept — they're user-managed structure
    except KeyError:
        raise HTTPException(status_code=404, detail="Card entry not found")

    _inv_save(user, inv)
    return JSONResponse({"ok": True})


# ════════════════════════════════════════
# ── Decks GA API ──
# ════════════════════════════════════════

DIR_DECK_INDEX = "DATA_GA/DECK_GA"
DIR_DECKS_GA = "DATA_GA/DECKS_GA"
DEFAULT_SECTIONS = ["Material Deck", "Main Deck"]


def _deck_index_load(username: str) -> dict:
    if is_db_mode():
        return _deck_index_load_db(username)

    path = f"{DIR_DECK_INDEX}/{username}.json"
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _deck_index_save(username: str, data: dict) -> None:
    if is_db_mode():
        _deck_index_save_db(username, data)
        return

    os.makedirs(DIR_DECK_INDEX, exist_ok=True)
    with open(f"{DIR_DECK_INDEX}/{username}.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def _normalize_deck_sections(sections: dict) -> dict:
    """Upgrade a legacy flat {card_id: qty} section into the current row-list
    shape ({"card_id", "edition_id", "foil_id", "quantity"} dicts), so every
    deck consumer can assume the list shape regardless of when the JSON file
    on disk was last saved. Already-normalized sections pass through as-is."""
    normalized = {}
    for name, cards in sections.items():
        if isinstance(cards, dict):
            normalized[name] = [
                {"card_id": card_id, "edition_id": None, "foil_id": None, "quantity": qty}
                for card_id, qty in cards.items()
            ]
        else:
            normalized[name] = cards
    return normalized


def _deck_load(username: str, deck_name: str) -> dict | None:
    if is_db_mode():
        return _deck_load_db(username, deck_name)

    path = f"{DIR_DECKS_GA}/{username}/{deck_name}.json"
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if "sections" in data:
        data["sections"] = _normalize_deck_sections(data["sections"])
    return data


def _deck_save(username: str, deck_name: str, data: dict) -> None:
    if is_db_mode():
        _deck_save_db(username, deck_name, data)
        return

    os.makedirs(f"{DIR_DECKS_GA}/{username}", exist_ok=True)
    with open(f"{DIR_DECKS_GA}/{username}/{deck_name}.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)

    # Any deck-content write bumps the index's last-modified date
    index = _deck_index_load(username)
    if deck_name in index:
        index[deck_name]["modified"] = date.today().isoformat()
        _deck_index_save(username, index)


# DB-mode deck storage. A JSON "deck" is really two documents (a per-user
# index entry — banner/symbol/tags/created/modified — plus a per-deck
# content file — desc/format/sections) that both fold onto ONE `decks` row
# here; deck_sections/deck_cards hold the content. _deck_index_load/_save
# and _deck_load/_save return/accept the exact same dict shapes as the JSON
# branch, so every deck route below stays unchanged — EXCEPT api_deck_patch,
# which needs one explicit DB-mode branch for renaming (see its comment):
# the generic index-save below treats "old name gone, new name present" as
# delete-old-create-new, which would drop the deck's sections/cards — same
# reason the JSON branch doesn't let a generic save handle renaming either,
# and instead calls os.rename() on the file directly.
def _deck_index_load_db(username: str) -> dict:
    user_id = user_get_id(username)

    with get_session() as session:
        rows = session.execute(select(Deck).where(Deck.user_id == user_id)).scalars().all()
        return {
            row.name: {
                "banner": row.banner,
                "symbol": row.symbol,
                "tags": row.tags,
                "public": row.is_public,
                "edition_locked": row.edition_locked,
                "created": row.created_at.isoformat() if row.created_at else None,
                "modified": row.modified_at.isoformat() if row.modified_at else None,
            }
            for row in rows
        }


def _deck_index_save_db(username: str, data: dict) -> None:
    user_id = user_get_id(username)

    with get_session() as session:
        # Decks removed from the index (deck_delete) — cascades to their
        # sections/cards. A rename never reaches here as a deletion; see
        # api_deck_patch's explicit rename-in-place branch.
        keep_names = list(data.keys())
        session.execute(delete(Deck).where(Deck.user_id == user_id, Deck.name.notin_(keep_names)))

        for name, entry in data.items():
            created = date.fromisoformat(entry["created"]) if entry.get("created") else None
            modified = date.fromisoformat(entry["modified"]) if entry.get("modified") else None
            index_fields = {
                "banner": entry.get("banner"), "symbol": entry.get("symbol"), "tags": entry.get("tags"),
                "is_public": entry.get("public", False),
                "edition_locked": entry.get("edition_locked", False),
                "created_at": created, "modified_at": modified,
            }
            stmt = pg_insert(Deck).values(user_id=user_id, name=name, **index_fields).on_conflict_do_update(
                index_elements=["user_id", "name"], set_=index_fields,
            )
            session.execute(stmt)


def _deck_load_db(username: str, deck_name: str) -> dict | None:
    user_id = user_get_id(username)

    with get_session() as session:
        deck_row = session.execute(
            select(Deck).where(Deck.user_id == user_id, Deck.name == deck_name)
        ).scalar_one_or_none()

        if deck_row is None:
            return None

        sections = session.execute(
            select(DeckSection).where(DeckSection.deck_id == deck_row.id).order_by(DeckSection.position)
        ).scalars().all()

        sections_data = {}
        for section_row in sections:
            cards = session.execute(
                select(DeckCard).where(DeckCard.section_id == section_row.id).order_by(DeckCard.position)
            ).scalars().all()
            sections_data[section_row.name] = [
                {"card_id": c.card_id, "edition_id": c.edition_id, "foil_id": c.foil_id, "quantity": c.quantity}
                for c in cards
            ]

        return {"desc": deck_row.desc or "", "format": deck_row.format or "", "sections": sections_data}


def _deck_save_db(username: str, deck_name: str, data: dict) -> None:
    user_id = user_get_id(username)

    with get_session() as session:
        deck_row = session.execute(
            select(Deck).where(Deck.user_id == user_id, Deck.name == deck_name)
        ).scalar_one_or_none()

        today = date.today()

        if deck_row is None:
            # Defensive fallback mirroring the JSON branch's own "deck file
            # missing — rebuild it" case (see api_deck_patch) — every real
            # path creates the index row first, so this shouldn't normally
            # fire.
            deck_row = Deck(user_id=user_id, name=deck_name, created_at=today)
            session.add(deck_row)
            session.flush()

        deck_row.desc = data.get("desc", "")
        deck_row.format = data.get("format", "")
        deck_row.modified_at = today
        session.flush()

        session.execute(delete(DeckSection).where(DeckSection.deck_id == deck_row.id))
        session.flush()

        for position, (section_name, cards) in enumerate(data.get("sections", {}).items()):
            section_row = DeckSection(deck_id=deck_row.id, name=section_name, position=position)
            session.add(section_row)
            session.flush()

            for card_position, row in enumerate(cards):
                session.add(DeckCard(
                    section_id=section_row.id, card_id=row["card_id"],
                    edition_id=row.get("edition_id"), foil_id=row.get("foil_id"),
                    quantity=row["quantity"], position=card_position,
                ))


def _deck_row_find(cards: list[dict], card_id: str, edition_id: str | None, foil_id: str | None) -> dict | None:
    """Find the row for a specific (card_id, edition_id, foil_id) — a bare
    card_id may have several rows in one section, split across editions."""
    return next(
        (r for r in cards if r["card_id"] == card_id
         and r.get("edition_id") == edition_id and r.get("foil_id") == foil_id),
        None,
    )


def _deck_row_add(cards: list[dict], card_id: str, edition_id: str | None, foil_id: str | None, qty: int) -> int:
    """Merge qty into the matching row (creating one if needed), or remove it
    if the merge brings quantity to zero or below. Returns the resulting
    quantity (0 if the row was removed/never created)."""
    row = _deck_row_find(cards, card_id, edition_id, foil_id)
    if row:
        row["quantity"] += qty
        if row["quantity"] <= 0:
            cards.remove(row)
            return 0
        return row["quantity"]
    if qty > 0:
        cards.append({"card_id": card_id, "edition_id": edition_id, "foil_id": foil_id, "quantity": qty})
        return qty
    return 0


def _deck_rows_all_editions(cards: list[dict], card_id: str) -> list[dict]:
    """Every row for card_id regardless of edition/foil."""
    return [r for r in cards if r["card_id"] == card_id]


def _pick_random_printing(card_id: str, info_data: dict) -> tuple[str | None, str | None]:
    """Random (edition_id, foil_id) for a card — used whenever a new deck
    card row needs *some* real printing recorded even though the deck isn't
    Edition Locked (the view just won't surface it while unlocked)."""
    editions = info_data.get(card_id, {}).get("editions", {})
    if not editions:
        return None, None
    eid = random.choice(list(editions.keys()))
    foils = editions[eid].get("foils", {})
    fid = random.choice(list(foils.keys())) if foils else None
    return eid, fid


def _deck_row_add_generic(cards: list[dict], card_id: str, qty: int, info_data: dict) -> int:
    """Add qty of card_id without pinning a printing — reuses any existing
    row for that card_id (whatever printing it already has), or rolls a
    fresh random one if this is the card's first row here. Used for adds
    while not Edition Locked, and for text-import (which never specifies a
    printing either way)."""
    rows = _deck_rows_all_editions(cards, card_id)
    if rows:
        rows[0]["quantity"] += qty
        if rows[0]["quantity"] <= 0:
            cards.remove(rows[0])
            return 0
        return rows[0]["quantity"]
    if qty > 0:
        eid, fid = _pick_random_printing(card_id, info_data)
        cards.append({"card_id": card_id, "edition_id": eid, "foil_id": fid, "quantity": qty})
        return qty
    return 0


def _deck_is_edition_locked(username: str, deck_name: str) -> bool:
    return bool(_deck_index_load(username).get(deck_name, {}).get("edition_locked", False))


def _deck_card_count(sections: dict) -> int:
    return sum(row["quantity"] for cards in sections.values() for row in cards)


def _make_deck_data(desc: str, fmt: str) -> dict:
    return {
        "desc": desc,
        "format": fmt,
        "sections": {s: [] for s in DEFAULT_SECTIONS}
    }


def _deck_detail_payload(deck_data: dict) -> dict:
    slug_data = load_slugs_data()
    info_data = load_info_data()
    name_map = {d["card_id"]: d["name"] for d in slug_data.values()}
    edition_map = {}
    editions_info: dict[str, dict] = {}
    foils_info: dict[str, dict] = {}
    for cards in deck_data["sections"].values():
        for row in cards:
            card_id = row["card_id"]
            if card_id not in edition_map:
                eid = _pick_edition(card_id, info_data)
                if eid:
                    edition_map[card_id] = eid

            eid, fid = row.get("edition_id"), row.get("foil_id")
            if not eid:
                continue
            einfo = info_data.get(card_id, {}).get("editions", {}).get(eid, {})
            if eid not in editions_info:
                editions_info[eid] = {
                    "set_prefix": einfo.get("set_prefix"),
                    "collector_number": einfo.get("collector_number"),
                    "rarity": einfo.get("rarity"),
                }
            if fid and fid not in foils_info:
                foils_info[fid] = {"kind": einfo.get("foils", {}).get(fid, {}).get("kind")}
    return {
        **deck_data, "name_map": name_map, "edition_map": edition_map,
        "editions_info": editions_info, "foils_info": foils_info,
    }


def _public_decks_list() -> list[dict]:
    """Every deck marked public, across all users — feeds the public /decks
    browse page. Unlike _user_decks_list (one user's decks), this fans out
    over every user, so each entry also carries its owner's username (for
    display) and omnidex_id (the stable id used in the deck's public URL/API
    path — see api_public_deck_get)."""
    if is_db_mode():
        with get_session() as session:
            rows = session.execute(
                select(Deck, User.username).join(User, User.id == Deck.user_id).where(Deck.is_public == True)
            ).all()
        decks = []
        for row, username in rows:
            deck_data = _deck_load_db(username, row.name)
            count = _deck_card_count(deck_data["sections"]) if deck_data and "sections" in deck_data else 0
            profile = user_get_profile(username)
            decks.append({
                "name": row.name,
                "username": username,
                "omnidex_id": profile.get("omnidex_id") if profile else None,
                "format": row.format or "",
                "desc": row.desc or "",
                "banner": row.banner,
                "card_count": count,
            })
        decks.sort(key=lambda d: d["name"].lower())
        return decks

    decks = []
    for user in user_list():
        username = user["username"]
        profile = user_get_profile(username)
        omnidex_id = profile.get("omnidex_id") if profile else None
        for name, entry in _deck_index_load(username).items():
            if not entry.get("public"):
                continue
            deck_data = _deck_load(username, name)
            count = _deck_card_count(deck_data["sections"]) if deck_data and "sections" in deck_data else 0
            decks.append({
                "name": name,
                "username": username,
                "omnidex_id": omnidex_id,
                "format": (deck_data or {}).get("format", entry.get("format", "")),
                "desc": (deck_data or {}).get("desc", entry.get("desc", "")),
                "banner": entry.get("banner"),
                "card_count": count,
            })
    decks.sort(key=lambda d: d["name"].lower())
    return decks


def _resolve_card_id(name: str, slug_data: dict) -> str | None:
    # Use the same slug normalization card search uses for exact local matches
    slug = _format_search(name)
    if slug in slug_data:
        return slug_data[slug]["card_id"]
    from rapidfuzz import process, fuzz
    name_to_id = {d["name"].lower(): d["card_id"] for d in slug_data.values()}
    matches = process.extract(name.lower(), list(name_to_id.keys()),
                              scorer=fuzz.WRatio, score_cutoff=70, limit=1)
    if matches:
        return name_to_id[matches[0][0]]
    return None


def _pick_edition(card_id: str, info_data: dict) -> str | None:
    editions = info_data.get(card_id, {}).get("editions", {})
    if not editions:
        return None
    return random.choice(list(editions.keys()))


@app.get("/api/decks")
async def api_decks_list(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    index = _deck_index_load(user)
    result = {}
    for name, entry in index.items():
        deck_data = _deck_load(user, name)
        count = _deck_card_count(deck_data["sections"]) if deck_data and "sections" in deck_data else 0
        # desc/format live in the deck file; fall back to legacy index fields
        result[name] = {**entry,
                        "desc": (deck_data or {}).get("desc", entry.get("desc", "")),
                        "format": (deck_data or {}).get("format", entry.get("format", "")),
                        "card_count": count}
    return JSONResponse({"decks": result})


@app.post("/api/decks")
async def api_deck_create(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    name = body.get("name", "").strip()
    fmt = body.get("format", "").strip()
    desc = body.get("desc", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    index = _deck_index_load(user)
    if name in index:
        raise HTTPException(status_code=400, detail="Deck already exists")
    created = date.today().isoformat()
    index[name] = {"banner": None, "symbol": None, "tags": None, "public": False,
                   "edition_locked": False, "created": created, "modified": created}
    _deck_index_save(user, index)
    _deck_save(user, name, _make_deck_data(desc, fmt))
    return JSONResponse({"ok": True, "created": created})


@app.get("/api/decks/{deck_name}/export")
async def api_deck_export(deck_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    slug_data = load_slugs_data()
    name_map = {d["card_id"]: d["name"] for d in slug_data.values()}
    lines = []
    for section_name, cards in deck_data["sections"].items():
        if not cards:
            continue
        # Export always reports one name+qty line per card_id, summed across
        # any edition/foil split — competition submissions only care about
        # which cards and how many, never which printing.
        totals: dict[str, int] = {}
        order = []
        for row in cards:
            card_id = row["card_id"]
            if card_id not in totals:
                totals[card_id] = 0
                order.append(card_id)
            totals[card_id] += row["quantity"]
        lines.append(f"# {section_name}")
        for card_id in order:
            lines.append(f"{totals[card_id]} {name_map.get(card_id, card_id)}")
        lines.append("")
    return JSONResponse({"text": "\n".join(lines).strip()})


@app.post("/api/decks/{deck_name}/import/parse")
async def api_deck_import_parse(deck_name: str, request: Request):
    """Parse import text. Returns resolved cards (local match) and unresolved (need API lookup)."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    text = body.get("text", "")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")

    slug_data = load_slugs_data()

    resolved = []  # {card_id, name, qty, section}
    unresolved = []  # {name, qty, section}
    current_section = None
    sections = deck_data["sections"]

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            current_section = line.lstrip("#").strip()
            if current_section not in sections:
                sections[current_section] = []
            continue
        if current_section is None:
            continue
        parts = line.split(" ", 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        qty = int(parts[0])
        card_name = parts[1].strip()
        slug = _format_search(card_name)
        card_id = slug_data[slug]["card_id"] if slug in slug_data else None
        if card_id:
            resolved.append({"card_id": card_id, "name": card_name, "qty": qty, "section": current_section})
        else:
            unresolved.append({"name": card_name, "qty": qty, "section": current_section})

    # Save new sections (may have been created during parse)
    _deck_save(user, deck_name, deck_data)

    return JSONResponse({"resolved": resolved, "unresolved": unresolved})


@app.post("/api/decks/{deck_name}/import/commit")
async def api_deck_import_commit(deck_name: str, request: Request):
    """Add a batch of already-resolved cards to the deck."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    cards = body.get("cards", [])  # [{card_id, qty, section}]

    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")

    info_data = load_info_data()
    for item in cards:
        card_id = item.get("card_id")
        section = item.get("section")
        qty = int(item.get("qty", 1))
        if not card_id or not section:
            continue
        if section not in deck_data["sections"]:
            deck_data["sections"][section] = []
        _deck_row_add_generic(deck_data["sections"][section], card_id, qty, info_data)

    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True})


@app.post("/api/decks/{deck_name}/import/resolve")
async def api_deck_import_resolve(deck_name: str, request: Request):
    """Resolve a single card name via API search and add it to the deck."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    card_name = body.get("name", "").strip()
    section = body.get("section", "").strip()
    qty = int(body.get("qty", 1))

    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")

    slug_data = load_slugs_data()

    slug = _format_search(card_name)
    card_id = slug_data[slug]["card_id"] if slug in slug_data else None

    if not card_id:
        api_result = _api_search_variants(card_name)
        if api_result:
            # Re-read to pick up what _api_search_variants just synced —
            # _persist_card writes JSON or Postgres per mode and busts the
            # read cache, so the new card is visible on this re-read.
            slug_data = load_slugs_data()
            card_id = slug_data[slug]["card_id"] if slug in slug_data else None

    if card_id:
        if section not in deck_data["sections"]:
            deck_data["sections"][section] = []
        _deck_row_add_generic(deck_data["sections"][section], card_id, qty, load_info_data())
        _deck_save(user, deck_name, deck_data)
        return JSONResponse({"ok": True, "card_id": card_id, "found": True})

    return JSONResponse({"ok": True, "found": False})


@app.get("/api/decks/public")
async def api_public_decks_list():
    return JSONResponse({"decks": _public_decks_list()})


@app.get("/api/decks/public/{omnidex_id}/{deck_name}")
async def api_public_deck_get(omnidex_id: str, deck_name: str):
    # Looked up by Omnidex ID rather than username — same rationale as the
    # public profile route (api_public_profile): a stable, not-writable
    # public id rather than the mutable username.
    username = user_find_by_omnidex(omnidex_id.strip())
    if username is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    index = _deck_index_load(username)
    entry = index.get(deck_name)
    if entry is None or not entry.get("public"):
        raise HTTPException(status_code=404, detail="Deck not found")
    deck_data = _deck_load(username, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    return JSONResponse({**_deck_detail_payload(deck_data), "username": username, "omnidex_id": omnidex_id,
                          "banner": entry.get("banner"), "edition_locked": entry.get("edition_locked", False)})


@app.get("/api/decks/{deck_name}")
async def api_deck_get(deck_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    entry = _deck_index_load(user).get(deck_name, {})
    return JSONResponse({**_deck_detail_payload(deck_data), "edition_locked": entry.get("edition_locked", False)})


@app.patch("/api/decks/{deck_name}")
async def api_deck_patch(deck_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    new_name = body.get("name", "").strip()
    index = _deck_index_load(user)
    if deck_name not in index:
        raise HTTPException(status_code=404, detail="Deck not found")
    if new_name and new_name != deck_name:
        if new_name in index:
            raise HTTPException(status_code=400, detail="Deck name already taken")
        index[new_name] = index.pop(deck_name)
        if is_db_mode():
            # Rename in place, preserving the row's id (and therefore its
            # sections/cards) — the DB-mode equivalent of the os.rename()
            # below. The generic _deck_index_save further down can't do
            # this itself: from its point of view the old name just
            # vanished and a new one appeared, which it can only read as
            # "delete the old deck, create an empty new one."
            user_id = user_get_id(user)
            with get_session() as session:
                session.execute(
                    update(Deck).where(Deck.user_id == user_id, Deck.name == deck_name).values(name=new_name)
                )
        else:
            old_path = f"{DIR_DECKS_GA}/{user}/{deck_name}.json"
            new_path = f"{DIR_DECKS_GA}/{user}/{new_name}.json"
            if os.path.exists(old_path):
                os.rename(old_path, new_path)
        deck_name = new_name
    if "banner" in body:
        banner = body["banner"]
        index[deck_name]["banner"] = banner.strip() if isinstance(banner, str) and banner.strip() else None
    if "public" in body:
        index[deck_name]["public"] = bool(body["public"])
    if "edition_locked" in body:
        index[deck_name]["edition_locked"] = bool(body["edition_locked"])
    index[deck_name]["modified"] = date.today().isoformat()
    _deck_index_save(user, index)
    if "format" in body or "desc" in body:
        fmt = body.get("format", "").strip()
        desc = body.get("desc", "").strip()
        deck_data = _deck_load(user, deck_name)
        if deck_data is None:
            # Deck file missing — rebuild it so format/desc aren't silently lost
            deck_data = _make_deck_data(desc, fmt)
        else:
            if "format" in body:
                deck_data["format"] = fmt
            if "desc" in body:
                deck_data["desc"] = desc
        _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True})


@app.delete("/api/decks/{deck_name}")
async def api_deck_delete(deck_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    index = _deck_index_load(user)
    if deck_name not in index:
        raise HTTPException(status_code=404, detail="Deck not found")
    del index[deck_name]
    _deck_index_save(user, index)
    deck_file = f"{DIR_DECKS_GA}/{user}/{deck_name}.json"
    if os.path.exists(deck_file):
        os.remove(deck_file)
    return JSONResponse({"ok": True})


@app.post("/api/decks/{deck_name}/card/edition")
async def api_deck_card_edition(deck_name: str, request: Request):
    """Swap an existing row's printing in place (Edition Locked only) — changes
    which edition/foil a card slot points to without touching its quantity or
    position, so the owner doesn't have to delete the old row and re-add the
    new one."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    card_id = body.get("card_id", "").strip()
    section = body.get("section", "").strip()
    from_edition_id = body.get("from_edition_id") or None
    from_foil_id = body.get("from_foil_id") or None
    to_edition_id = body.get("to_edition_id") or None
    to_foil_id = body.get("to_foil_id") or None
    if not card_id or not section or not to_edition_id:
        raise HTTPException(status_code=400, detail="Missing card_id, section, or to_edition_id")
    if not _deck_is_edition_locked(user, deck_name):
        raise HTTPException(status_code=400, detail="Deck is not Edition Locked")

    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    if section not in deck_data["sections"]:
        raise HTTPException(status_code=400, detail="Section not found")

    cards = deck_data["sections"][section]
    row = _deck_row_find(cards, card_id, from_edition_id, from_foil_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Card not in section")

    existing = _deck_row_find(cards, card_id, to_edition_id, to_foil_id)
    if existing is not None and existing is not row:
        # The target printing already has its own row here — merge into it
        # and drop the old one, same as api_deck_card_move's merge-on-collision.
        existing["quantity"] += row["quantity"]
        cards.remove(row)
    else:
        row["edition_id"] = to_edition_id
        row["foil_id"] = to_foil_id

    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True})


@app.post("/api/decks/{deck_name}/card/move")
async def api_deck_card_move(deck_name: str, request: Request):
    """Move a card to a new position — within a section or across sections."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    card_id = body.get("card_id", "")
    edition_id = body.get("edition_id") or None
    foil_id = body.get("foil_id") or None
    from_section = body.get("from_section", "")
    to_section = body.get("to_section", "")
    index = body.get("index", 0)

    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    sections = deck_data.get("sections", {})
    if from_section not in sections or to_section not in sections:
        raise HTTPException(status_code=404, detail="Section not found")

    target = sections[to_section]

    if _deck_is_edition_locked(user, deck_name):
        row = _deck_row_find(sections[from_section], card_id, edition_id, foil_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Card not in section")

        sections[from_section].remove(row)
        qty = row["quantity"]

        existing = _deck_row_find(target, card_id, edition_id, foil_id)
        if existing:
            # Card (same edition/foil) already in target section — merge
            # quantities at its new position
            target.remove(existing)
            qty += existing["quantity"]

        index = max(0, min(int(index), len(target)))
        target.insert(index, {"card_id": card_id, "edition_id": edition_id, "foil_id": foil_id, "quantity": qty})
    else:
        # Not Edition Locked — the dragged tile represents every row for
        # this card_id collapsed together; move them all as one unit.
        rows = _deck_rows_all_editions(sections[from_section], card_id)
        if not rows:
            raise HTTPException(status_code=404, detail="Card not in section")
        for row in rows:
            sections[from_section].remove(row)
        qty = sum(r["quantity"] for r in rows)
        index = max(0, min(int(index), len(target)))
        for i, row in enumerate(rows):
            target.insert(index + i, row)

    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True, "merged_qty": qty})


@app.post("/api/decks/{deck_name}/card")
async def api_deck_card_add(deck_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    card_id = body.get("card_id", "").strip()
    section = body.get("section", "").strip()
    edition_id = body.get("edition_id") or None
    foil_id = body.get("foil_id") or None
    quantity = int(body.get("quantity", 1))
    if not card_id or not section:
        raise HTTPException(status_code=400, detail="Missing card_id or section")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    if section not in deck_data["sections"]:
        raise HTTPException(status_code=400, detail="Section not found")
    cards = deck_data["sections"][section]
    if _deck_is_edition_locked(user, deck_name):
        new_qty = _deck_row_add(cards, card_id, edition_id, foil_id, quantity)
    else:
        new_qty = _deck_row_add_generic(cards, card_id, quantity, load_info_data())
    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True, "quantity": new_qty})


@app.patch("/api/decks/{deck_name}/card")
async def api_deck_card_set(deck_name: str, request: Request):
    """Set the absolute quantity of a card in a deck section."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    card_id = body.get("card_id", "").strip()
    section = body.get("section", "").strip()
    edition_id = body.get("edition_id") or None
    foil_id = body.get("foil_id") or None
    quantity = int(body.get("quantity", 0))
    if not card_id or not section:
        raise HTTPException(status_code=400, detail="Missing card_id or section")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    if section not in deck_data["sections"]:
        raise HTTPException(status_code=400, detail="Section not found")
    cards = deck_data["sections"][section]

    if _deck_is_edition_locked(user, deck_name):
        row = _deck_row_find(cards, card_id, edition_id, foil_id)
        if quantity <= 0:
            if row:
                cards.remove(row)
        elif row:
            row["quantity"] = quantity
        else:
            cards.append({"card_id": card_id, "edition_id": edition_id, "foil_id": foil_id, "quantity": quantity})
    else:
        # Not Edition Locked — the client shows one collapsed tile per
        # card_id, so an absolute-quantity set here means "this is the new
        # total," however many real rows currently make it up.
        rows = _deck_rows_all_editions(cards, card_id)
        current_total = sum(r["quantity"] for r in rows)
        if quantity <= 0:
            for r in rows:
                cards.remove(r)
        elif not rows:
            eid, fid = _pick_random_printing(card_id, load_info_data())
            cards.append({"card_id": card_id, "edition_id": eid, "foil_id": fid, "quantity": quantity})
        elif quantity >= current_total:
            rows[0]["quantity"] += quantity - current_total
        else:
            remaining = current_total - quantity
            for r in reversed(rows):
                if remaining <= 0:
                    break
                take = min(r["quantity"], remaining)
                r["quantity"] -= take
                remaining -= take
                if r["quantity"] <= 0:
                    cards.remove(r)
    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True})


@app.delete("/api/decks/{deck_name}/card")
async def api_deck_card_delete(deck_name: str, request: Request):
    """Remove a card from a deck section — a specific printing when Edition
    Locked, or every row for that card_id (the whole collapsed tile) when not."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    card_id = body.get("card_id", "").strip()
    section = body.get("section", "").strip()
    edition_id = body.get("edition_id") or None
    foil_id = body.get("foil_id") or None
    if not card_id or not section:
        raise HTTPException(status_code=400, detail="Missing card_id or section")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    cards = deck_data["sections"].get(section, [])
    if _deck_is_edition_locked(user, deck_name):
        row = _deck_row_find(cards, card_id, edition_id, foil_id)
        if row:
            cards.remove(row)
    else:
        for row in _deck_rows_all_editions(cards, card_id):
            cards.remove(row)
    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True})


@app.post("/api/decks/{deck_name}/section")
async def api_deck_section_add(deck_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    section = body.get("section", "").strip()
    if not section:
        raise HTTPException(status_code=400, detail="Section name required")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    if section in deck_data["sections"]:
        raise HTTPException(status_code=400, detail="Section already exists")
    deck_data["sections"][section] = []
    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True})


@app.delete("/api/decks/{deck_name}/section/{section_name}")
async def api_deck_section_delete(deck_name: str, section_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    if section_name not in deck_data["sections"]:
        raise HTTPException(status_code=404, detail="Section not found")
    del deck_data["sections"][section_name]
    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True})


@app.patch("/api/decks/{deck_name}/section/{section_name}/rename")
async def api_deck_section_rename(deck_name: str, section_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    new_name = body.get("name", "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name required")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    if section_name not in deck_data["sections"]:
        raise HTTPException(status_code=404, detail="Section not found")
    if new_name in deck_data["sections"]:
        raise HTTPException(status_code=400, detail="Section name already taken")
    # Rebuild sections dict preserving insertion order
    new_sections = {}
    for k, v in deck_data["sections"].items():
        new_sections[new_name if k == section_name else k] = v
    deck_data["sections"] = new_sections
    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True})

from api_ga import _api_search, _build_collector_map, _format_search, _sort_collector_number, _update_slug, \
    JSON_EDITIONS, JSON_INFO, JSON_SLUGS, JSON_THEMA, set_search, UPDATE_THRESHOLD
from api_tcgplayer import get_all_ids, get_last_listings, get_last_sales, get_product_id, set_product_id
from datetime import date, datetime, timedelta, timezone
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from pricing_ga import JSON_LISTINGS, JSON_SALES, RARITY_MAP, _foil_kind_for_id, add_manual_entry, delete_entry, \
    find_product_ids_by_editions, import_pasted_sales_tcg_by_edition, scrape_batch_tcg_by_editions, \
    scrape_listings_tcg_by_edition, scrape_sales_and_listings_tcg_by_edition, scrape_sales_tcg_by_edition
from rapidfuzz import fuzz, process
from user import JSON_USERS, user_create, user_login
from util_file import new_json
from watchlist_ga import watchlist_add, watchlist_list, watchlist_remove

import json
import os
import random
import re
import threading
import uuid

load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", 480))

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/elements", StaticFiles(directory="assets/GA_ELEMENTS"), name="elements")
app.mount("/marketplaces", StaticFiles(directory="assets/MARKETPLACES"), name="marketplaces")

_set_search_cache = {}

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
    users_file = new_json(JSON_USERS)

    with users_file.open("r", encoding="utf-8") as f:
        users_data = json.load(f)

    return users_data.get(username, {}).get("auth_type")


def require_admin(request: Request) -> str:
    user = get_current_user(request)

    if not user or get_user_auth_type(user) != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    return user


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


def _last_sale_price(sales_data: dict, card_id: str, edition_id: str, foils: dict):
    foil_id = _pick_default_foil(foils)
    if not foil_id:
        return None
    records = sales_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])
    if not records:
        return None
    return max(records, key=lambda r: r["date"])["price"]


@app.get("/api/cards/search")
async def api_cards_search(request: Request, q: str = "", all_prints: bool = False):
    set_params = request.query_params.getlist("set")
    set_filters = [s.strip().lower().replace(" ", "_") for s in set_params]

    slug_file = new_json(JSON_SLUGS)
    info_file = new_json(JSON_INFO)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    with new_json(JSON_SALES).open(encoding="utf-8") as f:
        sales_data = json.load(f)

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
                path = f"DATA_GA/SETS_GA/{key}.json"
                set_file_cache[key] = json.load(open(path)) if os.path.exists(path) else {}
            set_data = set_file_cache[key]
            card["collector_number"] = next(
                (num for num, eids in set_data.items()
                 if card["edition_id"] in (eids if isinstance(eids, list) else [eids])),
                ""
            )
            card["last_price"] = _last_sale_price(
                sales_data, card["card_id"], card["edition_id"], edition_info.get("foils", {})
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
            with slug_file.open("r", encoding="utf-8") as f:
                slug_data = json.load(f)

            with info_file.open("r", encoding="utf-8") as f:
                info_data = json.load(f)

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
                set_file_path = f"DATA_GA/SETS_GA/{set_filter}.json"
                if os.path.exists(set_file_path):
                    with open(set_file_path, "r", encoding="utf-8") as f:
                        set_data = json.load(f)
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
    slug_file = new_json(JSON_SLUGS)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

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
    info_file = new_json(JSON_INFO)
    thema_file = new_json(JSON_THEMA)
    listings_file = new_json(JSON_LISTINGS)
    sales_file = new_json(JSON_SALES)
    slug_file = new_json(JSON_SLUGS)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    with thema_file.open("r", encoding="utf-8") as f:
        thema_data = json.load(f)

    with listings_file.open("r", encoding="utf-8") as f:
        listings_data = json.load(f)

    with sales_file.open("r", encoding="utf-8") as f:
        sales_data = json.load(f)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    card_info = info_data.get(card_id)

    if not card_info:
        raise HTTPException(status_code=404, detail="Card not found")

    # INFO.json entries don't carry a name — SLUGS.json is keyed by slug, not
    # card_id, so this is a scan rather than a direct lookup. Fine here since
    # it's one detail-page fetch, not a hot path like search. Needed so
    # callers that only have a card_id (e.g. restoring a selection from a
    # bookmarked ?card_id= URL, see the Prices page) can still show a name
    # without a separate search round-trip.
    card_info["name"] = next(
        (data["name"] for data in slug_data.values() if data.get("card_id") == card_id),
        None
    )

    card_listings = listings_data.get(card_id, {})
    card_sales = sales_data.get(card_id, {})

    for edition_id, edition_info in card_info.get("editions", {}).items():
        set_prefix = edition_info.get("set_prefix", "")
        set_file_name = set_prefix.lower().replace(" ", "_")
        set_path = f"DATA_GA/SETS_GA/{set_file_name}.json"

        collector_number = "?"

        if os.path.exists(set_path):
            with open(set_path, "r", encoding="utf-8") as f:
                set_data = json.load(f)

            collector_number = next(
                (num for num, eids in set_data.items()
                 if edition_id in (eids if isinstance(eids, list) else [eids])),
                "?"
            )

        edition_info["collector_number"] = collector_number
        edition_info["thema"] = thema_data.get(edition_id, {})

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

    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return JSONResponse({"username": user, "auth_type": get_user_auth_type(user)})


@app.get("/api/sets")
async def api_sets():
    sets_dir = "DATA_GA/SETS_GA"

    if not os.path.exists(sets_dir):
        return JSONResponse({"sets": []})

    sets = sorted([
        os.path.splitext(f.name)[0].upper().replace("_", " ")
        for f in os.scandir(sets_dir)
        if f.name.endswith(".json")
    ])

    return JSONResponse({"sets": sets})


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

    needs_fetch = set_filter not in _set_search_cache
    if not needs_fetch:
        last_sync = date.fromisoformat(_set_search_cache[set_filter])
        needs_fetch = (date.today() - last_sync).days > UPDATE_THRESHOLD

    if not needs_fetch:
        # Local data is fresh enough — no job needed, frontend can fetch results immediately
        return JSONResponse({"job_id": None, "cached": True})

    _set_search_cache[set_filter] = date.today().isoformat()

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


def _run_pricing_batch_job(job_id: str, edition_ids: list, target: str) -> None:
    def on_progress(edition_id, result):
        with _pricing_batch_jobs_lock:
            job = _pricing_batch_jobs.get(job_id)
            if job is None:
                return
            job["results"][edition_id] = result
            job["done"] += 1
            job["current_edition_id"] = edition_id

    try:
        scrape_batch_tcg_by_editions(edition_ids, target, debug=False, headless=False, progress_callback=on_progress)

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

    if target not in ("both", "sales", "listings"):
        raise HTTPException(status_code=400, detail="target must be 'both', 'sales', or 'listings'")

    if not edition_ids:
        raise HTTPException(status_code=400, detail="edition_ids is required")

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
        args=(job_id, edition_ids, target),
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
        with new_json(JSON_EDITIONS).open(encoding="utf-8") as f:
            editions_data = json.load(f)
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


def _days_since(iso_date: str | None) -> int | None:
    if not iso_date:
        return None

    return (date.today() - date.fromisoformat(iso_date)).days


@app.get("/api/admin/users")
async def api_admin_users(request: Request):
    require_admin(request)

    with new_json(JSON_USERS).open(encoding="utf-8") as f:
        users_data = json.load(f)

    results = [
        {"username": username, "auth_type": info.get("auth_type")}
        for username, info in users_data.items()
    ]
    results.sort(key=lambda r: r["username"].lower())

    return JSONResponse({"users": results})


@app.get("/api/admin/pricing/product-ids")
async def api_admin_pricing_product_ids(request: Request):
    require_admin(request)

    with new_json(JSON_EDITIONS).open(encoding="utf-8") as f:
        editions_data = json.load(f)

    with new_json(JSON_INFO).open(encoding="utf-8") as f:
        info_data = json.load(f)

    with new_json(JSON_SLUGS).open(encoding="utf-8") as f:
        slugs_data = json.load(f)

    name_by_card_id = {entry["card_id"]: entry["name"] for entry in slugs_data.values()}
    collector_map = _build_collector_map()
    ids_data = get_all_ids()

    results = []

    for edition_id, edition_ref in editions_data.items():
        card_id = edition_ref.get("card_id")
        edition_info = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {})
        edition_ids = ids_data.get(edition_id, {})

        results.append({
            "edition_id": edition_id,
            "card_id": card_id,
            "name": name_by_card_id.get(card_id, "Unknown"),
            "rarity": RARITY_MAP.get(edition_info.get("rarity")),
            "set_prefix": edition_info.get("set_prefix"),
            "set_name": edition_info.get("set_name"),
            "collector_number": collector_map.get(edition_id),
            "product_id": edition_ids.get("product_id"),
            "sales_days_since": _days_since(edition_ids.get("last_sales")),
            "listings_days_since": _days_since(edition_ids.get("last_listings")),
        })

    results.sort(key=lambda r: (r["name"], r["set_prefix"] or ""))

    return JSONResponse({"editions": results})


@app.post("/api/admin/pricing/product-id")
async def api_admin_set_product_id(request: Request):
    require_admin(request)

    body = await request.json()
    edition_id = body.get("edition_id", "").strip()
    product_id = body.get("product_id", "").strip()

    if not edition_id:
        raise HTTPException(status_code=400, detail="edition_id is required")

    if product_id and not product_id.isdigit():
        raise HTTPException(status_code=400, detail="Product ID must be numeric")

    with new_json(JSON_EDITIONS).open(encoding="utf-8") as f:
        editions_data = json.load(f)

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    set_product_id(edition_id, product_id)

    return JSONResponse({"edition_id": edition_id, "product_id": product_id})


@app.get("/api/admin/pricing/{edition_id}/history")
async def api_admin_pricing_history(edition_id: str, request: Request):
    require_admin(request)

    with new_json(JSON_EDITIONS).open(encoding="utf-8") as f:
        editions_data = json.load(f)

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    card_id = editions_data[edition_id]["card_id"]

    with new_json(JSON_INFO).open(encoding="utf-8") as f:
        info_data = json.load(f)

    foils = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {}).get("foils", {})
    foil_kind_by_id = {}

    for foil_id, foil_info in foils.items():
        foil_kind_by_id[foil_id] = foil_info.get("kind")

        for variant_id, variant_info in foil_info.get("variants", {}).items():
            foil_kind_by_id[variant_id] = variant_info.get("kind")

    def _flatten(json_path):
        with open(json_path, encoding="utf-8") as f:
            store = json.load(f)

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

    return JSONResponse({
        "sales": _flatten(JSON_SALES),
        "listings": _flatten(JSON_LISTINGS),
        "last_sales": get_last_sales(edition_id),
        "last_listings": get_last_listings(edition_id),
    })


@app.get("/api/admin/pricing/{edition_id}/foils")
async def api_admin_pricing_foils(edition_id: str, request: Request):
    require_admin(request)

    with new_json(JSON_EDITIONS).open(encoding="utf-8") as f:
        editions_data = json.load(f)

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    card_id = editions_data[edition_id]["card_id"]

    with new_json(JSON_INFO).open(encoding="utf-8") as f:
        info_data = json.load(f)

    foils = info_data.get(card_id, {}).get("editions", {}).get(edition_id, {}).get("foils", {})
    options = []

    for foil_id, foil_info in foils.items():
        variant_population = sum(v.get("population", 0) for v in foil_info.get("variants", {}).values())
        remaining_population = foil_info.get("population", 0) - variant_population

        if remaining_population > 0:
            options.append({"foil_id": foil_id, "kind": foil_info.get("kind", "").title()})

        for variant_id, variant_info in foil_info.get("variants", {}).items():
            options.append({"foil_id": variant_id, "kind": variant_info.get("kind", "")})

    return JSONResponse({"foils": options})


@app.post("/api/admin/pricing/{edition_id}/entry")
async def api_admin_pricing_add_entry(edition_id: str, request: Request):
    require_admin(request)

    with new_json(JSON_EDITIONS).open(encoding="utf-8") as f:
        editions_data = json.load(f)

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    body = await request.json()
    entry_type = body.get("type")
    foil_id = body.get("foil_id", "").strip()
    marketplace = body.get("marketplace", "").strip() or "Manual"
    info = body.get("info", "").strip()
    entry_date = body.get("date", "").strip()

    if entry_type not in ("sales", "listings"):
        raise HTTPException(status_code=400, detail="type must be 'sales' or 'listings'")

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
        entry = add_manual_entry(edition_id, foil_id, entry_type, price, quantity, info, marketplace, entry_date)
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

    with new_json(JSON_EDITIONS).open(encoding="utf-8") as f:
        editions_data = json.load(f)

    if edition_id not in editions_data:
        raise HTTPException(status_code=404, detail="Edition not found")

    body = await request.json()
    raw_text = body.get("text", "")

    if not raw_text.strip():
        raise HTTPException(status_code=400, detail="Pasted text is required")

    result = import_pasted_sales_tcg_by_edition(edition_id, raw_text)

    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])

    return JSONResponse(result)


@app.get("/api/sets/search")
async def api_sets_search(prefix: str):
    set_filter = prefix.strip().lower().replace(" ", "_")
    set_file_path = f"DATA_GA/SETS_GA/{set_filter}.json"

    if not os.path.exists(set_file_path):
        return JSONResponse({"cards": []})

    with open(set_file_path, "r", encoding="utf-8") as f:
        set_data = json.load(f)

    slug_file = new_json(JSON_SLUGS)
    edition_file = new_json("DATA_GA/CARDS_GA/EDITIONS.json")
    info_file = new_json(JSON_INFO)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    with edition_file.open("r", encoding="utf-8") as f:
        edition_data = json.load(f)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    with new_json(JSON_SALES).open(encoding="utf-8") as f:
        sales_data = json.load(f)

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
async def api_login(username: str = Form(...), password: str = Form(...)):
    user = user_login(username, password)

    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = create_token(username)

    resp = JSONResponse({"username": username, "auth_type": get_user_auth_type(username)})
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
async def api_register(username: str = Form(...), password: str = Form(...)):
    try:
        user_create(username, password)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return await api_login(username=username, password=password)


@app.get("/images/{edition_id}.jpg")
async def get_image(edition_id: str):
    path = f"DATA_GA/IMAGES_GA/{edition_id}.jpg"

    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(path)


@app.get("/decks_ga", response_class=HTMLResponse)
async def decks_ga_page():
    return serve_index()


@app.get("/inventory", response_class=HTMLResponse)
async def inventory_page():
    return serve_index()


@app.get("/admin", response_class=HTMLResponse)
async def admin_page():
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

    with new_json(JSON_EDITIONS).open(encoding="utf-8") as f:
        editions_data = json.load(f)

    with new_json(JSON_INFO).open(encoding="utf-8") as f:
        info_data = json.load(f)

    with new_json(JSON_SLUGS).open(encoding="utf-8") as f:
        slugs_data = json.load(f)

    with new_json(JSON_SALES).open(encoding="utf-8") as f:
        sales_data = json.load(f)

    with new_json(JSON_LISTINGS).open(encoding="utf-8") as f:
        listings_data = json.load(f)

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
        lowest_listing = min((r["price"] for r in listing_records), default=None)

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


def _inv_load(username: str) -> dict:
    inv_file = new_json(f"DATA_GA/INV_GA/{username}.json")
    with inv_file.open("r", encoding="utf-8") as f:
        raw = json.load(f)

    # Empty file → init default structure
    if not raw:
        data = {
            DEFAULT_BIN: {"banner": None, "default": True, "desc": "", "symbol": None, "tags": None, "sections": {}}}
        _inv_save(username, data)
        return data

    # Old flat UUID-keyed structure → migrate to default bin
    first_val = next(iter(raw.values()), {})
    if isinstance(first_val, dict) and "card_id" in first_val:
        data = {
            DEFAULT_BIN: {"banner": None, "default": True, "desc": "", "symbol": None, "tags": None, "sections": {}}}
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
    inv_file = new_json(f"DATA_GA/INV_GA/{username}.json")
    with inv_file.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


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

    with new_json(JSON_SALES).open(encoding="utf-8") as f:
        sales_data = json.load(f)

    total = 0.0
    priced_quantity = 0
    total_quantity = 0

    for cards in inv[bin_name].get("sections", {}).values():
        for card_id, editions in cards.items():
            for edition_id, foils in editions.items():
                for foil_id, quantity in foils.items():
                    if quantity <= 0:
                        continue

                    total_quantity += quantity
                    records = sales_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])

                    if not records:
                        continue

                    latest = max(records, key=lambda r: r["date"])
                    total += latest["price"] * quantity
                    priced_quantity += quantity

    return JSONResponse({
        "total": round(total, 2),
        "priced_quantity": priced_quantity,
        "total_quantity": total_quantity,
    })


@app.get("/api/inventory/bins/{bin_name}/prices")
async def api_bin_prices(bin_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    with new_json(JSON_SALES).open(encoding="utf-8") as f:
        sales_data = json.load(f)

    prices: dict = {}

    for cards in inv[bin_name].get("sections", {}).values():
        for card_id, editions in cards.items():
            for edition_id, foils in editions.items():
                for foil_id in foils:
                    records = sales_data.get(card_id, {}).get(edition_id, {}).get(foil_id, [])
                    if not records:
                        continue

                    latest = max(records, key=lambda r: r["date"])
                    prices.setdefault(card_id, {}).setdefault(edition_id, {})[foil_id] = latest["price"]

    return JSONResponse(prices)


@app.get("/api/inv/info")
async def api_inv_info():
    info_file = new_json(JSON_INFO)
    with info_file.open("r", encoding="utf-8") as f:
        return JSONResponse(json.load(f))


@app.get("/api/inv/slugs")
async def api_inv_slugs():
    slug_file = new_json(JSON_SLUGS)
    with slug_file.open("r", encoding="utf-8") as f:
        return JSONResponse(json.load(f))


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

    info_file = new_json(JSON_INFO)
    slug_file = new_json(JSON_SLUGS)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)
    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

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
    sets_dir = "DATA_GA/SETS_GA"
    set_collector_map = {}
    if os.path.exists(sets_dir):
        for f in os.scandir(sets_dir):
            if not f.name.endswith(".json"):
                continue
            prefix = f.name[:-5].upper().replace("_", " ")
            with open(f.path, "r", encoding="utf-8") as fh:
                set_data = json.load(fh)
            set_collector_map[prefix] = {}
            for num, eids in set_data.items():
                if isinstance(eids, str):
                    eids = [eids]
                set_collector_map[prefix][num] = eids
    return set_collector_map


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

    info_file = new_json(JSON_INFO)
    slug_file = new_json(JSON_SLUGS)
    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)
    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

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

    info_file = new_json(JSON_INFO)
    slug_file = new_json(JSON_SLUGS)
    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)
    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

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
    path = f"{DIR_DECK_INDEX}/{username}.json"
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _deck_index_save(username: str, data: dict) -> None:
    os.makedirs(DIR_DECK_INDEX, exist_ok=True)
    with open(f"{DIR_DECK_INDEX}/{username}.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def _deck_load(username: str, deck_name: str) -> dict | None:
    path = f"{DIR_DECKS_GA}/{username}/{deck_name}.json"
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _deck_save(username: str, deck_name: str, data: dict) -> None:
    os.makedirs(f"{DIR_DECKS_GA}/{username}", exist_ok=True)
    with open(f"{DIR_DECKS_GA}/{username}/{deck_name}.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)

    # Any deck-content write bumps the index's last-modified date
    index = _deck_index_load(username)
    if deck_name in index:
        index[deck_name]["modified"] = date.today().isoformat()
        _deck_index_save(username, index)


def _deck_card_count(sections: dict) -> int:
    total = 0
    for cards in sections.values():
        for qty in cards.values():
            total += qty
    return total


def _make_deck_data(desc: str, fmt: str) -> dict:
    return {
        "desc": desc,
        "format": fmt,
        "sections": {s: {} for s in DEFAULT_SECTIONS}
    }


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
    index[name] = {"banner": None, "symbol": None, "tags": None,
                   "created": created, "modified": created}
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
    slug_file = new_json(JSON_SLUGS)
    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)
    name_map = {d["card_id"]: d["name"] for d in slug_data.values()}
    lines = []
    for section_name, cards in deck_data["sections"].items():
        if not cards:
            continue
        lines.append(f"# {section_name}")
        for card_id, qty in cards.items():
            lines.append(f"{qty} {name_map.get(card_id, card_id)}")
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

    slug_file = new_json(JSON_SLUGS)
    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

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
                sections[current_section] = {}
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

    for item in cards:
        card_id = item.get("card_id")
        section = item.get("section")
        qty = int(item.get("qty", 1))
        if not card_id or not section:
            continue
        if section not in deck_data["sections"]:
            deck_data["sections"][section] = {}
        deck_data["sections"][section][card_id] = deck_data["sections"][section].get(card_id, 0) + qty

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

    slug_file = new_json(JSON_SLUGS)
    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    slug = _format_search(card_name)
    card_id = slug_data[slug]["card_id"] if slug in slug_data else None

    if not card_id:
        api_result = _api_search_variants(card_name)
        if api_result:
            with slug_file.open("r", encoding="utf-8") as f:
                slug_data = json.load(f)
            card_id = slug_data[slug]["card_id"] if slug in slug_data else None

    if card_id:
        if section not in deck_data["sections"]:
            deck_data["sections"][section] = {}
        deck_data["sections"][section][card_id] = deck_data["sections"][section].get(card_id, 0) + qty
        _deck_save(user, deck_name, deck_data)
        return JSONResponse({"ok": True, "card_id": card_id, "found": True})

    return JSONResponse({"ok": True, "found": False})


@app.get("/api/decks/{deck_name}")
async def api_deck_get(deck_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    slug_file = new_json(JSON_SLUGS)
    info_file = new_json(JSON_INFO)
    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)
    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)
    name_map = {d["card_id"]: d["name"] for d in slug_data.values()}
    edition_map = {}
    for cards in deck_data["sections"].values():
        for card_id in cards:
            if card_id not in edition_map:
                eid = _pick_edition(card_id, info_data)
                if eid:
                    edition_map[card_id] = eid
    return JSONResponse({**deck_data, "name_map": name_map, "edition_map": edition_map})


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
        old_path = f"{DIR_DECKS_GA}/{user}/{deck_name}.json"
        new_path = f"{DIR_DECKS_GA}/{user}/{new_name}.json"
        if os.path.exists(old_path):
            os.rename(old_path, new_path)
        deck_name = new_name
    if "banner" in body:
        banner = body["banner"]
        index[deck_name]["banner"] = banner.strip() if isinstance(banner, str) and banner.strip() else None
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


@app.post("/api/decks/{deck_name}/card/move")
async def api_deck_card_move(deck_name: str, request: Request):
    """Move a card to a new position — within a section or across sections."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    card_id = body.get("card_id", "")
    from_section = body.get("from_section", "")
    to_section = body.get("to_section", "")
    index = body.get("index", 0)

    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    sections = deck_data.get("sections", {})
    if from_section not in sections or to_section not in sections:
        raise HTTPException(status_code=404, detail="Section not found")
    if card_id not in sections[from_section]:
        raise HTTPException(status_code=404, detail="Card not in section")

    qty = sections[from_section].pop(card_id)

    target = sections[to_section]
    if card_id in target:
        # Card already in target section — merge quantities at its new position
        qty += target.pop(card_id)

    items = list(target.items())
    index = max(0, min(int(index), len(items)))
    items.insert(index, (card_id, qty))
    sections[to_section] = dict(items)

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
    quantity = int(body.get("quantity", 1))
    if not card_id or not section:
        raise HTTPException(status_code=400, detail="Missing card_id or section")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    if section not in deck_data["sections"]:
        raise HTTPException(status_code=400, detail="Section not found")
    cards = deck_data["sections"][section]
    new_qty = cards.get(card_id, 0) + quantity
    if new_qty <= 0:
        cards.pop(card_id, None)
    else:
        cards[card_id] = new_qty
    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True, "quantity": max(new_qty, 0)})


@app.patch("/api/decks/{deck_name}/card")
async def api_deck_card_set(deck_name: str, request: Request):
    """Set the absolute quantity of a card in a deck section."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    card_id = body.get("card_id", "").strip()
    section = body.get("section", "").strip()
    quantity = int(body.get("quantity", 0))
    if not card_id or not section:
        raise HTTPException(status_code=400, detail="Missing card_id or section")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    if section not in deck_data["sections"]:
        raise HTTPException(status_code=400, detail="Section not found")
    if quantity <= 0:
        deck_data["sections"][section].pop(card_id, None)
    else:
        deck_data["sections"][section][card_id] = quantity
    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True})


@app.delete("/api/decks/{deck_name}/card")
async def api_deck_card_delete(deck_name: str, request: Request):
    """Remove a card from a deck section entirely."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    card_id = body.get("card_id", "").strip()
    section = body.get("section", "").strip()
    if not card_id or not section:
        raise HTTPException(status_code=400, detail="Missing card_id or section")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")
    deck_data["sections"].get(section, {}).pop(card_id, None)
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
    deck_data["sections"][section] = {}
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

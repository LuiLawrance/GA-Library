from api_ga import _api_search, _format_search, _sort_collector_number, JSON_INFO, JSON_SLUGS, JSON_THEMA, \
    set_search, UPDATE_THRESHOLD
from datetime import date, datetime, timedelta
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from rapidfuzz import fuzz, process
from user import user_create, user_login
from util_file import new_json

import json
import os
import random

load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", 480))

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/elements", StaticFiles(directory="assets/GA_ELEMENTS"), name="elements")

_set_search_cache = {}


def create_token(username: str) -> str:
    expire = datetime.utcnow() + timedelta(minutes=JWT_EXPIRE_MINUTES)

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


def serve_index():
    with open("templates/index.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


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


@app.get("/api/cards/search")
async def api_cards_search(request: Request, q: str = ""):
    set_params = request.query_params.getlist("set")
    set_filters = [s.strip().lower().replace(" ", "_") for s in set_params]

    slug_file = new_json(JSON_SLUGS)
    info_file = new_json(JSON_INFO)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    def enrich(cards):
        set_file_cache = {}
        for card in cards:
            card_info = info_data.get(card["card_id"], {})
            edition_info = card_info.get("editions", {}).get(card["edition_id"], {})
            card["element"] = card_info.get("element") or ""
            set_prefix = edition_info.get("set_prefix", "")
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

                for edition_id in (candidate_editions if set_filters else [
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
        card_data = _api_search(_format_search(q))

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

                    for edition_id in (candidate_editions if set_filters else [
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

                if editions:
                    edition_id = random.choice(editions)
                    rarity = card_info.get("editions", {}).get(edition_id, {}).get("rarity")
                    cards.append({
                        "card_id": card_id,
                        "edition_id": edition_id,
                        "name": data["name"],
                        "rarity": rarity,
                    })
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

            if editions:
                edition_id = random.choice(editions)
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

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    with thema_file.open("r", encoding="utf-8") as f:
        thema_data = json.load(f)

    card_info = info_data.get(card_id)

    if not card_info:
        raise HTTPException(status_code=404, detail="Card not found")

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

    return JSONResponse({"card_id": card_id, "card": card_info})


@app.get("/api/me")
async def api_me(request: Request):
    user = get_current_user(request)

    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return JSONResponse({"username": user})


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


@app.get("/api/sets/search")
async def api_sets_search(prefix: str):
    set_filter = prefix.strip().lower().replace(" ", "_")
    set_file_path = f"DATA_GA/SETS_GA/{set_filter}.json"

    if set_filter not in _set_search_cache:
        _set_search_cache[set_filter] = date.today().isoformat()
        set_search(prefix.strip().upper(), False)
    else:
        last_sync = date.fromisoformat(_set_search_cache[set_filter])
        if (date.today() - last_sync).days > UPDATE_THRESHOLD:
            _set_search_cache[set_filter] = date.today().isoformat()
            set_search(prefix.strip().upper(), False)

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
            rarity = card_info.get("editions", {}).get(edition_id, {}).get("rarity")

            cards.append({
                "card_id": card_id,
                "edition_id": edition_id,
                "name": slug_entry["name"],
                "rarity": rarity,
                "element": card_info.get("element") or "",
                "collector_number": collector_number,
            })

    return JSONResponse({"cards": cards})


@app.post("/api/login")
async def api_login(username: str = Form(...), password: str = Form(...)):
    user = user_login(username, password)

    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = create_token(username)

    resp = JSONResponse({"username": username})
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


@app.get("/fragments/login", response_class=HTMLResponse)
async def fragment_login():
    with open("templates/login.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/prices", response_class=HTMLResponse)
async def fragment_prices():
    with open("templates/prices.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())


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
        data = {DEFAULT_BIN: {"default": True, "desc": "", "public": False, "cards": {}}}
        _inv_save(username, data)
        return data

    # Old flat UUID-keyed structure → migrate to default bin
    first_val = next(iter(raw.values()), {})
    if isinstance(first_val, dict) and "card_id" in first_val:
        data = {DEFAULT_BIN: {"default": True, "desc": "", "public": False, "cards": {}}}
        _inv_save(username, data)
        return data

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


@app.get("/api/inv/collector")
async def api_inv_collector():
    sets_dir = "DATA_GA/SETS_GA"
    result = {}
    if os.path.exists(sets_dir):
        for f in os.scandir(sets_dir):
            if not f.name.endswith(".json"):
                continue
            with open(f.path, "r", encoding="utf-8") as fh:
                set_data = json.load(fh)
            for num, eids in set_data.items():
                if isinstance(eids, str):
                    eids = [eids]
                for eid in eids:
                    result[eid] = num
    return JSONResponse(result)


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
    sets_dir = "DATA_GA/SETS_GA"
    collector_map = {}
    if os.path.exists(sets_dir):
        for f in os.scandir(sets_dir):
            if not f.name.endswith(".json"):
                continue
            with open(f.path, "r", encoding="utf-8") as fh:
                set_data = json.load(fh)
            for num, eids in set_data.items():
                if isinstance(eids, str):
                    eids = [eids]
                for eid in eids:
                    collector_map[eid] = num

    # Build card_id → name map
    name_map = {data["card_id"]: data["name"] for data in slug_data.values()}

    lines = []
    cards = inv[bin_name].get("cards", {})

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

    return JSONResponse({"lines": lines})


def toFoilLabel(s: str) -> str:
    return s.lower().replace("_", " ").title() if s else ""


@app.post("/api/inventory/bins/{bin_name}/import")
async def api_bin_import(bin_name: str, request: Request):
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

    # Build name (lowercased) → card_id map
    name_to_id = {data["name"].lower(): data["card_id"] for data in slug_data.values()}

    # Build edition_id → collector_number and reverse maps per set
    sets_dir = "DATA_GA/SETS_GA"
    # set_prefix → { collector_number → [edition_id] }
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

    results = []
    cards = inv[bin_name]["cards"]

    import re as _re

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue

        # Parse: {qty}x {name} ({set}) [#{collector}] {foil_kind}
        m = _re.match(
            r'^(\d+)[xX]\s+(.+?)\s+\(([^)]+)\)(?:\s+#(\S+))?\s*(.*)?$',
            line
        )
        if not m:
            results.append({"line": raw_line, "ok": False, "error": "Could not parse line"})
            continue

        qty_str, card_name, set_prefix, collector_number, foil_kind_raw = m.groups()
        quantity = int(qty_str)
        card_name = card_name.strip()
        set_prefix = set_prefix.strip().upper()
        foil_kind_raw = (foil_kind_raw or "").strip().lower()
        if not foil_kind_raw:
            foil_kind_raw = "nonfoil"

        # Resolve card_id
        card_id = name_to_id.get(card_name.lower())
        if not card_id:
            results.append({"line": raw_line, "ok": False, "error": f"Card not found: {card_name}"})
            continue

        card_info = info_data.get(card_id, {})
        all_editions = card_info.get("editions", {})

        # Resolve edition_id
        edition_id = None
        set_prefix_key = set_prefix.upper()

        if collector_number and set_prefix_key in set_collector_map:
            eids = set_collector_map[set_prefix_key].get(collector_number, [])
            for eid in eids:
                if eid in all_editions:
                    edition_id = eid
                    break

        # Fallback: find any edition matching set_prefix
        if not edition_id:
            for eid, einfo in all_editions.items():
                if einfo.get("set_prefix", "").upper() == set_prefix_key:
                    edition_id = eid
                    break

        if not edition_id:
            results.append({"line": raw_line, "ok": False, "error": f"Edition not found: {set_prefix}"})
            continue

        # Resolve foil_id
        edition_foils = all_editions[edition_id].get("foils", {})
        foil_id = None

        for fid, finfo in edition_foils.items():
            kind = finfo.get("kind", "").lower()
            if foil_kind_raw in ("nonfoil", "normal") and kind in ("nonfoil", "normal"):
                foil_id = fid
                break
            if kind == foil_kind_raw:
                foil_id = fid
                break
            # Check variants
            for vid, vinfo in finfo.get("variants", {}).items():
                if vinfo.get("kind", "").lower() == foil_kind_raw:
                    foil_id = vid
                    break
            if foil_id:
                break

        # Fallback: pick default foil
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
            results.append({"line": raw_line, "ok": False, "error": "No foil type found"})
            continue

        # Insert into bin
        cards.setdefault(card_id, {}).setdefault(edition_id, {})
        existing = cards[card_id][edition_id].get(foil_id, 0)
        cards[card_id][edition_id][foil_id] = existing + quantity
        results.append({"line": raw_line, "ok": True, "added": quantity})

    _inv_save(user, inv)
    return JSONResponse({"results": results})


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

    inv[name] = {"banner": None, "default": False, "desc": desc, "public": False, "symbol": None, "tags": None,
                 "cards": {}}
    _inv_save(user, inv)
    return JSONResponse({"ok": True})


@app.patch("/api/inventory/bins/{bin_name}")
async def api_bin_patch(bin_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    new_name = body.get("name", "").strip()
    desc = body.get("desc", "").strip()

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    if new_name and new_name != bin_name:
        if new_name in inv:
            raise HTTPException(status_code=400, detail="Bin name already taken")
        inv[new_name] = inv.pop(bin_name)
        bin_name = new_name

    inv[bin_name]["desc"] = desc
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

@app.post("/api/inventory/card")
async def api_card_add(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    body = await request.json()
    bin_name = body.get("bin")
    card_id = body.get("card_id")
    edition_id = body.get("edition_id")
    foil_id = body.get("foil_id")
    quantity = int(body.get("quantity", 1))

    if not all([bin_name, card_id, edition_id, foil_id]):
        raise HTTPException(status_code=400, detail="Missing required fields")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    cards = inv[bin_name]["cards"]
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
    card_id = body.get("card_id")
    edition_id = body.get("edition_id")
    foil_id = body.get("foil_id")
    quantity = int(body.get("quantity", 1))

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    try:
        inv[bin_name]["cards"][card_id][edition_id][foil_id] = quantity
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
    card_id = body.get("card_id")
    edition_id = body.get("edition_id")
    foil_id = body.get("foil_id")

    inv = _inv_load(user)
    if bin_name not in inv:
        raise HTTPException(status_code=404, detail="Bin not found")

    cards = inv[bin_name]["cards"]
    try:
        del cards[card_id][edition_id][foil_id]
        if not cards[card_id][edition_id]: del cards[card_id][edition_id]
        if not cards[card_id]: del cards[card_id]
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
    name_to_id = {d["name"].lower(): d["card_id"] for d in slug_data.values()}
    if name.lower() in name_to_id:
        return name_to_id[name.lower()]
    from rapidfuzz import process, fuzz
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
        result[name] = {**entry, "card_count": count}
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
    index[name] = {"desc": desc, "format": fmt, "created": created}
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


@app.post("/api/decks/{deck_name}/import")
async def api_deck_import(deck_name: str, request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    body = await request.json()
    text = body.get("text", "")
    deck_data = _deck_load(user, deck_name)
    if deck_data is None:
        raise HTTPException(status_code=404, detail="Deck not found")

    slug_file = new_json(JSON_SLUGS)
    info_file = new_json(JSON_INFO)
    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)
    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    name_to_id = {d["name"].lower(): d["card_id"] for d in slug_data.values()}
    current_section = None
    not_found = []
    sections = deck_data["sections"]

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        # Section header
        if line.startswith("#"):
            section_name = line.lstrip("#").strip()
            if section_name not in sections:
                sections[section_name] = {}
            current_section = section_name
            continue

        if current_section is None:
            continue

        # Card line: "qty Card Name"
        parts = line.split(" ", 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue

        qty = int(parts[0])
        card_name = parts[1].strip()

        # Step 1 — exact match in local slug data
        card_id = name_to_id.get(card_name.lower())

        # Step 2 — not found locally, try the external API
        if not card_id:
            api_results = _api_search(_format_search(card_name))
            if api_results:
                # Reload slug data in case API updated it
                with slug_file.open("r", encoding="utf-8") as f:
                    slug_data = json.load(f)
                name_to_id = {d["name"].lower(): d["card_id"] for d in slug_data.values()}
                card_id = name_to_id.get(card_name.lower())

        if card_id:
            sections[current_section][card_id] = sections[current_section].get(card_id, 0) + qty
        else:
            not_found.append(card_name)

    _deck_save(user, deck_name, deck_data)
    return JSONResponse({"ok": True, "not_found": not_found})


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
    fmt = body.get("format", "").strip()
    desc = body.get("desc", "").strip()
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
    index[deck_name]["format"] = fmt
    index[deck_name]["desc"] = desc
    _deck_index_save(user, index)
    deck_data = _deck_load(user, deck_name)
    if deck_data:
        deck_data["format"] = fmt
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

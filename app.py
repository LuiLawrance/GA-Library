from api_ga import _api_search, _format_search, _sort_collector_number, JSON_INFO, JSON_SLUGS, set_search, \
    UPDATE_THRESHOLD
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

            return JSONResponse({"cards": cards, "message": None, "fuzzy": False})

        # ── Step 1: API call ──
        card_data = _api_search(_format_search(q))

        if card_data:
            with slug_file.open("r", encoding="utf-8") as f:
                slug_data = json.load(f)

            with info_file.open("r", encoding="utf-8") as f:
                info_data = json.load(f)

            slug = _format_search(q)

            if slug in slug_data:
                card_id = slug_data[slug]["card_id"]
                card_info = info_data.get(card_id, {})
                editions = list(card_info.get("editions", {}).keys())

                if editions:
                    edition_id = random.choice(editions)
                    rarity = card_info.get("editions", {}).get(edition_id, {}).get("rarity")
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
            return JSONResponse({"cards": cards, "message": None, "fuzzy": False})

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
        return JSONResponse({"cards": cards, "message": None, "fuzzy": fuzzy_added})

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

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

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

    inv[name] = {"default": False, "desc": desc, "public": False, "cards": {}}
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

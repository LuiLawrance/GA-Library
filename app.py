from api_ga import _api_search, _format_search, JSON_INFO, JSON_SLUGS
from datetime import datetime, timedelta
from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from rapidfuzz import process, fuzz
from user import user_create, user_login
from util_file import new_json

import json
import os

load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", 480))

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")


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
    with open("templates/index.html") as f:
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
async def api_cards_search(q: str):
    slug_file = new_json(JSON_SLUGS)
    info_file = new_json(JSON_INFO)

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    query = q.strip().lower()
    cards = []

    # ── Step 1: Substring match ──
    substring_matches = {
        slug: data for slug, data in slug_data.items()
        if query in data["name"].lower()
    }

    if substring_matches:
        for slug, data in substring_matches.items():
            card_id = data["card_id"]
            card_info = info_data.get(card_id, {})
            for edition_id in card_info.get("editions", {}):
                cards.append({
                    "edition_id": edition_id,
                    "name": data["name"],
                })
        return JSONResponse({"cards": cards, "message": None})

    # ── Step 2: Fuzzy match ──
    name_to_slug = {data["name"]: slug for slug, data in slug_data.items()}
    names = list(name_to_slug.keys())

    fuzzy_matches = process.extract(q, names, scorer=fuzz.WRatio, score_cutoff=80)

    if fuzzy_matches:
        for name, score, _ in fuzzy_matches:
            slug = name_to_slug[name]
            card_id = slug_data[slug]["card_id"]
            card_info = info_data.get(card_id, {})
            for edition_id in card_info.get("editions", {}):
                cards.append({
                    "edition_id": edition_id,
                    "name": name,
                })
        return JSONResponse({"cards": cards, "message": None})

    # ── Step 3: API call ──
    card_data = _api_search(_format_search(q))

    if not card_data:
        return JSONResponse({"cards": [], "message": f"No card found for '{q}'."})

    with slug_file.open("r", encoding="utf-8") as f:
        slug_data = json.load(f)

    with info_file.open("r", encoding="utf-8") as f:
        info_data = json.load(f)

    slug = _format_search(q)
    card_id = slug_data[slug]["card_id"]
    card_info = info_data.get(card_id, {})

    for edition_id in card_info.get("editions", {}):
        cards.append({
            "edition_id": edition_id,
            "name": slug_data[slug]["name"],
        })

    return JSONResponse({"cards": cards, "message": None})


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
         if query in data["name"].lower()},
    )

    return JSONResponse({"suggestions": suggestions[:10]})


@app.get("/api/me")
async def api_me(request: Request):
    user = get_current_user(request)

    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    return JSONResponse({"username": user})


@app.post("/api/login")
async def api_login(response: Response, username: str = Form(...), password: str = Form(...)):
    user = user_login(username, password)

    if not user:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = create_token(username)

    response.set_cookie(
        key="token",
        value=token,
        httponly=True,
        max_age=JWT_EXPIRE_MINUTES * 60
    )

    return JSONResponse({"username": username})


@app.post("/api/logout")
async def api_logout(response: Response):
    response.delete_cookie("token")
    return JSONResponse({"message": "Logged out"})


@app.post("/api/register")
async def api_register(response: Response, username: str = Form(...), password: str = Form(...)):
    try:
        user_create(username, password)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return await api_login(response, username=username, password=password)


@app.get("/images/{edition_id}.jpg")
async def get_image(edition_id: str):
    path = f"DATA_GA/IMAGES_GA/{edition_id}.jpg"

    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(path)


@app.get("/fragments/cards", response_class=HTMLResponse)
async def fragment_cards():
    with open("templates/cards.html") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/collection", response_class=HTMLResponse)
async def fragment_collection():
    with open("templates/collection.html") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/decks", response_class=HTMLResponse)
async def fragment_decks():
    with open("templates/decks.html") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/home", response_class=HTMLResponse)
async def fragment_home():
    with open("templates/home.html") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/login", response_class=HTMLResponse)
async def fragment_login():
    with open("templates/login.html") as f:
        return HTMLResponse(f.read())


@app.get("/fragments/prices", response_class=HTMLResponse)
async def fragment_prices():
    with open("templates/prices.html") as f:
        return HTMLResponse(f.read())

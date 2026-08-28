from db.models import User as UserModel
from db.session import get_session
from db_mode import is_db_mode
from deck_ga import deck_init
from inv_ga import inv_init
from pathlib import Path
from sqlalchemy import select
from util_file import new_json

import bcrypt
import json

DIR_DECK = "DATA_GA/DECK_GA"
DIR_DECKS = "DATA_GA/DECKS_GA"
DIR_INV = "DATA_GA/INV_GA"
DIR_WISH = "DATA_GA/WISH_GA"

JSON_USERS = "DATA_GENERAL/USERS.json"

# Highest to lowest privilege. The first user ever created becomes "owner";
# everyone who signs up after that starts at the base "user" rank.
RANK_ORDER = ["owner", "admin", "moderator", "user"]


def _load_users_data() -> dict:
    users_file = new_json(JSON_USERS)

    with users_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def _save_users_data(data: dict) -> None:
    with new_json(JSON_USERS).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def user_create(username: str, password: str, debug: bool = False) -> None:
    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

    if is_db_mode():
        with get_session() as session:
            if session.get(UserModel, username):
                raise ValueError(f"Username already taken: {username}")

            is_first_user = session.execute(select(UserModel.username).limit(1)).first() is None

            session.add(UserModel(
                username=username,
                password_hash=hashed.decode("utf-8"),
                auth_type="owner" if is_first_user else "user",
                notes=[],
            ))

        # Inventory/decks/wishlist aren't DB-wired yet (see the migration
        # plan's Stage 1 scope) — a user created in DB mode gets none of
        # those until a later stage adds them here too.
        if debug:
            print(f"Created user (DB): {username}")

        return

    users_data = _load_users_data()

    if username in users_data:
        raise ValueError(f"Username already taken: {username}")

    users_data[username] = {
        "auth_type": "owner" if not users_data else "user",
        "password": hashed.decode("utf-8"),
        "notes": []
    }

    _save_users_data(users_data)

    inv_init(username, debug)
    deck_init(username, debug)
    new_json(f"{DIR_WISH}/{username}.json", debug)

    if debug:
        print(f"Created user: {username}")


def user_delete(username: str, debug: bool = False) -> None:
    if is_db_mode():
        with get_session() as session:
            user = session.get(UserModel, username)

            if not user:
                print(f"User not found: {username}")
                return

            # Inventory/decks/watchlist rows for this user (if any were
            # imported by scripts/migrate_json_to_pg.py) cascade with it —
            # see the ondelete="CASCADE" on those tables' username FK.
            session.delete(user)

        if debug:
            print(f"Deleted user (DB): {username}")

        return

    users_data = _load_users_data()

    if username not in users_data:
        print(f"User not found: {username}")
        return

    del users_data[username]

    _save_users_data(users_data)

    for directory in (DIR_DECK, DIR_INV, DIR_WISH):
        file = Path(f"{directory}/{username}.json")

        if file.exists():
            file.unlink()

            if debug:
                print(f"Deleted file: {file}")
        else:
            if debug:
                print(f"File not found: {file}")

    # Remove individual deck files
    decks_dir = Path(f"{DIR_DECKS}/{username}")

    if decks_dir.exists():
        for deck_file in decks_dir.iterdir():
            deck_file.unlink()

            if debug:
                print(f"Deleted file: {deck_file}")

        decks_dir.rmdir()

        if debug:
            print(f"Deleted directory: {decks_dir}")

    if debug:
        print(f"Deleted user: {username}")


def user_login(username: str, password: str, debug: bool = False) -> str | None:
    if is_db_mode():
        with get_session() as session:
            user = session.get(UserModel, username)
            hashed = user.password_hash.encode("utf-8") if user else None
    else:
        users_data = _load_users_data()
        hashed = users_data.get(username, {}).get("password", "").encode("utf-8") if username in users_data else None

    if hashed is None:
        if debug:
            print(f"User not found: {username}")
        return None

    if not bcrypt.checkpw(password.encode("utf-8"), hashed):
        if debug:
            print(f"Invalid password for user: {username}")
        return None

    if debug:
        print(f"Login successful: {username}")

    return username


def user_reset(username: str, password: str, debug: bool = False) -> None:
    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

    if is_db_mode():
        with get_session() as session:
            user = session.get(UserModel, username)

            if not user:
                print(f"User not found: {username}")
                return

            user.password_hash = hashed.decode("utf-8")

        if debug:
            print(f"Reset password for user (DB): {username}")

        return

    users_data = _load_users_data()

    if username not in users_data:
        print(f"User not found: {username}")
        return

    users_data[username]["password"] = hashed.decode("utf-8")

    _save_users_data(users_data)

    if debug:
        print(f"Reset password for user: {username}")


def user_get_auth_type(username: str) -> str | None:
    if is_db_mode():
        with get_session() as session:
            user = session.get(UserModel, username)
            return user.auth_type if user else None

    return _load_users_data().get(username, {}).get("auth_type")


def user_list() -> list[dict]:
    """[{username, auth_type}, ...] for every user — feeds the Admin Users panel."""
    if is_db_mode():
        with get_session() as session:
            rows = session.execute(select(UserModel.username, UserModel.auth_type)).all()
            return [{"username": row.username, "auth_type": row.auth_type} for row in rows]

    return [
        {"username": username, "auth_type": info.get("auth_type")}
        for username, info in _load_users_data().items()
    ]


def user_set_role(username: str, auth_type: str) -> None:
    if is_db_mode():
        with get_session() as session:
            user = session.get(UserModel, username)
            user.auth_type = auth_type
        return

    users_data = _load_users_data()
    users_data[username]["auth_type"] = auth_type
    _save_users_data(users_data)

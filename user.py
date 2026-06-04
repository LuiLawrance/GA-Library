from pathlib import Path
from util_file import new_json

import bcrypt
import json

DIR_DECK = "DATA_GA/DECK_GA"
DIR_INV = "DATA_GA/INV_GA"
DIR_WISH = "DATA_GA/WISH_GA"

JSON_USERS = "DATA_GENERAL/USERS.json"


def user_create(username: str, password: str, debug: bool = False) -> None:
    users_file = new_json(JSON_USERS)

    with users_file.open("r", encoding="utf-8") as f:
        users_data = json.load(f)

    if username in users_data:
        print(f"User already exists: {username}")
        return

    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

    users_data[username] = {
        "auth_type": "local",
        "password": hashed.decode("utf-8"),
        "notes": []
    }

    with users_file.open("w", encoding="utf-8") as f:
        json.dump(users_data, f, indent=4, ensure_ascii=False)

    new_json(f"{DIR_INV}/{username}.json", debug)
    new_json(f"{DIR_WISH}/{username}.json", debug)
    new_json(f"{DIR_DECK}/{username}.json", debug)

    if debug:
        print(f"Created user: {username}")


def user_delete(username: str, debug: bool = False) -> None:
    users_file = new_json(JSON_USERS)

    with users_file.open("r", encoding="utf-8") as f:
        users_data = json.load(f)

    if username not in users_data:
        print(f"User not found: {username}")
        return

    del users_data[username]

    with users_file.open("w", encoding="utf-8") as f:
        json.dump(users_data, f, indent=4, ensure_ascii=False)

    for directory in (DIR_DECK, DIR_INV, DIR_WISH):
        file = Path(f"{directory}/{username}.json")

        if file.exists():
            file.unlink()

            if debug:
                print(f"Deleted file: {file}")
        else:
            if debug:
                print(f"File not found: {file}")

    if debug:
        print(f"Deleted user: {username}")


def user_login(username: str, password: str, debug: bool = False) -> str | None:
    users_file = new_json(JSON_USERS)

    with users_file.open("r", encoding="utf-8") as f:
        users_data = json.load(f)

    if username not in users_data:
        if debug:
            print(f"User not found: {username}")
        return None

    hashed = users_data[username]["password"].encode("utf-8")

    if not bcrypt.checkpw(password.encode("utf-8"), hashed):
        if debug:
            print(f"Invalid password for user: {username}")
        return None

    if debug:
        print(f"Login successful: {username}")

    return username


def user_reset(username: str, password: str, debug: bool = False) -> None:
    users_file = new_json(JSON_USERS)

    with users_file.open("r", encoding="utf-8") as f:
        users_data = json.load(f)

    if username not in users_data:
        print(f"User not found: {username}")
        return

    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

    users_data[username]["password"] = hashed.decode("utf-8")

    with users_file.open("w", encoding="utf-8") as f:
        json.dump(users_data, f, indent=4, ensure_ascii=False)

    if debug:
        print(f"Reset password for user: {username}")

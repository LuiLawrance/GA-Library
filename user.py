import file
import json

USER_FILE_PATH = "DATA_CLIENT/GA_USERS/GA_USERS.json"


def _load_users():
    path = file.new_json(USER_FILE_PATH)

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        return {}

    for username, user_data in data.items():
        saved_cards = user_data.get("saved_cards", {})

        if isinstance(saved_cards, list):
            user_data["saved_cards"] = {}

        elif not isinstance(saved_cards, dict):
            user_data["saved_cards"] = {}

    return data


def _save_users(data: dict):
    path = file.new_json(USER_FILE_PATH)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)


def check_user(username: str):
    users = _load_users()

    if username in users:
        return True
    else:
        return False


def new_user(username: str, password: str):
    users = _load_users()

    if username in users:
        print(f"User '{username}' already exists.")
        return False

    users[username] = {
        'password': password,
    }

    _save_users(users)
    print(f"User '{username}' created.")
    return True


def reset_password(username: str):
    users = _load_users()

    if username in users:
        new_password = input("Enter new password: ")
        users[username]['password'] = new_password
        _save_users(users)
    else:
        print(f"User '{username}' does not exist.")


def user_login(username: str, password: str):
    users = _load_users()

    if username not in users:
        print(f"User '{username}' does not exist.")
        return None

    if users[username]['password'] != password:
        print(f"Password incorrect.")
        return None

    print(f"\nWelcome back, {username}!\n")
    return username

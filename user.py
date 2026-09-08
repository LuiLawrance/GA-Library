from db.models import User as UserModel
from db.session import get_session
from db_mode import is_db_mode
from deck_ga import deck_init
from inv_ga import inv_init
from pathlib import Path
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from util_file import new_json

from datetime import datetime, timezone

import bcrypt
import json

DIR_DECK = "DATA_GA/DECK_GA"
DIR_DECKS = "DATA_GA/DECKS_GA"
DIR_INV = "DATA_GA/INV_GA"
DIR_WISH = "DATA_GA/WISH_GA"

JSON_USERS = "DATA_GENERAL/USERS.json"

# Highest to lowest privilege. The first user ever created becomes "owner";
# everyone who signs up after that starts at the base "user" rank. Each rank
# inherits everything the rank below it can do, plus more — see the tier sets
# and require_* helpers in app.py for what each one unlocks in the admin
# console (moderator → Users tab, admin → Cards tab + user management,
# super_admin → System tab).
RANK_ORDER = ["owner", "super_admin", "admin", "moderator", "user"]


def _load_users_data() -> dict:
    users_file = new_json(JSON_USERS)

    with users_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def _save_users_data(data: dict) -> None:
    with new_json(JSON_USERS).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def _get_user(session, username: str) -> UserModel | None:
    """Look up a user row by username (DB mode). username is no longer the
    primary key — see db/models.py's User — so this replaces the old
    session.get(UserModel, username) shortcut."""
    return session.execute(select(UserModel).where(UserModel.username == username)).scalar_one_or_none()


def user_create(username: str, password: str | None, omnidex_id: str | None = None,
                google_sub: str | None = None, google_email: str | None = None,
                debug: bool = False) -> None:
    """omnidex_id is supplied at registration (see api_register); it must be
    unique across all users, and is write-once — there's no way to change it
    afterward. Format validation happens in the caller.

    password is None for a Google-only account (Sign in with Google) — no
    password is hashed or stored, and the stored value stays NULL / null so
    user_login refuses password login for it (distinct from the "" an admin
    reset leaves, which allows a one-time blank login). google_sub, when
    given, is Google's stable per-user id and must be unique across all users.
    """
    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()) if password is not None else None
    omnidex_id = omnidex_id or None
    google_sub = google_sub or None
    google_email = google_email or None

    if is_db_mode():
        with get_session() as session:
            if _get_user(session, username):
                raise ValueError(f"Username already taken: {username}")

            if omnidex_id and session.execute(
                select(UserModel.username).where(UserModel.omnidex_id == omnidex_id)
            ).first():
                raise ValueError("That Omnidex ID is already taken")

            if google_sub and session.execute(
                select(UserModel.username).where(UserModel.google_sub == google_sub)
            ).first():
                raise ValueError("That Google account is already linked to another user")

            is_first_user = session.execute(select(UserModel.username).limit(1)).first() is None

            session.add(UserModel(
                username=username,
                password_hash=hashed.decode("utf-8") if hashed is not None else None,
                auth_type="owner" if is_first_user else "user",
                notes=[],
                bio="",
                omnidex_id=omnidex_id,
                admin_note="",
                google_sub=google_sub,
                google_email=google_email,
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

    if omnidex_id and any(info.get("omnidex_id") == omnidex_id for info in users_data.values()):
        raise ValueError("That Omnidex ID is already taken")

    if google_sub and any(info.get("google_sub") == google_sub for info in users_data.values()):
        raise ValueError("That Google account is already linked to another user")

    users_data[username] = {
        "auth_type": "owner" if not users_data else "user",
        "password": hashed.decode("utf-8") if hashed is not None else None,
        "notes": [],
        "bio": "",
        "omnidex_id": omnidex_id,
        "admin_note": "",
        "google_sub": google_sub,
        "google_email": google_email,
        "created_at": datetime.now(timezone.utc).isoformat(),
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
            user = _get_user(session, username)

            if not user:
                print(f"User not found: {username}")
                return

            # Inventory/decks/watchlist rows for this user (if any were
            # imported by scripts/migrate_json_to_pg.py) cascade with it —
            # see the ondelete="CASCADE" on those tables' user_id FK.
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
            user = _get_user(session, username)
            user_exists = user is not None
            raw_hash = user.password_hash if user else None
    else:
        users_data = _load_users_data()
        user_exists = username in users_data
        raw_hash = users_data.get(username, {}).get("password") if user_exists else None

    if not user_exists:
        if debug:
            print(f"User not found: {username}")
        return None

    # A Google-only account (Sign in with Google) never set a password — the
    # stored value is NULL / null, and password login is refused outright.
    # This is distinct from the "" an admin reset leaves (handled below).
    if raw_hash is None:
        if debug:
            print(f"No password login for user: {username}")
        return None

    hashed = raw_hash.encode("utf-8")

    # An admin-cleared password is stored as "" — it only accepts a blank
    # password, and the user is forced to set a new one right after login
    # (see user_needs_setup / the account-setup gate in app.js).
    if hashed == b"":
        return username if password == "" else None

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
            user = _get_user(session, username)

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


def user_get_id(username: str) -> int | None:
    """The surrogate users.id for a username (DB mode only) — resolves the
    user_id FK value for inventory_bins/decks/watchlist_entries/
    wishlist_entries, which key off id rather than username. Returns None in
    JSON mode (those tables aren't JSON files keyed by username at all) or if
    the username doesn't exist."""
    if not is_db_mode():
        return None

    with get_session() as session:
        user = _get_user(session, username)
        return user.id if user else None


def user_get_auth_type(username: str) -> str | None:
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)
            return user.auth_type if user else None

    return _load_users_data().get(username, {}).get("auth_type")


def user_find_by_omnidex(omnidex_id: str) -> str | None:
    """Username for a given Omnidex ID, or None. Omnidex IDs are unique, so
    this is the lookup behind the public /@<omnidex_id> profile route."""
    if not omnidex_id:
        return None

    if is_db_mode():
        with get_session() as session:
            row = session.execute(
                select(UserModel.username).where(UserModel.omnidex_id == omnidex_id)
            ).first()
            return row.username if row else None

    return next(
        (username for username, info in _load_users_data().items()
         if info.get("omnidex_id") == omnidex_id),
        None,
    )


def user_list() -> list[dict]:
    """[{username, auth_type, omnidex_id}, ...] for every user — feeds the Admin
    Users panel. omnidex_id is None until the user sets one."""
    if is_db_mode():
        with get_session() as session:
            rows = session.execute(
                select(UserModel.username, UserModel.auth_type, UserModel.omnidex_id)
            ).all()
            return [
                {"username": row.username, "auth_type": row.auth_type, "omnidex_id": row.omnidex_id}
                for row in rows
            ]

    return [
        {"username": username, "auth_type": info.get("auth_type"), "omnidex_id": info.get("omnidex_id")}
        for username, info in _load_users_data().items()
    ]


def user_set_role(username: str, auth_type: str) -> None:
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)
            user.auth_type = auth_type
        return

    users_data = _load_users_data()
    users_data[username]["auth_type"] = auth_type
    _save_users_data(users_data)


def user_get_profile(username: str) -> dict | None:
    """{username, auth_type, bio, omnidex_id, admin_note, created_at} — feeds
    the self-service Profile page and the Admin -> Users panel.

    created_at is an ISO string in DB mode and for JSON users created since the
    field was added — None for older JSON accounts that predate it. omnidex_id
    is None until the user sets it. admin_note is admin-only free text.
    """
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)

            if not user:
                return None

            return {
                "username": user.username,
                "auth_type": user.auth_type,
                "bio": user.bio or "",
                "omnidex_id": user.omnidex_id,
                "admin_note": user.admin_note or "",
                "created_at": user.created_at.isoformat() if user.created_at else None,
            }

    info = _load_users_data().get(username)

    if info is None:
        return None

    return {
        "username": username,
        "auth_type": info.get("auth_type"),
        "bio": info.get("bio", ""),
        "omnidex_id": info.get("omnidex_id"),
        "admin_note": info.get("admin_note", ""),
        "created_at": info.get("created_at"),
    }


_NO_SETUP = {"must_set_omnidex": False, "must_set_password": False}


def user_needs_setup(username: str) -> dict:
    """{must_set_omnidex, must_set_password} — an admin can clear either from
    the Admin -> Users panel, which forces the user to re-enter it before they
    can use anything (the account-setup gate in app.js, plus a server-side
    middleware check).

    Returns all-False for an unknown user — e.g. a stale auth cookie left over
    after the data was wiped. Without this, a fresh install with such a cookie
    would show the setup gate for a phantom account.
    """
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)
            if not user:
                return dict(_NO_SETUP)
            return {
                "must_set_omnidex": user.omnidex_id is None,
                "must_set_password": user.password_hash == "",
            }

    info = _load_users_data().get(username)
    if info is None:
        return dict(_NO_SETUP)
    return {
        "must_set_omnidex": not info.get("omnidex_id"),
        # "" means an admin cleared it (blank login, must reset). None/missing
        # means a Google-only account that never had one — not a setup step.
        "must_set_password": info.get("password") == "",
    }


def user_set_bio(username: str, bio: str) -> None:
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)
            user.bio = bio
        return

    users_data = _load_users_data()
    users_data[username]["bio"] = bio
    _save_users_data(users_data)


def user_set_admin_note(username: str, note: str) -> None:
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)
            user.admin_note = note
        return

    users_data = _load_users_data()
    users_data[username]["admin_note"] = note
    _save_users_data(users_data)


def user_set_omnidex_id(username: str, omnidex_id: str) -> None:
    """Assign a user's Omnidex ID (used by the account-setup gate when an admin
    has cleared it). Raises ValueError if another account already uses that ID.
    The write-once rule — can only be set while currently unset — is enforced
    by the caller (app.py)."""
    if is_db_mode():
        with get_session() as session:
            clash = session.execute(
                select(UserModel.username).where(UserModel.omnidex_id == omnidex_id)
            ).first()

            if clash and clash.username != username:
                raise ValueError("That Omnidex ID is already taken")

            user = _get_user(session, username)
            user.omnidex_id = omnidex_id

            try:
                session.flush()
            except IntegrityError:
                raise ValueError("That Omnidex ID is already taken")

        return

    users_data = _load_users_data()

    for other, info in users_data.items():
        if other != username and info.get("omnidex_id") == omnidex_id:
            raise ValueError("That Omnidex ID is already taken")

    users_data[username]["omnidex_id"] = omnidex_id
    _save_users_data(users_data)


def user_admin_reset_omnidex(username: str) -> None:
    """Clear a user's Omnidex ID — they must re-enter one on next login."""
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)
            if user:
                user.omnidex_id = None
        return

    users_data = _load_users_data()
    if username in users_data:
        users_data[username]["omnidex_id"] = None
        _save_users_data(users_data)


def user_admin_reset_password(username: str) -> None:
    """Clear a user's password to "" — they log in with a blank password, then
    must set a new one before doing anything (see user_login / user_needs_setup)."""
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)
            if user:
                user.password_hash = ""
        return

    users_data = _load_users_data()
    if username in users_data:
        users_data[username]["password"] = ""
        _save_users_data(users_data)


# ── Google account link (Sign in with Google) ────────────────────────────────

def user_find_by_google_sub(google_sub: str) -> str | None:
    """Username linked to a given Google `sub` claim, or None. google_sub is
    unique, so this backs the "returning Google user" fast path in
    /api/auth/google."""
    if not google_sub:
        return None

    if is_db_mode():
        with get_session() as session:
            row = session.execute(
                select(UserModel.username).where(UserModel.google_sub == google_sub)
            ).first()
            return row.username if row else None

    return next(
        (username for username, info in _load_users_data().items()
         if info.get("google_sub") == google_sub),
        None,
    )


def user_link_google(username: str, google_sub: str, google_email: str | None) -> None:
    """Attach a Google account to an existing user. Raises ValueError if that
    Google `sub` is already linked to a different account."""
    google_email = google_email or None

    if is_db_mode():
        with get_session() as session:
            clash = session.execute(
                select(UserModel.username).where(UserModel.google_sub == google_sub)
            ).first()
            if clash and clash.username != username:
                raise ValueError("That Google account is already linked to another user")

            user = _get_user(session, username)
            if user:
                user.google_sub = google_sub
                user.google_email = google_email
        return

    users_data = _load_users_data()

    for other, info in users_data.items():
        if other != username and info.get("google_sub") == google_sub:
            raise ValueError("That Google account is already linked to another user")

    if username in users_data:
        users_data[username]["google_sub"] = google_sub
        users_data[username]["google_email"] = google_email
        _save_users_data(users_data)


def user_unlink_google(username: str) -> None:
    """Detach any linked Google account from a user."""
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)
            if user:
                user.google_sub = None
                user.google_email = None
        return

    users_data = _load_users_data()
    if username in users_data:
        users_data[username]["google_sub"] = None
        users_data[username]["google_email"] = None
        _save_users_data(users_data)


def user_get_google_email(username: str) -> str | None:
    """The linked Google account's email for a user, or None if none linked."""
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)
            return user.google_email if user else None

    return _load_users_data().get(username, {}).get("google_email")


def user_has_password(username: str) -> bool:
    """Whether a user can log in with a password — a real hash is stored (not
    NULL for a Google-only account, and not the "" an admin reset leaves).
    Backs the "set a password before you can unlink Google" guard."""
    if is_db_mode():
        with get_session() as session:
            user = _get_user(session, username)
            return bool(user and user.password_hash)

    return bool(_load_users_data().get(username, {}).get("password"))

"""Resolve and persist the DATABASE_URL used when Use JSON is off.

Two layers, JSON wins:

  * The environment value — DATABASE_URL from .env in local dev, or the
    platform-injected variable on Railway — is a read-only DEFAULT. Nothing
    here ever writes it back, so the committed .env stays a clean default.

  * Any connection the admin saves through Admin -> System -> "Database
    Connection" is stored under the `database_url` key in
    DATA_GENERAL/SETTINGS.json and takes priority over the environment value.

resolved_database_url() is what the app (db/session.py), Alembic
(alembic/env.py) and the migrate script all connect with. SETTINGS.json is
read directly here — like db_mode.py, and for the same reason — so the URL
resolves at the same bootstrap layer as use_json without pulling in the whole
settings module.
"""

import json
import os

from util_file import new_json

JSON_SETTINGS = "DATA_GENERAL/SETTINGS.json"
_URL_KEY = "database_url"


def _load() -> dict:
    with new_json(JSON_SETTINGS).open("r", encoding="utf-8") as f:
        return json.load(f)


def _save(data: dict) -> None:
    with new_json(JSON_SETTINGS).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def _clean(value) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def env_database_url() -> str | None:
    """The read-only default from the environment (.env locally, the platform
    variable on Railway). Never written by this app."""
    return _clean(os.getenv("DATABASE_URL"))


def saved_database_url() -> str | None:
    """The admin-saved override from SETTINGS.json, or None if unset."""
    return _clean(_load().get(_URL_KEY))


def resolved_database_url() -> str | None:
    """The connection string actually in effect: the SETTINGS.json override if
    the admin has saved one, otherwise the environment default."""
    return saved_database_url() or env_database_url()


def save_database_url(url: str) -> None:
    """Persist an admin-edited connection string to SETTINGS.json. The .env
    file / platform variable is left untouched."""
    data = _load()
    data[_URL_KEY] = url
    _save(data)


def clear_database_url() -> None:
    """Drop the SETTINGS.json override so the environment default applies
    again."""
    data = _load()
    if data.pop(_URL_KEY, None) is not None:
        _save(data)

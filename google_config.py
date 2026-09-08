"""Resolve and persist the "Sign in with Google" configuration.

Same two-layer model as db_connection.py, JSON wins:

  * The environment value — GOOGLE_CLIENT_ID from .env in local dev, or a
    platform-injected variable — is a read-only DEFAULT. Nothing here ever
    writes it back, so the committed .env stays a clean default.

  * A client ID the admin saves through Admin -> System -> "Google Sign-In"
    is stored under `google_client_id` in DATA_GENERAL/SETTINGS.json and takes
    priority over the environment value.

The feature as a whole is gated by the `google_signin_enabled` toggle (a plain
bool in settings.py's SETTINGS_DEFAULTS, flipped via /api/admin/settings like
the other System switches). While it's off, resolved_google_client_id()
returns None so every consumer treats Google sign-in as unconfigured.

SETTINGS.json is read directly here — like db_connection.py and db_mode.py,
and for the same reason — so the config resolves at the same bootstrap layer
as use_json without pulling in the whole settings module.
"""

import json
import os

from util_file import new_json

JSON_SETTINGS = "DATA_GENERAL/SETTINGS.json"
_ID_KEY = "google_client_id"
_ENABLED_KEY = "google_signin_enabled"


def _load() -> dict:
    with new_json(JSON_SETTINGS).open("r", encoding="utf-8") as f:
        return json.load(f)


def _save(data: dict) -> None:
    with new_json(JSON_SETTINGS).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def _clean(value) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def env_google_client_id() -> str | None:
    """The read-only default from the environment (.env locally, the platform
    variable when hosted). Never written by this app."""
    return _clean(os.getenv("GOOGLE_CLIENT_ID"))


def saved_google_client_id() -> str | None:
    """The admin-saved override from SETTINGS.json, or None if unset."""
    return _clean(_load().get(_ID_KEY))


def google_signin_enabled() -> bool:
    """Whether the Admin -> System "Google Sign-In" toggle is on."""
    return bool(_load().get(_ENABLED_KEY, False))


def resolved_google_client_id() -> str | None:
    """The client ID actually in effect: None when the toggle is off, else the
    SETTINGS.json override if the admin has saved one, otherwise the
    environment default (still None if neither is set)."""
    if not google_signin_enabled():
        return None
    return saved_google_client_id() or env_google_client_id()


def save_google_client_id(value: str) -> None:
    """Persist an admin-edited client ID to SETTINGS.json. The .env file /
    platform variable is left untouched. An empty string clears the override
    so the environment default applies again."""
    data = _load()
    cleaned = (value or "").strip()

    if cleaned:
        data[_ID_KEY] = cleaned
    else:
        data.pop(_ID_KEY, None)

    _save(data)

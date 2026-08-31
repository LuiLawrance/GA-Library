from db_mode import ensure_use_json_default
from util_file import new_json

import json

JSON_SETTINGS = "DATA_GENERAL/SETTINGS.json"

# Admin settings are ALWAYS JSON-resident, in every mode — SETTINGS.json is
# the single source of truth and is never mirrored into Postgres. (It
# persists on Railway too: DATA_GENERAL is symlinked onto the DATA_GA volume
# — see the Dockerfile.) use_json in particular *must* stay in JSON since
# it's what decides whether to read the DB at all; the rest just follow the
# same rule for consistency. use_json is the single storage switch (Off →
# the Postgres at the Database Connection settings, On → flat JSON); its
# default is resolved by ensure_use_json_default (which also migrates the
# old local_database key away), not the flat default here — see db_mode.py.
SETTINGS_DEFAULTS = {
    "store_images_locally": False,
    # Static default here only for /api/admin/settings' key-validation loop
    # (app.py) — ensure_use_json_default always runs first in load_settings
    # and, once use_json is already on disk, this default never actually
    # applies (the "missing keys" fill-in below skips keys already present).
    "use_json": True,
    # Only meaningful when use_json is off. Marks this deployment as running
    # on a local machine (True) vs a hosted box such as Railway (False), which
    # can't spawn the headless-Chromium TCGPlayer scrapers. Gates the Cards
    # page's live TCGPlayer controls client-side — the per-row 🔍 auto
    # product-ID finder and the Refresh Sales/Listings/Selected buttons (see
    # adminPidProductIdFieldHtml / updateAdminPidRefreshButton in admin.js).
    # Defaults off so a fresh hosted deployment never shows controls it can't
    # run; flip it on from the System page when running locally.
    "local_db": True,
}


def _load_json_settings() -> dict:
    settings_file = new_json(JSON_SETTINGS)

    with settings_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def _save_json_settings(data: dict) -> None:
    with new_json(JSON_SETTINGS).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def load_settings() -> dict:
    data = ensure_use_json_default(_load_json_settings())

    missing = {k: v for k, v in SETTINGS_DEFAULTS.items() if k not in data}
    if missing:
        data.update(missing)
        _save_json_settings(data)

    return data


def save_settings(data: dict) -> None:
    json_data = _load_json_settings()
    json_data.update(data)
    _save_json_settings(json_data)

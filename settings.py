from db.models import AppSetting
from db.session import get_session
from db_mode import ensure_use_json_default, is_db_mode
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from util_file import new_json

import json

JSON_SETTINGS = "DATA_GENERAL/SETTINGS.json"

# use_json and local_database are always JSON-resident, never migrated to
# Postgres — they're what decides whether to read the DB at all, so neither
# can itself require a DB read to resolve. See db_mode.py. use_json is the
# master switch (On hides/overrides Local Database and forces JSON); its
# default is derived from local_database the first time it's read after
# being introduced, not a flat default here — see ensure_use_json_default.
JSON_ONLY_KEYS = {"use_json", "local_database"}

SETTINGS_DEFAULTS = {
    "store_images_locally": False,
    "local_database": False,
    # Static default here only for /api/admin/settings' key-validation loop
    # (app.py) — ensure_use_json_default always runs first in load_settings
    # and, once use_json is already on disk, this default never actually
    # applies (the "missing keys" fill-in below skips keys already present).
    "use_json": True,
}


def _load_json_settings() -> dict:
    settings_file = new_json(JSON_SETTINGS)

    with settings_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def _save_json_settings(data: dict) -> None:
    with new_json(JSON_SETTINGS).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def load_settings() -> dict:
    json_data = ensure_use_json_default(_load_json_settings())
    json_only = {k: json_data.get(k) for k in JSON_ONLY_KEYS}

    if not is_db_mode():
        missing = {k: v for k, v in SETTINGS_DEFAULTS.items() if k not in json_data}
        if missing:
            json_data.update(missing)
            _save_json_settings(json_data)
        return json_data

    with get_session() as session:
        db_data = {row.key: row.value for row in session.execute(select(AppSetting)).scalars()}

    other_defaults = {k: v for k, v in SETTINGS_DEFAULTS.items() if k not in JSON_ONLY_KEYS}
    missing = {k: v for k, v in other_defaults.items() if k not in db_data}
    if missing:
        db_data.update(missing)
        save_settings({**db_data, **json_only})

    return {**db_data, **json_only}


def save_settings(data: dict) -> None:
    json_only_updates = {k: bool(data[k]) for k in JSON_ONLY_KEYS if k in data}
    if json_only_updates:
        json_data = _load_json_settings()
        json_data.update(json_only_updates)
        _save_json_settings(json_data)

    other = {k: v for k, v in data.items() if k not in JSON_ONLY_KEYS}

    if not is_db_mode():
        json_data = _load_json_settings()
        json_data.update(other)
        _save_json_settings(json_data)
        return

    if not other:
        return

    with get_session() as session:
        for key, value in other.items():
            stmt = pg_insert(AppSetting).values(key=key, value=bool(value)).on_conflict_do_update(
                index_elements=["key"], set_={"value": bool(value)},
            )
            session.execute(stmt)

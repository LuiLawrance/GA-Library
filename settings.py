from util_file import new_json

import json

JSON_SETTINGS = "DATA_GENERAL/SETTINGS.json"

SETTINGS_DEFAULTS = {
    "store_images_locally": False,
    "local_database": False,
}


def load_settings() -> dict:
    settings_file = new_json(JSON_SETTINGS)

    with settings_file.open("r", encoding="utf-8") as f:
        data = json.load(f)

    # A fresh file starts as {} (see new_json) — fill in any default keys
    # missing from it, but never overwrite a value already on disk, so an
    # existing SETTINGS.json is always the source of truth once it exists.
    missing = {k: v for k, v in SETTINGS_DEFAULTS.items() if k not in data}
    if missing:
        data.update(missing)
        save_settings(data)

    return data


def save_settings(data: dict) -> None:
    with new_json(JSON_SETTINGS).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)

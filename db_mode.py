from util_file import new_json

import json

JSON_SETTINGS = "DATA_GENERAL/SETTINGS.json"


def _load() -> dict:
    settings_file = new_json(JSON_SETTINGS)

    with settings_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def _save(data: dict) -> None:
    with new_json(JSON_SETTINGS).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def ensure_use_json_default(data: dict | None = None) -> dict:
    """Backfills SETTINGS.json's use_json key the first time it's read after
    this switch was introduced. use_json is the master switch — On hides and
    overrides the Local Database toggle, Off reveals it — so a brand new
    install should default to use_json=True (JSON, no DB needed). But an
    install that had already turned local_database on defaults instead to
    use_json=False, so upgrading doesn't silently switch a working DB setup
    back to JSON. Returns the (possibly just-updated) settings dict; callers
    that already have `data` loaded can pass it in to avoid a second read."""
    if data is None:
        data = _load()

    if "use_json" not in data:
        data["use_json"] = not bool(data.get("local_database", False))
        _save(data)

    return data


def is_db_mode() -> bool:
    """Whether storage-aware modules should read/write Postgres instead of JSON.

    Reads DATA_GENERAL/SETTINGS.json directly rather than going through
    settings.py's load_settings() — both use_json and local_database have to
    be resolvable without first knowing whether to read the DB, so they (and
    only they) always live in JSON regardless of this function's answer.

    True only when JSON is explicitly turned off AND the Local Database
    switch (only meaningful/visible in the UI once use_json is off) is on.
    """
    data = ensure_use_json_default()

    return (not data["use_json"]) and bool(data.get("local_database", False))

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
    """Keeps SETTINGS.json's single storage switch, use_json, in a sane shape.

    use_json is the one storage switch: On → flat JSON files, Off → the
    Postgres at the Database Connection settings. It used to be paired with a
    second `local_database` key (Off + local_database On meant database); that
    was merged away — Off alone now means database. This backfills/migrates:

      * A brand-new install with no use_json key → use_json=True (JSON, no DB
        setup needed).
      * An older install that only had local_database → use_json takes its
        inverse (local_database On ⇒ use_json=False), so a working DB setup
        isn't silently switched back to JSON on upgrade.
      * Any leftover local_database key is then dropped.

    Returns the (possibly just-updated) settings dict; callers that already
    have `data` loaded can pass it in to avoid a second read."""
    if data is None:
        data = _load()

    dirty = False

    if "use_json" not in data:
        data["use_json"] = not bool(data.get("local_database", False))
        dirty = True

    if "local_database" in data:
        del data["local_database"]
        dirty = True

    if dirty:
        _save(data)

    return data


def is_db_mode() -> bool:
    """Whether storage-aware modules should read/write Postgres instead of JSON.

    Reads DATA_GENERAL/SETTINGS.json directly rather than going through
    settings.py's load_settings() — use_json has to be resolvable without
    first knowing whether to read the DB, so it (and only it) always lives in
    JSON regardless of this function's answer.

    True whenever JSON is explicitly turned off (see the System page's single
    Use JSON switch — Off means "use the database at the Database Connection
    settings").
    """
    return not ensure_use_json_default()["use_json"]

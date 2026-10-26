"""The Timeline — admin-curated dated milestones (set releases, World /
Ascent tournaments, banlist updates, ...) recorded from Admin → Cards →
Events (see admin.js), so other features can line their data up against
them later (e.g. price history around a set release).

Deliberately separate from the Omnidex events store (events_ga.py): those are
API snapshots that a refresh rewrites and an admin can delete, these are
hand-entered. A tournament the Omnidex knows about is linked by its event id
(omnidex_event_id) — the Events page shows that link from its side (see
api_event_detail in app.py), so the two stay mutually connected without
sharing a table. The id is a plain value, not a foreign key: the link
survives the Omnidex event being deleted locally and re-fetched later.

Storage follows is_db_mode(): the timeline_events table
(db.models.TimelineEvent) in DB mode, JSON_TIMELINE otherwise.
"""

from datetime import date, datetime, timezone
from db.models import TimelineEvent
from db.session import get_session
from db_mode import is_db_mode
from sqlalchemy import select
from util_file import new_json

import json
import threading

JSON_TIMELINE = "DATA_GA/TIMELINE.json"

CATEGORIES = ("set_release", "tournament", "banlist", "announcement", "other")
TITLE_MAX = 200
NOTES_MAX = 2000
SET_PREFIX_MAX = 40

# JSON mode's read-modify-write isn't atomic across concurrent requests.
_json_lock = threading.Lock()


class TimelineError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _parse_date(value, field: str, required: bool) -> date | None:
    text = str(value or "").strip()
    if not text:
        if required:
            raise TimelineError(f"{field} is required")
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        raise TimelineError(f"{field} must be a YYYY-MM-DD date")


def _clean(data: dict) -> dict:
    """Validates and normalizes an editor payload into column values. Raises
    TimelineError on a missing title/date, an unknown category, or an end
    date before the start."""
    title = str(data.get("title") or "").strip()[:TITLE_MAX]
    if not title:
        raise TimelineError("Title is required")

    category = data.get("category")
    if category not in CATEGORIES:
        raise TimelineError("Unknown category")

    start = _parse_date(data.get("start_date"), "Date", required=True)
    end = _parse_date(data.get("end_date"), "End date", required=False)
    if end is not None and end < start:
        raise TimelineError("End date can't be before the start date")
    if end == start:
        end = None

    omnidex_event_id = data.get("omnidex_event_id")
    if omnidex_event_id in ("", None):
        omnidex_event_id = None
    else:
        try:
            omnidex_event_id = int(omnidex_event_id)
        except (TypeError, ValueError):
            raise TimelineError("Omnidex event id must be a number")

    return {
        "title": title,
        "category": category,
        "start_date": start,
        "end_date": end,
        "set_prefix": str(data.get("set_prefix") or "").strip()[:SET_PREFIX_MAX] or None,
        "omnidex_event_id": omnidex_event_id,
        "notes": str(data.get("notes") or "").strip()[:NOTES_MAX] or None,
    }


def _entry_dict(row: TimelineEvent) -> dict:
    return {
        "id": row.id,
        "title": row.title,
        "category": row.category,
        "start_date": _iso(row.start_date),
        "end_date": _iso(row.end_date),
        "set_prefix": row.set_prefix,
        "omnidex_event_id": row.omnidex_event_id,
        "notes": row.notes,
        "created_at": _iso(row.created_at),
        "created_by": row.created_by,
        "updated_at": _iso(row.updated_at),
        "updated_by": row.updated_by,
    }


# JSON-mode store: {"next_id": int, "entries": [entry dict, ...]} — the same
# dict shape _entry_dict() returns, so both modes hand callers identical records.
def _load_json() -> dict:
    with new_json(JSON_TIMELINE).open("r", encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("next_id", 1)
    data.setdefault("entries", [])
    return data


def _save_json(data: dict) -> None:
    with new_json(JSON_TIMELINE).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def _json_values(values: dict) -> dict:
    return {k: _iso(v) if isinstance(v, date) else v for k, v in values.items()}


def list_entries() -> list[dict]:
    """Every entry, newest first (by start date, then id)."""
    if is_db_mode():
        with get_session() as session:
            entries = [_entry_dict(row) for row in session.execute(select(TimelineEvent)).scalars().all()]
    else:
        entries = _load_json()["entries"]

    return sorted(entries, key=lambda e: (e["start_date"] or "", e["id"]), reverse=True)


def entries_for_omnidex_event(event_id: int) -> list[dict]:
    """The entries linked to one Omnidex event — the Events page's side of
    the link."""
    if is_db_mode():
        with get_session() as session:
            rows = session.execute(
                select(TimelineEvent).where(TimelineEvent.omnidex_event_id == event_id)
            ).scalars().all()
            return [_entry_dict(row) for row in rows]

    return [dict(e) for e in _load_json()["entries"] if e.get("omnidex_event_id") == event_id]


def create_entry(data: dict, username: str | None = None) -> dict:
    values = _clean(data)
    now = _now()

    if is_db_mode():
        with get_session() as session:
            row = TimelineEvent(**values, created_at=now, created_by=username)
            session.add(row)
            session.flush()
            return _entry_dict(row)

    with _json_lock:
        store = _load_json()
        entry = {
            "id": store["next_id"],
            **_json_values(values),
            "created_at": now.isoformat(),
            "created_by": username,
            "updated_at": None,
            "updated_by": None,
        }
        store["entries"].append(entry)
        store["next_id"] += 1
        _save_json(store)
    return dict(entry)


def update_entry(entry_id: int, data: dict, username: str | None = None) -> dict | None:
    """Replaces one entry's editable fields. Returns the updated entry, or
    None if there's no such id."""
    values = _clean(data)
    now = _now()

    if is_db_mode():
        with get_session() as session:
            row = session.get(TimelineEvent, entry_id)
            if row is None:
                return None
            for key, value in values.items():
                setattr(row, key, value)
            row.updated_at = now
            row.updated_by = username
            session.flush()
            return _entry_dict(row)

    with _json_lock:
        store = _load_json()
        entry = next((e for e in store["entries"] if e["id"] == entry_id), None)
        if entry is None:
            return None
        entry.update(_json_values(values))
        entry["updated_at"] = now.isoformat()
        entry["updated_by"] = username
        _save_json(store)
    return dict(entry)


def delete_entry(entry_id: int) -> bool:
    """Permanently removes one entry. Returns whether it existed."""
    if is_db_mode():
        with get_session() as session:
            row = session.get(TimelineEvent, entry_id)
            if row is None:
                return False
            session.delete(row)
            return True

    with _json_lock:
        store = _load_json()
        kept = [e for e in store["entries"] if e["id"] != entry_id]
        if len(kept) == len(store["entries"]):
            return False
        store["entries"] = kept
        _save_json(store)
    return True

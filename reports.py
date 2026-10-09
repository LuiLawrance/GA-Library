"""User-submitted issue reports — the topbar ❓ button's "Report an issue"
pop-up (see report.js) and the admin console's Reports tab (see admin.js).

Anyone can file one, signed in or not (the login page itself might be what's
broken). Each report carries the reporter's free-text message, a category,
the page they were on, their browser's user agent, and their username when
signed in. Admins resolve (or reopen) a report, optionally leaving a note;
resolved reports are kept as history, the same as the Needs Action log.

Storage follows is_db_mode(): the issue_reports table (db.models.IssueReport)
in DB mode, JSON_REPORTS otherwise.
"""

from datetime import datetime, timezone
from db.models import IssueReport
from db.session import get_session
from db_mode import is_db_mode
from sqlalchemy import select
from util_file import new_json

import json
import threading

JSON_REPORTS = "DATA_GENERAL/REPORTS.json"

CATEGORIES = ("bug", "card_data", "suggestion", "other")
MESSAGE_MAX = 2000
PAGE_URL_MAX = 500
USER_AGENT_MAX = 300
ADMIN_NOTE_MAX = 1000

# JSON mode's read-modify-write isn't atomic across concurrent requests.
_json_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _report_dict(row: IssueReport) -> dict:
    return {
        "id": row.id,
        "category": row.category,
        "message": row.message,
        "page_url": row.page_url,
        "user_agent": row.user_agent,
        "reporter": row.reporter,
        "created_at": _iso(row.created_at),
        "resolved_at": _iso(row.resolved_at),
        "resolved_by": row.resolved_by,
        "admin_note": row.admin_note,
    }


# JSON-mode store: {"next_id": int, "reports": [report dict, ...]} — the same
# dict shape _report_dict() returns, so both modes hand callers identical records.
def _load_json() -> dict:
    with new_json(JSON_REPORTS).open("r", encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("next_id", 1)
    data.setdefault("reports", [])
    return data


def _save_json(data: dict) -> None:
    with new_json(JSON_REPORTS).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)


def create_report(category: str, message: str, page_url: str | None = None,
                  user_agent: str | None = None, reporter: str | None = None) -> dict:
    """Files one report. Raises ValueError on an unknown category or an empty
    message; over-long fields are truncated rather than rejected."""
    if category not in CATEGORIES:
        raise ValueError("Unknown category")

    message = (message or "").strip()[:MESSAGE_MAX]
    if not message:
        raise ValueError("Message is required")

    page_url = (page_url or "").strip()[:PAGE_URL_MAX] or None
    user_agent = (user_agent or "").strip()[:USER_AGENT_MAX] or None
    now = _now()

    if is_db_mode():
        with get_session() as session:
            row = IssueReport(
                category=category, message=message, page_url=page_url,
                user_agent=user_agent, reporter=reporter, created_at=now,
            )
            session.add(row)
            session.flush()
            return _report_dict(row)

    with _json_lock:
        data = _load_json()
        report = {
            "id": data["next_id"],
            "category": category,
            "message": message,
            "page_url": page_url,
            "user_agent": user_agent,
            "reporter": reporter,
            "created_at": now.isoformat(),
            "resolved_at": None,
            "resolved_by": None,
            "admin_note": None,
        }
        data["reports"].append(report)
        data["next_id"] += 1
        _save_json(data)
    return dict(report)


def list_reports() -> list[dict]:
    """Every report — open first (newest on top), then resolved (most
    recently resolved on top)."""
    if is_db_mode():
        with get_session() as session:
            reports = [_report_dict(row) for row in session.execute(select(IssueReport)).scalars().all()]
    else:
        reports = _load_json()["reports"]

    open_reports = sorted((r for r in reports if not r["resolved_at"]), key=lambda r: r["created_at"], reverse=True)
    resolved = sorted((r for r in reports if r["resolved_at"]), key=lambda r: r["resolved_at"], reverse=True)
    return open_reports + resolved


def update_report(report_id: int, resolved: bool | None = None, username: str | None = None,
                  admin_note: str | None = None) -> dict | None:
    """Resolves or reopens one report (resolved=None leaves its status, and
    who resolved it, as is) and/or replaces its admin note (None leaves the
    note as is, "" clears it). Returns the updated report, or None if there's
    no such id."""
    now = _now()
    update_note = admin_note is not None
    if update_note:
        admin_note = admin_note.strip()[:ADMIN_NOTE_MAX] or None

    if is_db_mode():
        with get_session() as session:
            row = session.get(IssueReport, report_id)
            if row is None:
                return None
            if resolved is not None:
                row.resolved_at = now if resolved else None
                row.resolved_by = username if resolved else None
            if update_note:
                row.admin_note = admin_note
            session.flush()
            return _report_dict(row)

    with _json_lock:
        data = _load_json()
        row = next((r for r in data["reports"] if r["id"] == report_id), None)
        if row is None:
            return None
        if resolved is not None:
            row["resolved_at"] = now.isoformat() if resolved else None
            row["resolved_by"] = username if resolved else None
        if update_note:
            row["admin_note"] = admin_note
        _save_json(data)
    return dict(row)


def delete_report(report_id: int) -> bool:
    """Permanently removes one report (spam / junk). Returns whether it existed."""
    if is_db_mode():
        with get_session() as session:
            row = session.get(IssueReport, report_id)
            if row is None:
                return False
            session.delete(row)
            return True

    with _json_lock:
        data = _load_json()
        kept = [r for r in data["reports"] if r["id"] != report_id]
        if len(kept) == len(data["reports"]):
            return False
        data["reports"] = kept
        _save_json(data)
    return True

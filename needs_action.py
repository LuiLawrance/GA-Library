"""The admin "Needs Action" log — product pages a scrape flagged for a manual look.

The only reason today is SALES_WINDOW: the TCGPlayer scraper never logs in, and
a logged-out product page's sales popup only shows the SALES_WINDOW_SIZE most
recent sales. When a single scrape of one product page stores
SALES_WINDOW_FLAG_MIN or more new sales, older sales may have already scrolled
out of that window unseen — so the page is flagged for an admin to open
TCGPlayer while logged in and add any missing sales by hand (admin Cards ->
Needs Action, see admin.js).

One OPEN flag per (edition_id, foil_id, marketplace, reason): a re-flag while
it's still open adds to it (new_sales, scrape_count, last_flagged_at) rather
than stacking a duplicate. Resolving stamps resolved_at/resolved_by; resolved
flags are kept as the log's history.

Storage follows is_db_mode(): the pricing_flags table (db.models.PricingFlag)
in DB mode, JSON_NEEDS_ACTION otherwise. foil_id is "" for an edition's main
product page or a Curio Foil's id for its own separate one — the same
convention marketplace_scrape_clocks uses.

Each flagged scrape also records its gap: the newest sale date already on file
for that product page beforehand (previous_latest, None on a first-ever scrape)
and the earliest of the sales it newly stored (earliest_new). Missed sales, if
any, fall between those two dates — what the admin Needs Action view shows.
"""

from datetime import datetime, timezone
from db.models import Edition, PricingFlag
from db.session import get_session
from db_mode import is_db_mode
from sqlalchemy import select
from util_file import new_json

import json

JSON_NEEDS_ACTION = "DATA_GA/PRICING_GA/NEEDS_ACTION.json"

REASON_SALES_WINDOW = "sales_window"
SALES_WINDOW_SIZE = 5
SALES_WINDOW_FLAG_MIN = 3


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _flag_dict(row: PricingFlag) -> dict:
    return {
        "id": row.id,
        "edition_id": row.edition_id,
        "foil_id": row.foil_id,
        "marketplace": row.marketplace,
        "reason": row.reason,
        "new_sales": row.new_sales,
        "scrape_count": row.scrape_count,
        "gaps": list(row.gaps or []),
        "first_flagged_at": _iso(row.first_flagged_at),
        "last_flagged_at": _iso(row.last_flagged_at),
        "resolved_at": _iso(row.resolved_at),
        "resolved_by": row.resolved_by,
    }


# JSON-mode store: {"next_id": int, "flags": [flag dict, ...]} — the same dict
# shape _flag_dict() returns, so both modes hand callers identical records.
def _load_json() -> dict:
    with new_json(JSON_NEEDS_ACTION).open("r", encoding="utf-8") as f:
        data = json.load(f)
    data.setdefault("next_id", 1)
    data.setdefault("flags", [])
    return data


def _save_json(data: dict) -> None:
    with new_json(JSON_NEEDS_ACTION).open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4)


def flag_sales_window(edition_id: str, foil_id: str | None, new_sales: int,
                      previous_latest: str | None = None, earliest_new: str | None = None,
                      marketplace: str = "TCGPlayer", debug: bool = False) -> bool:
    """Flags (or adds onto the open flag for) one product page whose scrape just
    stored `new_sales` new sales, recording that scrape's gap — previous_latest
    (newest sale date on file before it) to earliest_new (earliest date it
    stored), both ISO dates. No-op below SALES_WINDOW_FLAG_MIN. Returns whether
    a flag was written."""
    if new_sales < SALES_WINDOW_FLAG_MIN:
        return False

    foil_id = foil_id or ""
    now = _now()
    gap = {
        "previous_latest": previous_latest,
        "earliest_new": earliest_new,
        "new_sales": new_sales,
        "flagged_at": now.isoformat(),
    }

    if is_db_mode():
        with get_session() as session:
            # Same "skip, don't fail" rule as the scrape clocks — no editions
            # row means nothing to hang the FK on.
            if session.get(Edition, edition_id) is None:
                return False

            row = session.execute(
                select(PricingFlag).where(
                    PricingFlag.edition_id == edition_id,
                    PricingFlag.foil_id == foil_id,
                    PricingFlag.marketplace == marketplace,
                    PricingFlag.reason == REASON_SALES_WINDOW,
                    PricingFlag.resolved_at.is_(None),
                )
            ).scalar_one_or_none()

            if row is None:
                session.add(PricingFlag(
                    edition_id=edition_id, foil_id=foil_id, marketplace=marketplace,
                    reason=REASON_SALES_WINDOW, new_sales=new_sales, scrape_count=1, gaps=[gap],
                    first_flagged_at=now, last_flagged_at=now,
                ))
            else:
                row.new_sales += new_sales
                row.scrape_count += 1
                row.last_flagged_at = now
                # Reassigned (not appended in place) so SQLAlchemy sees the JSONB change.
                row.gaps = [*(row.gaps or []), gap]
    else:
        data = _load_json()
        row = next((
            f for f in data["flags"]
            if f["edition_id"] == edition_id and f["foil_id"] == foil_id
            and f["marketplace"] == marketplace and f["reason"] == REASON_SALES_WINDOW
            and not f.get("resolved_at")
        ), None)

        if row is None:
            data["flags"].append({
                "id": data["next_id"],
                "edition_id": edition_id,
                "foil_id": foil_id,
                "marketplace": marketplace,
                "reason": REASON_SALES_WINDOW,
                "new_sales": new_sales,
                "scrape_count": 1,
                "gaps": [gap],
                "first_flagged_at": now.isoformat(),
                "last_flagged_at": now.isoformat(),
                "resolved_at": None,
                "resolved_by": None,
            })
            data["next_id"] += 1
        else:
            row["new_sales"] += new_sales
            row["scrape_count"] += 1
            row["last_flagged_at"] = now.isoformat()
            row.setdefault("gaps", []).append(gap)

        _save_json(data)

    if debug:
        print(f"Flagged Needs Action | {edition_id} | foil_id={foil_id or '-'} | {marketplace} | new_sales={new_sales}")

    return True


def list_flags(include_resolved: bool = False) -> list[dict]:
    """Open flags (plus resolved ones if asked), newest activity first."""
    if is_db_mode():
        query = select(PricingFlag)
        if not include_resolved:
            query = query.where(PricingFlag.resolved_at.is_(None))
        with get_session() as session:
            flags = [_flag_dict(row) for row in session.execute(query).scalars().all()]
    else:
        flags = [f for f in _load_json()["flags"] if include_resolved or not f.get("resolved_at")]

    # Open first (most recently flagged on top), then resolved (most recently resolved on top).
    open_flags = sorted((f for f in flags if not f["resolved_at"]), key=lambda f: f["last_flagged_at"], reverse=True)
    resolved = sorted((f for f in flags if f["resolved_at"]), key=lambda f: f["resolved_at"], reverse=True)
    return open_flags + resolved


def set_resolved(flag_id: int, resolved: bool, username: str | None = None) -> dict | None:
    """Resolves (or reopens) one flag. Returns the updated flag, or None if
    there's no such id. Reopening fails (returns None) when another open flag
    already exists for the same product page — there can only be one."""
    now = _now()

    if is_db_mode():
        with get_session() as session:
            row = session.get(PricingFlag, flag_id)
            if row is None:
                return None

            if not resolved and row.resolved_at is not None:
                clash = session.execute(
                    select(PricingFlag.id).where(
                        PricingFlag.edition_id == row.edition_id,
                        PricingFlag.foil_id == row.foil_id,
                        PricingFlag.marketplace == row.marketplace,
                        PricingFlag.reason == row.reason,
                        PricingFlag.resolved_at.is_(None),
                    )
                ).first()
                if clash is not None:
                    return None

            row.resolved_at = now if resolved else None
            row.resolved_by = username if resolved else None
            session.flush()
            return _flag_dict(row)

    data = _load_json()
    row = next((f for f in data["flags"] if f["id"] == flag_id), None)
    if row is None:
        return None

    if not resolved and row.get("resolved_at"):
        clash = any(
            f is not row and not f.get("resolved_at")
            and (f["edition_id"], f["foil_id"], f["marketplace"], f["reason"])
            == (row["edition_id"], row["foil_id"], row["marketplace"], row["reason"])
            for f in data["flags"]
        )
        if clash:
            return None

    row["resolved_at"] = now.isoformat() if resolved else None
    row["resolved_by"] = username if resolved else None
    _save_json(data)
    return dict(row)

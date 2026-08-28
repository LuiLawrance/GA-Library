from datetime import date
from db.models import Edition, WatchlistEntry
from db.session import get_session
from db_mode import is_db_mode
from sqlalchemy import delete as sa_delete, select
from util_file import new_json

import json

DIR_WATCHLIST = "DATA_GA/WATCHLIST_GA"


def _watchlist_path(username: str) -> str:
    return f"{DIR_WATCHLIST}/{username}.json"


def _load_watchlist(username: str) -> dict:
    watchlist_file = new_json(_watchlist_path(username))

    with watchlist_file.open("r", encoding="utf-8") as f:
        return json.load(f)


def _save_watchlist(username: str, data: dict) -> None:
    with open(_watchlist_path(username), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def watchlist_list(username: str) -> list[tuple[str, str, str, str]]:
    """Flat list of (card_id, edition_id, foil_id, added_date)."""
    if is_db_mode():
        with get_session() as session:
            rows = session.execute(
                select(Edition.card_id, WatchlistEntry.edition_id, WatchlistEntry.foil_id, WatchlistEntry.added_date)
                .join(Edition, Edition.edition_id == WatchlistEntry.edition_id)
                .where(WatchlistEntry.username == username)
            ).all()

            return [
                (row.card_id, row.edition_id, row.foil_id, row.added_date.isoformat() if row.added_date else None)
                for row in rows
            ]

    data = _load_watchlist(username)
    rows = []

    for card_id, editions in data.items():
        for edition_id, foils in editions.items():
            for foil_id, meta in foils.items():
                rows.append((card_id, edition_id, foil_id, meta.get("added")))

    return rows


def watchlist_add(username: str, card_id: str, edition_id: str, foil_id: str, debug: bool = False) -> bool:
    """Returns False if this printing is already watched (no-op), True if newly added."""
    if is_db_mode():
        with get_session() as session:
            existing = session.execute(
                select(WatchlistEntry).where(
                    WatchlistEntry.username == username,
                    WatchlistEntry.edition_id == edition_id,
                    WatchlistEntry.foil_id == foil_id,
                )
            ).scalar_one_or_none()

            if existing:
                return False

            session.add(WatchlistEntry(
                username=username, edition_id=edition_id, foil_id=foil_id, added_date=date.today(),
            ))

        if debug:
            print(
                f"Added to watchlist (DB) | "
                f"user={username} | card_id={card_id} | edition_id={edition_id} | foil_id={foil_id}"
            )

        return True

    data = _load_watchlist(username)
    existing = data.get(card_id, {}).get(edition_id, {}).get(foil_id)

    if existing:
        return False

    data.setdefault(card_id, {}).setdefault(edition_id, {})[foil_id] = {"added": date.today().isoformat()}
    _save_watchlist(username, data)

    if debug:
        print(
            f"Added to watchlist | "
            f"user={username} | "
            f"card_id={card_id} | "
            f"edition_id={edition_id} | "
            f"foil_id={foil_id}"
        )

    return True


def watchlist_remove(username: str, card_id: str, edition_id: str, foil_id: str, debug: bool = False) -> bool:
    """Returns False if the printing wasn't being watched (no-op), True if removed."""
    if is_db_mode():
        with get_session() as session:
            result = session.execute(
                sa_delete(WatchlistEntry).where(
                    WatchlistEntry.username == username,
                    WatchlistEntry.edition_id == edition_id,
                    WatchlistEntry.foil_id == foil_id,
                )
            )
            removed = result.rowcount > 0

        if debug and removed:
            print(
                f"Removed from watchlist (DB) | "
                f"user={username} | card_id={card_id} | edition_id={edition_id} | foil_id={foil_id}"
            )

        return removed

    data = _load_watchlist(username)
    foils = data.get(card_id, {}).get(edition_id, {})

    if foil_id not in foils:
        return False

    del foils[foil_id]

    if not foils:
        del data[card_id][edition_id]
    if card_id in data and not data[card_id]:
        del data[card_id]

    _save_watchlist(username, data)

    if debug:
        print(
            f"Removed from watchlist | "
            f"user={username} | "
            f"card_id={card_id} | "
            f"edition_id={edition_id} | "
            f"foil_id={foil_id}"
        )

    return True

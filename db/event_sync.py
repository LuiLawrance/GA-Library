"""Normalized event record -> Postgres rows, for the Omnidex events tables.

Same role db/catalog_sync.py plays for cards. Two callers must not drift:

  * events_ga.py::_persist_event — the live write after an event is fetched
    from the API (add / refresh) when is_db_mode() is true.
  * scripts/migrate_json_to_pg.py::migrate_events — the bulk import of the
    DATA_GA/EVENTS_GA/* files (admin "Sync to Database").

The shared contract is the record events_ga._build_event_record() returns:

    {"event": {...}, "players": {player_id: {...}}, "entrants": [...],
     "standings": [...], "matches": [...], "decklists": [...]}

The JSON files store exactly the same pieces (event -> EVENTS.json,
players -> PLAYERS.json, the four lists -> EVENT_DATA/{event_id}.json), so
the migration rebuilds the record from disk and hands it to persist_event()
unchanged.

Every function here takes an already-open Session and leaves the
transaction to the caller, so one event's whole write is atomic.
"""

from datetime import datetime
from db.catalog_sync import upsert
from db.models import Event, EventDecklist, EventEntrant, EventMatch, EventStanding, OmnidexPlayer
from sqlalchemy import delete
from sqlalchemy.orm import Session

PLAYER_CORE_COLS = ["username", "country", "cp", "emblem", "rank", "updated_at"]
PLAYER_JUDGE_COLS = ["judge_level", "judge_experience"]

_CHILD_MODELS = (EventDecklist, EventMatch, EventStanding, EventEntrant)


def _ts(value):
    """ISO string (the record's own format, also what JSON mode stores) ->
    aware datetime for a timestamptz column."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def build_event_row(event: dict) -> dict:
    row = {c.name: event.get(c.name) for c in Event.__table__.columns}
    for col in ("start_at", "started_at", "completed_at", "last_synced"):
        row[col] = _ts(row[col])
    row["stages"] = row["stages"] or []
    row["statistics"] = row["statistics"] or {}
    row["player_count"] = row["player_count"] or 0
    row["team_count"] = row["team_count"] or 0
    return row


def build_player_rows(players: dict) -> tuple[list[dict], list[dict]]:
    """(judge_rows, other_rows). Split so a judge's judge_level /
    judge_experience only ever get overwritten by a payload that actually
    carries them — a later event where the same person merely played must
    not null those fields out."""
    judges, others = [], []
    for player_id, info in players.items():
        row = {
            "player_id": int(player_id),
            "username": info.get("username"),
            "country": info.get("country"),
            "cp": info.get("cp"),
            "emblem": info.get("emblem"),
            "rank": info.get("rank"),
            "judge_level": info.get("judge_level"),
            "judge_experience": info.get("judge_experience"),
            "updated_at": _ts(info.get("updated_at")),
        }
        (judges if row["judge_level"] is not None else others).append(row)
    return judges, others


def persist_event(session: Session, record: dict) -> None:
    """Writes one event's full footprint: upserts its players into the shared
    directory and the event row, then replaces every child row. Children are
    delete-then-insert rather than upserted — a refresh can legitimately make
    rows disappear (a dropped entrant, re-paired round), and nothing else
    references them."""
    event_row = build_event_row(record["event"])
    event_id = event_row["event_id"]

    judge_rows, other_rows = build_player_rows(record.get("players", {}))
    upsert(session, OmnidexPlayer, judge_rows, ["player_id"], PLAYER_CORE_COLS + PLAYER_JUDGE_COLS)
    upsert(session, OmnidexPlayer, other_rows, ["player_id"], PLAYER_CORE_COLS)

    upsert(session, Event, [event_row], ["event_id"])

    for model in _CHILD_MODELS:
        session.execute(delete(model).where(model.event_id == event_id))

    entrants = [{"event_id": event_id, **e} for e in record.get("entrants", [])]
    standings = [{"event_id": event_id, **s} for s in record.get("standings", [])]
    matches = [
        {"event_id": event_id, **m, "completed_at": _ts(m.get("completed_at"))}
        for m in record.get("matches", [])
    ]
    decklists = [{"event_id": event_id, **d} for d in record.get("decklists", [])]

    # Plain inserts (empty update_cols -> ON CONFLICT DO NOTHING): the rows
    # were just cleared, so a conflict can only mean the API itself repeated a
    # key within one payload — keep the first rather than fail the sync.
    upsert(session, EventEntrant, entrants, ["event_id", "player_id", "role"], [])
    upsert(session, EventStanding, standings, ["event_id", "position"], [])
    upsert(session, EventMatch, matches, ["event_id", "stage_id", "round_id", "match_id"], [])
    upsert(session, EventDecklist, decklists, ["event_id", "player_id"], [])


def delete_event(session: Session, event_id: int) -> bool:
    """Removes one event and (via ON DELETE CASCADE) its child rows. The
    shared omnidex_players directory is left alone. Returns whether a row
    existed."""
    result = session.execute(delete(Event).where(Event.event_id == event_id))
    return result.rowcount > 0

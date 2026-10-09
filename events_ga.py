"""Omnidex organized-play events — fetched from the Grand Archive API and
stored locally the same way the card catalog is.

API (https://api-docs.gatcg.com/endpoints/omnidex): everything hangs off one
event id — /omnidex/events/{id} plus /players, /judges, /teams, /standings,
/pairings (one stage+round per call), /decklists and /statistics. There is
NO endpoint that lists or searches events, so an event only enters local
storage when someone adds it by id (or pastes its omni.gatcg.com URL).

Storage mirrors api_ga.py's cards:

  * fetch_event() pulls every endpoint and _build_event_record() normalizes
    the raw payloads into one record (the shared contract, like INFO.json's
    entry shape is for cards — see db/event_sync.py's docstring).
  * _persist_event() writes that record: DB mode -> Postgres in a single
    transaction via db/event_sync.py; JSON mode -> the DATA_GA/EVENTS_GA
    files below. The per-event detail lives in its own file because a large
    event's decklists alone run to ~0.5 MB — keeping them out of EVENTS.json
    keeps the list page's read small.

      EVENTS.json               {event_id: event metadata}
      PLAYERS.json              {player_id: latest Omnidex player snapshot}
      EVENT_DATA/{event_id}.json {entrants, standings, matches, decklists}

  * load_event_list() / load_event_detail() hand callers the same shapes in
    both modes.

Refresh policy (the counterpart of api_ga.UPDATE_THRESHOLD): an event whose
status is final and was synced after it finished never needs re-fetching;
anything still running is re-fetched on view once its copy is older than
LIVE_REFRESH_MINUTES. Admins can force a refresh at any time.
"""

from datetime import datetime, timedelta, timezone
from db import event_sync
from db.models import Event, EventDecklist, EventEntrant, EventMatch, EventStanding, OmnidexPlayer
from db.session import get_session
from db_mode import is_db_mode
from pathlib import Path
from sqlalchemy import select
from util_file import new_dir, new_json

import json
import os
import re
import requests
import threading

API_EVENTS = "https://api.gatcg.com/omnidex/events/"
OMNI_EVENT_URL = "https://omni.gatcg.com/events/"

DIR_EVENT_DATA = "DATA_GA/EVENTS_GA/EVENT_DATA"
JSON_EVENTS = "DATA_GA/EVENTS_GA/EVENTS.json"
JSON_PLAYERS = "DATA_GA/EVENTS_GA/PLAYERS.json"

LIVE_REFRESH_MINUTES = 5
REQUEST_TIMEOUT = 20

FINAL_STATUSES = {"complete", "canceled", "canceled-reset", "canceled-suspended"}
TEAM_FORMATS_PREFIX = "team-"

# One fetch per event at a time within a process — two people opening the
# same live event at once shouldn't both fire the ~20 API calls a refresh
# takes. (Separate uvicorn workers can still overlap; the write is atomic
# either way, so the worst case is one redundant fetch.)
_fetch_locks: dict[int, threading.Lock] = {}
_fetch_locks_guard = threading.Lock()


class EventNotFound(Exception):
    pass


class EventFetchError(Exception):
    pass


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _ms_to_iso(value) -> str | None:
    if not isinstance(value, (int, float)):
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()


def _int_or_none(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_event_id(value) -> int | None:
    """Accepts a bare id ("27292") or an Omnidex event URL
    ("https://omni.gatcg.com/events/27292", with or without trailing bits)."""
    text = str(value or "").strip()
    match = re.search(r"events/(\d+)", text) or re.fullmatch(r"#?(\d{1,10})", text)
    return int(match.group(1)) if match else None


def _lock_for(event_id: int) -> threading.Lock:
    with _fetch_locks_guard:
        return _fetch_locks.setdefault(event_id, threading.Lock())


# ── API fetch ─────────────────────────────────────────────────────────────────

def _api_get(http: requests.Session, path: str, params: dict | None = None, debug: bool = False):
    """GET one Omnidex endpoint. Returns the JSON body, or None for a 400/404
    (the API answers those for "not applicable to this event" — e.g. /teams
    on a 1v1 event, /standings before Swiss starts). Raises EventFetchError
    for anything else."""
    url = f"{API_EVENTS}{path}"
    try:
        response = http.get(url, params=params, timeout=REQUEST_TIMEOUT)
    except requests.exceptions.RequestException as e:
        raise EventFetchError(f"API request failed ({e})") from e

    if debug:
        print(f"GET {url} {params or ''} -> {response.status_code}")

    if response.status_code in (400, 404):
        return None
    if not response.ok:
        raise EventFetchError(f"API returned {response.status_code} for {path}")

    try:
        return response.json()
    except ValueError as e:
        raise EventFetchError(f"API returned non-JSON for {path}") from e


def _fetch_pairings(http: requests.Session, event_id: int, stages: list, debug: bool = False) -> list[dict]:
    """Every round of every started stage. /pairings serves one stage+round
    per call; round 1's response carries round.total, which says how many
    more to ask for."""
    rounds = []
    for stage in stages:
        stage_id = stage.get("id")
        if stage_id is None or stage.get("status") == "waiting":
            continue

        first = _api_get(http, f"{event_id}/pairings", {"stage": stage_id, "round": 1}, debug)
        if not first:
            continue
        rounds.append(first)

        total = _int_or_none((first.get("round") or {}).get("total")) or 1
        for round_id in range(2, total + 1):
            payload = _api_get(http, f"{event_id}/pairings", {"stage": stage_id, "round": round_id}, debug)
            if payload:
                rounds.append(payload)
    return rounds


def fetch_event(event_id: int, debug: bool = False) -> dict:
    """Pulls every endpoint for one event and returns the raw payloads
    ({"event", "players", "judges", "teams", "standings", "pairings",
    "decklists", "statistics"}). Raises EventNotFound / EventFetchError."""
    with requests.Session() as http:
        event = _api_get(http, str(event_id), debug=debug)
        if not event or "id" not in event:
            raise EventNotFound(f"Event {event_id} not found")

        stages = event.get("stages") or []
        is_team = str(event.get("format") or "").startswith(TEAM_FORMATS_PREFIX)
        swiss_started = any(s.get("type") == "swiss" and s.get("status") != "waiting" for s in stages)

        return {
            "event": event,
            "players": _api_get(http, f"{event_id}/players", debug=debug) or [],
            "judges": _api_get(http, f"{event_id}/judges", debug=debug) or [],
            "teams": (_api_get(http, f"{event_id}/teams", debug=debug) or []) if is_team else [],
            "standings": (_api_get(http, f"{event_id}/standings", debug=debug) or {}) if swiss_started else {},
            "pairings": _fetch_pairings(http, event_id, stages, debug),
            "decklists": (_api_get(http, f"{event_id}/decklists", debug=debug) or []) if event.get("decklists") else [],
            "statistics": _api_get(http, f"{event_id}/statistics", debug=debug) or {},
        }


# ── Normalize ─────────────────────────────────────────────────────────────────

def _build_event_meta(raw: dict, team_count: int) -> dict:
    """Snake-cased event metadata. The live API's field names drift from its
    own spec (it sends both date/startAt, dateStarted/startedAt), so each
    value falls back across both spellings."""
    event = raw["event"]
    host = event.get("host") or {}
    season = event.get("season") or {}
    return {
        "event_id": int(event["id"]),
        "name": event.get("name") or f"Event {event['id']}",
        "category": event.get("category"),
        "format": event.get("format"),
        "status": event.get("status"),
        "setting": event.get("setting"),
        "structure": event.get("structure"),
        "type": event.get("type"),
        "ranked": event.get("ranked"),
        "description": event.get("description") or "",
        "url": event.get("url") or f"{OMNI_EVENT_URL}{event['id']}",
        "start_at": event.get("startAt") or event.get("date"),
        "started_at": event.get("startedAt") or event.get("dateStarted"),
        "completed_at": event.get("dateCompleted"),
        "vp_multiplier": event.get("vpMultiplier"),
        "swiss_rounds": event.get("swissRounds"),
        "swiss_match_config": event.get("swissMatchConfig"),
        "se_cut_size": event.get("singleEliminationCutSize"),
        "se_match_config": event.get("singleEliminationMatchConfig"),
        "team_size": event.get("teamSize"),
        "has_decklists": event.get("decklists"),
        "host_id": host.get("id"),
        "host_name": host.get("name"),
        "host_address": host.get("address"),
        "host_country": host.get("addressCountryCode"),
        "season_id": season.get("id"),
        "season_name": season.get("name"),
        "player_count": len(event.get("players") or raw["players"]),
        "team_count": team_count,
        "stages": [
            {"id": s.get("id"), "status": s.get("status"), "type": s.get("type")}
            for s in event.get("stages") or []
        ],
        "statistics": raw.get("statistics") or {},
        "last_synced": _now_iso(),
    }


def _build_event_record(raw: dict) -> dict:
    """Raw API payloads -> the normalized record both storage paths consume
    (see db/event_sync.py)."""
    synced = _now_iso()

    players: dict[str, dict] = {}
    entrants: list[dict] = []

    team_of: dict[int, tuple[str, int | None]] = {}
    for team in raw.get("teams") or []:
        for member in team.get("players") or []:
            pid = _int_or_none(member.get("id"))
            if pid is not None:
                team_of[pid] = (team.get("name"), _int_or_none(member.get("slot")))

    for role, source in (("player", raw.get("players") or []), ("judge", raw.get("judges") or [])):
        for p in source:
            pid = _int_or_none(p.get("id"))
            if pid is None:
                continue

            entry = players.setdefault(str(pid), {})
            entry.update({
                "username": p.get("username"),
                "country": p.get("country"),
                "cp": _int_or_none(p.get("cp")),
                "emblem": p.get("emblem"),
                "rank": _int_or_none(p.get("rank")),
                "updated_at": synced,
            })
            if role == "judge":
                entry["judge_level"] = _int_or_none(p.get("judgeLevel"))
                entry["judge_experience"] = _int_or_none(p.get("judgeExperience"))

            team_name, team_slot = team_of.get(pid, (None, None)) if role == "player" else (None, None)
            entrants.append({
                "player_id": pid,
                "role": role,
                "final_placement": _int_or_none(p.get("finalPlacement")),
                "team_name": team_name,
                "team_slot": team_slot,
            })

    standings = []
    for position, s in enumerate((raw.get("standings") or {}).get("standings") or [], start=1):
        stats = {k: v for k, v in s.items() if k.startswith("stats") or k == "tiebreaker"}
        standings.append({
            "position": position,
            "player_id": _int_or_none(s.get("id")) if "name" not in s else None,
            "team_name": s.get("name"),
            "final_placement": _int_or_none(s.get("finalPlacement")),
            "status": s.get("status"),
            "stats": stats,
        })

    matches = []
    for payload in raw.get("pairings") or []:
        stage = payload.get("stage") or {}
        round_info = payload.get("round") or {}
        for m in payload.get("pairings") or []:
            matches.append({
                "stage_id": _int_or_none(stage.get("id")) or 0,
                "round_id": _int_or_none(round_info.get("id")) or 0,
                "match_id": _int_or_none(m.get("id")) or 0,
                "stage_type": stage.get("type"),
                "label": m.get("label"),
                "status": m.get("status"),
                "completed_at": _ms_to_iso(m.get("completedAt")),
                "pairing": m.get("pairing") or [],
            })

    decklists = []
    for d in raw.get("decklists") or []:
        pid = _int_or_none(d.get("player"))
        if pid is None:
            continue
        deck = d.get("decklist") or {}
        decklists.append({
            "player_id": pid,
            "visible": bool(d.get("visible", True)),
            "main": deck.get("main") or [],
            "material": deck.get("material") or [],
            "sideboard": deck.get("sideboard") or [],
        })

    return {
        "event": _build_event_meta(raw, len(raw.get("teams") or [])),
        "players": players,
        "entrants": entrants,
        "standings": standings,
        "matches": matches,
        "decklists": decklists,
    }


# ── Persist ───────────────────────────────────────────────────────────────────

def _json_load(path: str) -> dict:
    with new_json(path).open("r", encoding="utf-8") as f:
        return json.load(f)


def _json_save(path: str, data: dict) -> None:
    file_path = new_json(path)
    tmp_path = file_path.with_suffix(f".tmp.{os.getpid()}")
    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)
    os.replace(tmp_path, file_path)


def _event_data_path(event_id: int) -> str:
    return f"{DIR_EVENT_DATA}/{event_id}.json"


def _persist_event(record: dict, debug: bool = False) -> None:
    event_id = record["event"]["event_id"]

    if is_db_mode():
        with get_session() as session:
            event_sync.persist_event(session, record)
        if debug:
            print(f"Persisted event to Postgres | event_id={event_id}")
        return

    players_data = _json_load(JSON_PLAYERS)
    for player_id, info in record["players"].items():
        existing = players_data.get(player_id, {})
        # Same rule as event_sync.build_player_rows: a non-judge appearance
        # never wipes judge fields recorded from an earlier event.
        players_data[player_id] = {**existing, **info}
    _json_save(JSON_PLAYERS, players_data)

    new_dir(DIR_EVENT_DATA)
    _json_save(_event_data_path(event_id), {
        "entrants": record["entrants"],
        "standings": record["standings"],
        "matches": record["matches"],
        "decklists": record["decklists"],
    })

    # Index last, so a crash mid-write never lists an event with no detail file.
    events_data = _json_load(JSON_EVENTS)
    events_data[str(event_id)] = record["event"]
    _json_save(JSON_EVENTS, events_data)

    if debug:
        print(f"Persisted event to JSON | event_id={event_id}")


def sync_event(event_id: int, debug: bool = False) -> dict:
    """Fetch + normalize + store one event. Returns its stored metadata."""
    with _lock_for(event_id):
        record = _build_event_record(fetch_event(event_id, debug))
        _persist_event(record, debug)
        return record["event"]


def delete_event(event_id: int) -> bool:
    if is_db_mode():
        with get_session() as session:
            return event_sync.delete_event(session, event_id)

    events_data = _json_load(JSON_EVENTS)
    existed = events_data.pop(str(event_id), None) is not None
    if existed:
        _json_save(JSON_EVENTS, events_data)
    Path(_event_data_path(event_id)).unlink(missing_ok=True)
    return existed


# ── Staleness ─────────────────────────────────────────────────────────────────

def needs_refresh(meta: dict) -> bool:
    """Whether a stored event's copy is out of date (see module docstring)."""
    synced = _parse_ts(meta.get("last_synced"))
    if synced is None:
        return True

    if meta.get("status") in FINAL_STATUSES:
        completed = _parse_ts(meta.get("completed_at"))
        # Synced after it finished (or it never reported a finish time) —
        # nothing left to change.
        return completed is not None and synced < completed

    return datetime.now(timezone.utc) - synced > timedelta(minutes=LIVE_REFRESH_MINUTES)


# ── Read ──────────────────────────────────────────────────────────────────────

def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _db_event_meta(row: Event) -> dict:
    meta = {}
    for col in Event.__table__.columns:
        value = getattr(row, col.name)
        if isinstance(value, datetime):
            value = value.isoformat()
        elif col.name == "vp_multiplier" and value is not None:
            value = float(value)
        meta[col.name] = value
    return meta


_LIST_FIELDS = (
    "event_id", "name", "category", "format", "status", "setting", "ranked", "start_at", "completed_at",
    "host_name", "host_country", "season_name", "player_count", "team_count", "has_decklists", "last_synced",
)


def load_event_list() -> list[dict]:
    """Every stored event's summary, newest start date first."""
    if is_db_mode():
        with get_session() as session:
            rows = session.execute(select(Event)).scalars().all()
            events = [_db_event_meta(r) for r in rows]
    else:
        events = list(_json_load(JSON_EVENTS).values())

    summaries = [{k: e.get(k) for k in _LIST_FIELDS} for e in events]
    summaries.sort(key=lambda e: e.get("start_at") or "", reverse=True)
    return summaries


def load_event_meta(event_id: int) -> dict | None:
    if is_db_mode():
        with get_session() as session:
            row = session.get(Event, event_id)
            return _db_event_meta(row) if row else None
    return _json_load(JSON_EVENTS).get(str(event_id))


def _load_event_parts(event_id: int) -> tuple[dict, dict] | None:
    """(meta, {"players", "entrants", "standings", "matches", "decklists"})
    for one event, in the record's own shapes — `players` scoped to the
    people who appear in it."""
    if is_db_mode():
        with get_session() as session:
            row = session.get(Event, event_id)
            if row is None:
                return None

            entrants = [
                {"player_id": e.player_id, "role": e.role, "final_placement": e.final_placement,
                 "team_name": e.team_name, "team_slot": e.team_slot}
                for e in session.execute(
                    select(EventEntrant).where(EventEntrant.event_id == event_id)
                ).scalars()
            ]
            player_ids = {e["player_id"] for e in entrants}
            players = {
                str(p.player_id): {
                    "username": p.username, "country": p.country, "cp": p.cp, "emblem": p.emblem,
                    "rank": p.rank, "judge_level": p.judge_level, "judge_experience": p.judge_experience,
                }
                for p in session.execute(
                    select(OmnidexPlayer).where(OmnidexPlayer.player_id.in_(player_ids))
                ).scalars()
            } if player_ids else {}
            standings = [
                {"position": s.position, "player_id": s.player_id, "team_name": s.team_name,
                 "final_placement": s.final_placement, "status": s.status, "stats": s.stats}
                for s in session.execute(
                    select(EventStanding).where(EventStanding.event_id == event_id)
                    .order_by(EventStanding.position)
                ).scalars()
            ]
            matches = [
                {"stage_id": m.stage_id, "round_id": m.round_id, "match_id": m.match_id,
                 "stage_type": m.stage_type, "label": m.label, "status": m.status,
                 "completed_at": _iso(m.completed_at), "pairing": m.pairing}
                for m in session.execute(
                    select(EventMatch).where(EventMatch.event_id == event_id)
                ).scalars()
            ]
            decklists = [
                {"player_id": d.player_id, "visible": d.visible, "main": d.main,
                 "material": d.material, "sideboard": d.sideboard}
                for d in session.execute(
                    select(EventDecklist).where(EventDecklist.event_id == event_id)
                ).scalars()
            ]
            return _db_event_meta(row), {
                "players": players, "entrants": entrants, "standings": standings,
                "matches": matches, "decklists": decklists,
            }

    meta = _json_load(JSON_EVENTS).get(str(event_id))
    if meta is None:
        return None

    detail_path = Path(_event_data_path(event_id))
    detail = json.loads(detail_path.read_text(encoding="utf-8")) if detail_path.exists() else {}
    entrants = detail.get("entrants", [])
    all_players = _json_load(JSON_PLAYERS)
    players = {
        str(e["player_id"]): all_players[str(e["player_id"])]
        for e in entrants if str(e["player_id"]) in all_players
    }
    return meta, {
        "players": players,
        "entrants": entrants,
        "standings": detail.get("standings", []),
        "matches": detail.get("matches", []),
        "decklists": detail.get("decklists", []),
    }


def load_event_detail(event_id: int) -> dict | None:
    """Display-ready view of one stored event (same shape in both modes):

        {event, players: [...], judges: [...], teams: [...], standings: [...],
         rounds: [{stage_id, stage_type, round_id, matches: [...]}], decklists}

    players/judges are the entrant rows joined to the player directory;
    teams are derived from the players' team_name/team_slot."""
    parts = _load_event_parts(event_id)
    if parts is None:
        return None
    meta, data = parts

    directory = data["players"]

    def person(entrant: dict) -> dict:
        info = directory.get(str(entrant["player_id"]), {})
        return {
            "player_id": entrant["player_id"],
            "username": info.get("username"),
            "country": info.get("country"),
            "cp": info.get("cp"),
            "emblem": info.get("emblem"),
            "rank": info.get("rank"),
            "judge_level": info.get("judge_level"),
            "final_placement": entrant.get("final_placement"),
            "team_name": entrant.get("team_name"),
            "team_slot": entrant.get("team_slot"),
        }

    def placement_key(p: dict):
        return (p["final_placement"] is None, p["final_placement"] or 0, (p["username"] or "").lower())

    players = sorted((person(e) for e in data["entrants"] if e["role"] == "player"), key=placement_key)
    judges = sorted(
        (person(e) for e in data["entrants"] if e["role"] == "judge"),
        key=lambda p: (-(p["judge_level"] or 0), (p["username"] or "").lower()),
    )

    teams_by_name: dict[str, dict] = {}
    for p in players:
        if not p["team_name"]:
            continue
        team = teams_by_name.setdefault(p["team_name"], {"name": p["team_name"], "final_placement": None, "players": []})
        team["players"].append(p["player_id"])
        if p["final_placement"] is not None:
            current = team["final_placement"]
            team["final_placement"] = p["final_placement"] if current is None else min(current, p["final_placement"])
    teams = sorted(teams_by_name.values(), key=lambda t: (t["final_placement"] is None, t["final_placement"] or 0, t["name"].lower()))
    slot_of = {p["player_id"]: p["team_slot"] or 0 for p in players}
    for team in teams:
        team["players"].sort(key=lambda pid: slot_of.get(pid, 0))

    rounds: dict[tuple[int, int], dict] = {}
    for m in data["matches"]:
        key = (m["stage_id"], m["round_id"])
        rounds.setdefault(key, {
            "stage_id": m["stage_id"], "stage_type": m["stage_type"], "round_id": m["round_id"], "matches": [],
        })["matches"].append(m)
    for r in rounds.values():
        r["matches"].sort(key=lambda m: m["match_id"])

    return {
        "event": meta,
        "players": players,
        "judges": judges,
        "teams": teams,
        "standings": sorted(data["standings"], key=lambda s: s["position"]),
        "rounds": [rounds[k] for k in sorted(rounds)],
        "decklists": data["decklists"],
    }


def _record_for(standings: list[dict], player_id: int, team_name: str | None) -> dict | None:
    """{wins, losses, ties} from this player's (or their team's) Swiss row."""
    for s in standings:
        if (team_name and s.get("team_name") == team_name) or (not team_name and s.get("player_id") == player_id):
            stats = s.get("stats") or {}
            return {
                "wins": stats.get("statsWins", 0),
                "losses": stats.get("statsLosses", 0),
                "ties": stats.get("statsTies", 0),
            }
    return None


def load_player_events(player_id: int) -> list[dict]:
    """Every stored event an Omnidex ID played or judged in, newest first —
    feeds the Events menu on a user's profile (users.omnidex_id is the same
    number as the API's player id). One row per (event, role):

        {event_id, name, start_at, category, format, status, player_count,
         role, final_placement, team_name, record: {wins, losses, ties} | None}
    """
    rows = []

    if is_db_mode():
        with get_session() as session:
            hits = session.execute(
                select(EventEntrant, Event)
                .join(Event, Event.event_id == EventEntrant.event_id)
                .where(EventEntrant.player_id == player_id)
            ).all()
            for entrant, event in hits:
                standings = []
                if entrant.role == "player":
                    query = select(EventStanding).where(EventStanding.event_id == event.event_id)
                    query = query.where(
                        EventStanding.team_name == entrant.team_name if entrant.team_name
                        else EventStanding.player_id == player_id
                    )
                    standings = [
                        {"player_id": s.player_id, "team_name": s.team_name, "stats": s.stats}
                        for s in session.execute(query).scalars()
                    ]
                rows.append((_db_event_meta(event), {
                    "role": entrant.role, "final_placement": entrant.final_placement,
                    "team_name": entrant.team_name,
                }, standings))
    else:
        for event_id, meta in _json_load(JSON_EVENTS).items():
            detail_path = Path(_event_data_path(int(event_id)))
            if not detail_path.exists():
                continue
            detail = json.loads(detail_path.read_text(encoding="utf-8"))
            for entrant in detail.get("entrants", []):
                if entrant.get("player_id") == player_id:
                    rows.append((meta, entrant, detail.get("standings", [])))

    events = []
    for meta, entrant, standings in rows:
        is_player = entrant["role"] == "player"
        events.append({
            "event_id": meta["event_id"],
            "name": meta.get("name"),
            "start_at": meta.get("start_at"),
            "category": meta.get("category"),
            "format": meta.get("format"),
            "status": meta.get("status"),
            "player_count": meta.get("player_count"),
            "role": entrant["role"],
            "final_placement": entrant.get("final_placement") if is_player else None,
            "team_name": entrant.get("team_name"),
            "record": _record_for(standings, player_id, entrant.get("team_name")) if is_player else None,
        })

    events.sort(key=lambda e: e.get("start_at") or "", reverse=True)
    return events

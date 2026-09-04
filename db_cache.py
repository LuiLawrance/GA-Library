"""Process-wide read-through cache for DB-mode whole-table loaders.

In DB mode the card catalog tables change on the admin "Sync to Database"
job (see _run_sync_job in app.py) AND on a live API card fetch — _persist_card
in api_ga.py (and sync_featured_sets) write Postgres directly and call
bust() themselves right after. The pricing tables (price_sales /
price_listings) and the tcg_* / foil_tcg_overrides fields likewise move on
the live add / import / scrape / paste / delete writers in pricing_ga.py /
api_tcgplayer.py, each of which busts afterward. So the loaders that pull an
entire table (load_info_data, load_slugs_data, load_sales_data, ...) can be
memoized for the life of the process: every writer that touches these tables
busts afterward, and the TTL is only a backstop in case a bust() call is
ever missed.

Only the DB-mode branch of each loader goes through here. JSON mode keeps
reading files directly — that path is already fast, and caching it would
break the read-after-write that api_cards_search relies on right after a
live API search syncs a new card into the JSON files.

Cached values are shared, read-only state. Every current caller only reads
them; the one request path that used to mutate load_info_data()'s result
(api_card_detail) now uses the scoped load_card_detail_data() instead.

Cross-process note (uvicorn `--workers N`): each worker is a separate OS
process with its own copy of `_store`, so an in-memory-only bust() would
only clear the cache of whichever worker happened to handle that request —
the other N-1 workers would keep serving pre-write data for up to the full
TTL, every time, instead of that being a rare missed-bust edge case. Workers
of one service DO share this container's filesystem (see the Dockerfile's
DATA_GA volume-mount comment), so bust() also stamps a small generation
marker file there; peek()/put() check it first and drop this process's
`_store` if another worker's bust() moved it since we last looked. One
extra local stat+read per cache access — negligible next to the network
round trip to Postgres this cache exists to avoid. (This only covers worker
processes of a single service instance sharing one filesystem/volume, not
multiple horizontally-scaled service instances — that would need a shared
store like Redis instead of a local file.)
"""

import os
import threading
import time

# 10 minutes — long enough that back-to-back requests (a page load, then
# every drawer open / search after it) all hit the cache, short enough that a
# missed bust() self-heals well before anyone files a bug.
_TTL_SECONDS = 600

_GENERATION_FILE = "DATA_GENERAL/.cache_generation"

_lock = threading.Lock()
_store: dict[str, tuple[float, object]] = {}
# The generation marker this process's _store is known to reflect. None
# means "never checked yet" — distinct from "" (file didn't exist yet, e.g.
# no bust() has ever happened), so the very first access always syncs once.
_seen_generation: str | None = None


def _read_generation() -> str:
    try:
        with open(_GENERATION_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _sync_generation() -> None:
    """Drops this process's cache if another worker's bust() landed since we
    last checked. Must be called with _lock held."""
    global _seen_generation
    current = _read_generation()
    if current != _seen_generation:
        _store.clear()
        _seen_generation = current


def peek(key: str):
    """Cached value for `key`, or None if absent/expired (None is never a
    real cached value here — every loader returns a dict or list)."""
    with _lock:
        _sync_generation()
        hit = _store.get(key)
        if hit is None:
            return None
        expiry, value = hit
        if time.monotonic() >= expiry:
            del _store[key]
            return None
        return value


def put(key: str, value) -> None:
    with _lock:
        _sync_generation()
        _store[key] = (time.monotonic() + _TTL_SECONDS, value)


def bust() -> None:
    """Drop every cached table — in this process directly, and in every
    other worker process sharing this container via the generation file."""
    global _seen_generation
    with _lock:
        _store.clear()
        _seen_generation = str(time.time_ns())

        os.makedirs(os.path.dirname(_GENERATION_FILE), exist_ok=True)
        tmp_path = f"{_GENERATION_FILE}.tmp.{os.getpid()}"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(_seen_generation)
        os.replace(tmp_path, _GENERATION_FILE)  # atomic on POSIX — no partial reads

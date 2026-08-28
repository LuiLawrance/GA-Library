"""Process-wide read-through cache for DB-mode whole-table loaders.

In DB mode the card catalog tables change on the admin "Sync to Database"
job (see _run_sync_job in app.py) AND on a live API card fetch — _persist_card
in api_ga.py (and sync_featured_sets) write Postgres directly and call
bust() themselves right after. Pricing tables still only move on the sync
job (see the Stage 6 notes in api_tcgplayer.py / pricing_ga.py). So the
loaders that pull an entire table (load_info_data, load_slugs_data,
load_sales_data, ...) can be memoized for the life of the process: every
writer that touches these tables busts afterward, and the TTL is only a
backstop in case a bust() call is ever missed.

Only the DB-mode branch of each loader goes through here. JSON mode keeps
reading files directly — that path is already fast, and caching it would
break the read-after-write that api_cards_search relies on right after a
live API search syncs a new card into the JSON files.

Cached values are shared, read-only state. Every current caller only reads
them; the one request path that used to mutate load_info_data()'s result
(api_card_detail) now uses the scoped load_card_detail_data() instead.
"""

import threading
import time

# 10 minutes — long enough that back-to-back requests (a page load, then
# every drawer open / search after it) all hit the cache, short enough that a
# missed bust() self-heals well before anyone files a bug.
_TTL_SECONDS = 600

_lock = threading.Lock()
_store: dict[str, tuple[float, object]] = {}


def peek(key: str):
    """Cached value for `key`, or None if absent/expired (None is never a
    real cached value here — every loader returns a dict or list)."""
    with _lock:
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
        _store[key] = (time.monotonic() + _TTL_SECONDS, value)


def bust() -> None:
    """Drop every cached table. Called after a Sync-to-Database job so the
    next read reflects the just-synced rows."""
    with _lock:
        _store.clear()

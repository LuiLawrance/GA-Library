FROM python:3.14-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install --with-deps chromium

COPY . .

# DATA_GA is a Railway volume mount; DATA_GENERAL is symlinked into a
# subfolder of it so both directories persist on the single volume Railway
# allows per service.
#
# `alembic upgrade head` runs on every boot when DATABASE_URL is set, so a
# deploy always lands on the current schema (idempotent — Alembic skips
# revisions already applied). Skipped entirely for a JSON-only deploy with no
# DATABASE_URL; fatal if it fails, so a broken migration stops the deploy
# rather than starting the app against a half-migrated database.
#
# WEB_CONCURRENCY (default 2) picks the number of uvicorn worker processes.
# Every DB call in this app is synchronous (see db/session.py) and made
# directly from `async def` route handlers with no thread offload, so ONE
# worker means one slow Postgres round trip stalls every concurrent user's
# request, not just the one that triggered it. Multiple worker processes
# fixes that at the process level — safe to do here because auth is a
# stateless signed JWT (any worker can validate any user's cookie, see
# create_token/get_current_user in app.py) and the in-memory catalog/pricing
# cache (db_cache.py) propagates bust() across workers via a marker file on
# this same shared volume. The one known gap: the admin "Sync to Database"
# progress tracker (_sync_jobs in app.py) is a plain in-memory dict, so a
# status poll landing on a different worker than the one running the job
# won't find it — low-impact (admin-only, rare, worst case a stalled
# progress bar) and not fixed here. Override with a platform env var if
# Railway's instance size calls for a different count.
CMD ["sh", "-c", "mkdir -p DATA_GA/DATA_GENERAL && ln -sfn DATA_GA/DATA_GENERAL DATA_GENERAL && { [ -z \"$DATABASE_URL\" ] || alembic upgrade head; } && uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-2}"]

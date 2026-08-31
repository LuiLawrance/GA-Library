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
CMD ["sh", "-c", "mkdir -p DATA_GA/DATA_GENERAL && ln -sfn DATA_GA/DATA_GENERAL DATA_GENERAL && { [ -z \"$DATABASE_URL\" ] || alembic upgrade head; } && uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]

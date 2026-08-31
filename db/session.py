from contextlib import contextmanager
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

import os

# Created lazily (not at import time) so importing db.session doesn't require
# DATABASE_URL to be set — only actually connecting (via get_session) does.
# That keeps JSON-only local runs (Use JSON on, no Postgres container running
# at all) free of any DB-related startup requirement.
_engine = None
_SessionLocal = None


def _get_engine():
    global _engine, _SessionLocal

    if _engine is None:
        database_url = os.getenv("DATABASE_URL")

        if not database_url:
            raise RuntimeError(
                "DATABASE_URL is not set — required when Use JSON is off. "
                "See .env for the local Docker Postgres connection string."
            )

        _engine = create_engine(database_url, future=True)
        _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False, future=True)

    return _engine


def reset_engine() -> None:
    """Drop the cached engine so the next get_session() reconnects using the
    current DATABASE_URL. Called after the Admin -> System "Database
    Connection" panel changes the connection string — _get_engine() re-reads
    os.getenv("DATABASE_URL") when it rebuilds. In-flight requests already
    holding a session finish on the old pooled connection; dispose() only
    stops new checkouts."""
    global _engine, _SessionLocal

    if _engine is not None:
        _engine.dispose()

    _engine = None
    _SessionLocal = None


@contextmanager
def get_session() -> Session:
    _get_engine()

    session = _SessionLocal()

    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

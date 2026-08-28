from contextlib import contextmanager
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

import os

# Created lazily (not at import time) so importing db.session doesn't require
# DATABASE_URL to be set — only actually connecting (via get_session) does.
# That keeps JSON-only local runs (local_database off, no Postgres container
# running at all) free of any DB-related startup requirement.
_engine = None
_SessionLocal = None


def _get_engine():
    global _engine, _SessionLocal

    if _engine is None:
        database_url = os.getenv("DATABASE_URL")

        if not database_url:
            raise RuntimeError(
                "DATABASE_URL is not set — required when local_database is on. "
                "See .env for the local Docker Postgres connection string."
            )

        _engine = create_engine(database_url, future=True)
        _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False, future=True)

    return _engine


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

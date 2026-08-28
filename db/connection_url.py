"""Parse / rebuild the DATABASE_URL from its individual pieces.

Backs the Admin -> System -> "Database Connection" panel: parse() turns the
current DATABASE_URL into the fields shown there, compose() turns edited
fields back into a URL string to write to .env and os.environ. Both go
through SQLAlchemy's own URL type so quoting, IPv6 hosts, odd passwords etc.
are handled the same way get_session()'s create_engine() would handle them.

DATABASE_URL is still the single source of truth (see db/session.py) — this
module never stores anything itself.
"""

from sqlalchemy.engine import make_url
from sqlalchemy.engine.url import URL

# What .env ships with and what get_session() has always assumed; used when
# there's no existing URL to copy the driver from.
DEFAULT_DRIVERNAME = "postgresql+psycopg2"

# sslmode rides in the URL query string (?sslmode=require) rather than being
# its own URL component — pull it out into its own field, leave any other
# query keys untouched so compose() can put them back.
_SSLMODE_KEY = "sslmode"

# The blank-slate shape parse() returns when DATABASE_URL is unset, so the
# frontend always gets the same keys.
_EMPTY = {
    "drivername": DEFAULT_DRIVERNAME,
    "host": "",
    "port": "",
    "database": "",
    "username": "",
    "password": "",
    "sslmode": "",
}


def parse(url_str: str | None) -> dict:
    """DATABASE_URL -> {drivername, host, port, database, username, password,
    sslmode}. Every value is a string ("" / port as digits) so it drops
    straight into form inputs. Returns the empty shape for a missing or
    unparseable URL rather than raising."""
    if not url_str:
        return dict(_EMPTY)

    try:
        url = make_url(url_str)
    except Exception:
        return dict(_EMPTY)

    query = dict(url.query)
    sslmode = query.get(_SSLMODE_KEY, "")
    # url.query values can be tuples when a key repeats; the frontend only
    # ever needs the scalar.
    if isinstance(sslmode, (tuple, list)):
        sslmode = sslmode[0] if sslmode else ""

    return {
        "drivername": url.drivername or DEFAULT_DRIVERNAME,
        "host": url.host or "",
        "port": str(url.port) if url.port else "",
        "database": url.database or "",
        "username": url.username or "",
        "password": url.password or "",
        "sslmode": sslmode,
    }


def compose(fields: dict, *, base_url: str | None = None) -> str:
    """{host, port, database, username, password, sslmode} -> a URL string.

    The driver and any query keys other than sslmode are copied from
    base_url (the URL currently in effect) so editing the host can't
    silently drop a `?sslmode=require` the platform put there. Raises
    ValueError on missing host / database or a non-numeric port.
    """
    host = (fields.get("host") or "").strip()
    database = (fields.get("database") or "").strip()
    username = (fields.get("username") or "").strip()
    password = fields.get("password") or ""
    sslmode = (fields.get("sslmode") or "").strip()
    port_raw = str(fields.get("port") or "").strip()

    if not host:
        raise ValueError("Host is required.")
    if not database:
        raise ValueError("Database name is required.")

    port = None
    if port_raw:
        try:
            port = int(port_raw)
        except ValueError:
            raise ValueError(f"Port must be a number, got {port_raw!r}.")

    drivername = DEFAULT_DRIVERNAME
    query: dict = {}
    if base_url:
        try:
            existing = make_url(base_url)
            drivername = existing.drivername or DEFAULT_DRIVERNAME
            query = {k: v for k, v in existing.query.items() if k != _SSLMODE_KEY}
        except Exception:
            pass

    if sslmode:
        query[_SSLMODE_KEY] = sslmode

    url = URL.create(
        drivername=drivername,
        username=username or None,
        password=password or None,
        host=host,
        port=port,
        database=database,
        query=query,
    )

    return url.render_as_string(hide_password=False)

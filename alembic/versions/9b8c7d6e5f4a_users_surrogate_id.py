"""users surrogate id

Revision ID: 9b8c7d6e5f4a
Revises: 5180b718b391
Create Date: 2026-09-03 11:00:00.000000

Gives `users` its own surrogate integer primary key (id), same pattern as
price_listings/price_sales/decks/etc., instead of using the mutable
`username` column as the key. inventory_bins, decks, watchlist_entries and
wishlist_entries all had a `username` foreign key pointing straight at
users.username — that's replaced with a `user_id` foreign key pointing at
users.id, so changing a user's username (or, down the line, offering a
rename feature at all) no longer means updating every dependent table's key
column in lockstep. username stays on `users` itself as a required, unique,
but otherwise ordinary column.

Each half below runs in two passes over the four child tables rather than
one, because Postgres won't let users_pkey be dropped (upgrade) or recreated
on a different column (downgrade) while any child table's foreign key still
depends on the constraint being replaced — that FK has to be dropped first,
on every child table, before touching users' primary key.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9b8c7d6e5f4a'
down_revision: Union[str, Sequence[str], None] = '5180b718b391'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (child table, old unique-constraint columns, new unique-constraint columns)
_CHILD_TABLES = [
    ("inventory_bins", ["username", "name"], ["user_id", "name"]),
    ("decks", ["username", "name"], ["user_id", "name"]),
    ("watchlist_entries", ["username", "edition_id", "foil_id"], ["user_id", "edition_id", "foil_id"]),
    ("wishlist_entries", ["username", "edition_id", "foil_id"], ["user_id", "edition_id", "foil_id"]),
]


def upgrade() -> None:
    """Upgrade schema."""
    # users: add the surrogate column first — ADD COLUMN ... SERIAL backfills
    # every existing row via the sequence in one pass — but it can't become
    # the primary key until every child table has let go of its FK into
    # users.username below, so it's left unconstrained for now.
    op.execute("ALTER TABLE users ADD COLUMN id SERIAL")

    # Pass 1: give every child table its user_id column, backfilled from the
    # username it still has, then drop that table's old username-based FK
    # and unique constraint (and the column itself — nothing needs it once
    # user_id is populated).
    for table, old_cols, _ in _CHILD_TABLES:
        op.add_column(table, sa.Column("user_id", sa.Integer(), nullable=True))
        op.execute(
            f"UPDATE {table} SET user_id = users.id "
            f"FROM users WHERE users.username = {table}.username"
        )
        op.alter_column(table, "user_id", nullable=False)

        op.drop_constraint(f"{table}_{'_'.join(old_cols)}_key", table, type_="unique")
        op.drop_constraint(f"{table}_username_fkey", table, type_="foreignkey")
        op.drop_column(table, "username")

    # Now nothing references users.username as a foreign key anymore, so the
    # primary key can move from username to id.
    op.drop_constraint("users_pkey", "users", type_="primary")
    op.create_primary_key("users_pkey", "users", ["id"])
    op.create_unique_constraint("users_username_key", "users", ["username"])

    # Pass 2: point every child table's FK/unique constraint at user_id now
    # that users.id is a real primary key.
    for table, _, new_cols in _CHILD_TABLES:
        op.create_foreign_key(f"{table}_user_id_fkey", table, "users", ["user_id"], ["id"], ondelete="CASCADE")
        op.create_unique_constraint(f"{table}_{'_'.join(new_cols)}_key", table, new_cols)


def downgrade() -> None:
    """Downgrade schema."""
    # Pass 1: give every child table back its username column, backfilled
    # from user_id (users.id/username both still exist at this point), then
    # drop that table's user_id-based FK/unique constraint and the column —
    # this has to happen before users' primary key can move off id.
    for table, old_cols, new_cols in _CHILD_TABLES:
        op.add_column(table, sa.Column("username", sa.Text(), nullable=True))
        op.execute(
            f"UPDATE {table} SET username = users.username "
            f"FROM users WHERE users.id = {table}.user_id"
        )
        op.alter_column(table, "username", nullable=False)

        op.drop_constraint(f"{table}_{'_'.join(new_cols)}_key", table, type_="unique")
        op.drop_constraint(f"{table}_user_id_fkey", table, type_="foreignkey")
        op.drop_column(table, "user_id")

    # Move the primary key back to username now that nothing references id.
    op.drop_constraint("users_username_key", "users", type_="unique")
    op.drop_constraint("users_pkey", "users", type_="primary")
    op.create_primary_key("users_pkey", "users", ["username"])
    op.drop_column("users", "id")

    # Pass 2: restore every child table's old username-based FK/unique.
    for table, old_cols, _ in _CHILD_TABLES:
        op.create_foreign_key(
            f"{table}_username_fkey", table, "users", ["username"], ["username"], ondelete="CASCADE",
        )
        op.create_unique_constraint(f"{table}_{'_'.join(old_cols)}_key", table, old_cols)

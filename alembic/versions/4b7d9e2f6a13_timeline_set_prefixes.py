"""timeline_events: set_prefix -> set_prefixes, drop banlist

A set release can cover several sets, so the single set_prefix text column
becomes a set_prefixes JSON list (existing values carried over). The banlist
category is retired; any such entry becomes an announcement. See
timeline.CATEGORY_FIELDS for which fields each category keeps.

Revision ID: 4b7d9e2f6a13
Revises: 8c4f2b6d1e93
Create Date: 2026-10-26 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '4b7d9e2f6a13'
down_revision: Union[str, Sequence[str], None] = '8c4f2b6d1e93'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'timeline_events',
        sa.Column('set_prefixes', postgresql.JSONB(astext_type=sa.Text()), nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
    )
    op.execute(
        "UPDATE timeline_events SET set_prefixes = jsonb_build_array(set_prefix) "
        "WHERE set_prefix IS NOT NULL AND set_prefix <> ''"
    )
    op.drop_column('timeline_events', 'set_prefix')
    op.execute("UPDATE timeline_events SET category = 'announcement' WHERE category = 'banlist'")


def downgrade() -> None:
    """Downgrade schema. Keeps only the first set of a multi-set entry;
    retired banlist entries stay announcements."""
    op.add_column('timeline_events', sa.Column('set_prefix', sa.Text(), nullable=True))
    op.execute("UPDATE timeline_events SET set_prefix = set_prefixes->>0")
    op.drop_column('timeline_events', 'set_prefixes')

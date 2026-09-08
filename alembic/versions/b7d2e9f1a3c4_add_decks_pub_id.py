"""add decks.pub_id

Revision ID: b7d2e9f1a3c4
Revises: a3b4c5d6e7f8
Create Date: 2026-09-08 10:00:00.000000

Gives every deck a stable, opaque per-deck handle (`pub_id`) that is minted
once and never rewritten on rename. It's the second segment of a public deck
URL (/decks?omni=<omnidex_id>&deck=<pub_id>), so a shared link keeps working
after the owner renames the deck — same rationale as users.omnidex_id.

The column is added nullable, backfilled with a fresh 8-hex-char token per
row (unique within each user), then made NOT NULL with a (user_id, pub_id)
unique constraint.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7d2e9f1a3c4'
down_revision: Union[str, Sequence[str], None] = 'a3b4c5d6e7f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('decks', sa.Column('pub_id', sa.Text(), nullable=True))

    # One fresh 8-hex-char token per existing row. md5(random() || id) is
    # per-row distinct; an 8-hex space (~4.3e9) makes a collision within a
    # single user's handful of decks a non-event, and the unique constraint
    # below would catch one anyway.
    op.execute("""
        UPDATE decks
        SET pub_id = substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 8)
        WHERE pub_id IS NULL
    """)

    op.alter_column('decks', 'pub_id', nullable=False)
    op.create_unique_constraint('uq_decks_user_id_pub_id', 'decks', ['user_id', 'pub_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('uq_decks_user_id_pub_id', 'decks', type_='unique')
    op.drop_column('decks', 'pub_id')

"""add inventory_bins.pub_id

Revision ID: c8e3f0a2b4d6
Revises: b7d2e9f1a3c4
Create Date: 2026-09-08 12:00:00.000000

Gives every inventory bin a stable, opaque per-bin handle (`pub_id`), minted
once and never rewritten on rename — the second segment of a public bin URL
(/collection?omni=<omnidex_id>&bin=<pub_id>). Mirrors decks.pub_id
(b7d2e9f1a3c4); same rationale as users.omnidex_id.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c8e3f0a2b4d6'
down_revision: Union[str, Sequence[str], None] = 'b7d2e9f1a3c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('inventory_bins', sa.Column('pub_id', sa.Text(), nullable=True))

    # One fresh 8-hex-char token per existing row (see the decks.pub_id
    # migration for the collision reasoning).
    op.execute("""
        UPDATE inventory_bins
        SET pub_id = substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 8)
        WHERE pub_id IS NULL
    """)

    op.alter_column('inventory_bins', 'pub_id', nullable=False)
    op.create_unique_constraint('uq_inventory_bins_user_id_pub_id', 'inventory_bins', ['user_id', 'pub_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('uq_inventory_bins_user_id_pub_id', 'inventory_bins', type_='unique')
    op.drop_column('inventory_bins', 'pub_id')

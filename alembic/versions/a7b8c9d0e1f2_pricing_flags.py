"""pricing_flags

The admin "Needs Action" log — product pages a scrape flagged for a manual
look (e.g. 3+ new sales out of TCGPlayer's 5-sale logged-out window). See
db.models.PricingFlag and needs_action.py.

Revision ID: a7b8c9d0e1f2
Revises: f3a8c2d1e6b4
Create Date: 2026-10-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7b8c9d0e1f2'
down_revision: Union[str, Sequence[str], None] = 'f3a8c2d1e6b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'pricing_flags',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('edition_id', sa.Text(), nullable=False),
        sa.Column('foil_id', sa.Text(), nullable=False),          # '' = main product
        sa.Column('marketplace', sa.Text(), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('new_sales', sa.Integer(), nullable=False),
        sa.Column('scrape_count', sa.Integer(), nullable=False),
        sa.Column('first_flagged_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_flagged_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('resolved_by', sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(['edition_id'], ['editions.edition_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_pricing_flags_edition_id', 'pricing_flags', ['edition_id'])
    op.create_index(
        'ix_pricing_flags_open', 'pricing_flags', ['edition_id', 'foil_id', 'marketplace', 'reason'],
        unique=True, postgresql_where=sa.text('resolved_at IS NULL'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_pricing_flags_open', table_name='pricing_flags')
    op.drop_index('ix_pricing_flags_edition_id', table_name='pricing_flags')
    op.drop_table('pricing_flags')

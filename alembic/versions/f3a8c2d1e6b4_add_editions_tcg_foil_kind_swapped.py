"""add editions tcg_foil_kind_swapped

Revision ID: f3a8c2d1e6b4
Revises: d9f4a1c6e8b2
Create Date: 2026-09-11 00:00:00.000000

Per-edition admin override for TCGPlayer product pages that label their rows'
conditions the opposite of what our foil data expects (e.g. a foil-only print
TCGPlayer nonetheless sells as a single unlabeled "Near Mint" product, no "
Foil" suffix) — see db/models.py's Edition.tcg_foil_kind_swapped and its use
in pricing_ga._store_sales_tcg / _store_listings_tcg.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3a8c2d1e6b4'
down_revision: Union[str, Sequence[str], None] = 'd9f4a1c6e8b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('editions', sa.Column('tcg_foil_kind_swapped', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('editions', 'tcg_foil_kind_swapped')

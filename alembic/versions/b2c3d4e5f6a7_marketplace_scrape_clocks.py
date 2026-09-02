"""marketplace_scrape_clocks

"Last Sales" / "Last Listings" are now tracked per marketplace (TCGPlayer /
CoreTCG / Manual), not as a single TCGPlayer-only date. Move them off
editions.tcg_last_sales / tcg_last_listings and foil_tcg_overrides.last_sales /
last_listings into a sparse marketplace_scrape_clocks table, backfilling the
existing values as the "TCGPlayer" rows, then drop the four columns.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-09-01 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b2c3d4e5f6a7'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'marketplace_scrape_clocks',
        sa.Column('edition_id', sa.Text(), nullable=False),
        sa.Column('foil_id', sa.Text(), nullable=False),          # '' = edition-level (main product)
        sa.Column('marketplace', sa.Text(), nullable=False),
        sa.Column('field', sa.Text(), nullable=False),            # 'sales' | 'listings'
        sa.Column('last_date', sa.Date(), nullable=False),
        sa.CheckConstraint("field IN ('sales', 'listings')", name='marketplace_scrape_clocks_field_check'),
        sa.ForeignKeyConstraint(['edition_id'], ['editions.edition_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('edition_id', 'foil_id', 'marketplace', 'field'),
    )

    # Backfill: every existing clock becomes the marketplace='TCGPlayer' row.
    op.execute(
        "INSERT INTO marketplace_scrape_clocks (edition_id, foil_id, marketplace, field, last_date) "
        "SELECT edition_id, '', 'TCGPlayer', 'sales', tcg_last_sales FROM editions "
        "WHERE tcg_last_sales IS NOT NULL"
    )
    op.execute(
        "INSERT INTO marketplace_scrape_clocks (edition_id, foil_id, marketplace, field, last_date) "
        "SELECT edition_id, '', 'TCGPlayer', 'listings', tcg_last_listings FROM editions "
        "WHERE tcg_last_listings IS NOT NULL"
    )
    op.execute(
        "INSERT INTO marketplace_scrape_clocks (edition_id, foil_id, marketplace, field, last_date) "
        "SELECT edition_id, foil_id, 'TCGPlayer', 'sales', last_sales FROM foil_tcg_overrides "
        "WHERE last_sales IS NOT NULL"
    )
    op.execute(
        "INSERT INTO marketplace_scrape_clocks (edition_id, foil_id, marketplace, field, last_date) "
        "SELECT edition_id, foil_id, 'TCGPlayer', 'listings', last_listings FROM foil_tcg_overrides "
        "WHERE last_listings IS NOT NULL"
    )

    op.drop_column('editions', 'tcg_last_sales')
    op.drop_column('editions', 'tcg_last_listings')
    op.drop_column('foil_tcg_overrides', 'last_sales')
    op.drop_column('foil_tcg_overrides', 'last_listings')


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column('editions', sa.Column('tcg_last_sales', sa.Date(), nullable=True))
    op.add_column('editions', sa.Column('tcg_last_listings', sa.Date(), nullable=True))
    op.add_column('foil_tcg_overrides', sa.Column('last_sales', sa.Date(), nullable=True))
    op.add_column('foil_tcg_overrides', sa.Column('last_listings', sa.Date(), nullable=True))

    # Copy the TCGPlayer rows back into the columns (non-TCGPlayer clocks are lost).
    op.execute(
        "UPDATE editions e SET tcg_last_sales = c.last_date "
        "FROM marketplace_scrape_clocks c "
        "WHERE c.edition_id = e.edition_id AND c.foil_id = '' "
        "AND c.marketplace = 'TCGPlayer' AND c.field = 'sales'"
    )
    op.execute(
        "UPDATE editions e SET tcg_last_listings = c.last_date "
        "FROM marketplace_scrape_clocks c "
        "WHERE c.edition_id = e.edition_id AND c.foil_id = '' "
        "AND c.marketplace = 'TCGPlayer' AND c.field = 'listings'"
    )
    op.execute(
        "UPDATE foil_tcg_overrides o SET last_sales = c.last_date "
        "FROM marketplace_scrape_clocks c "
        "WHERE c.edition_id = o.edition_id AND c.foil_id = o.foil_id "
        "AND c.marketplace = 'TCGPlayer' AND c.field = 'sales'"
    )
    op.execute(
        "UPDATE foil_tcg_overrides o SET last_listings = c.last_date "
        "FROM marketplace_scrape_clocks c "
        "WHERE c.edition_id = o.edition_id AND c.foil_id = o.foil_id "
        "AND c.marketplace = 'TCGPlayer' AND c.field = 'listings'"
    )

    op.drop_table('marketplace_scrape_clocks')

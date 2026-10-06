"""price_sales: keep same-day duplicate sales

Drops price_sales' unique constraint on the full (edition_id, foil_id, date,
marketplace, price, quantity, condition) tuple. Two genuinely separate sales of
the same printing on the same day at the same price/condition are both real —
the constraint silently collapsed them into one row. Duplicate protection now
lives in the writers instead (see pricing_ga: the scrape's settled-date rule and
the imports' count-aware dedup), same as price_listings and JSON mode already work.

The constraint's index was also the only index on (edition_id, foil_id) — the
lookup every per-card sales read uses — so a plain one replaces it, matching
price_listings' ix_price_listings_edition_id_foil_id.

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-10-06 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9d0e1f2a3b4'
down_revision: Union[str, Sequence[str], None] = 'b8c9d0e1f2a3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = ('edition_id', 'foil_id', 'date', 'marketplace', 'price', 'quantity', 'condition')


def upgrade() -> None:
    """Upgrade schema."""
    # The initial schema left it unnamed, so look up Postgres' generated name
    # rather than hardcoding its 63-char truncation.
    op.execute("""
        DO $$
        DECLARE c text;
        BEGIN
            SELECT conname INTO c FROM pg_constraint
            WHERE conrelid = 'price_sales'::regclass AND contype = 'u';
            IF c IS NOT NULL THEN
                EXECUTE format('ALTER TABLE price_sales DROP CONSTRAINT %I', c);
            END IF;
        END $$;
    """)
    op.create_index('ix_price_sales_edition_id_foil_id', 'price_sales', ['edition_id', 'foil_id'])


def downgrade() -> None:
    """Downgrade schema. Collapses any same-day duplicates back down to one row
    (keeping the oldest) so the constraint can be re-added."""
    op.drop_index('ix_price_sales_edition_id_foil_id', table_name='price_sales')
    op.execute(f"""
        DELETE FROM price_sales a USING price_sales b
        WHERE a.id > b.id
          AND {' AND '.join(f'a.{c} IS NOT DISTINCT FROM b.{c}' for c in _COLUMNS)}
    """)
    op.create_unique_constraint(None, 'price_sales', list(_COLUMNS))

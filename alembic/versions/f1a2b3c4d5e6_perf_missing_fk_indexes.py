"""add missing indexes on hot filter/join columns

Postgres does not auto-index foreign-key columns (only the referenced side,
e.g. the primary key they point at). These columns are filtered/joined on
directly by the card drawer, set/collector browsing, and pricing lookups
(editions.card_id, editions.set_slug — api_ga.py's load_card_detail_data /
_load_set_collector_data_db; price_listings.edition_id — pricing_ga.py's
_load_price_data_for_card), and were previously forcing full sequential
scans of editions/price_listings on every card view. card_rules.card_id and
card_slugs.card_id aren't on a hot path yet but are FK-shaped the same way,
so they're closed out here too rather than leaving a latent trap.

Revision ID: f1a2b3c4d5e6
Revises: d5e6f7a8b9c0
Create Date: 2026-09-04 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'd5e6f7a8b9c0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index('ix_editions_card_id', 'editions', ['card_id'])
    op.create_index('ix_editions_set_slug', 'editions', ['set_slug'])
    op.create_index('ix_card_rules_card_id', 'card_rules', ['card_id'])
    op.create_index('ix_card_slugs_card_id', 'card_slugs', ['card_id'])
    op.create_index('ix_price_listings_edition_id_foil_id', 'price_listings', ['edition_id', 'foil_id'])


def downgrade() -> None:
    op.drop_index('ix_price_listings_edition_id_foil_id', table_name='price_listings')
    op.drop_index('ix_card_slugs_card_id', table_name='card_slugs')
    op.drop_index('ix_card_rules_card_id', table_name='card_rules')
    op.drop_index('ix_editions_set_slug', table_name='editions')
    op.drop_index('ix_editions_card_id', table_name='editions')

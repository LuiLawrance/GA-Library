"""deck cards edition/foil

Revision ID: c4d5e6f7a8b9
Revises: 9b8c7d6e5f4a
Create Date: 2026-09-03 12:00:00.000000

Adds optional edition_id/foil_id to deck_cards, mirroring inventory_cards'
(card_id, edition_id, foil_id) shape but nullable — decks don't require a
specific printing, they just allow one to be recorded when the deck owner
cares to pin a card slot to a particular edition/foil. Existing rows get
NULL/NULL, which is exactly today's "any printing" behavior, so no backfill
is needed.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4d5e6f7a8b9'
down_revision: Union[str, Sequence[str], None] = '9b8c7d6e5f4a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('deck_cards', sa.Column('edition_id', sa.Text(), nullable=True))
    op.add_column('deck_cards', sa.Column('foil_id', sa.Text(), nullable=True))
    op.drop_constraint('deck_cards_section_id_card_id_key', 'deck_cards', type_='unique')
    op.create_unique_constraint(
        'deck_cards_section_id_card_id_edition_id_foil_id_key', 'deck_cards',
        ['section_id', 'card_id', 'edition_id', 'foil_id'],
    )
    op.create_foreign_key(
        'deck_cards_edition_id_foil_id_fkey', 'deck_cards', 'foils',
        ['edition_id', 'foil_id'], ['edition_id', 'foil_id'],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('deck_cards_edition_id_foil_id_fkey', 'deck_cards', type_='foreignkey')
    op.drop_constraint('deck_cards_section_id_card_id_edition_id_foil_id_key', 'deck_cards', type_='unique')
    op.create_unique_constraint('deck_cards_section_id_card_id_key', 'deck_cards', ['section_id', 'card_id'])
    op.drop_column('deck_cards', 'foil_id')
    op.drop_column('deck_cards', 'edition_id')

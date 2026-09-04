"""decks edition_locked

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-09-03 14:30:00.000000

Deck-wide flag: when on, adding a card always asks which printing/foil to
use (see DeckCard.edition_id/foil_id, added in c4d5e6f7a8b9) instead of
defaulting to "any edition". Off by default, matching decks.is_public's own
add-a-flag pattern (5180b718b391).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5e6f7a8b9c0'
down_revision: Union[str, Sequence[str], None] = 'c4d5e6f7a8b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('decks', sa.Column('edition_locked', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('decks', 'edition_locked')

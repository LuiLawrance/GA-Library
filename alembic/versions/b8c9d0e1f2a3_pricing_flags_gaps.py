"""pricing_flags.gaps

Each flagged scrape's possible gap in the sales history — the newest sale date
already on file for that product page before the scrape (previous_latest) and
the earliest of the sales it newly stored (earliest_new). Any sales TCGPlayer's
5-sale logged-out window hid fall between the two. A list, since a re-flag
while still open adds another gap onto the same flag. See needs_action.py.

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-10-05 01:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b8c9d0e1f2a3'
down_revision: Union[str, Sequence[str], None] = 'a7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('pricing_flags', sa.Column(
        'gaps', postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb"),
    ))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('pricing_flags', 'gaps')

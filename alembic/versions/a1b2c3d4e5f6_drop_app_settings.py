"""drop app_settings

Admin settings are JSON-only now — SETTINGS.json is the sole source of truth
in every mode (see settings.py). The app_settings table briefly mirrored the
non-mode keys (store_images_locally) while DB mode was active; nothing reads
or writes it anymore.

Revision ID: a1b2c3d4e5f6
Revises: c1a6f4bd682e
Create Date: 2026-08-28 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = 'c1a6f4bd682e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_table('app_settings')


def downgrade() -> None:
    """Downgrade schema."""
    op.create_table(
        'app_settings',
        sa.Column('key', sa.Text(), nullable=False),
        sa.Column('value', sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint('key'),
    )

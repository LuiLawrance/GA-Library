"""add users.omnidex_id

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2026-09-03 02:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e4f5a6b7c8d9'
down_revision: Union[str, Sequence[str], None] = 'd3e4f5a6b7c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('omnidex_id', sa.Text(), nullable=True))
    op.create_unique_constraint('uq_users_omnidex_id', 'users', ['omnidex_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('uq_users_omnidex_id', 'users', type_='unique')
    op.drop_column('users', 'omnidex_id')

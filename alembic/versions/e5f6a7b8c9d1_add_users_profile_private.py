"""add users.profile_private

Per-user switch that hides the public /#<omnidex_id> profile page from
everyone but its owner — see user.user_set_profile_private.

Revision ID: e5f6a7b8c9d1
Revises: 7e3c1a9b5d20
Create Date: 2026-10-09 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e5f6a7b8c9d1'
down_revision: Union[str, Sequence[str], None] = '7e3c1a9b5d20'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'users',
        sa.Column('profile_private', sa.Boolean(), nullable=False, server_default=sa.text('false')),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('users', 'profile_private')

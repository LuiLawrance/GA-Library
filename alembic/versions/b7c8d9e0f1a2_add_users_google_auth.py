"""add users google auth (google_sub, google_email; password_hash nullable)

Revision ID: b7c8d9e0f1a2
Revises: a3b4c5d6e7f8
Create Date: 2026-09-07 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7c8d9e0f1a2'
down_revision: Union[str, Sequence[str], None] = 'a3b4c5d6e7f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('users', sa.Column('google_sub', sa.Text(), nullable=True))
    op.add_column('users', sa.Column('google_email', sa.Text(), nullable=True))
    op.create_unique_constraint('uq_users_google_sub', 'users', ['google_sub'])
    # A Google-only account has no password — NULL, distinct from "" which
    # already means "admin-cleared, blank-password login allowed" (user_login).
    op.alter_column('users', 'password_hash', existing_type=sa.Text(), nullable=True)


def downgrade() -> None:
    """Downgrade schema."""
    # Fails if any Google-only rows (password_hash IS NULL) exist — expected.
    op.alter_column('users', 'password_hash', existing_type=sa.Text(), nullable=False)
    op.drop_constraint('uq_users_google_sub', 'users', type_='unique')
    op.drop_column('users', 'google_email')
    op.drop_column('users', 'google_sub')

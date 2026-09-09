"""add bin_shares / deck_shares

Revision ID: d9f4a1c6e8b2
Revises: c8e3f0a2b4d6
Create Date: 2026-09-08 14:00:00.000000

Collaborative access for inventory bins and decks (Postgres-only feature). One
row grants one user a role — viewer / editor / manager — on one bin/deck they
don't own. The owner stays inventory_bins.user_id / decks.user_id and is never
a row here. See _bin_access / _deck_access in app.py.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd9f4a1c6e8b2'
down_revision: Union[str, Sequence[str], None] = 'c8e3f0a2b4d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ROLE_CHECK = "role IN ('viewer', 'editor', 'manager')"


def _share_table(name: str, parent: str, parent_col: str) -> None:
    op.create_table(
        name,
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column(parent_col, sa.Integer(), nullable=False),
        sa.Column('grantee_id', sa.Integer(), nullable=False),
        sa.Column('role', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.ForeignKeyConstraint([parent_col], [f'{parent}.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['grantee_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(parent_col, 'grantee_id'),
        sa.CheckConstraint(_ROLE_CHECK, name=f'ck_{name}_role'),
    )
    op.create_index(f'ix_{name}_grantee_id', name, ['grantee_id'])


def upgrade() -> None:
    """Upgrade schema."""
    _share_table('bin_shares', 'inventory_bins', 'bin_id')
    _share_table('deck_shares', 'decks', 'deck_id')


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_deck_shares_grantee_id', table_name='deck_shares')
    op.drop_table('deck_shares')
    op.drop_index('ix_bin_shares_grantee_id', table_name='bin_shares')
    op.drop_table('bin_shares')

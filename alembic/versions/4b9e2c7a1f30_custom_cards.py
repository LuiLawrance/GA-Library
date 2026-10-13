"""custom cards: cards.is_custom, editions.is_custom, custom_images

Admin-created cards / printings the Grand Archive API doesn't have (see
custom_cards.py). is_custom marks them so API syncs leave them alone; their
art lives in custom_images (bytes in Postgres so every instance sharing this
database can serve it, cached to each instance's DATA_GA/IMAGES_GA on first
view).

Revision ID: 4b9e2c7a1f30
Revises: e5f6a7b8c9d1
Create Date: 2026-10-12 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4b9e2c7a1f30'
down_revision: Union[str, Sequence[str], None] = 'e5f6a7b8c9d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('cards', sa.Column('is_custom', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('editions', sa.Column('is_custom', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_table(
        'custom_images',
        sa.Column('edition_id', sa.Text(), nullable=False),
        sa.Column('content_type', sa.Text(), nullable=False),
        sa.Column('data', sa.LargeBinary(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['edition_id'], ['editions.edition_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('edition_id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('custom_images')
    op.drop_column('editions', 'is_custom')
    op.drop_column('cards', 'is_custom')

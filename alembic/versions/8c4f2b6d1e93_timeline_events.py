"""timeline_events

Admin-curated dated milestones (set releases, World/Ascent tournaments,
banlist updates...) from Admin → Cards → Events. See db.models.TimelineEvent
and timeline.py.

Revision ID: 8c4f2b6d1e93
Revises: 4b9e2c7a1f30
Create Date: 2026-10-23 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8c4f2b6d1e93'
down_revision: Union[str, Sequence[str], None] = '4b9e2c7a1f30'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'timeline_events',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('category', sa.Text(), nullable=False),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('end_date', sa.Date(), nullable=True),
        sa.Column('set_prefix', sa.Text(), nullable=True),
        sa.Column('omnidex_event_id', sa.Integer(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_by', sa.Text(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('updated_by', sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_timeline_events_start_date', 'timeline_events', ['start_date'])
    op.create_index('ix_timeline_events_omnidex_event_id', 'timeline_events', ['omnidex_event_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_timeline_events_omnidex_event_id', table_name='timeline_events')
    op.drop_index('ix_timeline_events_start_date', table_name='timeline_events')
    op.drop_table('timeline_events')

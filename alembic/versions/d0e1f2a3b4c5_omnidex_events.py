"""omnidex events

Organized-play events from the Grand Archive API's /omnidex/events/* endpoints
— see db.models.Event and events_ga.py.

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-10-09 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'd0e1f2a3b4c5'
down_revision: Union[str, Sequence[str], None] = 'c9d0e1f2a3b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'events',
        sa.Column('event_id', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('category', sa.Text(), nullable=True),
        sa.Column('format', sa.Text(), nullable=True),
        sa.Column('status', sa.Text(), nullable=True),
        sa.Column('setting', sa.Text(), nullable=True),
        sa.Column('structure', sa.Text(), nullable=True),
        sa.Column('type', sa.Text(), nullable=True),
        sa.Column('ranked', sa.Boolean(), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('url', sa.Text(), nullable=True),
        sa.Column('start_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('vp_multiplier', sa.Numeric(), nullable=True),
        sa.Column('swiss_rounds', sa.Integer(), nullable=True),
        sa.Column('swiss_match_config', sa.Text(), nullable=True),
        sa.Column('se_cut_size', sa.Integer(), nullable=True),
        sa.Column('se_match_config', sa.Text(), nullable=True),
        sa.Column('team_size', sa.Integer(), nullable=True),
        sa.Column('has_decklists', sa.Boolean(), nullable=True),
        sa.Column('host_id', sa.Integer(), nullable=True),
        sa.Column('host_name', sa.Text(), nullable=True),
        sa.Column('host_address', sa.Text(), nullable=True),
        sa.Column('host_country', sa.Text(), nullable=True),
        sa.Column('season_id', sa.Integer(), nullable=True),
        sa.Column('season_name', sa.Text(), nullable=True),
        sa.Column('player_count', sa.Integer(), nullable=False),
        sa.Column('team_count', sa.Integer(), nullable=False),
        sa.Column('stages', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('statistics', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('last_synced', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('event_id'),
    )
    op.create_index('ix_events_start_at', 'events', ['start_at'])

    op.create_table(
        'omnidex_players',
        sa.Column('player_id', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('username', sa.Text(), nullable=True),
        sa.Column('country', sa.Text(), nullable=True),
        sa.Column('cp', sa.Integer(), nullable=True),
        sa.Column('emblem', sa.Text(), nullable=True),
        sa.Column('rank', sa.Integer(), nullable=True),
        sa.Column('judge_level', sa.Integer(), nullable=True),
        sa.Column('judge_experience', sa.Integer(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('player_id'),
    )

    op.create_table(
        'event_entrants',
        sa.Column('event_id', sa.Integer(), nullable=False),
        sa.Column('player_id', sa.Integer(), nullable=False),
        sa.Column('role', sa.Text(), nullable=False),
        sa.Column('final_placement', sa.Integer(), nullable=True),
        sa.Column('team_name', sa.Text(), nullable=True),
        sa.Column('team_slot', sa.Integer(), nullable=True),
        sa.CheckConstraint("role IN ('player', 'judge')", name='ck_event_entrants_role'),
        sa.ForeignKeyConstraint(['event_id'], ['events.event_id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['player_id'], ['omnidex_players.player_id']),
        sa.PrimaryKeyConstraint('event_id', 'player_id', 'role'),
    )
    op.create_index('ix_event_entrants_player_id', 'event_entrants', ['player_id'])

    op.create_table(
        'event_standings',
        sa.Column('event_id', sa.Integer(), nullable=False),
        sa.Column('position', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('player_id', sa.Integer(), nullable=True),
        sa.Column('team_name', sa.Text(), nullable=True),
        sa.Column('final_placement', sa.Integer(), nullable=True),
        sa.Column('status', sa.Text(), nullable=True),
        sa.Column('stats', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.event_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('event_id', 'position'),
    )

    op.create_table(
        'event_matches',
        sa.Column('event_id', sa.Integer(), nullable=False),
        sa.Column('stage_id', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('round_id', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('match_id', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('stage_type', sa.Text(), nullable=True),
        sa.Column('label', sa.Text(), nullable=True),
        sa.Column('status', sa.Text(), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('pairing', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.event_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('event_id', 'stage_id', 'round_id', 'match_id'),
    )

    op.create_table(
        'event_decklists',
        sa.Column('event_id', sa.Integer(), nullable=False),
        sa.Column('player_id', sa.Integer(), autoincrement=False, nullable=False),
        sa.Column('visible', sa.Boolean(), nullable=False),
        sa.Column('main', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('material', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('sideboard', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.event_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('event_id', 'player_id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('event_decklists')
    op.drop_table('event_matches')
    op.drop_table('event_standings')
    op.drop_index('ix_event_entrants_player_id', table_name='event_entrants')
    op.drop_table('event_entrants')
    op.drop_table('omnidex_players')
    op.drop_index('ix_events_start_at', table_name='events')
    op.drop_table('events')

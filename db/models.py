"""SQLAlchemy models mirroring the full DATA_GA/DATA_GENERAL JSON data model.

The migration proceeded domain by domain (see the migration plan) — `users`
first, then the card catalog and pricing reads. Admin settings deliberately
stayed out: SETTINGS.json is their sole source of truth in every mode (see
settings.py), and the `app_settings` table that briefly mirrored them was
dropped in migration a1b2c3d4e5f6. Models whose app.py routes aren't wired
to Postgres yet still exist here so the schema and the import script
(scripts/migrate_json_to_pg.py) stay complete.

Primary keys reuse the JSON data's own string IDs (card_id, edition_id,
foil_id, username, slug, ...) wherever one already exists, so a table reads
1:1 against the JSON file it replaces. Surrogate integer keys are only used
where the JSON has none (rules, errors, price rows, bins, sections, decks,
deck cards, watchlist/wishlist entries).

Note: `datetime` is imported as a module (`import datetime as dt`, referenced
as `dt.date`/`dt.datetime`) rather than `from datetime import date, datetime`
— several columns below are themselves named `date`/`created_at` etc., and a
bare `date`/`datetime` type import gets shadowed by SQLAlchemy's annotation
resolution once a same-named column exists on the class, silently producing
the wrong `nullable` value instead of an error (confirmed while writing
CardRule.date below — it came out NOT NULL despite `| None` until this
import was qualified).
"""

import datetime as dt

from sqlalchemy import (
    Boolean, CheckConstraint, Date, DateTime, ForeignKey, ForeignKeyConstraint, Numeric, Text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


# ── Users & settings ─────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    username: Mapped[str] = mapped_column(Text, primary_key=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    auth_type: Mapped[str] = mapped_column(Text, nullable=False)
    notes: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=dt.datetime.utcnow)


# ── Card catalog ──────────────────────────────────────────────────────────────

class FeaturedSetGroup(Base):
    __tablename__ = "featured_set_groups"

    group_name: Mapped[str] = mapped_column(Text, primary_key=True)
    image_path: Mapped[str | None] = mapped_column(Text)


class Set(Base):
    __tablename__ = "sets"

    slug: Mapped[str] = mapped_column(Text, primary_key=True)
    prefix: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str | None] = mapped_column(Text)
    featured_group: Mapped[str | None] = mapped_column(ForeignKey("featured_set_groups.group_name"))
    # Position within featured_group's own list — FEATURED_SETS.json orders
    # each group's member sets deliberately (e.g. "PRD, PRD 1st, PRDG, ..."),
    # an ordering with no other natural sort key, so it's preserved
    # explicitly rather than left to fall out of insertion/alphabetical order.
    featured_position: Mapped[int | None]
    image_path: Mapped[str | None] = mapped_column(Text)
    last_searched: Mapped[dt.date | None] = mapped_column(Date)
    tcgplayer_group_id: Mapped[str | None] = mapped_column(Text)


class Card(Base):
    __tablename__ = "cards"

    card_id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str | None] = mapped_column(Text)
    element: Mapped[str | None] = mapped_column(Text)
    effect: Mapped[str | None] = mapped_column(Text)
    effect_html: Mapped[str | None] = mapped_column(Text)
    effect_raw: Mapped[str | None] = mapped_column(Text)
    legality_draft: Mapped[bool | None] = mapped_column(Boolean)
    legality_pantheon: Mapped[bool | None] = mapped_column(Boolean)
    legality_standard: Mapped[bool | None] = mapped_column(Boolean)
    cost_memory: Mapped[int | None]
    cost_reserve: Mapped[int | None]
    durability: Mapped[int | None]
    level: Mapped[int | None]
    life: Mapped[int | None]
    power: Mapped[int | None]
    # Most cards carry a numeric Speed stat, but some (confirmed in real
    # source data — see scripts/migrate_json_to_pg.py's _split_speed) encode
    # a boolean "Fast" keyword under the same INFO.json "speed" key instead
    # of a number. Kept as two columns rather than overloading one, so the
    # numeric case stays a real INTEGER instead of degrading to text for
    # everyone to accommodate the rarer boolean case.
    speed: Mapped[int | None]
    speed_fast: Mapped[bool | None] = mapped_column(Boolean)
    types: Mapped[list | None] = mapped_column(JSONB)
    last_synced: Mapped[dt.date | None] = mapped_column(Date)


class CardSlug(Base):
    __tablename__ = "card_slugs"

    slug: Mapped[str] = mapped_column(Text, primary_key=True)
    card_id: Mapped[str] = mapped_column(ForeignKey("cards.card_id"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)


class CardRule(Base):
    __tablename__ = "card_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    card_id: Mapped[str] = mapped_column(ForeignKey("cards.card_id"), nullable=False)
    date: Mapped[dt.date | None] = mapped_column(Date)
    title: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, nullable=False)


class Edition(Base):
    __tablename__ = "editions"

    edition_id: Mapped[str] = mapped_column(Text, primary_key=True)
    card_id: Mapped[str] = mapped_column(ForeignKey("cards.card_id"), nullable=False)
    set_slug: Mapped[str | None] = mapped_column(ForeignKey("sets.slug"))
    collector_number: Mapped[str | None] = mapped_column(Text)
    rarity: Mapped[int | None]
    illustrator: Mapped[str | None] = mapped_column(Text)
    flavor: Mapped[str | None] = mapped_column(Text)
    date_created: Mapped[dt.date | None] = mapped_column(Date)
    date_release: Mapped[dt.date | None] = mapped_column(Date)
    date_update: Mapped[dt.date | None] = mapped_column(Date)
    # ID_TCGPLAYER.json's top-level (main-product) entry folded onto the edition
    tcg_product_id: Mapped[str | None] = mapped_column(Text)
    tcg_is_no_listings: Mapped[bool] = mapped_column(Boolean, default=False)
    tcg_last_sales: Mapped[dt.date | None] = mapped_column(Date)
    tcg_last_listings: Mapped[dt.date | None] = mapped_column(Date)


class Foil(Base):
    """Unifies INFO.json's top-level foils and their nested `variants` (e.g.
    Curio Foils) into one table/ID space — parent_foil_id is NULL for a
    top-level foil, set for a variant nested under that foil.

    Primary key is (edition_id, foil_id), NOT foil_id alone: confirmed
    against the real local data that foil_id/variant_id strings are only
    unique WITHIN their own edition's `foils` dict, not globally — the same
    id (e.g. the "temp" TEMP_FOIL_ID sentinel, but also plenty of ordinary
    ids) repeats across many unrelated editions. card_id and edition_id ARE
    confirmed globally unique, so those stay single-column keys."""
    __tablename__ = "foils"
    __table_args__ = (
        ForeignKeyConstraint(["edition_id", "parent_foil_id"], ["foils.edition_id", "foils.foil_id"]),
    )

    edition_id: Mapped[str] = mapped_column(ForeignKey("editions.edition_id"), primary_key=True)
    foil_id: Mapped[str] = mapped_column(Text, primary_key=True)
    parent_foil_id: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str | None] = mapped_column(Text)
    population: Mapped[int | None]
    printing: Mapped[bool | None] = mapped_column(Boolean)


class FoilTcgOverride(Base):
    """Sparse — only for variants (Curio Foils etc.) sold as their own
    separate TCGPlayer product, distinct from their parent foil's."""
    __tablename__ = "foil_tcg_overrides"
    __table_args__ = (
        ForeignKeyConstraint(["edition_id", "foil_id"], ["foils.edition_id", "foils.foil_id"]),
    )

    edition_id: Mapped[str] = mapped_column(Text, primary_key=True)
    foil_id: Mapped[str] = mapped_column(Text, primary_key=True)
    product_id: Mapped[str | None] = mapped_column(Text)
    is_no_listings: Mapped[bool] = mapped_column(Boolean, default=False)
    last_sales: Mapped[dt.date | None] = mapped_column(Date)
    last_listings: Mapped[dt.date | None] = mapped_column(Date)


class ThemaScore(Base):
    __tablename__ = "thema_scores"
    __table_args__ = (CheckConstraint("foil_type IN ('nonfoil', 'foil')", name="thema_scores_foil_type_check"),)

    edition_id: Mapped[str] = mapped_column(ForeignKey("editions.edition_id"), primary_key=True)
    foil_type: Mapped[str] = mapped_column(Text, primary_key=True)
    charm: Mapped[int | None]
    ferocity: Mapped[int | None]
    grace: Mapped[int | None]
    mystique: Mapped[int | None]
    valor: Mapped[int | None]
    dynamic: Mapped[bool | None] = mapped_column(Boolean)


class CardError(Base):
    """Flat append-only log — identifier is free-text in the source data
    (an edition_id, a URL, a card name, ...) so it isn't a real FK."""
    __tablename__ = "card_errors"

    id: Mapped[int] = mapped_column(primary_key=True)
    occurred_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    identifier: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)


# ── Pricing ───────────────────────────────────────────────────────────────────

class PriceListing(Base):
    __tablename__ = "price_listings"
    __table_args__ = (
        ForeignKeyConstraint(["edition_id", "foil_id"], ["foils.edition_id", "foils.foil_id"]),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    edition_id: Mapped[str] = mapped_column(Text, nullable=False)
    foil_id: Mapped[str] = mapped_column(Text, nullable=False)
    date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    marketplace: Mapped[str | None] = mapped_column(Text)
    price: Mapped[float | None] = mapped_column(Numeric(10, 2))
    quantity: Mapped[int | None]
    condition: Mapped[str | None] = mapped_column(Text)


class PriceSale(Base):
    __tablename__ = "price_sales"
    __table_args__ = (
        ForeignKeyConstraint(["edition_id", "foil_id"], ["foils.edition_id", "foils.foil_id"]),
        UniqueConstraint("edition_id", "foil_id", "date", "marketplace", "price", "quantity", "condition"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    edition_id: Mapped[str] = mapped_column(Text, nullable=False)
    foil_id: Mapped[str] = mapped_column(Text, nullable=False)
    date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    marketplace: Mapped[str | None] = mapped_column(Text)
    price: Mapped[float | None] = mapped_column(Numeric(10, 2))
    quantity: Mapped[int | None]
    condition: Mapped[str | None] = mapped_column(Text)


# ── Inventory (schema only this stage — see plan) ──────────────────────────────

class InventoryBin(Base):
    __tablename__ = "inventory_bins"
    __table_args__ = (UniqueConstraint("username", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(ForeignKey("users.username", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    desc: Mapped[str | None] = mapped_column(Text)
    banner: Mapped[str | None] = mapped_column(Text)
    symbol: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list | None] = mapped_column(JSONB)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)


class InventorySection(Base):
    __tablename__ = "inventory_sections"
    __table_args__ = (UniqueConstraint("bin_id", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    bin_id: Mapped[int] = mapped_column(ForeignKey("inventory_bins.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int | None]


class InventoryCard(Base):
    __tablename__ = "inventory_cards"
    __table_args__ = (
        UniqueConstraint("section_id", "card_id", "edition_id", "foil_id"),
        ForeignKeyConstraint(["edition_id", "foil_id"], ["foils.edition_id", "foils.foil_id"]),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("inventory_sections.id", ondelete="CASCADE"), nullable=False)
    card_id: Mapped[str] = mapped_column(ForeignKey("cards.card_id"), nullable=False)
    edition_id: Mapped[str] = mapped_column(Text, nullable=False)
    foil_id: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[int] = mapped_column(nullable=False)


# ── Decks (schema only this stage — see plan) ───────────────────────────────────

class Deck(Base):
    __tablename__ = "decks"
    __table_args__ = (UniqueConstraint("username", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(ForeignKey("users.username", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    desc: Mapped[str | None] = mapped_column(Text)
    format: Mapped[str | None] = mapped_column(Text)
    banner: Mapped[str | None] = mapped_column(Text)
    symbol: Mapped[str | None] = mapped_column(Text)
    tags: Mapped[list | None] = mapped_column(JSONB)
    created_at: Mapped[dt.date | None] = mapped_column(Date)
    modified_at: Mapped[dt.date | None] = mapped_column(Date)


class DeckSection(Base):
    __tablename__ = "deck_sections"
    __table_args__ = (UniqueConstraint("deck_id", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    deck_id: Mapped[int] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int | None]


class DeckCard(Base):
    __tablename__ = "deck_cards"
    __table_args__ = (UniqueConstraint("section_id", "card_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("deck_sections.id", ondelete="CASCADE"), nullable=False)
    card_id: Mapped[str] = mapped_column(ForeignKey("cards.card_id"), nullable=False)
    quantity: Mapped[int] = mapped_column(nullable=False)
    position: Mapped[int | None]


# ── Watchlist / Wishlist (schema only this stage — see plan) ───────────────────

class WatchlistEntry(Base):
    __tablename__ = "watchlist_entries"
    __table_args__ = (
        UniqueConstraint("username", "edition_id", "foil_id"),
        ForeignKeyConstraint(["edition_id", "foil_id"], ["foils.edition_id", "foils.foil_id"]),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(ForeignKey("users.username", ondelete="CASCADE"), nullable=False)
    edition_id: Mapped[str] = mapped_column(Text, nullable=False)
    foil_id: Mapped[str] = mapped_column(Text, nullable=False)
    added_date: Mapped[dt.date | None] = mapped_column(Date)


class WishlistEntry(Base):
    """Placeholder — wishlist has no implemented behavior anywhere in the app
    yet (see plan); mirrors watchlist's shape as a starting point."""
    __tablename__ = "wishlist_entries"
    __table_args__ = (
        UniqueConstraint("username", "edition_id", "foil_id"),
        ForeignKeyConstraint(["edition_id", "foil_id"], ["foils.edition_id", "foils.foil_id"]),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(ForeignKey("users.username", ondelete="CASCADE"), nullable=False)
    edition_id: Mapped[str] = mapped_column(Text, nullable=False)
    foil_id: Mapped[str] = mapped_column(Text, nullable=False)
    added_date: Mapped[dt.date | None] = mapped_column(Date)

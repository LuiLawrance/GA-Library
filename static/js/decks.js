// ═══════════════════════════════════════
// PUBLIC DECKS PAGE (read-only browse of every deck marked public)
// ═══════════════════════════════════════

let pdDecks = [];
let pdActiveDeck = null; // {omnidexId, name}
let pdActiveDeckData = null; // last-fetched detail payload, kept so the view toggle can re-render
// Viewer's chosen display mode for the open deck — starts at the deck's own
// edition_locked value, then the reader can flip it. Purely local: no server write.
let pdViewLocked = false;

async function loadPublicDecks() {
    const container = document.getElementById('pd-sections');
    if (!container) return;

    try {
        const res = await fetch('/api/decks/public');
        if (!res.ok) throw new Error();
        const data = await res.json();
        pdDecks = data.decks || [];
    } catch {
        container.innerHTML = '<p class="dga-loading">Failed to load decks.</p>';
        return;
    }

    renderPublicDeckSectionsList();
}

// One section for now ("All Decks") — more can be appended here later (e.g.
// by format, featured) without touching the surrounding page layout, same
// as a deck's own card grid or an Inventory bin groups its contents.
function renderPublicDeckSectionsList() {
    const container = document.getElementById('pd-sections');
    container.innerHTML = '';
    container.appendChild(buildPublicDeckSection('All Decks', pdDecks));
}

function buildPublicDeckSection(label, decks) {
    const block = document.createElement('div');
    block.className = 'dga-section-block';

    const header = document.createElement('div');
    header.className = 'dga-section-header';
    header.innerHTML = `
        <span class="dga-section-label label">${label}</span>
        <span class="dga-section-count">${decks.length} deck${decks.length !== 1 ? 's' : ''}</span>`;
    block.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'dga-deck-grid pd-section-deck-grid';

    if (decks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pd-empty';
        empty.innerHTML = `<span class="inv-empty-icon">⬡</span><p>No public decks yet.</p>`;
        grid.appendChild(empty);
    } else {
        decks.forEach((deck, i) => grid.appendChild(buildPublicDeckTile(deck, i, decks.length)));
    }

    block.appendChild(grid);
    return block;
}

function buildPublicDeckTile(deck, index, total) {
    const tile = document.createElement('div');
    tile.className = 'dga-deck-tile';
    const delay = total <= 1 ? 0 : Math.min(index * 50, Math.round((index / (total - 1)) * 400));
    tile.style.animationDelay = `${delay}ms`;

    const fmt = deck.format ? `<span class="dga-tile-format">${deck.format}</span>` : '';
    const count = deck.card_count || 0;

    // Format badge sits in the icon row, to the right of the ⬡ glyph — same
    // placement as Inventory's "Default" bin badge (see buildBinTile). Meta row
    // mirrors .inv-bin-meta-row: card count left, priced-total badge bottom-right
    // — badge only for Edition Locked decks (an unlocked deck pins no real
    // printings, so there's nothing meaningful to total).
    const valueBadge = deck.edition_locked
        ? '<span class="inv-bin-value-badge inv-bin-value-loading">…</span>'
        : '';
    tile.innerHTML = `
        <div class="dga-tile-icon-row">
            <span class="dga-tile-icon">⬡</span>
            ${fmt}
        </div>
        <div class="dga-tile-name">${deck.name}</div>
        <div class="pd-tile-owner">by ${deck.username}</div>
        <div class="dga-tile-desc">${deck.desc || ''}</div>
        <div class="dga-tile-meta-row inv-bin-meta-row">
            <div class="dga-tile-meta">${count} card${count !== 1 ? 's' : ''}</div>
            ${valueBadge}
        </div>`;

    if (deck.edition_locked && deck.omnidex_id) {
        loadDeckValue(
            tile.querySelector('.inv-bin-value-badge'),
            `/api/decks/public/${encodeURIComponent(deck.omnidex_id)}/${encodeURIComponent(deck.name)}/value`,
        );
    }

    if (deck.banner) {
        tile.classList.add('has-banner');
        const bg = document.createElement('div');
        bg.className = 'dga-tile-banner';
        bg.style.backgroundImage = `url('/images/${encodeURIComponent(deck.banner)}.jpg')`;
        tile.prepend(bg);
    }

    tile.onclick = () => openPublicDeckDetail(deck.omnidex_id, deck.name, true, deck.username);
    return tile;
}

// omnidexId (not username) addresses the deck in the URL/API — same rationale
// as the public profile page (see api_public_deck_get). displayUsername is an
// optional immediate value for the "by ..." byline, shown before the deck
// fetch resolves (which also carries username, confirming/filling it in for
// a direct/deep-linked visit where no tile click supplied it upfront).
async function openPublicDeckDetail(omnidexId, deckName, pushUrl = true, displayUsername = null) {
    pdActiveDeck = {omnidexId, name: deckName};

    document.getElementById('pd-list-view').classList.add('hidden');
    document.getElementById('pd-detail-view').classList.remove('hidden');

    document.getElementById('pd-detail-name').textContent = deckName;
    document.getElementById('pd-detail-owner').textContent = displayUsername ? `by ${displayUsername}` : '';

    const grid = document.getElementById('pd-card-grid');
    if (grid) grid.innerHTML = '<p class="dga-loading">Loading...</p>';

    const valEl = document.getElementById('pd-detail-value');
    if (valEl) {
        // Shown only for Edition Locked decks — see the fetch below.
        valEl.classList.add('hidden');
        valEl.textContent = '…';
        valEl.classList.add('inv-bin-value-loading');
        valEl.classList.remove('inv-bin-value-partial');
    }

    if (pushUrl) {
        window.history.pushState({}, '', `/decks?omni=${encodeURIComponent(omnidexId)}&deck=${encodeURIComponent(deckName)}`);
    }

    try {
        const res = await fetch(`/api/decks/public/${encodeURIComponent(omnidexId)}/${encodeURIComponent(deckName)}`);
        if (!res.ok) throw new Error();
        const data = await res.json();

        document.getElementById('pd-detail-format').textContent = data.format ? `[${data.format}]` : '';
        document.getElementById('pd-detail-desc').textContent = data.desc || '';
        document.getElementById('pd-detail-owner').textContent = `by ${data.username}`;

        pdActiveDeckData = data;
        _pdSyncViewToggle(!!data.edition_locked);
        renderPublicDeckSections(data);

        // Priced total — Edition Locked decks only (an unlocked deck pins no
        // real printings). The value is from the deck's stored rows, so it's
        // the same number regardless of the viewer's Locked/Unlocked toggle.
        const valEl2 = document.getElementById('pd-detail-value');
        if (valEl2) valEl2.classList.toggle('hidden', !data.edition_locked);
        if (data.edition_locked) {
            loadDeckValue(
                valEl2,
                `/api/decks/public/${encodeURIComponent(omnidexId)}/${encodeURIComponent(deckName)}/value`,
            );
        }
    } catch {
        if (grid) grid.innerHTML = '<p class="dga-loading">Failed to load deck.</p>';
    }
}

function closePublicDeckDetail() {
    pdActiveDeck = null;
    pdActiveDeckData = null;
    document.getElementById('pd-detail-view').classList.add('hidden');
    document.getElementById('pd-list-view').classList.remove('hidden');
    window.history.pushState({}, '', '/decks');
}

// Show the pill only when the owner curated printings (edition_locked); default
// the viewer's mode to match the deck, so they first see it as the owner built it.
function _pdSyncViewToggle(deckLocked) {
    const toggle = document.getElementById('pd-edition-view-toggle');
    if (!toggle) return;
    toggle.classList.toggle('hidden', !deckLocked);
    pdViewLocked = deckLocked;
    _pdPaintViewToggle();
}

function _pdPaintViewToggle() {
    const toggle = document.getElementById('pd-edition-view-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('.pill-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', (btn.dataset.value === 'true') === pdViewLocked);
    });
    positionPillIndicator(toggle);
}

// Reader flips between the owner's exact editions/foils (Locked) and a
// collapsed bare-card view (Unlocked). Local only — re-renders from the
// payload already in hand, no refetch.
function setPdEditionView(locked) {
    if (locked === pdViewLocked) return;
    pdViewLocked = locked;
    _pdPaintViewToggle();
    if (pdActiveDeckData) renderPublicDeckSections(pdActiveDeckData);
}

// Groups a section's rows by card_id, preserving first-seen order — same
// helper as decks_ga.js's _dgaGroupCardsByCardId, duplicated per this file's
// existing split from decks_ga.js (no shared module between them).
function _pdGroupCardsByCardId(cards) {
    const order = [];
    const byId = new Map();
    for (const row of cards) {
        if (!byId.has(row.card_id)) {
            byId.set(row.card_id, []);
            order.push(row.card_id);
        }
        byId.get(row.card_id).push(row);
    }
    return order.map(cardId => byId.get(cardId));
}

function renderPublicDeckSections(deckData) {
    const grid = document.getElementById('pd-card-grid');
    const sections = deckData.sections || {};
    const nameMap = deckData.name_map || {};
    const editionMap = deckData.edition_map || {};
    const editionsInfo = deckData.editions_info || {};
    const foilsInfo = deckData.foils_info || {};
    // {card_id: {edition_id: {foil_id: {price, lowest_listing}}}} — server sends
    // it only for Edition Locked decks (see api_public_deck_get). Only tiles
    // that pin a printing (Locked view) resolve an entry from it.
    const cardPrices = deckData.card_prices || {};
    // Viewer's toggle, not the deck's stored flag — see setPdEditionView.
    const editionLocked = pdViewLocked;

    let totalUnique = 0, totalQty = 0;
    for (const cards of Object.values(sections)) {
        totalUnique += editionLocked ? cards.length : new Set(cards.map(r => r.card_id)).size;
        for (const row of cards) totalQty += row.quantity;
    }
    document.getElementById('pd-detail-counts').textContent = `${totalUnique} unique · ${totalQty} total`;

    grid.innerHTML = '';

    if (Object.keys(sections).length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dga-sections-empty';
        empty.innerHTML = `<span class="inv-empty-icon">⬡</span><p>This deck is empty.</p>`;
        grid.appendChild(empty);
        return;
    }

    for (const [sectionName, cards] of Object.entries(sections)) {
        const block = document.createElement('div');
        block.className = 'dga-section-block';

        const sectionQty = cards.reduce((s, row) => s + row.quantity, 0);
        const header = document.createElement('div');
        header.className = 'dga-section-header';
        header.innerHTML = `
            <span class="dga-section-label label">${sectionName}</span>
            <span class="dga-section-count">${sectionQty} card${sectionQty !== 1 ? 's' : ''}</span>`;
        block.appendChild(header);

        const sectionGrid = document.createElement('div');
        sectionGrid.className = 'dga-section-grid';

        // Locked: one tile per row (a card_id may have several, split
        // across printings). Unlocked: one tile per card_id, collapsing
        // its rows together (summed quantity, a random printing among them
        // for the thumbnail, no foil badge) — same rule as the owner view.
        if (editionLocked) {
            cards.forEach((row, i) => {
                const cardName = nameMap[row.card_id] || row.card_id;
                const displayEditionId = row.edition_id || editionMap[row.card_id] || null;
                sectionGrid.appendChild(buildPublicCardTile(
                    row.card_id, cardName, displayEditionId, row.quantity, i, cards.length,
                    row.edition_id || null, row.foil_id || null, editionsInfo, foilsInfo, cardPrices,
                ));
            });
        } else {
            const groups = _pdGroupCardsByCardId(cards);
            groups.forEach((rows, i) => {
                const cardId = rows[0].card_id;
                const cardName = nameMap[cardId] || cardId;
                const qty = rows.reduce((s, r) => s + r.quantity, 0);
                // Unlocked means editions don't matter for display either —
                // always a random printing from the card's full catalog
                // (edition_map, server-side _pick_edition), regardless of
                // which printing(s) got randomly assigned to the row(s)
                // themselves when they were added.
                const displayEditionId = editionMap[cardId] || null;
                sectionGrid.appendChild(buildPublicCardTile(
                    cardId, cardName, displayEditionId, qty, i, groups.length,
                    null, null, editionsInfo, foilsInfo, cardPrices,
                ));
            });
        }

        block.appendChild(sectionGrid);
        grid.appendChild(block);
    }
}

// Foil/curio indicator for a tile that pins a specific printing — duplicated
// from decks_ga.js's own _dgaFoilBadgeEmoji, same rationale as the rest of
// this file's split from decks_ga.js: no shared module between them.
const PD_ALWAYS_FOIL_RARITIES = new Set([7, 8, 9]);
function _pdFoilBadgeEmoji(rarity, kind) {
    if (PD_ALWAYS_FOIL_RARITIES.has(rarity)) return '';
    const k = (kind || '').toLowerCase();
    if (k === 'nonfoil' || k === '') return '';
    return k === 'foil' ? '⭐' : '💎';
}

function buildPublicCardTile(card_id, cardName, editionId, qty, index, total,
                              rowEditionId = null, rowFoilId = null, editionsInfo = {}, foilsInfo = {}, cardPrices = {}) {
    const tile = document.createElement('div');
    tile.className = 'dga-card-tile inv-card-tile tile-hoverable';
    const delay = total <= 1 ? 0 : Math.min(index * 40, Math.round((index / (total - 1)) * 600));
    tile.style.animationDelay = `${delay}ms`;

    const imgSrc = editionId ? `/images/${editionId}.jpg` : '';
    const foilEmoji = rowEditionId
        ? _pdFoilBadgeEmoji(editionsInfo[rowEditionId]?.rarity, foilsInfo[rowFoilId]?.kind)
        : '';

    // Sale / listing badges (priceBadgesHTML, tiles.js) — only a pinned printing
    // in the Locked view resolves an entry, so the Unlocked view shows none.
    const priceEntry = rowEditionId ? cardPrices[card_id]?.[rowEditionId]?.[rowFoilId] : undefined;
    const priceBadges = priceEntry ? priceBadgesHTML(priceEntry.price, priceEntry.lowest_listing) : '';

    tile.innerHTML = `
        <div class="edition-tile-wrap tile-zoom">
            ${imgSrc ? `<div class="tile-img-spinner">${TILE_SPINNER_SVG}</div>` : ''}
            <img class="${imgSrc ? '' : 'tile-img-loaded'}" alt="${cardName}"
                onload="revealTileImage(this)"
                onerror="this.style.opacity='0.1'; revealTileImage(this)">
            <div class="card-tile-dim"></div>
        </div>
        ${priceBadges}
        <span class="inv-qty-badge">x${qty}</span>
        ${foilEmoji ? `<span class="dga-foil-badge">${foilEmoji}</span>` : ''}
        <div class="inv-card-tile-overlay">
            <div class="inv-card-tile-info">
                <div class="dga-card-tile-name">${cardName}</div>
            </div>
        </div>`;

    if (imgSrc) queueTileImageLoad(tile.querySelector('.edition-tile-wrap img'), imgSrc);

    tile.onclick = () => openCardDrawer(card_id, editionId, cardName);

    return tile;
}

window.initDecks = async function () {
    await loadPublicDecks();

    const urlParams = new URLSearchParams(window.location.search);
    const omnidexId = urlParams.get('omni');
    const deckName = urlParams.get('deck');
    if (omnidexId && deckName) {
        await openPublicDeckDetail(omnidexId, deckName, false);
    }
};

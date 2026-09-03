// ═══════════════════════════════════════
// PUBLIC DECKS PAGE (read-only browse of every deck marked public)
// ═══════════════════════════════════════

let pdDecks = [];
let pdActiveDeck = null; // {username, name}

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

    tile.innerHTML = `
        <div class="dga-tile-icon">⬡</div>
        <div class="dga-tile-name">${deck.name}${fmt}</div>
        <div class="pd-tile-owner">by ${deck.username}</div>
        <div class="dga-tile-desc">${deck.desc || ''}</div>
        <div class="dga-tile-meta">${count} card${count !== 1 ? 's' : ''}</div>`;

    if (deck.banner) {
        tile.classList.add('has-banner');
        const bg = document.createElement('div');
        bg.className = 'dga-tile-banner';
        bg.style.backgroundImage = `url('/images/${encodeURIComponent(deck.banner)}.jpg')`;
        tile.prepend(bg);
    }

    tile.onclick = () => openPublicDeckDetail(deck.username, deck.name);
    return tile;
}

async function openPublicDeckDetail(username, deckName, pushUrl = true) {
    pdActiveDeck = {username, name: deckName};

    document.getElementById('pd-list-view').classList.add('hidden');
    document.getElementById('pd-detail-view').classList.remove('hidden');

    document.getElementById('pd-detail-name').textContent = deckName;
    document.getElementById('pd-detail-owner').textContent = `by ${username}`;

    const grid = document.getElementById('pd-card-grid');
    if (grid) grid.innerHTML = '<p class="dga-loading">Loading...</p>';

    if (pushUrl) {
        window.history.pushState({}, '', `/decks?user=${encodeURIComponent(username)}&deck=${encodeURIComponent(deckName)}`);
    }

    try {
        const res = await fetch(`/api/decks/public/${encodeURIComponent(username)}/${encodeURIComponent(deckName)}`);
        if (!res.ok) throw new Error();
        const data = await res.json();

        document.getElementById('pd-detail-format').textContent = data.format ? `[${data.format}]` : '';
        document.getElementById('pd-detail-desc').textContent = data.desc || '';

        renderPublicDeckSections(data);
    } catch {
        if (grid) grid.innerHTML = '<p class="dga-loading">Failed to load deck.</p>';
    }
}

function closePublicDeckDetail() {
    pdActiveDeck = null;
    document.getElementById('pd-detail-view').classList.add('hidden');
    document.getElementById('pd-list-view').classList.remove('hidden');
    window.history.pushState({}, '', '/decks');
}

function renderPublicDeckSections(deckData) {
    const grid = document.getElementById('pd-card-grid');
    const sections = deckData.sections || {};
    const nameMap = deckData.name_map || {};
    const editionMap = deckData.edition_map || {};

    let totalUnique = 0, totalQty = 0;
    for (const cards of Object.values(sections)) {
        for (const qty of Object.values(cards)) {
            totalUnique++;
            totalQty += qty;
        }
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

        const sectionQty = Object.values(cards).reduce((s, q) => s + q, 0);
        const header = document.createElement('div');
        header.className = 'dga-section-header';
        header.innerHTML = `
            <span class="dga-section-label label">${sectionName}</span>
            <span class="dga-section-count">${sectionQty} card${sectionQty !== 1 ? 's' : ''}</span>`;
        block.appendChild(header);

        const sectionGrid = document.createElement('div');
        sectionGrid.className = 'dga-section-grid';

        Object.entries(cards).forEach(([card_id, qty], i) => {
            const cardName = nameMap[card_id] || card_id;
            const editionId = editionMap[card_id] || null;
            sectionGrid.appendChild(buildPublicCardTile(card_id, cardName, editionId, qty, i, Object.keys(cards).length));
        });

        block.appendChild(sectionGrid);
        grid.appendChild(block);
    }
}

function buildPublicCardTile(card_id, cardName, editionId, qty, index, total) {
    const tile = document.createElement('div');
    tile.className = 'dga-card-tile inv-card-tile tile-hoverable';
    const delay = total <= 1 ? 0 : Math.min(index * 40, Math.round((index / (total - 1)) * 600));
    tile.style.animationDelay = `${delay}ms`;

    const imgSrc = editionId ? `/images/${editionId}.jpg` : '';

    tile.innerHTML = `
        <div class="edition-tile-wrap tile-zoom">
            ${imgSrc ? `<div class="tile-img-spinner">${TILE_SPINNER_SVG}</div>` : ''}
            <img class="${imgSrc ? '' : 'tile-img-loaded'}" alt="${cardName}"
                onload="revealTileImage(this)"
                onerror="this.style.opacity='0.1'; revealTileImage(this)">
            <div class="card-tile-dim"></div>
        </div>
        <span class="inv-qty-badge">x${qty}</span>
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
    const username = urlParams.get('user');
    const deckName = urlParams.get('deck');
    if (username && deckName) {
        await openPublicDeckDetail(username, deckName, false);
    }
};

// ── State ──
let gaDecks = {};         // index: { deckName: { desc, format, created } }
let activeDeck = null;    // currently open deck name
let activeDeckData = null; // full deck JSON { desc, format, cards: {} }

// ═══════════════════════════════════════
// LOAD & RENDER DECK LIST
// ═══════════════════════════════════════

async function loadMyDecks() {
    try {
        const res = await fetch('/api/decks');
        if (!res.ok) return;
        const data = await res.json();
        gaDecks = data.decks || {};
        renderDeckGrid();
    } catch {
        console.error('Failed to load decks');
    }
}

function renderDeckGrid() {
    const grid = document.getElementById('dga-deck-grid');
    const subtitle = document.getElementById('dga-subtitle');
    if (!grid) return;

    const names = Object.keys(gaDecks);
    const total = names.reduce((sum, n) => sum + countDeckCards(gaDecks[n].card_count || 0), 0);
    subtitle.textContent = `${names.length} deck${names.length !== 1 ? 's' : ''}`;

    grid.innerHTML = '';
    names.forEach((name, i) => grid.appendChild(buildDeckTile(name, gaDecks[name], i, names.length)));

    const createTile = document.createElement('div');
    createTile.className = 'dga-deck-create';
    createTile.style.animationDelay = `${Math.min(names.length * 50, 400)}ms`;
    createTile.innerHTML = `<span class="dga-create-plus">+</span><span class="dga-create-label">New Deck</span>`;
    createTile.onclick = openCreateDeckModal;
    grid.appendChild(createTile);
}

function countDeckCards(n) {
    return typeof n === 'number' ? n : 0;
}

function buildDeckTile(name, entry, index, total) {
    const tile = document.createElement('div');
    tile.className = 'dga-deck-tile';
    const delay = total <= 1 ? 0 : Math.min(index * 50, Math.round((index / (total - 1)) * 400));
    tile.style.animationDelay = `${delay}ms`;

    const fmt = entry.format ? `<span class="dga-tile-format">${entry.format}</span>` : '';
    const desc = entry.desc ? `<div class="dga-tile-desc">${entry.desc}</div>` : '';
    const count = entry.card_count || 0;

    tile.innerHTML = `
        <div class="dga-tile-icon">🃏</div>
        <div class="dga-tile-name">${name}${fmt}</div>
        ${desc}
        <div class="dga-tile-meta">${count} card${count !== 1 ? 's' : ''} · ${entry.created || ''}</div>`;

    tile.onclick = () => openDeckDetail(name);
    return tile;
}

// ═══════════════════════════════════════
// DECK DETAIL
// ═══════════════════════════════════════

async function openDeckDetail(deckName, pushUrl = true) {
    activeDeck = deckName;
    activeDeckData = null;

    document.getElementById('dga-list-view').classList.add('hidden');
    document.getElementById('dga-detail-view').classList.remove('hidden');

    const entry = gaDecks[deckName] || {};
    document.getElementById('dga-detail-name').textContent = deckName;
    document.getElementById('dga-detail-format').textContent = entry.format ? `[${entry.format}]` : '';
    document.getElementById('dga-detail-desc').textContent = entry.desc || '';

    const grid = document.getElementById('dga-card-grid');
    if (grid) grid.innerHTML = '<p class="dga-loading">Loading...</p>';

    if (pushUrl) window.history.pushState({}, '', `/decks_ga?deck=${encodeURIComponent(deckName)}`);

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(deckName)}`);
        if (!res.ok) throw new Error('Failed to load deck');
        activeDeckData = await res.json();
        await enrichAndRenderDeckCards(activeDeckData.cards || {});
    } catch {
        if (grid) grid.innerHTML = '<p class="dga-loading">Failed to load deck.</p>';
    }
}

function closeDeckDetail() {
    activeDeck = null;
    activeDeckData = null;
    document.getElementById('dga-detail-view').classList.add('hidden');
    document.getElementById('dga-list-view').classList.remove('hidden');
    window.history.pushState({}, '', '/decks_ga');
    renderDeckGrid();
}

const rarityMapDga = {1: "C", 2: "U", 3: "R", 4: "SR", 5: "UR", 6: "PR", 7: "CSR", 8: "CUR", 9: "CPR"};
const ALWAYS_FOIL_RARITIES_DGA = new Set([7, 8, 9]);

function getFoilSuffixDga(row) {
    if (ALWAYS_FOIL_RARITIES_DGA.has(row.rarity)) return '';
    const kind = row.foilKindRaw || '';
    if (kind === 'nonfoil' || kind === '') return '';
    if (kind === 'foil') return '⭐';
    return '💎';
}

async function enrichAndRenderDeckCards(cards) {
    const rows = [];

    if (Object.keys(cards).length === 0) {
        renderDeckCardGrid([]);
        return;
    }

    try {
        const [infoRes, slugRes, collectorRes] = await Promise.all([
            fetch('/api/inv/info'),
            fetch('/api/inv/slugs'),
            fetch('/api/inv/collector')
        ]);
        const infoData = infoRes.ok ? await infoRes.json() : {};
        const slugData = slugRes.ok ? await slugRes.json() : {};
        const collectorData = collectorRes.ok ? await collectorRes.json() : {};

        for (const [card_id, editions] of Object.entries(cards)) {
            const cardInfo = infoData[card_id] || {};
            const slugEntry = Object.values(slugData).find(v => v.card_id === card_id);
            const cardName = slugEntry?.name || card_id;

            for (const [edition_id, foils] of Object.entries(editions)) {
                const editionInfo = cardInfo.editions?.[edition_id] || {};
                const foilsData = editionInfo.foils || {};

                for (const [foil_id, quantity] of Object.entries(foils)) {
                    let foilKind = 'Standard';
                    let foilKindRaw = '';
                    if (foilsData[foil_id]) {
                        foilKindRaw = foilsData[foil_id].kind || '';
                        foilKind = (typeof toFoilLabel === 'function' ? toFoilLabel(foilKindRaw) : foilKindRaw) || 'Standard';
                    } else {
                        for (const finfo of Object.values(foilsData)) {
                            if (finfo.variants?.[foil_id]) {
                                foilKindRaw = finfo.variants[foil_id].kind || '';
                                foilKind = (typeof toFoilLabel === 'function' ? toFoilLabel(foilKindRaw) : foilKindRaw) || 'Variant';
                                break;
                            }
                        }
                    }
                    rows.push({
                        card_id, edition_id, foil_id, quantity,
                        cardName,
                        setPrefix: editionInfo.set_prefix || '',
                        rarity: editionInfo.rarity,
                        foilKind,
                        foilKindRaw: foilKindRaw.toLowerCase(),
                        element: cardInfo.element || '',
                        collectorNumber: collectorData[edition_id] || ''
                    });
                }
            }
        }
    } catch {
        console.error('Failed to enrich deck cards');
    }

    renderDeckCardGrid(rows);
}

function renderDeckCardGrid(rows) {
    const grid = document.getElementById('dga-card-grid');
    if (!grid) return;

    if (!rows.length) {
        grid.innerHTML = '<p class="dga-loading">No cards in this deck yet.</p>';
        return;
    }

    grid.innerHTML = '';
    rows.forEach((row, i) => grid.appendChild(buildDeckCardTile(row, i, rows.length)));
}

function buildDeckCardTile(row, index, total = 1) {
    const rarity = rarityMapDga[row.rarity] || '';
    const rarityClass = rarity ? `rarity-${rarity.toLowerCase()}` : '';

    const tile = document.createElement('div');
    tile.className = 'dga-card-tile';
    const maxDelay = 600;
    const delay = total <= 1 ? 0 : Math.min(index * 40, Math.round((index / (total - 1)) * maxDelay));
    tile.style.animationDelay = `${delay}ms`;
    tile.dataset.cardId = row.card_id;
    tile.dataset.editionId = row.edition_id;
    tile.dataset.foilId = row.foil_id;

    tile.innerHTML = `
        <div class="edition-tile-wrap">
            <img src="/images/${row.edition_id}.jpg" alt="${row.cardName}"
                onerror="this.style.opacity='0.1'">
            <div class="card-tile-dim"></div>
            ${rarity ? `<span class="edition-rarity-badge ${rarityClass}${getFoilSuffixDga(row) ? ' has-foil-suffix' : ''}">${rarity}${getFoilSuffixDga(row)}</span>` : ''}
        </div>
        <span class="dga-qty-badge">x${row.quantity}</span>
        <div class="dga-card-tile-overlay">
            <div class="dga-card-tile-info">
                <div class="dga-card-tile-name">${row.cardName}</div>
                <div class="dga-card-tile-foil">${row.foilKind}</div>
            </div>
        </div>`;

    tile.addEventListener('animationend', () => tile.classList.add('animated'));
    return tile;
}

// ═══════════════════════════════════════
// CREATE DECK MODAL
// ═══════════════════════════════════════

function openCreateDeckModal() {
    document.getElementById('dga-create-name').value = '';
    document.getElementById('dga-create-format').value = '';
    document.getElementById('dga-create-desc').value = '';
    document.getElementById('dga-create-error').classList.add('hidden');
    document.getElementById('dga-create-modal').classList.remove('hidden');
    document.getElementById('dga-create-name').focus();
}

function closeCreateDeckModal() {
    document.getElementById('dga-create-modal').classList.add('hidden');
}

async function submitCreateDeck() {
    const name = document.getElementById('dga-create-name').value.trim();
    const format = document.getElementById('dga-create-format').value.trim();
    const desc = document.getElementById('dga-create-desc').value.trim();
    const errEl = document.getElementById('dga-create-error');

    if (!name) {
        errEl.textContent = 'Deck name is required.';
        errEl.classList.remove('hidden');
        return;
    }

    if (gaDecks[name]) {
        errEl.textContent = 'A deck with that name already exists.';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch('/api/decks', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name, format, desc})
        });

        if (!res.ok) {
            const data = await res.json();
            errEl.textContent = data.error || 'Failed to create deck.';
            errEl.classList.remove('hidden');
            return;
        }

        const data = await res.json();
        gaDecks[name] = {desc, format, created: data.created || '', card_count: 0};
        closeCreateDeckModal();
        renderDeckGrid();
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

// ═══════════════════════════════════════
// DECK SETTINGS MODAL
// ═══════════════════════════════════════

function openDeckSettingsModal() {
    if (!activeDeck) return;
    const entry = gaDecks[activeDeck] || {};
    document.getElementById('dga-settings-name').value = activeDeck;
    document.getElementById('dga-settings-format').value = entry.format || '';
    document.getElementById('dga-settings-desc').value = entry.desc || '';
    document.getElementById('dga-settings-error').classList.add('hidden');
    document.getElementById('dga-settings-modal').classList.remove('hidden');
}

function closeDeckSettingsModal() {
    document.getElementById('dga-settings-modal').classList.add('hidden');
}

async function submitDeckSettings() {
    const newName = document.getElementById('dga-settings-name').value.trim();
    const format = document.getElementById('dga-settings-format').value.trim();
    const desc = document.getElementById('dga-settings-desc').value.trim();
    const errEl = document.getElementById('dga-settings-error');

    if (!newName) {
        errEl.textContent = 'Deck name is required.';
        errEl.classList.remove('hidden');
        return;
    }

    if (newName !== activeDeck && gaDecks[newName]) {
        errEl.textContent = 'A deck with that name already exists.';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: newName, format, desc})
        });

        if (!res.ok) {
            const data = await res.json();
            errEl.textContent = data.error || 'Failed to update deck.';
            errEl.classList.remove('hidden');
            return;
        }

        // Update local state
        const existing = gaDecks[activeDeck];
        delete gaDecks[activeDeck];
        gaDecks[newName] = {...existing, format, desc};

        const oldName = activeDeck;
        activeDeck = newName;

        document.getElementById('dga-detail-name').textContent = newName;
        document.getElementById('dga-detail-format').textContent = format ? `[${format}]` : '';
        document.getElementById('dga-detail-desc').textContent = desc;

        if (oldName !== newName) {
            window.history.replaceState({}, '', `/decks_ga?deck=${encodeURIComponent(newName)}`);
        }

        closeDeckSettingsModal();
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

async function submitDeleteDeck() {
    if (!activeDeck) return;
    const confirm = window.confirm(`Delete deck "${activeDeck}"? This cannot be undone.`);
    if (!confirm) return;

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}`, {method: 'DELETE'});
        if (!res.ok) throw new Error('Delete failed');
        delete gaDecks[activeDeck];
        closeDeckSettingsModal();
        closeDeckDetail();
    } catch {
        document.getElementById('dga-settings-error').textContent = 'Failed to delete deck.';
        document.getElementById('dga-settings-error').classList.remove('hidden');
    }
}

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

window.initDecksGa = async function () {
    if (!currentUser) return;
    await loadMyDecks();

    // Restore deck from URL params
    const urlParams = new URLSearchParams(window.location.search);
    const deckName = urlParams.get('deck');
    if (deckName && gaDecks[deckName]) {
        await openDeckDetail(deckName, false);
    }
};
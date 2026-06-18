// ── State ──
let gaDecks = {};         // index: { deckName: { desc, format, created } }
let activeDeck = null;    // currently open deck name
let activeDeckData = null; // full deck JSON { desc, format, cards: {} }

// ── Add card modal state ──
let dgaAddModalCardId = null;
let dgaAddModalCardData = null;
let dgaAddModalEditionId = null;
let dgaAddModalFoilId = null;
let dgaAddAcIndex = -1;

// ═══════════════════════════════════════
// FORMAT DROPDOWN — mirrors set-dropdown / cards-filter-btn rotating-arrow style
// ═══════════════════════════════════════

function toggleDgaFormatDropdown(scope) {
    const menu = document.getElementById(`dga-${scope}-format-menu`);
    const btn = document.getElementById(`dga-${scope}-format-btn`);
    const isOpen = !menu.classList.contains('hidden');
    if (isOpen) {
        menu.classList.add('hidden');
        btn.classList.remove('open');
    } else {
        // Close any other open format dropdown first
        document.querySelectorAll('.dga-fmt-dropdown-menu').forEach(m => m.classList.add('hidden'));
        document.querySelectorAll('.dga-fmt-dropdown-btn').forEach(b => b.classList.remove('open'));
        menu.classList.remove('hidden');
        btn.classList.add('open');
    }
}

function closeDgaFormatDropdown(scope) {
    const menu = document.getElementById(`dga-${scope}-format-menu`);
    const btn = document.getElementById(`dga-${scope}-format-btn`);
    if (menu) menu.classList.add('hidden');
    if (btn) btn.classList.remove('open');
}

function selectDgaFormat(scope, value, label) {
    document.getElementById(`dga-${scope}-format`).value = value;
    document.getElementById(`dga-${scope}-format-label`).textContent = label;
    document.querySelectorAll(`#dga-${scope}-format-menu .dga-fmt-dropdown-option`).forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.value === value);
    });
    closeDgaFormatDropdown(scope);
}

function setDgaFormatValue(scope, value) {
    const labels = {'': 'None', 'Standard': 'Standard', 'Draft': 'Draft', 'Pantheon': 'Pantheon'};
    selectDgaFormat(scope, value, labels[value] || 'None');
}

document.addEventListener('click', e => {
    if (!e.target.closest('.dga-fmt-dropdown-wrap')) {
        closeDgaFormatDropdown('create');
        closeDgaFormatDropdown('settings');
    }
}, true);

document.addEventListener('click', e => {
    const opt = e.target.closest('.dga-fmt-dropdown-option');
    if (!opt) return;
    const menu = opt.closest('.dga-fmt-dropdown-menu');
    const scope = menu.id.includes('create') ? 'create' : 'settings';
    selectDgaFormat(scope, opt.dataset.value, opt.textContent);
});

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
    const countEl = document.getElementById('dga-detail-counts');
    if (countEl) countEl.textContent = '';

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

    updateDeckCounts(rows);

    grid.innerHTML = '';

    if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'inv-empty-grid';
        empty.innerHTML = `<span class="inv-empty-icon">⬡</span><p>No cards in this deck yet.</p><p class="inv-empty-sub">Click the + tile to add cards.</p>`;
        grid.appendChild(empty);
    } else {
        rows.forEach((row, i) => grid.appendChild(buildDeckCardTile(row, i, rows.length)));
    }

    const addTile = document.createElement('div');
    addTile.className = 'inv-card-add-tile';
    addTile.style.animationDelay = `${Math.min(rows.length * 40, 640)}ms`;
    addTile.innerHTML = `<span class="inv-create-plus">+</span><span class="inv-create-label">Add Card</span>`;
    addTile.onclick = openDeckAddModal;
    grid.appendChild(addTile);
}

function updateDeckCounts(rows) {
    const totalQty = rows.reduce((s, r) => s + r.quantity, 0);
    const countEl = document.getElementById('dga-detail-counts');
    if (countEl) countEl.textContent = `${rows.length} card${rows.length !== 1 ? 's' : ''} · ${totalQty} cop${totalQty !== 1 ? 'ies' : 'y'}`;
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
    setDgaFormatValue('create', '');
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
    setDgaFormatValue('settings', entry.format || '');
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
    if (!confirm(`Delete deck "${activeDeck}"? Cards inside will be removed.`)) return;

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
// ADD CARD MODAL (mirrors inventory's add-card flow)
// ═══════════════════════════════════════

function openDeckAddModal() {
    dgaAddModalCardId = null;
    dgaAddModalCardData = null;
    dgaAddModalEditionId = null;
    dgaAddModalFoilId = null;
    document.getElementById('dga-add-card-search').value = '';
    const _res = document.getElementById('dga-add-card-results');
    if (_res) {
        _res.style.gridTemplateColumns = '';
        _res.classList.remove('has-scroll');
    }
    document.getElementById('dga-add-card-results').innerHTML = `<div class="inv-search-placeholder" style="padding:30px 0"><span class="inv-empty-icon">⬡</span><p>Search for a card to add it.</p></div>`;
    document.getElementById('dga-add-step-search').classList.remove('hidden');
    document.getElementById('dga-add-step-foil').classList.add('hidden');
    document.getElementById('dga-add-back-btn').classList.add('hidden');
    document.querySelector('#dga-add-modal .inv-modal-wide').classList.remove('inv-modal-foil-step');
    document.getElementById('dga-add-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('dga-add-card-search').focus(), 60);
}

function closeDeckAddModal() {
    document.getElementById('dga-add-modal').classList.add('hidden');
    hideDgaAddAc();
    const btn = document.getElementById('dga-add-modal-submit');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Add to Deck';
    }
}

function dgaBackToSearch() {
    document.getElementById('dga-add-step-foil').classList.add('hidden');
    document.getElementById('dga-add-step-search').classList.remove('hidden');
    document.getElementById('dga-add-back-btn').classList.add('hidden');
    document.querySelector('#dga-add-modal .inv-modal-wide').classList.remove('inv-modal-foil-step');
    dgaAddModalCardId = null;
    dgaAddModalCardData = null;
    dgaAddModalEditionId = null;
    dgaAddModalFoilId = null;
    const results = document.getElementById('dga-add-card-results');
    const tileCount = results ? results.querySelectorAll('.inv-search-tile').length : 0;
    if (tileCount > 0) {
        const cols = Math.min(tileCount, 5);
        if (results) results.style.gridTemplateColumns = `repeat(${cols}, 255px)`;
    }
    setTimeout(() => document.getElementById('dga-add-card-search').focus(), 40);
}

async function searchDgaAddCards() {
    const query = document.getElementById('dga-add-card-search')?.value?.trim();
    const results = document.getElementById('dga-add-card-results');
    if (!results || !query) return;

    results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Searching...</p></div>`;

    try {
        const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        results.innerHTML = '';

        if (!data.cards?.length) {
            results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>${data.message || 'No cards found.'}</p></div>`;
            return;
        }

        const cols = Math.min(data.cards.length, 5);
        results.style.gridTemplateColumns = `repeat(${cols}, 255px)`;
        results.classList.toggle('has-scroll', data.cards.length >= 6);

        const uniqueIds = new Set(data.cards.map(c => c.card_id));
        if (uniqueIds.size === 1) {
            const card = data.cards[0];
            await dgaGoToFoilStep(card.card_id, card.edition_id, card.name);
            return;
        }

        data.cards.forEach((card, i) => {
            const rarity = rarityMapDga[card.rarity] || '';
            const rarityClass = rarity ? `rarity-${rarity.toLowerCase()}` : '';
            const tile = document.createElement('div');
            tile.className = 'inv-search-tile';
            tile.style.animationDelay = `${Math.min(i, 20) * 30}ms`;
            tile.innerHTML = `
                <div class="edition-tile-wrap">
                    <img src="/images/${card.edition_id}.jpg" alt="${card.name}">
                    <div class="inv-search-tile-overlay">＋</div>
                </div>`;
            tile.onclick = () => dgaGoToFoilStep(card.card_id, card.edition_id, card.name);
            tile.addEventListener('animationend', () => tile.classList.add('animated'));
            results.appendChild(tile);
        });
    } catch {
        results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Search failed.</p></div>`;
    }
}

async function dgaGoToFoilStep(cardId, editionId, cardName) {
    dgaAddModalCardId = cardId;

    document.getElementById('dga-add-modal-name').textContent = cardName;
    document.getElementById('dga-add-modal-set').textContent = '';
    document.getElementById('dga-add-modal-img').src = `/images/${editionId}.jpg`;
    document.getElementById('dga-add-modal-foils').innerHTML = '<div style="font-size:0.78rem;color:var(--text-muted);">Loading...</div>';
    const qtyEl = document.getElementById('dga-add-modal-qty');
    qtyEl.value = 1;
    if (typeof scaleQtyFont === 'function') scaleQtyFont(qtyEl);
    document.getElementById('dga-add-modal-submit').disabled = true;

    document.getElementById('dga-add-step-search').classList.add('hidden');
    document.getElementById('dga-add-step-foil').classList.remove('hidden');
    document.getElementById('dga-add-back-btn').classList.remove('hidden');
    document.querySelector('#dga-add-modal .inv-modal-wide').classList.add('inv-modal-foil-step');

    try {
        const res = await fetch(`/api/cards/${cardId}`);
        const data = await res.json();
        dgaAddModalCardData = data.card;

        const editions = Object.entries(dgaAddModalCardData.editions || {}).sort((a, b) => {
            const parseNum = s => {
                const m = (s || 'ZZZ').match(/^(\d+)([A-Z]*)$/i);
                return m ? [parseInt(m[1]), m[2] || ''] : [Infinity, s];
            };
            const [nA, sA] = parseNum(a[1].collector_number);
            const [nB, sB] = parseNum(b[1].collector_number);
            return nA !== nB ? nA - nB : sA.localeCompare(sB);
        });

        const foilList = document.getElementById('dga-add-modal-foils');
        foilList.innerHTML = '';
        let firstOpt = null;

        editions.forEach(([eid, einfo]) => {
            const rarity = rarityMapDga[einfo.rarity] || '?';
            Object.entries(einfo.foils || {}).forEach(([fid, finfo]) => {
                const opt = dgaBuildFoilOption(eid, fid, finfo.kind, einfo.set_prefix, rarity, einfo.collector_number, false);
                if (!firstOpt) firstOpt = {opt, eid, fid};
                foilList.appendChild(opt);
                Object.entries(finfo.variants || {}).forEach(([vid, vinfo]) => {
                    const vopt = dgaBuildFoilOption(eid, vid, vinfo.kind, einfo.set_prefix, rarity, einfo.collector_number, true);
                    foilList.appendChild(vopt);
                });
            });
        });

        if (firstOpt) dgaSelectFoilOption(firstOpt.opt, firstOpt.eid, firstOpt.fid);
    } catch {
        document.getElementById('dga-add-modal-foils').innerHTML = '<div style="font-size:0.78rem;color:var(--error);">Failed to load editions.</div>';
    }
}

function dgaBuildFoilOption(editionId, foilId, kind, setPrefix, rarity, collectorNum, isVariant) {
    const label = kind ? kind.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'Standard';
    const opt = document.createElement('div');
    opt.className = 'inv-foil-option';
    opt.dataset.editionId = editionId;
    opt.dataset.foilId = foilId;
    opt.innerHTML = `
        <div class="inv-foil-left">
            <div class="inv-foil-name">${label}${isVariant ? ' <span style="opacity:0.5;font-size:0.85em">(variant)</span>' : ''}</div>
            <div class="inv-foil-meta">${setPrefix} · ${rarity} · #${collectorNum || '?'}</div>
        </div>
        <div class="inv-foil-check"></div>`;
    opt.onclick = () => dgaSelectFoilOption(opt, editionId, foilId);
    return opt;
}

function dgaSelectFoilOption(opt, editionId, foilId) {
    document.querySelectorAll('#dga-add-modal-foils .inv-foil-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    dgaAddModalEditionId = editionId;
    dgaAddModalFoilId = foilId;

    const einfo = dgaAddModalCardData?.editions?.[editionId];
    if (einfo) {
        document.getElementById('dga-add-modal-img').src = `/images/${editionId}.jpg`;
        document.getElementById('dga-add-modal-set').textContent = `${einfo.set_name || ''} (${einfo.set_prefix || ''}) — #${einfo.collector_number || '?'}`;
    }
    document.getElementById('dga-add-modal-submit').disabled = false;
}

function changeDgaAddQty(delta) {
    const input = document.getElementById('dga-add-modal-qty');
    input.value = Math.max(1, Math.min(999, (parseInt(input.value) || 1) + delta));
}

async function submitDgaAddCard() {
    if (!dgaAddModalCardId || !dgaAddModalEditionId || !dgaAddModalFoilId || !activeDeck) return;

    const quantity = parseInt(document.getElementById('dga-add-modal-qty').value) || 1;
    const btn = document.getElementById('dga-add-modal-submit');
    btn.disabled = true;
    btn.textContent = 'Adding...';

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                card_id: dgaAddModalCardId,
                edition_id: dgaAddModalEditionId,
                foil_id: dgaAddModalFoilId,
                quantity
            })
        });

        if (res.ok) {
            if (activeDeckData) {
                const cards = activeDeckData.cards;
                if (!cards[dgaAddModalCardId]) cards[dgaAddModalCardId] = {};
                if (!cards[dgaAddModalCardId][dgaAddModalEditionId]) cards[dgaAddModalCardId][dgaAddModalEditionId] = {};
                const existing = cards[dgaAddModalCardId][dgaAddModalEditionId][dgaAddModalFoilId] || 0;
                cards[dgaAddModalCardId][dgaAddModalEditionId][dgaAddModalFoilId] = existing + quantity;
            }

            closeDeckAddModal();
            await enrichAndRenderDeckCards(activeDeckData?.cards || {});

            // Keep deck list card_count in sync for when user returns to grid
            if (gaDecks[activeDeck]) {
                gaDecks[activeDeck].card_count = (gaDecks[activeDeck].card_count || 0) + quantity;
            }
        } else {
            btn.textContent = 'Error';
            setTimeout(() => {
                btn.textContent = 'Add to Deck';
                btn.disabled = false;
            }, 1500);
        }
    } catch {
        btn.textContent = 'Failed';
        setTimeout(() => {
            btn.textContent = 'Add to Deck';
            btn.disabled = false;
        }, 1500);
    }
}

// ── Autocomplete (deck add modal) ──

async function fetchDgaAddCardSuggestions(value) {
    const list = document.getElementById('dga-add-card-autocomplete');
    if (value.length < 2) {
        hideDgaAddAc();
        return;
    }
    try {
        const res = await fetch(`/api/cards/suggest?q=${encodeURIComponent(value)}`);
        const data = await res.json();
        if (!data.suggestions?.length) {
            hideDgaAddAc();
            return;
        }
        dgaAddAcIndex = -1;
        list.innerHTML = '';
        data.suggestions.forEach(name => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.textContent = name;
            item.onclick = () => {
                document.getElementById('dga-add-card-search').value = name;
                hideDgaAddAc();
                searchDgaAddCards();
            };
            list.appendChild(item);
        });
        list.classList.remove('hidden');
    } catch {
        hideDgaAddAc();
    }
}

function hideDgaAddAc() {
    const list = document.getElementById('dga-add-card-autocomplete');
    if (list) {
        list.classList.add('hidden');
        list.innerHTML = '';
    }
    dgaAddAcIndex = -1;
}

function handleDgaAddCardKeydown(e) {
    const list = document.getElementById('dga-add-card-autocomplete');
    const items = list?.querySelectorAll('.autocomplete-item') || [];
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        dgaAddAcIndex = Math.min(dgaAddAcIndex + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('selected', i === dgaAddAcIndex));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        dgaAddAcIndex = Math.max(dgaAddAcIndex - 1, -1);
        items.forEach((el, i) => el.classList.toggle('selected', i === dgaAddAcIndex));
    } else if (e.key === 'Enter') {
        if (dgaAddAcIndex >= 0 && items[dgaAddAcIndex]) {
            document.getElementById('dga-add-card-search').value = items[dgaAddAcIndex].textContent;
            hideDgaAddAc();
            searchDgaAddCards();
        } else {
            hideDgaAddAc();
            searchDgaAddCards();
        }
    } else if (e.key === 'Escape') {
        hideDgaAddAc();
        closeDeckAddModal();
    }
}

document.addEventListener('click', e => {
    if (!document.getElementById('dga-add-modal')) return;
    if (!e.target.closest('#dga-add-card-search') && !e.target.closest('#dga-add-card-autocomplete')) hideDgaAddAc();
}, true);

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
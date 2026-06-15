// ── State ──
let invBins = {};
let activeBin = null;
let binCardRows = [];
let addModalCardId = null;
let addModalCardData = null;
let addModalEditionId = null;
let addModalFoilId = null;
let cardModalRow = null;   // the row being edited in the card detail modal
let invAcIndex = -1;
let addAcIndex = -1;

const rarityMapInv = {1: "C", 2: "U", 3: "R", 4: "SR", 5: "UR", 6: "PR", 7: "CSR", 8: "CUR", 9: "CPR"};

// ── Quantity font scaling ──
function scaleQtyFont(input) {
    const len = String(input.value || '0').replace('-', '').length;
    const isTile = input.classList.contains('inv-tile-qty-input');
    if (isTile) {
        input.style.fontSize = len <= 3 ? '1.1rem' : len === 4 ? '0.85rem' : '0.7rem';
    } else {
        input.style.fontSize = len <= 3 ? '1rem' : len === 4 ? '0.8rem' : '0.65rem';
    }
}

function scaleIndicatorFont(box) {
    const text = box.textContent || '';
    const len = text.replace(/[^0-9]/g, '').length;
    box.style.fontSize = len <= 4 ? '1rem' : len === 5 ? '0.8rem' : '0.65rem';
}

// Watch for indicator box content changes (tiles.js sets innerHTML directly)
const _indicatorObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
        const box = m.target.querySelector('.inv-tile-qty-indicator-box');
        if (box) scaleIndicatorFont(box);
    }
});

function _observeIndicators() {
    document.querySelectorAll('.inv-tile-qty-indicator').forEach(ind => {
        _indicatorObserver.observe(ind, {childList: true, subtree: false});
    });
}

// Also observe the grid so newly added tiles get watched
const _gridObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
        m.addedNodes.forEach(node => {
            if (node.nodeType !== 1) return;
            node.querySelectorAll('.inv-tile-qty-indicator').forEach(ind => {
                _indicatorObserver.observe(ind, {childList: true, subtree: false});
            });
        });
    }
});

// ═══════════════════════════════════════
// LOAD & RENDER BINS
// ═══════════════════════════════════════

async function loadInventory() {
    try {
        const res = await fetch('/api/inventory');
        if (!res.ok) return;
        const data = await res.json();
        invBins = data.bins || {};
        renderBinGrid();
    } catch {
        console.error('Failed to load inventory');
    }
}

function renderBinGrid() {
    const grid = document.getElementById('inv-bins-grid');
    const subtitle = document.getElementById('inv-bin-subtitle');
    if (!grid) return;

    const binNames = Object.keys(invBins);
    const totalCards = binNames.reduce((sum, n) => sum + countBinEntries(invBins[n].cards || {}), 0);
    subtitle.textContent = `${binNames.length} bin${binNames.length !== 1 ? 's' : ''} · ${totalCards} card${totalCards !== 1 ? 's' : ''}`;

    const maxBinDelay = 400;
    grid.innerHTML = '';
    binNames.forEach((name, i) => grid.appendChild(buildBinTile(name, invBins[name], i, binNames.length)));

    const createTile = document.createElement('div');
    createTile.className = 'inv-bin-create';
    createTile.style.animationDelay = `${Math.min(binNames.length * 50, maxBinDelay)}ms`;
    createTile.innerHTML = `<span class="inv-create-plus">+</span><span class="inv-create-label">New Bin</span>`;
    createTile.onclick = openCreateModal;
    grid.appendChild(createTile);
}

function buildBinTile(name, bin, index, total = 1) {
    const count = countBinEntries(bin.cards || {});
    const tile = document.createElement('div');
    tile.className = `inv-bin-tile${bin.default ? ' default-bin' : ''}`;
    const maxDelay = 400;
    const delay = total <= 1 ? 0 : Math.min(index * 50, Math.round((index / (total - 1)) * maxDelay));
    tile.style.animationDelay = `${delay}ms`;
    tile.innerHTML = `
        <div class="inv-bin-icon-row">
            <span class="inv-bin-icon">${bin.default ? '📦' : '⬡'}</span>
            ${bin.default ? '<span class="inv-bin-default-badge">Default</span>' : ''}
        </div>
        <div class="inv-bin-name">${name}</div>
        <div class="inv-bin-desc">${bin.desc || ''}</div>
        <div class="inv-bin-meta">${count} card${count !== 1 ? 's' : ''}</div>`;
    tile.onclick = () => openBinDetail(name);
    tile.addEventListener('contextmenu', e => {
        e.preventDefault();
        openBinContextMenu(e, name);
    });
    return tile;
}

function countBinEntries(cards) {
    let total = 0;
    for (const editions of Object.values(cards))
        for (const foils of Object.values(editions))
            for (const qty of Object.values(foils))
                total += qty;
    return total;
}

// ═══════════════════════════════════════
// BIN DETAIL
// ═══════════════════════════════════════

async function openBinDetail(binName) {
    safeDiscardEditMode();
    activeBin = binName;
    binCardRows = [];
    const bin = invBins[binName];

    document.getElementById('inv-bins-view').classList.add('hidden');
    document.getElementById('inv-detail-view').classList.remove('hidden');

    document.getElementById('detail-bin-name').textContent = binName;
    document.getElementById('detail-bin-meta').textContent = bin.desc || '';
    document.getElementById('inv-card-filter').value = '';

    // Clear grid and reset filters when opening a new bin
    binFilters.set = '';
    binFilters.element = '';
    binFilters.rarity = '';
    binFilters.foil = '';
    updateFilterButtonState();
    closeFilterDropdown();
    const grid = document.getElementById('inv-card-grid');
    if (grid) grid.innerHTML = '';

    const deleteBtn = document.getElementById('settings-delete-btn');
    if (deleteBtn) deleteBtn.style.display = bin.default ? 'none' : '';

    await enrichAndRenderBinCards(bin);
}

function closeBinDetail() {
    closeInvDrawer();
    safeDiscardEditMode();
    activeBin = null;
    binCardRows = [];
    document.getElementById('inv-detail-view').classList.add('hidden');
    document.getElementById('inv-bins-view').classList.remove('hidden');
    renderBinGrid();
}

async function enrichAndRenderBinCards(bin) {
    const cards = bin.cards || {};
    const rows = [];

    if (Object.keys(cards).length === 0) {
        binCardRows = [];
        renderBinCards();
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
                        foilKind = toFoilLabel(foilKindRaw) || 'Standard';
                    } else {
                        for (const finfo of Object.values(foilsData)) {
                            if (finfo.variants?.[foil_id]) {
                                foilKindRaw = finfo.variants[foil_id].kind || '';
                                foilKind = toFoilLabel(foilKindRaw) || 'Variant';
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
        console.error('Failed to enrich bin cards');
    }

    binCardRows = rows;
    populateFilterMenus();
    renderBinCards();
}

function renderBinCards() {
    const grid = document.getElementById('inv-card-grid');
    if (!grid) return;

    const filter = document.getElementById('inv-card-filter')?.value?.toLowerCase() || '';
    const sort = binFilters.sort || 'collector';

    let rows = [...binCardRows];

    // Name text filter
    if (filter) rows = rows.filter(r => r.cardName.toLowerCase().includes(filter));

    // Dropdown filters
    if (binFilters.set) rows = rows.filter(r => r.setPrefix === binFilters.set);
    if (binFilters.element) rows = rows.filter(r => r.element === binFilters.element);
    if (binFilters.rarity) rows = rows.filter(r => (rarityMapInv[r.rarity] || '') === binFilters.rarity);
    if (binFilters.foil) rows = rows.filter(r => r.foilKindRaw === binFilters.foil);

    rows.sort((a, b) => {
        switch (sort) {
            case 'name':
                return a.cardName.localeCompare(b.cardName);
            case 'set':
                return a.setPrefix.localeCompare(b.setPrefix);
            case 'rarity':
                return (b.rarity || 0) - (a.rarity || 0);
            case 'quantity':
                return b.quantity - a.quantity;
            case 'collector': {
                const parseCol = s => {
                    const m = (s || '').match(/^(\d+)([A-Z]*)$/i);
                    return m ? [parseInt(m[1]), m[2] || ''] : [Infinity, s || ''];
                };
                const [nA, sA] = parseCol(a.collectorNumber);
                const [nB, sB] = parseCol(b.collectorNumber);
                if (a.setPrefix !== b.setPrefix) return a.setPrefix.localeCompare(b.setPrefix);
                return nA !== nB ? nA - nB : sA.localeCompare(sB);
            }
        }
    });

    updateInvCounts();

    grid.innerHTML = '';

    if (rows.length === 0 && !filter) {
        // Empty state + add tile
        const empty = document.createElement('div');
        empty.className = 'inv-empty-grid';
        empty.innerHTML = `<span class="inv-empty-icon">⬡</span><p>No cards in this bin.</p><p class="inv-empty-sub">Click the + tile to add cards.</p>`;
        grid.appendChild(empty);
    } else {
        rows.forEach((row, i) => {
            const tile = buildInvCardTile(row, i, rows.length);
            const input = tile.querySelector('.inv-tile-qty-input');
            if (input) scaleQtyFont(input);
            grid.appendChild(tile);
        });
    }

    // Observe grid for new tiles and watch existing indicators
    _gridObserver.disconnect();
    _gridObserver.observe(grid, {childList: true});
    _observeIndicators();

    // Add card tile always at end
    const addTile = document.createElement('div');
    addTile.className = 'inv-card-add-tile';
    addTile.style.animationDelay = `${Math.min(rows.length * 40, 640)}ms`;
    addTile.innerHTML = `<span class="inv-create-plus">+</span><span class="inv-create-label">Add Card</span>`;
    addTile.onclick = openAddModal;
    grid.appendChild(addTile);
}

// ── Bin filter state ──
const binFilters = {sort: 'collector', set: '', element: '', rarity: '', foil: ''};

function toggleFilterDropdown() {
    const menu = document.getElementById('inv-filter-menu');
    const btn = document.getElementById('inv-filter-btn');
    const isOpen = !menu.classList.contains('hidden');
    if (isOpen) {
        menu.classList.add('hidden');
        btn.classList.remove('open');
    } else {
        populateFilterMenus();
        menu.classList.remove('hidden');
        btn.classList.add('open');

    }
}

function closeFilterDropdown() {
    const menu = document.getElementById('inv-filter-menu');
    const btn = document.getElementById('inv-filter-btn');
    if (menu) menu.classList.add('hidden');
    if (btn) btn.classList.remove('open');
}

function populateFilterMenus() {
    const sets = [...new Set(binCardRows.map(r => r.setPrefix).filter(Boolean))].sort();
    const elements = [...new Set(binCardRows.map(r => r.element).filter(Boolean))].sort();
    const rarityNums = [...new Set(binCardRows.map(r => r.rarity).filter(r => r != null))].sort((a, b) => a - b);
    const rarities = rarityNums.map(r => rarityMapInv[r] || String(r));
    const foils = [...new Set(binCardRows.map(r => r.foilKindRaw).filter(Boolean))].sort();
    const sortOptions = ['name', 'set', 'rarity', 'quantity', 'collector'];

    renderFilterChips('inv-filter-sort-options', sortOptions, 'sort');
    renderFilterChips('inv-filter-set-options', sets, 'set');
    renderFilterChips('inv-filter-element-options', elements, 'element');
    renderFilterChips('inv-filter-rarity-options', rarities, 'rarity');
    renderFilterChips('inv-filter-foil-options', foils, 'foil');
}

function renderFilterChips(containerId, values, filterKey) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    if (!values.length) {
        container.innerHTML = '<span style="font-size:0.7rem;color:var(--text-muted);opacity:0.5;">None</span>';
        return;
    }
    values.forEach(val => {
        const chip = document.createElement('button');
        chip.className = 'inv-filter-chip' + (binFilters[filterKey] === val ? ' selected' : '');
        chip.textContent = val;
        chip.onclick = (e) => {
            e.stopPropagation();
            toggleFilterChip(filterKey, val, chip);
        };
        container.appendChild(chip);
    });
}

function toggleFilterChip(filterKey, val, chip) {
    if (filterKey === 'sort') {
        // Sort always has a value — just switch
        chip.parentElement.querySelectorAll('.inv-filter-chip').forEach(c => c.classList.remove('selected'));
        binFilters.sort = val;
        chip.classList.add('selected');
    } else if (binFilters[filterKey] === val) {
        binFilters[filterKey] = '';
        chip.classList.remove('selected');
    } else {
        chip.parentElement.querySelectorAll('.inv-filter-chip').forEach(c => c.classList.remove('selected'));
        binFilters[filterKey] = val;
        chip.classList.add('selected');
    }
    updateFilterButtonState();
    renderBinCards();
}

function updateFilterButtonState() {
    const btn = document.getElementById('inv-filter-btn');
    const label = document.getElementById('inv-filter-label');
    if (!btn || !label) return;
    const activeCount = Object.entries(binFilters).filter(([k, v]) => k !== 'sort' && v).length;
    btn.classList.toggle('active', activeCount > 0);
    label.textContent = activeCount > 0 ? `Filter (${activeCount})` : 'Filter';
}

function clearBinFilters() {
    binFilters.sort = 'collector';
    binFilters.set = '';
    binFilters.element = '';
    binFilters.rarity = '';
    binFilters.foil = '';
    updateFilterButtonState();
    populateFilterMenus();
    renderBinCards();
}

function filterBinCards(value) {
    renderBinCards();
}

// CSR=7, CUR=8, CPR=9 are always foil — skip foil indicator for these
const ALWAYS_FOIL_RARITIES = new Set([7, 8, 9]);

function getFoilSuffix(row) {
    if (ALWAYS_FOIL_RARITIES.has(row.rarity)) return '';
    const kind = row.foilKindRaw || '';
    if (kind === 'nonfoil' || kind === '') return '';
    if (kind === 'foil') return '⭐';
    return '💎';
}


// ── Inline tile quantity controls ──

function tileQtyChange(btn, delta) {
    const input = btn.closest('.inv-card-tile-qty-ctrl').querySelector('.inv-tile-qty-input');
    const before = parseInt(input.value) || 0;
    const newVal = Math.max(0, before + delta);
    input.value = newVal;
    scaleQtyFont(input);

    if (isEditMode()) {
        // Already in edit mode — absorb this change into the session
        enterEditMode(input, before);
    } else {
        tileQtyCommit(input);
    }
}

async function tileQtySet(input) {
    const val = parseInt(input.value);
    if (isNaN(val) || val < 0) input.value = 0;

    if (isEditMode()) {
        // Stage the text-box change — enterEditMode records originalValue if first touch
        const before = pendingQtyChanges.has(input)
            ? pendingQtyChanges.get(input)   // keep the true original
            : val;                            // first touch via text box (original = current typed val is wrong — use row data)
        // Better: read from binCardRows for the true original
        const cardId = input.dataset.cardId;
        const editionId = input.dataset.editionId;
        const foilId = input.dataset.foilId;
        const row = binCardRows.find(r => r.card_id === cardId && r.edition_id === editionId && r.foil_id === foilId);
        const trueOriginal = pendingQtyChanges.has(input)
            ? pendingQtyChanges.get(input)
            : (row?.quantity ?? val);
        enterEditMode(input, trueOriginal);

    } else {
        tileQtyCommit(input);
    }
}

// Called by the wheel listener in tiles.js — stages instead of immediately committing
function tileQtyStage(input, originalValue) {
    enterEditMode(input, originalValue);
}

// Silently discard any active edit session — call before navigating away
function safeDiscardEditMode() {
    if (!isEditMode()) return;
    discardQtyChange(true);  // immediate — no animation when leaving bin
}

// ── Pending quantity changes (wheel-scroll edit mode) ──
// Map of input element -> originalValue for all staged changes in the current edit session
let pendingQtyChanges = new Map();

function isEditMode() {
    return pendingQtyChanges.size > 0;
}


// ── Indicator helpers delegated to tiles.js ──
// updateTileIndicator, clearTileIndicator, clearAllIndicators defined in tiles.js

function enterEditMode(input, originalValue) {
    if (!pendingQtyChanges.has(input)) {
        pendingQtyChanges.set(input, originalValue);
    }

    const currentValue = parseInt(input.value) || 0;
    const storedOriginal = pendingQtyChanges.get(input);

    if (currentValue === storedOriginal) {
        // Returned to original — remove and clear indicator
        pendingQtyChanges.delete(input);
        const tile = input.closest('.inv-card-tile');
        if (tile) clearTileIndicator(tile);

        if (!pendingQtyChanges.size) {
            hideQtyConfirmBar();
            return;
        }
    } else {
        updateTileIndicator(input, pendingQtyChanges);
    }

    showQtyConfirmBar();
}

function showQtyConfirmBar() {
    const bar = document.getElementById('inv-qty-confirm-bar');
    if (!bar) return;
    bar.classList.remove('hidden', 'confirmed');
    const msg = bar.querySelector('.inv-qty-confirm-msg');
    if (msg) msg.textContent = 'Confirm changes?';
    void bar.offsetWidth;
    bar.classList.add('visible');
}

function hideQtyConfirmBar(immediate = false) {
    const bar = document.getElementById('inv-qty-confirm-bar');
    if (!bar) return;
    bar.classList.remove('visible', 'confirmed');
    if (immediate) {
        bar.classList.add('hidden');
    } else {
        setTimeout(() => bar.classList.add('hidden'), 230);
    }
    pendingQtyChanges.clear();
    clearAllIndicators();
}

async function applyQtyChange() {
    if (!pendingQtyChanges.size) return;

    // Snapshot all data before any DOM manipulation — renderBinCards() on deletion
    // destroys and recreates tiles, detaching inputs still in the queue.
    const changes = [...pendingQtyChanges.entries()].map(([input, originalValue]) => ({
        quantity: Math.max(0, parseInt(input.value) || 0),
        cardId: input.dataset.cardId,
        editionId: input.dataset.editionId,
        foilId: input.dataset.foilId,
    }));

    pendingQtyChanges.clear();

    // Process deletions first so renderBinCards() is only called once at the end
    const toDelete = changes.filter(c => c.quantity === 0);
    const toUpdate = changes.filter(c => c.quantity > 0);

    for (const c of toUpdate) {
        try {
            await fetch('/api/inventory/card', {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    bin: activeBin,
                    card_id: c.cardId,
                    edition_id: c.editionId,
                    foil_id: c.foilId,
                    quantity: c.quantity
                })
            });
            if (invBins[activeBin]?.cards?.[c.cardId]?.[c.editionId]) {
                invBins[activeBin].cards[c.cardId][c.editionId][c.foilId] = c.quantity;
            }
            const row = binCardRows.find(r => r.card_id === c.cardId && r.edition_id === c.editionId && r.foil_id === c.foilId);
            if (row) row.quantity = c.quantity;
            // Update badge on the existing tile
            const tile = document.querySelector(
                `.inv-card-tile[data-card-id="${c.cardId}"][data-edition-id="${c.editionId}"][data-foil-id="${c.foilId}"]`
            );
            const badge = tile?.querySelector('.inv-qty-badge');
            if (badge) badge.textContent = `x${c.quantity}`;
        } catch {
            console.error('Failed to update quantity');
        }
    }

    for (const c of toDelete) {
        try {
            await fetch('/api/inventory/card', {
                method: 'DELETE',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({bin: activeBin, card_id: c.cardId, edition_id: c.editionId, foil_id: c.foilId})
            });
            const bin = invBins[activeBin];
            delete bin.cards[c.cardId]?.[c.editionId]?.[c.foilId];
            if (bin.cards[c.cardId]?.[c.editionId] && !Object.keys(bin.cards[c.cardId][c.editionId]).length) delete bin.cards[c.cardId][c.editionId];
            if (bin.cards[c.cardId] && !Object.keys(bin.cards[c.cardId]).length) delete bin.cards[c.cardId];
            binCardRows = binCardRows.filter(r => !(r.card_id === c.cardId && r.edition_id === c.editionId && r.foil_id === c.foilId));
        } catch {
            console.error('Failed to remove card');
        }
    }

    updateInvCounts();
    if (toDelete.length) renderBinCards();

    // Flash green then dismiss
    const bar = document.getElementById('inv-qty-confirm-bar');
    if (bar) {
        bar.classList.add('confirmed');
        const msg = bar.querySelector('.inv-qty-confirm-msg');
        if (msg) msg.textContent = 'Changes applied';
        setTimeout(() => hideQtyConfirmBar(), 1500);
    }
}

async function discardQtyChange(immediate = false) {
    if (!pendingQtyChanges.size) return;
    for (const [input, originalValue] of pendingQtyChanges) {
        input.value = originalValue;
        const badge = input.closest('.inv-card-tile')?.querySelector('.inv-qty-badge');
        if (badge) badge.textContent = `x${originalValue}`;
    }
    clearAllIndicators();
    hideQtyConfirmBar(immediate);
}

// Immediate commit — the actual API call, extracted from tileQtyCommit
async function _commitQtyImmediate(input, staged = false) {

    const quantity = Math.max(0, parseInt(input.value) || 0);
    const cardId = input.dataset.cardId;
    const editionId = input.dataset.editionId;
    const foilId = input.dataset.foilId;

    // Update qty badge immediately
    const tile = input.closest('.inv-card-tile');
    const badge = tile?.querySelector('.inv-qty-badge');
    if (badge) badge.textContent = `x${quantity}`;

    if (quantity === 0) {
        // When staged (scroll preview), don't remove the tile yet — wait for confirm
        if (staged) return;
        // Remove card
        try {
            await fetch('/api/inventory/card', {
                method: 'DELETE',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({bin: activeBin, card_id: cardId, edition_id: editionId, foil_id: foilId})
            });
            const bin = invBins[activeBin];
            delete bin.cards[cardId]?.[editionId]?.[foilId];
            if (bin.cards[cardId]?.[editionId] && !Object.keys(bin.cards[cardId][editionId]).length) delete bin.cards[cardId][editionId];
            if (bin.cards[cardId] && !Object.keys(bin.cards[cardId]).length) delete bin.cards[cardId];
            binCardRows = binCardRows.filter(r => !(r.card_id === cardId && r.edition_id === editionId && r.foil_id === foilId));
            tile?.remove();
            renderBinCards();
        } catch {
            console.error('Failed to remove card');
        }
        return;
    }

    try {
        await fetch('/api/inventory/card', {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({bin: activeBin, card_id: cardId, edition_id: editionId, foil_id: foilId, quantity})
        });
        if (invBins[activeBin]?.cards?.[cardId]?.[editionId]) {
            invBins[activeBin].cards[cardId][editionId][foilId] = quantity;
        }
        const row = binCardRows.find(r => r.card_id === cardId && r.edition_id === editionId && r.foil_id === foilId);
        if (row) row.quantity = quantity;
        updateInvCounts();
    } catch {
        console.error('Failed to update quantity');
    }
}

async function tileQtyCommit(input) {
    await _commitQtyImmediate(input);
}

function updateInvCounts() {
    const totalQty = binCardRows.reduce((s, r) => s + r.quantity, 0);
    const countEl = document.getElementById('detail-bin-counts');
    if (countEl) countEl.textContent = `${binCardRows.length} card${binCardRows.length !== 1 ? 's' : ''} · ${totalQty} cop${totalQty !== 1 ? 'ies' : 'y'}`;
}

function buildInvCardTile(row, index, total = 1) {
    const rarity = rarityMapInv[row.rarity] || '';
    const rarityClass = rarity ? `rarity-${rarity.toLowerCase()}` : '';

    const tile = document.createElement('div');
    tile.className = 'inv-card-tile';
    const maxDelay = 600;
    const delay = total <= 1 ? 0 : Math.min(index * 40, Math.round((index / (total - 1)) * maxDelay));
    tile.style.animationDelay = `${delay}ms`;
    tile.dataset.cardId = row.card_id;
    tile.dataset.editionId = row.edition_id;
    tile.dataset.foilId = row.foil_id;

    const uid = `${row.card_id}-${row.edition_id}-${row.foil_id}`;

    tile.innerHTML = `
        <div class="edition-tile-wrap">
            <img src="/images/${row.edition_id}.jpg" alt="${row.cardName}"
                onerror="this.style.opacity='0.1'">
            <div class="card-tile-dim"></div>
            ${rarity ? `<span class="edition-rarity-badge ${rarityClass}${getFoilSuffix(row) ? ' has-foil-suffix' : ''}">${rarity}${getFoilSuffix(row)}</span>` : ''}
        </div>
        <span class="inv-qty-badge">x${row.quantity}</span>
        <div class="inv-card-tile-overlay">
            <div class="inv-card-tile-info">
                <div class="inv-card-tile-name">${row.cardName}</div>
                <div class="inv-card-tile-foil">${row.foilKind}</div>
            </div>
        </div>
        <div class="inv-card-tile-qty-ctrl">
            <button class="inv-tile-qty-btn inv-tile-qty-add" onclick="event.stopPropagation(); tileQtyChange(this, 1)">+</button>
            <input class="inv-tile-qty-input" type="number" value="${row.quantity}" min="0" max="999"
                data-card-id="${row.card_id}"
                data-edition-id="${row.edition_id}"
                data-foil-id="${row.foil_id}"
                onchange="tileQtySet(this)"
                oninput="scaleQtyFont(this)"
                onclick="event.stopPropagation()"
                onfocus="this.select()">
            <button class="inv-tile-qty-btn inv-tile-qty-sub" onclick="event.stopPropagation(); tileQtyChange(this, -1)">−</button>
        </div>
        <div class="inv-tile-qty-indicator"></div>`;

    tile.addEventListener('click', () => openInvDrawer(row.card_id, row.edition_id, row.cardName));
    tile.addEventListener('contextmenu', e => {
        e.preventDefault();
        openCardContextMenu(e, row);
    });
    tile.addEventListener('animationend', () => tile.classList.add('animated'));
    return tile;
}

// ═══════════════════════════════════════
// CARD DETAIL MODAL (click existing card)
// ═══════════════════════════════════════

function openCardModal(row) {
    cardModalRow = row;
    document.getElementById('card-modal-name').textContent = row.cardName;
    document.getElementById('card-modal-set').textContent = `${row.setPrefix}${row.rarity ? ' · ' + (rarityMapInv[row.rarity] || '') : ''}`;
    document.getElementById('card-modal-img').src = `/images/${row.edition_id}.jpg`;
    document.getElementById('card-modal-foil').textContent = row.foilKind;
    const cardModalQtyEl = document.getElementById('card-modal-qty');
    cardModalQtyEl.value = row.quantity;
    scaleQtyFont(cardModalQtyEl);
    document.getElementById('inv-card-modal').classList.remove('hidden');
}

function closeCardModal() {
    document.getElementById('inv-card-modal').classList.add('hidden');
    cardModalRow = null;
}

function changeCardModalQty(delta) {
    const input = document.getElementById('card-modal-qty');
    input.value = Math.max(0, Math.min(999, (parseInt(input.value) || 0) + delta));
}

async function saveCardModal() {
    if (!cardModalRow) return;
    const qty = parseInt(document.getElementById('card-modal-qty').value) || 0;

    if (qty <= 0) {
        await removeCardModal();
        return;
    }

    try {
        const res = await fetch('/api/inventory/card', {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                bin: activeBin,
                card_id: cardModalRow.card_id,
                edition_id: cardModalRow.edition_id,
                foil_id: cardModalRow.foil_id,
                quantity: qty
            })
        });

        if (res.ok) {
            // Update local state
            invBins[activeBin].cards[cardModalRow.card_id][cardModalRow.edition_id][cardModalRow.foil_id] = qty;
            const r = binCardRows.find(r => r.card_id === cardModalRow.card_id && r.edition_id === cardModalRow.edition_id && r.foil_id === cardModalRow.foil_id);
            if (r) r.quantity = qty;
            closeCardModal();
            renderBinCards();
        }
    } catch {
        console.error('Failed to save');
    }
}

async function removeCardModal() {
    if (!cardModalRow) return;

    try {
        const res = await fetch('/api/inventory/card', {
            method: 'DELETE',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                bin: activeBin,
                card_id: cardModalRow.card_id,
                edition_id: cardModalRow.edition_id,
                foil_id: cardModalRow.foil_id
            })
        });

        if (res.ok) {
            const bin = invBins[activeBin];
            delete bin.cards[cardModalRow.card_id][cardModalRow.edition_id][cardModalRow.foil_id];
            if (!Object.keys(bin.cards[cardModalRow.card_id][cardModalRow.edition_id]).length)
                delete bin.cards[cardModalRow.card_id][cardModalRow.edition_id];
            if (!Object.keys(bin.cards[cardModalRow.card_id]).length)
                delete bin.cards[cardModalRow.card_id];

            binCardRows = binCardRows.filter(r => !(r.card_id === cardModalRow.card_id && r.edition_id === cardModalRow.edition_id && r.foil_id === cardModalRow.foil_id));
            closeCardModal();
            renderBinCards();
        }
    } catch {
        console.error('Failed to remove');
    }
}

// ═══════════════════════════════════════
// ADD CARD MODAL (two-step: search → foil)
// ═══════════════════════════════════════

function openAddModal() {
    addModalCardId = null;
    addModalCardData = null;
    addModalEditionId = null;
    addModalFoilId = null;
    document.getElementById('add-card-search').value = '';
    const _res = document.getElementById('add-card-results');
    if (_res) {
        _res.style.gridTemplateColumns = '';
        _res.classList.remove('has-scroll');
    }
    document.getElementById('add-card-results').innerHTML = `<div class="inv-search-placeholder" style="padding:30px 0"><span class="inv-empty-icon">⬡</span><p>Search for a card to add it.</p></div>`;
    document.getElementById('add-step-search').classList.remove('hidden');
    document.getElementById('add-step-foil').classList.add('hidden');
    document.getElementById('add-back-btn').classList.add('hidden');
    document.querySelector('#inv-add-modal .inv-modal-wide').classList.remove('inv-modal-foil-step');
    document.getElementById('inv-add-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('add-card-search').focus(), 60);
}

function closeAddModal() {
    document.getElementById('inv-add-modal').classList.add('hidden');
    hideAddAc();
    const btn = document.getElementById('add-modal-submit');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Add to Bin';
    }
}

function backToSearch() {
    document.getElementById('add-step-foil').classList.add('hidden');
    document.getElementById('add-step-search').classList.remove('hidden');
    document.getElementById('add-back-btn').classList.add('hidden');
    document.querySelector('#inv-add-modal .inv-modal-wide').classList.remove('inv-modal-foil-step');
    addModalCardId = null;
    addModalCardData = null;
    addModalEditionId = null;
    addModalFoilId = null;
    // Restore grid columns to match existing results
    const results = document.getElementById('add-card-results');
    const tileCount = results ? results.querySelectorAll('.inv-search-tile').length : 0;
    if (tileCount > 0) {
        const cols = Math.min(tileCount, 5);
        if (results) results.style.gridTemplateColumns = `repeat(${cols}, 255px)`;
    }
    setTimeout(() => document.getElementById('add-card-search').focus(), 40);
}

async function searchAddCards() {
    const query = document.getElementById('add-card-search')?.value?.trim();
    const results = document.getElementById('add-card-results');
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

        // Fix grid columns and scroll padding before any branching
        const cols = Math.min(data.cards.length, 5);
        results.style.gridTemplateColumns = `repeat(${cols}, 255px)`;
        results.classList.toggle('has-scroll', data.cards.length >= 6);

        // Single unique card — skip grid, go straight to foil picker
        const uniqueIds = new Set(data.cards.map(c => c.card_id));
        if (uniqueIds.size === 1) {
            const card = data.cards[0];
            await goToFoilStep(card.card_id, card.edition_id, card.name);
            return;
        }

        // Multiple distinct cards — show grid so user picks one
        data.cards.forEach((card, i) => {
            const rarity = rarityMapInv[card.rarity] || '';
            const rarityClass = rarity ? `rarity-${rarity.toLowerCase()}` : '';
            const tile = document.createElement('div');
            tile.className = 'inv-search-tile';
            tile.style.animationDelay = `${Math.min(i, 20) * 30}ms`;
            tile.innerHTML = `
                <div class="edition-tile-wrap">
                    <img src="/images/${card.edition_id}.jpg" alt="${card.name}">
                    <div class="inv-search-tile-overlay">＋</div>
                </div>`;
            tile.onclick = () => goToFoilStep(card.card_id, card.edition_id, card.name);
            tile.addEventListener('animationend', () => tile.classList.add('animated'));
            results.appendChild(tile);
        });
    } catch {
        results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Search failed.</p></div>`;
    }
}

async function goToFoilStep(cardId, editionId, cardName) {
    addModalCardId = cardId;

    document.getElementById('add-modal-name').textContent = cardName;
    document.getElementById('add-modal-set').textContent = '';
    document.getElementById('add-modal-img').src = `/images/${editionId}.jpg`;
    document.getElementById('add-modal-foils').innerHTML = '<div style="font-size:0.78rem;color:var(--text-muted);">Loading...</div>';
    const addModalQtyEl = document.getElementById('add-modal-qty');
    addModalQtyEl.value = 1;
    scaleQtyFont(addModalQtyEl);
    document.getElementById('add-modal-submit').disabled = true;

    document.getElementById('add-step-search').classList.add('hidden');
    document.getElementById('add-step-foil').classList.remove('hidden');
    document.getElementById('add-back-btn').classList.remove('hidden');
    document.querySelector('#inv-add-modal .inv-modal-wide').classList.add('inv-modal-foil-step');

    try {
        const res = await fetch(`/api/cards/${cardId}`);
        const data = await res.json();
        addModalCardData = data.card;

        const editions = Object.entries(addModalCardData.editions || {}).sort((a, b) => {
            const parseNum = s => {
                const m = (s || 'ZZZ').match(/^(\d+)([A-Z]*)$/i);
                return m ? [parseInt(m[1]), m[2] || ''] : [Infinity, s];
            };
            const [nA, sA] = parseNum(a[1].collector_number);
            const [nB, sB] = parseNum(b[1].collector_number);
            return nA !== nB ? nA - nB : sA.localeCompare(sB);
        });

        const foilList = document.getElementById('add-modal-foils');
        foilList.innerHTML = '';
        let firstOpt = null;

        editions.forEach(([eid, einfo]) => {
            const rarity = rarityMapInv[einfo.rarity] || '?';
            Object.entries(einfo.foils || {}).forEach(([fid, finfo]) => {
                const opt = buildFoilOption(eid, fid, finfo.kind, einfo.set_prefix, rarity, einfo.collector_number, false);
                if (!firstOpt) firstOpt = {opt, eid, fid};
                foilList.appendChild(opt);
                Object.entries(finfo.variants || {}).forEach(([vid, vinfo]) => {
                    const vopt = buildFoilOption(eid, vid, vinfo.kind, einfo.set_prefix, rarity, einfo.collector_number, true);
                    foilList.appendChild(vopt);
                });
            });
        });

        if (firstOpt) selectFoilOption(firstOpt.opt, firstOpt.eid, firstOpt.fid);
    } catch {
        document.getElementById('add-modal-foils').innerHTML = '<div style="font-size:0.78rem;color:var(--error);">Failed to load editions.</div>';
    }
}

function buildFoilOption(editionId, foilId, kind, setPrefix, rarity, collectorNum, isVariant) {
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
    opt.onclick = () => selectFoilOption(opt, editionId, foilId);
    return opt;
}

function selectFoilOption(opt, editionId, foilId) {
    document.querySelectorAll('#add-modal-foils .inv-foil-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    addModalEditionId = editionId;
    addModalFoilId = foilId;

    const einfo = addModalCardData?.editions?.[editionId];
    if (einfo) {
        document.getElementById('add-modal-img').src = `/images/${editionId}.jpg`;
        document.getElementById('add-modal-set').textContent = `${einfo.set_name || ''} (${einfo.set_prefix || ''}) — #${einfo.collector_number || '?'}`;
    }
    document.getElementById('add-modal-submit').disabled = false;
}

function changeAddQty(delta) {
    const input = document.getElementById('add-modal-qty');
    input.value = Math.max(1, Math.min(999, (parseInt(input.value) || 1) + delta));
}

async function submitAddCard() {
    if (!addModalCardId || !addModalEditionId || !addModalFoilId || !activeBin) return;

    const quantity = parseInt(document.getElementById('add-modal-qty').value) || 1;
    const btn = document.getElementById('add-modal-submit');
    btn.disabled = true;
    btn.textContent = 'Adding...';

    try {
        const res = await fetch('/api/inventory/card', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                bin: activeBin,
                card_id: addModalCardId,
                edition_id: addModalEditionId,
                foil_id: addModalFoilId,
                quantity
            })
        });

        if (res.ok) {
            const bin = invBins[activeBin];
            if (!bin.cards[addModalCardId]) bin.cards[addModalCardId] = {};
            if (!bin.cards[addModalCardId][addModalEditionId]) bin.cards[addModalCardId][addModalEditionId] = {};
            const existing = bin.cards[addModalCardId][addModalEditionId][addModalFoilId] || 0;
            bin.cards[addModalCardId][addModalEditionId][addModalFoilId] = existing + quantity;

            closeAddModal();
            await enrichAndRenderBinCards(invBins[activeBin]);
        } else {
            btn.textContent = 'Error';
            setTimeout(() => {
                btn.textContent = 'Add to Bin';
                btn.disabled = false;
            }, 1500);
        }
    } catch {
        btn.textContent = 'Failed';
        setTimeout(() => {
            btn.textContent = 'Add to Bin';
            btn.disabled = false;
        }, 1500);
    }
}

// ═══════════════════════════════════════
// AUTOCOMPLETE (add modal)
// ═══════════════════════════════════════

async function fetchAddCardSuggestions(value) {
    const list = document.getElementById('add-card-autocomplete');
    if (value.length < 2) {
        hideAddAc();
        return;
    }
    try {
        const res = await fetch(`/api/cards/suggest?q=${encodeURIComponent(value)}`);
        const data = await res.json();
        if (!data.suggestions?.length) {
            hideAddAc();
            return;
        }
        addAcIndex = -1;
        list.innerHTML = '';
        data.suggestions.forEach(name => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.textContent = name;
            item.onclick = () => {
                document.getElementById('add-card-search').value = name;
                hideAddAc();
                searchAddCards();
            };
            list.appendChild(item);
        });
        list.classList.remove('hidden');
    } catch {
        hideAddAc();
    }
}

function hideAddAc() {
    const list = document.getElementById('add-card-autocomplete');
    if (list) {
        list.classList.add('hidden');
        list.innerHTML = '';
    }
    addAcIndex = -1;
}

function handleAddCardKeydown(e) {
    const list = document.getElementById('add-card-autocomplete');
    const items = list?.querySelectorAll('.autocomplete-item') || [];
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        addAcIndex = Math.min(addAcIndex + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('selected', i === addAcIndex));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        addAcIndex = Math.max(addAcIndex - 1, -1);
        items.forEach((el, i) => el.classList.toggle('selected', i === addAcIndex));
    } else if (e.key === 'Enter') {
        if (addAcIndex >= 0 && items[addAcIndex]) {
            document.getElementById('add-card-search').value = items[addAcIndex].textContent;
            hideAddAc();
            searchAddCards();
        } else {
            hideAddAc();
            searchAddCards();
        }
    } else if (e.key === 'Escape') {
        hideAddAc();
        closeAddModal();
    }
}

// Use capture so it fires even inside stopPropagation — guarded to inventory page only
document.addEventListener('click', e => {
    if (!document.getElementById('inv-add-modal')) return;
    if (!e.target.closest('#add-card-search') && !e.target.closest('#add-card-autocomplete')) hideAddAc();
    if (!e.target.closest('.inv-filter-dropdown-wrap')) closeFilterDropdown();
    if (!e.target.closest('#inv-card-context-menu')) closeCardContextMenu();
}, true);


// ═══════════════════════════════════════
// BIN CONTEXT MENU
// ═══════════════════════════════════════

let ctxTargetBin = null;

function openBinContextMenu(e, binName) {
    ctxTargetBin = binName;
    const menu = document.getElementById('inv-bin-context-menu');
    const setDefaultBtn = document.getElementById('ctx-set-default');

    // Hide "set as default" if already default, hide "delete" for default bin
    setDefaultBtn.style.display = invBins[binName]?.default ? 'none' : '';
    const isDefault = invBins[binName]?.default;
    const deleteBtn = document.getElementById('ctx-delete');
    if (deleteBtn) deleteBtn.style.display = isDefault ? 'none' : '';
    const divider = document.querySelector('#inv-bin-context-menu .inv-context-divider');
    if (divider) divider.style.display = isDefault ? 'none' : '';

    menu.classList.remove('hidden');

    // Position near cursor, keep within viewport
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 60);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
}

function closeBinContextMenu() {
    document.getElementById('inv-bin-context-menu').classList.add('hidden');
    ctxTargetBin = null;
}

function ctxRename() {
    if (!ctxTargetBin) return;
    const name = ctxTargetBin;
    closeBinContextMenu();

    const input = document.getElementById('rename-bin-input');
    const errEl = document.getElementById('rename-bin-error');
    input.value = name;
    input.dataset.originalName = name;
    errEl.classList.add('hidden');
    document.getElementById('inv-rename-modal').classList.remove('hidden');
    setTimeout(() => {
        input.focus();
        input.select();
    }, 50);
}

function closeRenameModal() {
    document.getElementById('inv-rename-modal').classList.add('hidden');
}

async function submitRenameBin() {
    const newName = document.getElementById('rename-bin-input').value.trim();
    const errEl = document.getElementById('rename-bin-error');
    errEl.classList.add('hidden');

    if (!newName) {
        errEl.textContent = 'Name is required.';
        errEl.classList.remove('hidden');
        return;
    }

    // Find the bin being renamed (stored before modal opened)
    const oldName = document.getElementById('rename-bin-input').dataset.originalName || newName;

    if (newName !== oldName && invBins[newName]) {
        errEl.textContent = 'A bin with that name already exists.';
        errEl.classList.remove('hidden');
        return;
    }

    if (newName === oldName) {
        closeRenameModal();
        return;
    }

    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(oldName)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: newName, desc: invBins[oldName]?.desc || ''})
        });

        if (res.ok) {
            invBins[newName] = invBins[oldName];
            delete invBins[oldName];
            closeRenameModal();
            renderBinGrid();
        } else {
            const err = await res.json();
            errEl.textContent = err.detail || 'Failed to rename.';
            errEl.classList.remove('hidden');
        }
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

function ctxEditDesc() {
    if (!ctxTargetBin) return;
    const name = ctxTargetBin;
    closeBinContextMenu();

    const input = document.getElementById('desc-bin-input');
    input.value = invBins[name]?.desc || '';
    input.dataset.targetBin = name;
    document.getElementById('desc-bin-error').classList.add('hidden');
    document.getElementById('inv-desc-modal').classList.remove('hidden');
    setTimeout(() => {
        input.focus();
    }, 50);
}

function closeDescModal() {
    document.getElementById('inv-desc-modal').classList.add('hidden');
}

async function submitDescBin() {
    const input = document.getElementById('desc-bin-input');
    const binName = input.dataset.targetBin;
    const desc = input.value.trim();
    const errEl = document.getElementById('desc-bin-error');
    errEl.classList.add('hidden');

    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(binName)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: binName, desc})
        });

        if (res.ok) {
            invBins[binName].desc = desc;
            closeDescModal();
            renderBinGrid();
        } else {
            const err = await res.json();
            errEl.textContent = err.detail || 'Failed to save.';
            errEl.classList.remove('hidden');
        }
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

async function ctxDelete() {
    if (!ctxTargetBin) return;
    const name = ctxTargetBin;
    closeBinContextMenu();

    if (invBins[name]?.default) return;
    if (!confirm(`Delete bin "${name}"? All cards inside will be removed.`)) return;

    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(name)}`, {method: 'DELETE'});
        if (res.ok) {
            delete invBins[name];
            renderBinGrid();
        }
    } catch {
        console.error('Failed to delete bin');
    }
}

async function ctxSetDefault() {
    if (!ctxTargetBin) return;
    const name = ctxTargetBin;
    closeBinContextMenu();

    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(name)}/default`, {method: 'POST'});
        if (res.ok) {
            // Update local state — clear all defaults then set the new one
            for (const b of Object.keys(invBins)) invBins[b].default = (b === name);
            renderBinGrid();
        }
    } catch {
        console.error('Failed to set default bin');
    }
}

// Close context menu on any click or scroll
document.addEventListener('click', () => closeBinContextMenu());
document.addEventListener('scroll', () => closeBinContextMenu(), true);

// ═══════════════════════════════════════
// CREATE BIN MODAL
// ═══════════════════════════════════════

function openCreateModal() {
    document.getElementById('create-bin-name').value = '';
    document.getElementById('create-bin-desc').value = '';
    document.getElementById('create-bin-error').classList.add('hidden');
    document.getElementById('inv-create-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('create-bin-name').focus(), 50);
}

function closeCreateModal() {
    document.getElementById('inv-create-modal').classList.add('hidden');
}

async function submitCreateBin() {
    const name = document.getElementById('create-bin-name').value.trim();
    const desc = document.getElementById('create-bin-desc').value.trim();
    const errEl = document.getElementById('create-bin-error');
    errEl.classList.add('hidden');

    if (!name) {
        errEl.textContent = 'Name is required.';
        errEl.classList.remove('hidden');
        return;
    }
    if (invBins[name]) {
        errEl.textContent = 'A bin with that name already exists.';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch('/api/inventory/bins', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name, desc})
        });
        if (res.ok) {
            invBins[name] = {banner: null, default: false, desc, public: false, symbol: null, tags: null, cards: {}};
            closeCreateModal();
            renderBinGrid();
        } else {
            const err = await res.json();
            errEl.textContent = err.detail || 'Failed to create bin.';
            errEl.classList.remove('hidden');
        }
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

// ═══════════════════════════════════════
// BIN SETTINGS MODAL
// ═══════════════════════════════════════

function openBinSettings() {
    const bin = invBins[activeBin];
    document.getElementById('settings-bin-name').value = activeBin;
    document.getElementById('settings-bin-desc').value = bin?.desc || '';
    document.getElementById('settings-bin-error').classList.add('hidden');
    const deleteBtn = document.getElementById('settings-delete-btn');
    if (deleteBtn) deleteBtn.style.display = bin?.default ? 'none' : '';
    const defaultBtn = document.getElementById('settings-default-btn');
    if (defaultBtn) defaultBtn.style.display = bin?.default ? 'none' : '';
    document.getElementById('inv-settings-modal').classList.remove('hidden');
}

function closeBinSettings() {
    document.getElementById('inv-settings-modal').classList.add('hidden');
}

async function settingsSetDefault() {
    if (!activeBin) return;
    const name = activeBin;

    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(name)}/default`, {method: 'POST'});
        if (res.ok) {
            for (const b of Object.keys(invBins)) invBins[b].default = (b === name);
            closeBinSettings();
            // Update header badge visibility
            document.getElementById('detail-bin-name').textContent = name;
        }
    } catch {
        console.error('Failed to set default bin');
    }
}

async function submitBinSettings() {
    const newName = document.getElementById('settings-bin-name').value.trim();
    const desc = document.getElementById('settings-bin-desc').value.trim();
    const errEl = document.getElementById('settings-bin-error');
    errEl.classList.add('hidden');

    if (!newName) {
        errEl.textContent = 'Name is required.';
        errEl.classList.remove('hidden');
        return;
    }
    if (newName !== activeBin && invBins[newName]) {
        errEl.textContent = 'A bin with that name already exists.';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: newName, desc})
        });
        if (res.ok) {
            const bin = invBins[activeBin];
            bin.desc = desc;
            if (newName !== activeBin) {
                invBins[newName] = bin;
                delete invBins[activeBin];
                activeBin = newName;
            }
            document.getElementById('detail-bin-name').textContent = activeBin;
            document.getElementById('detail-bin-meta').textContent = desc;
            closeBinSettings();
        } else {
            const err = await res.json();
            errEl.textContent = err.detail || 'Failed to save.';
            errEl.classList.remove('hidden');
        }
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

async function deleteBin() {
    if (invBins[activeBin]?.default) return;
    if (!confirm(`Delete bin "${activeBin}"? Cards inside will be removed.`)) return;
    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}`, {method: 'DELETE'});
        if (res.ok) {
            delete invBins[activeBin];
            closeBinSettings();
            closeBinDetail();
        }
    } catch {
        console.error('Failed to delete bin');
    }
}


// ═══════════════════════════════════════
// INVENTORY DRAWER
// ═══════════════════════════════════════

let selectedInvCardId = null;
let invDrawerActiveTab = 'info';

async function openInvDrawer(cardId, editionId, cardName) {
    const drawer = document.getElementById('inv-card-drawer');
    if (!drawer) return;

    if (selectedInvCardId === cardId) {
        const currentTile = document.querySelector('#inv-card-drawer .drawer-edition-tile img.edition-selected');
        if (currentTile && currentTile.id === `edition-tile-inv-${editionId}`) {
            closeInvDrawer();
            return;
        }
        selectInvDrawerEdition(editionId);
        return;
    }

    const isAlreadyOpen = selectedInvCardId !== null;
    selectedInvCardId = cardId;

    try {
        const res = await fetch(`/api/cards/${cardId}`);
        const data = await res.json();
        const card = data.card;

        const editions = Object.entries(card.editions).sort((a, b) => {
            const parseNum = str => {
                const m = (str || 'ZZZ').match(/^(\d+)([A-Z]*)$/i);
                return m ? [parseInt(m[1]), m[2] || ''] : [Infinity, str];
            };
            const [nA, sA] = parseNum(a[1].collector_number);
            const [nB, sB] = parseNum(b[1].collector_number);
            return nA !== nB ? nA - nB : sA.localeCompare(sB);
        });

        const selectedEdition = card.editions[editionId];

        const statsMap = {
            'Cost (Memory)': card.stats?.cost_memory,
            'Cost (Reserve)': card.stats?.cost_reserve,
            'Power': card.stats?.power,
            'Life': card.stats?.life,
            'Durability': card.stats?.durability,
            'Speed': card.stats?.speed === true ? 'Fast' : card.stats?.speed === false ? 'Slow' : null,
            'Level': card.stats?.level,
        };

        const statsHTML = Object.entries(statsMap)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([label, value]) => `
                <div class="drawer-stat">
                    <span class="drawer-stat-label">${label}</span>
                    <span class="drawer-stat-value">${value}</span>
                </div>`).join('');

        const legalityHTML = Object.entries(card.legality || {})
            .map(([format, legal]) => `
                <span class="drawer-legal-tag ${legal ? 'legal' : 'illegal'}">${format}</span>`)
            .join('');

        const rarityMapD = {1: "C", 2: "U", 3: "R", 4: "SR", 5: "UR", 6: "PR", 7: "CSR", 8: "CUR", 9: "CPR"};

        const editionsHTML = editions.map(([eid, einfo], i) => {
            const rarity = rarityMapD[einfo.rarity] || "?";
            const rarityClass = `rarity-${rarity.toLowerCase()}`;
            return `
            <div class="drawer-edition-tile" style="animation-delay: ${i * 60}ms">
                <div class="edition-tile-wrap">
                    <img src="/images/${eid}.jpg" alt="${einfo.set_name}"
                        title="${einfo.set_name} (${einfo.set_prefix})"
                        onclick="event.stopPropagation(); selectInvDrawerEdition('${eid}')"
                        id="edition-tile-inv-${eid}">
                    <span class="edition-prefix-badge">${einfo.set_prefix}</span>
                    <span class="edition-rarity-badge ${rarityClass}">${rarity}</span>
                </div>
            </div>`;
        }).join('');

        const drawerContent = document.getElementById('inv-drawer-content');
        drawer.dataset.editions = JSON.stringify(Object.fromEntries(editions));
        drawer.dataset.selectedEdition = editionId;

        const inner = document.createElement('div');
        inner.className = 'drawer-content-animate';
        inner.innerHTML = `
            <div class="drawer-top">
                <img class="drawer-card-image" src="/images/${editionId}.jpg" alt="${cardId}">
                <div class="drawer-card-info">
                    <div class="drawer-name-row">
                        <div>
                            <div class="drawer-name">${cardName}</div>
                            <div class="drawer-set">${selectedEdition?.set_name || ''} (${selectedEdition?.set_prefix || ''}) &mdash; #${selectedEdition?.collector_number || '?'}</div>
                        </div>
                        ${card.element ? `<img class="drawer-element" src="/elements/${card.element}.png" alt="${card.element}">` : ''}
                    </div>
                    <div class="drawer-tab-info">
                        <div>
                            <div class="drawer-section-label">Types</div>
                            <div class="drawer-types">
                                ${(card.types || []).map(t => `<span class="drawer-type-tag">${t}</span>`).join('')}
                            </div>
                        </div>
                        ${statsHTML ? `<div><div class="drawer-section-label">Stats</div><div class="drawer-stats">${statsHTML}</div></div>` : ''}
                        ${card.effect ? `<div><div class="drawer-section-label">Effect</div><div class="drawer-effect">${parseEffect(card.effect, cardName)}</div></div>` : ''}
                        ${legalityHTML ? `<div><div class="drawer-section-label">Legality</div><div class="drawer-legality">${legalityHTML}</div></div>` : ''}
                    </div>
                    <div class="drawer-tab-thema hidden"></div>
                </div>
            </div>
            <div class="drawer-editions-section">
                <div class="drawer-section-label">Editions</div>
                <div class="drawer-editions">${editionsHTML}</div>
            </div>`;

        const doInsert = () => {
            drawerContent.innerHTML = '';
            drawerContent.appendChild(inner);

            // Mark the selected edition tile immediately
            const initialTile = document.getElementById(`edition-tile-inv-${editionId}`);
            if (initialTile) initialTile.classList.add('edition-selected');

            // Apply active tab to newly rendered panels
            const cardInfo = drawer.querySelector('.drawer-card-info');
            if (cardInfo && invDrawerActiveTab === 'thema') {
                cardInfo.querySelector('.drawer-tab-info').classList.add('hidden');
                const themaPanel = cardInfo.querySelector('.drawer-tab-thema');
                themaPanel.classList.remove('hidden');
                themaPanel.innerHTML = buildTabThemaPanel(card.editions[editionId]);
            }
        };

        if (isAlreadyOpen) {
            const existing = drawerContent.firstElementChild;
            if (existing) {
                existing.style.transition = 'opacity 0.15s ease';
                existing.style.opacity = '0';

                setTimeout(() => {
                    doInsert();
                    inner.style.opacity = '0';
                    inner.style.transition = 'opacity 0.2s ease';
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        inner.style.opacity = '1';
                        setTimeout(() => {
                            inner.style.transition = '';
                            inner.style.opacity = '';
                        }, 220);
                    }));
                }, 150);
            } else {
                doInsert();
            }
        } else {
            doInsert();
        }

        drawer.classList.remove('hidden');
        setTimeout(() => {
            drawer.classList.add('open');
            if (!isAlreadyOpen) invDrawerActiveTab = 'info';
            const sidebar = document.getElementById('inv-drawer-sidebar');
            sidebar.classList.remove('hidden');
            sidebar.querySelectorAll('.drawer-sidebar-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === invDrawerActiveTab);
            });
            document.querySelector('.footer')?.classList.add('footer-hidden');
        }, 10);

    } catch {
        console.error('Failed to load card details for inv drawer');
    }
}

function closeInvDrawer() {
    const drawer = document.getElementById('inv-card-drawer');
    if (!drawer) return;
    drawer.classList.remove('open');
    document.getElementById('inv-drawer-sidebar')?.classList.add('hidden');
    selectedInvCardId = null;
    invDrawerActiveTab = 'info';
    const gridWrap = document.querySelector('.inv-card-grid-wrap');
    if (!gridWrap || gridWrap.scrollTop === 0) {
        document.querySelector('.footer')?.classList.remove('footer-hidden');
    }
    setTimeout(() => drawer.classList.add('hidden'), 300);
}

function selectInvDrawerEdition(editionId) {
    const mainImage = document.querySelector('#inv-card-drawer .drawer-card-image');
    if (!mainImage) return;

    mainImage.classList.add('switching');
    setTimeout(() => {
        mainImage.src = `/images/${editionId}.jpg`;
        mainImage.classList.remove('switching');
    }, 200);

    const drawer = document.getElementById('inv-card-drawer');
    const editions = JSON.parse(drawer.dataset.editions || '{}');
    const edition = editions[editionId];

    drawer.dataset.selectedEdition = editionId;

    if (edition) {
        const setEl = drawer.querySelector('.drawer-set');
        if (setEl) setEl.textContent = `${edition.set_name} (${edition.set_prefix}) — #${edition.collector_number || '?'}`;
    }

    const cardInfo = drawer.querySelector('.drawer-card-info');
    if (cardInfo) {
        cardInfo.classList.remove('drawer-info-animate');
        void cardInfo.offsetWidth;
        cardInfo.classList.add('drawer-info-animate');
    }

    drawer.querySelectorAll('.drawer-edition-tile img').forEach(img => img.classList.remove('edition-selected'));
    document.getElementById(`edition-tile-inv-${editionId}`)?.classList.add('edition-selected');

    if (invDrawerActiveTab === 'thema') {
        const themaPanel = cardInfo?.querySelector('.drawer-tab-thema');
        if (themaPanel) themaPanel.innerHTML = buildTabThemaPanel(edition);
    }
}


// ═══════════════════════════════════════
// CARD CONTEXT MENU
// ═══════════════════════════════════════

let ctxCardRow = null;

function openCardContextMenu(e, row) {
    ctxCardRow = row;
    const menu = document.getElementById('inv-card-context-menu');
    menu.classList.remove('hidden');
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 60);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
}

function closeCardContextMenu() {
    document.getElementById('inv-card-context-menu')?.classList.add('hidden');
    ctxCardRow = null;
}

function ctxCardMove() {
    if (!ctxCardRow) return;
    const row = ctxCardRow;
    closeCardContextMenu();
    openMoveModal(row);
}

// ═══════════════════════════════════════
// MOVE CARD MODAL
// ═══════════════════════════════════════

let moveRow = null;

function changeMoveQty(delta) {
    const input = document.getElementById('move-qty');
    const max = moveRow?.quantity || 999;
    const current = parseInt(input.value) || 0;
    const next = Math.max(1, Math.min(max, current + delta));
    input.value = next;
}

function openMoveModal(row) {
    moveRow = row;

    // Card info line
    document.getElementById('move-card-info').textContent =
        `${row.cardName} · ${row.setPrefix} · ${row.foilKind}`;

    document.getElementById('move-modal-error').classList.add('hidden');

    const qtyInput = document.getElementById('move-qty');
    if (qtyInput) {
        qtyInput.value = '';
        qtyInput.placeholder = `All (${row.quantity})`;
    }

    // Build bin list — exclude current bin
    const list = document.getElementById('move-bin-list');
    list.innerHTML = '';

    const otherBins = Object.entries(invBins).filter(([name]) => name !== activeBin);

    if (otherBins.length === 0) {
        list.innerHTML = '<div style="font-size:0.78rem;color:var(--text-muted);opacity:0.6;padding:8px 2px;">No other bins. Create one below.</div>';
    } else {
        otherBins.forEach(([name, bin]) => {
            const count = countBinEntries(bin.cards || {});
            const btn = document.createElement('button');
            btn.className = 'inv-move-bin-option';
            btn.innerHTML = `
                <span>${name}${bin.default ? ' <span style="color:var(--accent);font-size:0.65rem">(default)</span>' : ''}</span>
                <span class="inv-move-bin-option-meta">${count} card${count !== 1 ? 's' : ''}</span>`;
            btn.onclick = () => executeMoveCard(name);
            list.appendChild(btn);
        });
    }

    document.getElementById('inv-move-modal').classList.remove('hidden');
}

function closeMoveModal() {
    document.getElementById('inv-move-modal').classList.add('hidden');
    moveRow = null;
}

async function executeMoveCard(targetBin) {
    if (!moveRow || !activeBin) return;
    const {card_id, edition_id, foil_id} = moveRow;
    const maxQty = moveRow.quantity;
    const inputVal = parseInt(document.getElementById('move-qty')?.value);
    const quantity = (!inputVal || inputVal >= maxQty) ? maxQty : Math.max(1, inputVal);
    const partial = quantity < maxQty;
    const errEl = document.getElementById('move-modal-error');
    errEl.classList.add('hidden');

    try {
        // Add to target bin
        const addRes = await fetch('/api/inventory/card', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({bin: targetBin, card_id, edition_id, foil_id, quantity})
        });

        if (!addRes.ok) throw new Error('Failed to add to target bin');

        // Remove or reduce from current bin
        const remaining = maxQty - quantity;
        let srcRes;
        if (partial) {
            srcRes = await fetch('/api/inventory/card', {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({bin: activeBin, card_id, edition_id, foil_id, quantity: remaining})
            });
        } else {
            srcRes = await fetch('/api/inventory/card', {
                method: 'DELETE',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({bin: activeBin, card_id, edition_id, foil_id})
            });
        }

        if (!srcRes.ok) throw new Error('Failed to update source bin');

        // Update local state
        const srcBin = invBins[activeBin];
        if (partial) {
            srcBin.cards[card_id][edition_id][foil_id] = remaining;
            const srcRow = binCardRows.find(r => r.card_id === card_id && r.edition_id === edition_id && r.foil_id === foil_id);
            if (srcRow) srcRow.quantity = remaining;
        } else {
            delete srcBin.cards[card_id]?.[edition_id]?.[foil_id];
            if (srcBin.cards[card_id]?.[edition_id] && !Object.keys(srcBin.cards[card_id][edition_id]).length)
                delete srcBin.cards[card_id][edition_id];
            if (srcBin.cards[card_id] && !Object.keys(srcBin.cards[card_id]).length)
                delete srcBin.cards[card_id];
        }

        const tgt = invBins[targetBin];
        if (!tgt.cards[card_id]) tgt.cards[card_id] = {};
        if (!tgt.cards[card_id][edition_id]) tgt.cards[card_id][edition_id] = {};
        const existing = tgt.cards[card_id][edition_id][foil_id] || 0;
        tgt.cards[card_id][edition_id][foil_id] = existing + quantity;

        if (!partial) binCardRows = binCardRows.filter(r => !(r.card_id === card_id && r.edition_id === edition_id && r.foil_id === foil_id));

        closeMoveModal();
        renderBinCards();
        populateFilterMenus();

    } catch (err) {
        errEl.textContent = err.message || 'Move failed.';
        errEl.classList.remove('hidden');
    }
}

async function ctxMoveToNewBin() {
    const name = prompt('New bin name:')?.trim();
    if (!name) return;
    if (invBins[name]) {
        document.getElementById('move-modal-error').textContent = 'A bin with that name already exists.';
        document.getElementById('move-modal-error').classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch('/api/inventory/bins', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name, desc: ''})
        });
        if (!res.ok) throw new Error('Failed to create bin');
        invBins[name] = {default: false, desc: '', public: false, cards: {}};
        await executeMoveCard(name);
    } catch (err) {
        document.getElementById('move-modal-error').textContent = err.message || 'Failed.';
        document.getElementById('move-modal-error').classList.remove('hidden');
    }
}

// ═══════════════════════════════════════
// IMPORT / EXPORT
// ═══════════════════════════════════════

let importExportTab = 'import';

function openImportExportModal() {
    if (!activeBin) return;
    document.getElementById('import-export-bin-label').textContent = activeBin;
    document.getElementById('import-textarea').value = '';
    document.getElementById('export-textarea').value = '';
    document.getElementById('import-results').classList.add('hidden');
    document.getElementById('import-results').innerHTML = '';
    document.getElementById('import-submit-btn').textContent = 'Import';
    document.getElementById('import-submit-btn').disabled = false;
    switchImportExportTab('import');
    document.getElementById('inv-import-export-modal').classList.remove('hidden');

    // Pre-load export content
    loadExport();
}

function closeImportExportModal() {
    document.getElementById('inv-import-export-modal').classList.add('hidden');
}

function switchImportExportTab(tab) {
    importExportTab = tab;
    document.getElementById('import-tab-btn').classList.toggle('active', tab === 'import');
    document.getElementById('export-tab-btn').classList.toggle('active', tab === 'export');
    document.getElementById('import-panel').classList.toggle('hidden', tab !== 'import');
    document.getElementById('export-panel').classList.toggle('hidden', tab !== 'export');
}

async function loadExport() {
    const textarea = document.getElementById('export-textarea');
    textarea.value = 'Loading...';
    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}/export`);
        const data = await res.json();
        textarea.value = data.lines.join('\n');
    } catch {
        textarea.value = 'Failed to load export.';
    }
}

async function copyExport() {
    const textarea = document.getElementById('export-textarea');
    await navigator.clipboard.writeText(textarea.value);
    const btn = document.getElementById('export-copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => {
        btn.textContent = 'Copy to Clipboard';
    }, 1800);
}

async function submitImport() {
    const textarea = document.getElementById('import-textarea');
    const lines = textarea.value.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;

    const btn = document.getElementById('import-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Importing...';

    const resultsEl = document.getElementById('import-results');
    resultsEl.innerHTML = '';
    resultsEl.classList.add('hidden');

    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}/import`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({lines})
        });
        const data = await res.json();

        const successes = data.results.filter(r => r.ok);
        const failures = data.results.filter(r => !r.ok);

        let html = '';

        if (successes.length) {
            html += `<div class="inv-import-summary inv-import-summary--ok">✓ ${successes.length} line${successes.length !== 1 ? 's' : ''} imported successfully</div>`;
        }

        if (failures.length) {
            html += `<div class="inv-import-summary inv-import-summary--err">✕ ${failures.length} line${failures.length !== 1 ? 's' : ''} failed</div>`;
            html += failures.map(r =>
                `<div class="inv-import-error-line"><span class="inv-import-error-text">${r.error}</span><span class="inv-import-error-raw">${r.line}</span></div>`
            ).join('');
        }

        resultsEl.innerHTML = html;
        resultsEl.classList.remove('hidden');

        if (successes.length) {
            await enrichAndRenderBinCards(invBins[activeBin]);
            // Reload local bin state
            const invRes = await fetch('/api/inventory');
            if (invRes.ok) {
                const invData = await invRes.json();
                invBins = invData.bins || {};
            }
        }

        btn.textContent = 'Import Again';
        btn.disabled = false;
    } catch {
        resultsEl.innerHTML = '<div class="inv-import-summary inv-import-summary--err">Request failed.</div>';
        resultsEl.classList.remove('hidden');
        btn.textContent = 'Import';
        btn.disabled = false;
    }
}

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════

window.initInventory = async function () {
    if (!currentUser) return;
    await loadInventory();

    // Wire font scaling to static modal qty inputs
    ['move-qty', 'add-modal-qty', 'card-modal-qty'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => scaleQtyFont(el));
        scaleQtyFont(el);
    });
};
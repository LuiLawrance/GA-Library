// ── State ──
let invBins = {};
let activeBin = null;
let binCardRows = [];
let invBinPrices = {};
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
    const stats = countBinStats(bin.sections || {});
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
        <div class="inv-bin-meta-row">
            <div class="inv-bin-meta">${stats.cards} card${stats.cards !== 1 ? 's' : ''} · ${stats.copies} cop${stats.copies !== 1 ? 'ies' : 'y'}</div>
            <span class="inv-bin-value-badge inv-bin-value-loading">…</span>
        </div>`;
    if (bin.banner) {
        tile.classList.add('has-banner');
        const clip = document.createElement('div');
        clip.className = 'inv-bin-banner-clip';
        const bg = document.createElement('div');
        bg.className = 'inv-bin-banner';
        bg.style.backgroundImage = `url('/images/${encodeURIComponent(bin.banner)}.jpg')`;
        clip.appendChild(bg);
        tile.prepend(clip);
    }
    tile.onclick = () => openBinDetail(name);
    tile.addEventListener('contextmenu', e => {
        e.preventDefault();
        openBinContextMenu(e, name);
    });
    loadBinValue(name, tile.querySelector('.inv-bin-value-badge'));
    return tile;
}

async function loadBinValue(binName, badgeEl) {
    if (!badgeEl) return;

    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(binName)}/value`);
        if (!res.ok) throw new Error('Failed to load bin value');
        const data = await res.json();

        badgeEl.textContent = `$${data.total.toFixed(2)}`;
        badgeEl.classList.remove('inv-bin-value-loading');

        if (data.priced_quantity < data.total_quantity) {
            badgeEl.classList.add('inv-bin-value-partial');
        }

        // Stash the latest breakdown on the element and read it at hover time,
        // rather than attaching a fresh closure-bound listener on every call.
        // The bin-detail header's badge is a single persistent element that
        // loadBinValue() re-runs on every card/quantity edit (see
        // updateInvCounts), so re-attaching listeners here would stack up an
        // unbounded number of duplicate handlers over a session — unlike grid
        // tiles, which get a brand-new badge element on every render.
        badgeEl._binValueData = data;
        if (!badgeEl._binValueHoverWired) {
            badgeEl._binValueHoverWired = true;
            badgeEl.addEventListener('mouseenter', () => showBinValuePopup(badgeEl, badgeEl._binValueData));
            badgeEl.addEventListener('mouseleave', hideBinValuePopup);
        }
    } catch (err) {
        badgeEl.textContent = '—';
        badgeEl.classList.remove('inv-bin-value-loading');
    }
}

let _stackedTileFixEl = null;

function showBinValuePopup(badgeEl, data) {
    let popup = document.getElementById('inv-bin-value-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'inv-bin-value-popup';
        popup.className = 'inv-bin-value-popup hidden';
    }

    _restoreStackedTile();

    // Anchored with CSS (position:absolute against the badge's own row,
    // which has position:relative — see .inv-bin-meta-row and
    // .inv-detail-counts-row) instead of position:fixed + JS-computed
    // viewport coordinates. The page applies `zoom: 0.9` below 2100px
    // (main.css), and getBoundingClientRect()-based fixed-position math
    // doesn't agree with that zoom, producing a left-ward offset that grew
    // with distance from the page origin. Re-parenting the single shared
    // popup into whichever row is currently hovered keeps it in the same
    // coordinate space as the badge, so no viewport math is needed. Which
    // way it opens (up vs down) is decided purely by CSS based on which row
    // it's currently parented in — see .inv-bin-meta-row > .inv-bin-value-popup
    // in inventory.css. The tile's own banner clip lives on a dedicated
    // .inv-bin-banner-clip layer (see inventory.css) so the popup is never
    // cropped by it.
    const row = badgeEl.parentElement;
    row.appendChild(popup);

    const tile = row.closest('.inv-bin-tile');
    if (tile) {
        // Every tile gets its own stacking context from its entrance
        // animation (opacity/transform in @keyframes revealUp), so a
        // popup nested in an earlier-row tile paints BEHIND a later-row
        // tile's opaque background regardless of the popup's own z-index —
        // z-index only ranks siblings within the same stacking context.
        // Bumping the active tile's own z-index lifts its whole stacking
        // context (popup included) above its unhovered siblings.
        _stackedTileFixEl = tile;
        tile.classList.add('inv-bin-tile-popup-active');
    }

    const rows = [
        ['sale', 'Sale data', data.sale_quantity],
        ['listing', 'Listing data', data.listing_quantity],
        ['none', 'No data', data.unpriced_quantity],
    ];

    popup.innerHTML = rows.map(([kind, label, qty]) => `
        <div class="inv-bin-value-popup-row">
            <span class="inv-bin-value-popup-dot inv-bin-value-popup-dot-${kind}"></span>
            <span class="inv-bin-value-popup-label">${label}</span>
            <span class="inv-bin-value-popup-count">${qty}</span>
        </div>`).join('');

    popup.classList.remove('hidden');
}

function _restoreStackedTile() {
    if (_stackedTileFixEl) {
        _stackedTileFixEl.classList.remove('inv-bin-tile-popup-active');
        _stackedTileFixEl = null;
    }
}

function hideBinValuePopup() {
    document.getElementById('inv-bin-value-popup')?.classList.add('hidden');
    _restoreStackedTile();
}

function countBinEntries(sections) {
    let total = 0;
    for (const cards of Object.values(sections))
        for (const editions of Object.values(cards))
            for (const foils of Object.values(editions))
                for (const qty of Object.values(foils))
                    total += qty;
    return total;
}

function countBinStats(sections) {
    let cards = 0;
    let copies = 0;
    for (const cardsMap of Object.values(sections))
        for (const editions of Object.values(cardsMap))
            for (const foils of Object.values(editions))
                for (const qty of Object.values(foils)) {
                    cards += 1;
                    copies += qty;
                }
    return {cards, copies};
}

// ═══════════════════════════════════════
// BIN DETAIL
// ═══════════════════════════════════════

// ── Bin header inline editing (mirrors deck detail title/desc editing) ──

const INV_DESC_PLACEHOLDER = 'Add a description...';

function invRenderDetailName(name) {
    const el = document.getElementById('detail-bin-name');
    if (el) el.textContent = name;
}

function invRenderDetailDesc(desc) {
    const el = document.getElementById('detail-bin-meta');
    if (!el) return;
    if (desc) {
        el.textContent = desc;
        el.classList.remove('inv-detail-meta-placeholder');
    } else {
        el.textContent = INV_DESC_PLACEHOLDER;
        el.classList.add('inv-detail-meta-placeholder');
    }
}

function invWireDetailInlineEdit() {
    const nameEl = document.getElementById('detail-bin-name');
    const nameIcon = document.getElementById('detail-bin-name-edit-icon');
    const descEl = document.getElementById('detail-bin-meta');
    const descIcon = document.getElementById('detail-bin-meta-edit-icon');

    if (nameEl) {
        nameEl.onclick = () => invStartDetailInlineEdit('name');
        if (nameIcon) nameIcon.onclick = () => invStartDetailInlineEdit('name');
    }
    if (descEl) {
        descEl.onclick = () => invStartDetailInlineEdit('desc');
        if (descIcon) descIcon.onclick = () => invStartDetailInlineEdit('desc');
    }
}

function invStartDetailInlineEdit(field) {
    const isName = field === 'name';
    const labelEl = document.getElementById(isName ? 'detail-bin-name' : 'detail-bin-meta');
    if (!labelEl || labelEl.isContentEditable || !activeBin) return;

    const bin = invBins[activeBin] || {};
    const originalName = activeBin;
    const originalDesc = bin.desc || '';

    // Use the raw value (not the placeholder) as the starting edit content
    if (isName) {
        labelEl.textContent = originalName;
    } else {
        labelEl.textContent = originalDesc;
        labelEl.classList.remove('inv-detail-meta-placeholder');
    }

    labelEl.contentEditable = 'true';
    labelEl.classList.add('editing');
    labelEl.focus();

    // Place cursor at end
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(labelEl);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    // Description has a 100-char cap, matching the bin modals' maxlength
    const INV_DESC_MAXLENGTH = 100;

    function enforceDescLimit() {
        if (labelEl.textContent.length <= INV_DESC_MAXLENGTH) return;
        labelEl.textContent = labelEl.textContent.slice(0, INV_DESC_MAXLENGTH);
        const r = document.createRange();
        const s = window.getSelection();
        r.selectNodeContents(labelEl);
        r.collapse(false);
        s.removeAllRanges();
        s.addRange(r);
    }

    if (!isName) labelEl.addEventListener('input', enforceDescLimit);

    async function commit() {
        labelEl.contentEditable = 'false';
        labelEl.classList.remove('editing');
        let newValue = labelEl.textContent.trim();
        if (!isName && newValue.length > INV_DESC_MAXLENGTH) newValue = newValue.slice(0, INV_DESC_MAXLENGTH);

        if (isName) {
            if (!newValue || newValue === originalName) {
                invRenderDetailName(originalName);
                return;
            }
            if (invBins[newValue]) {
                invRenderDetailName(originalName);
                return;
            }
        } else {
            if (newValue === originalDesc) {
                invRenderDetailDesc(originalDesc);
                return;
            }
        }

        const payload = {
            name: isName ? newValue : activeBin,
            desc: isName ? originalDesc : newValue
        };

        try {
            const res = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}`, {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                if (isName) invRenderDetailName(originalName);
                else invRenderDetailDesc(originalDesc);
                return;
            }

            if (isName) {
                invBins[newValue] = invBins[originalName];
                delete invBins[originalName];
                activeBin = newValue;
                invRenderDetailName(newValue);
                window.history.replaceState({}, '', `/inventory?bin=${encodeURIComponent(newValue)}`);
                invWireDetailInlineEdit();
            } else {
                if (invBins[activeBin]) invBins[activeBin].desc = newValue;
                invRenderDetailDesc(newValue);
            }
        } catch {
            if (isName) invRenderDetailName(originalName);
            else invRenderDetailDesc(originalDesc);
        }
    }

    labelEl.addEventListener('blur', commit, {once: true});
    labelEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            labelEl.blur();
        }
        if (e.key === 'Escape') {
            labelEl.removeEventListener('blur', commit);
            labelEl.contentEditable = 'false';
            labelEl.classList.remove('editing');
            if (isName) invRenderDetailName(originalName);
            else invRenderDetailDesc(originalDesc);
        }
    });
}

async function openBinDetail(binName, pushUrl = true) {
    safeDiscardEditMode();
    activeBin = binName;
    binCardRows = [];
    const bin = invBins[binName];

    document.getElementById('inv-bins-view').classList.add('hidden');
    document.getElementById('inv-detail-view').classList.remove('hidden');

    invRenderDetailName(binName);
    invRenderDetailDesc(bin.desc || '');
    invWireDetailInlineEdit();
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

    if (pushUrl) window.history.pushState({}, '', `/inventory?bin=${encodeURIComponent(binName)}`);

    await enrichAndRenderBinCards(bin);
}

function closeBinDetail() {
    closeInvDrawer();
    safeDiscardEditMode();
    activeBin = null;
    binCardRows = [];
    document.getElementById('inv-detail-view').classList.add('hidden');
    document.getElementById('inv-bins-view').classList.remove('hidden');
    window.history.pushState({}, '', '/inventory');
    renderBinGrid();
}

async function enrichAndRenderBinCards(bin) {
    const sections = bin.sections || {};
    const rows = [];

    if (Object.keys(sections).length === 0) {
        binCardRows = [];
        invBinPrices = {};
        renderBinCards();
        return;
    }

    try {
        const [infoRes, slugRes, collectorRes, pricesRes] = await Promise.all([
            fetch('/api/inv/info'),
            fetch('/api/inv/slugs'),
            fetch('/api/inv/collector'),
            fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}/prices`)
        ]);
        const infoData = infoRes.ok ? await infoRes.json() : {};
        const slugData = slugRes.ok ? await slugRes.json() : {};
        const collectorData = collectorRes.ok ? await collectorRes.json() : {};
        invBinPrices = pricesRes.ok ? await pricesRes.json() : {};

        for (const [sectionName, cards] of Object.entries(sections))
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
                            section: sectionName,
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

function renderBinCards(animate = true) {
    const grid = document.getElementById('inv-card-grid');
    if (!grid) return;
    grid.classList.toggle('inv-no-anim', !animate);

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

    const sectionNames = Object.keys(invBins[activeBin]?.sections || {});
    const anyFilterActive = !!(filter || binFilters.set || binFilters.element || binFilters.rarity || binFilters.foil);

    if (sectionNames.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'inv-empty-grid';
        empty.innerHTML = `<span class="inv-empty-icon">⬡</span><p>No sections yet.</p><p class="inv-empty-sub">Add a section to get started.</p>`;
        grid.appendChild(empty);
    } else {
        for (const sectionName of sectionNames) {
            const sectionRows = rows.filter(r => r.section === sectionName);
            if (anyFilterActive && sectionRows.length === 0) continue;

            const block = document.createElement('div');
            block.className = 'dga-section-block';

            const sectionQty = sectionRows.reduce((s, r) => s + r.quantity, 0);
            const header = document.createElement('div');
            header.className = 'dga-section-header';
            header.innerHTML = `
                <span class="dga-section-label-group">
                    <span class="dga-section-label label dga-section-label-editable" title="Click to rename">${sectionName}</span><span class="dga-section-edit-icon">✎</span>
                </span>
                <span class="dga-section-count">${sectionQty} card${sectionQty !== 1 ? 's' : ''}</span>
                <div class="dga-section-header-actions">
                    <button class="dga-section-action-btn btn btn--subtle dga-section-action-delete" title="Delete section">✕</button>
                </div>`;
            const label = header.querySelector('.dga-section-label-editable');
            const pencil = header.querySelector('.dga-section-edit-icon');
            label.onclick = () => invStartSectionRename(label, sectionName);
            pencil.onclick = () => invStartSectionRename(label, sectionName);
            header.querySelector('.dga-section-action-delete').onclick = () => invDeleteSection(sectionName);
            block.appendChild(header);

            const sectionGrid = document.createElement('div');
            sectionGrid.className = 'inv-section-grid';
            sectionGrid.dataset.section = sectionName;
            invWireSectionDrop(sectionGrid);

            sectionRows.forEach((row, i) => {
                const tile = buildInvCardTile(row, i, sectionRows.length);
                const input = tile.querySelector('.inv-tile-qty-input');
                if (input) scaleQtyFont(input);
                sectionGrid.appendChild(tile);
            });

            const addTile = document.createElement('div');
            addTile.className = 'inv-card-add-tile';
            addTile.style.animationDelay = `${Math.min(sectionRows.length * 40, 640)}ms`;
            addTile.innerHTML = `<span class="inv-create-plus">+</span><span class="inv-create-label">Add Card</span>`;
            addTile.onclick = () => openAddModal(sectionName);
            sectionGrid.appendChild(addTile);

            block.appendChild(sectionGrid);
            grid.appendChild(block);
        }
    }

    grid.appendChild(invBuildAddSectionButton());

    _gridObserver.disconnect();
    _gridObserver.observe(grid, {childList: true, subtree: true});
    _observeIndicators();
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
        const section = input.dataset.section;
        const row = binCardRows.find(r => r.card_id === cardId && r.edition_id === editionId && r.foil_id === foilId && r.section === section);
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
    // Deck tiles route to the deck edit mode
    if (input.closest('.dga-card-tile') && typeof dgaDeckEditMode !== 'undefined') {
        dgaDeckEditMode.stage(input, originalValue);
        return;
    }
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
        section: input.dataset.section,
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
                    section: c.section,
                    card_id: c.cardId,
                    edition_id: c.editionId,
                    foil_id: c.foilId,
                    quantity: c.quantity
                })
            });
            if (invBins[activeBin]?.sections?.[c.section]?.[c.cardId]?.[c.editionId]) {
                invBins[activeBin].sections[c.section][c.cardId][c.editionId][c.foilId] = c.quantity;
            }
            const row = binCardRows.find(r => r.card_id === c.cardId && r.edition_id === c.editionId && r.foil_id === c.foilId && r.section === c.section);
            if (row) row.quantity = c.quantity;
            // Update badge on the existing tile
            const tile = document.querySelector(
                `.inv-card-tile[data-card-id="${c.cardId}"][data-edition-id="${c.editionId}"][data-foil-id="${c.foilId}"][data-section="${c.section}"]`
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
                body: JSON.stringify({
                    bin: activeBin,
                    section: c.section,
                    card_id: c.cardId,
                    edition_id: c.editionId,
                    foil_id: c.foilId
                })
            });
            const cards = invBins[activeBin].sections?.[c.section] || {};
            delete cards[c.cardId]?.[c.editionId]?.[c.foilId];
            if (cards[c.cardId]?.[c.editionId] && !Object.keys(cards[c.cardId][c.editionId]).length) delete cards[c.cardId][c.editionId];
            if (cards[c.cardId] && !Object.keys(cards[c.cardId]).length) delete cards[c.cardId];
            binCardRows = binCardRows.filter(r => !(r.card_id === c.cardId && r.edition_id === c.editionId && r.foil_id === c.foilId && r.section === c.section));
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
    const section = input.dataset.section;

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
                body: JSON.stringify({bin: activeBin, section, card_id: cardId, edition_id: editionId, foil_id: foilId})
            });
            const cards = invBins[activeBin].sections?.[section] || {};
            delete cards[cardId]?.[editionId]?.[foilId];
            if (cards[cardId]?.[editionId] && !Object.keys(cards[cardId][editionId]).length) delete cards[cardId][editionId];
            if (cards[cardId] && !Object.keys(cards[cardId]).length) delete cards[cardId];
            binCardRows = binCardRows.filter(r => !(r.card_id === cardId && r.edition_id === editionId && r.foil_id === foilId && r.section === section));
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
            body: JSON.stringify({
                bin: activeBin,
                section,
                card_id: cardId,
                edition_id: editionId,
                foil_id: foilId,
                quantity
            })
        });
        if (invBins[activeBin]?.sections?.[section]?.[cardId]?.[editionId]) {
            invBins[activeBin].sections[section][cardId][editionId][foilId] = quantity;
        }
        const row = binCardRows.find(r => r.card_id === cardId && r.edition_id === editionId && r.foil_id === foilId && r.section === section);
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

    const valueBadge = document.getElementById('detail-bin-value');
    if (valueBadge && activeBin) {
        valueBadge.textContent = '…';
        valueBadge.classList.add('inv-bin-value-loading');
        valueBadge.classList.remove('inv-bin-value-partial');
        loadBinValue(activeBin, valueBadge);
    }
}

// ── Section CRUD ──

function invBuildAddSectionButton() {
    const btn = document.createElement('button');
    btn.className = 'dga-add-section-btn';
    btn.innerHTML = '+ Add Section';
    btn.onclick = () => {
        const input = document.createElement('input');
        input.className = 'dga-add-section-btn inv-add-section-input';
        input.placeholder = 'Section name...';
        input.maxLength = 50;
        btn.replaceWith(input);
        input.focus();
        const cancel = () => input.replaceWith(invBuildAddSectionButton());
        input.addEventListener('keydown', async e => {
            if (e.key === 'Escape') cancel();
            if (e.key !== 'Enter') return;
            const name = input.value.trim();
            if (!name) return cancel();
            try {
                const res = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}/section`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({section: name})
                });
                if (!res.ok) return cancel();
                (invBins[activeBin].sections ??= {})[name] = {};
                renderBinCards();
            } catch {
                cancel();
            }
        });
        input.addEventListener('blur', cancel);
    };
    return btn;
}

function invStartSectionRename(labelEl, sectionName) {
    if (labelEl.isContentEditable) return;
    labelEl.contentEditable = 'true';
    labelEl.classList.add('editing');
    labelEl.focus();
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(labelEl);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    async function commit() {
        labelEl.contentEditable = 'false';
        labelEl.classList.remove('editing');
        const newName = labelEl.textContent.trim();
        if (!newName || newName === sectionName) {
            labelEl.textContent = sectionName;
            return;
        }
        if (invBins[activeBin]?.sections?.[newName] !== undefined) {
            labelEl.textContent = sectionName;
            return;
        }
        try {
            const res = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}/section/${encodeURIComponent(sectionName)}/rename`, {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: newName})
            });
            if (!res.ok) {
                labelEl.textContent = sectionName;
                return;
            }
            const bin = invBins[activeBin];
            bin.sections = Object.fromEntries(
                Object.entries(bin.sections).map(([k, v]) => [k === sectionName ? newName : k, v]));
            binCardRows.forEach(r => {
                if (r.section === sectionName) r.section = newName;
            });
            renderBinCards();
        } catch {
            labelEl.textContent = sectionName;
        }
    }

    labelEl.addEventListener('blur', commit, {once: true});
    labelEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            labelEl.blur();
        }
        if (e.key === 'Escape') {
            labelEl.removeEventListener('blur', commit);
            labelEl.contentEditable = 'false';
            labelEl.classList.remove('editing');
            labelEl.textContent = sectionName;
        }
    });
}

async function invDeleteSection(sectionName) {
    if (!activeBin) return;
    const count = binCardRows.filter(r => r.section === sectionName).length;
    if (count > 0 && !await appConfirm(`Delete section "${sectionName}" and its ${count} card entr${count !== 1 ? 'ies' : 'y'}?`, {title: 'Delete Section'})) return;
    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}/section/${encodeURIComponent(sectionName)}`, {
            method: 'DELETE'
        });
        if (!res.ok) return;
        delete invBins[activeBin].sections[sectionName];
        binCardRows = binCardRows.filter(r => r.section !== sectionName);
        renderBinCards();
    } catch {
        console.error('Failed to delete section');
    }
}

// ── Cross-section drag (move-focused: drop a card on another section) ──

let invDragRow = null;

function invWireTileDrag(tile, row) {
    tile.draggable = true;
    const qtyBox = tile.querySelector('.inv-card-tile-qty-ctrl');
    if (qtyBox) {
        qtyBox.addEventListener('mousedown', e => {
            if (e.target.closest('button, input')) tile.draggable = false;
        });
        document.addEventListener('mouseup', () => {
            tile.draggable = true;
        });
    }
    tile.addEventListener('dragstart', e => {
        invDragRow = row;
        tile.classList.add('dga-dragging');
        document.body.classList.add('dga-drag-active');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.card_id);
        const rect = tile.getBoundingClientRect();
        const ghost = tile.cloneNode(true);
        ghost.querySelector('.inv-card-tile-overlay')?.remove();
        ghost.querySelector('.inv-card-tile-qty-ctrl')?.remove();
        ghost.style.cssText = `position: fixed; top: -9999px; left: -9999px;` +
            `width: ${rect.width}px; height: ${rect.height}px;` +
            `margin: 0; animation: none; opacity: 1; pointer-events: none;`;
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, rect.width / 2, rect.height / 2);
        tile._invDragGhost = ghost;
    });
    tile.addEventListener('dragend', () => {
        tile.classList.remove('dga-dragging');
        document.body.classList.remove('dga-drag-active');
        tile._invDragGhost?.remove();
        tile._invDragGhost = null;
        invDragRow = null;
        document.querySelectorAll('.inv-section-grid.inv-drop-target')
            .forEach(g => g.classList.remove('inv-drop-target'));
    });
}

function invWireSectionDrop(sectionGrid) {
    sectionGrid.addEventListener('dragover', e => {
        if (!invDragRow) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const isTarget = sectionGrid.dataset.section !== invDragRow.section;
        document.querySelectorAll('.inv-section-grid.inv-drop-target')
            .forEach(g => {
                if (g !== sectionGrid) g.classList.remove('inv-drop-target');
            });
        sectionGrid.classList.toggle('inv-drop-target', isTarget);
    });
    sectionGrid.addEventListener('dragleave', e => {
        if (!sectionGrid.contains(e.relatedTarget)) sectionGrid.classList.remove('inv-drop-target');
    });
    sectionGrid.addEventListener('drop', e => {
        if (!invDragRow) return;
        e.preventDefault();
        sectionGrid.classList.remove('inv-drop-target');
        invCommitSectionMove(invDragRow, sectionGrid.dataset.section);
    });
}

function invCommitSectionMove(row, toSection) {
    if (!activeBin || !toSection || toSection === row.section) return;
    const fromSection = row.section;
    const {card_id, edition_id, foil_id} = row;

    // Optimistic local move
    const sections = invBins[activeBin].sections;
    const srcCards = sections[fromSection];
    if (srcCards?.[card_id]?.[edition_id]?.[foil_id] !== undefined) {
        const qty = srcCards[card_id][edition_id][foil_id];
        delete srcCards[card_id][edition_id][foil_id];
        if (!Object.keys(srcCards[card_id][edition_id]).length) delete srcCards[card_id][edition_id];
        if (!Object.keys(srcCards[card_id]).length) delete srcCards[card_id];
        const dst = sections[toSection] ??= {};
        dst[card_id] ??= {};
        dst[card_id][edition_id] ??= {};
        dst[card_id][edition_id][foil_id] = (dst[card_id][edition_id][foil_id] || 0) + qty;
    }
    // Merge rows if the same entry already exists in the target section
    const existingRow = binCardRows.find(r =>
        r !== row && r.section === toSection && r.card_id === card_id &&
        r.edition_id === edition_id && r.foil_id === foil_id);
    if (existingRow) {
        existingRow.quantity += row.quantity;
        binCardRows = binCardRows.filter(r => r !== row);
    } else {
        row.section = toSection;
    }
    renderBinCards(false);

    fetch('/api/inventory/card/move', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            bin: activeBin, card_id, edition_id, foil_id,
            from_section: fromSection, to_section: toSection
        })
    }).then(res => {
        if (!res.ok) enrichAndRenderBinCards(invBins[activeBin]);
    }).catch(() => enrichAndRenderBinCards(invBins[activeBin]));
}

function buildInvCardTile(row, index, total = 1) {
    const rarity = rarityMapInv[row.rarity] || '';
    const rarityClass = rarity ? `rarity-${rarity.toLowerCase()}` : '';

    const tile = document.createElement('div');
    tile.className = 'inv-card-tile tile-hoverable';
    const maxDelay = 600;
    const delay = total <= 1 ? 0 : Math.min(index * 40, Math.round((index / (total - 1)) * maxDelay));
    tile.style.animationDelay = `${delay}ms`;
    tile.dataset.cardId = row.card_id;
    tile.dataset.editionId = row.edition_id;
    tile.dataset.foilId = row.foil_id;
    tile.dataset.section = row.section;
    invWireTileDrag(tile, row);

    const uid = `${row.card_id}-${row.edition_id}-${row.foil_id}`;
    const priceEntry = invBinPrices[row.card_id]?.[row.edition_id]?.[row.foil_id];
    const lastPrice = priceEntry?.price;
    const lowestListing = priceEntry?.lowest_listing;

    tile.innerHTML = `
        <div class="edition-tile-wrap tile-zoom">
            <div class="tile-img-spinner">${TILE_SPINNER_SVG}</div>
            <img alt="${row.cardName}"
                onload="revealTileImage(this)"
                onerror="this.style.opacity='0.1'; revealTileImage(this)">
            <div class="card-tile-dim"></div>
            ${rarity ? `<span class="edition-rarity-badge ${rarityClass}${getFoilSuffix(row) ? ' has-foil-suffix' : ''}">${rarity}${getFoilSuffix(row)}</span>` : ''}
        </div>
        ${priceBadgesHTML(lastPrice, lowestListing)}
        <span class="inv-qty-badge">x${row.quantity}</span>
        <div class="inv-card-tile-overlay">
            <div class="inv-card-tile-info">
                <div class="inv-card-tile-name">${row.cardName}</div>
                <div class="inv-card-tile-foil">${row.foilKind}</div>
            </div>
        </div>
        <div class="inv-card-tile-qty-ctrl">
            <button class="inv-tile-qty-btn btn btn--icon inv-tile-qty-add" onclick="event.stopPropagation(); tileQtyChange(this, 1)">+</button>
            <input class="inv-tile-qty-input" type="number" value="${row.quantity}" min="0" max="999"
                data-card-id="${row.card_id}"
                data-edition-id="${row.edition_id}"
                data-foil-id="${row.foil_id}"
                data-section="${row.section}"
                onchange="tileQtySet(this)"
                oninput="scaleQtyFont(this)"
                onclick="event.stopPropagation()"
                onfocus="this.select()">
            <button class="inv-tile-qty-btn btn btn--icon inv-tile-qty-sub" onclick="event.stopPropagation(); tileQtyChange(this, -1)">−</button>
        </div>
        <div class="inv-tile-qty-indicator"></div>`;

    tile.addEventListener('click', () => openInvDrawer(row.card_id, row.edition_id, row.cardName));
    tile.addEventListener('contextmenu', e => {
        e.preventDefault();
        openCardContextMenu(e, row);
    });
    tile.addEventListener('animationend', () => tile.classList.add('animated'));

    // Queued (tiles.js) — see the matching comment in buildCardTile (cards.js).
    queueTileImageLoad(tile.querySelector('.edition-tile-wrap img'), `/images/${row.edition_id}.jpg`);

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

let invAddTargetSection = null;

// Populate the add-modal's section dropdown; pre-select the section whose
// + tile opened the modal, falling back to the bin's first section/Unsorted
function invPopulateAddSectionDropdown() {
    const menu = document.getElementById('inv-add-section-menu');
    const label = document.getElementById('inv-add-section-label');
    const hidden = document.getElementById('inv-add-section');
    if (!menu || !label || !hidden) return;

    const sections = Object.keys(invBins[activeBin]?.sections || {});
    const options = sections.length ? sections : ['Unsorted'];
    const preSelect = invAddTargetSection && options.includes(invAddTargetSection)
        ? invAddTargetSection
        : options[0];

    menu.innerHTML = '';
    options.forEach(s => {
        const opt = document.createElement('div');
        opt.className = `dga-fmt-dropdown-option${s === preSelect ? ' selected' : ''}`;
        opt.dataset.value = s;
        opt.textContent = s;
        opt.onclick = () => {
            hidden.value = s;
            label.textContent = s;
            menu.querySelectorAll('.dga-fmt-dropdown-option').forEach(o => o.classList.toggle('selected', o === opt));
            menu.classList.add('hidden');
            document.getElementById('inv-add-section-btn').classList.remove('open');
        };
        menu.appendChild(opt);
    });
    hidden.value = preSelect;
    label.textContent = preSelect;
}

function toggleInvAddSectionDropdown() {
    const menu = document.getElementById('inv-add-section-menu');
    const btn = document.getElementById('inv-add-section-btn');
    const open = !menu.classList.contains('hidden');
    if (!open) openSectionDropdownFixed(menu, btn);
    menu.classList.toggle('hidden', open);
    btn.classList.toggle('open', !open);
}

function openAddModal(sectionName = null) {
    invAddTargetSection = sectionName;
    invPopulateAddSectionDropdown();
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
    // Closing mid-resize shouldn't leave a stale animation holding the box at the wrong
    // size for next time — it uses fill:'forwards' so it keeps holding even while hidden.
    resetBoxResize(document.querySelector('#inv-add-modal .inv-modal-wide'));
}

// Thin adapter over the shared animateBoxResize() for this modal's box.
function animateAddModalResize(mutate) {
    animateBoxResize(document.querySelector('#inv-add-modal .inv-modal-wide'), mutate);
}

function backToSearch() {
    if (document.getElementById('add-step-foil').classList.contains('hidden')) return;
    animateAddModalResize(() => {
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
    });
    setTimeout(() => document.getElementById('add-card-search').focus(), 40);
}

async function searchAddCards() {
    const query = document.getElementById('add-card-search')?.value?.trim();
    const results = document.getElementById('add-card-results');
    if (!results || !query) return;

    // A prior search may have widened the grid to fit multiple result columns — reset it
    // before showing a single-message placeholder, or the placeholder inherits that stale
    // width instead of shrinking back down to its natural size.
    const resetResultsGrid = () => {
        results.style.gridTemplateColumns = '';
        results.classList.remove('has-scroll');
    };

    animateAddModalResize(() => {
        resetResultsGrid();
        results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Searching...</p></div>`;
    });

    try {
        const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();

        if (!data.cards?.length) {
            animateAddModalResize(() => {
                resetResultsGrid();
                results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>${data.message || 'No cards found.'}</p></div>`;
            });
            return;
        }

        // Single unique card — skip grid, go straight to foil picker
        const uniqueIds = new Set(data.cards.map(c => c.card_id));
        if (uniqueIds.size === 1) {
            const card = data.cards[0];
            await goToFoilStep(card.card_id, card.edition_id, card.name);
            return;
        }

        // Multiple distinct cards — show grid so user picks one. The tile images reserve
        // their aspect ratio via CSS (aspect-ratio: 5/7 on .inv-search-tile img), so the
        // grid's height is known immediately without waiting on images to load.
        animateAddModalResize(() => {
            results.innerHTML = '';
            const cols = Math.min(data.cards.length, 5);
            results.style.gridTemplateColumns = `repeat(${cols}, 255px)`;
            results.classList.toggle('has-scroll', data.cards.length >= 6);

            data.cards.forEach((card, i) => {
                const rarity = rarityMapInv[card.rarity] || '';
                const rarityClass = rarity ? `rarity-${rarity.toLowerCase()}` : '';
                const tile = document.createElement('div');
                tile.className = 'inv-search-tile tile-hoverable';
                tile.style.animationDelay = `${Math.min(i, 20) * 30}ms`;
                tile.innerHTML = `
                    <div class="edition-tile-wrap tile-zoom">
                        <img src="/images/${card.edition_id}.jpg" alt="${card.name}">
                        <div class="card-tile-dim"></div>
                        <div class="inv-search-tile-add tile-action-btn">+</div>
                    </div>`;
                tile.onclick = () => goToFoilStep(card.card_id, card.edition_id, card.name);
                tile.addEventListener('animationend', () => tile.classList.add('animated'));
                results.appendChild(tile);
            });
        });
    } catch {
        animateAddModalResize(() => {
            resetResultsGrid();
            results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Search failed.</p></div>`;
        });
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

    // The foils list area is capped/scrollable within the foil step's fixed-height
    // container (.inv-modal-foils { overflow-y: auto } inside the 380px-tall
    // .inv-foil-step-body), so the box's own size is fully determined right here —
    // populating the foils list further down (async, after fetch) never changes it.
    animateAddModalResize(() => {
        document.getElementById('add-step-search').classList.add('hidden');
        document.getElementById('add-step-foil').classList.remove('hidden');
        document.getElementById('add-back-btn').classList.remove('hidden');
        document.querySelector('#inv-add-modal .inv-modal-wide').classList.add('inv-modal-foil-step');
    });

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
                const variants = finfo.variants || {};

                // Some cards (e.g. "Lunar Conduit", RDOA) are printed ONLY as
                // their special Curio Foil (Quicksilver/Aurora/Interference/
                // etc.) — no separate Nonfoil/Foil product was ever made, so
                // the variant's population accounts for the parent foil's
                // entire population. Offering that parent as a selectable
                // option then just points at a print that doesn't exist —
                // skip it and show only the Curio Foil. Same rule as
                // _curio_foil_id_for_edition / api_admin_pricing_foils in
                // app.py.
                const variantPopulation = Object.values(variants).reduce((sum, v) => sum + (v.population || 0), 0);
                // A null population means the API hasn't reported circulation data yet
                // (a TEMP_FOIL_ID placeholder edition) — still offer it so the foil stays
                // selectable, same as _sync_info in pricing_ga.py treats it.
                const remainingPopulation = finfo.population == null ? null : finfo.population - variantPopulation;

                if (remainingPopulation === null || remainingPopulation > 0) {
                    const opt = buildFoilOption(eid, fid, finfo.kind, einfo.set_prefix, rarity, einfo.collector_number, false, finfo.population == null);
                    if (!firstOpt) firstOpt = {opt, eid, fid};
                    foilList.appendChild(opt);
                }

                Object.entries(variants).forEach(([vid, vinfo]) => {
                    const vopt = buildFoilOption(eid, vid, vinfo.kind, einfo.set_prefix, rarity, einfo.collector_number, true);
                    if (!firstOpt) firstOpt = {opt: vopt, eid, fid: vid};
                    foilList.appendChild(vopt);
                });
            });
        });

        if (firstOpt) selectFoilOption(firstOpt.opt, firstOpt.eid, firstOpt.fid);
    } catch {
        document.getElementById('add-modal-foils').innerHTML = '<div style="font-size:0.78rem;color:var(--error);">Failed to load editions.</div>';
    }
}

function buildFoilOption(editionId, foilId, kind, setPrefix, rarity, collectorNum, isVariant, isTemp = false) {
    const label = kind ? kind.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'Standard';
    const opt = document.createElement('div');
    opt.className = 'inv-foil-option';
    opt.dataset.editionId = editionId;
    opt.dataset.foilId = foilId;
    opt.innerHTML = `
        <div class="inv-foil-left">
            <div class="inv-foil-name">${label}${isVariant ? ' <span style="opacity:0.5;font-size:0.85em">(variant)</span>' : ''}${isTemp ? ' <span class="inv-foil-temp-badge" title="No circulation data reported yet — this printing is a placeholder until the official foil ID is assigned">TEMP</span>' : ''}</div>
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
                section: document.getElementById('inv-add-section')?.value || invAddTargetSection || 'Unsorted',
                card_id: addModalCardId,
                edition_id: addModalEditionId,
                foil_id: addModalFoilId,
                quantity
            })
        });

        if (res.ok) {
            const bin = invBins[activeBin];
            const chosenSection = document.getElementById('inv-add-section')?.value || invAddTargetSection || 'Unsorted';
            const sec = bin.sections[chosenSection] ??= {};
            if (!sec[addModalCardId]) sec[addModalCardId] = {};
            if (!sec[addModalCardId][addModalEditionId]) sec[addModalCardId][addModalEditionId] = {};
            const existing = sec[addModalCardId][addModalEditionId][addModalFoilId] || 0;
            sec[addModalCardId][addModalEditionId][addModalFoilId] = existing + quantity;

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

    // Only offer Clear Banner when the bin has one
    const clearBannerBtn = document.getElementById('ctx-clear-banner');
    if (clearBannerBtn) clearBannerBtn.style.display = invBins[binName]?.banner ? '' : 'none';

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
    if (!await appConfirm(`Delete bin "${name}"? All cards inside will be removed.`, {title: 'Delete Bin'})) return;

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

async function ctxClearBanner() {
    if (!ctxTargetBin) return;
    const name = ctxTargetBin;
    closeBinContextMenu();
    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(name)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({banner: null})
        });
        if (!res.ok) return;
        if (invBins[name]) invBins[name].banner = null;
        renderBinGrid();
    } catch {
        console.error('Failed to clear banner');
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
            invBins[name] = {banner: null, default: false, desc, symbol: null, tags: null, sections: {}};
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
    const overlay = document.getElementById('inv-settings-modal');
    overlay.classList.add('hidden');
    // Undo the entrance-animation suppression a back-from-import/export morph may have left
    // on the settings box, so it gets its normal reveal animation again next time it opens.
    overlay.querySelector('.inv-modal:not(.inv-modal-import-export)')?.classList.remove('morph-resizing');
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
            invRenderDetailName(name);
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
            invRenderDetailName(activeBin);
            invRenderDetailDesc(desc);
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
    if (!await appConfirm(`Delete bin "${activeBin}"? Cards inside will be removed.`, {title: 'Delete Bin'})) return;
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
//
// The inventory bin page uses the same #card-drawer component as every other
// page, just mounted at #inv-card-drawer — all of the open/close/edition-select
// behavior lives once in drawer.js (openDrawer/closeDrawer/selectDrawerEditionFor
// + DRAWER_CONFIG), so a fix or change there applies here automatically instead
// of needing to be copied over by hand.

let selectedInvCardId = null;
let invDrawerActiveTab = 'info';
let invDrawerIsOpen = false;

function openInvDrawer(cardId, editionId, cardName) {
    return openDrawer('inv-card-drawer', cardId, editionId, cardName);
}

function closeInvDrawer() {
    closeDrawer('inv-card-drawer');
}

function selectInvDrawerEdition(editionId) {
    return selectDrawerEditionFor('inv-card-drawer', editionId);
}


// ═══════════════════════════════════════
// CARD CONTEXT MENU
// ═══════════════════════════════════════

let ctxCardRow = null;

function openCardContextMenu(e, row) {
    ctxCardRow = row;
    const isCurrent = invBins[activeBin]?.banner === row.edition_id;
    const label = document.getElementById('inv-ctx-banner-label');
    if (label) label.textContent = isCurrent ? 'Remove Banner' : 'Set as Banner';
    const menu = document.getElementById('inv-card-context-menu');
    menu.classList.remove('hidden');
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 60);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
}

async function ctxCardBanner() {
    if (!ctxCardRow || !activeBin) return;
    const editionId = ctxCardRow.edition_id;
    closeCardContextMenu();

    // Right-clicking the current banner card removes the banner
    const banner = invBins[activeBin]?.banner === editionId ? null : editionId;

    try {
        const res = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({banner})
        });
        if (!res.ok) return;
        if (invBins[activeBin]) invBins[activeBin].banner = banner;
    } catch {
        console.error('Failed to update banner');
    }
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
    moveTargetBin = null;
    moveTargetSection = null;
    document.getElementById('move-section-block').classList.add('hidden');
    document.getElementById('move-confirm-btn').classList.add('hidden');

    // The current bin is included — section-to-section moves within a bin
    Object.entries(invBins).forEach(([name, bin]) => {
        const count = countBinEntries(bin.sections || {});
        const isCurrent = name === activeBin;
        const btn = document.createElement('button');
        btn.className = 'inv-move-bin-option';
        btn.dataset.bin = name;
        btn.innerHTML = `
            <span>${name}${bin.default ? ' <span style="color:var(--accent);font-size:0.65rem">(default)</span>' : ''}${isCurrent ? ' <span style="color:var(--text-muted);font-size:0.65rem">(this bin)</span>' : ''}</span>
            <span class="inv-move-bin-option-meta">${count} card${count !== 1 ? 's' : ''}</span>`;
        btn.onclick = () => moveSelectBin(name);
        list.appendChild(btn);
    });

    document.getElementById('inv-move-modal').classList.remove('hidden');
}

let moveTargetBin = null;
let moveTargetSection = null;

function moveSelectBin(binName) {
    moveTargetBin = binName;
    moveTargetSection = null;
    document.querySelectorAll('#move-bin-list .inv-move-bin-option')
        .forEach(b => b.classList.toggle('active', b.dataset.bin === binName));

    // Build the section list for the chosen bin
    const sections = Object.keys(invBins[binName]?.sections || {});
    const options = sections.length ? sections : ['Unsorted'];
    const secList = document.getElementById('move-section-list');
    secList.innerHTML = '';
    options.forEach(sec => {
        const isSource = binName === activeBin && sec === moveRow?.section;
        const btn = document.createElement('button');
        btn.className = 'inv-move-bin-option';
        btn.dataset.section = sec;
        btn.disabled = isSource;
        btn.innerHTML = `<span>${sec}${isSource ? ' <span style="color:var(--text-muted);font-size:0.65rem">(current)</span>' : ''}</span>`;
        if (!isSource) btn.onclick = () => moveSelectSection(sec);
        secList.appendChild(btn);
    });
    document.getElementById('move-section-block').classList.remove('hidden');
    document.getElementById('move-confirm-btn').classList.add('hidden');
}

function moveSelectSection(sectionName) {
    moveTargetSection = sectionName;
    document.querySelectorAll('#move-section-list .inv-move-bin-option')
        .forEach(b => b.classList.toggle('active', b.dataset.section === sectionName));
    document.getElementById('move-confirm-btn').classList.remove('hidden');
}

function confirmMoveCard() {
    if (!moveTargetBin || !moveTargetSection) return;
    executeMoveCard(moveTargetBin, moveTargetSection);
}

function closeMoveModal() {
    document.getElementById('inv-move-modal').classList.add('hidden');
    moveRow = null;
}

async function executeMoveCard(targetBin, targetSection = null) {
    if (!moveRow || !activeBin) return;
    const {card_id, edition_id, foil_id, section} = moveRow;
    targetSection = targetSection || section; // legacy path: same-named section
    if (targetBin === activeBin && targetSection === section) return; // true no-op
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
            body: JSON.stringify({bin: targetBin, section: targetSection, card_id, edition_id, foil_id, quantity})
        });

        if (!addRes.ok) throw new Error('Failed to add to target bin');

        // Remove or reduce from current bin
        const remaining = maxQty - quantity;
        let srcRes;
        if (partial) {
            srcRes = await fetch('/api/inventory/card', {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({bin: activeBin, section, card_id, edition_id, foil_id, quantity: remaining})
            });
        } else {
            srcRes = await fetch('/api/inventory/card', {
                method: 'DELETE',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({bin: activeBin, section, card_id, edition_id, foil_id})
            });
        }

        if (!srcRes.ok) throw new Error('Failed to update source bin');

        // Update local state — target lands in a same-named section (server auto-creates)
        const srcCards = invBins[activeBin].sections?.[section] || {};
        if (partial) {
            if (srcCards[card_id]?.[edition_id]) srcCards[card_id][edition_id][foil_id] = remaining;
            const srcRow = binCardRows.find(r => r.card_id === card_id && r.edition_id === edition_id && r.foil_id === foil_id && r.section === section);
            if (srcRow) srcRow.quantity = remaining;
        } else {
            delete srcCards[card_id]?.[edition_id]?.[foil_id];
            if (srcCards[card_id]?.[edition_id] && !Object.keys(srcCards[card_id][edition_id]).length)
                delete srcCards[card_id][edition_id];
            if (srcCards[card_id] && !Object.keys(srcCards[card_id]).length)
                delete srcCards[card_id];
        }

        const tgt = invBins[targetBin];
        tgt.sections ??= {};
        const tgtCards = tgt.sections[targetSection] ??= {};
        if (!tgtCards[card_id]) tgtCards[card_id] = {};
        if (!tgtCards[card_id][edition_id]) tgtCards[card_id][edition_id] = {};
        const existing = tgtCards[card_id][edition_id][foil_id] || 0;
        tgtCards[card_id][edition_id][foil_id] = existing + quantity;

        if (!partial) binCardRows = binCardRows.filter(r => !(r.card_id === card_id && r.edition_id === edition_id && r.foil_id === foil_id && r.section === section));

        closeMoveModal();
        if (targetBin === activeBin) {
            // Same-bin section move: rebuild rows so the card appears in its new section
            await enrichAndRenderBinCards(invBins[activeBin]);
        } else {
            renderBinCards();
        }
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
        invBins[name] = {banner: null, default: false, desc: '', symbol: null, tags: null, sections: {}};
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

function transitionSettingsToImportExport() {
    if (!activeBin) return;

    const ieBoxAlready = document.querySelector('.inv-modal-import-export');
    const overlay = document.getElementById('inv-settings-modal');

    // Guard against a double-click (or any re-entrant call) firing this a second time:
    // once the box has been borrowed into the settings overlay, it becomes a *second*
    // '.inv-modal' sibling there, so a naive re-lookup below would grab the original
    // (now hidden, zero-size) settings box as the animation's "from" size and scale the
    // real box down to nothing — the delayed flash a double-click would otherwise produce.
    if (ieBoxAlready.parentElement === overlay) return;

    // The settings overlay is already open (its backdrop is fully composited), so the
    // resize morph reparents the import/export box into it instead of revealing a second
    // overlay — swapping overlays mid-transition causes a post-animation flash, since a
    // freshly-shown backdrop-filter element needs an extra frame to composite.
    const settingsBox = overlay.querySelector('.inv-modal:not(.inv-modal-import-export)');
    const fromRect = settingsBox.getBoundingClientRect();

    document.getElementById('import-export-bin-label').textContent = activeBin;
    document.getElementById('import-textarea').value = '';
    document.getElementById('export-textarea').value = '';
    document.getElementById('import-results').classList.add('hidden');
    document.getElementById('import-results').innerHTML = '';
    document.getElementById('import-submit-btn').textContent = 'Import';
    document.getElementById('import-submit-btn').disabled = false;
    switchImportExportTab('import');

    const ieBox = ieBoxAlready;
    settingsBox.classList.add('hidden');
    overlay.appendChild(ieBox);
    overlay.onclick = closeImportExportModal;
    morphBoxIn(ieBox, fromRect);

    loadExport();
}

function transitionImportExportToSettings() {
    const overlay = document.getElementById('inv-settings-modal');
    const ieBox = document.querySelector('.inv-modal-import-export');

    // Only meaningful once the box has actually been borrowed into the settings overlay
    // (i.e. we got here via the forward morph) — otherwise there's nowhere to "go back" to.
    if (ieBox.parentElement !== overlay) return;

    const settingsBox = overlay.querySelector('.inv-modal:not(.inv-modal-import-export)');
    const fromRect = {width: ieBox.offsetWidth, height: ieBox.offsetHeight};

    resetBoxResize(ieBox);
    resetMorphBox(ieBox);

    // Swap content immediately — settings becomes the visible box, import/export goes back
    // to its home overlay — then fake the "shrink" the same way the forward morph fakes the
    // "grow".
    const homeOverlay = document.getElementById('inv-import-export-modal');
    homeOverlay.appendChild(ieBox);
    homeOverlay.classList.add('hidden');
    overlay.onclick = closeBinSettings;
    settingsBox.classList.remove('hidden');
    morphBoxIn(settingsBox, fromRect);
}

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
    const homeOverlay = document.getElementById('inv-import-export-modal');
    const ieBox = document.querySelector('.inv-modal-import-export');

    // Closing mid-morph should never leave a stale resize animation attached to the box.
    resetBoxResize(ieBox);
    resetMorphBox(ieBox);

    // If the box was borrowed by the settings overlay for the resize morph, return
    // everything to its normal place (invisible now, so no flash from the move).
    if (ieBox.parentElement !== homeOverlay) {
        const settingsOverlay = document.getElementById('inv-settings-modal');
        const settingsBox = settingsOverlay.querySelector('.inv-modal:not(.inv-modal-import-export)');
        settingsOverlay.classList.add('hidden');
        settingsOverlay.onclick = closeBinSettings;
        resetMorphBox(settingsBox);
        settingsBox.classList.remove('hidden');
        homeOverlay.appendChild(ieBox);
    }

    homeOverlay.classList.add('hidden');
}

function switchImportExportTab(tab) {
    // Re-entrancy guard: a double-click (or any repeat call while already on this tab)
    // would otherwise read the box's height *mid-animation* as a bogus "from" value.
    if (tab === importExportTab) return;

    const box = document.querySelector('.inv-modal-import-export');
    animateBoxResize(box, () => {
        importExportTab = tab;
        document.getElementById('import-tab-btn').classList.toggle('active', tab === 'import');
        document.getElementById('export-tab-btn').classList.toggle('active', tab === 'export');
        document.getElementById('import-panel').classList.toggle('hidden', tab !== 'import');
        document.getElementById('export-panel').classList.toggle('hidden', tab !== 'export');
    });
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

function invProgressHTML(done, total, currentCard) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const label = currentCard ? `${done}/${total} — ${currentCard}` : `${done}/${total}`;
    return `
        <div class="inv-progress-wrap">
            <div class="inv-progress-label" id="inv-progress-label">${label}</div>
            <div class="inv-progress-track">
                <div class="inv-progress-bar" id="inv-progress-bar" style="width:${pct}%"></div>
            </div>
        </div>`;
}

function invUpdateProgress(done, total, currentCard) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const label = document.getElementById('inv-progress-label');
    const bar = document.getElementById('inv-progress-bar');
    if (label) label.textContent = currentCard ? `${done}/${total} — ${currentCard}` : `${done}/${total}`;
    if (bar) bar.style.width = `${pct}%`;
}

async function submitImport() {
    const textarea = document.getElementById('import-textarea');
    const lines = textarea.value.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length || !activeBin) return;

    const btn = document.getElementById('import-submit-btn');
    const resultsEl = document.getElementById('import-results');
    btn.disabled = true;
    btn.textContent = 'Parsing...';
    resultsEl.innerHTML = '';
    resultsEl.classList.add('hidden');

    try {
        // Step 1 — parse lines, get resolved inserts + unresolved (needs API lookup) + failed (bad format/edition/foil)
        const parseRes = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}/import/parse`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({lines})
        });
        const parseData = await parseRes.json();

        const resolved = parseData.resolved || [];
        const unresolved = parseData.unresolved || [];
        const failed = parseData.failed || [];
        const total = resolved.length + unresolved.length;

        // Step 2 — commit all locally-resolved inserts in one shot
        if (resolved.length) {
            await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}/import/commit`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({inserts: resolved})
            });
        }

        // Step 3 — resolve unresolved cards one at a time via API search, with progress bar
        const resolvedFails = [];
        let done = resolved.length;

        if (unresolved.length) {
            resultsEl.innerHTML = invProgressHTML(done, total, unresolved[0].name);
            resultsEl.classList.remove('hidden');

            for (const item of unresolved) {
                invUpdateProgress(done, total, item.name);
                const res = await fetch(`/api/inventory/bins/${encodeURIComponent(activeBin)}/import/resolve`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({line: item.line, slug: item.slug, section: item.section})
                });
                const data = await res.json();
                if (!data.ok) resolvedFails.push({
                    line: data.line || item.line,
                    error: data.error || `Card not found: ${item.name}`
                });
                done++;
                invUpdateProgress(done, total, done < total ? unresolved[done - resolved.length]?.name || '' : '');
            }
        }

        // Step 4 — reload inventory state and re-render
        const successCount = total - resolvedFails.length;
        if (successCount > 0) {
            const invRes = await fetch('/api/inventory');
            if (invRes.ok) {
                const invData = await invRes.json();
                invBins = invData.bins || {};
            }
            await enrichAndRenderBinCards(invBins[activeBin]);
            updateInvCounts();
        }

        // Final result
        const allFailures = [...failed, ...resolvedFails];
        let html = '';
        if (successCount > 0) {
            html += `<div class="inv-import-summary inv-import-summary--ok">✓ ${successCount} line${successCount !== 1 ? 's' : ''} imported successfully</div>`;
        }
        if (allFailures.length) {
            html += `<div class="inv-import-summary inv-import-summary--err">✕ ${allFailures.length} line${allFailures.length !== 1 ? 's' : ''} failed</div>`;
            html += allFailures.map(r =>
                `<div class="inv-import-error-line"><span class="inv-import-error-text">${r.error}</span><span class="inv-import-error-raw">${r.line}</span></div>`
            ).join('');
        }
        resultsEl.innerHTML = html;
        resultsEl.classList.remove('hidden');

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

    // ── Restore bin from URL params ──
    const urlParams = new URLSearchParams(window.location.search);
    const binName = urlParams.get('bin');
    if (binName && invBins[binName]) {
        await openBinDetail(binName, false);
    }
};
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

    grid.innerHTML = '';
    binNames.forEach((name, i) => grid.appendChild(buildBinTile(name, invBins[name], i)));

    const createTile = document.createElement('div');
    createTile.className = 'inv-bin-create';
    createTile.style.animationDelay = `${binNames.length * 50}ms`;
    createTile.innerHTML = `<span class="inv-create-plus">+</span><span class="inv-create-label">New Bin</span>`;
    createTile.onclick = openCreateModal;
    grid.appendChild(createTile);
}

function buildBinTile(name, bin, index) {
    const count = countBinEntries(bin.cards || {});
    const tile = document.createElement('div');
    tile.className = `inv-bin-tile${bin.default ? ' default-bin' : ''}`;
    tile.style.animationDelay = `${index * 50}ms`;
    tile.innerHTML = `
        <span class="inv-bin-icon">${bin.default ? '📦' : '⬡'}</span>
        ${bin.default ? '<span class="inv-bin-default-badge">Default</span>' : ''}
        <div class="inv-bin-name">${name}</div>
        <div class="inv-bin-meta">${count} card${count !== 1 ? 's' : ''}${bin.desc ? ' · ' + bin.desc : ''}</div>`;
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
    activeBin = binName;
    binCardRows = [];
    const bin = invBins[binName];

    document.getElementById('inv-bins-view').classList.add('hidden');
    document.getElementById('inv-detail-view').classList.remove('hidden');

    document.getElementById('detail-bin-name').textContent = binName;
    document.getElementById('detail-bin-meta').textContent = bin.desc || '';
    document.getElementById('inv-card-filter').value = '';

    // Clear grid immediately so previous bin's cards don't flash
    const grid = document.getElementById('inv-card-grid');
    if (grid) grid.innerHTML = '';

    const deleteBtn = document.getElementById('settings-delete-btn');
    if (deleteBtn) deleteBtn.style.display = bin.default ? 'none' : '';

    await enrichAndRenderBinCards(bin);
}

function closeBinDetail() {
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
        const [infoRes, slugRes] = await Promise.all([
            fetch('/api/inv/info'),
            fetch('/api/inv/slugs')
        ]);
        const infoData = infoRes.ok ? await infoRes.json() : {};
        const slugData = slugRes.ok ? await slugRes.json() : {};

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
                        foilKind = foilKindRaw.charAt(0).toUpperCase() + foilKindRaw.slice(1) || 'Standard';
                    } else {
                        for (const finfo of Object.values(foilsData)) {
                            if (finfo.variants?.[foil_id]) {
                                foilKindRaw = finfo.variants[foil_id].kind || '';
                                foilKind = foilKindRaw || 'Variant';
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
                        foilKindRaw: foilKindRaw.toLowerCase()
                    });
                }
            }
        }
    } catch {
        console.error('Failed to enrich bin cards');
    }

    binCardRows = rows;
    renderBinCards();
}

function renderBinCards() {
    const grid = document.getElementById('inv-card-grid');
    if (!grid) return;

    const filter = document.getElementById('inv-card-filter')?.value?.toLowerCase() || '';
    const sort = document.getElementById('inv-card-sort')?.value || 'name';

    let rows = [...binCardRows];
    if (filter) rows = rows.filter(r =>
        r.cardName.toLowerCase().includes(filter) ||
        r.setPrefix.toLowerCase().includes(filter) ||
        r.foilKind.toLowerCase().includes(filter)
    );

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
        }
    });

    // Update counts
    const totalQty = binCardRows.reduce((s, r) => s + r.quantity, 0);
    const countEl = document.getElementById('detail-bin-counts');
    if (countEl) countEl.textContent = `${binCardRows.length} card${binCardRows.length !== 1 ? 's' : ''} · ${totalQty} cop${totalQty !== 1 ? 'ies' : 'y'}`;

    grid.innerHTML = '';

    if (rows.length === 0 && !filter) {
        // Empty state + add tile
        const empty = document.createElement('div');
        empty.className = 'inv-empty-grid';
        empty.innerHTML = `<span class="inv-empty-icon">⬡</span><p>No cards in this bin.</p><p class="inv-empty-sub">Click the + tile to add cards.</p>`;
        grid.appendChild(empty);
    } else {
        rows.forEach((row, i) => grid.appendChild(buildInvCardTile(row, i)));
    }

    // Add card tile always at end
    const addTile = document.createElement('div');
    addTile.className = 'inv-card-add-tile';
    addTile.style.animationDelay = `${Math.min(rows.length, 30) * 40}ms`;
    addTile.innerHTML = `<span class="inv-create-plus">+</span><span class="inv-create-label">Add Card</span>`;
    addTile.onclick = openAddModal;
    grid.appendChild(addTile);
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

function buildInvCardTile(row, index) {
    const rarity = rarityMapInv[row.rarity] || '';
    const rarityClass = rarity ? `rarity-${rarity.toLowerCase()}` : '';

    const tile = document.createElement('div');
    tile.className = 'inv-card-tile';
    tile.style.animationDelay = `${Math.min(index, 30) * 40}ms`;
    tile.dataset.cardId = row.card_id;
    tile.dataset.editionId = row.edition_id;
    tile.dataset.foilId = row.foil_id;

    tile.innerHTML = `
        <div class="edition-tile-wrap">
            <img src="/images/${row.edition_id}.jpg" alt="${row.cardName}"
                onerror="this.style.opacity='0.1'">
            ${rarity ? `<span class="edition-rarity-badge ${rarityClass}${getFoilSuffix(row) ? ' has-foil-suffix' : ''}">${rarity}${getFoilSuffix(row)}</span>` : ''}
        </div>
        <span class="inv-qty-badge">x${row.quantity}</span>
        <div class="inv-card-tile-overlay">
            <div class="inv-card-tile-name">${row.cardName}</div>
            <div class="inv-card-tile-foil">${row.foilKind}</div>
            <div class="inv-card-tile-qty">x${row.quantity}</div>
        </div>`;

    tile.onclick = () => openCardModal(row);
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
    document.getElementById('card-modal-qty').value = row.quantity;
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
    document.getElementById('add-modal-qty').value = 1;
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
    const label = kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Standard';
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
            invBins[name] = {default: false, desc, public: false, cards: {}};
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
// INIT
// ═══════════════════════════════════════

window.initInventory = async function () {
    if (!currentUser) return;
    await loadInventory();
};
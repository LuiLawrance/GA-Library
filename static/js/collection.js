// ═══════════════════════════════════════
// COLLECTION PAGE (read-only browse of every Inventory bin marked public)
// ═══════════════════════════════════════

let colBins = [];
let colActiveBin = null; // {omnidexId, name}
let colActiveBinData = null;

async function loadPublicBins() {
    const container = document.getElementById('col-sections');
    if (!container) return;

    try {
        const res = await fetch('/api/inventory/public');
        if (!res.ok) throw new Error();
        const data = await res.json();
        colBins = data.bins || [];
    } catch {
        container.innerHTML = '<p class="dga-loading">Failed to load bins.</p>';
        return;
    }

    renderPublicBinSectionsList();
}

// One section for now ("All Bins") — more can be appended here later (e.g.
// featured) without touching the surrounding page layout, same as the public
// Decks page or a bin's own card grid groups its contents.
function renderPublicBinSectionsList() {
    const container = document.getElementById('col-sections');
    container.innerHTML = '';
    container.appendChild(buildPublicBinSection('All Bins', colBins));
}

function buildPublicBinSection(label, bins) {
    const block = document.createElement('div');
    block.className = 'dga-section-block';

    const header = document.createElement('div');
    header.className = 'dga-section-header';
    header.innerHTML = `
        <span class="dga-section-label label">${label}</span>
        <span class="dga-section-count">${bins.length} bin${bins.length !== 1 ? 's' : ''}</span>`;
    block.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'dga-deck-grid col-section-bin-grid';

    if (bins.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pd-empty';
        empty.innerHTML = `<span class="inv-empty-icon">⬡</span><p>No public bins yet.</p>`;
        grid.appendChild(empty);
    } else {
        bins.forEach((bin, i) => grid.appendChild(buildPublicBinTile(bin, i, bins.length)));
    }

    block.appendChild(grid);
    return block;
}

// Mirrors buildPublicDeckTile (decks.js) — same tile shape/classes, just a
// bin's card_count in place of a deck's, and no format badge.
function buildPublicBinTile(bin, index, total) {
    const tile = document.createElement('div');
    tile.className = 'dga-deck-tile';
    const delay = total <= 1 ? 0 : Math.min(index * 50, Math.round((index / (total - 1)) * 400));
    tile.style.animationDelay = `${delay}ms`;

    const count = bin.card_count || 0;

    tile.innerHTML = `
        <div class="dga-tile-icon-row">
            <span class="dga-tile-icon">⬡</span>
        </div>
        <div class="dga-tile-name">${bin.name}</div>
        <div class="pd-tile-owner">by ${bin.username}</div>
        <div class="dga-tile-desc">${bin.desc || ''}</div>
        <div class="dga-tile-meta-row inv-bin-meta-row">
            <div class="dga-tile-meta">${count} card${count !== 1 ? 's' : ''}</div>
            <span class="inv-bin-value-badge inv-bin-value-loading">…</span>
        </div>`;

    if (bin.omnidex_id) {
        loadPublicBinValue(
            tile.querySelector('.inv-bin-value-badge'),
            `/api/inventory/public/${encodeURIComponent(bin.omnidex_id)}/${encodeURIComponent(bin.name)}/value`,
        );
    }

    if (bin.banner) {
        tile.classList.add('has-banner');
        const bg = document.createElement('div');
        bg.className = 'dga-tile-banner';
        bg.style.backgroundImage = `url('/images/${encodeURIComponent(bin.banner)}.jpg')`;
        tile.prepend(bg);
    }

    tile.onclick = () => openPublicBinDetail(bin.omnidex_id, bin.name, true, bin.username);
    return tile;
}

// Same fetch-and-paint pattern as inventory.js's loadBinValue, just pointed at
// a public (unauthenticated) bin's /value endpoint instead of the owner's —
// showBinValuePopup/hideBinValuePopup (inventory.js) are reused as-is, same as
// decks_ga.js's own deck tiles do.
async function loadPublicBinValue(badgeEl, url) {
    if (!badgeEl) return;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load bin value');
        const data = await res.json();

        badgeEl.textContent = `$${data.total.toFixed(2)}`;
        badgeEl.classList.remove('inv-bin-value-loading');
        if (data.priced_quantity < data.total_quantity) {
            badgeEl.classList.add('inv-bin-value-partial');
        }

        badgeEl._binValueData = data;
        if (!badgeEl._binValueHoverWired) {
            badgeEl._binValueHoverWired = true;
            badgeEl.addEventListener('mouseenter', () => showBinValuePopup(badgeEl, badgeEl._binValueData));
            badgeEl.addEventListener('mouseleave', hideBinValuePopup);
        }
    } catch {
        badgeEl.textContent = '—';
        badgeEl.classList.remove('inv-bin-value-loading');
    }
}

// omnidexId (not username) addresses the bin in the URL/API — same rationale
// as the public Decks/profile pages. displayUsername is an optional immediate
// value for the "by ..." byline, shown before the bin fetch resolves (which
// also carries username, confirming/filling it in for a direct/deep-linked
// visit where no tile click supplied it upfront).
function _colSetDetailOwner(omnidexId, username) {
    const el = document.getElementById('col-detail-owner');
    if (!el) return;
    if (!username) {
        el.textContent = '';
        return;
    }
    el.innerHTML = `by <a class="pd-owner-link" href="/@${encodeURIComponent(omnidexId)}" data-link>${escapeHtml(username)}</a>`;
}

async function openPublicBinDetail(omnidexId, binName, pushUrl = true, displayUsername = null) {
    colActiveBin = {omnidexId, name: binName};

    document.getElementById('col-list-view').classList.add('hidden');
    document.getElementById('col-detail-view').classList.remove('hidden');

    document.getElementById('col-detail-name').textContent = binName;
    document.getElementById('col-detail-desc').textContent = '';
    _colSetDetailOwner(omnidexId, displayUsername);

    const grid = document.getElementById('col-card-grid');
    if (grid) grid.innerHTML = '<p class="dga-loading">Loading...</p>';

    const valEl = document.getElementById('col-detail-value');
    if (valEl) {
        valEl.textContent = '…';
        valEl.classList.add('inv-bin-value-loading');
        valEl.classList.remove('inv-bin-value-partial');
    }

    if (pushUrl) {
        window.history.pushState({}, '', `/collection?omni=${encodeURIComponent(omnidexId)}&bin=${encodeURIComponent(binName)}`);
    }

    try {
        const res = await fetch(`/api/inventory/public/${encodeURIComponent(omnidexId)}/${encodeURIComponent(binName)}`);
        if (!res.ok) throw new Error();
        const data = await res.json();

        document.getElementById('col-detail-desc').textContent = data.desc || '';
        _colSetDetailOwner(omnidexId, data.username);

        colActiveBinData = data;
        await renderPublicBinSections(data, omnidexId, binName);

        if (valEl) {
            loadPublicBinValue(valEl, `/api/inventory/public/${encodeURIComponent(omnidexId)}/${encodeURIComponent(binName)}/value`);
        }
    } catch {
        if (grid) grid.innerHTML = '<p class="dga-loading">Failed to load bin.</p>';
    }
}

function closePublicBinDetail() {
    colActiveBin = null;
    colActiveBinData = null;
    document.getElementById('col-detail-view').classList.add('hidden');
    document.getElementById('col-list-view').classList.remove('hidden');
    window.history.pushState({}, '', '/collection');
}

// Enriches the bin's raw {card_id: {edition_id: {foil_id: quantity}}} sections
// against the same public card-catalog endpoints Inventory's own
// enrichAndRenderBinCards uses (/api/inv/info, /api/inv/slugs, /api/inv/collector
// — none of them require auth) plus this bin's own public /prices endpoint,
// then paints one .dga-section-block per section. Duplicated from inventory.js
// rather than shared — same rationale as decks.js's own split from
// decks_ga.js: no shared module between page-specific files here.
async function renderPublicBinSections(binData, omnidexId, binName) {
    const grid = document.getElementById('col-card-grid');
    const sections = binData.sections || {};

    let totalUnique = 0, totalQty = 0;
    for (const cards of Object.values(sections))
        for (const editions of Object.values(cards))
            for (const foils of Object.values(editions))
                for (const quantity of Object.values(foils)) {
                    totalUnique++;
                    totalQty += quantity;
                }
    document.getElementById('col-detail-counts').textContent = `${totalUnique} unique · ${totalQty} total`;

    grid.innerHTML = '';

    if (Object.keys(sections).length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dga-sections-empty';
        empty.innerHTML = `<span class="inv-empty-icon">⬡</span><p>This bin is empty.</p>`;
        grid.appendChild(empty);
        return;
    }

    let infoData = {}, slugData = {}, collectorData = {}, prices = {};
    try {
        const [infoRes, slugRes, collectorRes, pricesRes] = await Promise.all([
            fetch('/api/inv/info'),
            fetch('/api/inv/slugs'),
            fetch('/api/inv/collector'),
            fetch(`/api/inventory/public/${encodeURIComponent(omnidexId)}/${encodeURIComponent(binName)}/prices`),
        ]);
        infoData = infoRes.ok ? await infoRes.json() : {};
        slugData = slugRes.ok ? await slugRes.json() : {};
        collectorData = collectorRes.ok ? await collectorRes.json() : {};
        prices = pricesRes.ok ? await pricesRes.json() : {};
    } catch {
        console.error('Failed to load card catalog for public bin');
    }

    for (const [sectionName, cards] of Object.entries(sections)) {
        const block = document.createElement('div');
        block.className = 'dga-section-block';

        let sectionQty = 0;
        for (const editions of Object.values(cards))
            for (const foils of Object.values(editions))
                for (const q of Object.values(foils)) sectionQty += q;

        const header = document.createElement('div');
        header.className = 'dga-section-header';
        header.innerHTML = `
            <span class="dga-section-label label">${sectionName}</span>
            <span class="dga-section-count">${sectionQty} card${sectionQty !== 1 ? 's' : ''}</span>`;
        block.appendChild(header);

        const sectionGrid = document.createElement('div');
        sectionGrid.className = 'dga-section-grid';

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
                    sectionGrid.appendChild(buildPublicBinCardTile({
                        card_id, edition_id, foil_id, quantity, cardName,
                        rarity: editionInfo.rarity, foilKind, foilKindRaw: foilKindRaw.toLowerCase(),
                        setPrefix: editionInfo.set_prefix || '', collectorNumber: collectorData[edition_id] || '',
                    }, prices));
                }
            }
        }

        block.appendChild(sectionGrid);
        grid.appendChild(block);
    }
}

// Read-only counterpart of inventory.js's buildInvCardTile — same look
// (rarity badge, foil suffix, price badges, qty badge) minus the inline
// qty-edit controls and drag handling an owner's own bin offers.
function buildPublicBinCardTile(row, prices) {
    const rarity = rarityMapInv[row.rarity] || '';
    const rarityClass = rarity ? `rarity-${rarity.toLowerCase()}` : '';

    const tile = document.createElement('div');
    tile.className = 'dga-card-tile inv-card-tile tile-hoverable';

    const priceEntry = prices[row.card_id]?.[row.edition_id]?.[row.foil_id];
    const priceBadges = priceEntry ? priceBadgesHTML(priceEntry.price, priceEntry.lowest_listing) : '';

    tile.innerHTML = `
        <div class="edition-tile-wrap tile-zoom">
            <div class="tile-img-spinner">${TILE_SPINNER_SVG}</div>
            <img alt="${row.cardName}"
                onload="revealTileImage(this)"
                onerror="this.style.opacity='0.1'; revealTileImage(this)">
            <div class="card-tile-dim"></div>
            ${rarity ? `<span class="edition-rarity-badge ${rarityClass}${getFoilSuffix(row) ? ' has-foil-suffix' : ''}">${rarity}${getFoilSuffix(row)}</span>` : ''}
        </div>
        ${priceBadges}
        <span class="inv-qty-badge">x${row.quantity}</span>
        <div class="inv-card-tile-overlay">
            <div class="inv-card-tile-info">
                <div class="dga-card-tile-name">${row.cardName}</div>
                <div class="dga-card-tile-foil">${row.foilKind}</div>
            </div>
        </div>`;

    queueTileImageLoad(tile.querySelector('.edition-tile-wrap img'), `/images/${row.edition_id}.jpg`);

    tile.onclick = () => openCardDrawer(row.card_id, row.edition_id, row.cardName);

    return tile;
}

window.initCollection = async function () {
    await loadPublicBins();

    const urlParams = new URLSearchParams(window.location.search);
    const omnidexId = urlParams.get('omni');
    const binName = urlParams.get('bin');
    if (omnidexId && binName) {
        await openPublicBinDetail(omnidexId, binName, false);
    }
};

// ── State ──
let watchlistData = [];
let watchlistAcIndex = -1;
let watchlistCardId = null;
let watchlistCardName = null;
let watchlistCardData = null;
let watchlistEditionId = null;
let watchlistFoilId = null;

let priceGraphCard = null;
let priceSearchAcIndex = -1;

async function initPrices() {
    const guest = document.getElementById('prices-guest');
    const content = document.getElementById('prices-content');
    if (!guest || !content) return;

    if (!currentUser) {
        guest.classList.remove('hidden');
        content.classList.add('hidden');
        return;
    }

    guest.classList.add('hidden');
    content.classList.remove('hidden');

    // The page's DOM is rebuilt fresh every time this route loads, but this
    // module-level state isn't — without resetting it here, a row from a
    // previous visit would still show as selected (and the graph panel would
    // stay on its empty placeholder instead of re-triggering the auto-select)
    // even though nothing on the new page actually points to that card.
    priceGraphCard = null;

    await loadWatchlist();
}

async function loadWatchlist() {
    const table = document.getElementById('prices-table');
    if (!table) return;

    try {
        const res = await fetch('/api/watchlist');
        if (!res.ok) throw new Error('Failed to load watchlist');
        const data = await res.json();
        watchlistData = data.watchlist || [];
        renderWatchlist();
    } catch {
        table.innerHTML = `
            <div class="prices-empty">
                <span class="inv-empty-icon">⚠️</span>
                <p>Failed to load watchlist.</p>
            </div>`;
    }
}

function renderWatchlist() {
    const table = document.getElementById('prices-table');
    if (!table) return;

    if (!watchlistData.length) {
        table.innerHTML = `
            <div class="prices-empty">
                <span class="inv-empty-icon">⬡</span>
                <p>Your watchlist is empty. Add a card to start tracking its price.</p>
            </div>`;
        return;
    }

    table.innerHTML = watchlistData.map((row, i) => {
        const foilLabel = row.foil_kind ? toFoilLabel(row.foil_kind) : 'Standard';
        const priceText = row.price != null ? `$${row.price.toFixed(2)}` : null;
        const meta = `${row.set_prefix || '—'} · #${row.collector_number || '?'} · ${foilLabel}`;

        let changeHTML = '<span class="prices-change prices-change--flat">—</span>';
        if (row.change_pct != null) {
            const up = row.change_pct > 0;
            const flat = row.change_pct === 0;
            const cls = flat ? 'prices-change--flat' : (up ? 'prices-change--up' : 'prices-change--down');
            const arrow = flat ? '' : (up ? '▲ ' : '▼ ');
            changeHTML = `<span class="prices-change ${cls}">${arrow}${Math.abs(row.change_pct).toFixed(1)}%</span>`;
        }

        return `
            <div class="prices-watch-tile card-tile card-tile--authed"
                 style="animation-delay:${Math.min(i, 20) * 30}ms"
                 data-card-id="${row.card_id}" data-edition-id="${row.edition_id}" data-foil-id="${row.foil_id}"
                 data-name="${escapeHtml(row.name)}"
                 title="${escapeHtml(row.name)} — ${escapeHtml(meta)}">
                <div class="prices-watch-tile-media">
                    <div class="edition-tile-wrap">
                        <img src="/images/${row.edition_id}.jpg" alt="${escapeHtml(row.name)}">
                    </div>
                </div>
                ${priceText ? `<span class="inv-price-badge">${priceText}</span>` : ''}
                <button class="prices-watch-remove" title="Remove from watchlist">&times;</button>
                <div class="prices-watch-tile-info">
                    <div class="prices-watch-tile-name">${escapeHtml(row.name)}</div>
                    ${changeHTML}
                </div>
            </div>`;
    }).join('');

    // Bound from the tile's own data-* attributes rather than interpolated into
    // an inline onclick string — card names can contain characters (e.g. the
    // apostrophe in "Apothecary's Harvest") that survive escapeHtml's HTML
    // escaping but still reintroduce a raw quote once the browser HTML-decodes
    // the onclick attribute back into JS source, breaking the string literal
    // and silently no-op'ing the click.
    table.querySelectorAll('.prices-watch-tile').forEach(tile => {
        const {cardId, editionId, foilId, name} = tile.dataset;
        tile.addEventListener('click', () => showPriceGraph(cardId, editionId, foilId, name));
        tile.querySelector('.prices-watch-remove')?.addEventListener('click', e => {
            e.stopPropagation();
            removeFromWatchlist(cardId, editionId, foilId);
        });
    });

    highlightSelectedWatchlistRow();

    // Default to the first watched card so the graph panel isn't empty on load.
    if (watchlistData.length && !priceGraphCard) {
        const first = watchlistData[0];
        showPriceGraph(first.card_id, first.edition_id, first.foil_id, first.name);
    }
}

// ═══════════════════════════════════════
// PRICE GRAPH PANEL
// ═══════════════════════════════════════

function highlightSelectedWatchlistRow() {
    document.querySelectorAll('.prices-watch-tile').forEach(tile => {
        const match = priceGraphCard
            && tile.dataset.cardId === priceGraphCard.cardId
            && tile.dataset.editionId === priceGraphCard.editionId
            && tile.dataset.foilId === priceGraphCard.foilId;
        tile.classList.toggle('selected', match);
    });
}

async function showPriceGraph(cardId, editionId, foilId, cardName) {
    priceGraphCard = {cardId, editionId, foilId};
    highlightSelectedWatchlistRow();

    const header = document.getElementById('price-graph-header');
    const body = document.getElementById('price-graph-body');
    if (!body) return;

    // Fade the previous card's chart out before swapping in the new one,
    // rather than replacing it outright — matches .prices-graph-body's
    // transition duration (see prices.css).
    body.classList.add('switching');
    await new Promise(r => setTimeout(r, 180));

    body.innerHTML = `<div class="prices-graph-loading">Loading chart...</div>`;
    body.classList.remove('switching');

    try {
        const res = await fetch(`/api/cards/${cardId}`);
        if (!res.ok) throw new Error('Failed to load card');
        const data = await res.json();
        const edition = data.card?.editions?.[editionId];
        const foilInfo = edition?.foils?.[foilId];
        const pricing = edition?.pricing?.[foilId] || {sales: [], listings: []};

        if (header) {
            const foilLabel = foilInfo?.kind ? toFoilLabel(foilInfo.kind) : 'Standard';
            header.innerHTML = `
                <div class="prices-graph-title">${escapeHtml(cardName)}</div>
                <div class="prices-graph-meta">${escapeHtml(edition?.set_prefix || '—')} · #${escapeHtml(edition?.collector_number || '?')} · ${escapeHtml(foilLabel)}</div>`;
        }

        // Render once so the row layout settles — .pricing-chart-canvas's
        // width/height are determined by CSS flex (flex:1 next to the fixed-
        // width legend menu), not by the chart's own content, so they're
        // already correct even on this first pass. Re-render at that exact
        // size so the chart fills the panel instead of a fixed-aspect box
        // getting stretched or leaving empty space.
        body.innerHTML = buildPricingComboChart(pricing.sales || [], pricing.listings || [], Infinity);
        const canvasEl = body.querySelector('.pricing-chart-canvas');
        if (canvasEl) {
            const availableWidth = canvasEl.clientWidth;
            const availableHeight = canvasEl.clientHeight;
            body.innerHTML = buildPricingComboChart(pricing.sales || [], pricing.listings || [], Infinity, availableWidth, availableHeight);
        }
    } catch {
        body.innerHTML = `<div class="prices-graph-empty"><span class="inv-empty-icon">⚠️</span><p>Failed to load price history.</p></div>`;
    }
}

async function removeFromWatchlist(cardId, editionId, foilId) {
    try {
        await fetch('/api/watchlist', {
            method: 'DELETE',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({card_id: cardId, edition_id: editionId, foil_id: foilId}),
        });
    } catch {
        // fall through to reload regardless — a stale row is worse than a retry
    }
    await loadWatchlist();
}

// ═══════════════════════════════════════
// ADD TO WATCHLIST MODAL
// ═══════════════════════════════════════

function openWatchlistModal() {
    document.getElementById('watchlist-card-search').value = '';
    const results = document.getElementById('watchlist-card-results');
    if (results) {
        results.style.gridTemplateColumns = '';
        results.classList.remove('has-scroll');
        results.innerHTML = `<div class="inv-search-placeholder" style="padding:30px 0"><span class="inv-empty-icon">⬡</span><p>Search for a card to watch.</p></div>`;
    }
    document.getElementById('watchlist-step-search').classList.remove('hidden');
    document.getElementById('watchlist-step-foil').classList.add('hidden');
    document.getElementById('watchlist-back-btn').classList.add('hidden');
    document.getElementById('watchlist-add-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('watchlist-card-search').focus(), 60);
}

function closeWatchlistModal() {
    document.getElementById('watchlist-add-modal').classList.add('hidden');
    hideWatchlistAc();
    const btn = document.getElementById('watchlist-modal-submit');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Add to Watchlist';
    }
}

function watchlistBackToSearch() {
    document.getElementById('watchlist-step-foil').classList.add('hidden');
    document.getElementById('watchlist-step-search').classList.remove('hidden');
    document.getElementById('watchlist-back-btn').classList.add('hidden');
    watchlistCardId = null;
    watchlistCardName = null;
    watchlistCardData = null;
    watchlistEditionId = null;
    watchlistFoilId = null;
    setTimeout(() => document.getElementById('watchlist-card-search').focus(), 40);
}

async function fetchWatchlistSuggestions(value) {
    const list = document.getElementById('watchlist-card-autocomplete');
    if (value.length < 2) {
        hideWatchlistAc();
        return;
    }
    try {
        const res = await fetch(`/api/cards/suggest?q=${encodeURIComponent(value)}`);
        const data = await res.json();
        if (!data.suggestions?.length) {
            hideWatchlistAc();
            return;
        }
        watchlistAcIndex = -1;
        list.innerHTML = '';
        data.suggestions.forEach(name => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.textContent = name;
            item.onclick = () => {
                document.getElementById('watchlist-card-search').value = name;
                hideWatchlistAc();
                searchWatchlistCards();
            };
            list.appendChild(item);
        });
        list.classList.remove('hidden');
    } catch {
        hideWatchlistAc();
    }
}

function hideWatchlistAc() {
    const list = document.getElementById('watchlist-card-autocomplete');
    if (list) {
        list.classList.add('hidden');
        list.innerHTML = '';
    }
    watchlistAcIndex = -1;
}

function handleWatchlistSearchKeydown(e) {
    const list = document.getElementById('watchlist-card-autocomplete');
    const items = list?.querySelectorAll('.autocomplete-item') || [];
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        watchlistAcIndex = Math.min(watchlistAcIndex + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('selected', i === watchlistAcIndex));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        watchlistAcIndex = Math.max(watchlistAcIndex - 1, -1);
        items.forEach((el, i) => el.classList.toggle('selected', i === watchlistAcIndex));
    } else if (e.key === 'Enter') {
        if (watchlistAcIndex >= 0 && items[watchlistAcIndex]) {
            document.getElementById('watchlist-card-search').value = items[watchlistAcIndex].textContent;
            hideWatchlistAc();
            searchWatchlistCards();
        } else {
            hideWatchlistAc();
            searchWatchlistCards();
        }
    } else if (e.key === 'Escape') {
        hideWatchlistAc();
        closeWatchlistModal();
    }
}

async function searchWatchlistCards() {
    const query = document.getElementById('watchlist-card-search')?.value?.trim();
    const results = document.getElementById('watchlist-card-results');
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
            await goToWatchlistFoilStep(card.card_id, card.edition_id, card.name);
            return;
        }

        data.cards.forEach((card, i) => {
            const tile = document.createElement('div');
            tile.className = 'inv-search-tile';
            tile.style.animationDelay = `${Math.min(i, 20) * 30}ms`;
            tile.innerHTML = `
                <div class="edition-tile-wrap">
                    <img src="/images/${card.edition_id}.jpg" alt="${escapeHtml(card.name)}">
                    <div class="inv-search-tile-overlay">＋</div>
                </div>`;
            tile.onclick = () => goToWatchlistFoilStep(card.card_id, card.edition_id, card.name);
            tile.addEventListener('animationend', () => tile.classList.add('animated'));
            results.appendChild(tile);
        });
    } catch {
        results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Search failed.</p></div>`;
    }
}

function openWatchlistModalToFoilStep(cardId, editionId, cardName) {
    document.getElementById('watchlist-add-modal').classList.remove('hidden');
    goToWatchlistFoilStep(cardId, editionId, cardName);
}

async function goToWatchlistFoilStep(cardId, editionId, cardName) {
    watchlistCardId = cardId;
    watchlistCardName = cardName;

    document.getElementById('watchlist-modal-name').textContent = cardName;
    document.getElementById('watchlist-modal-set').textContent = '';
    document.getElementById('watchlist-modal-img').src = `/images/${editionId}.jpg`;
    document.getElementById('watchlist-modal-foils').innerHTML = '<div style="font-size:0.78rem;color:var(--text-muted);">Loading...</div>';
    document.getElementById('watchlist-modal-submit').disabled = true;

    document.getElementById('watchlist-step-search').classList.add('hidden');
    document.getElementById('watchlist-step-foil').classList.remove('hidden');
    document.getElementById('watchlist-back-btn').classList.remove('hidden');

    try {
        const res = await fetch(`/api/cards/${cardId}`);
        const data = await res.json();
        watchlistCardData = data.card;

        const editions = Object.entries(watchlistCardData.editions || {}).sort((a, b) => {
            const parseNum = s => {
                const m = (s || 'ZZZ').match(/^(\d+)([A-Z]*)$/i);
                return m ? [parseInt(m[1]), m[2] || ''] : [Infinity, s];
            };
            const [nA, sA] = parseNum(a[1].collector_number);
            const [nB, sB] = parseNum(b[1].collector_number);
            return nA !== nB ? nA - nB : sA.localeCompare(sB);
        });

        const foilList = document.getElementById('watchlist-modal-foils');
        foilList.innerHTML = '';
        let firstOpt = null;
        // If the caller identified a specific printing (e.g. a tile clicked in
        // the all-editions search results), preselect that one instead of
        // always defaulting to the first in collector-number order.
        let matchOpt = null;

        editions.forEach(([eid, einfo]) => {
            const rarityMap = {1: "C", 2: "U", 3: "R", 4: "SR", 5: "UR", 6: "PR", 7: "CSR", 8: "CUR", 9: "CPR"};
            const rarity = rarityMap[einfo.rarity] || '?';
            Object.entries(einfo.foils || {}).forEach(([fid, finfo]) => {
                const opt = buildWatchlistFoilOption(eid, fid, finfo.kind, einfo.set_prefix, rarity, einfo.collector_number, false);
                if (!firstOpt) firstOpt = {opt, eid, fid};
                if (!matchOpt && eid === editionId) matchOpt = {opt, eid, fid};
                foilList.appendChild(opt);
                Object.entries(finfo.variants || {}).forEach(([vid, vinfo]) => {
                    const vopt = buildWatchlistFoilOption(eid, vid, vinfo.kind, einfo.set_prefix, rarity, einfo.collector_number, true);
                    foilList.appendChild(vopt);
                });
            });
        });

        const initialOpt = matchOpt || firstOpt;
        if (initialOpt) selectWatchlistFoilOption(initialOpt.opt, initialOpt.eid, initialOpt.fid);
    } catch {
        document.getElementById('watchlist-modal-foils').innerHTML = '<div style="font-size:0.78rem;color:var(--error);">Failed to load editions.</div>';
    }
}

function buildWatchlistFoilOption(editionId, foilId, kind, setPrefix, rarity, collectorNum, isVariant) {
    const label = kind ? kind.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'Standard';
    const opt = document.createElement('div');
    opt.className = 'inv-foil-option';
    opt.dataset.editionId = editionId;
    opt.dataset.foilId = foilId;
    opt.innerHTML = `
        <div class="inv-foil-left">
            <div class="inv-foil-name">${label}${isVariant ? ' <span style="opacity:0.5;font-size:0.85em">(variant)</span>' : ''}</div>
            <div class="inv-foil-meta">${escapeHtml(setPrefix || '')} · ${rarity} · #${collectorNum || '?'}</div>
        </div>
        <div class="inv-foil-check"></div>`;
    opt.onclick = () => selectWatchlistFoilOption(opt, editionId, foilId);
    return opt;
}

function selectWatchlistFoilOption(opt, editionId, foilId) {
    document.querySelectorAll('#watchlist-modal-foils .inv-foil-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    watchlistEditionId = editionId;
    watchlistFoilId = foilId;

    const einfo = watchlistCardData?.editions?.[editionId];
    if (einfo) {
        document.getElementById('watchlist-modal-img').src = `/images/${editionId}.jpg`;
        document.getElementById('watchlist-modal-set').textContent = `${einfo.set_name || ''} (${einfo.set_prefix || ''}) — #${einfo.collector_number || '?'}`;
    }
    document.getElementById('watchlist-modal-submit').disabled = false;

    // Preview the chart behind the modal so the user can see the price
    // history before deciding whether to add it to their watchlist.
    if (watchlistCardId && watchlistCardName) {
        showPriceGraph(watchlistCardId, editionId, foilId, watchlistCardName);
    }
}

async function submitAddToWatchlist() {
    if (!watchlistCardId || !watchlistEditionId || !watchlistFoilId) return;

    const btn = document.getElementById('watchlist-modal-submit');
    btn.disabled = true;
    btn.textContent = 'Adding...';

    try {
        const res = await fetch('/api/watchlist', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                card_id: watchlistCardId,
                edition_id: watchlistEditionId,
                foil_id: watchlistFoilId,
            }),
        });

        if (res.ok) {
            closeWatchlistModal();
            await loadWatchlist();
        } else {
            btn.textContent = 'Error';
            setTimeout(() => {
                btn.textContent = 'Add to Watchlist';
                btn.disabled = false;
            }, 1500);
        }
    } catch {
        btn.textContent = 'Failed';
        setTimeout(() => {
            btn.textContent = 'Add to Watchlist';
            btn.disabled = false;
        }, 1500);
    }
}

// ═══════════════════════════════════════
// CARD SEARCH PANEL
// ═══════════════════════════════════════

async function fetchPriceSearchSuggestions(value) {
    const list = document.getElementById('price-search-autocomplete');
    if (!list) return;
    if (value.length < 2) {
        hidePriceSearchAc();
        return;
    }
    try {
        const res = await fetch(`/api/cards/suggest?q=${encodeURIComponent(value)}`);
        const data = await res.json();
        if (!data.suggestions?.length) {
            hidePriceSearchAc();
            return;
        }
        priceSearchAcIndex = -1;
        list.innerHTML = '';
        data.suggestions.forEach(name => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.textContent = name;
            item.onclick = () => {
                document.getElementById('price-search-input').value = name;
                hidePriceSearchAc();
                searchPriceCards();
            };
            list.appendChild(item);
        });
        list.classList.remove('hidden');
    } catch {
        hidePriceSearchAc();
    }
}

function hidePriceSearchAc() {
    const list = document.getElementById('price-search-autocomplete');
    if (list) {
        list.classList.add('hidden');
        list.innerHTML = '';
    }
    priceSearchAcIndex = -1;
}

function handlePriceSearchKeydown(e) {
    const list = document.getElementById('price-search-autocomplete');
    const items = list?.querySelectorAll('.autocomplete-item') || [];
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        priceSearchAcIndex = Math.min(priceSearchAcIndex + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('selected', i === priceSearchAcIndex));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        priceSearchAcIndex = Math.max(priceSearchAcIndex - 1, -1);
        items.forEach((el, i) => el.classList.toggle('selected', i === priceSearchAcIndex));
    } else if (e.key === 'Enter') {
        if (priceSearchAcIndex >= 0 && items[priceSearchAcIndex]) {
            document.getElementById('price-search-input').value = items[priceSearchAcIndex].textContent;
        }
        hidePriceSearchAc();
        searchPriceCards();
    } else if (e.key === 'Escape') {
        hidePriceSearchAc();
    }
}

async function searchPriceCards() {
    const query = document.getElementById('price-search-input')?.value?.trim();
    const results = document.getElementById('price-search-results');
    if (!results || !query) return;

    results.innerHTML = `<div class="inv-search-placeholder"><span class="inv-empty-icon">⬡</span><p>Searching...</p></div>`;

    try {
        const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}&all_prints=1`);
        const data = await res.json();

        if (!data.cards?.length) {
            results.innerHTML = `<div class="inv-search-placeholder"><span class="inv-empty-icon">⬡</span><p>${data.message || 'No cards found.'}</p></div>`;
            return;
        }

        // One tile per printing now (all_prints=1), so group same-name cards
        // together and order their printings by collector number.
        const cards = [...data.cards].sort((a, b) => {
            if (a.name !== b.name) return a.name.localeCompare(b.name);
            const [nA, sA] = _sortCollectorNumber(a.collector_number);
            const [nB, sB] = _sortCollectorNumber(b.collector_number);
            return nA !== nB ? nA - nB : sA.localeCompare(sB);
        });

        results.innerHTML = '';
        cards.forEach((card, i) => results.appendChild(buildPriceSearchTile(card, i, cards.length)));
    } catch {
        results.innerHTML = `<div class="inv-search-placeholder"><span class="inv-empty-icon">⬡</span><p>Search failed.</p></div>`;
    }
}

// Mirrors buildCardTile() from the regular Cards page (same card-tile markup
// and styling) but opens the watchlist foil-step instead of the full drawer,
// and skips attachInvOverlay since inventory quantity controls don't apply here.
function buildPriceSearchTile(card, index, total = 1) {
    const rarity = rarityMap[card.rarity] || '';
    const rarityClass = `rarity-${rarity.toLowerCase()}`;

    const tile = document.createElement('div');
    tile.className = 'card-tile card-tile--authed';
    const maxDelay = 400;
    const delay = total <= 1 ? 0 : Math.min(index * 40, Math.round((index / (total - 1)) * maxDelay));
    tile.style.animationDelay = `${delay}ms`;
    const caption = (card.set_prefix || card.collector_number)
        ? `<div class="prices-tile-caption">${escapeHtml(card.set_prefix || '—')} · #${escapeHtml(card.collector_number || '?')}</div>`
        : '';
    tile.innerHTML = `
        <div class="edition-tile-wrap">
            <img src="/images/${card.edition_id}.jpg" alt="${escapeHtml(card.name)}"
                onerror="this.parentElement.parentElement.innerHTML='<div class=card-tile-missing>${escapeHtml(card.name)}</div>'">
            ${rarity ? `<span class="edition-rarity-badge ${rarityClass}">${rarity}</span>` : ''}
        </div>
        ${card.last_price != null ? `<span class="inv-price-badge">$${Number(card.last_price).toFixed(2)}</span>` : ''}
        ${caption}`;
    tile.onclick = () => openWatchlistModalToFoilStep(card.card_id, card.edition_id, card.name);
    tile.addEventListener('animationend', () => tile.classList.add('animated'));
    return tile;
}

// Use capture so it fires even inside stopPropagation — guarded to the prices page only
document.addEventListener('click', e => {
    if (!document.getElementById('watchlist-add-modal')) return;
    if (!e.target.closest('#watchlist-card-search') && !e.target.closest('#watchlist-card-autocomplete')) hideWatchlistAc();
    if (!e.target.closest('#price-search-input') && !e.target.closest('#price-search-autocomplete')) hidePriceSearchAc();
}, true);

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

// Must match .prices-content's resting grid-template-rows in prices.css.
// Selecting a card from Card Search requires hovering that panel, which
// shrinks the graph panel for as long as the hover lasts (see
// .prices-content:has(.prices-search-panel:hover) in prices.css) — these
// let measureRestingGraphSize compute what the graph panel's height would be
// at rest even while that hover-shrink is currently in effect, so the chart
// always renders at full size and never has to react to the search panel
// expanding or collapsing afterward.
const PRICES_GRAPH_ROW_FR = 1.2;
const PRICES_SEARCH_ROW_FR = 0.8;

function measureRestingGraphSize(canvasEl) {
    const currentWidth = canvasEl.clientWidth;
    const currentHeight = canvasEl.clientHeight;

    const graphPanel = document.querySelector('.prices-graph-panel');
    const contentEl = document.querySelector('.prices-content');
    if (!graphPanel || !contentEl) return {width: currentWidth, height: currentHeight};

    // .prices-content's own height (unlike its rows' split) doesn't change
    // when the search panel hover-expands — only how that fixed total is
    // divided between the graph and search rows does — so this is the
    // resting height the graph row would have regardless of the current split.
    const contentStyle = getComputedStyle(contentEl);
    const rowGap = parseFloat(contentStyle.rowGap || contentStyle.gap) || 0;
    const paddingV = parseFloat(contentStyle.paddingTop) + parseFloat(contentStyle.paddingBottom);
    const availableRowsHeight = contentEl.clientHeight - paddingV - rowGap;
    const restingPanelHeight = availableRowsHeight * (PRICES_GRAPH_ROW_FR / (PRICES_GRAPH_ROW_FR + PRICES_SEARCH_ROW_FR));

    // The panel's height change propagates 1:1 down to the canvas (both ends
    // of the chain are plain flex:1, nothing clamps in between), so the delta
    // from the panel's current height to its resting height is exactly the
    // delta the canvas needs too — no need to separately account for the
    // panel's own padding/header eating into that height.
    const heightDelta = restingPanelHeight - graphPanel.clientHeight;

    return {width: currentWidth, height: currentHeight + heightDelta};
}

async function initPrices() {
    const content = document.getElementById('prices-content');
    if (!content) return;

    // The page's DOM is rebuilt fresh every time this route loads, but this
    // module-level state isn't — without resetting it here, a card selected
    // on a previous visit would still show as selected (ring on its tile)
    // even though nothing on the new page actually points to it anymore.
    priceGraphCard = null;

    // Only the watchlist itself needs an account — Card Search and the price
    // graph both hit endpoints that don't require one, so guests get the
    // full page except the watchlist grid, which shows a login prompt in
    // its place instead of the whole page being replaced like it used to be.
    if (currentUser) {
        await loadWatchlist();
    } else {
        renderWatchlistGuestPrompt();
    }

    // Restore a selected card from the URL (?card_id=&edition_id=&foil_id=)
    // — e.g. a shared or bookmarked link, or just the page being refreshed.
    // Works for guests too, same as a fresh selection. updateUrl:false since
    // the URL already has this selection; no need to replace it with itself.
    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get('card_id');
    const editionId = urlParams.get('edition_id');
    const foilId = urlParams.get('foil_id');
    if (cardId && editionId && foilId) {
        showPriceGraph(cardId, editionId, foilId, null, false);
    }
}

function renderWatchlistGuestPrompt() {
    const table = document.getElementById('prices-table');
    if (!table) return;
    table.innerHTML = `
        <div class="prices-empty">
            <span class="inv-empty-icon">📈</span>
            <p>Log in to build a watchlist and track card prices.</p>
            <a href="/login" data-link class="btn-login">Log In</a>
        </div>`;
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
            <div class="prices-watch-tile card-tile card-tile--authed tile-hoverable"
                 style="animation-delay:${Math.min(i, 20) * 30}ms"
                 data-card-id="${row.card_id}" data-edition-id="${row.edition_id}" data-foil-id="${row.foil_id}"
                 data-name="${escapeHtml(row.name)}"
                 title="${escapeHtml(row.name)} — ${escapeHtml(meta)}">
                <div class="prices-watch-tile-media tile-zoom">
                    <div class="edition-tile-wrap">
                        <div class="card-tile-dim"></div>
                        <img src="/images/${row.edition_id}.jpg" alt="${escapeHtml(row.name)}">
                        <button class="prices-watch-remove tile-action-btn tile-action-btn--danger" title="Remove from watchlist">&times;</button>
                    </div>
                </div>
                ${priceText ? `<span class="inv-price-badge">${priceText}</span>` : ''}
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
        tile.addEventListener('click', () => {
            // Clicking the card that's already driving the graph wouldn't
            // change anything there — open the full card drawer instead,
            // since that's presumably what the user actually wants a second
            // click on the same card for.
            const alreadySelected = priceGraphCard
                && priceGraphCard.cardId === cardId
                && priceGraphCard.editionId === editionId
                && priceGraphCard.foilId === foilId;
            if (alreadySelected) {
                openCardDrawer(cardId, editionId, name);
            } else {
                showPriceGraph(cardId, editionId, foilId, name);
            }
        });
        tile.querySelector('.prices-watch-remove')?.addEventListener('click', e => {
            e.stopPropagation();
            removeFromWatchlist(cardId, editionId, foilId);
        });
    });

    highlightSelectedPriceCard();
}

// ═══════════════════════════════════════
// PRICE GRAPH PANEL
// ═══════════════════════════════════════

// Keeps the "selected" ring in sync with priceGraphCard wherever a matching
// tile might be rendered — the watchlist grid and the Card Search results
// both use it, so a card selected from either place is reflected in both.
function highlightSelectedPriceCard() {
    document.querySelectorAll('.prices-watch-tile').forEach(tile => {
        const match = priceGraphCard
            && tile.dataset.cardId === priceGraphCard.cardId
            && tile.dataset.editionId === priceGraphCard.editionId
            && tile.dataset.foilId === priceGraphCard.foilId;
        tile.classList.toggle('selected', match);
    });

    // Search-result tiles don't pin a specific foil (there's no foil picker
    // in that grid — see resolveDefaultFoil), so they're matched on
    // card+edition only, the same looser identity selectPriceSearchCard uses
    // to decide whether a tile is already the selected one.
    document.querySelectorAll('#price-search-results .card-tile').forEach(tile => {
        const match = priceGraphCard
            && tile.dataset.cardId === priceGraphCard.cardId
            && tile.dataset.editionId === priceGraphCard.editionId;
        tile.classList.toggle('selected', match);
    });
}

// updateUrl syncs the selection into the URL (?card_id=&edition_id=&foil_id=)
// so it survives a refresh and can be shared/bookmarked — mirrors the same
// ?bin=/?deck= pattern already used on Inventory/Decks. replaceState rather
// than pushState: unlike opening a bin or deck (one deliberate navigation),
// selecting a card here happens casually and often in quick succession, and
// pushState per click would flood browser history with one entry per card
// glanced at. False for callers where the selection isn't really "the
// thing being looked at" yet — e.g. the watchlist modal's foil-picker
// preview, which shows a chart for a card that hasn't been added yet.
async function showPriceGraph(cardId, editionId, foilId, cardName, updateUrl = true) {
    priceGraphCard = {cardId, editionId, foilId};
    highlightSelectedPriceCard();

    if (updateUrl) {
        const params = new URLSearchParams({card_id: cardId, edition_id: editionId, foil_id: foilId});
        window.history.replaceState({}, '', `/prices?${params}`);
    }

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
        // foilId may be a Curio Foil's variant id rather than a top-level
        // foil id — resolveFoilInfo checks each foil's variants too, since a
        // plain edition.foils[foilId] lookup would miss those and mislabel
        // the header as "Standard".
        const foilInfo = resolveFoilInfo(edition?.foils, foilId);
        // A sole Curio Foil (see soleCurioVariant) has no base printing of
        // its own, so TCGPlayer sales/listings scraped against its parent's
        // own foil_id (its override product page isn't always configured —
        // see soleVariantOf's comment in drawer.js, which this mirrors)
        // belong to the variant too, not a nonexistent plain-Foil printing.
        // Fold that parent data in alongside the variant's own so the graph
        // isn't missing price history that's really its.
        const mergeFoilId = findSoleCurioParent(edition?.foils, foilId);
        const primaryPricing = edition?.pricing?.[foilId] || {sales: [], listings: []};
        const secondaryPricing = mergeFoilId ? (edition?.pricing?.[mergeFoilId] || {sales: [], listings: []}) : {sales: [], listings: []};
        const pricing = {
            sales: [...primaryPricing.sales, ...secondaryPricing.sales],
            listings: [...primaryPricing.listings, ...secondaryPricing.listings],
        };
        // Callers restoring a selection from the URL (see initPrices) only
        // have the raw ids, not a display name — fall back to the name the
        // card detail endpoint now resolves server-side.
        cardName = cardName || data.card?.name || '';

        if (header) {
            const foilLabel = foilInfo?.kind ? toFoilLabel(foilInfo.kind) : 'Standard';
            header.innerHTML = `
                <div class="prices-graph-title">${escapeHtml(cardName)}</div>
                <div class="prices-graph-meta">${escapeHtml(edition?.set_prefix || '—')} · #${escapeHtml(edition?.collector_number || '?')} · ${escapeHtml(foilLabel)}</div>`;
        }

        const sales = pricing.sales || [];
        const listings = pricing.listings || [];

        // Render once so the row layout settles — .pricing-chart-canvas's
        // width/height are determined by CSS flex (flex:1 next to the fixed-
        // width legend menu), not by the chart's own content, so they're
        // already correct even on this first pass. Re-render at that exact
        // size so the chart fills the panel instead of a fixed-aspect box
        // getting stretched or leaving empty space. Always the panel's
        // *resting* size (see measureRestingGraphSize) even if it's
        // currently squeezed down by the search panel's hover-expand state —
        // the chart is sized once here and never adjusted afterward, so it
        // has to be right the first time regardless of what's currently
        // hovered.
        body.innerHTML = buildPricingComboChart(sales, listings, Infinity);
        const canvasEl = body.querySelector('.pricing-chart-canvas');
        if (canvasEl) {
            const {width, height} = measureRestingGraphSize(canvasEl);
            body.innerHTML = buildPricingComboChart(sales, listings, Infinity, width, height);
        }

        // A card with enough history renders wider than the panel and scrolls
        // (see PRICING_CHART_MIN_POINT_SPACING in drawer.js) — default that
        // scroll to its right edge so the most recent data, not the oldest,
        // is what's in view without the user having to scroll first.
        const scrollEl = body.querySelector('.pricing-chart-scroll');
        if (scrollEl) scrollEl.scrollLeft = scrollEl.scrollWidth;
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
    // Closing mid-resize shouldn't leave a stale animation holding the box at the wrong
    // size for next time — it uses fill:'forwards' so it keeps holding even while hidden.
    resetBoxResize(document.querySelector('#watchlist-add-modal .inv-modal-wide'));
}

// Thin adapter over the shared animateBoxResize() for this modal's box.
function animateWatchlistModalResize(mutate) {
    animateBoxResize(document.querySelector('#watchlist-add-modal .inv-modal-wide'), mutate);
}

function watchlistBackToSearch() {
    if (document.getElementById('watchlist-step-foil').classList.contains('hidden')) return;
    animateWatchlistModalResize(() => {
        document.getElementById('watchlist-step-foil').classList.add('hidden');
        document.getElementById('watchlist-step-search').classList.remove('hidden');
        document.getElementById('watchlist-back-btn').classList.add('hidden');
        // Restore grid columns to match existing results
        const results = document.getElementById('watchlist-card-results');
        const tileCount = results ? results.querySelectorAll('.inv-search-tile').length : 0;
        if (tileCount > 0) {
            const cols = Math.min(tileCount, 5);
            if (results) results.style.gridTemplateColumns = `repeat(${cols}, 255px)`;
        }
    });
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

    // A prior search may have widened the grid to fit multiple result columns — reset it
    // before showing a single-message placeholder, or the placeholder inherits that stale
    // width instead of shrinking back down to its natural size.
    const resetResultsGrid = () => {
        results.style.gridTemplateColumns = '';
        results.classList.remove('has-scroll');
    };

    animateWatchlistModalResize(() => {
        resetResultsGrid();
        results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Searching...</p></div>`;
    });

    try {
        const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();

        if (!data.cards?.length) {
            animateWatchlistModalResize(() => {
                resetResultsGrid();
                results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>${data.message || 'No cards found.'}</p></div>`;
            });
            return;
        }

        const uniqueIds = new Set(data.cards.map(c => c.card_id));
        if (uniqueIds.size === 1) {
            const card = data.cards[0];
            await goToWatchlistFoilStep(card.card_id, card.edition_id, card.name);
            return;
        }

        // The tile images reserve their aspect ratio via CSS (aspect-ratio: 5/7 on
        // .inv-search-tile img), so the grid's height is known immediately without
        // waiting on images to load.
        animateWatchlistModalResize(() => {
            results.innerHTML = '';
            const cols = Math.min(data.cards.length, 5);
            results.style.gridTemplateColumns = `repeat(${cols}, 255px)`;
            results.classList.toggle('has-scroll', data.cards.length >= 6);

            data.cards.forEach((card, i) => {
                const tile = document.createElement('div');
                tile.className = 'inv-search-tile tile-hoverable';
                tile.style.animationDelay = `${Math.min(i, 20) * 30}ms`;
                tile.innerHTML = `
                    <div class="edition-tile-wrap tile-zoom">
                        <img src="/images/${card.edition_id}.jpg" alt="${escapeHtml(card.name)}">
                        <div class="card-tile-dim"></div>
                        <div class="inv-search-tile-add tile-action-btn">+</div>
                    </div>`;
                tile.onclick = () => goToWatchlistFoilStep(card.card_id, card.edition_id, card.name);
                tile.addEventListener('animationend', () => tile.classList.add('animated'));
                results.appendChild(tile);
            });
        });
    } catch {
        animateWatchlistModalResize(() => {
            resetResultsGrid();
            results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Search failed.</p></div>`;
        });
    }
}

function openWatchlistModalToFoilStep(cardId, editionId, cardName, onlyThisEdition = false) {
    // This bypasses the search step entirely, but goToWatchlistFoilStep's resize
    // animation still measures the (hidden) search step's current size as its "from" —
    // a stale wide grid left over from an earlier search would otherwise make the box
    // start too wide instead of growing cleanly from its narrow default.
    const results = document.getElementById('watchlist-card-results');
    if (results) {
        results.style.gridTemplateColumns = '';
        results.classList.remove('has-scroll');
    }
    document.getElementById('watchlist-add-modal').classList.remove('hidden');
    goToWatchlistFoilStep(cardId, editionId, cardName, onlyThisEdition);
}

// onlyThisEdition restricts the foil list to just editionId — used when the
// caller already picked one exact printing (e.g. the Prices Card Search
// grid, which shows a separate tile per printing via all_prints=1) so the
// modal doesn't re-list every other printing of the card on top of that.
async function goToWatchlistFoilStep(cardId, editionId, cardName, onlyThisEdition = false) {
    watchlistCardId = cardId;
    watchlistCardName = cardName;

    document.getElementById('watchlist-modal-name').textContent = cardName;
    document.getElementById('watchlist-modal-set').textContent = '';
    document.getElementById('watchlist-modal-img').src = `/images/${editionId}.jpg`;
    document.getElementById('watchlist-modal-foils').innerHTML = '<div style="font-size:0.78rem;color:var(--text-muted);">Loading...</div>';
    document.getElementById('watchlist-modal-submit').disabled = true;

    // The foils list area is capped/scrollable within the foil step's fixed-height
    // container (.inv-modal-foils { overflow-y: auto } inside the 380px-tall
    // .inv-foil-step-body), so the box's own size is fully determined right here —
    // populating the foils list further down (async, after fetch) never changes it.
    const watchlistBox = document.querySelector('#watchlist-add-modal .inv-modal-wide');
    const stepResizeDone = animateBoxResize(watchlistBox, () => {
        document.getElementById('watchlist-step-search').classList.add('hidden');
        document.getElementById('watchlist-step-foil').classList.remove('hidden');
        document.getElementById('watchlist-back-btn').classList.remove('hidden');
    });

    // The card-data fetch runs in parallel with that resize, but the resize that
    // follows once it resolves (below) waits for this first one to actually finish —
    // this fetch is often fast enough to resolve within a handful of milliseconds,
    // and firing a second resize that quickly would cancel the step-swap resize
    // before it's had any real time to be visible, which is what made clicking a
    // results tile look like nothing happened at all.
    const [fetchResult] = await Promise.all([
        fetch(`/api/cards/${cardId}`).then(res => res.json()).then(data => ({ok: true, data})).catch(() => ({ok: false})),
        stepResizeDone
    ]);

    if (!fetchResult.ok) {
        animateWatchlistModalResize(() => {
            document.getElementById('watchlist-modal-foils').innerHTML = '<div style="font-size:0.78rem;color:var(--error);">Failed to load editions.</div>';
        });
        return;
    }

    try {
        const data = fetchResult.data;
        watchlistCardData = data.card;

        let editions = Object.entries(watchlistCardData.editions || {}).sort((a, b) => {
            const parseNum = s => {
                const m = (s || 'ZZZ').match(/^(\d+)([A-Z]*)$/i);
                return m ? [parseInt(m[1]), m[2] || ''] : [Infinity, s];
            };
            const [nA, sA] = parseNum(a[1].collector_number);
            const [nB, sB] = parseNum(b[1].collector_number);
            return nA !== nB ? nA - nB : sA.localeCompare(sB);
        });

        if (onlyThisEdition) {
            editions = editions.filter(([eid]) => eid === editionId);
        }

        // Unlike decks_ga/inventory's Add Card modal, this modal's foil step never
        // switches to a fixed-width class — its box stays width:max-content, sized to
        // fit whatever's actually in the foils list. So swapping "Loading..." for the
        // real foil buttons here can genuinely change the box's natural size, and needs
        // its own resize animation rather than assuming the size settled back when the
        // step was first revealed.
        animateWatchlistModalResize(() => {
            const foilList = document.getElementById('watchlist-modal-foils');
            foilList.innerHTML = '';

            // Collect every real foil/variant combo across the listed editions
            // before rendering anything — whether there's actually a choice to
            // present isn't known until the whole set is gathered.
            const optionEntries = [];
            editions.forEach(([eid, einfo]) => {
                const rarityMap = {1: "C", 2: "U", 3: "R", 4: "SR", 5: "UR", 6: "PR", 7: "CSR", 8: "CUR", 9: "CPR"};
                const rarity = rarityMap[einfo.rarity] || '?';
                Object.entries(einfo.foils || {}).forEach(([fid, finfo]) => {
                    // A foil whose entire population is a single variant (see
                    // _curio_foil_id_for_edition in app.py — the "exactly one
                    // variant" rule that identifies a true Curio Foil, e.g.
                    // Lunar Conduit/RDOA) has no separate base printing of its
                    // own — every copy that would otherwise be a plain "Foil" IS
                    // the Curio Foil — so offer only the Curio Foil option
                    // instead of a redundant, nonexistent plain-Foil one too.
                    const sole = soleCurioVariant(finfo);
                    if (sole) {
                        const [vid, vinfo] = sole;
                        optionEntries.push({eid, fid: vid, kind: vinfo.kind, setPrefix: einfo.set_prefix, rarity, collectorNum: einfo.collector_number, isVariant: false});
                        return;
                    }

                    optionEntries.push({eid, fid, kind: finfo.kind, setPrefix: einfo.set_prefix, rarity, collectorNum: einfo.collector_number, isVariant: false});
                    Object.entries(finfo.variants || {}).forEach(([vid, vinfo]) => {
                        optionEntries.push({eid, fid: vid, kind: vinfo.kind, setPrefix: einfo.set_prefix, rarity, collectorNum: einfo.collector_number, isVariant: true});
                    });
                });
            });

            let firstOpt = null;
            // If the caller identified a specific printing (e.g. a tile clicked in
            // the all-editions search results), preselect that one instead of
            // always defaulting to the first in collector-number order.
            let matchOpt = null;

            optionEntries.forEach(entry => {
                const opt = buildWatchlistFoilOption(entry.eid, entry.fid, entry.kind, entry.setPrefix, entry.rarity, entry.collectorNum, entry.isVariant);
                if (!firstOpt) firstOpt = {opt, eid: entry.eid, fid: entry.fid};
                if (!matchOpt && entry.eid === editionId) matchOpt = {opt, eid: entry.eid, fid: entry.fid};
                foilList.appendChild(opt);
            });

            const initialOpt = matchOpt || firstOpt;
            if (initialOpt) selectWatchlistFoilOption(initialOpt.opt, initialOpt.eid, initialOpt.fid);
        });
    } catch {
        animateWatchlistModalResize(() => {
            document.getElementById('watchlist-modal-foils').innerHTML = '<div style="font-size:0.78rem;color:var(--error);">Failed to load editions.</div>';
        });
    }
}

// Mirrors soleVariantOf in drawer.js — returns the [variantId, variantInfo]
// entry to fold in as the sole Curio Foil option, or null when this foil has
// a real base printing of its own alongside its variant(s).
function soleCurioVariant(foilInfo) {
    const variants = Object.entries(foilInfo.variants || {});
    if (variants.length !== 1) return null;
    const [, variantInfo] = variants[0];
    const basePop = (foilInfo.population ?? 0) - (variantInfo.population ?? 0);
    return basePop <= 0 ? variants[0] : null;
}

// Given a Curio Foil variant's own id, finds the parent foil id whose entire
// population it accounts for (see soleCurioVariant) — that parent's own
// scraped pricing data belongs to this variant too (see showPriceGraph).
// Returns null for a variant with a real base printing alongside it.
function findSoleCurioParent(foils, foilId) {
    for (const [parentId, finfo] of Object.entries(foils || {})) {
        const sole = soleCurioVariant(finfo);
        if (sole && sole[0] === foilId) return parentId;
    }
    return null;
}

function foilOptionLabel(kind) {
    return kind ? kind.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'Standard';
}

function buildWatchlistFoilOption(editionId, foilId, kind, setPrefix, rarity, collectorNum, isVariant) {
    const label = foilOptionLabel(kind);
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
    // history before deciding whether to add it to their watchlist. Not a
    // real selection yet (they haven't committed to adding it), so this
    // shouldn't overwrite the URL's current selection.
    if (watchlistCardId && watchlistCardName) {
        showPriceGraph(watchlistCardId, editionId, foilId, watchlistCardName, false);
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
        // A freshly-rendered set of tiles has no idea what's currently
        // selected — if the graphed card happens to reappear in this
        // search, its ring needs to show up immediately, not just after
        // the next selection change.
        highlightSelectedPriceCard();
    } catch {
        results.innerHTML = `<div class="inv-search-placeholder"><span class="inv-empty-icon">⬡</span><p>Search failed.</p></div>`;
    }
}

// Mirrors buildCardTile() from the regular Cards page (same card-tile markup
// and styling). Selecting the tile itself behaves like a watchlist row (see
// selectPriceSearchCard) — only the "+" overlay button opens the watchlist
// add modal, scoped to just this one printing since each tile here is a
// single edition (all_prints=1).
function buildPriceSearchTile(card, index, total = 1) {
    const rarity = rarityMap[card.rarity] || '';
    const rarityClass = `rarity-${rarity.toLowerCase()}`;

    const tile = document.createElement('div');
    // Card Search works for guests too (only the watchlist itself needs an
    // account) — matches buildCardTile() on the regular Cards page, which
    // makes the same currentUser-based split for the same reason: the
    // --authed hover treatment (dim + fading badges, see tiles.css) only
    // makes sense when there's an add-to-watchlist button underneath it.
    tile.className = currentUser ? 'card-tile card-tile--authed tile-hoverable' : 'card-tile card-tile--guest tile-hoverable';
    tile.dataset.cardId = card.card_id;
    tile.dataset.editionId = card.edition_id;
    const maxDelay = 400;
    const delay = total <= 1 ? 0 : Math.min(index * 40, Math.round((index / (total - 1)) * maxDelay));
    tile.style.animationDelay = `${delay}ms`;
    const caption = (card.set_prefix || card.collector_number)
        ? `<div class="prices-tile-caption">${escapeHtml(card.set_prefix || '—')} · #${escapeHtml(card.collector_number || '?')}</div>`
        : '';
    tile.innerHTML = `
        <div class="prices-search-tile-media tile-zoom">
            <div class="edition-tile-wrap">
                <img src="/images/${card.edition_id}.jpg" alt="${escapeHtml(card.name)}"
                    onerror="this.parentElement.parentElement.parentElement.innerHTML='<div class=card-tile-missing>${escapeHtml(card.name)}</div>'">
                ${rarity ? `<span class="edition-rarity-badge ${rarityClass}">${rarity}</span>` : ''}
            </div>
        </div>
        ${card.last_price != null ? `<span class="inv-price-badge">$${Number(card.last_price).toFixed(2)}</span>` : ''}
        ${caption}`;
    tile.onclick = () => selectPriceSearchCard(card);
    tile.addEventListener('animationend', () => tile.classList.add('animated'));
    attachPriceSearchAddOverlay(tile, card);
    return tile;
}

// Same not-selected/already-selected split as the watchlist tiles
// (renderWatchlist in loadWatchlist's click binding): clicking a printing
// that isn't already driving the graph selects it and loads the graph;
// clicking the one that's already selected opens the card drawer instead.
// Search results carry an edition but not a specific foil, so "selected" is
// judged on card+edition only, and a default foil is resolved on demand to
// actually drive the graph.
async function selectPriceSearchCard(card) {
    const alreadySelected = priceGraphCard
        && priceGraphCard.cardId === card.card_id
        && priceGraphCard.editionId === card.edition_id;

    if (alreadySelected) {
        openCardDrawer(card.card_id, card.edition_id, card.name);
        return;
    }

    const foilId = await resolveDefaultFoil(card.card_id, card.edition_id);
    if (!foilId) return;
    showPriceGraph(card.card_id, card.edition_id, foilId, card.name);
}

// Card Search tiles only carry a card+edition, not a specific foil (there's
// no foil picker in this grid) — pick the same default a fresh watchlist
// add would land on, so a plain click still has a foil to graph.
async function resolveDefaultFoil(cardId, editionId) {
    try {
        const res = await fetch(`/api/cards/${cardId}`);
        const data = await res.json();
        const foils = data.card?.editions?.[editionId]?.foils;
        return foils ? pickDefaultFoil(foils) : null;
    } catch {
        return null;
    }
}

// Hover affordance for search-result tiles, echoing the Cards page's hover
// treatment (dim layer, badges fading) but styled like the inventory qty
// "+" button (tiles.js/inventory.css) rather than the full-cover "+" used in
// the watchlist modal's own search step — white instead of green since this
// isn't a quantity action, just "add to watchlist". This button is the only
// thing on the tile that opens the add modal; clicking anywhere else selects
// the card instead (see selectPriceSearchCard).
function attachPriceSearchAddOverlay(tile, card) {
    if (!currentUser) return;

    const wrap = tile.querySelector('.edition-tile-wrap');
    if (!wrap) return;

    const dim = document.createElement('div');
    dim.className = 'card-tile-dim';
    wrap.insertBefore(dim, wrap.firstChild);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'prices-search-add-btn tile-action-btn';
    addBtn.title = 'Add to watchlist';
    addBtn.textContent = '+';
    addBtn.onclick = e => {
        e.stopPropagation();
        openWatchlistModalToFoilStep(card.card_id, card.edition_id, card.name, true);
    };
    wrap.appendChild(addBtn);
}

// Use capture so it fires even inside stopPropagation — guarded to the prices page only
document.addEventListener('click', e => {
    if (!document.getElementById('watchlist-add-modal')) return;
    if (!e.target.closest('#watchlist-card-search') && !e.target.closest('#watchlist-card-autocomplete')) hideWatchlistAc();
    if (!e.target.closest('#price-search-input') && !e.target.closest('#price-search-autocomplete')) hidePriceSearchAc();
}, true);

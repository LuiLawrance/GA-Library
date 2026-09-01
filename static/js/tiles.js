// ═══════════════════════════════════════
// tiles.js — shared card tile behaviour
// Used by: inventory, card search, and any future page
// ═══════════════════════════════════════

// ── Shared foil label formatter ──
function toFoilLabel(s) {
    return s ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : '';
}

// ── Sale/listing price badge markup — shared by Cards, Inventory, and the
// drawer's edition grid. Sale (green) always sits on top; the listing (red)
// badge stacks under it, or takes its spot via .inv-listing-badge--solo
// when there's no sale price to stack under. ──
function priceBadgesHTML(lastPrice, lowestListing) {
    let html = '';
    if (lastPrice != null) {
        html += `<span class="inv-price-badge">$${Number(lastPrice).toFixed(2)}</span>`;
    }
    if (lowestListing != null) {
        const solo = lastPrice == null ? ' inv-listing-badge--solo' : '';
        html += `<span class="inv-listing-badge${solo}">$${Number(lowestListing).toFixed(2)}</span>`;
    }
    return html;
}

// ── Loading placeholder shown over a tile's image while it downloads — see
// .tile-img-spinner (cards.css). Shared by Cards search results and the
// drawer's edition grid. revealTileImage below (wired as the img's onload)
// fades this out; a caller that also wires onerror can reuse it there too,
// to fade out the spinner rather than leaving it spinning on a failed load. ──
const TILE_SPINNER_SVG = `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M20 4v5h-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
`;

// Crossfades a tile's image in over its loading spinner once the image is
// ready, rather than snapping from one to the other instantly — reuses
// fadeSwap's fade-out/mutate/fade-in mechanic (animation.js), the same one
// page navigation and the drawer's edition switch already use.
// .tile-img-spinner's own fade-out/fade-in pair (not main.css's generic
// .content one) lives in cards.css, per fadeSwap's own convention that each
// caller defines the CSS shape for whatever it's fading.
function revealTileImage(img) {
    const spinner = img.previousElementSibling;

    if (!spinner || !spinner.classList.contains('tile-img-spinner')) {
        img.classList.add('tile-img-loaded');
        return;
    }

    fadeSwap(spinner, () => {
        spinner.remove();
        img.classList.add('tile-img-loaded');
    }, {outMs: 150, inMs: 200});
}

// ── Viewport-gated, concurrency-limited image loading queue ──
// Every card image request — even with images cached server-side — goes
// through OUR OWN server (/images/{id}.jpg, /set-images/{name}.png), and
// browsers cap concurrent connections per origin (commonly ~6). A big result
// grid setting dozens or hundreds of <img src> at once saturates that cap
// entirely: anything else hitting the server afterward — opening the drawer,
// its own edition images, a new search, /api/me — has to sit queued BEHIND
// the whole grid's requests at the browser level before the server ever even
// receives it. A server-side fix (e.g. a bounded thread pool for downloads)
// can't touch this — the browser hasn't sent the request yet to be handled.
//
// Two layers deal with that here:
//   1. A viewport gate (IntersectionObserver). Pages like Cards, My Decks,
//      and Inventory can lay out hundreds of tiles at once, almost all of
//      them scrolled well out of view. Those don't get queued at all until
//      they're about to enter the viewport — so with "Store Images Locally"
//      off (every hit a live redirect to the upstream API) we're not firing
//      hundreds of upstream fetches for art nobody has scrolled to yet.
//   2. A concurrency cap on the tiles that DO get queued, so even a fast
//      scroll through a long list keeps a few connection slots free for
//      everything else.
const TILE_IMG_MAX_CONCURRENT = 4;

// How far outside the viewport a tile can be and still start loading. A
// one-ish-screen buffer so images finish just before they're scrolled to,
// rather than visibly popping in late.
const TILE_IMG_VIEWPORT_MARGIN = '800px';

const _tileImgSupported = typeof IntersectionObserver === 'function';

let _tileImgActive = 0;
const _tileImgQueue = [];

// Tiles parked until they scroll near view. <img> → {src, observer}.
// `observer` is null between queueTileImageLoad (which parks it) and the
// microtask that actually attaches it (see _attachParked). Tracked in this
// map — not just left living inside the observer — so a re-render that
// throws the old grid away (every one of these pages clears its grid with
// `container.innerHTML = ''`) can have its now-detached imgs, and their src
// strings, swept back out instead of pinned for the life of the page.
const _tileImgParked = new Map();

// One IntersectionObserver per scroll root. The Cards grid scrolls with the
// page (root null); the Inventory and My Decks grids scroll inside their own
// overflow container, and the near-view buffer (rootMargin) only means
// anything when it's measured against the box that actually clips the tiles
// — so each such container gets its own observer keyed on that element.
const _tileImgObservers = new Map(); // rootEl|null → IntersectionObserver

function _tileImgObserverFor(root) {
    // Prune observers whose scroll container has since been removed from the
    // page (SPA navigation swaps the whole grid out) — otherwise every visit
    // to a page leaves its previous grid's observer behind for good.
    for (const [el, obs] of _tileImgObservers) {
        if (el && !el.isConnected) {
            obs.disconnect();
            _tileImgObservers.delete(el);
        }
    }

    let observer = _tileImgObservers.get(root);
    if (!observer) {
        observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = entry.target;
                observer.unobserve(img);
                const parked = _tileImgParked.get(img);
                _tileImgParked.delete(img);
                if (parked && img.isConnected) _tileImgQueue.push({img, src: parked.src});
            }
            _pumpTileImgQueue();
        }, {root, rootMargin: `${TILE_IMG_VIEWPORT_MARGIN} 0px`});
        _tileImgObservers.set(root, observer);
    }
    return observer;
}

// Nearest scrollable ancestor of `el` (the box the tile scrolls within), or
// null for the page/viewport. Mirrors what the browser uses as the clip for
// intersection, so the observer's root matches. Positive hits are memoised
// per ancestor: every tile in one grid shares the chain above it, so once
// the grid's own scroll container is found for the first tile the rest short
// -circuit to it. (Only positives are cached — a "not scrollable yet"
// container can start overflowing on the next, bigger render.)
const _tileImgScrollRootCache = new WeakMap(); // ancestor element → its own scroll rootEl

function _tileImgScrollRoot(el) {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        // Sibling tiles share every ancestor from the grid container upward,
        // so this hits on the second tile onward in a grid that scrolls
        // internally.
        if (_tileImgScrollRootCache.has(node)) return _tileImgScrollRootCache.get(node);

        const oy = getComputedStyle(node).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) {
            _tileImgScrollRootCache.set(node, node);
            return node;
        }
    }
    return null;
}

// Drop parked tiles whose grid has since been torn down — their imgs are no
// longer in the document, so they'll never intersect and would otherwise sit
// in their observer (and this map) forever. Cheap, and runs exactly when it
// matters: each new queue call means a fresh grid is being built.
//
// Only entries that have already been handed to an observer are considered:
// a tile parked earlier in the *current* build loop (observer still null)
// isn't connected yet either — its grid is built detached and appended in
// one go (My Decks does this for a whole section at a time) — but it's not
// stale, just not attached yet. Its own _attachParked microtask does the
// real connected check.
function _sweepParkedTiles() {
    for (const [img, parked] of _tileImgParked) {
        if (parked.observer && !img.isConnected) {
            parked.observer.unobserve(img);
            _tileImgParked.delete(img);
        }
    }
}

// Queues `img` to load `src` once a slot is free, rather than setting
// img.src directly (which starts the fetch immediately, uncontrolled).
// Callers build their tile markup with no src at all (or a bare <img> with
// its URL kept only in a JS variable) and call this right after inserting
// the tile into the DOM.
//
// priority:true skips the viewport gate and jumps the front of the queue —
// for a small surface the user is looking at right now (the drawer's edition
// thumbnails), not an off-screen result grid working through a big batch;
// otherwise the drawer's own images would just wait their turn behind
// whatever the grid queued first.
function queueTileImageLoad(img, src, {priority = false} = {}) {
    if (priority || !_tileImgSupported) {
        // No observer support → fall back to the old "queue everything now"
        // behaviour (still concurrency-capped).
        if (priority) {
            _tileImgQueue.unshift({img, src});
        } else {
            _tileImgQueue.push({img, src});
        }

        // Deferred a tick rather than pumped synchronously — this runs from
        // inside a tile-builder function (buildCardTile etc.) whose own
        // caller appends the returned tile right after, so `img` isn't
        // connected to the DOM yet at this exact point. A microtask runs
        // once that build loop (and its appendChild calls) has finished, so
        // _pumpTileImgQueue's isConnected check sees where things landed
        // instead of "nothing is connected yet" — which would skip every
        // tile and leave every spinner stuck forever.
        queueMicrotask(_pumpTileImgQueue);
        return;
    }

    _sweepParkedTiles();
    _tileImgParked.set(img, {src, observer: null});

    // Hold the loading spinner still while parked — a long list can park
    // hundreds of tiles at once, and nothing is actually in flight for them
    // yet. _pumpTileImgQueue starts it spinning when the load really begins.
    _tileSpinnerFor(img)?.classList.add('tile-img-spinner--parked');

    // Deferred a tick before observe() for the same reason the fallback path
    // defers its pump: the tile isn't connected yet here, and we need it laid
    // out in the DOM both to find its scroll container and for the observer
    // to report a real position. The observer's own first callback is async
    // anyway, so this costs nothing.
    queueMicrotask(() => _attachParked(img));
}

function _attachParked(img) {
    const parked = _tileImgParked.get(img);
    if (!parked || parked.observer) return;

    if (!img.isConnected) {
        _tileImgParked.delete(img);
        return;
    }

    parked.observer = _tileImgObserverFor(_tileImgScrollRoot(img));
    parked.observer.observe(img);
}

// The tile's loading spinner (previous sibling of its <img>), or null — some
// callers render no spinner (e.g. a deck tile with no resolved edition yet).
function _tileSpinnerFor(img) {
    const s = img.previousElementSibling;
    return s && s.classList.contains('tile-img-spinner') ? s : null;
}

function _pumpTileImgQueue() {
    while (_tileImgActive < TILE_IMG_MAX_CONCURRENT && _tileImgQueue.length) {
        const {img, src} = _tileImgQueue.shift();

        // The tile may have been torn down already (e.g. a new search
        // replaced the whole grid) before its turn came up — skip it rather
        // than spending a slot loading art nobody will ever see.
        if (!img.isConnected) continue;

        // Load is actually starting now — let the spinner spin (no-op if it
        // was never parked).
        _tileSpinnerFor(img)?.classList.remove('tile-img-spinner--parked');

        _tileImgActive++;

        const release = () => {
            _tileImgActive--;
            _pumpTileImgQueue();
        };

        img.addEventListener('load', release, {once: true});
        img.addEventListener('error', release, {once: true});
        img.src = src;
    }
}

// ── Look up a foil's info by id, checking each foil's variants (e.g. a
// Curio Foil) when it isn't a top-level foil id itself. Mirrors
// _foil_kind_for_id in pricing_ga.py. ──
function resolveFoilInfo(foils, foilId) {
    if (!foils) return null;
    if (foils[foilId]) return foils[foilId];
    for (const finfo of Object.values(foils)) {
        if (finfo.variants?.[foilId]) return finfo.variants[foilId];
    }
    return null;
}

// ── Foil priority: normal/nonfoil > foil > anything else ──
function pickDefaultFoil(foils) {
    const priority = kind => {
        const k = (kind || '').toLowerCase();
        if (k === 'normal' || k === 'nonfoil') return 0;
        if (k === 'foil') return 1;
        return 2;
    };
    return Object.entries(foils)
        .sort((a, b) => priority(a[1].kind) - priority(b[1].kind))[0]?.[0] ?? null;
}

// ── Inventory snapshot (default bin) ──
let invSnapshot = {};
let invSnapshotSections = {}; // card→edition→foil→section (default bin)
const INV_QUICKADD_SECTION = 'Unsorted';

async function loadInvSnapshot() {
    if (!currentUser) {
        invSnapshot = {};
        return;
    }
    try {
        const res = await fetch('/api/inventory');
        if (!res.ok) {
            invSnapshot = {};
            return;
        }
        const data = await res.json();
        const bins = data.bins || {};
        const defaultBin = Object.values(bins).find(b => b.default);
        invSnapshot = {};
        invSnapshotSections = {};
        for (const [sectionName, cards] of Object.entries(defaultBin?.sections || {})) {
            for (const [cid, eds] of Object.entries(cards)) {
                for (const [eid, foils] of Object.entries(eds)) {
                    for (const [fid, qty] of Object.entries(foils)) {
                        (invSnapshot[cid] ??= {})[eid] ??= {};
                        invSnapshot[cid][eid][fid] = qty;
                        (invSnapshotSections[cid] ??= {})[eid] ??= {};
                        invSnapshotSections[cid][eid][fid] = sectionName;
                    }
                }
            }
        }
    } catch {
        invSnapshot = {};
    }
}

function snapQty(cardId, editionId) {
    const m = invSnapshot[cardId]?.[editionId];
    if (!m) return 0;
    return Object.values(m).reduce((s, q) => s + q, 0);
}

// ── Default bin name cache ──
let _defaultBinName = null;

async function getDefaultBinName() {
    if (_defaultBinName) return _defaultBinName;
    try {
        const res = await fetch('/api/inventory');
        if (!res.ok) return null;
        const data = await res.json();
        const bins = data.bins || {};
        _defaultBinName = Object.entries(bins).find(([, b]) => b.default)?.[0] ?? null;
    } catch {
        _defaultBinName = null;
    }
    return _defaultBinName;
}

// ── Commit a quantity change to the default bin ──
async function commitQtyToDefault(cardId, editionId, foilId, newQty) {
    const binName = await getDefaultBinName();
    if (!binName) return;

    const exists = invSnapshot[cardId]?.[editionId]?.[foilId] !== undefined;

    if (newQty <= 0) {
        if (exists) {
            await fetch('/api/inventory/card', {
                method: 'DELETE',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    bin: binName,
                    section: invSnapshotSections[cardId]?.[editionId]?.[foilId] || INV_QUICKADD_SECTION,
                    card_id: cardId, edition_id: editionId, foil_id: foilId
                })
            });
            delete invSnapshot[cardId]?.[editionId]?.[foilId];
        }
    } else if (exists) {
        await fetch('/api/inventory/card', {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                bin: binName,
                section: invSnapshotSections[cardId]?.[editionId]?.[foilId] || INV_QUICKADD_SECTION,
                card_id: cardId,
                edition_id: editionId,
                foil_id: foilId,
                quantity: newQty
            })
        });
    } else {
        await fetch('/api/inventory/card', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                bin: binName,
                section: (typeof cardSearchTargetSection === 'string' && cardSearchTargetSection) || INV_QUICKADD_SECTION,
                card_id: cardId,
                edition_id: editionId,
                foil_id: foilId,
                quantity: newQty
            })
        });
        (invSnapshotSections[cardId] ??= {})[editionId] ??= {};
        invSnapshotSections[cardId][editionId][foilId] =
            (typeof cardSearchTargetSection === 'string' && cardSearchTargetSection) || INV_QUICKADD_SECTION;
    }

    if (!invSnapshot[cardId]) invSnapshot[cardId] = {};
    if (!invSnapshot[cardId][editionId]) invSnapshot[cardId][editionId] = {};
    invSnapshot[cardId][editionId][foilId] = newQty;
}

// ══════════════════════════════════════════════════════════
// TileEditMode — reusable edit mode for any tile grid
// ══════════════════════════════════════════════════════════
// Usage:
//   const myEditMode = new TileEditMode('bar-element-id', async (changes) => { ... });
//   myEditMode.stage(input, originalValue);  // call on scroll/change
//   myEditMode.apply();                      // confirm button
//   myEditMode.discard();                    // discard button
//   myEditMode.isActive();                   // whether edit mode is on
// ──────────────────────────────────────────────────────────
class TileEditMode {
    constructor(barId, commitFn) {
        this.barId = barId;
        this.commitFn = commitFn;         // async fn(changes: [{input, cardId, editionId, foilId, quantity}])
        this.pending = new Map();         // input → originalValue
    }

    isActive() {
        return this.pending.size > 0;
    }

    stage(input, originalValue) {
        if (!this.pending.has(input)) {
            this.pending.set(input, originalValue);
        }

        const currentValue = parseInt(input.value) || 0;
        const storedOriginal = this.pending.get(input);

        if (currentValue === storedOriginal) {
            // Returned to original — remove from pending and clear indicator
            this.pending.delete(input);
            const tile = input.closest('.inv-card-tile') ?? input.closest('.card-tile');
            if (tile) this._clearIndicator(tile);

            // If nothing else is pending, exit edit mode entirely
            if (!this.pending.size) {
                this._hideBar();
                return;
            }
        } else {
            this._updateIndicator(input);
        }

        this._showBar();
    }

    async apply() {
        if (!this.pending.size) return;

        // Snapshot before any DOM changes
        const changes = [...this.pending.entries()].map(([input, origVal]) => ({
            input,
            origVal,
            quantity: Math.max(0, parseInt(input.value) || 0),
            cardId: input.dataset.cardId,
            editionId: input.dataset.editionId,
            foilId: input.dataset.foilId,
            section: input.dataset.section,
        }));

        this.pending.clear();
        this._clearAllIndicators();

        await this.commitFn(changes);

        // Flash green
        const bar = document.getElementById(this.barId);
        if (bar) {
            bar.classList.add('confirmed');
            const msg = bar.querySelector('.inv-qty-confirm-msg');
            if (msg) msg.textContent = 'Changes applied';
            setTimeout(() => this._hideBar(), 1500);
        }
    }

    discard(immediate = false) {
        for (const [input, originalValue] of this.pending) {
            input.value = originalValue;
            const badge = input.closest('[data-card-id]')?.querySelector('.inv-qty-badge')
                ?? input.closest('.inv-card-tile')?.querySelector('.inv-qty-badge')
                ?? input.closest('.card-tile')?.querySelector('.inv-qty-badge');
            if (badge) {
                badge.textContent = `x${originalValue}`;
                badge.style.display = originalValue > 0 ? '' : 'none';
            }
        }
        this.pending.clear();
        this._clearAllIndicators();
        this._hideBar(immediate);
    }

    // ── Indicator helpers ──

    _updateIndicator(input) {
        const tile = input.closest('.inv-card-tile') ?? input.closest('.card-tile');
        if (!tile) return;

        const originalValue = this.pending.get(input);
        if (originalValue === undefined) {
            this._clearIndicator(tile);
            return;
        }

        const currentValue = parseInt(input.value) || 0;
        const delta = currentValue - originalValue;

        let ind = tile.querySelector('.inv-tile-qty-indicator');
        if (!ind) {
            ind = document.createElement('div');
            ind.className = 'inv-tile-qty-indicator';
            tile.appendChild(ind);
        }

        tile.classList.add('has-pending');

        if (currentValue === 0) {
            ind.innerHTML = '<div class="inv-tile-qty-indicator-box indicator-del">🗑</div>';
        } else if (delta > 0) {
            ind.innerHTML = `<div class="inv-tile-qty-indicator-box indicator-add">+${delta}</div>`;
        } else {
            ind.innerHTML = `<div class="inv-tile-qty-indicator-box indicator-sub">${delta}</div>`;
        }
    }

    _clearIndicator(tile) {
        tile.classList.remove('has-pending');
        const ind = tile.querySelector('.inv-tile-qty-indicator');
        if (ind) ind.innerHTML = '';
    }

    _clearAllIndicators() {
        document.querySelectorAll('.has-pending').forEach(tile => this._clearIndicator(tile));
    }

    // ── Bar helpers ──

    _showBar() {
        const bar = document.getElementById(this.barId);
        if (!bar) return;
        bar.classList.remove('hidden', 'confirmed');
        const msg = bar.querySelector('.inv-qty-confirm-msg');
        if (msg) msg.textContent = 'Confirm changes?';
        void bar.offsetWidth;
        bar.classList.add('visible');
    }

    _hideBar(immediate = false) {
        const bar = document.getElementById(this.barId);
        if (!bar) return;
        bar.classList.remove('visible', 'confirmed');
        if (immediate) {
            bar.classList.add('hidden');
        } else {
            setTimeout(() => bar.classList.add('hidden'), 230);
        }
    }
}

// ── Standalone indicator helpers (used by inventory.js) ──
function updateTileIndicator(input, pendingMap) {
    const tile = input.closest('.inv-card-tile') ?? input.closest('.card-tile');
    if (!tile) return;
    const originalValue = pendingMap.get(input);
    if (originalValue === undefined) {
        clearTileIndicator(tile);
        return;
    }
    const currentValue = parseInt(input.value) || 0;
    const delta = currentValue - originalValue;
    let ind = tile.querySelector('.inv-tile-qty-indicator');
    if (!ind) {
        ind = document.createElement('div');
        ind.className = 'inv-tile-qty-indicator';
        tile.appendChild(ind);
    }
    tile.classList.add('has-pending');
    if (currentValue === 0) {
        ind.innerHTML = '<div class="inv-tile-qty-indicator-box indicator-del">🗑</div>';
    } else if (delta > 0) {
        ind.innerHTML = `<div class="inv-tile-qty-indicator-box indicator-add">+${delta}</div>`;
    } else {
        ind.innerHTML = `<div class="inv-tile-qty-indicator-box indicator-sub">${delta}</div>`;
    }
}

function clearTileIndicator(tile) {
    tile.classList.remove('has-pending');
    const ind = tile.querySelector('.inv-tile-qty-indicator');
    if (ind) ind.innerHTML = '';
}

function clearAllIndicators() {
    document.querySelectorAll('.has-pending').forEach(clearTileIndicator);
}

// ── Card search edit mode instance ──
// Wired to the cards-qty-confirm-bar; commits directly to the default bin.
const cardsEditMode = new TileEditMode('cards-qty-confirm-bar', async (changes) => {
    for (const c of changes) {
        if (!c.foilId) continue;
        await commitQtyToDefault(c.cardId, c.editionId, c.foilId, c.quantity);
        // Update badge after commit
        const badge = c.input.closest('.card-tile')?.querySelector('.inv-qty-badge');
        if (badge) {
            badge.textContent = `x${c.quantity}`;
            badge.style.display = c.quantity > 0 ? '' : 'none';
        }
    }
});

// ── Attach inventory overlay to any card tile ──
function attachInvOverlay(tile, cardId, editionId, cardName) {
    if (!currentUser) return;

    const qty = snapQty(cardId, editionId);

    // Dim layer inside .edition-tile-wrap
    const wrap = tile.querySelector('.edition-tile-wrap');
    if (wrap && !wrap.querySelector('.card-tile-dim')) {
        const dim = document.createElement('div');
        dim.className = 'card-tile-dim';
        wrap.insertBefore(dim, wrap.firstChild);
    }

    // Qty badge
    const badge = document.createElement('span');
    badge.className = 'inv-qty-badge';
    badge.style.display = qty > 0 ? '' : 'none';
    badge.textContent = `x${qty}`;
    tile.appendChild(badge);

    // Name/foil overlay
    const overlay = document.createElement('div');
    overlay.className = 'inv-card-tile-overlay';
    overlay.innerHTML = `
        <div class="inv-card-tile-info">
            <div class="inv-card-tile-name">${cardName}</div>
            <div class="inv-card-tile-foil" data-foil-label="${cardId}-${editionId}">—</div>
        </div>`;
    tile.appendChild(overlay);

    // Indicator (shown when edit mode is active and mouse is not hovering)
    const indicator = document.createElement('div');
    indicator.className = 'inv-tile-qty-indicator';
    tile.appendChild(indicator);

    // +/input/− controls
    const ctrl = document.createElement('div');
    ctrl.className = 'inv-card-tile-qty-ctrl';
    ctrl.innerHTML = `
        <button class="inv-tile-qty-btn inv-tile-qty-add" type="button">+</button>
        <input class="inv-tile-qty-input" type="number" value="${qty}" min="0" max="999"
            data-card-id="${cardId}" data-edition-id="${editionId}">
        <button class="inv-tile-qty-btn inv-tile-qty-sub" type="button">−</button>`;
    tile.appendChild(ctrl);

    // Resolve foil lazily on first hover
    let foilId = null;
    let foilResolved = false;

    async function resolveFoil() {
        if (foilResolved) return foilId;
        foilResolved = true;
        try {
            const res = await fetch(`/api/cards/${cardId}`);
            const data = await res.json();
            const editionInfo = data.card?.editions?.[editionId];
            if (editionInfo?.foils) {
                foilId = pickDefaultFoil(editionInfo.foils);
                const kind = editionInfo.foils[foilId]?.kind || '';
                const label = toFoilLabel(kind) || '—';
                const el = tile.querySelector(`[data-foil-label="${cardId}-${editionId}"]`);
                if (el) el.textContent = label;
                // Store foilId on input for commitFn to read
                ctrl.querySelector('.inv-tile-qty-input').dataset.foilId = foilId;
            }
        } catch { /* silent */
        }
        return foilId;
    }

    tile.addEventListener('mouseenter', resolveFoil, {once: true});

    const input = ctrl.querySelector('.inv-tile-qty-input');

    async function adjustQty(delta) {
        const fid = await resolveFoil();
        if (!fid) return;
        const before = parseInt(input.value) || 0;
        const newQty = Math.max(0, before + delta);
        input.value = newQty;
        if (cardsEditMode.isActive()) {
            cardsEditMode.stage(input, before);
        } else {
            await commitQtyToDefault(cardId, editionId, fid, newQty);
            updateBadge(newQty);
        }
    }

    function updateBadge(newQty) {
        badge.textContent = `x${newQty}`;
        badge.style.display = newQty > 0 ? '' : 'none';
    }

    ctrl.querySelector('.inv-tile-qty-add').addEventListener('click', e => {
        e.stopPropagation();
        adjustQty(1);
    });
    ctrl.querySelector('.inv-tile-qty-sub').addEventListener('click', e => {
        e.stopPropagation();
        adjustQty(-1);
    });

    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', async () => {
        const fid = await resolveFoil();
        const val = Math.max(0, parseInt(input.value) || 0);
        input.value = val;
        if (cardsEditMode.isActive()) {
            const orig = cardsEditMode.pending.has(input)
                ? cardsEditMode.pending.get(input)
                : val;
            cardsEditMode.stage(input, orig);
        } else {
            await commitQtyToDefault(cardId, editionId, fid, val);
            updateBadge(val);
        }
    });
}

// ── Scroll wheel on quantity inputs ──

// Heuristic: only accept discrete mouse-wheel notches, reject trackpad gestures.
// Per-event checks alone leak: trackpad momentum ramps up into large integer
// deltas that mimic wheel notches. So events are grouped into "bursts" (gap of
// less than WHEEL_BURST_GAP_MS between events) and the whole burst inherits the
// classification of how it started. A trackpad flick's momentum tail therefore
// stays blocked, while each spaced mouse notch opens a fresh, cleanly
// classified burst.
const WHEEL_BURST_GAP_MS = 200;
let _wheelBurstLast = 0;
let _wheelBurstIsTrackpad = false;

function _looksLikeTrackpad(e) {
    if (e.ctrlKey) return true;                    // pinch-zoom gesture
    if (e.deltaMode !== 0) return false;           // LINE/PAGE mode = real wheel
    if (e.deltaX !== 0) return true;               // horizontal drift = trackpad
    if (!Number.isInteger(e.deltaY)) return true;  // fractional = trackpad
    return Math.abs(e.deltaY) < 50;                // small steps = trackpad
}

function isMouseWheelEvent(e) {
    const now = performance.now();
    const inBurst = (now - _wheelBurstLast) < WHEEL_BURST_GAP_MS;
    _wheelBurstLast = now;

    if (!inBurst) {
        // New gesture — classify from its opening event
        _wheelBurstIsTrackpad = _looksLikeTrackpad(e);
    } else if (!_wheelBurstIsTrackpad && _looksLikeTrackpad(e)) {
        // Trackpad evidence mid-burst poisons the whole burst
        _wheelBurstIsTrackpad = true;
    }

    return !_wheelBurstIsTrackpad;
}

document.addEventListener('wheel', e => {
    // Burst tracking runs on EVERY wheel event, page-wide — otherwise a
    // trackpad scroll that starts outside the input and drifts over it
    // mid-momentum would open a fresh burst and misclassify as a mouse.
    const accepted = isMouseWheelEvent(e);

    if (!e.target.matches('.inv-tile-qty-input')) return;
    e.preventDefault();

    if (!accepted) return;

    const input = e.target;
    const current = parseInt(input.value) || 0;
    const delta = e.deltaY < 0 ? 1 : -1;
    const newVal = Math.max(0, Math.min(999, current + delta));

    if (newVal === current) return;

    const originalValue = current;
    input.value = newVal;

    const isInvTile = !!input.closest('.inv-card-tile');
    const isCardTile = !!input.closest('.card-tile');

    if (isInvTile && typeof tileQtyStage === 'function') {
        tileQtyStage(input, originalValue);
    } else if (isCardTile) {
        cardsEditMode.stage(input, originalValue);
    } else {
        input.dispatchEvent(new Event('change', {bubbles: true}));
    }
}, {passive: false});
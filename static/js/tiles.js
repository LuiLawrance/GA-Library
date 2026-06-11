// ═══════════════════════════════════════
// tiles.js — shared card tile behaviour
// Used by: inventory, card search, and any future page
// ═══════════════════════════════════════

// ── Shared foil label formatter ──
function toFoilLabel(s) {
    return s ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : '';
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
        invSnapshot = defaultBin?.cards || {};
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
                body: JSON.stringify({bin: binName, card_id: cardId, edition_id: editionId, foil_id: foilId})
            });
            delete invSnapshot[cardId]?.[editionId]?.[foilId];
        }
    } else if (exists) {
        await fetch('/api/inventory/card', {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                bin: binName,
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
                card_id: cardId,
                edition_id: editionId,
                foil_id: foilId,
                quantity: newQty
            })
        });
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
        this._updateIndicator(input);
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
document.addEventListener('wheel', e => {
    if (!e.target.matches('.inv-tile-qty-input')) return;
    e.preventDefault();

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
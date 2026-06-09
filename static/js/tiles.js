// ═══════════════════════════════════════
// tiles.js — shared card tile behaviour
// Used by: inventory, card search, and any future page
// ═══════════════════════════════════════

// ── Shared foil label formatter ──
function toFoilLabel(s) {
    return s ? s.toLowerCase().replace(/\w/g, c => c.toUpperCase()) : '';
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
// { card_id: { edition_id: { foil_id: qty } } }
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

    // Update snapshot
    if (!invSnapshot[cardId]) invSnapshot[cardId] = {};
    if (!invSnapshot[cardId][editionId]) invSnapshot[cardId][editionId] = {};
    invSnapshot[cardId][editionId][foilId] = newQty;
}

// ── Attach inventory overlay to any card tile ──
// Injects: dim layer (inside edition-tile-wrap), qty badge, name/foil overlay, +/input/− controls
// All writes go to the user's default bin.
function attachInvOverlay(tile, cardId, editionId, cardName) {
    if (!currentUser) return;

    const qty = snapQty(cardId, editionId);

    // Dim layer inside .edition-tile-wrap — clipped to card shape by wrap's overflow:hidden
    const wrap = tile.querySelector('.edition-tile-wrap');
    if (wrap && !wrap.querySelector('.card-tile-dim')) {
        const dim = document.createElement('div');
        dim.className = 'card-tile-dim';
        // Insert before first child so it sits beneath the image in z-order
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
            }
        } catch { /* silent */
        }
        return foilId;
    }

    tile.addEventListener('mouseenter', resolveFoil, {once: true});

    async function adjustQty(delta) {
        const fid = await resolveFoil();
        if (!fid) return;
        const input = ctrl.querySelector('.inv-tile-qty-input');
        const newQty = Math.max(0, (parseInt(input.value) || 0) + delta);
        input.value = newQty;
        await commitQtyToDefault(cardId, editionId, fid, newQty);
        updateBadge(newQty);
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

    const input = ctrl.querySelector('.inv-tile-qty-input');
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', async () => {
        const fid = await resolveFoil();
        const val = Math.max(0, parseInt(input.value) || 0);
        input.value = val;
        await commitQtyToDefault(cardId, editionId, fid, val);
        updateBadge(val);
    });
}
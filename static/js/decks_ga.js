// ── State ──
let gaDecks = {};
let activeDeck = null;
let activeDeckData = null;

// ── Add modal state ──
let dgaAddModalCardId = null;
let dgaAddModalCardName = null;
let dgaAddModalEditionId = null;
let dgaAddModalFoilId = null;
let dgaAddModalCardData = null; // full /api/cards/{id} response once the deck is Edition Locked
let dgaAddModalPreSection = null;
let dgaAddAcIndex = -1;

// ── Banner search modal state ──
let dgaBannerTargetDeck = null;
let dgaBannerModalEditionId = null;
let dgaBannerAcIndex = -1;

// ═══════════════════════════════════════
// DECK CONTEXT MENU
// ═══════════════════════════════════════

let dgaCtxTargetDeck = null;

function dgaOpenContextMenu(e, deckName) {
    dgaCtxTargetDeck = deckName;
    const menu = document.getElementById('dga-context-menu');

    // Set Banner and Clear Banner are mutually exclusive — only offer the one
    // that applies to the deck's current state, to keep the menu shorter.
    const hasBanner = !!gaDecks[deckName]?.banner;
    const setBtn = document.getElementById('dga-ctx-set-banner');
    const clearBtn = document.getElementById('dga-ctx-clear-banner');
    if (setBtn) setBtn.style.display = hasBanner ? 'none' : '';
    if (clearBtn) clearBtn.style.display = hasBanner ? '' : 'none';

    // Same mutual-exclusivity pattern for Make Public / Make Private.
    const isPublic = !!gaDecks[deckName]?.public;
    const makePublicBtn = document.getElementById('dga-ctx-make-public');
    const makePrivateBtn = document.getElementById('dga-ctx-make-private');
    if (makePublicBtn) makePublicBtn.style.display = isPublic ? 'none' : '';
    if (makePrivateBtn) makePrivateBtn.style.display = isPublic ? '' : 'none';

    menu.classList.remove('hidden');
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 130);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
}

async function dgaCtxClearBanner() {
    if (!dgaCtxTargetDeck) return;
    const name = dgaCtxTargetDeck;
    dgaCloseContextMenu();
    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(name)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({banner: null})
        });
        if (!res.ok) return;
        if (gaDecks[name]) gaDecks[name].banner = null;
        renderDeckGrid();
    } catch {
        console.error('Failed to clear banner');
    }
}

async function dgaCtxSetPublic(value) {
    if (!dgaCtxTargetDeck) return;
    const name = dgaCtxTargetDeck;
    dgaCloseContextMenu();
    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(name)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({public: value})
        });
        if (!res.ok) return;
        if (gaDecks[name]) gaDecks[name].public = value;
        renderDeckGrid();
    } catch {
        console.error('Failed to update deck visibility');
    }
}

function dgaCloseContextMenu() {
    document.getElementById('dga-context-menu').classList.add('hidden');
    dgaCtxTargetDeck = null;
}

function dgaCtxOpenBannerSearch() {
    const name = dgaCtxTargetDeck;
    dgaCloseContextMenu();
    if (!name) return;
    openDeckBannerModal(name);
}

document.addEventListener('click', e => {
    if (!e.target.closest('#dga-context-menu')) dgaCloseContextMenu();
    if (!e.target.closest('#dga-card-context-menu')) dgaCloseCardContextMenu();
});
document.addEventListener('contextmenu', e => {
    if (!e.target.closest('.dga-deck-tile')) dgaCloseContextMenu();
    if (!e.target.closest('.dga-card-tile')) dgaCloseCardContextMenu();
});

// ── Deck card context menu (right-click a card inside a deck) ──

let dgaCtxTargetEdition = null;
// The specific row a right-click landed on — only meaningful (non-null
// editionId/foilId) when the deck is Edition Locked; used by "Change Edition".
let dgaCtxCardTarget = null; // {cardId, cardName, section, editionId, foilId}

function dgaOpenCardContextMenu(e, editionId, cardId, cardName, rowEditionId, rowFoilId, sectionName) {
    dgaCtxTargetEdition = editionId;
    dgaCtxCardTarget = {cardId, cardName, section: sectionName, editionId: rowEditionId, foilId: rowFoilId};
    const isCurrent = gaDecks[activeDeck]?.banner === editionId;
    document.getElementById('dga-ctx-banner-label').textContent =
        isCurrent ? 'Remove Banner' : 'Set as Banner';
    // Swapping a printing only makes sense for a specific, known row —
    // unlocked tiles are a collapsed group with no single row to target.
    document.getElementById('dga-ctx-change-edition').classList.toggle('hidden', !activeDeckData?.edition_locked);
    const menu = document.getElementById('dga-card-context-menu');
    menu.classList.remove('hidden');
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 100);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
}

function dgaCloseCardContextMenu() {
    document.getElementById('dga-card-context-menu')?.classList.add('hidden');
    dgaCtxTargetEdition = null;
    dgaCtxCardTarget = null;
}

async function dgaCtxSetBanner() {
    if (!dgaCtxTargetEdition || !activeDeck) return;
    const editionId = dgaCtxTargetEdition;
    dgaCloseCardContextMenu();

    // Right-clicking the current banner card removes the banner
    const banner = gaDecks[activeDeck]?.banner === editionId ? null : editionId;

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({banner})
        });
        if (!res.ok) return;
        if (gaDecks[activeDeck]) gaDecks[activeDeck].banner = banner;
    } catch {
        console.error('Failed to update banner');
    }
}

// ── Change Edition (context-menu action on a card, Edition Locked only) ──
// Swaps an existing row's printing in place instead of the owner having to
// delete it and re-add the desired one — reuses the same foils-list picker
// as the Add Card confirm step, minus the search/qty/section fields since
// it's editing one specific already-placed row.
let dgaSwapTarget = null; // {cardId, cardName, section, fromEditionId, fromFoilId}
let dgaSwapModalEditionId = null;
let dgaSwapModalFoilId = null;
let dgaSwapModalCardData = null;

function dgaCtxChangeEdition() {
    const target = dgaCtxCardTarget;
    dgaCloseCardContextMenu();
    if (!target || !activeDeck) return;
    dgaSwapTarget = {
        cardId: target.cardId, cardName: target.cardName, section: target.section,
        fromEditionId: target.editionId, fromFoilId: target.foilId,
    };
    dgaSwapModalEditionId = null;
    dgaSwapModalFoilId = null;
    dgaSwapModalCardData = null;

    document.getElementById('dga-swap-modal-name').textContent = target.cardName || '';
    document.getElementById('dga-swap-modal-set').textContent = '';
    document.getElementById('dga-swap-modal-img').src = target.editionId ? `/images/${target.editionId}.jpg` : '';
    document.getElementById('dga-swap-modal-submit').disabled = true;
    document.getElementById('dga-edition-swap-modal').classList.remove('hidden');

    dgaLoadSwapFoilOptions(target.cardId);
}

function closeDgaEditionSwapModal() {
    document.getElementById('dga-edition-swap-modal').classList.add('hidden');
    dgaSwapTarget = null;
}

async function dgaLoadSwapFoilOptions(cardId) {
    const foilList = document.getElementById('dga-swap-modal-foils');
    foilList.innerHTML = '<div style="font-size:0.78rem;color:var(--text-muted);">Loading...</div>';
    document.getElementById('dga-swap-modal-submit').disabled = true;

    try {
        const res = await fetch(`/api/cards/${cardId}`);
        const data = await res.json();
        dgaSwapModalCardData = data.card;

        const editions = Object.entries(dgaSwapModalCardData.editions || {}).sort((a, b) => {
            const parseNum = s => {
                const m = (s || 'ZZZ').match(/^(\d+)([A-Z]*)$/i);
                return m ? [parseInt(m[1]), m[2] || ''] : [Infinity, s];
            };
            const [nA, sA] = parseNum(a[1].collector_number);
            const [nB, sB] = parseNum(b[1].collector_number);
            return nA !== nB ? nA - nB : sA.localeCompare(sB);
        });

        foilList.innerHTML = '';
        let currentOpt = null;
        let firstOpt = null;

        editions.forEach(([eid, einfo]) => {
            const rarity = rarityMapInv[einfo.rarity] || '?';
            Object.entries(einfo.foils || {}).forEach(([fid, finfo]) => {
                const variants = finfo.variants || {};

                // Same "skip a parent no separate product was ever made for"
                // rule as the Add Card foil step (dgaLoadFoilOptions).
                const variantPopulation = Object.values(variants).reduce((sum, v) => sum + (v.population || 0), 0);
                const remainingPopulation = finfo.population == null ? null : finfo.population - variantPopulation;

                if (remainingPopulation === null || remainingPopulation > 0) {
                    const opt = dgaBuildSwapFoilOption(eid, fid, finfo.kind, einfo.set_prefix, rarity, einfo.collector_number, false, finfo.population == null);
                    if (!firstOpt) firstOpt = {opt, eid, fid};
                    if (eid === dgaSwapTarget?.fromEditionId && fid === dgaSwapTarget?.fromFoilId) currentOpt = {opt, eid, fid};
                    foilList.appendChild(opt);
                }

                Object.entries(variants).forEach(([vid, vinfo]) => {
                    const vopt = dgaBuildSwapFoilOption(eid, vid, vinfo.kind, einfo.set_prefix, rarity, einfo.collector_number, true);
                    if (!firstOpt) firstOpt = {opt: vopt, eid, fid: vid};
                    if (eid === dgaSwapTarget?.fromEditionId && vid === dgaSwapTarget?.fromFoilId) currentOpt = {opt: vopt, eid, fid: vid};
                    foilList.appendChild(vopt);
                });
            });
        });

        // Pre-select the card's current printing so the modal doesn't open
        // looking like nothing is chosen — the owner can then pick another.
        const toSelect = currentOpt || firstOpt;
        if (toSelect) dgaSelectSwapFoilOption(toSelect.opt, toSelect.eid, toSelect.fid);
    } catch {
        foilList.innerHTML = '<div style="font-size:0.78rem;color:var(--error);">Failed to load editions.</div>';
    }
}

function dgaBuildSwapFoilOption(editionId, foilId, kind, setPrefix, rarity, collectorNum, isVariant, isTemp = false) {
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
    opt.onclick = () => dgaSelectSwapFoilOption(opt, editionId, foilId);
    return opt;
}

function dgaSelectSwapFoilOption(opt, editionId, foilId) {
    document.querySelectorAll('#dga-swap-modal-foils .inv-foil-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    dgaSwapModalEditionId = editionId;
    dgaSwapModalFoilId = foilId;

    const einfo = dgaSwapModalCardData?.editions?.[editionId];
    if (einfo) {
        document.getElementById('dga-swap-modal-img').src = `/images/${editionId}.jpg`;
        document.getElementById('dga-swap-modal-set').textContent = `${einfo.set_name || ''} (${einfo.set_prefix || ''}) — #${einfo.collector_number || '?'}`;
    }
    document.getElementById('dga-swap-modal-submit').disabled = false;
}

async function submitDgaEditionSwap() {
    if (!dgaSwapTarget || !activeDeck || !dgaSwapModalEditionId) return;
    const btn = document.getElementById('dga-swap-modal-submit');
    btn.disabled = true;
    btn.textContent = 'Changing...';

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card/edition`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                card_id: dgaSwapTarget.cardId, section: dgaSwapTarget.section,
                from_edition_id: dgaSwapTarget.fromEditionId, from_foil_id: dgaSwapTarget.fromFoilId,
                to_edition_id: dgaSwapModalEditionId, to_foil_id: dgaSwapModalFoilId,
            })
        });

        if (res.ok) {
            btn.disabled = false;
            btn.textContent = 'Change Edition';
            closeDgaEditionSwapModal();
            await dgaReloadActiveDeck();
        } else {
            btn.textContent = 'Error';
            setTimeout(() => { btn.textContent = 'Change Edition'; btn.disabled = false; }, 1500);
        }
    } catch {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Change Edition'; btn.disabled = false; }, 1500);
    }
}

function dgaCtxRename() {
    const name = dgaCtxTargetDeck;
    dgaCloseContextMenu();
    if (!name) return;
    const input = document.getElementById('dga-rename-input');
    input.value = name;
    input.dataset.original = name;
    document.getElementById('dga-rename-error').classList.add('hidden');
    document.getElementById('dga-rename-modal').classList.remove('hidden');
    setTimeout(() => {
        input.focus();
        input.select();
    }, 50);
}

function dgaCloseRenameModal() {
    document.getElementById('dga-rename-modal').classList.add('hidden');
}

async function dgaSubmitRename() {
    const input = document.getElementById('dga-rename-input');
    const newName = input.value.trim();
    const oldName = input.dataset.original;
    const errEl = document.getElementById('dga-rename-error');

    if (!newName) return;
    if (newName === oldName) {
        dgaCloseRenameModal();
        return;
    }
    if (gaDecks[newName]) {
        errEl.textContent = 'A deck with that name already exists.';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(oldName)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                name: newName,
                format: gaDecks[oldName]?.format || '',
                desc: gaDecks[oldName]?.desc || ''
            })
        });
        if (!res.ok) {
            errEl.textContent = 'Failed to rename.';
            errEl.classList.remove('hidden');
            return;
        }
        const existing = gaDecks[oldName];
        delete gaDecks[oldName];
        gaDecks[newName] = {...existing};
        dgaCloseRenameModal();
        renderDeckGrid();
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

function dgaCtxEditDesc() {
    const name = dgaCtxTargetDeck;
    dgaCloseContextMenu();
    if (!name) return;
    const input = document.getElementById('dga-desc-input');
    input.value = gaDecks[name]?.desc || '';
    input.dataset.deck = name;
    document.getElementById('dga-desc-error').classList.add('hidden');
    document.getElementById('dga-desc-modal').classList.remove('hidden');
    setTimeout(() => {
        input.focus();
    }, 50);
}

function dgaCloseDescModal() {
    document.getElementById('dga-desc-modal').classList.add('hidden');
}

async function dgaSubmitDesc() {
    const input = document.getElementById('dga-desc-input');
    const desc = input.value.trim();
    const name = input.dataset.deck;
    const errEl = document.getElementById('dga-desc-error');

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(name)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name, format: gaDecks[name]?.format || '', desc})
        });
        if (!res.ok) {
            errEl.textContent = 'Failed to save.';
            errEl.classList.remove('hidden');
            return;
        }
        if (gaDecks[name]) gaDecks[name].desc = desc;
        dgaCloseDescModal();
        renderDeckGrid();
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

async function dgaCtxDelete() {
    const name = dgaCtxTargetDeck;
    dgaCloseContextMenu();
    if (!name) return;
    if (!await appConfirm(`Delete deck "${name}"? Cards inside will be removed.`, {title: 'Delete Deck'})) return;

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(name)}`, {method: 'DELETE'});
        if (!res.ok) return;
        delete gaDecks[name];
        renderDeckGrid();
    } catch {
        console.error('Failed to delete deck');
    }
}


function toggleDgaFormatDropdown(scope) {
    const menu = document.getElementById(`dga-${scope}-format-menu`);
    const btn = document.getElementById(`dga-${scope}-format-btn`);
    const isOpen = !menu.classList.contains('hidden');
    document.querySelectorAll('.dga-fmt-dropdown-menu').forEach(m => m.classList.add('hidden'));
    document.querySelectorAll('.dga-fmt-dropdown-btn').forEach(b => b.classList.remove('open'));
    if (!isOpen) {
        menu.classList.remove('hidden');
        btn.classList.add('open');
    }
}

function closeDgaFormatDropdown(scope) {
    document.getElementById(`dga-${scope}-format-menu`)?.classList.add('hidden');
    document.getElementById(`dga-${scope}-format-btn`)?.classList.remove('open');
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

// Capture phase: option clicks inside modals never bubble to document
// (.inv-modal stops propagation), so select must happen on the way down.
document.addEventListener('click', e => {
    const opt = e.target.closest('.dga-fmt-dropdown-option');
    if (!opt) return;
    const menu = opt.closest('.dga-fmt-dropdown-menu');
    if (!menu) return;
    const scope = menu.id.includes('create') ? 'create' : 'settings';
    selectDgaFormat(scope, opt.dataset.value, opt.textContent);
}, true);

// ═══════════════════════════════════════
// LOAD & RENDER DECK LIST
// ═══════════════════════════════════════

// Deck priced-total badge — same treatment as Inventory's loadBinValue
// (inventory.js): "…" while loading, "$N.NN" once resolved, a dimmed-outline
// "partial" state when some cards have no price data, and a hover popup with
// the sale / listing / no-data split. `url` is the deck's /value endpoint
// (owner: /api/decks/{name}/value, public: /api/decks/public/{omni}/{name}/value).
// The response shape matches api_bin_value (see _deck_value in app.py), so
// inventory.js's showBinValuePopup / hideBinValuePopup are reused as-is.
async function loadDeckValue(badgeEl, url) {
    if (!badgeEl) return;
    badgeEl.textContent = '…';
    badgeEl.classList.add('inv-bin-value-loading');
    badgeEl.classList.remove('inv-bin-value-partial');
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error();
        const data = await res.json();

        badgeEl.textContent = `$${data.total.toFixed(2)}`;
        badgeEl.classList.remove('inv-bin-value-loading');
        if (data.priced_quantity < data.total_quantity) badgeEl.classList.add('inv-bin-value-partial');

        // Stash the breakdown and read it at hover time — the detail-header
        // badge is a persistent element re-run on every edit, so re-binding
        // listeners each call would stack duplicates (same note as loadBinValue).
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

function buildDeckTile(name, entry, index, total) {
    const tile = document.createElement('div');
    tile.className = 'dga-deck-tile';
    const delay = total <= 1 ? 0 : Math.min(index * 50, Math.round((index / (total - 1)) * 400));
    tile.style.animationDelay = `${delay}ms`;

    const fmt = entry.format ? `<span class="dga-tile-format">${entry.format}</span>` : '';
    const pub = entry.public ? `<span class="dga-tile-public" title="Listed on the public Decks page">Public</span>` : '';
    const count = entry.card_count || 0;

    // Format / Public badges sit in the icon row, to the right of the ⬡ glyph —
    // same placement as Inventory's "Default" bin badge (see buildBinTile).
    // Meta row mirrors .inv-bin-meta-row: card count left, priced-total badge
    // bottom-right (streams in via loadDeckValue) — only for Edition Locked
    // decks, where every row pins a real printing, so an unlocked deck's value
    // is neither shown nor computed.
    const valueBadge = entry.edition_locked
        ? '<span class="inv-bin-value-badge inv-bin-value-loading">…</span>'
        : '';
    tile.innerHTML = `
        <div class="dga-tile-icon-row">
            <span class="dga-tile-icon">⬡</span>
            ${fmt}${pub}
        </div>
        <div class="dga-tile-name">${name}</div>
        <div class="dga-tile-desc">${entry.desc || ''}</div>
        <div class="dga-tile-meta-row inv-bin-meta-row">
            <div class="dga-tile-meta">${count} card${count !== 1 ? 's' : ''}</div>
            ${valueBadge}
        </div>`;

    if (entry.edition_locked) {
        loadDeckValue(tile.querySelector('.inv-bin-value-badge'), `/api/decks/${encodeURIComponent(name)}/value`);
    }

    if (entry.banner) {
        tile.classList.add('has-banner');
        const bg = document.createElement('div');
        bg.className = 'dga-tile-banner';
        bg.style.backgroundImage = `url('/images/${encodeURIComponent(entry.banner)}.jpg')`;
        tile.prepend(bg);
    }

    tile.onclick = () => openDeckDetail(name);
    tile.addEventListener('contextmenu', e => {
        e.preventDefault();
        dgaOpenContextMenu(e, name);
    });
    return tile;
}

// ═══════════════════════════════════════
// DECK DETAIL
// ═══════════════════════════════════════

const DGA_DESC_PLACEHOLDER = 'Add a description...';

function dgaRenderDetailName(name) {
    const el = document.getElementById('dga-detail-name');
    if (el) el.textContent = name;
}

function dgaRenderDetailDesc(desc) {
    const el = document.getElementById('dga-detail-desc');
    if (!el) return;
    if (desc) {
        el.textContent = desc;
        el.classList.remove('dga-detail-meta-placeholder');
    } else {
        el.textContent = DGA_DESC_PLACEHOLDER;
        el.classList.add('dga-detail-meta-placeholder');
    }
}

function dgaWireDetailInlineEdit() {
    const nameEl = document.getElementById('dga-detail-name');
    const nameIcon = document.getElementById('dga-detail-name-edit-icon');
    const descEl = document.getElementById('dga-detail-desc');
    const descIcon = document.getElementById('dga-detail-desc-edit-icon');

    if (nameEl) {
        nameEl.onclick = () => dgaStartDetailInlineEdit('name');
        if (nameIcon) nameIcon.onclick = () => dgaStartDetailInlineEdit('name');
    }
    if (descEl) {
        descEl.onclick = () => dgaStartDetailInlineEdit('desc');
        if (descIcon) descIcon.onclick = () => dgaStartDetailInlineEdit('desc');
    }
}

function dgaStartDetailInlineEdit(field) {
    const isName = field === 'name';
    const labelEl = document.getElementById(isName ? 'dga-detail-name' : 'dga-detail-desc');
    if (!labelEl || labelEl.isContentEditable || !activeDeck) return;

    const entry = gaDecks[activeDeck] || {};
    const originalName = activeDeck;
    const originalDesc = entry.desc || '';

    // Use the raw value (not the placeholder) as the starting edit content
    if (isName) {
        labelEl.textContent = originalName;
    } else {
        labelEl.textContent = originalDesc;
        labelEl.classList.remove('dga-detail-meta-placeholder');
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

    // Description has a 100-char cap, matching every other desc input in the app (bins included)
    const DGA_DESC_MAXLENGTH = 100;

    function enforceDescLimit() {
        if (labelEl.textContent.length <= DGA_DESC_MAXLENGTH) return;
        labelEl.textContent = labelEl.textContent.slice(0, DGA_DESC_MAXLENGTH);
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
        if (!isName && newValue.length > DGA_DESC_MAXLENGTH) newValue = newValue.slice(0, DGA_DESC_MAXLENGTH);

        if (isName) {
            if (!newValue || newValue === originalName) {
                dgaRenderDetailName(originalName);
                return;
            }
            if (gaDecks[newValue]) {
                dgaRenderDetailName(originalName);
                return;
            }
        } else {
            if (newValue === originalDesc) {
                dgaRenderDetailDesc(originalDesc);
                return;
            }
        }

        const payload = {
            name: isName ? newValue : activeDeck,
            format: entry.format || '',
            desc: isName ? originalDesc : newValue
        };

        try {
            const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}`, {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                if (isName) dgaRenderDetailName(originalName);
                else dgaRenderDetailDesc(originalDesc);
                return;
            }

            if (isName) {
                const existing = gaDecks[originalName];
                delete gaDecks[originalName];
                gaDecks[newValue] = {...existing, format: entry.format || '', desc: originalDesc};
                activeDeck = newValue;
                dgaRenderDetailName(newValue);
                window.history.replaceState({}, '', `/decks_ga?deck=${encodeURIComponent(newValue)}`);
                dgaWireDetailInlineEdit();
            } else {
                if (gaDecks[activeDeck]) gaDecks[activeDeck].desc = newValue;
                dgaRenderDetailDesc(newValue);
            }
        } catch {
            if (isName) dgaRenderDetailName(originalName);
            else dgaRenderDetailDesc(originalDesc);
        }
    }

    labelEl.addEventListener('blur', commit, {once: true});
    labelEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && isName) {
            e.preventDefault();
            labelEl.blur();
        }
        if (e.key === 'Enter' && e.shiftKey === false && !isName) {
            // Allow single-line commit on Enter for description too, for consistency with section rename
            e.preventDefault();
            labelEl.blur();
        }
        if (e.key === 'Escape') {
            labelEl.removeEventListener('blur', commit);
            labelEl.contentEditable = 'false';
            labelEl.classList.remove('editing');
            if (isName) dgaRenderDetailName(originalName);
            else dgaRenderDetailDesc(originalDesc);
        }
    });
}

async function openDeckDetail(deckName, pushUrl = true) {
    activeDeck = deckName;
    activeDeckData = null;

    document.getElementById('dga-list-view').classList.add('hidden');
    document.getElementById('dga-detail-view').classList.remove('hidden');

    const entry = gaDecks[deckName] || {};
    document.getElementById('dga-detail-format').textContent = entry.format ? `[${entry.format}]` : '';
    dgaRenderDetailName(deckName);
    dgaRenderDetailDesc(entry.desc || '');
    dgaWireDetailInlineEdit();
    _setEditionLockedPillUI(!!entry.edition_locked);

    const grid = document.getElementById('dga-card-grid');
    if (grid) grid.innerHTML = '<p class="dga-loading">Loading...</p>';
    const countEl = document.getElementById('dga-detail-counts');
    if (countEl) countEl.textContent = '';
    const valEl = document.getElementById('dga-detail-value');
    if (valEl) {
        // Value badge is Edition-Locked-decks-only — hidden for an unlocked deck.
        valEl.classList.toggle('hidden', !entry.edition_locked);
        valEl.textContent = '…';
        valEl.classList.add('inv-bin-value-loading');
        valEl.classList.remove('inv-bin-value-partial');
    }

    if (pushUrl) window.history.pushState({}, '', `/decks_ga?deck=${encodeURIComponent(deckName)}`);

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(deckName)}`);
        if (!res.ok) throw new Error();
        activeDeckData = await res.json();
        _setEditionLockedPillUI(!!activeDeckData.edition_locked); // authoritative, once known
        renderDeckSections(activeDeckData);
    } catch {
        if (grid) grid.innerHTML = '<p class="dga-loading">Failed to load deck.</p>';
    }
}

// Edition Locked (pill toggle next to the "+" add-card button, dga-edition-locked-toggle
// in decks_ga.html) — decides whether adding a card asks which printing/foil to
// use (dgaGoToConfirm), and whether the deck view lists each printing
// separately (Locked) or collapses same-card rows into one random-printing
// tile (Unlocked, today's default) — see renderDeckSections.
function _setEditionLockedPillUI(value) {
    const toggle = document.getElementById('dga-edition-locked-toggle');
    toggle.querySelectorAll('.pill-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', (btn.dataset.value === 'true') === value);
    });
    positionPillIndicator(toggle);
}

async function setDgaEditionLocked(value) {
    _setEditionLockedPillUI(value);
    if (!activeDeck) return;
    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({edition_locked: value})
        });
        if (!res.ok) throw new Error();
        if (gaDecks[activeDeck]) gaDecks[activeDeck].edition_locked = value;
        // Toggling changes how *existing* cards are grouped/displayed, not
        // just how new ones get added — re-render right away.
        if (activeDeckData) {
            activeDeckData.edition_locked = value;
            if (value) {
                // Locking makes the server attach per-card price data
                // (card_prices) the prior payload didn't carry — refetch so
                // the price badges show on this render.
                dgaReloadActiveDeck();
            } else {
                activeDeckData.card_prices = {};
                renderDeckSections(activeDeckData);
            }
        }
    } catch {
        console.error('Failed to update edition-locked setting');
        _setEditionLockedPillUI(!value);
    }
}

function closeDeckDetail() {
    if (typeof dgaDeckEditMode !== 'undefined') dgaDeckEditMode.discard(true);
    // Clean up drawer state so inventory drawer works correctly afterward
    if (typeof drawerIsOpen !== 'undefined' && drawerIsOpen) {
        closeCardDrawer();
    }
    activeDeck = null;
    activeDeckData = null;
    document.getElementById('dga-detail-view').classList.add('hidden');
    document.getElementById('dga-list-view').classList.remove('hidden');
    window.history.pushState({}, '', '/decks_ga');
    renderDeckGrid();
}

// ═══════════════════════════════════════
// SECTION RENDERING
// ═══════════════════════════════════════

const rarityMapDga = {1: 'C', 2: 'U', 3: 'R', 4: 'SR', 5: 'UR', 6: 'PR', 7: 'CSR', 8: 'CUR', 9: 'CPR'};

// ── Card drag & drop state ──

let dgaDragCard = null; // {cardId, fromSection, tile}
let dgaDragGhost = null;
let dgaPlaceholder = null;
let dgaDragTileAspect = '5 / 7';
// A tile's rect at its settled layout position — FLIP slides via transform,
// so subtracting the in-flight transform gives where the tile will end up.
// Decisions made against settled rects are correct even mid-animation.
function dgaSettledRect(el) {
    const r = el.getBoundingClientRect();
    const t = getComputedStyle(el).transform;
    if (t && t !== 'none') {
        const m = new DOMMatrixReadOnly(t);
        return {left: r.left - m.m41, top: r.top - m.m42, width: r.width, height: r.height};
    }
    return r;
}

// FLIP the section-grid card tiles (+ the "add" tile and the drop placeholder)
// from where they sit before `mutate` reorders/inserts to where it leaves them —
// see flipSlide in animation.js.
function dgaFlipMove(mutate) {
    const els = [...document.querySelectorAll(
        '.dga-section-grid .dga-card-tile, ' +
        '.dga-section-grid .inv-card-add-tile, .dga-drop-placeholder')];
    flipSlide(els, mutate, {duration: 180});
}

// Pure geometric insertion: cursor position in, reference tile out.
// Row-aware scan over settled rects — same cursor position ALWAYS yields
// the same insertion point, regardless of animations, gutters, or history.
function dgaResolveInsertion(grid, x, y) {
    const tiles = [...grid.querySelectorAll('.dga-card-tile')]
        .filter(t => t !== dgaDragCard?.tile);
    for (const t of tiles) {
        const r = dgaSettledRect(t);
        if (y < r.top) return t;                       // above this row → before it
        if (y <= r.top + r.height) {                   // within this row
            if (x < r.left + r.width / 2) return t;    // left of center → before
        }
    }
    return null; // past every tile → append at end
}

// Open the gap before `refNode` (or at `grid` end, before the add tile).
// There is only ever one gap: moving it here closes it wherever it was.
function dgaMovePlaceholder(grid, refNode, e) {
    if (!dgaDragCard) return;
    if (!dgaPlaceholder) {
        dgaPlaceholder = document.createElement('div');
        dgaPlaceholder.className = 'dga-drop-placeholder';
        // Aspect ratio (not px height): the grid supplies the width, height
        // follows in proportion — exact tile dimensions, immune to page zoom
        dgaPlaceholder.style.aspectRatio = dgaDragTileAspect;
    }
    let target = refNode || grid.querySelector('.inv-card-add-tile');
    // Normalize past the hidden source tile so "before it" and "after it"
    // are the same DOM position as well as the same visual position
    if (target === dgaDragCard.tile) target = target.nextSibling;
    if (target === dgaPlaceholder) return; // hovering just left of the gap — same position
    let effectiveNext = dgaPlaceholder.nextSibling;
    if (effectiveNext === dgaDragCard.tile) effectiveNext = effectiveNext.nextSibling;
    if (dgaPlaceholder.parentNode === grid && effectiveNext === target) return; // already there
    dgaFlipMove(() => grid.insertBefore(dgaPlaceholder, target));
}

// Commit the move to wherever the gap currently sits
function dgaCommitFromPlaceholder() {
    const grid = dgaPlaceholder?.closest('.dga-section-grid');
    if (!grid) return; // no gap open — nothing to commit
    const toSection = grid.dataset.section;
    let index = 0;
    for (const el of grid.children) {
        if (el === dgaPlaceholder) break;
        // The dragged card is still visible in its slot — don't count it,
        // since the backend indexes the section as if it were removed
        if (el.classList.contains('dga-card-tile') && el !== dgaDragCard?.tile) index++;
    }
    dgaCommitCardMove(toSection, index);
}

function dgaCommitCardMove(toSection, index) {
    if (!dgaDragCard || !activeDeck) return;
    const {cardId, editionId, foilId, fromSection} = dgaDragCard;

    const sections = activeDeckData?.sections || {};
    const editionLocked = !!activeDeckData?.edition_locked;
    // Locked: this tile is one specific row. Unlocked: it's every row for
    // cardId collapsed together, so the whole group moves as one unit.
    const rowMatches = editionLocked
        ? (r => r.card_id === cardId && (r.edition_id || null) === (editionId || null) && (r.foil_id || null) === (foilId || null))
        : (r => r.card_id === cardId);

    // No-op guard: dropping back onto its own position. Indices are
    // post-removal (the dragged card is excluded from the count), so its
    // own position is exactly currentIndex — one step right is index + 1.
    if (fromSection === toSection) {
        const currentIndex = (sections[fromSection] || []).findIndex(rowMatches);
        if (currentIndex === index) return;
    }

    // Optimistic: apply the move locally and render the final order NOW —
    // synchronously, before dragend fires — so no restore animation or
    // old-order frame ever shows. The server call runs in the background.
    const fromCards = sections[fromSection] || [];
    if (editionLocked) {
        const rowIndex = fromCards.findIndex(rowMatches);
        if (rowIndex !== -1) {
            let [row] = fromCards.splice(rowIndex, 1);
            const toCards = sections[toSection] || (sections[toSection] = []);
            const existingIndex = toCards.findIndex(rowMatches);
            if (existingIndex !== -1) {
                const [existing] = toCards.splice(existingIndex, 1);
                row = {...row, quantity: row.quantity + existing.quantity};
            }
            toCards.splice(Math.max(0, Math.min(index, toCards.length)), 0, row);
        }
    } else {
        const movingRows = fromCards.filter(rowMatches);
        if (movingRows.length) {
            for (const row of movingRows) fromCards.splice(fromCards.indexOf(row), 1);
            const toCards = sections[toSection] || (sections[toSection] = []);
            toCards.splice(Math.max(0, Math.min(index, toCards.length)), 0, ...movingRows);
        }
    }
    renderDeckSections(activeDeckData, false);

    fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            card_id: cardId,
            edition_id: editionLocked ? (editionId || null) : null,
            foil_id: editionLocked ? (foilId || null) : null,
            from_section: fromSection, to_section: toSection, index,
        })
    }).then(res => {
        if (!res.ok) dgaReloadActiveDeck(); // server refused — restore truth
    }).catch(() => dgaReloadActiveDeck());
}

// Refetch the active deck and re-render (recovery after a failed move)
async function dgaReloadActiveDeck() {
    if (!activeDeck) return;
    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}`);
        if (!res.ok) return;
        activeDeckData = await res.json();
        renderDeckSections(activeDeckData, false);
    } catch {
        console.error('Failed to reload deck');
    }
}

const ALWAYS_FOIL_DGA = new Set([7, 8, 9]);

// Groups a section's rows by card_id, preserving first-seen order — used
// when the deck isn't Edition Locked, where several rows for the same card
// (e.g. one random printing per separate add) collapse into one tile.
function _dgaGroupCardsByCardId(cards) {
    const order = [];
    const byId = new Map();
    for (const row of cards) {
        if (!byId.has(row.card_id)) {
            byId.set(row.card_id, []);
            order.push(row.card_id);
        }
        byId.get(row.card_id).push(row);
    }
    return order.map(cardId => byId.get(cardId));
}

function renderDeckSections(deckData, animate = true) {
    const grid = document.getElementById('dga-card-grid');
    grid.classList.toggle('dga-no-anim', !animate);
    const sections = deckData.sections || {};
    const nameMap = deckData.name_map || {};
    const editionMap = deckData.edition_map || {};
    const editionsInfo = deckData.editions_info || {};
    const foilsInfo = deckData.foils_info || {};
    // {card_id: {edition_id: {foil_id: {price, lowest_listing}}}} — server sends
    // it only for Edition Locked decks (empty otherwise), matching api_bin_prices.
    const cardPrices = deckData.card_prices || {};
    const editionLocked = !!deckData.edition_locked;

    let totalUnique = 0, totalQty = 0;
    for (const cards of Object.values(sections)) {
        totalUnique += editionLocked ? cards.length : new Set(cards.map(r => r.card_id)).size;
        for (const row of cards) totalQty += row.quantity;
    }
    updateDeckCounts(totalUnique, totalQty);

    grid.innerHTML = '';

    if (Object.keys(sections).length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dga-sections-empty';
        empty.innerHTML = `<span class="inv-empty-icon">⬡</span><p>No sections yet.</p><p class="inv-empty-sub">Add a section to get started.</p>`;
        grid.appendChild(empty);
    } else {
        for (const [sectionName, cards] of Object.entries(sections)) {
            const block = document.createElement('div');
            block.className = 'dga-section-block';

            // Header
            const sectionQty = cards.reduce((s, row) => s + row.quantity, 0);
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
            label.onclick = () => dgaStartInlineRename(label, sectionName);
            pencil.onclick = () => dgaStartInlineRename(label, sectionName);
            header.querySelectorAll('.dga-section-action-btn')[0].onclick = () => submitDeleteSection(sectionName);
            block.appendChild(header);

            // Per-section grid — always rendered
            const sectionGrid = document.createElement('div');
            sectionGrid.className = 'dga-section-grid';
            sectionGrid.dataset.section = sectionName;

            // Dropping on empty grid space appends to the section's end
            sectionGrid.addEventListener('dragover', e => {
                if (!dgaDragCard) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const ref = dgaResolveInsertion(sectionGrid, e.clientX, e.clientY);
                dgaMovePlaceholder(sectionGrid, ref, e);
            });
            sectionGrid.addEventListener('drop', e => {
                if (!dgaDragCard) return;
                e.preventDefault();
                dgaCommitFromPlaceholder();
            });

            // Card tiles. Locked: one tile per row (a card_id may have
            // several, split across printings). Unlocked: one tile per
            // card_id, collapsing its rows together (summed quantity, a
            // random printing among them for the thumbnail, no foil badge).
            let tileCount;
            if (editionLocked) {
                tileCount = cards.length;
                cards.forEach((row, i) => {
                    const cardName = nameMap[row.card_id] || row.card_id;
                    const displayEditionId = row.edition_id || editionMap[row.card_id] || null;
                    sectionGrid.appendChild(buildDeckCardTile(
                        row.card_id, cardName, displayEditionId, row.quantity, sectionName, i, tileCount,
                        row.edition_id || null, row.foil_id || null, editionsInfo, foilsInfo, cardPrices,
                    ));
                });
            } else {
                const groups = _dgaGroupCardsByCardId(cards);
                tileCount = groups.length;
                groups.forEach((rows, i) => {
                    const cardId = rows[0].card_id;
                    const cardName = nameMap[cardId] || cardId;
                    const qty = rows.reduce((s, r) => s + r.quantity, 0);
                    // Unlocked means editions don't matter for display either —
                    // always a random printing from the card's full catalog
                    // (edition_map, server-side _pick_edition), regardless of
                    // which printing(s) got randomly assigned to the row(s)
                    // themselves when they were added.
                    const displayEditionId = editionMap[cardId] || null;
                    sectionGrid.appendChild(buildDeckCardTile(
                        cardId, cardName, displayEditionId, qty, sectionName, i, tileCount,
                        null, null, editionsInfo, foilsInfo, cardPrices,
                    ));
                });
            }

            // Add tile inside this section's grid
            const addTile = document.createElement('div');
            addTile.className = 'inv-card-add-tile';
            addTile.style.animationDelay = `${Math.min(tileCount * 40, 640)}ms`;
            addTile.innerHTML = `<span class="inv-create-plus">+</span><span class="inv-create-label">Add Card</span>`;
            addTile.onclick = () => openDeckAddModal(sectionName);
            sectionGrid.appendChild(addTile);

            block.appendChild(sectionGrid);
            grid.appendChild(block);
        }
    }

    // Add section button — always visible; swaps into an inline name input
    grid.appendChild(dgaBuildAddSectionButton());
}

function dgaBuildAddSectionButton() {
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
        const cancel = () => input.replaceWith(dgaBuildAddSectionButton());
        input.addEventListener('keydown', async e => {
            if (e.key === 'Escape') cancel();
            if (e.key !== 'Enter') return;
            const name = input.value.trim();
            if (!name) return cancel();
            if (activeDeckData?.sections?.[name] !== undefined) return cancel();
            try {
                const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/section`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({section: name})
                });
                if (!res.ok) return cancel();
                activeDeckData.sections[name] = [];
                renderDeckSections(activeDeckData, false);
            } catch {
                cancel();
            }
        });
        input.addEventListener('blur', cancel);
    };
    return btn;
}

// The detail header's priced-total badge is Edition-Locked-decks-only: an
// unlocked deck's value is never shown or fetched. Hides the badge for an
// unlocked deck, otherwise (re)loads it. Called on deck open, on every count
// change, and when the Edition Locked pill is toggled.
function dgaRefreshDetailValue() {
    const badge = document.getElementById('dga-detail-value');
    if (!badge) return;
    const locked = !!gaDecks[activeDeck]?.edition_locked;
    badge.classList.toggle('hidden', !locked);
    if (locked && activeDeck) {
        loadDeckValue(badge, `/api/decks/${encodeURIComponent(activeDeck)}/value`);
    }
}

function updateDeckCounts(unique, total) {
    const countEl = document.getElementById('dga-detail-counts');
    if (countEl) countEl.textContent = `${unique} card${unique !== 1 ? 's' : ''} · ${total} cop${total !== 1 ? 'ies' : 'y'}`;

    // Re-price on every count change (add / remove / qty edit / import) — same
    // refresh trigger as Inventory's updateInvCounts → loadBinValue.
    dgaRefreshDetailValue();
}

// ── Deck tile edit mode — uses TileEditMode from tiles.js ──
const dgaDeckEditMode = new TileEditMode('dga-qty-confirm-bar', async (changes) => {
    const editionLocked = !!activeDeckData?.edition_locked;
    for (const c of changes) {
        const section = c.input.dataset.section;
        if (!section) continue;
        const editionId = c.editionId || null;
        const foilId = c.foilId || null;

        try {
            if (c.quantity <= 0) {
                await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
                    method: 'DELETE',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({card_id: c.cardId, section, edition_id: editionId, foil_id: foilId})
                });
            } else {
                await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
                    method: 'PATCH',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({card_id: c.cardId, section, edition_id: editionId, foil_id: foilId, quantity: c.quantity})
                });
            }
            if (editionLocked) {
                // One row per tile — patch it in place directly.
                const cards = activeDeckData?.sections?.[section];
                const row = cards?.find(r => r.card_id === c.cardId
                    && (r.edition_id || null) === editionId && (r.foil_id || null) === foilId);
                if (c.quantity <= 0) {
                    if (row) cards.splice(cards.indexOf(row), 1);
                } else if (row) {
                    row.quantity = c.quantity;
                }
                const badge = c.input.closest('.dga-card-tile')?.querySelector('.inv-qty-badge');
                if (badge) {
                    badge.textContent = `x${c.quantity}`;
                    badge.style.display = c.quantity > 0 ? '' : 'none';
                }
            }
            // Not locked: the tile is a collapsed group possibly spanning
            // several real rows, and the server redistributes the new
            // total across them — reload once below rather than trying to
            // duplicate that redistribution logic here.
        } catch {
            console.error('Failed to update deck card quantity');
        }
    }

    if (!editionLocked) {
        await dgaReloadActiveDeck();
        if (activeDeck && gaDecks[activeDeck]) {
            gaDecks[activeDeck].card_count = Object.values(activeDeckData?.sections || {})
                .reduce((s, c) => s + c.reduce((a, r) => a + r.quantity, 0), 0);
        }
        return;
    }

    // Re-render to remove deleted tiles
    const anyDeleted = changes.some(c => c.quantity <= 0);
    const totalQty = Object.values(activeDeckData?.sections || {}).reduce((s, c) => s + c.reduce((a, r) => a + r.quantity, 0), 0);
    const totalUnique = Object.values(activeDeckData?.sections || {}).reduce((s, c) => s + c.length, 0);

    // Keep the list-view's in-memory card_count in sync so it's correct immediately on back/browser-back,
    // without requiring a full re-fetch of /api/decks
    if (activeDeck && gaDecks[activeDeck]) gaDecks[activeDeck].card_count = totalQty;

    if (anyDeleted) renderDeckSections(activeDeckData); // internally calls updateDeckCounts with the same totals
    else updateDeckCounts(totalUnique, totalQty);
});

// Override indicator helpers to find .dga-card-tile instead of .inv-card-tile
dgaDeckEditMode._getTile = input => input.closest('.dga-card-tile');
dgaDeckEditMode._updateIndicator = function (input) {
    const tile = this._getTile(input);
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
    if (currentValue === 0) ind.innerHTML = '<div class="inv-tile-qty-indicator-box indicator-del">🗑</div>';
    else if (delta > 0) ind.innerHTML = `<div class="inv-tile-qty-indicator-box indicator-add">+${delta}</div>`;
    else ind.innerHTML = `<div class="inv-tile-qty-indicator-box indicator-sub">${delta}</div>`;
};
dgaDeckEditMode._clearIndicator = function (tile) {
    tile.classList.remove('has-pending');
    const ind = tile.querySelector('.inv-tile-qty-indicator');
    if (ind) ind.innerHTML = '';
};
dgaDeckEditMode._clearAllIndicators = function () {
    document.querySelectorAll('.dga-card-tile.has-pending').forEach(t => this._clearIndicator(t));
};

// Foil/curio indicator for a tile that pins a specific printing — mirrors
// Inventory's getFoilSuffix (inventory.js) but drops the rarity letter,
// just the emoji: ⭐ for a plain foil, 💎 for anything else non-foil (a
// descriptive Curio Foil name etc.), nothing for Nonfoil. Rarities that are
// always-foil (CSR/CUR/CPR) skip the badge too — same rule as Inventory,
// since it'd be redundant there.
const DGA_ALWAYS_FOIL_RARITIES = new Set([7, 8, 9]);
function _dgaFoilBadgeEmoji(rarity, kind) {
    if (DGA_ALWAYS_FOIL_RARITIES.has(rarity)) return '';
    const k = (kind || '').toLowerCase();
    if (k === 'nonfoil' || k === '') return '';
    return k === 'foil' ? '⭐' : '💎';
}

function buildDeckCardTile(card_id, cardName, editionId, qty, sectionName, index, total,
                            rowEditionId = null, rowFoilId = null, editionsInfo = {}, foilsInfo = {}, cardPrices = {}) {
    const tile = document.createElement('div');
    tile.className = 'dga-card-tile inv-card-tile tile-hoverable';
    const delay = total <= 1 ? 0 : Math.min(index * 40, Math.round((index / (total - 1)) * 600));
    tile.style.animationDelay = `${delay}ms`;

    const imgSrc = editionId ? `/images/${editionId}.jpg` : '';
    const foilEmoji = rowEditionId
        ? _dgaFoilBadgeEmoji(editionsInfo[rowEditionId]?.rarity, foilsInfo[rowFoilId]?.kind)
        : '';

    // Sale / listing badges — top-right of the tile, same as Inventory bin
    // cards (priceBadgesHTML, tiles.js). cardPrices is populated only for
    // Edition Locked decks, and only a pinned printing (rowEditionId/rowFoilId)
    // resolves an entry, so an Unlocked deck or collapsed tile shows nothing.
    const priceEntry = rowEditionId ? cardPrices[card_id]?.[rowEditionId]?.[rowFoilId] : undefined;
    const priceBadges = priceEntry ? priceBadgesHTML(priceEntry.price, priceEntry.lowest_listing) : '';

    // An empty src (no resolved edition yet) never fires load or error at
    // all — so it can't rely on revealTileImage to ever clear the "loading"
    // opacity:0 state (see .inv-card-tile .edition-tile-wrap img in
    // inventory.css). No spinner in that case either, since there's nothing
    // actually in flight to show progress on.
    tile.innerHTML = `
        <div class="edition-tile-wrap tile-zoom">
            ${imgSrc ? `<div class="tile-img-spinner">${TILE_SPINNER_SVG}</div>` : ''}
            <img class="${imgSrc ? '' : 'tile-img-loaded'}" alt="${cardName}"
                onload="revealTileImage(this)"
                onerror="this.style.opacity='0.1'; revealTileImage(this)">
            <div class="card-tile-dim"></div>
        </div>
        ${priceBadges}
        <span class="inv-qty-badge">x${qty}</span>
        ${foilEmoji ? `<span class="dga-foil-badge">${foilEmoji}</span>` : ''}
        <div class="inv-card-tile-overlay">
            <div class="inv-card-tile-info">
                <div class="dga-card-tile-name">${cardName}</div>
                <div class="dga-card-tile-foil">${sectionName}</div>
            </div>
        </div>
        <div class="inv-card-tile-qty-ctrl">
            <button class="inv-tile-qty-btn btn btn--icon inv-tile-qty-add" type="button">+</button>
            <input class="inv-tile-qty-input" type="number" value="${qty}" min="0" max="999"
                data-card-id="${card_id}"
                data-section="${sectionName}"
                data-edition-id="${rowEditionId || ''}"
                data-foil-id="${rowFoilId || ''}">
            <button class="inv-tile-qty-btn btn btn--icon inv-tile-qty-sub" type="button">−</button>
        </div>
        <div class="inv-tile-qty-indicator"></div>`;

    // Queued (tiles.js) — see the matching comment in buildCardTile (cards.js).
    if (imgSrc) queueTileImageLoad(tile.querySelector('.edition-tile-wrap img'), imgSrc);

    const input = tile.querySelector('.inv-tile-qty-input');
    const badge = tile.querySelector('.inv-qty-badge');

    tile.addEventListener('contextmenu', e => {
        e.preventDefault();
        dgaOpenCardContextMenu(e, editionId, card_id, cardName, rowEditionId, rowFoilId, sectionName);
    });

    // ── Drag & drop: reorder within / move across sections ──
    tile.draggable = true;
    tile.dataset.cardId = card_id;
    tile.dataset.section = sectionName;
    tile.dataset.editionId = rowEditionId || '';
    tile.dataset.foilId = rowFoilId || '';

    // Qty controls need normal mouse interaction — suspend dragging over them
    // The qty ctrl overlay spans the whole tile face, so only suspend
    // dragging when the press is on an actual button/input inside it
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
        dgaDragCard = {cardId: card_id, editionId: rowEditionId, foilId: rowFoilId, fromSection: sectionName, tile};
        tile.classList.add('dga-dragging');
        document.body.classList.add('dga-drag-active');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card_id); // Firefox requires data

        // Clean drag ghost: the card itself, minus overlay and qty controls
        const rect = tile.getBoundingClientRect();
        const ghost = tile.cloneNode(true);
        ghost.querySelector('.inv-card-tile-overlay')?.remove();
        ghost.querySelector('.inv-card-tile-qty-ctrl')?.remove();
        ghost.classList.remove('dga-dragging');
        ghost.style.cssText = `position: fixed; top: -9999px; left: -9999px;` +
            `width: ${rect.width}px; height: ${rect.height}px;` +
            `margin: 0; animation: none; opacity: 1; pointer-events: none;`;
        document.body.appendChild(ghost);
        // Anchor the drag image at its center so the cursor — which drives
        // all gap decisions — always sits at the card's visual center
        e.dataTransfer.setDragImage(ghost, rect.width / 2, rect.height / 2);
        dgaDragGhost = ghost;
        dgaDragTileAspect = `${rect.width} / ${rect.height}`;

        // The source slot becomes the gap, in place: the placeholder has the
        // card's exact footprint, so nothing shifts and no close animation
        // plays at pickup. The gap only departs when the cursor moves it.
        // (Deferred: hiding the source synchronously cancels the drag.)
        setTimeout(() => {
            if (dgaDragCard?.tile !== tile) return;
            dgaPlaceholder = document.createElement('div');
            dgaPlaceholder.className = 'dga-drop-placeholder';
            dgaPlaceholder.style.aspectRatio = dgaDragTileAspect;
            tile.parentNode.insertBefore(dgaPlaceholder, tile);
            tile.classList.add('dga-drag-collapsed');
        }, 0);
    });

    tile.addEventListener('dragend', () => {
        // Close the gap and restore the source slot (successful drops
        // re-render right after; cancelled drags animate the card back)
        dgaFlipMove(() => {
            dgaPlaceholder?.remove();
            tile.classList.remove('dga-drag-collapsed');
        });
        dgaPlaceholder = null;
        tile.classList.remove('dga-dragging');
        document.body.classList.remove('dga-drag-active');
        dgaDragGhost?.remove();
        dgaDragGhost = null;
        dgaDragCard = null;
    });


    // Commit immediately — used by +/− buttons and direct text input
    async function commitNow(newQty) {
        badge.textContent = `x${newQty}`;
        badge.style.display = newQty > 0 ? '' : 'none';
        const editionLocked = !!activeDeckData?.edition_locked;
        const findRow = cards => cards?.find(r => r.card_id === card_id
            && (r.edition_id || null) === rowEditionId && (r.foil_id || null) === rowFoilId);
        try {
            if (newQty <= 0) {
                await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
                    method: 'DELETE',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({card_id, section: sectionName, edition_id: rowEditionId, foil_id: rowFoilId})
                });
                if (editionLocked) {
                    const cards = activeDeckData?.sections?.[sectionName];
                    const row = findRow(cards);
                    if (row) cards.splice(cards.indexOf(row), 1);
                }
            } else {
                await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
                    method: 'PATCH',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({card_id, section: sectionName, edition_id: rowEditionId, foil_id: rowFoilId, quantity: newQty})
                });
                if (editionLocked) {
                    const row = findRow(activeDeckData?.sections?.[sectionName]);
                    if (row) row.quantity = newQty;
                }
            }
            if (!editionLocked) {
                // Collapsed tile — the server may have redistributed quantity
                // across several real rows; reload rather than guess at that.
                await dgaReloadActiveDeck();
            } else {
                if (newQty <= 0) renderDeckSections(activeDeckData);
                else updateDeckCounts(
                    Object.values(activeDeckData?.sections || {}).reduce((s, c) => s + c.length, 0),
                    Object.values(activeDeckData?.sections || {}).reduce((s, c) => s + c.reduce((a, r) => a + r.quantity, 0), 0)
                );
            }
            // Keep list-view's in-memory card_count in sync
            if (activeDeck && gaDecks[activeDeck]) {
                gaDecks[activeDeck].card_count = Object.values(activeDeckData?.sections || {})
                    .reduce((s, c) => s + c.reduce((a, r) => a + r.quantity, 0), 0);
            }
        } catch {
            console.error('Failed to update deck card');
        }
    }

    // +/− buttons: commit immediately (or absorb into edit session if already staging)
    tile.querySelector('.inv-tile-qty-add').addEventListener('click', e => {
        e.stopPropagation();
        const before = parseInt(input.value) || 0;
        const newVal = Math.max(0, before + 1);
        input.value = newVal;
        if (dgaDeckEditMode.isActive()) {
            dgaDeckEditMode.stage(input, before);
        } else {
            commitNow(newVal);
        }
    });
    tile.querySelector('.inv-tile-qty-sub').addEventListener('click', e => {
        e.stopPropagation();
        const before = parseInt(input.value) || 0;
        const newVal = Math.max(0, before - 1);
        input.value = newVal;
        if (dgaDeckEditMode.isActive()) {
            dgaDeckEditMode.stage(input, before);
        } else {
            commitNow(newVal);
        }
    });

    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('focus', () => input.select());
    // Direct text input: commit immediately (or absorb into edit session if staging)
    input.addEventListener('change', () => {
        const val = Math.max(0, parseInt(input.value) || 0);
        input.value = val;
        if (dgaDeckEditMode.isActive()) {
            const orig = dgaDeckEditMode.pending.has(input) ? dgaDeckEditMode.pending.get(input) : val;
            dgaDeckEditMode.stage(input, orig);
        } else {
            commitNow(val);
        }
    });

    tile.addEventListener('animationend', () => tile.classList.add('animated'));
    tile.addEventListener('click', () => {
        if (editionId && document.getElementById('card-drawer')) {
            openCardDrawer(card_id, editionId, cardName);
        }
    });
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
    // After the modal is unhidden so the pill track has real layout for
    // positionPillIndicator to measure — offsetWidth is 0 while display:none.
    setDgaPublicValue(!!entry.public);
}

function setDgaPublicValue(value) {
    document.getElementById('dga-settings-public').value = value;
    const toggle = document.getElementById('dga-settings-public-toggle');
    toggle.querySelectorAll('.pill-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', (btn.dataset.value === 'true') === value);
    });
    positionPillIndicator(toggle);
}

function closeDeckSettingsModal() {
    const overlay = document.getElementById('dga-settings-modal');
    overlay.classList.add('hidden');
    // Undo the entrance-animation suppression a back-from-import/export morph may have left
    // on the settings box, so it gets its normal reveal animation again next time it opens.
    overlay.querySelector('.inv-modal:not(.inv-modal-import-export)')?.classList.remove('morph-resizing');
    closeDgaFormatDropdown('settings');
}

function renderSectionList() {
    const container = document.getElementById('dga-settings-sections');
    if (!container || !activeDeckData) return;
    const sections = Object.keys(activeDeckData.sections || {});
    container.innerHTML = '';
    sections.forEach(name => {
        const row = document.createElement('div');
        row.className = 'dga-section-row';
        row.innerHTML = `
            <span class="dga-section-row-name">${name}</span>
            <button class="dga-section-delete-btn btn btn--subtle" onclick="submitDeleteSection('${name.replace(/'/g, "\\'")}')">✕</button>`;
        container.appendChild(row);
    });
}

function dgaStartInlineRename(labelEl, sectionName) {
    if (labelEl.isContentEditable) return;

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

    async function commit() {
        labelEl.contentEditable = 'false';
        labelEl.classList.remove('editing');
        const newName = labelEl.textContent.trim();

        if (!newName || newName === sectionName) {
            labelEl.textContent = sectionName;
            return;
        }
        if (activeDeckData?.sections?.[newName] !== undefined) {
            labelEl.textContent = sectionName;
            return;
        }

        try {
            const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/section/${encodeURIComponent(sectionName)}/rename`, {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name: newName})
            });
            if (res.ok) {
                const newSections = {};
                for (const [k, v] of Object.entries(activeDeckData.sections))
                    newSections[k === sectionName ? newName : k] = v;
                activeDeckData.sections = newSections;
                renderDeckSections(activeDeckData);
            } else {
                labelEl.textContent = sectionName;
            }
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

function openRenameSectionModal(sectionName) {
    document.getElementById('dga-rename-section-modal').classList.remove('hidden');
    const input = document.getElementById('dga-rename-section-input');
    input.value = sectionName;
    input.dataset.original = sectionName;
    document.getElementById('dga-rename-section-error').classList.add('hidden');
    input.focus();
    input.select();
}

function closeRenameSectionModal() {
    document.getElementById('dga-rename-section-modal').classList.add('hidden');
}

async function submitRenameSectionModal() {
    const input = document.getElementById('dga-rename-section-input');
    const newName = input.value.trim();
    const oldName = input.dataset.original;
    const errEl = document.getElementById('dga-rename-section-error');

    if (!newName) return;
    if (newName === oldName) {
        closeRenameSectionModal();
        return;
    }
    if (!activeDeck) return;

    if (activeDeckData?.sections?.[newName] !== undefined) {
        errEl.textContent = 'A section with that name already exists.';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/section/${encodeURIComponent(oldName)}/rename`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: newName})
        });
        if (!res.ok) {
            errEl.textContent = 'Failed to rename section.';
            errEl.classList.remove('hidden');
            return;
        }
        // Update local state — preserve card order
        const cards = activeDeckData.sections[oldName];
        const newSections = {};
        for (const [k, v] of Object.entries(activeDeckData.sections)) {
            newSections[k === oldName ? newName : k] = v;
        }
        activeDeckData.sections = newSections;
        closeRenameSectionModal();
        renderDeckSections(activeDeckData);
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

function openAddSectionModal() {
    document.getElementById('dga-add-section-modal').classList.remove('hidden');
    const input = document.getElementById('dga-add-section-input');
    input.value = '';
    document.getElementById('dga-add-section-error').classList.add('hidden');
    input.focus();
}

function closeAddSectionModal() {
    document.getElementById('dga-add-section-modal').classList.add('hidden');
}

async function submitAddSectionModal() {
    const input = document.getElementById('dga-add-section-input');
    const name = input.value.trim();
    const errEl = document.getElementById('dga-add-section-error');

    if (!name) return;
    if (!activeDeck) return;

    if (activeDeckData?.sections?.[name] !== undefined) {
        errEl.textContent = 'Section already exists.';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/section`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({section: name})
        });
        if (!res.ok) {
            errEl.textContent = 'Failed to add section.';
            errEl.classList.remove('hidden');
            return;
        }
        if (!activeDeckData.sections[name]) activeDeckData.sections[name] = [];
        closeAddSectionModal();
        renderDeckSections(activeDeckData);
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

async function submitAddSection() {
    const input = document.getElementById('dga-section-new-name');
    const name = input.value.trim();
    if (!name || !activeDeck) return;

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/section`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({section: name})
        });
        if (!res.ok) return;
        if (!activeDeckData.sections[name]) activeDeckData.sections[name] = [];
        input.value = '';
        renderSectionList();
        renderDeckSections(activeDeckData);
    } catch {
        console.error('Failed to add section');
    }
}

async function submitDeleteSection(sectionName) {
    if (!activeDeck) return;
    if (!await appConfirm(`Delete section "${sectionName}" and all its cards?`, {title: 'Delete Section'})) return;

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/section/${encodeURIComponent(sectionName)}`, {method: 'DELETE'});
        if (!res.ok) return;
        delete activeDeckData.sections[sectionName];
        renderSectionList();
        renderDeckSections(activeDeckData);
        if (activeDeck && gaDecks[activeDeck]) {
            gaDecks[activeDeck].card_count = Object.values(activeDeckData?.sections || {})
                .reduce((s, c) => s + c.reduce((a, r) => a + r.quantity, 0), 0);
        }
    } catch {
        console.error('Failed to delete section');
    }
}

async function submitDeckSettings() {
    const newName = document.getElementById('dga-settings-name').value.trim();
    const format = document.getElementById('dga-settings-format').value.trim();
    const desc = document.getElementById('dga-settings-desc').value.trim();
    const isPublic = document.getElementById('dga-settings-public').value === 'true';
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
            body: JSON.stringify({name: newName, format, desc, public: isPublic})
        });
        if (!res.ok) {
            errEl.textContent = 'Failed to update deck.';
            errEl.classList.remove('hidden');
            return;
        }

        const existing = gaDecks[activeDeck];
        delete gaDecks[activeDeck];
        gaDecks[newName] = {...existing, format, desc, public: isPublic};
        const oldName = activeDeck;
        activeDeck = newName;

        document.getElementById('dga-detail-format').textContent = format ? `[${format}]` : '';
        dgaRenderDetailName(newName);
        dgaRenderDetailDesc(desc);
        dgaWireDetailInlineEdit();

        if (oldName !== newName)
            window.history.replaceState({}, '', `/decks_ga?deck=${encodeURIComponent(newName)}`);

        closeDeckSettingsModal();
    } catch {
        errEl.textContent = 'Request failed.';
        errEl.classList.remove('hidden');
    }
}

async function submitDeleteDeck() {
    if (!activeDeck) return;
    if (!await appConfirm(`Delete deck "${activeDeck}"? Cards inside will be removed.`, {title: 'Delete Deck'})) return;

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}`, {method: 'DELETE'});
        if (!res.ok) throw new Error();
        delete gaDecks[activeDeck];
        closeDeckSettingsModal();
        closeDeckDetail();
    } catch {
        document.getElementById('dga-settings-error').textContent = 'Failed to delete deck.';
        document.getElementById('dga-settings-error').classList.remove('hidden');
    }
}

// ═══════════════════════════════════════
// IMPORT / EXPORT MODAL
// ═══════════════════════════════════════

let dgaImportExportTab = 'import';

function dgaTransitionSettingsToImportExport() {
    if (!activeDeck) return;

    const ieBoxAlready = document.querySelector('.inv-modal-import-export');
    const overlay = document.getElementById('dga-settings-modal');

    // Guard against a double-click (or any re-entrant call) firing this a second time:
    // once the box has been borrowed into the settings overlay, it becomes a *second*
    // '.inv-modal' sibling there, so a naive re-lookup below would grab the original
    // (now hidden, zero-size) settings box as the animation's "from" size and scale the
    // real box down to nothing — that was the delayed flash a double-click produced.
    if (ieBoxAlready.parentElement === overlay) return;

    // The settings overlay is already open (its backdrop is fully composited), so the
    // resize morph reparents the import/export box into it instead of revealing a second
    // overlay — swapping overlays mid-transition is what caused the post-animation flash,
    // since a freshly-shown backdrop-filter element needs an extra frame to composite.
    const settingsBox = overlay.querySelector('.inv-modal:not(.inv-modal-import-export)');
    const fromRect = settingsBox.getBoundingClientRect();

    closeDgaFormatDropdown('settings');

    document.getElementById('dga-import-export-deck-label').textContent = activeDeck;
    document.getElementById('dga-import-textarea').value = '';
    document.getElementById('dga-export-textarea').value = '';
    document.getElementById('dga-import-results').classList.add('hidden');
    document.getElementById('dga-import-results').innerHTML = '';
    document.getElementById('dga-import-submit-btn').textContent = 'Import';
    document.getElementById('dga-import-submit-btn').disabled = false;
    dgaSwitchImportExportTab('import');

    const ieBox = ieBoxAlready;
    settingsBox.classList.add('hidden');
    overlay.appendChild(ieBox);
    overlay.onclick = dgaCloseImportExportModal;
    morphBoxIn(ieBox, fromRect);

    dgaLoadExport();
}

function dgaTransitionImportExportToSettings() {
    const overlay = document.getElementById('dga-settings-modal');
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
    const homeOverlay = document.getElementById('dga-import-export-modal');
    homeOverlay.appendChild(ieBox);
    homeOverlay.classList.add('hidden');
    overlay.onclick = closeDeckSettingsModal;
    settingsBox.classList.remove('hidden');
    morphBoxIn(settingsBox, fromRect);
}

function dgaOpenImportExportModal() {
    if (!activeDeck) return;
    document.getElementById('dga-import-export-deck-label').textContent = activeDeck;
    document.getElementById('dga-import-textarea').value = '';
    document.getElementById('dga-export-textarea').value = '';
    document.getElementById('dga-import-results').classList.add('hidden');
    document.getElementById('dga-import-results').innerHTML = '';
    document.getElementById('dga-import-submit-btn').textContent = 'Import';
    document.getElementById('dga-import-submit-btn').disabled = false;
    dgaSwitchImportExportTab('import');
    document.getElementById('dga-import-export-modal').classList.remove('hidden');
    dgaLoadExport();
}

function dgaCloseImportExportModal() {
    const homeOverlay = document.getElementById('dga-import-export-modal');
    const ieBox = document.querySelector('.inv-modal-import-export');

    // Closing mid-morph should never leave a stale resize animation attached to the box.
    resetBoxResize(ieBox);
    resetMorphBox(ieBox);

    // If the box was borrowed by the settings overlay for the resize morph, return
    // everything to its normal place (invisible now, so no flash from the move).
    if (ieBox.parentElement !== homeOverlay) {
        const settingsOverlay = document.getElementById('dga-settings-modal');
        const settingsBox = settingsOverlay.querySelector('.inv-modal:not(.inv-modal-import-export)');
        settingsOverlay.classList.add('hidden');
        settingsOverlay.onclick = closeDeckSettingsModal;
        resetMorphBox(settingsBox);
        settingsBox.classList.remove('hidden');
        homeOverlay.appendChild(ieBox);
    }

    homeOverlay.classList.add('hidden');
}

function dgaSwitchImportExportTab(tab) {
    // Re-entrancy guard: a double-click (or any repeat call while already on this tab)
    // would otherwise read the box's height *mid-animation* as a bogus "from" value once
    // the first call's still-running animation gets cancelled below — that produced the
    // glitch where the box eased toward the wrong height before snapping to the right one.
    if (tab === dgaImportExportTab) return;

    const box = document.querySelector('.inv-modal-import-export');
    animateBoxResize(box, () => {
        dgaImportExportTab = tab;
        document.getElementById('dga-import-tab-btn').classList.toggle('active', tab === 'import');
        document.getElementById('dga-export-tab-btn').classList.toggle('active', tab === 'export');
        document.getElementById('dga-import-panel').classList.toggle('hidden', tab !== 'import');
        document.getElementById('dga-export-panel').classList.toggle('hidden', tab !== 'export');
    });
}

async function dgaLoadExport() {
    const textarea = document.getElementById('dga-export-textarea');
    textarea.value = 'Loading...';
    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/export`);
        const data = await res.json();
        textarea.value = data.text || '';
    } catch {
        textarea.value = 'Failed to load export.';
    }
}

async function dgaCopyExport() {
    const textarea = document.getElementById('dga-export-textarea');
    await navigator.clipboard.writeText(textarea.value);
    const btn = document.getElementById('dga-export-copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => {
        btn.textContent = 'Copy to Clipboard';
    }, 1800);
}

async function dgaSubmitImport() {
    const textarea = document.getElementById('dga-import-textarea');
    const lines = textarea.value.trim();
    if (!lines || !activeDeck) return;

    const btn = document.getElementById('dga-import-submit-btn');
    const resultsEl = document.getElementById('dga-import-results');
    btn.disabled = true;
    btn.textContent = 'Parsing...';
    resultsEl.innerHTML = '';
    resultsEl.classList.add('hidden');

    try {
        // Step 1 — parse text, get resolved + unresolved lists
        const parseRes = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/import/parse`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({text: lines})
        });
        const parseData = await parseRes.json();

        const resolved = parseData.resolved || [];
        const unresolved = parseData.unresolved || [];
        const total = resolved.length + unresolved.length;

        // Step 2 — commit all locally-resolved cards in one shot
        if (resolved.length) {
            await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/import/commit`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({cards: resolved})
            });
        }

        // Step 3 — resolve unresolved cards one at a time with progress bar
        const notFound = [];
        let done = resolved.length;

        if (unresolved.length) {
            resultsEl.innerHTML = dgaProgressHTML(done, total, unresolved[0].name);
            resultsEl.classList.remove('hidden');

            for (const item of unresolved) {
                dgaUpdateProgress(done, total, item.name);
                const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/import/resolve`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name: item.name, qty: item.qty, section: item.section})
                });
                const data = await res.json();
                if (!data.found) notFound.push(item.name);
                done++;
                dgaUpdateProgress(done, total, done < total ? unresolved[done - resolved.length]?.name || '' : '');
            }
        }

        // Step 4 — reload deck and render
        const deckRes = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}`);
        activeDeckData = await deckRes.json();
        renderDeckSections(activeDeckData);
        renderSectionList();

        let totalQty = 0;
        for (const cards of Object.values(activeDeckData.sections || {}))
            for (const row of cards) totalQty += row.quantity;
        if (gaDecks[activeDeck]) gaDecks[activeDeck].card_count = totalQty;

        dgaLoadExport();

        // Final result
        const imported = total - notFound.length;
        let html = `<div class="inv-import-summary inv-import-summary--ok">✓ ${imported} card${imported !== 1 ? 's' : ''} imported</div>`;
        if (notFound.length) {
            html += `<div class="inv-import-summary inv-import-summary--err">✕ ${notFound.length} not found</div>`;
            html += notFound.map(n => `<div class="inv-import-error-line"><span class="inv-import-error-raw">${n}</span></div>`).join('');
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

function dgaProgressHTML(done, total, currentCard) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const label = currentCard ? `${done}/${total} — ${currentCard}` : `${done}/${total}`;
    return `
        <div class="dga-progress-wrap">
            <div class="dga-progress-label" id="dga-progress-label">${label}</div>
            <div class="dga-progress-track">
                <div class="dga-progress-bar" id="dga-progress-bar" style="width:${pct}%"></div>
            </div>
        </div>`;
}

function dgaUpdateProgress(done, total, currentCard) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const label = document.getElementById('dga-progress-label');
    const bar = document.getElementById('dga-progress-bar');
    if (label) label.textContent = currentCard ? `${done}/${total} — ${currentCard}` : `${done}/${total}`;
    if (bar) bar.style.width = `${pct}%`;
}

// ═══════════════════════════════════════
// ADD CARD MODAL — simplified (search → section+qty → add)
// ═══════════════════════════════════════

function openDeckAddModal(sectionName = null) {
    dgaAddModalCardId = null;
    dgaAddModalCardName = null;
    dgaAddModalEditionId = null;
    dgaAddModalFoilId = null;
    dgaAddModalCardData = null;
    dgaAddModalPreSection = sectionName;

    document.getElementById('dga-add-card-search').value = '';
    const results = document.getElementById('dga-add-card-results');
    results.style.gridTemplateColumns = ''; // a prior search may have left this widened
    results.classList.remove('has-scroll');
    results.innerHTML = `
        <div class="inv-search-placeholder" style="padding:30px 0">
            <span class="inv-empty-icon">⬡</span><p>Search for a card to add it.</p>
        </div>`;
    document.getElementById('dga-add-step-search').classList.remove('hidden');
    document.getElementById('dga-add-step-confirm').classList.add('hidden');
    document.getElementById('dga-add-back-btn').classList.add('hidden');
    document.querySelector('#dga-add-modal .inv-modal-wide').classList.remove('inv-modal-foil-step');
    document.getElementById('dga-add-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('dga-add-card-search').focus(), 60);
}

function closeDeckAddModal() {
    document.getElementById('dga-add-modal').classList.add('hidden');
    hideDgaAddAc();
    // Closing mid-resize shouldn't leave a stale animation holding the box at the wrong
    // size for next time — it uses fill:'forwards' so it keeps holding even while hidden.
    resetBoxResize(document.querySelector('#dga-add-modal .inv-modal-wide'));
}

// Thin adapter over the shared animateBoxResize() for this modal's box.
function dgaAnimateAddModalResize(mutate) {
    animateBoxResize(document.querySelector('#dga-add-modal .inv-modal-wide'), mutate);
}

function dgaBackToSearch() {
    if (document.getElementById('dga-add-step-confirm').classList.contains('hidden')) return;
    dgaAnimateAddModalResize(() => {
        document.getElementById('dga-add-step-confirm').classList.add('hidden');
        document.getElementById('dga-add-step-search').classList.remove('hidden');
        document.getElementById('dga-add-back-btn').classList.add('hidden');
        document.querySelector('#dga-add-modal .inv-modal-wide').classList.remove('inv-modal-foil-step');
    });
    // Stale foil options from the last card shouldn't linger into the next pick
    dgaAddModalFoilId = null;
    dgaAddModalCardData = null;
    const foilsBox = document.getElementById('dga-add-modal-foils');
    foilsBox.classList.add('hidden');
    foilsBox.innerHTML = '';
}

async function searchDgaAddCards() {
    const query = document.getElementById('dga-add-card-search')?.value?.trim();
    const results = document.getElementById('dga-add-card-results');
    if (!results || !query) return;

    // A prior search may have widened the grid to fit multiple result columns — reset it
    // before showing a single-message placeholder, or the placeholder inherits that stale
    // width instead of shrinking back down to its natural size.
    const resetResultsGrid = () => {
        results.style.gridTemplateColumns = '';
        results.classList.remove('has-scroll');
    };

    dgaAnimateAddModalResize(() => {
        resetResultsGrid();
        results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Searching...</p></div>`;
    });

    try {
        const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();

        if (!data.cards?.length) {
            dgaAnimateAddModalResize(() => {
                resetResultsGrid();
                results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>${data.message || 'No cards found.'}</p></div>`;
            });
            return;
        }

        // Unique card_ids — if only one unique card, go straight to confirm
        const uniqueIds = [...new Set(data.cards.map(c => c.card_id))];
        if (uniqueIds.length === 1) {
            const card = data.cards[0];
            dgaGoToConfirm(card.card_id, card.name, card.edition_id, dgaCardSetLabel(card));
            return;
        }

        // The tile images reserve their aspect ratio via CSS (aspect-ratio: 5/7 on
        // .inv-search-tile img), so the grid's height is known immediately — nothing here
        // waits on images loading before the resize animation measures its target size.
        dgaAnimateAddModalResize(() => {
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
                        <img src="/images/${card.edition_id}.jpg" alt="${card.name}">
                        <div class="card-tile-dim"></div>
                        <div class="inv-search-tile-add tile-action-btn">+</div>
                    </div>`;
                tile.onclick = () => dgaGoToConfirm(card.card_id, card.name, card.edition_id, dgaCardSetLabel(card));
                tile.addEventListener('animationend', () => tile.classList.add('animated'));
                results.appendChild(tile);
            });
        });
    } catch {
        dgaAnimateAddModalResize(() => {
            resetResultsGrid();
            results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Search failed.</p></div>`;
        });
    }
}

function dgaCardSetLabel(card) {
    const name = card.set_name || '';
    const prefix = card.set_prefix || '';
    if (name && prefix) return `${name} (${prefix})`;
    return name || prefix || '';
}

function dgaGoToConfirm(cardId, cardName, editionId, setLabel = '') {
    dgaAddModalCardId = cardId;
    dgaAddModalCardName = cardName;
    dgaAddModalEditionId = editionId;

    document.getElementById('dga-add-modal-name').textContent = cardName;
    const setEl = document.getElementById('dga-add-modal-set');
    if (setEl) setEl.textContent = setLabel;
    document.getElementById('dga-add-modal-img').src = editionId ? `/images/${editionId}.jpg` : '';
    document.getElementById('dga-add-modal-qty').value = 1;

    // Populate section dropdown — pre-select the section whose + tile was clicked
    const sections = activeDeckData ? Object.keys(activeDeckData.sections) : ['Main Deck'];
    const preSelect = dgaAddModalPreSection && sections.includes(dgaAddModalPreSection)
        ? dgaAddModalPreSection
        : (sections[0] || 'Main Deck');
    const menu = document.getElementById('dga-add-section-menu');
    const label = document.getElementById('dga-add-section-label');
    const hidden = document.getElementById('dga-add-section');
    menu.innerHTML = '';
    sections.forEach(s => {
        const opt = document.createElement('div');
        opt.className = `dga-fmt-dropdown-option${s === preSelect ? ' selected' : ''}`;
        opt.dataset.value = s;
        opt.textContent = s;
        opt.onclick = () => {
            hidden.value = s;
            label.textContent = s;
            document.querySelectorAll('#dga-add-section-menu .dga-fmt-dropdown-option').forEach(o => o.classList.toggle('selected', o === opt));
            document.getElementById('dga-add-section-menu').classList.add('hidden');
            document.getElementById('dga-add-section-btn').classList.remove('open');
        };
        menu.appendChild(opt);
    });
    hidden.value = preSelect;
    label.textContent = preSelect;

    // Reset any previous card's foil pick — either resolved fresh below, or
    // left null (generic — "any edition") when the deck isn't Edition Locked.
    dgaAddModalFoilId = null;
    dgaAddModalCardData = null;
    const editionLocked = !!activeDeckData?.edition_locked;
    const foilsBox = document.getElementById('dga-add-modal-foils');
    const submitBtn = document.getElementById('dga-add-modal-submit');
    if (editionLocked) {
        foilsBox.classList.remove('hidden');
        submitBtn.disabled = true;
    } else {
        foilsBox.classList.add('hidden');
        foilsBox.innerHTML = '';
        submitBtn.disabled = false;
    }

    dgaAnimateAddModalResize(() => {
        document.getElementById('dga-add-step-search').classList.add('hidden');
        document.getElementById('dga-add-step-confirm').classList.remove('hidden');
        document.getElementById('dga-add-back-btn').classList.remove('hidden');
        document.querySelector('#dga-add-modal .inv-modal-wide').classList.add('inv-modal-foil-step');
    });

    if (editionLocked) dgaLoadFoilOptions(cardId);
}

// Fetches the card's full edition/foil list and lets the user pin the add to
// one specific printing — same data source and sort as Inventory's foil step
// (goToFoilStep in inventory.js), duplicated here under dga-prefixed ids
// rather than shared, matching this file's existing convention of not
// sharing modal code with inventory.js.
async function dgaLoadFoilOptions(cardId) {
    const foilList = document.getElementById('dga-add-modal-foils');
    foilList.innerHTML = '<div style="font-size:0.78rem;color:var(--text-muted);">Loading...</div>';
    document.getElementById('dga-add-modal-submit').disabled = true;

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

        foilList.innerHTML = '';
        let firstOpt = null;

        editions.forEach(([eid, einfo]) => {
            const rarity = rarityMapInv[einfo.rarity] || '?';
            Object.entries(einfo.foils || {}).forEach(([fid, finfo]) => {
                const variants = finfo.variants || {};

                // Same "skip a parent that no separate product was ever
                // made for" rule as Inventory's goToFoilStep — see its
                // comment for the full rationale (Curio-Foil-only cards).
                const variantPopulation = Object.values(variants).reduce((sum, v) => sum + (v.population || 0), 0);
                const remainingPopulation = finfo.population == null ? null : finfo.population - variantPopulation;

                if (remainingPopulation === null || remainingPopulation > 0) {
                    const opt = dgaBuildFoilOption(eid, fid, finfo.kind, einfo.set_prefix, rarity, einfo.collector_number, false, finfo.population == null);
                    if (!firstOpt) firstOpt = {opt, eid, fid};
                    foilList.appendChild(opt);
                }

                Object.entries(variants).forEach(([vid, vinfo]) => {
                    const vopt = dgaBuildFoilOption(eid, vid, vinfo.kind, einfo.set_prefix, rarity, einfo.collector_number, true);
                    if (!firstOpt) firstOpt = {opt: vopt, eid, fid: vid};
                    foilList.appendChild(vopt);
                });
            });
        });

        if (firstOpt) dgaSelectFoilOption(firstOpt.opt, firstOpt.eid, firstOpt.fid);
    } catch {
        foilList.innerHTML = '<div style="font-size:0.78rem;color:var(--error);">Failed to load editions.</div>';
    }
}

function dgaBuildFoilOption(editionId, foilId, kind, setPrefix, rarity, collectorNum, isVariant, isTemp = false) {
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


// Open a section dropdown as position:fixed above its button — ancestor
// overflow:hidden containers (modal panels) can no longer clip it.
// Under the root zoom rule, getBoundingClientRect reports visual (zoomed)
// pixels while fixed positioning uses layout pixels — divide by the zoom.
function _pageZoom() {
    const z = parseFloat(getComputedStyle(document.documentElement).zoom);
    return (isFinite(z) && z > 0) ? z : 1;
}

function openSectionDropdownFixed(menu, btn) {
    const z = _pageZoom();
    const r = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = (r.left / z) + 'px';
    menu.style.width = (r.width / z) + 'px';
    menu.style.right = 'auto';
    menu.style.top = 'auto';
    menu.style.bottom = ((window.innerHeight - r.top) / z + 6) + 'px';
}

function toggleDgaAddSectionDropdown() {
    const menu = document.getElementById('dga-add-section-menu');
    const btn = document.getElementById('dga-add-section-btn');
    const open = !menu.classList.contains('hidden');
    if (!open) openSectionDropdownFixed(menu, btn);
    menu.classList.toggle('hidden', open);
    btn.classList.toggle('open', !open);
}

function changeDgaAddQty(delta) {
    const input = document.getElementById('dga-add-modal-qty');
    input.value = Math.max(1, Math.min(999, (parseInt(input.value) || 1) + delta));
}

async function submitDgaAddCard() {
    if (!dgaAddModalCardId || !activeDeck) return;

    const section = document.getElementById('dga-add-section').value;
    const quantity = parseInt(document.getElementById('dga-add-modal-qty').value) || 1;
    // Not Edition Locked means "any edition" — even though the search step
    // may have resolved *a* editionId for the thumbnail, that pick is only
    // cosmetic and must not be persisted as a real edition/foil selection.
    const editionLocked = !!activeDeckData?.edition_locked;
    const editionId = editionLocked ? dgaAddModalEditionId : null;
    const foilId = editionLocked ? dgaAddModalFoilId : null;
    const btn = document.getElementById('dga-add-modal-submit');
    btn.disabled = true;
    btn.textContent = 'Adding...';

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({card_id: dgaAddModalCardId, section, quantity, edition_id: editionId, foil_id: foilId})
        });

        if (res.ok) {
            // Reset button before closing
            btn.disabled = false;
            btn.textContent = 'Add to Deck';

            if (editionLocked) {
                // Update local state — a specific, known row
                if (activeDeckData?.sections?.[section] !== undefined) {
                    const cards = activeDeckData.sections[section];
                    const row = cards.find(r => r.card_id === dgaAddModalCardId
                        && (r.edition_id || null) === editionId && (r.foil_id || null) === foilId);
                    if (row) row.quantity += quantity;
                    else cards.push({card_id: dgaAddModalCardId, edition_id: editionId, foil_id: foilId, quantity});
                    if (dgaAddModalCardName && !activeDeckData.name_map[dgaAddModalCardId])
                        activeDeckData.name_map[dgaAddModalCardId] = dgaAddModalCardName;
                    // Seed editions_info/foils_info for the badge — the server won't be
                    // asked again until the next full reload, so without this a freshly
                    // picked edition/foil renders its badge as bare "#?" until then.
                    const einfo = dgaAddModalCardData?.editions?.[editionId];
                    if (einfo && !activeDeckData.editions_info[editionId]) {
                        activeDeckData.editions_info[editionId] = {
                            set_prefix: einfo.set_prefix, collector_number: einfo.collector_number, rarity: einfo.rarity,
                        };
                    }
                    if (foilId && einfo && !activeDeckData.foils_info[foilId]) {
                        activeDeckData.foils_info[foilId] = {kind: einfo.foils?.[foilId]?.kind};
                    }
                }
                closeDeckAddModal();
                renderDeckSections(activeDeckData);
                // Optimistic render above shows the tile immediately; reload to
                // pull in the new printing's card_prices entry for its badge.
                dgaReloadActiveDeck();
            } else {
                // Not locked — the server picked a random printing and/or
                // merged into an existing row for this card_id; reload
                // rather than guess which.
                closeDeckAddModal();
                await dgaReloadActiveDeck();
            }

            if (gaDecks[activeDeck])
                gaDecks[activeDeck].card_count = (gaDecks[activeDeck].card_count || 0) + quantity;
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

// ── Autocomplete ──

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
        }
        hideDgaAddAc();
        searchDgaAddCards();
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
// SET BANNER MODAL (deck grid → search a specific card edition)
// ═══════════════════════════════════════

function openDeckBannerModal(deckName) {
    dgaBannerTargetDeck = deckName;
    dgaBannerModalEditionId = null;

    document.getElementById('dga-banner-search').value = '';
    const results = document.getElementById('dga-banner-results');
    results.style.gridTemplateColumns = ''; // a prior search may have left this widened
    results.classList.remove('has-scroll');
    results.innerHTML = `
        <div class="inv-search-placeholder" style="padding:30px 0">
            <span class="inv-empty-icon">⬡</span><p>Search for a card to set as the banner.</p>
        </div>`;
    document.getElementById('dga-banner-step-search').classList.remove('hidden');
    document.getElementById('dga-banner-step-confirm').classList.add('hidden');
    document.getElementById('dga-banner-back-btn').classList.add('hidden');
    document.querySelector('#dga-banner-modal .inv-modal-wide').classList.remove('inv-modal-foil-step');
    document.getElementById('dga-banner-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('dga-banner-search').focus(), 60);
}

function closeDeckBannerModal() {
    document.getElementById('dga-banner-modal').classList.add('hidden');
    hideDgaBannerAc();
    resetBoxResize(document.querySelector('#dga-banner-modal .inv-modal-wide'));
    dgaBannerTargetDeck = null;
}

function dgaAnimateBannerModalResize(mutate) {
    animateBoxResize(document.querySelector('#dga-banner-modal .inv-modal-wide'), mutate);
}

function dgaBannerBackToSearch() {
    if (document.getElementById('dga-banner-step-confirm').classList.contains('hidden')) return;
    dgaAnimateBannerModalResize(() => {
        document.getElementById('dga-banner-step-confirm').classList.add('hidden');
        document.getElementById('dga-banner-step-search').classList.remove('hidden');
        document.getElementById('dga-banner-back-btn').classList.add('hidden');
        document.querySelector('#dga-banner-modal .inv-modal-wide').classList.remove('inv-modal-foil-step');
    });
}

async function searchDgaBannerCards() {
    const query = document.getElementById('dga-banner-search')?.value?.trim();
    const results = document.getElementById('dga-banner-results');
    if (!results || !query) return;

    const resetResultsGrid = () => {
        results.style.gridTemplateColumns = '';
        results.classList.remove('has-scroll');
    };

    dgaAnimateBannerModalResize(() => {
        resetResultsGrid();
        results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Searching...</p></div>`;
    });

    try {
        // all_prints=1 — unlike Add Card, a banner needs a specific printing,
        // not a random edition of the card (see api_cards_search in app.py).
        const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}&all_prints=1`);
        const data = await res.json();

        if (!data.cards?.length) {
            dgaAnimateBannerModalResize(() => {
                resetResultsGrid();
                results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>${data.message || 'No cards found.'}</p></div>`;
            });
            return;
        }

        const cards = [...data.cards].sort((a, b) => {
            if (a.name !== b.name) return a.name.localeCompare(b.name);
            return (a.collector_number || '').localeCompare(b.collector_number || '', undefined, {numeric: true});
        });

        dgaAnimateBannerModalResize(() => {
            results.innerHTML = '';
            const cols = Math.min(cards.length, 5);
            results.style.gridTemplateColumns = `repeat(${cols}, 255px)`;
            results.classList.toggle('has-scroll', cards.length >= 6);

            cards.forEach((card, i) => {
                const tile = document.createElement('div');
                tile.className = 'inv-search-tile tile-hoverable';
                tile.style.animationDelay = `${Math.min(i, 20) * 30}ms`;
                const setLabel = dgaCardSetLabel(card);
                const captionParts = [setLabel, card.collector_number ? `#${card.collector_number}` : ''].filter(Boolean);
                tile.innerHTML = `
                    <div class="edition-tile-wrap tile-zoom">
                        <img src="/images/${card.edition_id}.jpg" alt="${card.name}">
                        <div class="card-tile-dim"></div>
                        <div class="inv-search-tile-add tile-action-btn">🖼</div>
                    </div>
                    <div class="dga-banner-tile-caption">
                        <div class="dga-banner-tile-name">${card.name}</div>
                        <div class="dga-banner-tile-set">${captionParts.join(' · ')}</div>
                    </div>`;
                tile.onclick = () => dgaGoToBannerConfirm(card.name, card.edition_id, setLabel);
                tile.addEventListener('animationend', () => tile.classList.add('animated'));
                results.appendChild(tile);
            });
        });
    } catch {
        dgaAnimateBannerModalResize(() => {
            resetResultsGrid();
            results.innerHTML = `<div class="inv-search-placeholder" style="padding:20px 0"><span class="inv-empty-icon">⬡</span><p>Search failed.</p></div>`;
        });
    }
}

function dgaGoToBannerConfirm(cardName, editionId, setLabel = '') {
    dgaBannerModalEditionId = editionId;

    document.getElementById('dga-banner-modal-name').textContent = cardName;
    const setEl = document.getElementById('dga-banner-modal-set');
    if (setEl) setEl.textContent = setLabel;
    document.getElementById('dga-banner-modal-img').src = editionId ? `/images/${editionId}.jpg` : '';

    dgaAnimateBannerModalResize(() => {
        document.getElementById('dga-banner-step-search').classList.add('hidden');
        document.getElementById('dga-banner-step-confirm').classList.remove('hidden');
        document.getElementById('dga-banner-back-btn').classList.remove('hidden');
        document.querySelector('#dga-banner-modal .inv-modal-wide').classList.add('inv-modal-foil-step');
    });
}

async function submitDgaBanner() {
    if (!dgaBannerModalEditionId || !dgaBannerTargetDeck) return;

    const deckName = dgaBannerTargetDeck;
    const editionId = dgaBannerModalEditionId;
    const btn = document.getElementById('dga-banner-modal-submit');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(deckName)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({banner: editionId})
        });

        if (res.ok) {
            btn.disabled = false;
            btn.textContent = 'Set as Banner';

            if (gaDecks[deckName]) gaDecks[deckName].banner = editionId;

            closeDeckBannerModal();
            renderDeckGrid();
        } else {
            btn.textContent = 'Error';
            setTimeout(() => {
                btn.textContent = 'Set as Banner';
                btn.disabled = false;
            }, 1500);
        }
    } catch {
        btn.textContent = 'Failed';
        setTimeout(() => {
            btn.textContent = 'Set as Banner';
            btn.disabled = false;
        }, 1500);
    }
}

// ── Autocomplete ──

async function fetchDgaBannerSuggestions(value) {
    const list = document.getElementById('dga-banner-autocomplete');
    if (value.length < 2) {
        hideDgaBannerAc();
        return;
    }
    try {
        const res = await fetch(`/api/cards/suggest?q=${encodeURIComponent(value)}`);
        const data = await res.json();
        if (!data.suggestions?.length) {
            hideDgaBannerAc();
            return;
        }
        dgaBannerAcIndex = -1;
        list.innerHTML = '';
        data.suggestions.forEach(name => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.textContent = name;
            item.onclick = () => {
                document.getElementById('dga-banner-search').value = name;
                hideDgaBannerAc();
                searchDgaBannerCards();
            };
            list.appendChild(item);
        });
        list.classList.remove('hidden');
    } catch {
        hideDgaBannerAc();
    }
}

function hideDgaBannerAc() {
    const list = document.getElementById('dga-banner-autocomplete');
    if (list) {
        list.classList.add('hidden');
        list.innerHTML = '';
    }
    dgaBannerAcIndex = -1;
}

function handleDgaBannerKeydown(e) {
    const list = document.getElementById('dga-banner-autocomplete');
    const items = list?.querySelectorAll('.autocomplete-item') || [];
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        dgaBannerAcIndex = Math.min(dgaBannerAcIndex + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('selected', i === dgaBannerAcIndex));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        dgaBannerAcIndex = Math.max(dgaBannerAcIndex - 1, -1);
        items.forEach((el, i) => el.classList.toggle('selected', i === dgaBannerAcIndex));
    } else if (e.key === 'Enter') {
        if (dgaBannerAcIndex >= 0 && items[dgaBannerAcIndex]) {
            document.getElementById('dga-banner-search').value = items[dgaBannerAcIndex].textContent;
        }
        hideDgaBannerAc();
        searchDgaBannerCards();
    } else if (e.key === 'Escape') {
        hideDgaBannerAc();
        closeDeckBannerModal();
    }
}

document.addEventListener('click', e => {
    if (!document.getElementById('dga-banner-modal')) return;
    if (!e.target.closest('#dga-banner-search') && !e.target.closest('#dga-banner-autocomplete')) hideDgaBannerAc();
}, true);


window.initDecksGa = async function () {
    if (!currentUser) return;
    await loadMyDecks();

    const urlParams = new URLSearchParams(window.location.search);
    const deckName = urlParams.get('deck');
    if (deckName && gaDecks[deckName]) {
        await openDeckDetail(deckName, false);
    }
};
// ── State ──
let gaDecks = {};
let activeDeck = null;
let activeDeckData = null;

// ── Add modal state ──
let dgaAddModalCardId = null;
let dgaAddModalCardName = null;
let dgaAddModalEditionId = null;
let dgaAddModalPreSection = null;
let dgaAddAcIndex = -1;
let _dgaAddModalResizeAnim = null;

// ═══════════════════════════════════════
// DECK CONTEXT MENU
// ═══════════════════════════════════════

let dgaCtxTargetDeck = null;

function dgaOpenContextMenu(e, deckName) {
    dgaCtxTargetDeck = deckName;
    const menu = document.getElementById('dga-context-menu');

    // Only offer Clear Banner when the deck has one
    const clearBtn = document.getElementById('dga-ctx-clear-banner');
    if (clearBtn) clearBtn.style.display = gaDecks[deckName]?.banner ? '' : 'none';

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

function dgaCloseContextMenu() {
    document.getElementById('dga-context-menu').classList.add('hidden');
    dgaCtxTargetDeck = null;
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

function dgaOpenCardContextMenu(e, editionId) {
    dgaCtxTargetEdition = editionId;
    const isCurrent = gaDecks[activeDeck]?.banner === editionId;
    document.getElementById('dga-ctx-banner-label').textContent =
        isCurrent ? 'Remove Banner' : 'Set as Banner';
    const menu = document.getElementById('dga-card-context-menu');
    menu.classList.remove('hidden');
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 60);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
}

function dgaCloseCardContextMenu() {
    document.getElementById('dga-card-context-menu')?.classList.add('hidden');
    dgaCtxTargetEdition = null;
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
    const desc = entry.desc ? `<div class="dga-tile-desc">${entry.desc}</div>` : '';
    const count = entry.card_count || 0;

    tile.innerHTML = `
        <div class="dga-tile-icon">⬡</div>
        <div class="dga-tile-name">${name}${fmt}</div>
        <div class="dga-tile-desc">${entry.desc || ''}</div>
        <div class="dga-tile-meta">${count} card${count !== 1 ? 's' : ''}</div>`;

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

    const grid = document.getElementById('dga-card-grid');
    if (grid) grid.innerHTML = '<p class="dga-loading">Loading...</p>';
    const countEl = document.getElementById('dga-detail-counts');
    if (countEl) countEl.textContent = '';

    if (pushUrl) window.history.pushState({}, '', `/decks_ga?deck=${encodeURIComponent(deckName)}`);

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(deckName)}`);
        if (!res.ok) throw new Error();
        activeDeckData = await res.json();
        renderDeckSections(activeDeckData);
    } catch {
        if (grid) grid.innerHTML = '<p class="dga-loading">Failed to load deck.</p>';
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

// FLIP: record positions, mutate the DOM, then animate everything that shifted
function dgaFlipMove(mutate) {
    const els = [...document.querySelectorAll(
        '.dga-section-grid .dga-card-tile, ' +
        '.dga-section-grid .inv-card-add-tile, .dga-drop-placeholder')];
    const first = new Map(els.map(el => [el, el.getBoundingClientRect()]));
    mutate();
    for (const el of els) {
        if (!el.isConnected) continue;
        const f = first.get(el);
        if (!f || (f.width === 0 && f.height === 0)) continue; // was hidden — no origin to slide from
        const l = el.getBoundingClientRect();
        const dx = f.left - l.left, dy = f.top - l.top;
        if (!dx && !dy) continue;
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
            el.style.transition = 'transform 0.18s ease';
            el.style.transform = '';
            el.addEventListener('transitionend', () => {
                el.style.transition = '';
            }, {once: true});
        });
    }
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
    const {cardId, fromSection} = dgaDragCard;

    // No-op guard: dropping back onto its own position. Indices are
    // post-removal (the dragged card is excluded from the count), so its
    // own position is exactly currentIndex — one step right is index + 1.
    const sections = activeDeckData?.sections || {};
    if (fromSection === toSection) {
        const currentIndex = Object.keys(sections[fromSection] || {}).indexOf(cardId);
        if (currentIndex === index) return;
    }

    // Optimistic: apply the move locally and render the final order NOW —
    // synchronously, before dragend fires — so no restore animation or
    // old-order frame ever shows. The server call runs in the background.
    if (sections[fromSection] && cardId in sections[fromSection]) {
        let qty = sections[fromSection][cardId];
        delete sections[fromSection][cardId];
        if (cardId in (sections[toSection] || {})) {
            qty += sections[toSection][cardId];
            delete sections[toSection][cardId];
        }
        const items = Object.entries(sections[toSection] || {});
        items.splice(Math.max(0, Math.min(index, items.length)), 0, [cardId, qty]);
        sections[toSection] = Object.fromEntries(items);
    }
    renderDeckSections(activeDeckData, false);

    fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({card_id: cardId, from_section: fromSection, to_section: toSection, index})
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

function renderDeckSections(deckData, animate = true) {
    const grid = document.getElementById('dga-card-grid');
    grid.classList.toggle('dga-no-anim', !animate);
    const sections = deckData.sections || {};
    const nameMap = deckData.name_map || {};
    const editionMap = deckData.edition_map || {};

    let totalUnique = 0, totalQty = 0;
    for (const cards of Object.values(sections)) {
        for (const qty of Object.values(cards)) {
            totalUnique++;
            totalQty += qty;
        }
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
            const sectionQty = Object.values(cards).reduce((s, q) => s + q, 0);
            const header = document.createElement('div');
            header.className = 'dga-section-header';
            header.innerHTML = `
                <span class="dga-section-label-group">
                    <span class="dga-section-label dga-section-label-editable" title="Click to rename">${sectionName}</span><span class="dga-section-edit-icon">✎</span>
                </span>
                <span class="dga-section-count">${sectionQty} card${sectionQty !== 1 ? 's' : ''}</span>
                <div class="dga-section-header-actions">
                    <button class="dga-section-action-btn dga-section-action-delete" title="Delete section">✕</button>
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

            // Card tiles
            const cardEntries = Object.entries(cards);
            cardEntries.forEach(([card_id, qty], i) => {
                const cardName = nameMap[card_id] || card_id;
                const editionId = editionMap[card_id] || null;
                sectionGrid.appendChild(buildDeckCardTile(card_id, cardName, editionId, qty, sectionName, i, cardEntries.length));
            });

            // Add tile inside this section's grid
            const addTile = document.createElement('div');
            addTile.className = 'inv-card-add-tile';
            addTile.style.animationDelay = `${Math.min(cardEntries.length * 40, 640)}ms`;
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
                activeDeckData.sections[name] = {};
                renderDeckSections(activeDeckData, false);
            } catch {
                cancel();
            }
        });
        input.addEventListener('blur', cancel);
    };
    return btn;
}

function updateDeckCounts(unique, total) {
    const countEl = document.getElementById('dga-detail-counts');
    if (countEl) countEl.textContent = `${unique} card${unique !== 1 ? 's' : ''} · ${total} cop${total !== 1 ? 'ies' : 'y'}`;
}

// ── Deck tile edit mode — uses TileEditMode from tiles.js ──
const dgaDeckEditMode = new TileEditMode('dga-qty-confirm-bar', async (changes) => {
    for (const c of changes) {
        const section = c.input.dataset.section;
        if (!section) continue;

        try {
            if (c.quantity <= 0) {
                await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
                    method: 'DELETE',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({card_id: c.cardId, section})
                });
                if (activeDeckData?.sections?.[section])
                    delete activeDeckData.sections[section][c.cardId];
            } else {
                await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
                    method: 'PATCH',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({card_id: c.cardId, section, quantity: c.quantity})
                });
                if (activeDeckData?.sections?.[section])
                    activeDeckData.sections[section][c.cardId] = c.quantity;
            }
            // Update badge
            const badge = c.input.closest('.dga-card-tile')?.querySelector('.dga-qty-badge');
            if (badge) {
                badge.textContent = `x${c.quantity}`;
                badge.style.display = c.quantity > 0 ? '' : 'none';
            }
        } catch {
            console.error('Failed to update deck card quantity');
        }
    }

    // Re-render to remove deleted tiles
    const anyDeleted = changes.some(c => c.quantity <= 0);
    const totalQty = Object.values(activeDeckData?.sections || {}).reduce((s, c) => s + Object.values(c).reduce((a, v) => a + v, 0), 0);
    const totalUnique = Object.values(activeDeckData?.sections || {}).reduce((s, c) => s + Object.keys(c).length, 0);

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

function buildDeckCardTile(card_id, cardName, editionId, qty, sectionName, index, total) {
    const tile = document.createElement('div');
    tile.className = 'dga-card-tile inv-card-tile';
    const delay = total <= 1 ? 0 : Math.min(index * 40, Math.round((index / (total - 1)) * 600));
    tile.style.animationDelay = `${delay}ms`;

    const imgSrc = editionId ? `/images/${editionId}.jpg` : '';

    tile.innerHTML = `
        <div class="edition-tile-wrap">
            <img src="${imgSrc}" alt="${cardName}" onerror="this.style.opacity='0.1'">
            <div class="card-tile-dim"></div>
        </div>
        <span class="dga-qty-badge">x${qty}</span>
        <div class="dga-card-tile-overlay">
            <div class="dga-card-tile-info">
                <div class="dga-card-tile-name">${cardName}</div>
                <div class="dga-card-tile-foil">${sectionName}</div>
            </div>
        </div>
        <div class="inv-card-tile-qty-ctrl">
            <button class="inv-tile-qty-btn inv-tile-qty-add" type="button">+</button>
            <input class="inv-tile-qty-input" type="number" value="${qty}" min="0" max="999"
                data-card-id="${card_id}"
                data-section="${sectionName}">
            <button class="inv-tile-qty-btn inv-tile-qty-sub" type="button">−</button>
        </div>
        <div class="inv-tile-qty-indicator"></div>`;

    const input = tile.querySelector('.inv-tile-qty-input');
    const badge = tile.querySelector('.dga-qty-badge');

    tile.addEventListener('contextmenu', e => {
        e.preventDefault();
        dgaOpenCardContextMenu(e, editionId);
    });

    // ── Drag & drop: reorder within / move across sections ──
    tile.draggable = true;
    tile.dataset.cardId = card_id;
    tile.dataset.section = sectionName;

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
        dgaDragCard = {cardId: card_id, fromSection: sectionName, tile};
        tile.classList.add('dga-dragging');
        document.body.classList.add('dga-drag-active');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card_id); // Firefox requires data

        // Clean drag ghost: the card itself, minus overlay and qty controls
        const rect = tile.getBoundingClientRect();
        const ghost = tile.cloneNode(true);
        ghost.querySelector('.dga-card-tile-overlay')?.remove();
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
        try {
            if (newQty <= 0) {
                await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
                    method: 'DELETE',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({card_id, section: sectionName})
                });
                if (activeDeckData?.sections?.[sectionName]) {
                    delete activeDeckData.sections[sectionName][card_id];
                    renderDeckSections(activeDeckData);
                }
            } else {
                await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
                    method: 'PATCH',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({card_id, section: sectionName, quantity: newQty})
                });
                if (activeDeckData?.sections?.[sectionName])
                    activeDeckData.sections[sectionName][card_id] = newQty;
                updateDeckCounts(
                    Object.values(activeDeckData?.sections || {}).reduce((s, c) => s + Object.keys(c).length, 0),
                    Object.values(activeDeckData?.sections || {}).reduce((s, c) => s + Object.values(c).reduce((a, v) => a + v, 0), 0)
                );
            }
            // Keep list-view's in-memory card_count in sync
            if (activeDeck && gaDecks[activeDeck]) {
                gaDecks[activeDeck].card_count = Object.values(activeDeckData?.sections || {})
                    .reduce((s, c) => s + Object.values(c).reduce((a, v) => a + v, 0), 0);
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
            <button class="dga-section-delete-btn" onclick="submitDeleteSection('${name.replace(/'/g, "\\'")}')">✕</button>`;
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
        if (!activeDeckData.sections[name]) activeDeckData.sections[name] = {};
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
        if (!activeDeckData.sections[name]) activeDeckData.sections[name] = {};
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
                .reduce((s, c) => s + Object.values(c).reduce((a, v) => a + v, 0), 0);
        }
    } catch {
        console.error('Failed to delete section');
    }
}

async function submitDeckSettings() {
    const newName = document.getElementById('dga-settings-name').value.trim();
    const format = document.getElementById('dga-settings-format').value.trim();
    const desc = document.getElementById('dga-settings-desc').value.trim();
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
            body: JSON.stringify({name: newName, format, desc})
        });
        if (!res.ok) {
            errEl.textContent = 'Failed to update deck.';
            errEl.classList.remove('hidden');
            return;
        }

        const existing = gaDecks[activeDeck];
        delete gaDecks[activeDeck];
        gaDecks[newName] = {...existing, format, desc};
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

    // Reveal it at its real, final size/position right away — both boxes are centered by
    // the same flex overlay rule, so they share a center point — then fake the "resize"
    // with a transform: scale() from the settings box's size down to identity. This never
    // touches width/height (which force a full layout+paint on every animation frame and
    // is what caused the earlier late snap); the DOM box never actually changes size, so
    // there's nothing for a reflow to desync from.
    settingsBox.classList.add('hidden');
    overlay.appendChild(ieBox);
    overlay.onclick = dgaCloseImportExportModal;

    const toRect = ieBox.getBoundingClientRect();
    const scaleX = fromRect.width / toRect.width;
    const scaleY = fromRect.height / toRect.height;

    ieBox.classList.add('morph-resizing');

    const anim = ieBox.animate([
        {transform: `scale(${scaleX}, ${scaleY})`},
        {transform: 'scale(1, 1)'}
    ], {duration: 350, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards'});

    anim.finished.then(() => {
        anim.cancel();
        ieBox.style.transform = '';
        // Deliberately NOT removing 'morph-resizing' here: doing so re-enables .inv-modal's
        // default `animation: modalReveal`, which — since its 0% keyframe is opacity:0 —
        // restarts and instantly makes the whole box flash invisible before fading back in.
        // It stays suppressed until dgaCloseImportExportModal() resets it for next time.
    }).catch(() => {});

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

    // Reset any in-flight import/export animation before handing off.
    _dgaTabHeightAnim?.cancel();
    _dgaTabHeightAnim = null;
    ieBox.getAnimations().forEach(a => a.cancel());
    ieBox.classList.remove('morph-resizing');
    ieBox.style.transform = '';
    ieBox.style.height = '';
    ieBox.style.overflow = '';

    // Swap content immediately — settings becomes the visible box, import/export goes back
    // to its home overlay — then fake the "shrink" the same way the forward morph fakes the
    // "grow": settingsBox sits at its real, natural size the whole time; a transform:scale()
    // starting at the import/export box's old size and easing to identity is what fakes the
    // motion, so nothing here ever animates width/height directly.
    const homeOverlay = document.getElementById('dga-import-export-modal');
    homeOverlay.appendChild(ieBox);
    homeOverlay.classList.add('hidden');
    overlay.onclick = closeDeckSettingsModal;
    settingsBox.classList.add('morph-resizing'); // suppress modalReveal before it becomes visible
    settingsBox.classList.remove('hidden');

    const toWidth = settingsBox.offsetWidth;
    const toHeight = settingsBox.offsetHeight;
    const scaleX = fromRect.width / toWidth;
    const scaleY = fromRect.height / toHeight;

    const anim = settingsBox.animate([
        {transform: `scale(${scaleX}, ${scaleY})`},
        {transform: 'scale(1, 1)'}
    ], {duration: 350, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards'});

    anim.finished.then(() => {
        anim.cancel();
        settingsBox.style.transform = '';
        // 'morph-resizing' stays on until closeDeckSettingsModal() resets it — removing it
        // here while the box is still visible would restart modalReveal (opacity:0 flash),
        // same as the import/export box's forward-morph cleanup.
    }).catch(() => {});
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
    ieBox.getAnimations().forEach(a => a.cancel());
    _dgaTabHeightAnim = null;
    ieBox.classList.remove('morph-resizing');
    ieBox.style.transform = '';
    ieBox.style.height = '';
    ieBox.style.overflow = '';

    // If the box was borrowed by the settings overlay for the resize morph, return
    // everything to its normal place (invisible now, so no flash from the move).
    if (ieBox.parentElement !== homeOverlay) {
        const settingsOverlay = document.getElementById('dga-settings-modal');
        const settingsBox = settingsOverlay.querySelector('.inv-modal:not(.inv-modal-import-export)');
        settingsOverlay.classList.add('hidden');
        settingsOverlay.onclick = closeDeckSettingsModal;
        settingsBox.getAnimations().forEach(a => a.cancel());
        settingsBox.classList.remove('hidden', 'morph-resizing');
        settingsBox.style.transform = '';
        homeOverlay.appendChild(ieBox);
    }

    homeOverlay.classList.add('hidden');
}

let _dgaTabHeightAnim = null;

function dgaSwitchImportExportTab(tab) {
    // Re-entrancy guard: a double-click (or any repeat call while already on this tab)
    // would otherwise read the box's height *mid-animation* as a bogus "from" value once
    // the first call's still-running animation gets cancelled below — that produced the
    // glitch where the box eased toward the wrong height before snapping to the right one.
    if (tab === dgaImportExportTab) return;

    const box = document.querySelector('.inv-modal-import-export');
    // offsetHeight (layout height) rather than getBoundingClientRect() (visual, post-transform
    // size) — a tab click landing while the settings→import/export scale-in entrance is still
    // playing would otherwise read a shrunk, transform-distorted value as the "from" height.
    const fromHeight = box.offsetHeight;

    dgaImportExportTab = tab;
    document.getElementById('dga-import-tab-btn').classList.toggle('active', tab === 'import');
    document.getElementById('dga-export-tab-btn').classList.toggle('active', tab === 'export');
    document.getElementById('dga-import-panel').classList.toggle('hidden', tab !== 'import');
    document.getElementById('dga-export-panel').classList.toggle('hidden', tab !== 'export');

    const toHeight = box.offsetHeight;

    // Cancel only our own previous tab-switch animation if one's still in flight — never
    // box.getAnimations() wholesale, which would also abort an in-progress entrance morph
    // (e.g. the settings→import/export scale-in) and snap it to full size prematurely.
    _dgaTabHeightAnim?.cancel();

    // Skip animating when the box isn't actually visible yet (e.g. this call is just the
    // initial tab setup before the modal has been shown) — both heights read as 0 then.
    if (!fromHeight || fromHeight === toHeight) return;

    box.style.overflow = 'hidden';
    const anim = box.animate([
        {height: fromHeight + 'px'},
        {height: toHeight + 'px'}
    ], {duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards'});
    _dgaTabHeightAnim = anim;

    anim.finished.then(() => {
        anim.cancel();
        if (_dgaTabHeightAnim === anim) _dgaTabHeightAnim = null;
        box.style.overflow = '';
    }).catch(() => {});
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
            for (const qty of Object.values(cards)) totalQty += qty;
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
    _dgaAddModalResizeAnim?.cancel();
    _dgaAddModalResizeAnim = null;
    const box = document.querySelector('#dga-add-modal .inv-modal-wide');
    box.style.overflow = '';
    box.style.minWidth = '';
    box.style.maxWidth = '';
    box.style.maxHeight = '';
}

// Runs `mutate` (a step/content swap) and smoothly resizes the add-card box from its size
// before the swap to its size after — same box, same overlay throughout, so no backdrop-filter
// or entrance-animation concerns apply here (unlike the settings→import/export cross-modal
// morph); this animates width+height directly, same technique as the import/export tab switch.
function dgaAnimateAddModalResize(mutate) {
    const box = document.querySelector('#dga-add-modal .inv-modal-wide');

    // Cancel any previous resize animation FIRST, before measuring anything. Its held
    // fill:'forwards' value overrides CSS regardless of class changes, so if this call
    // fires again before the last one settled (e.g. a fast local search resolving straight
    // to dgaGoToConfirm before the idle→"Searching..." resize even finished), measuring
    // "from" and "to" while it's still active reads its stale held size for *both* —
    // making them look identical and skipping the animation below entirely.
    _dgaAddModalResizeAnim?.cancel();
    _dgaAddModalResizeAnim = null;

    const fromWidth = box.offsetWidth;
    const fromHeight = box.offsetHeight;

    mutate();

    const toWidth = box.offsetWidth;
    const toHeight = box.offsetHeight;

    // Skip animating when the box isn't visible yet, or the size genuinely didn't change
    // (e.g. re-confirming a different card while already on the confirm step).
    if (!fromWidth || !fromHeight || (fromWidth === toWidth && fromHeight === toHeight)) return;

    // The step swap in `mutate` already toggled classes, so the CSS min/max-width and
    // max-height for whichever step is now active are already in effect — e.g. going from
    // the wide results grid to the confirm step's `max-width: 700px` clamps the box to
    // 700px on frame 0, before the animation gets a chance to ease it there, which is why
    // width appeared to snap while height (whose max-height never changes between steps)
    // animated normally. Suspend the clamps for the animation's duration.
    box.style.overflow = 'hidden';
    box.style.minWidth = '0';
    box.style.maxWidth = 'none';
    box.style.maxHeight = 'none';

    const anim = box.animate([
        {width: fromWidth + 'px', height: fromHeight + 'px'},
        {width: toWidth + 'px', height: toHeight + 'px'}
    ], {duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards'});
    _dgaAddModalResizeAnim = anim;

    anim.finished.then(() => {
        anim.cancel();
        if (_dgaAddModalResizeAnim === anim) _dgaAddModalResizeAnim = null;
        box.style.overflow = '';
        box.style.minWidth = '';
        box.style.maxWidth = '';
        box.style.maxHeight = '';
    }).catch(() => {});
}

function dgaBackToSearch() {
    if (document.getElementById('dga-add-step-confirm').classList.contains('hidden')) return;
    dgaAnimateAddModalResize(() => {
        document.getElementById('dga-add-step-confirm').classList.add('hidden');
        document.getElementById('dga-add-step-search').classList.remove('hidden');
        document.getElementById('dga-add-back-btn').classList.add('hidden');
        document.querySelector('#dga-add-modal .inv-modal-wide').classList.remove('inv-modal-foil-step');
    });
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
                tile.className = 'inv-search-tile';
                tile.style.animationDelay = `${Math.min(i, 20) * 30}ms`;
                tile.innerHTML = `
                    <div class="edition-tile-wrap">
                        <img src="/images/${card.edition_id}.jpg" alt="${card.name}">
                        <div class="card-tile-dim"></div>
                        <div class="inv-search-tile-add">+</div>
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

    dgaAnimateAddModalResize(() => {
        document.getElementById('dga-add-step-search').classList.add('hidden');
        document.getElementById('dga-add-step-confirm').classList.remove('hidden');
        document.getElementById('dga-add-back-btn').classList.remove('hidden');
        document.querySelector('#dga-add-modal .inv-modal-wide').classList.add('inv-modal-foil-step');
    });
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
    const btn = document.getElementById('dga-add-modal-submit');
    btn.disabled = true;
    btn.textContent = 'Adding...';

    try {
        const res = await fetch(`/api/decks/${encodeURIComponent(activeDeck)}/card`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({card_id: dgaAddModalCardId, section, quantity})
        });

        if (res.ok) {
            // Reset button before closing
            btn.disabled = false;
            btn.textContent = 'Add to Deck';

            // Update local state
            if (activeDeckData?.sections?.[section] !== undefined) {
                const existing = activeDeckData.sections[section][dgaAddModalCardId] || 0;
                activeDeckData.sections[section][dgaAddModalCardId] = existing + quantity;
                // Update edition map for display
                if (dgaAddModalEditionId && !activeDeckData.edition_map[dgaAddModalCardId])
                    activeDeckData.edition_map[dgaAddModalCardId] = dgaAddModalEditionId;
                if (dgaAddModalCardName && !activeDeckData.name_map[dgaAddModalCardId])
                    activeDeckData.name_map[dgaAddModalCardId] = dgaAddModalCardName;
            }

            closeDeckAddModal();
            renderDeckSections(activeDeckData);

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


window.initDecksGa = async function () {
    if (!currentUser) return;
    await loadMyDecks();

    const urlParams = new URLSearchParams(window.location.search);
    const deckName = urlParams.get('deck');
    if (deckName && gaDecks[deckName]) {
        await openDeckDetail(deckName, false);
    }
};
let autocompleteIndex = -1;
let selectedCardId = null;
let selectedSets = new Set();

// ── Inventory snapshot: default bin's cards ──
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

function snapQty(cardId, editionId) {
    const m = invSnapshot[cardId]?.[editionId];
    if (!m) return 0;
    return Object.values(m).reduce((s, q) => s + q, 0);
}

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

function attachInvOverlay(tile, card) {
    if (!currentUser) return;

    const qty = snapQty(card.card_id, card.edition_id);

    // Dim layer lives inside edition-tile-wrap so it scales with the image
    const wrap = tile.querySelector('.edition-tile-wrap');
    if (wrap) {
        const dim = document.createElement('div');
        dim.className = 'card-tile-dim';
        wrap.appendChild(dim);
    }

    // qty badge
    const badge = document.createElement('span');
    badge.className = 'inv-qty-badge';
    badge.style.display = qty > 0 ? '' : 'none';
    badge.textContent = `x${qty}`;
    tile.appendChild(badge);

    // name/foil overlay — anchored to tile root, not the wrap
    const overlay = document.createElement('div');
    overlay.className = 'inv-card-tile-overlay';
    overlay.innerHTML = `
        <div class="inv-card-tile-info">
            <div class="inv-card-tile-name">${card.name}</div>
            <div class="inv-card-tile-foil" data-foil-label="${card.card_id}-${card.edition_id}">—</div>
        </div>`;
    tile.appendChild(overlay);

    // +/input/− controls — also anchored to tile root
    const ctrl = document.createElement('div');
    ctrl.className = 'inv-card-tile-qty-ctrl';
    ctrl.innerHTML = `
        <button class="inv-tile-qty-btn inv-tile-qty-add" type="button">+</button>
        <input class="inv-tile-qty-input" type="number" value="${qty}" min="0" max="999"
            data-card-id="${card.card_id}"
            data-edition-id="${card.edition_id}">
        <button class="inv-tile-qty-btn inv-tile-qty-sub" type="button">−</button>`;
    tile.appendChild(ctrl);

    let foilId = null;
    let foilResolved = false;

    async function resolveFoil() {
        if (foilResolved) return foilId;
        foilResolved = true;
        try {
            const res = await fetch(`/api/cards/${card.card_id}`);
            const data = await res.json();
            const editionInfo = data.card?.editions?.[card.edition_id];
            if (editionInfo?.foils) {
                foilId = pickDefaultFoil(editionInfo.foils);
                const foilInfo = editionInfo.foils[foilId];
                const label = foilInfo?.kind
                    ? foilInfo.kind.charAt(0).toUpperCase() + foilInfo.kind.slice(1)
                    : '—';
                const el = tile.querySelector(`[data-foil-label="${card.card_id}-${card.edition_id}"]`);
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
        await commitQty(newQty, fid);
    }

    async function commitQty(newQty, fid) {
        if (!fid) return;
        const binName = await getDefaultBinName();
        if (!binName) return;
        try {
            if (newQty <= 0) {
                if (invSnapshot[card.card_id]?.[card.edition_id]?.[fid]) {
                    await fetch('/api/inventory/card', {
                        method: 'DELETE',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            bin: binName,
                            card_id: card.card_id,
                            edition_id: card.edition_id,
                            foil_id: fid
                        })
                    });
                    delete invSnapshot[card.card_id]?.[card.edition_id]?.[fid];
                }
            } else if (invSnapshot[card.card_id]?.[card.edition_id]?.[fid] !== undefined) {
                await fetch('/api/inventory/card', {
                    method: 'PATCH',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        bin: binName,
                        card_id: card.card_id,
                        edition_id: card.edition_id,
                        foil_id: fid,
                        quantity: newQty
                    })
                });
            } else {
                await fetch('/api/inventory/card', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        bin: binName,
                        card_id: card.card_id,
                        edition_id: card.edition_id,
                        foil_id: fid,
                        quantity: newQty
                    })
                });
            }
            if (!invSnapshot[card.card_id]) invSnapshot[card.card_id] = {};
            if (!invSnapshot[card.card_id][card.edition_id]) invSnapshot[card.card_id][card.edition_id] = {};
            invSnapshot[card.card_id][card.edition_id][fid] = newQty;
            const b = tile.querySelector('.inv-qty-badge');
            if (b) {
                b.textContent = `x${newQty}`;
                b.style.display = newQty > 0 ? '' : 'none';
            }
        } catch { /* silent */
        }
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
    input.addEventListener('change', async () => {
        const fid = await resolveFoil();
        const val = Math.max(0, parseInt(input.value) || 0);
        input.value = val;
        await commitQty(val, fid);
    });
    input.addEventListener('focus', () => input.select());
}

const rarityMap = {
    1: "C", 2: "U", 3: "R", 4: "SR",
    5: "UR", 6: "PR", 7: "CSR", 8: "CUR", 9: "CPR"
};

function toggleSetDropdown() {
    const menu = document.getElementById('set-dropdown-menu');
    const btn = document.querySelector('.set-dropdown-btn');
    menu.classList.toggle('hidden');
    btn.classList.toggle('open');
}

function toggleSetOption(set) {
    if (selectedSets.has(set)) {
        selectedSets.delete(set);
    } else {
        selectedSets.add(set);
    }
    updateSetDropdownLabel();
    renderSetOptions();
}

function updateSetDropdownLabel() {
    const label = document.getElementById('set-dropdown-label');
    if (selectedSets.size === 0) {
        label.textContent = 'Sets';
    } else if (selectedSets.size === 1) {
        label.textContent = [...selectedSets][0];
    } else {
        label.textContent = `${selectedSets.size} Sets`;
    }
}

function renderSetOptions() {
    const container = document.getElementById('set-dropdown-options');
    if (!container) return;
    const allSets = container.dataset.sets ? JSON.parse(container.dataset.sets) : [];
    container.innerHTML = '';
    for (const set of allSets) {
        const isSelected = selectedSets.has(set);
        const option = document.createElement('div');
        option.className = `set-dropdown-option${isSelected ? ' selected' : ''}`;
        option.innerHTML = `
            <span>${set}</span>
            <div class="set-toggle"></div>
        `;
        option.onclick = (e) => {
            e.stopPropagation();
            toggleSetOption(set);
        };
        container.appendChild(option);
    }
}

async function loadSets() {
    const container = document.getElementById('set-dropdown-options');
    if (!container) return;
    try {
        const res = await fetch('/api/sets');
        const data = await res.json();
        container.dataset.sets = JSON.stringify(data.sets);
        renderSetOptions();
    } catch {
        console.error('Failed to load sets');
    }
}

function buildCardTile(card, index) {
    const rarity = rarityMap[card.rarity] || "";
    const rarityClass = `rarity-${rarity.toLowerCase()}`;

    const tile = document.createElement('div');
    tile.className = currentUser ? 'card-tile card-tile--authed' : 'card-tile card-tile--guest';
    tile.style.animationDelay = `${index * 60}ms`;
    tile.dataset.cardId = card.card_id;
    tile.innerHTML = `
        <div class="edition-tile-wrap">
            <img src="/images/${card.edition_id}.jpg" alt="${card.name}"
                onerror="this.parentElement.parentElement.innerHTML='<div class=card-tile-missing>${card.name}</div>'">
            ${rarity ? `<span class="edition-rarity-badge ${rarityClass}">${rarity}</span>` : ''}
        </div>
    `;
    tile.onclick = () => openCardDrawer(card.card_id, card.edition_id, card.name);
    tile.addEventListener('animationend', () => {
        tile.classList.add('animated');
    });

    attachInvOverlay(tile, card);

    return tile;
}

async function searchCards() {
    const query = document.getElementById('card-search').value.trim();
    const results = document.getElementById('card-results');

    if (!query && selectedSets.size === 0) return;

    results.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Searching...</p>';

    _defaultBinName = null;
    await loadInvSnapshot();

    // ── Set search ──
    if (query.startsWith('$')) {
        const setPrefix = query.slice(1).trim();
        if (!setPrefix) {
            results.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Enter a set prefix after $.</p>';
            return;
        }
        try {
            const res = await fetch(`/api/sets/search?prefix=${encodeURIComponent(setPrefix)}`);
            const data = await res.json();
            await loadSets();
            if (!data.cards.length) {
                results.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;">No cards found for set '${setPrefix}'.</p>`;
                return;
            }
            results.innerHTML = '';
            for (let i = 0; i < data.cards.length; i++) {
                results.appendChild(buildCardTile(data.cards[i], i));
            }
        } catch {
            results.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Set search failed.</p>';
        }
        return;
    }

    // ── Regular search ──
    try {
        const params = new URLSearchParams();
        if (query) params.append('q', query);
        for (const set of selectedSets) {
            params.append('set', set);
        }
        const res = await fetch(`/api/cards/search?${params}`);
        const data = await res.json();
        await loadSets();
        if (data.message) {
            results.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;">${data.message}</p>`;
            return;
        }
        results.innerHTML = '';
        if (data.fuzzy) {
            results.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;padding:0 0 16px 0;">No exact match found. Did you mean one of these?</p>`;
        }
        for (let i = 0; i < data.cards.length; i++) {
            results.appendChild(buildCardTile(data.cards[i], i));
        }
    } catch {
        results.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Search failed.</p>';
    }
}

async function fetchSuggestions(value) {
    const list = document.getElementById('autocomplete-list');
    if (value.length < 2) {
        hideAutocomplete();
        return;
    }
    try {
        const res = await fetch(`/api/cards/suggest?q=${encodeURIComponent(value)}`);
        const data = await res.json();
        if (!data.suggestions.length) {
            hideAutocomplete();
            return;
        }
        autocompleteIndex = -1;
        list.innerHTML = '';
        for (const name of data.suggestions) {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.textContent = name;
            item.onclick = () => {
                document.getElementById('card-search').value = name;
                hideAutocomplete();
                searchCards();
            };
            list.appendChild(item);
        }
        list.classList.remove('hidden');
    } catch {
        hideAutocomplete();
    }
}

function hideAutocomplete() {
    const list = document.getElementById('autocomplete-list');
    if (list) {
        list.classList.add('hidden');
        list.innerHTML = '';
    }
    autocompleteIndex = -1;
}

function handleCardKeydown(e) {
    const list = document.getElementById('autocomplete-list');
    const items = list ? list.querySelectorAll('.autocomplete-item') : [];
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        autocompleteIndex = Math.min(autocompleteIndex + 1, items.length - 1);
        items.forEach((item, i) => item.classList.toggle('selected', i === autocompleteIndex));
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        autocompleteIndex = Math.max(autocompleteIndex - 1, -1);
        items.forEach((item, i) => item.classList.toggle('selected', i === autocompleteIndex));
    } else if (e.key === 'Enter') {
        if (autocompleteIndex >= 0 && items[autocompleteIndex]) {
            document.getElementById('card-search').value = items[autocompleteIndex].textContent;
            hideAutocomplete();
            searchCards();
        } else {
            hideAutocomplete();
            searchCards();
        }
    } else if (e.key === 'Escape') {
        hideAutocomplete();
    }
}

document.addEventListener('click', e => {
    if (!e.target.closest('.autocomplete-wrap')) hideAutocomplete();
    if (!e.target.closest('.set-dropdown-wrap')) {
        const menu = document.getElementById('set-dropdown-menu');
        const btn = document.querySelector('.set-dropdown-btn');
        if (menu) menu.classList.add('hidden');
        if (btn) btn.classList.remove('open');
    }
});
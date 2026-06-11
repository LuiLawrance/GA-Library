// ── Default bin picker ──
let cardSearchDefaultBin = null;   // name of the currently selected default bin
let allBinsCache = null;           // { binName: { default, ... } }

async function initDefaultBinPicker() {
    if (!currentUser) return;
    try {
        const res = await fetch('/api/inventory');
        if (!res.ok) return;
        const data = await res.json();
        allBinsCache = data.bins || {};
        // Find the bin marked default
        cardSearchDefaultBin = Object.entries(allBinsCache).find(([, b]) => b.default)?.[0] ?? null;
        updateDefaultBinLabel();
    } catch { /* silent */
    }
}

function updateDefaultBinLabel() {
    const label = document.getElementById('default-bin-label');
    if (label) label.textContent = cardSearchDefaultBin ?? 'Default Bin';
}

function openDefaultBinPicker() {
    const menu = document.getElementById('default-bin-menu');
    if (!menu) return;

    if (!menu.classList.contains('hidden')) {
        menu.classList.add('hidden');
        return;
    }

    if (!allBinsCache) {
        initDefaultBinPicker();
        return;
    }

    menu.innerHTML = '';
    Object.keys(allBinsCache).forEach(name => {
        const item = document.createElement('div');
        item.className = 'default-bin-menu-item' + (name === cardSearchDefaultBin ? ' active' : '');
        item.innerHTML = `<span>${name}</span><span class="default-bin-check">✓</span>`;
        item.onclick = () => selectDefaultBin(name);
        menu.appendChild(item);
    });

    menu.classList.remove('hidden');
}

async function selectDefaultBin(name) {
    const menu = document.getElementById('default-bin-menu');
    if (menu) menu.classList.add('hidden');

    if (name === cardSearchDefaultBin) return;

    try {
        await fetch(`/api/inventory/bins/${encodeURIComponent(name)}/default`, {method: 'POST'});
        cardSearchDefaultBin = name;
        _defaultBinName = null;
        // Reload snapshot for the new default bin
        await loadInvSnapshot();
        updateDefaultBinLabel();
        // Refresh all badges and input values currently in the results grid
        refreshResultsBadges();
    } catch { /* silent */
    }
}

function refreshResultsBadges() {
    const grid = document.getElementById('card-results');
    if (!grid) return;
    grid.querySelectorAll('.card-tile').forEach(tile => {
        const cardId = tile.dataset.cardId;
        const input = tile.querySelector('.inv-tile-qty-input');
        if (!input) return;
        const editionId = input.dataset.editionId;
        const qty = snapQty(cardId, editionId);
        // Update input value
        input.value = qty;
        // Update badge
        const badge = tile.querySelector('.inv-qty-badge');
        if (badge) {
            badge.textContent = `x${qty}`;
            badge.style.display = qty > 0 ? '' : 'none';
        }
    });
}

let autocompleteIndex = -1;
let selectedCardId = null;
let selectedSets = new Set();

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
    tile.addEventListener('animationend', () => tile.classList.add('animated'));

    // tiles.js — attach inventory overlay for logged-in users
    attachInvOverlay(tile, card.card_id, card.edition_id, card.name);

    return tile;
}

async function searchCards() {
    const query = document.getElementById('card-search').value.trim();
    const results = document.getElementById('card-results');

    if (!query && selectedSets.size === 0) return;

    results.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Searching...</p>';

    // Refresh snapshot and bin name cache on each new search
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
        for (const set of selectedSets) params.append('set', set);

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
    if (!e.target.closest('.default-bin-wrap')) {
        document.getElementById('default-bin-menu')?.classList.add('hidden');
    }
});
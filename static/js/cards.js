let autocompleteIndex = -1;
let selectedCardId = null;
let selectedSets = new Set();

function parseEffect(text, cardName) {
    if (!text) return '';

    return text
        .replace(/CARDNAME/g, `<strong>${cardName}</strong>`)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\[(.+?)\]/g, '<span class="effect-tag">$1</span>')
        .replace(/\((\d+)\)/g, '<span class="effect-number">$1</span>')
        .replace(/\n/g, '<br>');
}

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

async function searchCards() {
    const query = document.getElementById('card-search').value.trim();
    const results = document.getElementById('card-results');

    if (!query && selectedSets.size === 0) return;

    results.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Searching...</p>';

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
                const card = data.cards[i];
                const tile = document.createElement('div');
                tile.className = 'card-tile';
                tile.style.animationDelay = `${i * 60}ms`;
                tile.dataset.cardId = card.card_id;
                tile.innerHTML = `<img src="/images/${card.edition_id}.jpg" alt="${card.name}" onerror="this.parentElement.innerHTML='<div class=card-tile-missing>${card.name}</div>'">`;
                tile.onclick = () => openCardDrawer(card.card_id, card.edition_id, card.name);
                tile.addEventListener('animationend', () => {
                    tile.classList.add('animated');
                });
                results.appendChild(tile);
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
            const card = data.cards[i];
            const tile = document.createElement('div');
            tile.className = 'card-tile';
            tile.style.animationDelay = `${i * 60}ms`;
            tile.dataset.cardId = card.card_id;
            tile.innerHTML = `<img src="/images/${card.edition_id}.jpg" alt="${card.name}" onerror="this.parentElement.innerHTML='<div class=card-tile-missing>${card.name}</div>'">`;
            tile.onclick = () => openCardDrawer(card.card_id, card.edition_id, card.name);
            tile.addEventListener('animationend', () => {
                tile.classList.add('animated');
            });
            results.appendChild(tile);
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

async function openCardDrawer(cardId, editionId, cardName) {
    const drawer = document.getElementById('card-drawer');
    const wrap = document.querySelector('.card-grid-wrap');

    if (selectedCardId === cardId) {
        const currentTile = document.querySelector('.drawer-edition-tile img.edition-selected');
        if (currentTile && currentTile.id === `edition-tile-${editionId}`) {
            closeCardDrawer();
            return;
        }
        selectDrawerEdition(editionId);
        return;
    }

    selectedCardId = cardId;

    try {
        const res = await fetch(`/api/cards/${cardId}`);
        const data = await res.json();
        const card = data.card;

        const editions = Object.entries(card.editions);
        const selectedEdition = card.editions[editionId];

        const statsMap = {
            'Cost (Memory)': card.stats?.cost_memory,
            'Cost (Reserve)': card.stats?.cost_reserve,
            'Power': card.stats?.power,
            'Life': card.stats?.life,
            'Durability': card.stats?.durability,
            'Speed': card.stats?.speed,
            'Level': card.stats?.level,
        };

        const statsHTML = Object.entries(statsMap)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([label, value]) => `
                <div class="drawer-stat">
                    <span class="drawer-stat-label">${label}</span>
                    <span class="drawer-stat-value">${value}</span>
                </div>
            `).join('');

        const legalityHTML = Object.entries(card.legality || {})
            .map(([format, legal]) => `
                <span class="drawer-legal-tag ${legal ? 'legal' : 'illegal'}">
                    ${format}
                </span>
            `).join('');

        const editionsHTML = editions.map(([eid, einfo], i) => `
            <div class="drawer-edition-tile" style="animation-delay: ${i * 60}ms">
                <img src="/images/${eid}.jpg" alt="${einfo.set_name}"
                    title="${einfo.set_name} (${einfo.set_prefix})"
                    onclick="event.stopPropagation(); selectDrawerEdition('${eid}')"
                    id="edition-tile-${eid}">
            </div>
        `).join('');

        const drawerContent = document.getElementById('drawer-content');

        drawer.dataset.editions = JSON.stringify(Object.fromEntries(editions));

        const inner = document.createElement('div');
        inner.className = 'drawer-content-animate';
        inner.innerHTML = `
            <div class="drawer-top">
                <img class="drawer-card-image" src="/images/${editionId}.jpg" alt="${cardId}">
                <div class="drawer-card-info">
                    <div>
                        <div class="drawer-name-row">
                            <div>
                                <div class="drawer-name">${cardName}</div>
                                <div class="drawer-set">${selectedEdition?.set_name || ''} (${selectedEdition?.set_prefix || ''}) &mdash; #${selectedEdition?.collector_number || '?'}</div>
                            </div>
                            ${card.element ? `<img class="drawer-element" src="/elements/${card.element}.png" alt="${card.element}">` : ''}
                        </div>
                    </div>

                    <div>
                        <div class="drawer-section-label">Types</div>
                        <div class="drawer-types">
                            ${(card.types || []).map(t => `<span class="drawer-type-tag">${t}</span>`).join('')}
                        </div>
                    </div>

                    ${statsHTML ? `
                    <div>
                        <div class="drawer-section-label">Stats</div>
                        <div class="drawer-stats">${statsHTML}</div>
                    </div>` : ''}

                    ${card.effect ? `
                    <div>
                        <div class="drawer-section-label">Effect</div>
                        <div class="drawer-effect">${parseEffect(card.effect, cardName)}</div>
                    </div>` : ''}

                    ${legalityHTML ? `
                    <div>
                        <div class="drawer-section-label">Legality</div>
                        <div class="drawer-legality">${legalityHTML}</div>
                    </div>` : ''}
                </div>
            </div>

            <div class="drawer-editions-section">
                <div class="drawer-section-label">Editions</div>
                <div class="drawer-editions">${editionsHTML}</div>
            </div>
        `;

        drawerContent.innerHTML = '';
        drawerContent.appendChild(inner);

        drawer.classList.remove('hidden');
        setTimeout(() => {
            drawer.classList.add('open');
            wrap.classList.add('drawer-open');
            document.getElementById('drawer-close-btn').classList.remove('hidden');

            const initialTile = document.getElementById(`edition-tile-${editionId}`);
            if (initialTile) initialTile.classList.add('edition-selected');
        }, 10);

    } catch {
        console.error('Failed to load card details');
    }
}

function closeCardDrawer() {
    const drawer = document.getElementById('card-drawer');
    const wrap = document.querySelector('.card-grid-wrap');

    drawer.classList.remove('open');
    wrap.classList.remove('drawer-open');
    document.getElementById('drawer-close-btn').classList.add('hidden');
    selectedCardId = null;

    setTimeout(() => {
        drawer.classList.add('hidden');
    }, 300);
}

function selectDrawerEdition(editionId) {
    const mainImage = document.querySelector('.drawer-card-image');
    const currentTile = document.querySelector('.drawer-edition-tile img.edition-selected');

    if (currentTile && currentTile.id === `edition-tile-${editionId}`) {
        return;
    }

    mainImage.classList.add('switching');

    setTimeout(() => {
        mainImage.src = `/images/${editionId}.jpg`;
        mainImage.classList.remove('switching');
    }, 200);

    const drawer = document.getElementById('card-drawer');
    const editions = JSON.parse(drawer.dataset.editions || '{}');
    const edition = editions[editionId];

    if (edition) {
        const setEl = document.querySelector('.drawer-set');
        if (setEl) {
            setEl.textContent = `${edition.set_name} (${edition.set_prefix}) — #${edition.collector_number || '?'}`;
        }
    }

    const cardInfo = document.querySelector('.drawer-card-info');
    if (cardInfo) {
        cardInfo.classList.remove('drawer-info-animate');
        void cardInfo.offsetWidth;
        cardInfo.classList.add('drawer-info-animate');
    }

    document.querySelectorAll('.drawer-edition-tile img').forEach(img => {
        img.classList.remove('edition-selected');
    });

    document.getElementById(`edition-tile-${editionId}`).classList.add('edition-selected');
}

document.addEventListener('click', e => {
    if (!e.target.closest('.autocomplete-wrap')) {
        hideAutocomplete();
    }

    if (!e.target.closest('.set-dropdown-wrap')) {
        const menu = document.getElementById('set-dropdown-menu');
        const btn = document.querySelector('.set-dropdown-btn');
        if (menu) menu.classList.add('hidden');
        if (btn) btn.classList.remove('open');
    }
});
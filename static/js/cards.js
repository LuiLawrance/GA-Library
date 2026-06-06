let autocompleteIndex = -1;
let selectedCardId = null;

async function searchCards() {
    const query = document.getElementById('card-search').value.trim();
    const results = document.getElementById('card-results');

    if (!query) return;

    results.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Searching...</p>';

    try {
        const res = await fetch(`/api/cards/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();

        if (data.message) {
            results.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;">${data.message}</p>`;
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
            tile.onclick = () => openCardDrawer(card.card_id, card.edition_id);
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

async function openCardDrawer(cardId, editionId) {
    const drawer = document.getElementById('card-drawer');
    const wrap = document.querySelector('.card-grid-wrap');

    if (selectedCardId === cardId) {
        closeCardDrawer();
        return;
    }

    selectedCardId = cardId;

    try {
        const res = await fetch(`/api/cards/${cardId}`);
        const data = await res.json();
        const card = data.card;

        const editions = Object.entries(card.editions);

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

        document.getElementById('drawer-content').innerHTML = `
            <div class="drawer-top">
                <img class="drawer-card-image" src="/images/${editionId}.jpg" alt="${cardId}">
                <div class="drawer-card-info">
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
                        <div class="drawer-effect">${card.effect}</div>
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

        drawer.classList.remove('hidden');
        setTimeout(() => {
            drawer.classList.add('open');
            wrap.classList.add('drawer-open');
            wrap.style.pointerEvents = 'none';

            const initialTile = document.getElementById(`edition-tile-${editionId}`);
            if (initialTile) initialTile.classList.add('edition-selected');

            setTimeout(() => {
                wrap.style.pointerEvents = '';
            }, 260);
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
    wrap.style.pointerEvents = 'none';
    selectedCardId = null;

    setTimeout(() => {
        drawer.classList.add('hidden');
        wrap.style.pointerEvents = '';
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

    document.querySelectorAll('.drawer-edition-tile img').forEach(img => {
        img.classList.remove('edition-selected');
    });

    document.getElementById(`edition-tile-${editionId}`).classList.add('edition-selected');
}

document.addEventListener('click', e => {
    if (!e.target.closest('.autocomplete-wrap')) {
        hideAutocomplete();
    }
});
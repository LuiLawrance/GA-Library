let autocompleteIndex = -1;

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
            tile.innerHTML = `<img src="/images/${card.edition_id}.jpg" alt="${card.name}" onerror="this.parentElement.innerHTML='<div class=card-tile-missing>${card.name}</div>'">`;
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

document.addEventListener('click', e => {
    if (!e.target.closest('.autocomplete-wrap')) {
        hideAutocomplete();
    }
});
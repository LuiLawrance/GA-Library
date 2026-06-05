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
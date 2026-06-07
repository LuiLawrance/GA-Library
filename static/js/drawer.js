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

async function openCardDrawer(cardId, editionId, cardName) {
    const drawer = document.getElementById('card-drawer');

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

        const editions = Object.entries(card.editions).sort((a, b) => {
            const numA = a[1].collector_number || 'ZZZ';
            const numB = b[1].collector_number || 'ZZZ';

            const parseNum = str => {
                const match = str.match(/^(\d+)([A-Z]*)$/i);
                if (match) return [parseInt(match[1]), match[2] || ''];
                return [Infinity, str];
            };

            const [nA, sA] = parseNum(numA);
            const [nB, sB] = parseNum(numB);

            if (nA !== nB) return nA - nB;
            return sA.localeCompare(sB);
        });

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

    drawer.classList.remove('open');
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
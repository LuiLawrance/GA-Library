let drawerIsOpen = false;
let drawerCardData = null;
let drawerActiveTab = 'info';

function parseEffect(text, cardName) {
    if (!text) return '';

    return text
        .replace(/CARDNAME/g, `<strong>${cardName}</strong>`)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\[REST\]/g, '<span class="effect-tag">↷</span>')
        .replace(/\[(.+?)\]/g, '<span class="effect-tag">$1</span>')
        .replace(/\((\d+)\)/g, '<span class="effect-number">$1</span>')
        .replace(/\n/g, '<br>');
}

const THEMA_CATEGORIES = ['charm', 'ferocity', 'grace', 'mystique', 'valor'];

function buildCollectorHTML(foils) {
    if (!foils || Object.keys(foils).length === 0) {
        return `<div class="thema-empty">No population data available for this edition.</div>`;
    }

    // Separate nonfoil, base foil, and special foils
    const entries = Object.values(foils);
    const nonfoilEntry = entries.find(f => f.kind?.toLowerCase() === 'nonfoil');
    const foilEntry = entries.find(f => f.kind?.toLowerCase() === 'foil');
    const specials = entries.filter(f => {
        const k = f.kind?.toLowerCase();
        return k !== 'nonfoil' && k !== 'foil';
    });

    // Max population across top-level foil types for bar scaling
    const topPops = [nonfoilEntry, foilEntry, ...specials]
        .filter(Boolean)
        .map(f => f.population ?? 0);
    const maxPop = Math.max(...topPops, 1);

    function printingBadge(printing) {
        if (printing == null) return '';
        return printing
            ? `<span class="collector-badge collector-badge--printing">Printing</span>`
            : `<span class="collector-badge collector-badge--oop">Out of Print</span>`;
    }

    function foilRow(foilObj, label, isVariant = false, parentPop = null) {
        const pop = foilObj.population ?? null;
        const pct = pop != null ? Math.round((pop / maxPop) * 100) : 0;
        const parentPct = (isVariant && parentPop && pop != null)
            ? Math.round((pop / parentPop) * 100)
            : null;

        return `
            <div class="collector-row${isVariant ? ' collector-row--variant' : ''}">
                <div class="collector-kind">${label}</div>
                <div class="collector-bar-wrap">
                    <div class="collector-bar${isVariant ? ' collector-bar--variant' : ''}" style="width: ${pct}%"></div>
                </div>
                <div class="collector-meta">
                    ${pop != null ? `<span class="collector-pop">${pop.toLocaleString()}</span>` : '<span class="collector-pop collector-pop--unknown">—</span>'}
                    ${parentPct != null ? `<span class="collector-pct">${parentPct}%</span>` : ''}
                    ${printingBadge(foilObj.printing)}
                </div>
            </div>`;
    }

    function foilBlock(foilObj, label) {
        if (!foilObj) return '';
        const variants = Object.values(foilObj.variants || {});
        const variantPop = variants.reduce((s, v) => s + (v.population ?? 0), 0);
        const basePop = (foilObj.population ?? 0) - variantPop;

        // If there are variants, show the base remainder as a sub-row
        let variantHTML = '';
        if (variants.length > 0) {
            if (basePop > 0) {
                variantHTML += foilRow(
                    {population: basePop, printing: foilObj.printing},
                    `Standard ${toFoilLabel(foilObj.kind)}`,
                    true,
                    foilObj.population
                );
            }
            variants.forEach(v => {
                variantHTML += foilRow(v, toFoilLabel(v.kind), true, foilObj.population);
            });
        }

        return foilRow(foilObj, label) + variantHTML;
    }

    const rows = [
        foilBlock(nonfoilEntry, 'Non-Foil'),
        foilBlock(foilEntry, 'Foil'),
        ...specials.map(f => foilBlock(f, toFoilLabel(f.kind)))
    ].join('');

    return `
        <div class="collector-section">
            <div class="collector-section-label">Population</div>
            ${rows}
        </div>`;
}

function buildThemaHTML(thema) {
    const hasNonfoil = thema?.nonfoil && Object.keys(thema.nonfoil).length > 0;
    const hasFoil = thema?.foil && Object.keys(thema.foil).length > 0;

    if (!hasNonfoil && !hasFoil) {
        return `<div class="thema-empty">No thema data available for this edition.</div>`;
    }

    // Collect all score values to determine the scale max
    const allValues = [];
    if (hasNonfoil) THEMA_CATEGORIES.forEach(c => {
        if (thema.nonfoil[c] != null) allValues.push(thema.nonfoil[c]);
    });
    if (hasFoil) THEMA_CATEGORIES.forEach(c => {
        if (thema.foil[c] != null) allValues.push(thema.foil[c]);
    });
    const maxVal = Math.max(...allValues, 1);

    const columns = [];
    if (hasNonfoil) columns.push({
        key: 'nonfoil',
        label: 'Non-Foil',
        data: thema.nonfoil,
        isDynamic: thema.nonfoil.dynamic
    });
    if (hasFoil) columns.push({key: 'foil', label: 'Foil', data: thema.foil, isDynamic: thema.foil.dynamic});

    const colsHTML = columns.map(col => {
        const barsHTML = THEMA_CATEGORIES.map(cat => {
            const val = col.data[cat] ?? null;
            const pct = val != null ? Math.round((val / maxVal) * 100) : 0;
            return `
                <div class="thema-row">
                    <div class="thema-cat">${cat}</div>
                    <div class="thema-bar-wrap">
                        <div class="thema-bar" style="width: ${pct}%"></div>
                    </div>
                    <div class="thema-val">${val ?? '—'}</div>
                </div>`;
        }).join('');

        const dynamicBadge = col.isDynamic
            ? `<span class="thema-dynamic-badge">Dynamic</span>`
            : '';

        return `
            <div class="thema-col">
                <div class="thema-col-header">
                    <span class="thema-col-label">${col.label}</span>
                    ${dynamicBadge}
                </div>
                ${barsHTML}
            </div>`;
    }).join('');

    return `<div class="thema-grid${columns.length === 1 ? ' thema-grid--single' : ''}">${colsHTML}</div>`;
}

function buildTabThemaPanel(edition) {
    const foils = edition?.foils || {};
    const thema = edition?.thema || {};
    return buildCollectorHTML(foils)
        + `<div class="collector-thema-divider"></div>`
        + `<div class="collector-section-label">Thema</div>`
        + buildThemaHTML(thema);
}

function switchDrawerTab(tab, drawerId = 'card-drawer') {
    if (drawerId === 'card-drawer') {
        drawerActiveTab = tab;
    } else {
        invDrawerActiveTab = tab;
    }
    const drawer = document.getElementById(drawerId);
    if (!drawer) return;

    // Update the external floating sidebar
    const sidebarId = drawerId === 'card-drawer' ? 'drawer-sidebar' : 'inv-drawer-sidebar';
    const sidebar = document.getElementById(sidebarId);
    if (sidebar) {
        sidebar.querySelectorAll('.drawer-sidebar-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
    }

    const cardInfo = drawer.querySelector('.drawer-card-info');
    if (!cardInfo) return;

    const infoPanel = cardInfo.querySelector('.drawer-tab-info');
    const themaPanel = cardInfo.querySelector('.drawer-tab-thema');
    if (!infoPanel || !themaPanel) return;

    if (tab === 'info') {
        infoPanel.classList.remove('hidden');
        themaPanel.classList.add('hidden');
    } else {
        infoPanel.classList.add('hidden');
        themaPanel.classList.remove('hidden');

        const currentEditionId = drawer.dataset.selectedEdition;
        const editions = JSON.parse(drawer.dataset.editions || '{}');
        themaPanel.innerHTML = buildTabThemaPanel(editions[currentEditionId]);
    }
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
            'Speed': card.stats?.speed === true ? 'Fast' : card.stats?.speed === false ? 'Slow' : null,
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

        const rarityMap = {
            1: "C", 2: "U", 3: "R", 4: "SR",
            5: "UR", 6: "PR", 7: "CSR", 8: "CUR", 9: "CPR"
        };

        const editionsHTML = editions.map(([eid, einfo], i) => {
            const rarity = rarityMap[einfo.rarity] || "?";
            const rarityClass = `rarity-${rarity.toLowerCase()}`;

            return `
            <div class="drawer-edition-tile" style="animation-delay: ${i * 60}ms">
                <div class="edition-tile-wrap">
                    <img src="/images/${eid}.jpg" alt="${einfo.set_name}"
                        title="${einfo.set_name} (${einfo.set_prefix})"
                        onclick="event.stopPropagation(); selectDrawerEdition('${eid}')"
                        id="edition-tile-${eid}">
                    <span class="edition-prefix-badge">${einfo.set_prefix}</span>
                    <span class="edition-rarity-badge ${rarityClass}">${rarity}</span>
                </div>
            </div>
        `
        }).join('');

        const drawerContent = document.getElementById('drawer-content');

        drawer.dataset.editions = JSON.stringify(Object.fromEntries(editions));
        drawer.dataset.selectedEdition = editionId;

        const inner = document.createElement('div');
        inner.className = 'drawer-content-animate';
        inner.innerHTML = `
            <div class="drawer-top">
                <img class="drawer-card-image" src="/images/${editionId}.jpg" alt="${cardId}">
                <div class="drawer-card-info">
                    <div class="drawer-name-row">
                        <div>
                            <div class="drawer-name">${cardName}</div>
                            <div class="drawer-set">${selectedEdition?.set_name || ''} (${selectedEdition?.set_prefix || ''}) &mdash; #${selectedEdition?.collector_number || '?'}</div>
                        </div>
                        ${card.element ? `<img class="drawer-element" src="/elements/${card.element}.png" alt="${card.element}">` : ''}
                    </div>

                    <div class="drawer-tab-info">
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

                    <div class="drawer-tab-thema hidden"></div>
                </div>
            </div>

            <div class="drawer-editions-section">
                <div class="drawer-section-label">Editions</div>
                <div class="drawer-editions">${editionsHTML}</div>
            </div>
        `;

        drawerContent.innerHTML = '';
        drawerContent.appendChild(inner);

        // Apply active tab to the newly rendered panels
        const cardInfo = drawer.querySelector('.drawer-card-info');
        if (cardInfo && drawerIsOpen) {
            const infoPanel = cardInfo.querySelector('.drawer-tab-info');
            const themaPanel = cardInfo.querySelector('.drawer-tab-thema');
            if (drawerActiveTab === 'thema') {
                infoPanel.classList.add('hidden');
                themaPanel.classList.remove('hidden');
                const editions = JSON.parse(drawer.dataset.editions || '{}');
                themaPanel.innerHTML = buildTabThemaPanel(editions[drawer.dataset.selectedEdition]);
            }
        }

        const isAlreadyOpen = drawerIsOpen;

        drawer.classList.remove('hidden');
        setTimeout(() => {
            drawer.classList.add('open');
            drawerIsOpen = true;
            if (!isAlreadyOpen) drawerActiveTab = 'info';
            const sidebar = document.getElementById('drawer-sidebar');
            sidebar.classList.remove('hidden');
            sidebar.querySelectorAll('.drawer-sidebar-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === drawerActiveTab);
            });
            document.querySelector('.footer').classList.add('footer-hidden');

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
    drawerIsOpen = false;
    drawerActiveTab = 'info';
    document.getElementById('drawer-sidebar').classList.add('hidden');
    selectedCardId = null;

    const gridWrap = document.querySelector('.card-grid-wrap');
    if (!gridWrap || gridWrap.scrollTop === 0) {
        document.querySelector('.footer').classList.remove('footer-hidden');
    }

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

    drawer.dataset.selectedEdition = editionId;

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

    // If thema tab is active, re-render for the new edition
    if (drawerActiveTab === 'thema') {
        const cardInfo = drawer.querySelector('.drawer-card-info');
        const themaPanel = cardInfo?.querySelector('.drawer-tab-thema');
        if (themaPanel) themaPanel.innerHTML = buildTabThemaPanel(edition);
    }
}
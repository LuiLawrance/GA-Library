let drawerIsOpen = false;
let drawerActiveTab = 'info';

const DRAWER_RARITY_MAP = {
    1: "C", 2: "U", 3: "R", 4: "SR",
    5: "UR", 6: "PR", 7: "CSR", 8: "CUR", 9: "CPR"
};

// Every card-drawer instance (the main one on Cards/Prices/Decks/Admin, and the
// inventory bin page's own copy) shares this exact same open/close/edition-select
// behavior. This registry is what lets openDrawer/closeDrawer/selectDrawerEditionFor
// below be written ONCE instead of once per page — see switchDrawerTab, which
// already followed this drawerId-parameterized shape before the rest did, and
// promptly went stale in the inventory page's independent copy as a result.
const DRAWER_CONFIG = {
    'card-drawer': {
        contentId: 'drawer-content',
        sidebarId: 'drawer-sidebar',
        tilePrefix: 'edition-tile-',
        gridWrapSelector: '.card-grid-wrap',
        adminAware: true,
        getSelectedCardId: () => selectedCardId,
        setSelectedCardId: v => { selectedCardId = v; },
        getIsOpen: () => drawerIsOpen,
        setIsOpen: v => { drawerIsOpen = v; },
        getActiveTab: () => drawerActiveTab,
        setActiveTab: v => { drawerActiveTab = v; },
        onOpenError: () => console.error('Failed to load card details'),
    },
    'inv-card-drawer': {
        contentId: 'inv-drawer-content',
        sidebarId: 'inv-drawer-sidebar',
        tilePrefix: 'edition-tile-inv-',
        gridWrapSelector: '.inv-card-grid-wrap',
        adminAware: false,
        getSelectedCardId: () => selectedInvCardId,
        setSelectedCardId: v => { selectedInvCardId = v; },
        getIsOpen: () => invDrawerIsOpen,
        setIsOpen: v => { invDrawerIsOpen = v; },
        getActiveTab: () => invDrawerActiveTab,
        setActiveTab: v => { invDrawerActiveTab = v; },
        onOpenError: () => console.error('Failed to load card details for inv drawer'),
    },
};

// Build the "Set Name (PREFIX) — #NUM" line with the set portion hyperlinked
// to a set search on the Cards page.
function drawerSetLineHTML(edition) {
    const setName = edition?.set_name || '';
    const setPrefix = edition?.set_prefix || '';
    const collectorNumber = edition?.collector_number || '?';
    const escapedPrefix = setPrefix.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    return `<a class="drawer-set-link" title="Search this set"
        onclick="event.stopPropagation(); drawerSearchSet('${escapedPrefix}')">${setName} (${setPrefix})</a> &mdash; #${collectorNumber}`;
}

// Close whichever drawer is open, then open the Cards page with this set
// applied as a filter. (The `$` set-search command stays user-only.)
function drawerSearchSet(setPrefix) {
    if (!setPrefix) return;

    if (document.getElementById('card-drawer') && typeof closeCardDrawer === 'function') {
        closeCardDrawer();
    }
    if (document.getElementById('inv-card-drawer') && typeof closeInvDrawer === 'function') {
        closeInvDrawer();
    }

    // Set filter values must match /api/sets strings (uppercase) so the
    // set dropdown reflects the applied filter.
    navigate(`/cards?set=${encodeURIComponent(setPrefix.toUpperCase())}`);
}

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

function formatCollectorDate(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
    });
}

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
        const cls = printing ? 'collector-badge--printing' : 'collector-badge--oop';
        return `<span class="collector-badge ${cls}">Printing</span>`;
    }

    function soleFoilBadge() {
        return `<span class="collector-badge collector-badge--sole" title="No standard foil printing exists — this special foil accounts for the entire foil population">All Foils</span>`;
    }

    function foilRow(foilObj, label, isVariant = false, parentPop = null, showSoleBadge = false) {
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
                    ${showSoleBadge ? soleFoilBadge() : ''}
                    ${printingBadge(foilObj.printing)}
                </div>
            </div>`;
    }

    function foilBlock(foilObj, label, showSoleBadge = false) {
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
                    'Standard',
                    true,
                    foilObj.population
                );
            }
            variants.forEach(v => {
                variantHTML += foilRow(v, toFoilLabel(v.kind).replace(/\s+Foil$/i, '').trim(), true, foilObj.population);
            });
        }

        return foilRow(foilObj, label, false, null, showSoleBadge) + variantHTML;
    }

    // Edge case: no standard "Foil" kind exists — the special foil(s) ARE the entire foil population
    const noBaseFoil = !foilEntry && specials.length > 0;

    const rows = [
        foilBlock(nonfoilEntry, 'Non-Foil'),
        foilBlock(foilEntry, 'Foil'),
        ...specials.map(f => foilBlock(f, toFoilLabel(f.kind).replace(/\s+Foil$/i, '').trim(), noBaseFoil))
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
    const illustrator = edition?.illustrator || null;

    const editionStats = [];
    if (edition?.date_created) editionStats.push({label: 'Released', value: formatCollectorDate(edition.date_created)});
    if (illustrator) editionStats.push({label: 'Illustrator', value: illustrator});

    const editionStatsHTML = editionStats.length
        ? `<div class="collector-thema-divider"></div>
           <div class="drawer-stats collector-edition-stats">
               ${editionStats.map(s => `
                   <div class="drawer-stat">
                       <span class="drawer-stat-label">${s.label}</span>
                       <span class="drawer-stat-value">${s.value}</span>
                   </div>
               `).join('')}
           </div>`
        : '';

    return buildCollectorHTML(foils)
        + `<div class="collector-thema-divider"></div>`
        + `<div class="collector-section-label">Thema</div>`
        + buildThemaHTML(thema)
        + editionStatsHTML;
}

// Edition-specific (flavor text differs per printing), so unlike the rest of
// the Info tab this has to be re-rendered on edition switch — see the
// .drawer-info-flavor lookup in selectDrawerEditionFor. Always renders the
// wrapper (toggling .hidden) rather than omitting it, so that lookup always
// has something to find.
function drawerInfoFlavorHTML(edition) {
    const hasFlavor = !!edition?.flavor;
    return `
        <div class="drawer-info-flavor${hasFlavor ? '' : ' hidden'}">
            <div class="drawer-flavor">${edition?.flavor || ''}</div>
        </div>`;
}

const PRICING_CHART_W = 400;
const PRICING_CHART_H = 140;
// bottom has room for two label rows: day-number ticks, then month titles
// underneath (see buildPricingComboChart's dateLabelsHTML/monthDividersHTML).
const PRICING_CHART_PAD = {top: 14, right: 10, bottom: 32, left: 46};

// Horizontal margin reserved inside the plot area so the first/last data
// points (and their axis ticks) sit a bit clear of the plot's left/right
// edges instead of flush against them — see timeToX in buildPricingComboChart.
const PRICING_CHART_X_INSET = 16;

// The drawer's chart is a brief, at-a-glance snapshot — cap each series to its
// most recent points rather than plotting a card's entire trade history. Full
// history stays available from the Prices page's watchlist.
const PRICING_CHART_MAX_POINTS = 5;

// A card with only a handful of data points never gets cramped no matter how
// wide a date range they're spread across — a sparse trickle of sales over two
// years still reads fine plotted across one fixed-width panel. Below this many
// distinct dates, the Prices page's full-history chart (the useLegendMenu
// chart, which unlike the drawer's never truncates via maxPoints) always
// renders at the panel's own width. At or above it, buildPricingComboChart
// switches to the windowed/scrolling layout governed by
// PRICING_CHART_MAX_VISIBLE_DAYS below.
const PRICING_CHART_SCROLL_POINT_THRESHOLD = 15;

// Once a chart has enough points to use the windowed layout (see
// PRICING_CHART_SCROLL_POINT_THRESHOLD), it shows at most this many days of
// history at the panel's resting width before widening and scrolling — a card
// with, say, a year of dense price history would otherwise cram 4x this many
// days into one fixed-width panel, squeezing every point together instead of
// leaving them readable. Below this span, points still just fill the panel
// at its normal width — the window only kicks in once there's actually more
// than this much history to show.
const PRICING_CHART_MAX_VISIBLE_DAYS = 91; // ~3 months

// Vertical space reserved at the bottom of the chart when it's in scrolling
// mode, matching .pricing-chart-scroll's styled scrollbar height (8px) plus a
// couple px of breathing room — see the `h` calculation in
// buildPricingComboChart for why this has to come off the chart's own height
// rather than just being extra panel space.
const PRICING_CHART_SCROLLBAR_GUTTER = 15;

// Best-to-worst condition order, matching CONDITION_MAP in api_tcgplayer.py —
// used both to sort each chart's legend/lines and to rank how much a line's
// color is lightened (Near Mint stays full-strength, worse grades fade out).
const PRICING_CONDITION_ORDER = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

// A sale/listing's "condition" carries the raw condition text, which for foil
// entries ends in " Foil" (e.g. "Near Mint Foil") — stripped here since the
// chart is already scoped to one foil's own section, so the suffix is redundant.
function normalizePricingCondition(condition) {
    return (condition || '').replace(/\s+Foil$/i, '').trim() || 'Unknown';
}

// Each condition gets its own hue rather than a lightened tint of one base
// color — sales step through the cool half of the spectrum (green → blue →
// indigo → violet → plum), listings through the warm half (red → orange →
// gold → rust → maroon), so e.g. Near Mint Sales (green) and Near Mint
// Listings (red) never read as "the same line, different shade."
const PRICING_SALES_COLORS = [
    'hsl(140, 55%, 45%)',  // Near Mint — green
    'hsl(210, 65%, 55%)',  // Lightly Played — blue
    'hsl(255, 55%, 62%)',  // Moderately Played — indigo
    'hsl(280, 45%, 55%)',  // Heavily Played — violet
    'hsl(305, 35%, 45%)',  // Damaged — plum
];
const PRICING_LISTINGS_COLORS = [
    'hsl(0, 70%, 55%)',   // Near Mint — red
    'hsl(30, 80%, 55%)',  // Lightly Played — orange
    'hsl(48, 80%, 50%)',  // Moderately Played — gold
    'hsl(20, 55%, 45%)',  // Heavily Played — rust
    'hsl(0, 45%, 35%)',   // Damaged — maroon
];
const PRICING_UNKNOWN_COLOR = 'hsl(0, 0%, 55%)';

function pricingConditionColor(type, condition) {
    const palette = type === 'sales' ? PRICING_SALES_COLORS : PRICING_LISTINGS_COLORS;
    const rank = PRICING_CONDITION_ORDER.indexOf(condition);
    return rank === -1 ? PRICING_UNKNOWN_COLOR : palette[rank];
}

// Stable, attribute-safe identifier for a (type, condition) series — used to
// tie a legend toggle to its line/dots/end-label so they can be hidden together.
function pricingSeriesKey(type, condition) {
    return `${type}-${condition}`.toLowerCase().replace(/\s+/g, '-');
}

// Groups entries by their normalized condition, then orders the groups
// Near Mint → Damaged (unrecognized conditions sort last) so lines and
// legend entries always read best-to-worst.
function groupPricingByCondition(entries) {
    const groups = new Map();

    for (const e of entries) {
        const condition = normalizePricingCondition(e.condition);
        if (!groups.has(condition)) groups.set(condition, []);
        groups.get(condition).push(e);
    }

    return [...groups.entries()].sort((a, b) => {
        const rankA = PRICING_CONDITION_ORDER.indexOf(a[0]);
        const rankB = PRICING_CONDITION_ORDER.indexOf(b[0]);
        return (rankA === -1 ? 99 : rankA) - (rankB === -1 ? 99 : rankB);
    });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showPricingTooltip(evt) {
    const g = evt.currentTarget;
    let tooltip = document.getElementById('pricing-tooltip');

    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'pricing-tooltip';
        tooltip.className = 'pricing-tooltip hidden';
        document.body.appendChild(tooltip);
    }

    tooltip.innerHTML = '';

    const headerEl = document.createElement('div');
    headerEl.className = 'pricing-tooltip-header';

    const keyEl = document.createElement('span');
    keyEl.className = 'pricing-tooltip-key';
    keyEl.style.background = g.dataset.color;
    headerEl.appendChild(keyEl);

    const seriesEl = document.createElement('span');
    seriesEl.className = 'pricing-tooltip-series';
    seriesEl.textContent = g.dataset.series;
    headerEl.appendChild(seriesEl);
    tooltip.appendChild(headerEl);

    const priceEl = document.createElement('div');
    priceEl.className = 'pricing-tooltip-price';
    priceEl.textContent = `$${g.dataset.price}`;
    tooltip.appendChild(priceEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'pricing-tooltip-meta';
    metaEl.textContent = `${g.dataset.date} · ${g.dataset.condition} · x${g.dataset.quantity}`;
    tooltip.appendChild(metaEl);

    tooltip.classList.remove('hidden');
    anchorPricingTooltip(g, tooltip);
}

function anchorPricingTooltip(g, tooltip) {
    const dot = g.querySelector('.pricing-chart-dot, .pricing-chart-avg-dot');
    if (!dot) return;

    // Anchor to the hovered point's own screen position (not the cursor) so the
    // tooltip stays put over the point regardless of where in its hit-radius
    // the mouse sits. Everything here is computed in real/rendered viewport
    // pixels — the same space getBoundingClientRect() and window.innerWidth/
    // Height use — so it can be compared and clamped directly.
    const dotRect = dot.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const margin = 8;

    const fitsAbove = dotRect.top - 10 - tooltipRect.height >= margin;
    let top = fitsAbove ? dotRect.top - 10 - tooltipRect.height : dotRect.bottom + 10;
    let left = dotRect.left + dotRect.width / 2 - tooltipRect.width / 2;

    // Clamp so the tooltip never runs off any edge of the browser window,
    // even when the point sits near a corner of the chart.
    top = Math.min(Math.max(top, margin), window.innerHeight - margin - tooltipRect.height);
    left = Math.min(Math.max(left, margin), window.innerWidth - margin - tooltipRect.width);

    // getBoundingClientRect() already reflects the page's `zoom` CSS property
    // (see main.css), but assigning that same value back to a position:fixed
    // element's inline left/top applies the zoom a second time. Divide it out
    // so the tooltip lands exactly where computed instead of drifting toward
    // the top-left corner.
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;

    tooltip.style.left = `${left / zoom}px`;
    tooltip.style.top = `${top / zoom}px`;
}

function hidePricingTooltip() {
    document.getElementById('pricing-tooltip')?.classList.add('hidden');
}

function buildPricingSeriesMarks(series, xAt, yAt) {
    const {label, color, entries, key} = series;

    if (!entries.length) return {linePath: '', dotsHTML: '', last: null, color, key};

    // The line traces one vertex per date — its average price when more than
    // one entry shares that date, its actual price otherwise. Every individual
    // entry still gets its own solid marker regardless of grouping.
    const byDate = new Map();
    for (const e of entries) {
        if (!byDate.has(e.date)) byDate.set(e.date, []);
        byDate.get(e.date).push(e);
    }

    const vertices = [...byDate.entries()]
        .map(([vdate, group]) => ({
            date: vdate,
            group,
            price: group.reduce((sum, e) => sum + e.price, 0) / group.length
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

    const vertexPoints = vertices.map(v => ({...v, cx: xAt(v.date), cy: yAt(v.price)}));

    const linePath = vertexPoints.length > 1
        ? vertexPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.cx.toFixed(1)} ${p.cy.toFixed(1)}`).join(' ')
        : '';

    const points = entries.map(e => ({...e, cx: xAt(e.date), cy: yAt(e.price)}));

    const dotsHTML = points.map(p => `
        <g class="pricing-chart-point"
           data-series="${escapeHtml(label)}"
           data-series-key="${escapeHtml(key)}"
           data-color="${escapeHtml(color)}"
           data-date="${escapeHtml(p.date)}"
           data-condition="${escapeHtml(p.condition || '')}"
           data-quantity="${p.quantity ?? 1}"
           data-price="${Number(p.price).toFixed(2)}"
           onmouseenter="showPricingTooltip(event)"
           onmouseleave="hidePricingTooltip()">
            <circle cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="8" class="pricing-chart-hit" />
            <circle cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="7" class="pricing-chart-dot-ring" style="stroke:${color}" />
            <circle cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="4" class="pricing-chart-dot" style="fill:${color}" />
        </g>`).join('');

    // Hollow marker at the average, only where a date actually grouped more than one entry.
    const avgDotsHTML = vertexPoints
        .filter(v => v.group.length > 1)
        .map(v => {
            const totalQuantity = v.group.reduce((sum, e) => sum + (e.quantity ?? 1), 0);
            return `
        <g class="pricing-chart-point"
           data-series="${escapeHtml(label)} Average"
           data-series-key="${escapeHtml(key)}"
           data-color="${escapeHtml(color)}"
           data-date="${escapeHtml(v.date)}"
           data-condition="Average of ${v.group.length}"
           data-quantity="${totalQuantity}"
           data-price="${Number(v.price).toFixed(2)}"
           onmouseenter="showPricingTooltip(event)"
           onmouseleave="hidePricingTooltip()">
            <circle cx="${v.cx.toFixed(1)}" cy="${v.cy.toFixed(1)}" r="9" class="pricing-chart-hit" />
            <circle cx="${v.cx.toFixed(1)}" cy="${v.cy.toFixed(1)}" r="8" class="pricing-chart-dot-ring" style="stroke:${color}" />
            <circle cx="${v.cx.toFixed(1)}" cy="${v.cy.toFixed(1)}" r="5" class="pricing-chart-avg-dot" style="stroke:${color}" />
        </g>`;
        }).join('');

    return {linePath, dotsHTML: dotsHTML + avgDotsHTML, last: vertexPoints[vertexPoints.length - 1], color, key};
}

// One labeled group of toggles in the Prices page's legend menu (see
// buildPricingComboChart) — skips entirely when this type has no series, so
// a card with only sales (or only listings) doesn't show an empty header.
function buildLegendMenuGroup(headerLabel, groupSeries) {
    if (!groupSeries.length) return '';

    return `
        <div class="pricing-legend-menu-header">${escapeHtml(headerLabel)}</div>
        ${groupSeries.map(s => `
        <div class="pricing-legend-toggle" data-series-key="${escapeHtml(s.key)}" onclick="togglePricingSeries(this)" role="checkbox" aria-checked="true">
            <span class="pricing-legend-swatch" style="--swatch-color:${s.color}"></span>
            <span class="pricing-legend-toggle-label">${escapeHtml(s.condition)}</span>
        </div>`).join('')}`;
}

function buildPricingComboChart(sales, listings, maxPoints = PRICING_CHART_MAX_POINTS, widthPx = null, heightPx = null) {
    // Split into one series per (type, condition) pair — "Near Mint Sales" and
    // "Lightly Played Sales" never share a line, same for listings — so each
    // grade's trend is readable on its own instead of averaged together.
    const series = [
        ...groupPricingByCondition(sales || []).map(([condition, entries]) => ({
            type: 'sales',
            condition,
            label: `${condition} Sales`,
            color: pricingConditionColor('sales', condition),
            key: pricingSeriesKey('sales', condition),
            entries: [...entries].sort((a, b) => a.date.localeCompare(b.date)).slice(-maxPoints),
        })),
        ...groupPricingByCondition(listings || []).map(([condition, entries]) => ({
            type: 'listings',
            condition,
            label: `${condition} Listings`,
            color: pricingConditionColor('listings', condition),
            key: pricingSeriesKey('listings', condition),
            entries: [...entries].sort((a, b) => a.date.localeCompare(b.date)).slice(-maxPoints),
        })),
    ];

    // The Prices page's graph panel (maxPoints=Infinity, i.e. full-history
    // mode) shows the legend as a toggle menu beside the chart instead of a
    // static strip above it — tied to maxPoints rather than widthPx/heightPx
    // so the very first render (before those are measured) already uses the
    // row layout, giving showPriceGraph a .pricing-chart-canvas to measure.
    // The drawer's compact ≤5-point chart keeps the plain static legend.
    const useLegendMenu = !Number.isFinite(maxPoints);

    const legendHTML = `
        <div class="pricing-legend">
            ${series.map(s => `
                <span class="pricing-legend-item">
                    <span class="pricing-legend-key" style="background:${s.color}"></span>${escapeHtml(s.label)}
                </span>`).join('')}
        </div>`;

    // Grouped under a "Sales"/"Listings" header instead of repeating that
    // word on every toggle (see buildLegendMenuGroup) — condition alone
    // (e.g. "Near Mint") is enough once the group makes the type clear.
    const salesGroupSeries = series.filter(s => s.type === 'sales');
    const listingsGroupSeries = series.filter(s => s.type === 'listings');
    // Each group renders into its own wrapper regardless of whether it has
    // content — an empty wrapper just collapses to nothing in the single-
    // type case, while the has-both class (only when both are non-empty)
    // splits the menu into equal halves via CSS so Listings' wrapper always
    // starts at the container's midpoint (see .pricing-legend-menu.has-both).
    const hasBothGroups = salesGroupSeries.length > 0 && listingsGroupSeries.length > 0;

    const legendMenuHTML = `
        <div class="pricing-legend-menu${hasBothGroups ? ' has-both' : ''}">
            <div class="pricing-legend-menu-group">${buildLegendMenuGroup('Sales', salesGroupSeries)}</div>
            <div class="pricing-legend-menu-group">${buildLegendMenuGroup('Listings', listingsGroupSeries)}</div>
        </div>`;

    const all = series.flatMap(s => s.entries);

    if (all.length === 0) {
        return useLegendMenu
            ? `<div class="pricing-empty">No pricing data available.</div>`
            : legendHTML + `<div class="pricing-empty">No pricing data available.</div>`;
    }

    const times = all.map(e => new Date(e.date).getTime());
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const timeSpan = (maxTime - minTime) || 1;

    // Only the Prices page's full-history chart (useLegendMenu, maxPoints=
    // Infinity) can ever have enough history to trip this — the drawer's own
    // chart caps each series to PRICING_CHART_MAX_POINTS and always comfortably
    // fits its fixed 400px width. Both gates have to clear: a card sparse
    // enough to stay under the point threshold is left at full width even if
    // its handful of sales span years, and a card with plenty of points but
    // packed into a short window is left at full width too since it isn't
    // actually short on room. Only once a card has both enough points *and*
    // enough history to need it does the chart widen — just enough to keep
    // the same "N days per panel-width" density for the extra time beyond
    // PRICING_CHART_MAX_VISIBLE_DAYS it's covering — and let the panel (see
    // the useLegendMenu return below) scroll horizontally over that width.
    // Determined ahead of h/pad below since reserving the scrollbar gutter
    // (see PRICING_CHART_SCROLLBAR_GUTTER) depends on already knowing this.
    const uniqueDateCount = new Set(all.map(e => e.date)).size;
    const spanDays = timeSpan / 86400000;
    const needsScroll = useLegendMenu
        && uniqueDateCount >= PRICING_CHART_SCROLL_POINT_THRESHOLD
        && spanDays > PRICING_CHART_MAX_VISIBLE_DAYS;

    // When the caller supplies its own measured pixel size (the Prices page's
    // graph panel), the viewBox matches it exactly — 1 viewBox unit = 1
    // rendered pixel — so the chart fills the panel without preserveAspectRatio
    // non-uniformly stretching a fixed box and distorting dots/text. The
    // drawer's own charts don't pass these and keep the fixed 400×140 sizing.
    const viewportW = Number.isFinite(widthPx) ? widthPx : PRICING_CHART_W;
    const viewportH = Number.isFinite(heightPx) ? heightPx : PRICING_CHART_H;
    // The horizontal scrollbar (see .pricing-chart-scroll in prices.css) sits
    // along the bottom edge of the panel regardless of the chart's own height,
    // so without this the chart's bottom-most content — the date/month axis
    // labels — would render right underneath it. Shrinking the chart itself
    // leaves that strip blank instead, with nothing there for the scrollbar to
    // cover.
    const h = needsScroll ? viewportH - PRICING_CHART_SCROLLBAR_GUTTER : viewportH;
    const pad = PRICING_CHART_PAD;
    const viewportPlotW = viewportW - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const plotW = needsScroll
        ? viewportPlotW * (spanDays / PRICING_CHART_MAX_VISIBLE_DAYS)
        : viewportPlotW;
    const w = needsScroll ? plotW + pad.left + pad.right : viewportW;

    const prices = all.map(e => e.price);
    const rawMin = Math.min(...prices);
    const rawMax = Math.max(...prices);
    const span = (rawMax - rawMin) || Math.max(rawMax * 0.2, 1);
    const minPrice = rawMin - span * 0.15;
    const maxPrice = rawMax + span * 0.15;

    const singleTime = minTime === maxTime;

    // Guards a very narrow chart from having the inset eat the whole plot
    // width (and, in turn, xAt/timeToX dividing by a zero or negative span).
    const insetX = Math.min(PRICING_CHART_X_INSET, plotW / 4);
    const dataPlotW = plotW - insetX * 2;
    const timeToX = time => pad.left + insetX + ((time - minTime) / timeSpan) * dataPlotW;
    const xAt = date => singleTime ? pad.left + plotW / 2 : timeToX(new Date(date).getTime());
    const yAt = price => pad.top + plotH - ((price - minPrice) / (maxPrice - minPrice)) * plotH;

    const gridlinesHTML = [0, 0.5, 1].map(t => {
        const gy = pad.top + plotH * t;
        const price = maxPrice - (maxPrice - minPrice) * t;
        return `
            <line x1="${pad.left}" y1="${gy.toFixed(1)}" x2="${(w - pad.right).toFixed(1)}" y2="${gy.toFixed(1)}" class="pricing-chart-grid" />
            <text x="${(pad.left - 6).toFixed(1)}" y="${gy.toFixed(1)}" class="pricing-chart-axis-label" text-anchor="end" dominant-baseline="middle">$${price.toFixed(2)}</text>`;
    }).join('');

    const marks = series.map(s => buildPricingSeriesMarks(s, xAt, yAt));

    // Direct end-labels only when there are just one or two lines total — the
    // legend + tooltip already carry identity, so once a card has several
    // condition lines, per-line price labels would just clutter the chart.
    let endLabelsHTML = '';
    const withLast = marks.filter(m => m.last);
    if (withLast.length > 0 && withLast.length <= 2 &&
        !(withLast.length === 2 && Math.abs(withLast[0].last.cy - withLast[1].last.cy) < 12)) {
        endLabelsHTML = withLast.map(m => {
            const p = m.last;
            const anchor = p.cx > w - pad.right - 30 ? 'end' : 'middle';
            return `<text x="${p.cx.toFixed(1)}" y="${(p.cy - 10).toFixed(1)}" class="pricing-chart-end-label" data-series-key="${escapeHtml(m.key)}" text-anchor="${anchor}">$${Number(p.price).toFixed(2)}</text>`;
        }).join('');
    }

    const firstDate = all.reduce((min, e) => e.date < min ? e.date : min, all[0].date);

    // Data-point ticks now show only the day of month — the month itself is
    // carried by the divider titles below (monthDividersHTML), so repeating
    // it on every tick would be redundant. Pure string slicing rather than
    // Date parsing, same reasoning as the old shortDate() this replaces:
    // avoids any UTC/local timezone reinterpretation of the "YYYY-MM-DD"
    // string shifting the displayed day.
    const dayOnly = date => String(parseInt(date.slice(8, 10), 10));
    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const axisY = (h - pad.bottom).toFixed(1);
    const tickBottomY = (h - pad.bottom + 4).toFixed(1);
    const dayLabelY = (h - pad.bottom + 12).toFixed(1);
    const monthLabelY = (h - 4).toFixed(1);

    // Rather than only ever labeling the two endpoint dates (which doesn't
    // reflect how the points in between are actually distributed in time),
    // pick a handful of ticks spread evenly across the real time range, each
    // snapped to its nearest actual data point so every label still names a
    // real date. A short tick line ties each label to the exact x position
    // of that point instead of just floating near it. Candidates closer
    // together than minGapPx are dropped (favoring the most recent date
    // over a too-close neighbor) so dates bunched close together don't
    // produce overlapping labels.
    const dateLabelsHTML = (() => {
        if (singleTime) {
            return `<text x="${(pad.left + plotW / 2).toFixed(1)}" y="${dayLabelY}" class="pricing-chart-axis-label" text-anchor="middle">${escapeHtml(dayOnly(firstDate))}</text>`;
        }

        const desiredCount = Math.max(2, Math.min(6, Math.floor(plotW / 60) + 1));
        const candidates = [];
        for (let i = 0; i < desiredCount; i++) {
            const targetTime = minTime + timeSpan * (i / (desiredCount - 1));
            let bestIdx = 0;
            let bestDiff = Infinity;
            for (let j = 0; j < times.length; j++) {
                const diff = Math.abs(times[j] - targetTime);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestIdx = j;
                }
            }
            candidates.push({date: all[bestIdx].date, x: xAt(all[bestIdx].date)});
        }

        // A bare day number is much narrower than the old "MM-DD" label, so
        // ticks can sit closer together before overlapping.
        const minGapPx = 24;
        const kept = [];
        for (const c of candidates) {
            const last = kept[kept.length - 1];
            if (last && last.date === c.date) continue;
            if (last && c.x - last.x < minGapPx) {
                if (c === candidates[candidates.length - 1]) {
                    kept.pop();
                } else {
                    continue;
                }
            }
            kept.push(c);
        }

        return kept.map(c => {
            const anchor = c.x <= pad.left + 12 ? 'start' : c.x >= w - pad.right - 12 ? 'end' : 'middle';
            return `
                <line x1="${c.x.toFixed(1)}" y1="${axisY}" x2="${c.x.toFixed(1)}" y2="${tickBottomY}" class="pricing-chart-tick" />
                <text x="${c.x.toFixed(1)}" y="${dayLabelY}" class="pricing-chart-axis-label" text-anchor="${anchor}">${escapeHtml(dayOnly(c.date))}</text>`;
        }).join('');
    })();

    // Vertical dividers marking every month boundary in view, each band
    // titled with its month name so the day-only ticks above still have
    // context. Boundaries are calendar month-starts, not data points, so
    // they're placed by real time (via timeSpan) rather than snapped to the
    // nearest entry the way the day ticks are. UTC getters/Date.UTC are used
    // throughout (matching how minTime/maxTime/xAt already parse the
    // "YYYY-MM-DD" strings as UTC midnight) so a boundary always lands
    // exactly at the 1st of its month regardless of the viewer's own
    // timezone offset.
    const monthDividersHTML = (() => {
        if (singleTime) {
            const month = MONTH_NAMES[new Date(firstDate).getUTCMonth()];
            return `<text x="${(pad.left + plotW / 2).toFixed(1)}" y="${monthLabelY}" class="pricing-chart-month-label" text-anchor="middle">${month}</text>`;
        }

        const boundaries = [];
        const start = new Date(minTime);
        let cursorTime = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
        while (cursorTime < maxTime) {
            boundaries.push(cursorTime);
            const c = new Date(cursorTime);
            cursorTime = Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1);
        }

        const dividersHTML = boundaries.map(t => {
            const x = timeToX(t).toFixed(1);
            return `<line x1="${x}" y1="${pad.top.toFixed(1)}" x2="${x}" y2="${axisY}" class="pricing-chart-month-divider" />`;
        }).join('');

        // Each band — from one boundary to the next, chart edges standing in
        // for the first/last — gets one title, centered on the band so it
        // reads as naming that whole stretch rather than crowding the line.
        const edges = [minTime, ...boundaries, maxTime];
        const minGapPx = 28;
        let lastX = -Infinity;
        const labelsHTML = edges.slice(0, -1).map((edgeStart, i) => {
            const midTime = (edgeStart + edges[i + 1]) / 2;
            const x = timeToX(midTime);
            if (x - lastX < minGapPx) return '';
            lastX = x;
            const month = MONTH_NAMES[new Date(edgeStart).getUTCMonth()];
            const anchor = x <= pad.left + 14 ? 'start' : x >= w - pad.right - 14 ? 'end' : 'middle';
            return `<text x="${x.toFixed(1)}" y="${monthLabelY}" class="pricing-chart-month-label" text-anchor="${anchor}">${month}</text>`;
        }).join('');

        return dividersHTML + labelsHTML;
    })();

    const linesHTML = marks.map(m => `<path d="${m.linePath}" style="stroke:${m.color}" class="pricing-chart-line" data-series-key="${escapeHtml(m.key)}" fill="none" />`).join('');
    const dotsHTML = marks.map(m => m.dotsHTML).join('');

    // Explicit pixel width/height (not the default width:100%/height:auto CSS)
    // so the rendered box matches the viewBox exactly instead of deriving
    // height from width via the fixed aspect ratio. Also needed in scroll mode
    // even on a first, unmeasured pass (see needsScroll above) — w is wider
    // than the panel there too, and without an explicit style CSS would just
    // shrink the svg back down to its container instead of letting it overflow
    // into the scrollable wrapper.
    const svgStyle = (Number.isFinite(widthPx) || Number.isFinite(heightPx) || needsScroll) ? ` style="width:${w}px;height:${h}px"` : '';

    const svgHTML = `
        <svg class="pricing-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"${svgStyle}>
            ${gridlinesHTML}
            ${monthDividersHTML}
            ${linesHTML}
            ${dotsHTML}
            ${endLabelsHTML}
            ${dateLabelsHTML}
        </svg>`;

    if (useLegendMenu) {
        // Wrapping in a scrollable div only when actually needed (rather than
        // always) keeps the plain case identical to before — no extra element,
        // no risk of an unwanted scrollbar from a rounding edge case.
        const canvasInner = needsScroll
            ? `<div class="pricing-chart-scroll">${svgHTML}</div>`
            : svgHTML;
        return `
            <div class="pricing-chart-row">
                <div class="pricing-chart-canvas">${canvasInner}</div>
                ${legendMenuHTML}
            </div>`;
    }

    return `${legendHTML}${svgHTML}`;
}

// Hides/shows a series' line, dots, and end-label together by toggling a
// shared data-series-key attribute — cheaper and simpler than re-running the
// whole chart-building pipeline just to remove one line from view.
function togglePricingSeries(toggleEl) {
    const key = toggleEl.dataset.seriesKey;
    toggleEl.classList.toggle('off');
    const isOff = toggleEl.classList.contains('off');
    toggleEl.setAttribute('aria-checked', String(!isOff));
    const canvas = toggleEl.closest('.pricing-chart-row')?.querySelector('.pricing-chart-canvas');
    if (!canvas || !key) return;
    canvas.querySelectorAll(`[data-series-key="${key}"]`).forEach(el => {
        el.classList.toggle('pricing-series-hidden', isOff);
    });
}

function buildPricingStats(sales, listings) {
    const stats = [];

    if (sales.length > 0) {
        const mostRecent = [...sales].sort((a, b) => b.date.localeCompare(a.date))[0];
        stats.push(['Most Recent Sale', `$${Number(mostRecent.price).toFixed(2)}`]);
    }

    if (listings.length > 0) {
        // Best-quality tier that actually has a listing (Near Mint first,
        // falling back down PRICING_CONDITION_ORDER), then the most recent
        // listing within that tier.
        const [, topTierEntries] = groupPricingByCondition(listings)[0];
        const mostRecent = [...topTierEntries].sort((a, b) => b.date.localeCompare(a.date))[0];
        stats.push(['Most Recent Listing', `$${Number(mostRecent.price).toFixed(2)}`]);
    }

    if (stats.length === 0) return '';

    return `
        <div class="drawer-stats pricing-stats">
            ${stats.map(([label, value]) => `
                <div class="drawer-stat">
                    <span class="drawer-stat-label">${label}</span>
                    <span class="drawer-stat-value">${value}</span>
                </div>
            `).join('')}
        </div>`;
}

// A saved product_id of "~" (NO_LISTINGS_SENTINEL in api_tcgplayer.py) means
// "confirmed to have no TCGPlayer listings" — not a real product to link to —
// so this falls back to a name search instead, same as the Admin Pricing
// tab's own TCG Player button (see openAdminPidTcgPlayer in admin.js).
function pricingTcgPlayerHref(productId, searchName) {
    return (productId && productId !== '~')
        ? `https://www.tcgplayer.com/product/${encodeURIComponent(productId)}`
        : `https://www.tcgplayer.com/search/grand-archive/product?q=${encodeURIComponent(searchName)}&productLineName=grand-archive`;
}

function pricingTcgLinkHTML(productId, searchName) {
    const href = pricingTcgPlayerHref(productId, searchName);
    return `
        <a class="pricing-tcg-btn" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="View on TCGPlayer">
            <img src="/marketplaces/TCG%20Player.png" alt="TCG Player" class="pricing-tcg-icon">
        </a>`;
}

function buildPricingFoilSection(foilId, label, pricing, linkHTML, mergeFoilId = null) {
    const primary = pricing?.[foilId] || {listings: [], sales: []};
    const secondary = mergeFoilId ? (pricing?.[mergeFoilId] || {listings: [], sales: []}) : {listings: [], sales: []};
    const sales = [...primary.sales, ...secondary.sales];
    const listings = [...primary.listings, ...secondary.listings];

    return `
        <div class="pricing-section">
            <div class="pricing-section-header">
                <div class="collector-section-label">${label}</div>
                ${linkHTML}
            </div>
            ${buildPricingStats(sales, listings)}
            ${buildPricingComboChart(sales, listings)}
        </div>`;
}

// A foil family whose entire population is a single variant (see
// _curio_foil_id_for_edition in app.py — the "exactly one variant" rule
// that identifies a true Curio Foil) has no separate base printing of its
// own: every copy that would otherwise be a plain "Foil" IS the Curio Foil.
// TCGPlayer sales/listings scraped against the parent's own foil_id (its
// override product page isn't always configured) belong to that variant
// too, not to a nonexistent plain-foil printing — so this returns the sole
// variant to fold in, or null when the foil has a real base printing.
function soleVariantOf([, foilObj]) {
    const variants = Object.entries(foilObj.variants || {});
    if (variants.length !== 1) return null;
    const [variantId, variantInfo] = variants[0];
    const basePop = (foilObj.population ?? 0) - (variantInfo.population ?? 0);
    return basePop <= 0 ? [variantId, variantInfo] : null;
}

function buildTabPricingPanel(edition, cardName) {
    const foils = edition?.foils || {};
    const pricing = edition?.pricing || {};
    // Regular nonfoil/foil printings (and top-level "special" foils, which
    // don't get their own override) all share the edition's own TCGPlayer
    // product page.
    const editionProductId = edition?.product_id || null;

    if (Object.keys(foils).length === 0) {
        return `<div class="thema-empty">No pricing data available for this edition.</div>`;
    }

    const entries = Object.entries(foils);
    const nonfoilEntry = entries.find(([, f]) => f.kind?.toLowerCase() === 'nonfoil');
    const foilEntry = entries.find(([, f]) => f.kind?.toLowerCase() === 'foil');
    const specials = entries.filter(([, f]) => {
        const k = f.kind?.toLowerCase();
        return k !== 'nonfoil' && k !== 'foil';
    });

    // Curio-only foils (no distinct base printing) are labeled and graphed
    // under the variant's own kind rather than the generic Non-Foil/Foil/
    // special label, folding the parent foil_id's data in alongside the
    // variant's own — see soleVariantOf above. Its own override product_id
    // is scraped against the parent foil_id's product page in this case (see
    // app.py), so the edition's product_id is a meaningful fallback link
    // here — unlike the standalone-variant case below, where it isn't.
    function sectionFor(entry, fallbackLabel) {
        const [foilId] = entry;
        const sole = soleVariantOf(entry);
        if (sole) {
            const [variantId, variantInfo] = sole;
            const label = toFoilLabel(variantInfo.kind);
            const link = pricingTcgLinkHTML(variantInfo.product_id || editionProductId, `${cardName} ${label}`);
            return buildPricingFoilSection(foilId, label, pricing, link, variantId);
        }
        const link = pricingTcgLinkHTML(editionProductId, cardName);
        return buildPricingFoilSection(foilId, fallbackLabel, pricing, link);
    }

    const sections = [];

    if (nonfoilEntry) sections.push(sectionFor(nonfoilEntry, 'Non-Foil'));
    if (foilEntry) sections.push(sectionFor(foilEntry, 'Foil'));
    specials.forEach(entry => sections.push(sectionFor(entry, toFoilLabel(entry[1].kind))));

    // Any variants not already folded into their parent's section above
    // (e.g. multi-stamp tournament promos, which have several variants
    // rather than the lone one a Curio Foil has) still get their own
    // section — linked only to its own override, same as the Admin Pricing
    // tab's Curio Foil view (see openAdminPidTcgPlayer in admin.js), since
    // the edition's main product page isn't about this variant.
    entries.forEach(entry => {
        const sole = soleVariantOf(entry);
        Object.entries(entry[1].variants || {}).forEach(([variantId, variantInfo]) => {
            if (sole && sole[0] === variantId) return;
            const label = toFoilLabel(variantInfo.kind);
            const link = pricingTcgLinkHTML(variantInfo.product_id, `${cardName} ${label}`);
            sections.push(buildPricingFoilSection(variantId, label, pricing, link));
        });
    });

    return sections.join('');
}

// The info/thema/pricing panels above the editions grid can differ in height,
// so anything that changes which one is showing (switching tabs) or what's in
// one of them (switching editions, when a data-driven tab is active) shifts the
// editions grid below into a new position the instant it happens. FLIP that
// shift into a slide: call this before the height-changing DOM update, then
// call the returned play() once it's done. compensateZoom because the drawer's
// getBoundingClientRect deltas are page-zoom-scaled (main.css `zoom` under
// 2100px) while a transform is not — see flipCapture in animation.js.
function captureEditionsGridShift(drawer) {
    return flipCapture(drawer?.querySelector('.drawer-editions-section'), {
        axis: 'y', compensateZoom: true, duration: 200,
    });
}

function switchDrawerTab(tab, drawerId = 'card-drawer') {
    const cfg = DRAWER_CONFIG[drawerId];
    const previousTab = cfg.getActiveTab();

    if (previousTab === tab) return;

    cfg.setActiveTab(tab);
    const drawer = document.getElementById(drawerId);
    if (!drawer) return;

    // Update the external floating sidebar
    const sidebar = document.getElementById(cfg.sidebarId);
    if (sidebar) {
        sidebar.querySelectorAll('.drawer-sidebar-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
    }

    const cardInfo = drawer.querySelector('.drawer-card-info');
    if (!cardInfo) return;

    const panels = {
        info: cardInfo.querySelector('.drawer-tab-info'),
        thema: cardInfo.querySelector('.drawer-tab-thema'),
        pricing: cardInfo.querySelector('.drawer-tab-pricing'),
    };

    const outgoing = panels[previousTab];
    const incoming = panels[tab];
    if (!outgoing || !incoming) return;

    // Populate incoming content before animating in
    const currentEditionId = drawer.dataset.selectedEdition;
    const editions = JSON.parse(drawer.dataset.editions || '{}');
    const edition = editions[currentEditionId];

    if (tab === 'thema') {
        incoming.innerHTML = buildTabThemaPanel(edition);
    } else if (tab === 'pricing') {
        incoming.innerHTML = buildTabPricingPanel(edition, cardInfo.querySelector('.drawer-name')?.textContent || '');
    }

    // Crossfade the panels; the editions grid below rides the height change of
    // whichever panel is now showing (FLIP captured while both are hidden).
    crossFade(outgoing, incoming, () => {}, {
        outShift: 'translateY(-6px)',
        inShift: 'translateY(6px)',
        onBetween: () => captureEditionsGridShift(drawer),
    });
}

// 'card-drawer' (see DRAWER_CONFIG above) is shared across Cards, Prices,
// Decks, and Admin — but only the Cards page's own bookmarked/shared links
// should carry an opened card, so every URL sync below is gated on cards.html's
// own root ("cards-page") actually being present, not just on which drawer id
// is involved.
function _onCardsPage() {
    return !!document.getElementById('cards-page');
}

// Reflects (or clears) the drawer's open card/edition into the URL as
// ?card_id=&edition_id=, preserving whatever search params (q/set/etc.) are
// already there. replaceState rather than pushState: opening a card or
// switching editions happens casually and often in quick succession, so a
// new history entry per click would flood the back button — mirrors the same
// reasoning showPriceGraph's URL sync uses on the Prices page.
function _syncCardsDrawerUrl(cardId, editionId) {
    if (!_onCardsPage()) return;

    const params = new URLSearchParams(window.location.search);

    if (cardId && editionId) {
        params.set('card_id', cardId);
        params.set('edition_id', editionId);
    } else {
        params.delete('card_id');
        params.delete('edition_id');
    }

    const query = params.toString();
    window.history.replaceState({}, '', query ? `/cards?${query}` : '/cards');
}

// Shared implementation behind openCardDrawer/openInvDrawer — see DRAWER_CONFIG above.
// updateUrl is false only when restoring from a URL that already carries this
// exact selection (see app.js's /cards restore) — no point replacing it with itself.
async function openDrawer(drawerId, cardId, editionId, cardName, updateUrl = true) {
    const cfg = DRAWER_CONFIG[drawerId];
    const drawer = document.getElementById(drawerId);
    if (!drawer) return;

    if (cfg.getSelectedCardId() === cardId) {
        const currentTile = drawer.querySelector('.drawer-edition-tile img.edition-selected');
        if (currentTile && currentTile.id === `${cfg.tilePrefix}${editionId}`) {
            closeDrawer(drawerId);
            return;
        }
        selectDrawerEditionFor(drawerId, editionId);
        return;
    }

    const isAlreadyOpen = cfg.getIsOpen();
    cfg.setSelectedCardId(cardId);

    try {
        const res = await fetch(`/api/cards/${cardId}`);
        const data = await res.json();
        const card = data.card;

        // Falls back to the name the API itself already resolves for a
        // card_id-only lookup (see api_card_detail's comment in app.py) —
        // lets a caller that only has card_id/edition_id, e.g. restoring a
        // bookmarked ?card_id= URL, open the drawer without a separate name
        // lookup of its own.
        cardName = cardName || card.name;

        if (updateUrl) _syncCardsDrawerUrl(cardId, editionId);

        const editions = Object.entries(card.editions).sort((a, b) => {
            const parseNum = str => {
                const match = (str || 'ZZZ').match(/^(\d+)([A-Z]*)$/i);
                return match ? [parseInt(match[1]), match[2] || ''] : [Infinity, str];
            };

            const [nA, sA] = parseNum(a[1].collector_number);
            const [nB, sB] = parseNum(b[1].collector_number);

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

        const editionsHTML = editions.map(([eid, einfo], i) => {
            const rarity = DRAWER_RARITY_MAP[einfo.rarity] || "?";
            const rarityClass = `rarity-${rarity.toLowerCase()}`;

            return `
            <div class="drawer-edition-tile tile-hoverable" style="animation-delay: ${i * 60}ms">
                <div class="drawer-edition-media tile-zoom">
                    <div class="edition-tile-wrap">
                        <div class="tile-img-spinner">${TILE_SPINNER_SVG}</div>
                        <img data-src="/images/${eid}.jpg" alt="${einfo.set_name}"
                            title="${einfo.set_name} (${einfo.set_prefix})"
                            onclick="event.stopPropagation(); selectDrawerEditionFor('${drawerId}', '${eid}')"
                            onload="revealTileImage(this)" onerror="revealTileImage(this)"
                            id="${cfg.tilePrefix}${eid}">
                        <span class="edition-prefix-badge">${einfo.set_prefix}</span>
                        <span class="edition-rarity-badge ${rarityClass}">${rarity}</span>
                        ${priceBadgesHTML(einfo.last_price, einfo.lowest_listing)}
                    </div>
                </div>
            </div>
        `
        }).join('');

        const drawerContent = document.getElementById(cfg.contentId);

        drawer.dataset.editions = JSON.stringify(Object.fromEntries(editions));
        drawer.dataset.selectedEdition = editionId;

        const inner = document.createElement('div');
        inner.innerHTML = `
            <div class="drawer-top">
                <img class="drawer-card-image" src="/images/${editionId}.jpg" alt="${cardId}">
                <div class="drawer-card-info">
                    <div class="drawer-name-row">
                        <div>
                            <div class="drawer-name">${cardName}</div>
                            <div class="drawer-set">${drawerSetLineHTML(selectedEdition)}</div>
                        </div>
                        <!-- card.element comes straight from the Grand Archive API in
                             UPPERCASE (e.g. "NORM"), but assets/GA_ELEMENTS' own filenames
                             are lowercase — harmless on Windows' case-insensitive filesystem,
                             but a 404 (missing element icon) once served from Railway's
                             case-sensitive Linux one, so this always lowercases the path. -->
                        ${card.element ? `<img class="drawer-element" src="/elements/${card.element.toLowerCase()}.png" alt="${card.element}">` : ''}
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

                        ${drawerInfoFlavorHTML(selectedEdition)}
                    </div>

                    <div class="drawer-tab-thema hidden"></div>
                    <div class="drawer-tab-pricing hidden"></div>
                </div>
            </div>

            <div class="drawer-editions-section">
                <div class="drawer-section-label">Editions</div>
                <div class="drawer-editions">${editionsHTML}</div>
            </div>
        `;

        const doInsert = () => {
            drawerContent.innerHTML = '';
            drawerContent.appendChild(inner);

            // Queued (tiles.js) rather than set directly in the template —
            // see the matching comment in buildCardTile (cards.js). A card
            // with many prints fires that many /images/ requests the instant
            // this markup lands, competing with the drawer's own detail fetch.
            inner.querySelectorAll('.drawer-editions img[data-src]').forEach(img => {
                queueTileImageLoad(img, img.dataset.src, {priority: true});
            });

            // Mark the selected edition tile immediately
            const initialTile = document.getElementById(`${cfg.tilePrefix}${editionId}`);
            if (initialTile) initialTile.classList.add('edition-selected');

            // Apply active tab to the newly rendered panels
            const cardInfo = drawer.querySelector('.drawer-card-info');
            const activeTab = cfg.getActiveTab();
            if (cardInfo && cfg.getIsOpen() && activeTab !== 'info') {
                const infoPanel = cardInfo.querySelector('.drawer-tab-info');
                infoPanel.classList.add('hidden');

                if (activeTab === 'thema') {
                    const themaPanel = cardInfo.querySelector('.drawer-tab-thema');
                    themaPanel.classList.remove('hidden');
                    themaPanel.innerHTML = buildTabThemaPanel(selectedEdition);
                } else if (activeTab === 'pricing') {
                    const pricingPanel = cardInfo.querySelector('.drawer-tab-pricing');
                    pricingPanel.classList.remove('hidden');
                    pricingPanel.innerHTML = buildTabPricingPanel(selectedEdition, cardName);
                }
            }
        };

        if (isAlreadyOpen) {
            const existing = drawerContent.firstElementChild;
            if (existing) {
                // Switching cards while the drawer stays open reuses the
                // app's own menu-to-menu transition (.content.fade-out/
                // .fade-in in main.css — same opacity+translateY(8px) motion
                // and timing) instead of the slide-in reveal below, which is
                // meant to read as "the drawer arriving" on a fresh open and
                // is too much motion for just swapping the card underneath it.
                //
                // If this is the first switch after a fresh open, `existing`
                // still carries drawer-content-animate from its own opening
                // animation. That animation's fill-mode:forwards keeps
                // holding opacity:1/transform:none with higher cascade
                // priority than the inline styles below for as long as the
                // class is attached — even though the animation itself
                // finished playing long ago — so the fade-out below would
                // silently no-op unless the class comes off first. Removing
                // the class and setting the transition/end-values in the same
                // tick can then get coalesced into one style update with no
                // separate "still opacity:1" frame in between — so the
                // transition never has a from-state to animate from and just
                // snaps straight to the end state. Reading offsetHeight forces
                // the browser to commit the class removal as its own frame
                // first, so the opacity/transform change right after is a
                // real, detectable change the transition can animate.
                existing.classList.remove('drawer-content-animate');
                void existing.offsetHeight;

                // doInsert removes `existing` and appends `inner`, so there are
                // no .hidden toggles to make (toggleHidden:false) — crossFade
                // just drives the out/in fade timing. See animation.js.
                crossFade(existing, inner, doInsert, {
                    toggleHidden: false,
                    outShift: 'translateY(8px)',
                    inShift: 'translateY(8px)',
                });
            } else {
                doInsert();
            }
        } else {
            // Fresh open — the fuller slide-in reveal (see .drawer-content-animate
            // / @keyframes drawerContentReveal in drawer.css) is fine here since
            // there's no previous card's content to visually collide with.
            inner.className = 'drawer-content-animate';
            doInsert();
        }

        drawer.classList.remove('hidden');
        setTimeout(() => {
            drawer.classList.add('open');
            cfg.setIsOpen(true);
            if (!isAlreadyOpen) cfg.setActiveTab('info');
            const sidebar = document.getElementById(cfg.sidebarId);
            sidebar?.classList.remove('hidden');
            sidebar?.querySelectorAll('.drawer-sidebar-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === cfg.getActiveTab());
            });
            document.querySelector('.footer')?.classList.add('footer-hidden');
        }, 10);

    } catch {
        cfg.onOpenError();
    }
}

// Shared implementation behind closeCardDrawer/closeInvDrawer — see DRAWER_CONFIG above.
function closeDrawer(drawerId) {
    const cfg = DRAWER_CONFIG[drawerId];
    const drawer = document.getElementById(drawerId);
    if (!drawer) return;

    _syncCardsDrawerUrl(null, null);

    drawer.classList.remove('open');
    cfg.setIsOpen(false);
    cfg.setActiveTab('info');
    document.getElementById(cfg.sidebarId)?.classList.add('hidden');
    cfg.setSelectedCardId(null);

    // The admin console keeps the footer hidden unconditionally (see initAdmin()
    // in admin.js) — it has no scrollable card grid to key footer visibility off of,
    // so closing the drawer there must not reveal it. Only the main card drawer
    // is reachable from admin, so this only applies when cfg.adminAware is set.
    const onAdminPage = cfg.adminAware && !!document.getElementById('admin-page');
    const gridWrap = document.querySelector(cfg.gridWrapSelector);

    if (!onAdminPage && (!gridWrap || gridWrap.scrollTop === 0)) {
        document.querySelector('.footer')?.classList.remove('footer-hidden');
    }

    setTimeout(() => {
        drawer.classList.add('hidden');
    }, 300);
}

function openCardDrawer(cardId, editionId, cardName, updateUrl = true) {
    return openDrawer('card-drawer', cardId, editionId, cardName, updateUrl);
}

function closeCardDrawer() {
    closeDrawer('card-drawer');
}

// Shared implementation behind selectDrawerEdition/selectInvDrawerEdition — see DRAWER_CONFIG above.
async function selectDrawerEditionFor(drawerId, editionId) {
    const cfg = DRAWER_CONFIG[drawerId];
    const drawer = document.getElementById(drawerId);
    const mainImage = drawer?.querySelector('.drawer-card-image');
    if (!mainImage) return;

    const currentTile = drawer.querySelector('.drawer-edition-tile img.edition-selected');
    if (currentTile && currentTile.id === `${cfg.tilePrefix}${editionId}`) {
        return;
    }

    _syncCardsDrawerUrl(cfg.getSelectedCardId(), editionId);

    const editions = JSON.parse(drawer.dataset.editions || '{}');
    const edition = editions[editionId];
    const cardInfo = drawer.querySelector('.drawer-card-info');

    // Same fade-out/fade-in classes (opacity+translateY(8px), same timing) used
    // for the app's page-to-page transition (main.css) and the admin pricing
    // detail switch (admin.js selectAdminPricingDetail), so switching editions
    // reads consistently with the rest of the app.
    await fadeSwap([mainImage, cardInfo], () => {
        // The new edition's thema/pricing content below can be taller or shorter
        // than the old one's, which would otherwise snap the editions grid into
        // its new position while it's invisible (mid fade). Captured now (info is
        // already faded out, so this is before any of that content changes) and
        // played once it's done — see captureEditionsGridShift.
        const playGridShift = captureEditionsGridShift(drawer);

        mainImage.src = `/images/${editionId}.jpg`;

        drawer.dataset.selectedEdition = editionId;

        if (edition) {
            const setEl = drawer.querySelector('.drawer-set');
            if (setEl) {
                setEl.innerHTML = drawerSetLineHTML(edition);
            }

            const flavorEl = cardInfo?.querySelector('.drawer-info-flavor');
            if (flavorEl) {
                flavorEl.outerHTML = drawerInfoFlavorHTML(edition);
            }
        }

        // If a data-driven tab is active, re-render for the new edition
        const activeTab = cfg.getActiveTab();
        if (activeTab === 'thema') {
            const themaPanel = cardInfo?.querySelector('.drawer-tab-thema');
            if (themaPanel) themaPanel.innerHTML = buildTabThemaPanel(edition);
        } else if (activeTab === 'pricing') {
            const pricingPanel = cardInfo?.querySelector('.drawer-tab-pricing');
            if (pricingPanel) pricingPanel.innerHTML = buildTabPricingPanel(edition, cardInfo?.querySelector('.drawer-name')?.textContent || '');
        }

        playGridShift();
    });

    drawer.querySelectorAll('.drawer-edition-tile img').forEach(img => {
        img.classList.remove('edition-selected');
    });

    document.getElementById(`${cfg.tilePrefix}${editionId}`)?.classList.add('edition-selected');
}

function selectDrawerEdition(editionId) {
    return selectDrawerEditionFor('card-drawer', editionId);
}
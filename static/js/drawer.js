let drawerIsOpen = false;
let drawerCardData = null;
let drawerActiveTab = 'info';

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
        return printing
            ? `<span class="collector-badge collector-badge--printing">Printing</span>`
            : `<span class="collector-badge collector-badge--oop">Out of Print</span>`;
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

const PRICING_CHART_W = 400;
const PRICING_CHART_H = 140;
const PRICING_CHART_PAD = {top: 14, right: 10, bottom: 20, left: 46};

// The drawer's chart is a brief, at-a-glance snapshot — cap each series to its
// most recent points rather than plotting a card's entire trade history. Full
// history stays available from the Prices page's watchlist.
const PRICING_CHART_MAX_POINTS = 5;

// Best-to-worst condition order, matching CONDITION_MAP in api_tcgplayer.py —
// used both to sort each chart's legend/lines and to rank how much a line's
// color is lightened (Near Mint stays full-strength, worse grades fade out).
const PRICING_CONDITION_ORDER = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

// A sale/listing's "info" carries the raw condition text, which for foil
// entries ends in " Foil" (e.g. "Near Mint Foil") — stripped here since the
// chart is already scoped to one foil's own section, so the suffix is redundant.
function normalizePricingCondition(info) {
    return (info || '').replace(/\s+Foil$/i, '').trim() || 'Unknown';
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
        const condition = normalizePricingCondition(e.info);
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
           data-condition="${escapeHtml(p.info || '')}"
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

    const legendMenuHTML = `
        <div class="pricing-legend-menu">
            ${series.map((s, i) => {
                // Series are built sales-first then listings (see above), so
                // a type change only ever happens once — right at that
                // boundary — and only when both actually appear.
                const separator = i > 0 && series[i - 1].type !== s.type ? '<div class="pricing-legend-separator"></div>' : '';
                return `${separator}
                <div class="pricing-legend-toggle" data-series-key="${escapeHtml(s.key)}" onclick="togglePricingSeries(this)">
                    <span class="pricing-legend-swatch" style="background:${s.color}"></span>
                    <span class="pricing-legend-toggle-label">${escapeHtml(s.label)}</span>
                </div>`;
            }).join('')}
        </div>`;

    const all = series.flatMap(s => s.entries);

    if (all.length === 0) {
        return useLegendMenu
            ? `<div class="pricing-empty">No pricing data available.</div>`
            : legendHTML + `<div class="pricing-empty">No pricing data available.</div>`;
    }

    // When the caller supplies its own measured pixel size (the Prices page's
    // graph panel), the viewBox matches it exactly — 1 viewBox unit = 1
    // rendered pixel — so the chart fills the panel without preserveAspectRatio
    // non-uniformly stretching a fixed box and distorting dots/text. The
    // drawer's own charts don't pass these and keep the fixed 400×140 sizing.
    const w = Number.isFinite(widthPx) ? widthPx : PRICING_CHART_W;
    const h = Number.isFinite(heightPx) ? heightPx : PRICING_CHART_H;
    const pad = PRICING_CHART_PAD;
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    const times = all.map(e => new Date(e.date).getTime());
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const timeSpan = (maxTime - minTime) || 1;

    const prices = all.map(e => e.price);
    const rawMin = Math.min(...prices);
    const rawMax = Math.max(...prices);
    const span = (rawMax - rawMin) || Math.max(rawMax * 0.2, 1);
    const minPrice = rawMin - span * 0.15;
    const maxPrice = rawMax + span * 0.15;

    const singleTime = minTime === maxTime;
    const xAt = date => singleTime ? pad.left + plotW / 2 : pad.left + ((new Date(date).getTime() - minTime) / timeSpan) * plotW;
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
    const lastDate = all.reduce((max, e) => e.date > max ? e.date : max, all[0].date);

    const dateLabelsHTML = `
        <text x="${pad.left}" y="${(h - 4).toFixed(1)}" class="pricing-chart-axis-label" text-anchor="start">${escapeHtml(firstDate)}</text>
        ${firstDate !== lastDate ? `<text x="${(w - pad.right).toFixed(1)}" y="${(h - 4).toFixed(1)}" class="pricing-chart-axis-label" text-anchor="end">${escapeHtml(lastDate)}</text>` : ''}`;

    const linesHTML = marks.map(m => `<path d="${m.linePath}" style="stroke:${m.color}" class="pricing-chart-line" data-series-key="${escapeHtml(m.key)}" fill="none" />`).join('');
    const dotsHTML = marks.map(m => m.dotsHTML).join('');

    // Explicit pixel width/height (not the default width:100%/height:auto CSS)
    // so the rendered box matches the viewBox exactly instead of deriving
    // height from width via the fixed aspect ratio.
    const svgStyle = (Number.isFinite(widthPx) || Number.isFinite(heightPx)) ? ` style="width:${w}px;height:${h}px"` : '';

    const svgHTML = `
        <svg class="pricing-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"${svgStyle}>
            ${gridlinesHTML}
            ${linesHTML}
            ${dotsHTML}
            ${endLabelsHTML}
            ${dateLabelsHTML}
        </svg>`;

    if (useLegendMenu) {
        return `
            <div class="pricing-chart-row">
                <div class="pricing-chart-canvas">${svgHTML}</div>
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
        const lowest = Math.min(...listings.map(l => l.price));
        stats.push(['Lowest Recent Listing', `$${lowest.toFixed(2)}`]);
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

function buildPricingFoilSection(foilId, label, pricing) {
    const data = pricing?.[foilId] || {listings: [], sales: []};

    return `
        <div class="pricing-section">
            <div class="collector-section-label">${label}</div>
            ${buildPricingStats(data.sales, data.listings)}
            ${buildPricingComboChart(data.sales, data.listings)}
        </div>`;
}

function buildTabPricingPanel(edition) {
    const foils = edition?.foils || {};
    const pricing = edition?.pricing || {};

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

    const sections = [];

    if (nonfoilEntry) sections.push(buildPricingFoilSection(nonfoilEntry[0], 'Non-Foil', pricing));
    if (foilEntry) sections.push(buildPricingFoilSection(foilEntry[0], 'Foil', pricing));
    specials.forEach(([fid, f]) => sections.push(buildPricingFoilSection(fid, toFoilLabel(f.kind), pricing)));

    return sections.join('');
}

function switchDrawerTab(tab, drawerId = 'card-drawer') {
    const isCardDrawer = drawerId === 'card-drawer';
    const previousTab = isCardDrawer ? drawerActiveTab : invDrawerActiveTab;

    if (previousTab === tab) return;

    if (isCardDrawer) {
        drawerActiveTab = tab;
    } else {
        invDrawerActiveTab = tab;
    }
    const drawer = document.getElementById(drawerId);
    if (!drawer) return;

    // Update the external floating sidebar
    const sidebarId = isCardDrawer ? 'drawer-sidebar' : 'inv-drawer-sidebar';
    const sidebar = document.getElementById(sidebarId);
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
        incoming.innerHTML = buildTabPricingPanel(edition);
    }

    // Fade out outgoing
    outgoing.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
    outgoing.style.opacity = '0';
    outgoing.style.transform = 'translateY(-6px)';

    setTimeout(() => {
        outgoing.classList.add('hidden');
        outgoing.style.transition = '';
        outgoing.style.opacity = '';
        outgoing.style.transform = '';

        // Fade in incoming
        incoming.classList.remove('hidden');
        incoming.style.opacity = '0';
        incoming.style.transform = 'translateY(6px)';
        incoming.style.transition = 'opacity 0.18s ease, transform 0.18s ease';

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                incoming.style.opacity = '1';
                incoming.style.transform = 'translateY(0)';
            });
        });

        setTimeout(() => {
            incoming.style.transition = '';
            incoming.style.opacity = '';
            incoming.style.transform = '';
        }, 200);
    }, 150);
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
    const isAlreadyOpen = drawerIsOpen;

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
                            <div class="drawer-set">${drawerSetLineHTML(selectedEdition)}</div>
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

            // Mark the selected edition tile immediately
            const initialTile = document.getElementById(`edition-tile-${editionId}`);
            if (initialTile) initialTile.classList.add('edition-selected');

            // Apply active tab to the newly rendered panels
            const cardInfo = drawer.querySelector('.drawer-card-info');
            if (cardInfo && drawerIsOpen && drawerActiveTab !== 'info') {
                const infoPanel = cardInfo.querySelector('.drawer-tab-info');
                const editions = JSON.parse(drawer.dataset.editions || '{}');
                const edition = editions[drawer.dataset.selectedEdition];
                infoPanel.classList.add('hidden');

                if (drawerActiveTab === 'thema') {
                    const themaPanel = cardInfo.querySelector('.drawer-tab-thema');
                    themaPanel.classList.remove('hidden');
                    themaPanel.innerHTML = buildTabThemaPanel(edition);
                } else if (drawerActiveTab === 'pricing') {
                    const pricingPanel = cardInfo.querySelector('.drawer-tab-pricing');
                    pricingPanel.classList.remove('hidden');
                    pricingPanel.innerHTML = buildTabPricingPanel(edition);
                }
            }
        };

        if (drawerIsOpen) {
            const existing = drawerContent.firstElementChild;
            if (existing) {
                existing.style.transition = 'opacity 0.15s ease';
                existing.style.opacity = '0';

                setTimeout(() => {
                    doInsert();
                    inner.style.opacity = '0';
                    inner.style.transition = 'opacity 0.2s ease';
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        inner.style.opacity = '1';
                        setTimeout(() => {
                            inner.style.transition = '';
                            inner.style.opacity = '';
                        }, 220);
                    }));
                }, 150);
            } else {
                doInsert();
            }
        } else {
            doInsert();
        }

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

    // The admin console keeps the footer hidden unconditionally (see initAdmin()
    // in admin.js) — it has no scrollable card grid to key footer visibility off of,
    // so closing the drawer there must not reveal it.
    const onAdminPage = !!document.getElementById('admin-page');
    const gridWrap = document.querySelector('.card-grid-wrap');

    if (!onAdminPage && (!gridWrap || gridWrap.scrollTop === 0)) {
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
            setEl.innerHTML = drawerSetLineHTML(edition);
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

    // If a data-driven tab is active, re-render for the new edition
    if (drawerActiveTab === 'thema') {
        const cardInfo = drawer.querySelector('.drawer-card-info');
        const themaPanel = cardInfo?.querySelector('.drawer-tab-thema');
        if (themaPanel) themaPanel.innerHTML = buildTabThemaPanel(edition);
    } else if (drawerActiveTab === 'pricing') {
        const cardInfo = drawer.querySelector('.drawer-card-info');
        const pricingPanel = cardInfo?.querySelector('.drawer-tab-pricing');
        if (pricingPanel) pricingPanel.innerHTML = buildTabPricingPanel(edition);
    }
}
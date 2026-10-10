// ── Events page ──
// Omnidex organized-play events stored locally (see events_ga.py). The list
// comes from /api/events; selecting one loads /api/events/{id}, which also
// re-syncs a still-running event whose copy has gone stale. Cards admins get
// an Add box plus Refresh / Delete on the selected event.

let eventsList = [];
let eventsDetail = null;
let eventsSelectedId = null;
let eventsTab = 'standings';
let eventsCanManage = false;
let eventsLookupBusy = false;   // a search-bar API lookup is in flight

const EVENT_CATEGORY_LABELS = {
    'worlds': 'Worlds',
    'nationals': 'Nationals',
    'regionals': 'Regionals',
    'ascent': 'Ascent',
    'store-championships': 'Store Championship',
    'regular': 'Regular',
};

const EVENT_STATUS_LABELS = {
    'rsvp': 'RSVP',
    'starting': 'Starting',
    'started': 'Live',
    'completable': 'Finishing',
    'complete': 'Complete',
    'canceled': 'Canceled',
    'canceled-reset': 'Canceled',
    'canceled-suspended': 'Canceled',
};

function eventCategoryLabel(c) {
    return EVENT_CATEGORY_LABELS[c] || (c ? c.replace(/-/g, ' ') : '—');
}

function eventFormatLabel(f) {
    if (!f) return '—';
    if (f === 'team-standard-3v3') return 'Team Standard 3v3';
    return f.replace(/-/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

function eventStatusTag(status) {
    const label = EVENT_STATUS_LABELS[status] || status || '—';
    const hue = status === 'complete' ? 'success'
        : (status === 'started' || status === 'starting' || status === 'completable') ? 'gold'
        : (status || '').startsWith('canceled') ? '' : 'slate';
    return `<span class="tag ${hue ? 'tag--' + hue : ''}">${escapeHtml(label)}</span>`;
}

function eventDate(iso, withTime = false) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const opts = {year: 'numeric', month: 'short', day: 'numeric'};
    if (withTime) Object.assign(opts, {hour: 'numeric', minute: '2-digit'});
    return d.toLocaleString(undefined, opts);
}

function eventPct(v) {
    return typeof v === 'number' ? `${v.toFixed(1)}%` : '—';
}

function eventPlacement(n) {
    if (n == null) return '—';
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── Init / list ──

window.initEvents = async function () {
    eventsCanManage = typeof ADMIN_CARDS_RANKS !== 'undefined' && ADMIN_CARDS_RANKS.has(authType);

    eventsDetail = null;
    eventsTab = 'standings';
    eventsLookupBusy = false;
    renderEventCategoryDropdown([]);
    document.getElementById('events-filter-category')
        ?.addEventListener('dropdown:change', renderEventList);
    await loadEventList();

    const id = parseInt(new URLSearchParams(window.location.search).get('event'), 10);
    if (id) await selectEvent(id, false);
};

// Category filter — the shared .select-dropdown (dropdown.js), rebuilt from
// whatever categories the stored events actually have.
function renderEventCategoryDropdown(categories) {
    const wrap = document.getElementById('events-filter-category');
    if (!wrap) return;
    const current = selectDropdownValue(wrap) || '';
    const options = [{value: '', label: 'All categories'},
        ...categories.map(c => ({value: c, label: eventCategoryLabel(c)}))];
    wrap.innerHTML = selectDropdownHTML(options, categories.includes(current) ? current : '');
}

async function loadEventList() {
    const listEl = document.getElementById('events-list');
    try {
        const res = await fetch('/api/events');
        const data = await res.json();
        eventsList = data.events || [];
    } catch {
        eventsList = [];
        if (listEl) listEl.innerHTML = '<div class="events-empty">Could not load events.</div>';
        return;
    }

    renderEventCategoryDropdown([...new Set(eventsList.map(e => e.category).filter(Boolean))].sort());
    renderEventList();
}

// An Omnidex event ID ("27292", "#27292") or event URL typed into the search
// bar — mirrors events_ga.parse_event_id. null for ordinary search text.
function parseEventSearchId(text) {
    const t = (text || '').trim();
    const m = t.match(/events\/(\d+)/) || t.match(/^#?(\d{1,10})$/);
    return m ? parseInt(m[1], 10) : null;
}

function renderEventList() {
    const listEl = document.getElementById('events-list');
    if (!listEl) return;

    const raw = document.getElementById('events-filter-input')?.value || '';
    const q = raw.trim().toLowerCase();
    const searchId = parseEventSearchId(raw);
    const cat = selectDropdownValue(document.getElementById('events-filter-category')) || '';

    if (!eventsLookupBusy) setEventsSearchMsg('');

    const shown = eventsList.filter(e => {
        if (cat && e.category !== cat) return false;
        if (searchId != null) return e.event_id === searchId;
        if (!q) return true;
        return [e.name, e.host_name, e.season_name]
            .some(v => (v || '').toLowerCase().includes(q));
    });

    const countEl = document.getElementById('events-count');
    if (countEl) countEl.textContent = eventsList.length ? `${shown.length} / ${eventsList.length}` : '';

    // An ID that isn't stored yet — offer to pull it from the Omnidex, the
    // way a card search falls back to the API for a card it doesn't have.
    if (searchId != null && !eventsList.some(e => e.event_id === searchId)) {
        listEl.innerHTML = `
            <button type="button" class="events-lookup-row" onclick="lookupEvent()" ${eventsLookupBusy ? 'disabled' : ''}>
                <span class="events-lookup-title">${eventsLookupBusy
                    ? `Fetching event #${searchId}…` : `Look up event #${searchId}`}</span>
                <span class="events-lookup-sub">Not stored yet — press Enter to fetch it from the Omnidex.</span>
            </button>`;
        return;
    }

    if (!eventsList.length) {
        listEl.innerHTML = '<div class="events-empty">No events stored yet. Enter an Omnidex event ID or URL above to look one up.</div>';
        return;
    }
    if (!shown.length) {
        listEl.innerHTML = '<div class="events-empty">No events match. Have its Omnidex ID? Enter it above.</div>';
        return;
    }

    listEl.innerHTML = shown.map(e => `
        <button type="button" class="events-row ${e.event_id === eventsSelectedId ? 'active' : ''}"
                data-event-id="${e.event_id}" onclick="selectEvent(${e.event_id})">
            <div class="events-row-top">
                <span class="events-row-name">${escapeHtml(e.name)}</span>
                ${eventStatusTag(e.status)}
            </div>
            <div class="events-row-meta">
                <span>${escapeHtml(eventDate(e.start_at))}</span>
                <span>·</span>
                <span>${escapeHtml(eventCategoryLabel(e.category))}</span>
                <span>·</span>
                <span>${e.player_count} players</span>
            </div>
            <div class="events-row-host">${escapeHtml(e.host_name || '')}${e.host_country
                ? ` <span class="events-muted">(${escapeHtml(e.host_country)})</span>` : ''}</div>
        </button>`).join('');
}

// ── Lookup (search bar) ──

function setEventsSearchMsg(text, isError = false) {
    const el = document.getElementById('events-search-msg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
    el.classList.toggle('error', isError);
}

function handleEventSearchKeydown(e) {
    if (e.key !== 'Enter') return;
    const searchId = parseEventSearchId(e.target.value);
    if (searchId == null) return;
    e.preventDefault();
    if (eventsList.some(ev => ev.event_id === searchId)) {
        selectEvent(searchId);
    } else {
        lookupEvent();
    }
}

async function lookupEvent() {
    const input = document.getElementById('events-filter-input');
    const searchId = parseEventSearchId(input?.value);
    if (searchId == null || eventsLookupBusy) return;

    eventsLookupBusy = true;
    renderEventList();
    let res;
    try {
        res = await fetch('/api/events/lookup', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({event: input.value.trim()}),
        });
    } catch {
        eventsLookupBusy = false;
        renderEventList();
        setEventsSearchMsg('Could not reach the server.', true);
        return;
    }

    // An unhandled server error comes back as plain text, not JSON.
    const data = await res.json().catch(() => ({}));
    eventsLookupBusy = false;
    if (!res.ok) {
        renderEventList();
        setEventsSearchMsg(data.detail || `Server error (${res.status}) — check the server log.`, true);
        return;
    }

    input.value = '';
    await loadEventList();
    // Clearing the search re-lists everything, so the new event may sit far
    // down the list — scroll it into view and flash it (see selectEvent).
    await selectEvent(data.event.event_id, true, {flash: data.fetched});
}

// ── Refresh / delete (cards admins) ──

async function refreshEvent() {
    if (!eventsSelectedId) return;
    const btn = document.getElementById('events-refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
    try {
        const res = await fetch(`/api/events/${eventsSelectedId}/refresh`, {method: 'POST'});
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.detail || 'Refresh failed.');
        }
        await loadEventList();
        await selectEvent(eventsSelectedId, false);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
    }
}

async function deleteEvent() {
    if (!eventsSelectedId || !eventsDetail) return;
    const ok = await appConfirm(`Remove "${eventsDetail.event.name}" from stored events?`,
        {title: 'Remove Event', confirmLabel: 'Remove'});
    if (!ok) return;

    const res = await fetch(`/api/events/${eventsSelectedId}`, {method: 'DELETE'});
    if (!res.ok) return;
    eventsSelectedId = null;
    eventsDetail = null;
    window.history.replaceState({}, '', '/events');
    const el = document.getElementById('events-detail');
    await Promise.all([fadeSwap(el, () => renderEventDetailPlaceholder()), loadEventList()]);
}

// ── Detail ──

function renderEventDetailPlaceholder(message) {
    const el = document.getElementById('events-detail');
    if (!el) return;
    el.innerHTML = `
        <div class="events-placeholder">
            <span class="inv-empty-icon">🏆</span>
            <p>${escapeHtml(message || 'Select an event to see its standings, pairings, and decklists.')}</p>
        </div>`;
}

// Scrolls the event list (only the list — never the page) just far enough to
// show `eventId`'s row: a no-op when it's already visible, so ordinary clicks
// don't jump. `flash` briefly highlights it — used for a freshly fetched event.
function revealEventRow(eventId, {flash = false} = {}) {
    const list = document.getElementById('events-list');
    const row = list?.querySelector(`.events-row[data-event-id="${eventId}"]`);
    if (!row) return;

    const top = row.offsetTop - list.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) {
        list.scrollTo({top, behavior: 'smooth'});
    } else if (bottom > list.scrollTop + list.clientHeight) {
        list.scrollTo({top: bottom - list.clientHeight, behavior: 'smooth'});
    }

    if (flash) {
        row.classList.remove('events-row--new');
        void row.offsetWidth;   // restart the animation if it's already applied
        row.classList.add('events-row--new');
    }
}

// How long the fade-out waits on the detail fetch before showing "Loading…"
// instead — a stale live event re-syncs on open, which can take seconds.
const EVENT_LOADING_AFTER_MS = 250;

async function fetchEventDetail(eventId) {
    try {
        const res = await fetch(`/api/events/${eventId}`);
        if (!res.ok) {
            return {error: res.status === 404 ? "That event isn't stored." : 'Could not load the event.'};
        }
        return {data: await res.json()};
    } catch {
        return {error: 'Could not load the event.'};
    }
}

function applyEventDetail(result) {
    if (result.error) {
        renderEventDetailPlaceholder(result.error);
        return;
    }
    const data = result.data;
    eventsDetail = data;
    eventsDetail.siteUsers = new Set(data.site_users || []);
    eventsDetail.byId = new Map([...data.players, ...data.judges].map(p => [p.player_id, p]));

    if (data.refreshed) loadEventList();

    const tabs = eventTabs();
    if (!tabs.some(t => t.id === eventsTab)) eventsTab = tabs[0].id;
    renderEventDetail();
}

// Switching events fades the detail out and the new one in (fadeSwap,
// animation.js). The fetch runs alongside the fade-out; if it isn't back
// shortly after, "Loading…" fades in first and the event follows it.
async function selectEvent(eventId, updateUrl = true, {flash = false} = {}) {
    eventsSelectedId = eventId;
    renderEventList();
    revealEventRow(eventId, {flash});

    if (updateUrl) window.history.replaceState({}, '', `/events?event=${eventId}`);

    const el = document.getElementById('events-detail');
    if (!el) return;

    const load = fetchEventDetail(eventId);
    let result = null;

    await fadeSwap(el, async () => {
        result = await Promise.race([load, sleep(EVENT_LOADING_AFTER_MS).then(() => null)]);
        // A newer click took over — its own fadeSwap renders the panel.
        if (eventsSelectedId !== eventId) return;
        if (result) applyEventDetail(result);
        else el.innerHTML = '<div class="events-placeholder"><p>Loading…</p></div>';
    });

    if (result) return;
    result = await load;
    if (eventsSelectedId !== eventId) return;
    await fadeSwap(el, () => applyEventDetail(result));
}

function eventIsTeam() {
    return (eventsDetail?.event.format || '').startsWith('team-');
}

function eventTabs() {
    const d = eventsDetail;
    const tabs = [];
    if (d.standings.length) tabs.push({id: 'standings', label: 'Standings'});
    if (d.rounds.length) tabs.push({id: 'pairings', label: 'Pairings'});
    tabs.push({id: 'players', label: eventIsTeam() ? 'Teams' : 'Players'});
    if (d.decklists.length) tabs.push({id: 'decklists', label: 'Decklists'});
    if (d.judges.length) tabs.push({id: 'judges', label: 'Judges'});
    return tabs;
}

function renderEventDetail() {
    const el = document.getElementById('events-detail');
    if (!el || !eventsDetail) return;
    const e = eventsDetail.event;

    const facts = [
        ['Date', eventDate(e.start_at, true)],
        ['Format', eventFormatLabel(e.format)],
        ['Category', eventCategoryLabel(e.category)],
        ['Players', e.team_count ? `${e.player_count} (${e.team_count} teams)` : String(e.player_count)],
        ['Swiss', e.swiss_rounds ? `${e.swiss_rounds} rounds${e.swiss_match_config ? ' · ' + e.swiss_match_config : ''}` : '—'],
        ['Top cut', e.se_cut_size ? `Top ${e.se_cut_size}${e.se_match_config ? ' · ' + e.se_match_config : ''}` : '—'],
        ['Season', e.season_name || '—'],
        ['Setting', e.setting ? e.setting[0].toUpperCase() + e.setting.slice(1) : '—'],
    ];

    const tabs = eventTabs();
    const map = eventMapHtml(e);

    el.innerHTML = `
        <div class="events-detail-header">
            <div class="events-detail-title-row">
                <h2 class="events-detail-title">${escapeHtml(e.name)}</h2>
                <div class="events-detail-actions">
                    <a class="btn btn--ghost" href="${escapeHtml(e.url)}" target="_blank" rel="noopener">Omnidex ↗</a>
                    ${eventsCanManage ? `
                        <button class="btn btn--subtle" id="events-refresh-btn" onclick="refreshEvent()">Refresh</button>
                        <button class="btn btn--subtle events-delete-btn" onclick="deleteEvent()">Remove</button>` : ''}
                </div>
            </div>
            <div class="events-overview ${map ? 'has-map' : ''}">
                <div class="events-overview-main">
                    <div class="events-detail-tags">
                        ${eventStatusTag(e.status)}
                        ${e.ranked ? '<span class="tag tag--accent">Ranked</span>' : ''}
                        ${e.vp_multiplier && e.vp_multiplier !== 1 ? `<span class="tag tag--mint">${e.vp_multiplier}× VP</span>` : ''}
                        <span class="events-detail-host">${escapeHtml(e.host_name || '')}${e.host_address
                            ? ` <span class="events-muted">— ${escapeHtml(e.host_address)}</span>` : ''}</span>
                    </div>
                    <div class="events-facts">
                        ${facts.map(([k, v]) => `
                            <div class="events-fact">
                                <span class="label label--muted label--sm">${k}</span>
                                <span class="events-fact-value">${escapeHtml(v)}</span>
                            </div>`).join('')}
                    </div>
                    ${e.description ? `<p class="events-description">${escapeHtml(e.description)}</p>` : ''}
                    <div class="events-synced events-muted">Synced ${escapeHtml(eventDate(e.last_synced, true))}</div>
                </div>
                ${map}
            </div>
        </div>
        <div class="events-tabs" role="tablist">
            ${tabs.map(t => `
                <button type="button" class="events-tab ${t.id === eventsTab ? 'active' : ''}"
                        role="tab" onclick="switchEventTab('${t.id}')">${t.label}</button>`).join('')}
        </div>
        <div class="events-tab-body scroll-thin" id="events-tab-body"></div>`;

    renderEventTab();
}

// Location map for in-person events, filling the right of the event header.
// The API only gives the host's street address (no coordinates), which
// Google's keyless embed can pin directly — nothing is geocoded or stored
// server-side. The embed's own large "Maps" button (top-left, inside the
// iframe, so it can't be styled) is cropped off by sliding the iframe up
// under the container's top edge; a small link of ours sits top-right
// instead. Google's attribution along the bottom stays visible. Skipped for
// online events or a host with no address.
function eventMapHtml(e) {
    const address = (e.host_address || '').trim();
    if (!address || e.setting === 'online') return '';

    const q = encodeURIComponent(address);
    return `
        <div class="events-map">
            <iframe class="events-map-frame" title="Map of ${escapeHtml(e.host_name || address)}"
                    src="https://maps.google.com/maps?q=${q}&z=15&output=embed"
                    loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
            <a class="events-map-link" href="https://www.google.com/maps/search/?api=1&query=${q}"
               target="_blank" rel="noopener" title="Open in Google Maps">Maps ↗</a>
        </div>`;
}

// The tab underline moves at once; the body fades between the two tabs.
function switchEventTab(tab) {
    if (tab === eventsTab) return;
    eventsTab = tab;
    document.querySelectorAll('.events-tab').forEach(b =>
        b.classList.toggle('active', b.getAttribute('onclick') === `switchEventTab('${tab}')`));
    const body = document.getElementById('events-tab-body');
    // renderEventTab reads eventsTab when the swap happens, so quick
    // successive clicks all land on the last tab picked.
    fadeSwap(body, renderEventTab);
}

function renderEventTab() {
    const body = document.getElementById('events-tab-body');
    if (!body) return;
    const render = {
        standings: renderEventStandings,
        pairings: renderEventPairings,
        players: eventIsTeam() ? renderEventTeams : renderEventPlayers,
        decklists: renderEventDecklists,
        judges: renderEventJudges,
    }[eventsTab];
    body.innerHTML = render ? render() : '';
    body.scrollTop = 0;
}

// A player's display name, linked to their GA Library profile when they
// have an account here (matched by Omnidex ID).
function eventPlayerName(playerId) {
    const p = eventsDetail.byId.get(playerId);
    const name = escapeHtml(p?.username || `#${playerId}`);
    return eventsDetail.siteUsers.has(playerId)
        ? `<a class="events-player-link" href="#${playerId}" data-link title="GA Library profile">${name}</a>`
        : name;
}

function eventSideName(id) {
    return typeof id === 'number' ? eventPlayerName(id) : escapeHtml(String(id ?? '—'));
}

function eventEmblem(p) {
    if (!p?.emblem || p.emblem === 'unranked') return '';
    return `<span class="events-emblem events-emblem--${escapeHtml(p.emblem)}">${escapeHtml(p.emblem)}</span>`;
}

function renderEventStandings() {
    const rows = eventsDetail.standings.map(s => {
        const st = s.stats || {};
        const who = s.team_name != null ? escapeHtml(s.team_name) : eventPlayerName(s.player_id);
        return `
            <tr class="${s.final_placement === 1 ? 'events-winner' : ''}">
                <td class="events-num">${s.position}</td>
                <td>${who}</td>
                <td class="events-num">${st.statsScore ?? '—'}</td>
                <td class="events-num">${st.statsWins ?? 0}-${st.statsLosses ?? 0}-${st.statsTies ?? 0}</td>
                <td class="events-num">${eventPct(st.statsPercentOMW)}</td>
                <td class="events-num">${eventPct(st.statsPercentGW)}</td>
                <td class="events-num">${eventPct(st.statsPercentOGW)}</td>
                <td class="events-num">${eventPlacement(s.final_placement)}</td>
            </tr>`;
    }).join('');
    return `
        <table class="events-table">
            <thead><tr>
                <th>#</th><th>${eventIsTeam() ? 'Team' : 'Player'}</th><th>Pts</th><th>W-L-T</th>
                <th title="Opponents' match win %">OMW</th><th title="Game win %">GW</th>
                <th title="Opponents' game win %">OGW</th><th>Final</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function renderEventPairings() {
    return eventsDetail.rounds.map(r => {
        const stageName = r.stage_type === 'single-elimination' ? 'Top Cut' : 'Swiss';
        const matches = r.matches.map(m => {
            const [a, b] = m.pairing;
            const side = p => p ? `
                <span class="events-side events-side--${escapeHtml(p.status || '')}">
                    ${eventSideName(p.id)}${p.dropped ? ' <span class="events-muted">(drop)</span>' : ''}
                </span>` : '<span class="events-side events-muted">—</span>';
            const score = a && b ? `${a.score ?? 0} – ${b.score ?? 0}` : (a?.status === 'byed' ? 'Bye' : '');
            return `
                <div class="events-match">
                    ${m.label ? `<div class="events-match-label label label--muted label--sm">${escapeHtml(m.label)}</div>` : ''}
                    <div class="events-match-row">${side(a)}<span class="events-score">${score}</span>${b ? side(b) : '<span class="events-side"></span>'}</div>
                </div>`;
        }).join('');
        return `
            <div class="events-round">
                <div class="events-round-title label">${stageName} · Round ${r.round_id}
                    <span class="events-muted">(${r.matches.length})</span></div>
                <div class="events-match-grid">${matches}</div>
            </div>`;
    }).join('');
}

function renderEventPlayers() {
    const rows = eventsDetail.players.map(p => `
        <tr>
            <td class="events-num">${eventPlacement(p.final_placement)}</td>
            <td>${eventPlayerName(p.player_id)}</td>
            <td>${escapeHtml(p.country || '')}</td>
            <td>${eventEmblem(p)}</td>
            <td class="events-num">${p.cp ?? '—'}</td>
            <td class="events-num">${p.rank ?? '—'}</td>
        </tr>`).join('');
    return `
        <table class="events-table">
            <thead><tr><th>Final</th><th>Player</th><th>Country</th><th>Emblem</th><th>CP</th><th>Rank</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

function renderEventTeams() {
    return `<div class="events-team-grid">${eventsDetail.teams.map(t => `
        <div class="events-team">
            <div class="events-team-head">
                <span class="events-team-name">${escapeHtml(t.name)}</span>
                <span class="events-muted">${eventPlacement(t.final_placement)}</span>
            </div>
            ${t.players.map(id => `<div class="events-team-member">${eventPlayerName(id)} ${eventEmblem(eventsDetail.byId.get(id))}</div>`).join('')}
        </div>`).join('')}</div>`;
}

function renderEventDecklists() {
    const placement = id => eventsDetail.byId.get(id)?.final_placement ?? Infinity;
    const lists = [...eventsDetail.decklists]
        .filter(d => d.visible)
        .sort((a, b) => placement(a.player_id) - placement(b.player_id));

    const section = (title, cards) => {
        if (!cards?.length) return '';
        const total = cards.reduce((n, c) => n + (c.quantity || 0), 0);
        return `
            <div class="events-deck-section">
                <div class="label label--muted label--sm">${title} (${total})</div>
                ${cards.map(c => `
                    <div class="events-deck-card">
                        <span class="events-num">${c.quantity}</span>
                        <a href="/cards?q=${encodeURIComponent(c.card)}" data-link>${escapeHtml(c.card)}</a>
                    </div>`).join('')}
            </div>`;
    };

    if (!lists.length) return '<div class="events-empty">No public decklists.</div>';

    return lists.map(d => {
        const p = eventsDetail.byId.get(d.player_id);
        return `
            <details class="events-deck">
                <summary>
                    <span class="events-num">${eventPlacement(p?.final_placement)}</span>
                    <span>${eventPlayerName(d.player_id)}</span>
                    ${p?.team_name ? `<span class="events-muted">${escapeHtml(p.team_name)}</span>` : ''}
                </summary>
                <div class="events-deck-body">
                    ${section('Material', d.material)}
                    ${section('Main', d.main)}
                    ${section('Sideboard', d.sideboard)}
                </div>
            </details>`;
    }).join('');
}

function renderEventJudges() {
    const rows = eventsDetail.judges.map(j => `
        <tr>
            <td>${eventPlayerName(j.player_id)}</td>
            <td>${escapeHtml(j.country || '')}</td>
            <td class="events-num">${j.judge_level ?? '—'}</td>
        </tr>`).join('');
    return `
        <table class="events-table">
            <thead><tr><th>Judge</th><th>Country</th><th>Judge level</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
}

// ── Admin → Cards → Events (the Timeline) ──
// Admin-curated dated milestones — set releases, World / Ascent tournaments,
// banlist updates — stored by timeline.py (/api/admin/timeline), so other
// features can line their data up against them later.
//
// Not a mode of the card grid like Info / Pricing / Needs Action: Events swaps
// #admin-cards-view out for its own list + editor (#admin-tl-view), and the
// header's search / "+ Add" button for its own (.admin-tl-only, see
// admin_timeline.css). switchAdminCardsView (admin.js) hands any move to or
// from it to switchAdminCardsEventsView below.
//
// A tournament the Omnidex knows about is linked by its event id. Linking
// goes through /api/events/lookup, so an event that isn't stored yet gets
// fetched and stored the same way the Events page's search bar does it; the
// Events page shows the link from its side (a chip on the event, see
// renderEventDetail in events.js, which also offers "+ Timeline" to admins).

const ADMIN_TL_CATEGORIES = [
    {value: 'set_release', label: 'Set Release', tag: 'tag--gold'},
    {value: 'tournament', label: 'Tournament', tag: 'tag--accent'},
    {value: 'banlist', label: 'Banlist', tag: 'tag--slate'},
    {value: 'announcement', label: 'Announcement', tag: 'tag--mint'},
    {value: 'other', label: 'Other', tag: ''},
];

// The filter pill's "Other" covers both of the minor categories.
const ADMIN_TL_FILTER_GROUPS = {other: ['announcement', 'other']};

// How many rows get the staggered entrance on a full list render — beyond
// this the rest just appear (they're off-screen anyway).
const ADMIN_TL_REVEAL_ROWS = 14;

let adminTlEntries = [];
let adminTlLoaded = false;
let adminTlLoading = null;      // the in-flight loadAdminTimeline() promise
let adminTlError = null;
let adminTlOmnidex = new Map(); // stored Omnidex events by id (/api/events summaries)
let adminTlSelectedId = null;   // the entry open in the editor (null for a new one / none)
let adminTlDraft = null;        // the editor's working copy, or null when it's empty
let adminTlDirty = false;
let adminTlFilter = 'all';
let adminTlSets = null;         // [{prefix, name}] for the Set picker, once loaded
let adminTlSaving = false;
let adminTlLinkBusy = false;
let adminTlPendingLink = null;  // ?link={omnidex id} — open a new entry linked to it (Events page "+ Timeline")

function adminTlCategory(value) {
    return ADMIN_TL_CATEGORIES.find(c => c.value === value) || ADMIN_TL_CATEGORIES[ADMIN_TL_CATEGORIES.length - 1];
}

function adminTlCategoryTagHtml(value) {
    const c = adminTlCategory(value);
    return `<span class="tag ${c.tag}">${escapeHtml(c.label)}</span>`;
}

// 'YYYY-MM-DD' (no time zone — the day as entered) -> a local Date.
function adminTlParseDay(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, d) : null;
}

function adminTlIsoDay(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function adminTlDayLabel(iso, withYear = false) {
    const d = adminTlParseDay(iso);
    if (!d) return '—';
    return d.toLocaleDateString(undefined, withYear
        ? {month: 'short', day: 'numeric', year: 'numeric'}
        : {month: 'short', day: 'numeric'});
}

function adminTlSortEntries() {
    adminTlEntries.sort((a, b) => (b.start_date || '').localeCompare(a.start_date || '') || b.id - a.id);
}

// Called from initAdmin (admin.js) on every admin load, before syncAdminUrl
// — that writes ?entry= back from adminTlSelectedId.
function resetAdminTimelineState() {
    adminTlEntries = [];
    adminTlLoaded = false;
    adminTlLoading = null;
    adminTlError = null;
    adminTlOmnidex = new Map();
    adminTlDraft = null;
    adminTlDirty = false;
    adminTlFilter = 'all';
    adminTlSaving = false;
    adminTlLinkBusy = false;

    const params = new URLSearchParams(window.location.search);
    const entry = parseInt(params.get('entry'), 10);
    const link = parseInt(params.get('link'), 10);
    adminTlSelectedId = adminCardsView === 'events' && Number.isFinite(entry) ? entry : null;
    adminTlPendingLink = adminCardsView === 'events' && Number.isFinite(link) ? link : null;
}

// Settles the page straight into (or out of) Events on load — no animation,
// same as the rest of initAdmin.
function initAdminTimeline() {
    const section = document.getElementById('admin-section-pricing');
    const on = adminCardsView === 'events';

    section?.classList.toggle('admin-cards-mode-events', on);
    document.getElementById('admin-cards-view')?.classList.toggle('hidden', on);
    document.getElementById('admin-tl-view')?.classList.toggle('hidden', !on);
    syncAdminTimelineFilterPill();

    // The editor is rebuilt from state, so the dropdown listener binds to the
    // (fresh, per admin load) editor element once.
    const editor = document.getElementById('admin-tl-editor');
    if (editor && !editor._adminTlBound) {
        editor._adminTlBound = true;
        editor.addEventListener('dropdown:change', e => {
            const field = e.target.closest('[data-tl-field]')?.dataset.tlField;
            if (field) onAdminTimelineField(field, e.detail.value);
        });
    }

    if (!on) return;

    renderAdminTimelineList();
    renderAdminTimelineEditor();
    loadAdminTimeline().then(() => {
        adminTlApplyLoadedSelection();
        renderAdminTimelineList({reveal: true});
        renderAdminTimelineEditor();
    });
}

// The pill's 4th option. The card grid sat hidden in whichever mode it was
// left in, so leaving Events settles it straight into the new one — there's
// nothing on screen to animate from.
async function switchAdminCardsEventsView(view) {
    const section = document.getElementById('admin-section-pricing');
    const cardsView = document.getElementById('admin-cards-view');
    const tlView = document.getElementById('admin-tl-view');
    if (!section || !cardsView || !tlView) return;

    const entering = view === 'events';
    if (!entering && !await adminTlConfirmDiscard()) return;

    if (view === 'needs-action' && adminPidMarketplace !== 'tcgplayer') {
        await switchAdminPidMarketplace('tcgplayer');
    }

    section.querySelectorAll('.admin-cards-subnav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    positionPillIndicator(section.querySelector('.admin-cards-subnav'));

    // Start the fetch now so it overlaps the fade-out.
    const loading = entering ? loadAdminTimeline() : null;
    const headerSwaps = section.querySelectorAll('.admin-cards-header-row .admin-pid-search, .admin-cards-header-row .admin-custom-add-btn');

    await fadeSwap([cardsView, tlView, ...headerSwaps], async () => {
        adminCardsView = view;
        section.classList.toggle('admin-cards-mode-events', entering);
        cardsView.classList.toggle('hidden', entering);
        tlView.classList.toggle('hidden', !entering);

        if (entering) {
            await loading;
            adminTlApplyLoadedSelection();
            renderAdminTimelineList({reveal: true});
            renderAdminTimelineEditor();
            positionPillIndicator(document.getElementById('admin-tl-filter'));
        } else {
            adminTlDirty = false;
            // Same Pricing-only state switchAdminCardsView closes out.
            adminPidAddEntryOpenType = null;
            adminPidImportOpenType = null;
            adminPidExportOpenType = null;
            adminPidSelected = new Set();

            section.classList.toggle('admin-cards-mode-info', view === 'info');
            section.classList.toggle('admin-cards-mode-na', view === 'needs-action');
            renderAdminPricingDetailAll();
            if (adminPidLoaded) renderAdminPricingIds();
            positionPillIndicator(document.getElementById(
                view === 'needs-action' ? 'admin-na-filter' : 'admin-pid-marketplace-toggle'
            ));
            positionPillIndicator(document.getElementById('admin-pid-source-toggle'));
        }

        syncAdminUrl();
    });

    updateAdminNaPillVisibility();

    if (!entering) {
        if (!adminPidLoaded) loadAdminPricingIds();
        else adminPidScrollToEdition(adminPidDetailSelected);
    }
}

async function loadAdminTimeline({force = false} = {}) {
    if (adminTlLoaded && !force) return;
    if (adminTlLoading) return adminTlLoading;

    adminTlLoading = (async () => {
        try {
            const [tlRes, evRes] = await Promise.all([fetch('/api/admin/timeline'), fetch('/api/events')]);
            const tl = await tlRes.json().catch(() => ({}));
            if (!tlRes.ok) throw new Error(tl.detail || 'Could not load the timeline');

            adminTlEntries = tl.entries || [];
            adminTlSortEntries();
            if (evRes.ok) {
                const ev = await evRes.json();
                adminTlOmnidex = new Map((ev.events || []).map(e => [e.event_id, e]));
            }
            adminTlLoaded = true;
            adminTlError = null;
        } catch (err) {
            adminTlError = err.message;
        } finally {
            adminTlLoading = null;
        }
    })();

    return adminTlLoading;
}

// After a load: open the deep-linked ?entry= (dropped if it's gone), or a
// new entry linked to ?link= (the Events page's "+ Timeline").
function adminTlApplyLoadedSelection() {
    if (adminTlDraft) return;

    if (adminTlPendingLink != null) {
        const eventId = adminTlPendingLink;
        adminTlPendingLink = null;
        adminTlSelectedId = null;
        adminTlDraft = adminTlNewDraft();
        const stored = adminTlOmnidex.get(eventId);
        if (stored) adminTlApplyOmnidexLink(stored, {render: false});
        else adminTlDraft.omnidex_event_id = eventId;
        adminTlDirty = true;
        syncAdminUrl();
        return;
    }

    const entry = adminTlEntries.find(e => e.id === adminTlSelectedId);
    if (entry) {
        adminTlDraft = adminTlDraftFrom(entry);
    } else if (adminTlSelectedId != null) {
        adminTlSelectedId = null;
        syncAdminUrl();
    }
}

// ── List ──

function syncAdminTimelineFilterPill() {
    const pill = document.getElementById('admin-tl-filter');
    pill?.querySelectorAll('.pill-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === adminTlFilter);
    });
    positionPillIndicator(pill);
}

function switchAdminTimelineFilter(filter) {
    if (adminTlFilter === filter) return;
    adminTlFilter = filter;
    syncAdminTimelineFilterPill();

    const list = document.getElementById('admin-tl-list');
    fadeSwap(list, () => renderAdminTimelineList({reveal: true}));
}

function adminTlFilteredEntries() {
    const query = (document.getElementById('admin-tl-search')?.value || '').trim().toLowerCase();
    const group = ADMIN_TL_FILTER_GROUPS[adminTlFilter] || [adminTlFilter];

    return adminTlEntries.filter(e => {
        if (adminTlFilter !== 'all' && !group.includes(e.category)) return false;
        if (!query) return true;
        const linked = e.omnidex_event_id ? adminTlOmnidex.get(e.omnidex_event_id) : null;
        return [e.title, e.notes, e.set_prefix, adminTlCategory(e.category).label, e.start_date,
            e.omnidex_event_id ? `#${e.omnidex_event_id}` : '', linked?.name]
            .some(v => String(v || '').toLowerCase().includes(query));
    });
}

function adminTlRowHtml(e, index, reveal, today) {
    const end = e.end_date && e.end_date !== e.start_date ? e.end_date : null;
    const crossesYear = end && end.slice(0, 4) !== e.start_date.slice(0, 4);
    const upcoming = e.start_date > today;
    const ongoing = !upcoming && end && end >= today;
    const linked = e.omnidex_event_id ? adminTlOmnidex.get(e.omnidex_event_id) : null;

    const chips = [
        adminTlCategoryTagHtml(e.category),
        e.set_prefix ? `<span class="admin-tl-chip">${escapeHtml(e.set_prefix)}</span>` : '',
        e.omnidex_event_id ? `<span class="admin-tl-chip admin-tl-chip-omni" title="Linked Omnidex event">🏆 ${
            escapeHtml(linked ? linked.name : `#${e.omnidex_event_id}`)}</span>` : '',
        ongoing ? '<span class="tag tag--success">Now</span>' : '',
    ].join('');

    return `
        <div class="admin-tl-row${e.id === adminTlSelectedId ? ' admin-tl-row-active' : ''}${upcoming ? ' admin-tl-row-upcoming' : ''}${
                reveal && index < ADMIN_TL_REVEAL_ROWS ? ' admin-tl-row-reveal' : ''}"
             data-id="${e.id}" style="--i:${Math.min(index, ADMIN_TL_REVEAL_ROWS)}"
             onclick="selectAdminTimelineEntry(${e.id})">
            <span class="admin-tl-row-date">
                <span class="admin-tl-row-day">${escapeHtml(adminTlDayLabel(e.start_date, crossesYear))}</span>
                ${end ? `<span class="admin-tl-row-end">to ${escapeHtml(adminTlDayLabel(end, crossesYear))}</span>` : ''}
            </span>
            <span class="admin-tl-row-rail"><span class="admin-tl-row-dot admin-tl-dot-${escapeHtml(e.category)}"></span></span>
            <span class="admin-tl-row-body">
                <span class="admin-tl-row-title">${escapeHtml(e.title)}</span>
                <span class="admin-tl-row-meta">${chips}</span>
            </span>
        </div>
    `;
}

// `reveal` plays the staggered row entrance (a load or filter change — not a
// keystroke in the search box). `flashId` pulses one row (just saved).
function renderAdminTimelineList({reveal = false, flashId = null} = {}) {
    const list = document.getElementById('admin-tl-list');
    const summary = document.getElementById('admin-tl-summary');
    if (!list) return;

    if (!adminTlLoaded) {
        list.innerHTML = `<div class="admin-pid-detail-empty">${adminTlError ? escapeHtml(adminTlError) : 'Loading…'}</div>`;
        if (summary) summary.textContent = '';
        return;
    }

    const today = adminTlIsoDay(new Date());
    const shown = adminTlFilteredEntries();
    const upcomingCount = shown.filter(e => e.start_date > today).length;

    if (summary) {
        summary.textContent = `${shown.length} event${shown.length === 1 ? '' : 's'}`
            + (upcomingCount ? ` · ${upcomingCount} upcoming` : '');
    }

    if (!shown.length) {
        list.innerHTML = `<div class="admin-pid-detail-empty">${adminTlEntries.length
            ? 'No events match.' : 'No events yet — use "+ Add Event" to record the first one.'}</div>`;
        return;
    }

    // Newest first, so upcoming entries lead; a "Today" marker separates them
    // from the past, and a year label opens each year.
    let html = '';
    let year = null;
    let todayPlaced = upcomingCount === 0;
    shown.forEach((e, i) => {
        if (!todayPlaced && e.start_date <= today) {
            html += '<div class="admin-tl-today"><span>Today</span></div>';
            todayPlaced = true;
        }
        const y = e.start_date.slice(0, 4);
        if (y !== year) {
            html += `<div class="admin-tl-year">${escapeHtml(y)}</div>`;
            year = y;
        }
        html += adminTlRowHtml(e, i, reveal, today);
    });
    if (!todayPlaced) html += '<div class="admin-tl-today"><span>Today</span></div>';

    list.innerHTML = html;

    if (flashId != null) {
        const row = list.querySelector(`.admin-tl-row[data-id="${flashId}"]`);
        if (row) {
            row.scrollIntoView({block: 'nearest'});
            row.classList.add('admin-tl-row-flash');
        }
    }
}

function setAdminTimelineActiveRow() {
    document.querySelectorAll('#admin-tl-list .admin-tl-row').forEach(row => {
        row.classList.toggle('admin-tl-row-active', Number(row.dataset.id) === adminTlSelectedId);
    });
}

// ── Editor ──

function adminTlNewDraft() {
    const group = ADMIN_TL_FILTER_GROUPS[adminTlFilter];
    const category = adminTlFilter === 'all' ? 'set_release' : (group ? group[0] : adminTlFilter);
    return {
        id: null, title: '', category, start_date: adminTlIsoDay(new Date()), end_date: '',
        set_prefix: '', omnidex_event_id: null, notes: '',
    };
}

function adminTlDraftFrom(entry) {
    return {
        id: entry.id,
        title: entry.title || '',
        category: entry.category,
        start_date: entry.start_date || '',
        end_date: entry.end_date || '',
        set_prefix: entry.set_prefix || '',
        omnidex_event_id: entry.omnidex_event_id ?? null,
        notes: entry.notes || '',
    };
}

// The shared type-"confirm" dialog (appConfirm, app.js), like every other
// confirmation in the app. Resolves true when there's nothing to lose.
async function adminTlConfirmDiscard() {
    if (!adminTlDirty) return true;
    return appConfirm('Discard your unsaved changes to this event?', {title: 'Discard Changes', confirmLabel: 'Discard'});
}

async function selectAdminTimelineEntry(id) {
    if (adminTlSelectedId === id && adminTlDraft) return;
    if (!await adminTlConfirmDiscard()) return;

    const entry = adminTlEntries.find(e => e.id === id);
    if (!entry) return;

    await fadeSwap(document.getElementById('admin-tl-editor'), () => {
        adminTlSelectedId = id;
        adminTlDraft = adminTlDraftFrom(entry);
        adminTlDirty = false;
        syncAdminUrl();
        setAdminTimelineActiveRow();
        renderAdminTimelineEditor();
    });
}

async function newAdminTimelineEntry() {
    if (adminTlDraft && adminTlDraft.id == null && !adminTlDirty) {
        document.getElementById('admin-tl-title')?.focus();
        return;
    }
    if (!await adminTlConfirmDiscard()) return;

    await fadeSwap(document.getElementById('admin-tl-editor'), () => {
        adminTlSelectedId = null;
        adminTlDraft = adminTlNewDraft();
        adminTlDirty = false;
        syncAdminUrl();
        setAdminTimelineActiveRow();
        renderAdminTimelineEditor();
    });
    document.getElementById('admin-tl-title')?.focus();
}

async function closeAdminTimelineEditor() {
    if (!await adminTlConfirmDiscard()) return;

    await fadeSwap(document.getElementById('admin-tl-editor'), () => {
        adminTlSelectedId = null;
        adminTlDraft = null;
        adminTlDirty = false;
        syncAdminUrl();
        setAdminTimelineActiveRow();
        renderAdminTimelineEditor();
    });
}

function onAdminTimelineField(field, value) {
    if (!adminTlDraft) return;
    adminTlDraft[field] = value;
    setAdminTimelineDirty(true);
    // Only the Omnidex block's "events near this date" suggestions depend on
    // another field.
    if (field === 'start_date') renderAdminTlOmniSuggestions();
}

// Updates just the footer buttons — the inputs keep focus while typing.
function setAdminTimelineDirty(dirty) {
    adminTlDirty = dirty;
    const save = document.getElementById('admin-tl-save-btn');
    if (save) save.disabled = !dirty || adminTlSaving;
    document.getElementById('admin-tl-revert-btn')?.classList.toggle('hidden', !dirty || adminTlDraft?.id == null);
    setAdminTimelineMsg('');
}

function setAdminTimelineMsg(text, isError = true) {
    const el = document.getElementById('admin-tl-editor-msg');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('admin-tl-msg-error', isError);
}

async function adminTlEnsureSets() {
    if (adminTlSets) return;
    try {
        const options = await loadAdminCustomOptions();
        adminTlSets = options.sets || [];
    } catch (err) {
        adminTlSets = [];
    }
    // Swap just the Set picker in — the rest of the form may be mid-edit.
    const slot = document.getElementById('admin-tl-set-slot');
    if (slot && adminTlDraft) slot.innerHTML = adminTlSetPickerHtml();
}

function adminTlSetPickerHtml() {
    if (!adminTlSets) {
        return '<div class="select-dropdown"><button type="button" class="select-dropdown-btn" disabled>'
            + '<span class="select-dropdown-label">Loading sets…</span></button></div>';
    }
    const options = [{value: '', label: 'None'},
        ...adminTlSets.map(s => ({value: s.prefix, label: s.name && s.name !== s.prefix ? `${s.prefix} — ${s.name}` : s.prefix}))];
    const current = adminTlDraft.set_prefix || '';
    if (current && !options.some(o => o.value === current)) options.push({value: current, label: current});
    return selectDropdownHTML(options, current);
}

function renderAdminTimelineEditor() {
    const editor = document.getElementById('admin-tl-editor');
    if (!editor) return;

    const d = adminTlDraft;
    if (!d) {
        editor.innerHTML = `
            <div class="admin-tl-editor-empty">
                <span class="label label--muted">Timeline</span>
                <p>Record set releases, World / Ascent tournaments, banlist updates and other dates worth lining data up against.</p>
                <p>Select an event from the timeline, or add a new one.</p>
                <button type="button" class="admin-pid-refresh-btn" onclick="newAdminTimelineEntry()">+ Add Event</button>
            </div>`;
        return;
    }

    const entry = d.id != null ? adminTlEntries.find(e => e.id === d.id) : null;
    const stamp = (verb, at, by) => at
        ? `${verb} ${escapeHtml(adminTlDayLabel(adminTlIsoDay(new Date(at)), true))}${by ? ` by ${escapeHtml(by)}` : ''}` : '';
    const meta = entry ? [stamp('Added', entry.created_at, entry.created_by), stamp('Updated', entry.updated_at, entry.updated_by)]
        .filter(Boolean).join(' · ') : '';

    editor.innerHTML = `
        <div class="admin-tl-editor-header">
            <span class="admin-pid-detail-section-title">${d.id != null ? 'Edit Event' : 'New Event'}</span>
            <button type="button" class="admin-tl-close-btn" title="Close" onclick="closeAdminTimelineEditor()">&#x2715;</button>
        </div>

        <label class="admin-tl-field">
            <span class="label label--muted label--sm">Title</span>
            <input type="text" class="input admin-tl-input" id="admin-tl-title" maxlength="200"
                   placeholder="e.g. Worlds 2026, Phantom Monarchs release"
                   value="${escapeHtml(d.title)}" oninput="onAdminTimelineField('title', this.value)">
        </label>

        <div class="admin-tl-field-row">
            <div class="admin-tl-field" data-tl-field="category">
                <span class="label label--muted label--sm">Category</span>
                ${selectDropdownHTML(ADMIN_TL_CATEGORIES.map(c => ({value: c.value, label: c.label})), d.category)}
            </div>
            <div class="admin-tl-field" data-tl-field="set_prefix">
                <span class="label label--muted label--sm">Set <span class="admin-tl-optional">optional</span></span>
                <div id="admin-tl-set-slot">${adminTlSetPickerHtml()}</div>
            </div>
        </div>

        <div class="admin-tl-field-row">
            <label class="admin-tl-field">
                <span class="label label--muted label--sm">Date</span>
                <input type="date" class="input admin-tl-input" id="admin-tl-start" value="${escapeHtml(d.start_date)}"
                       onchange="onAdminTimelineField('start_date', this.value)">
            </label>
            <label class="admin-tl-field">
                <span class="label label--muted label--sm">End date <span class="admin-tl-optional">optional</span></span>
                <input type="date" class="input admin-tl-input" id="admin-tl-end" value="${escapeHtml(d.end_date)}"
                       onchange="onAdminTimelineField('end_date', this.value)">
            </label>
        </div>

        <div class="admin-tl-field">
            <span class="label label--muted label--sm">Omnidex event <span class="admin-tl-optional">optional</span></span>
            <div id="admin-tl-omni">${adminTlOmniHtml()}</div>
        </div>

        <label class="admin-tl-field">
            <span class="label label--muted label--sm">Notes <span class="admin-tl-optional">optional</span></span>
            <textarea class="textarea admin-tl-notes" rows="3" maxlength="2000"
                      oninput="onAdminTimelineField('notes', this.value)">${escapeHtml(d.notes)}</textarea>
        </label>

        <div class="admin-tl-editor-footer">
            <span class="admin-tl-editor-meta">${meta}</span>
            <span class="admin-tl-editor-msg" id="admin-tl-editor-msg"></span>
            <div class="admin-tl-editor-actions">
                ${d.id != null ? `<button type="button" class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary admin-tl-delete-btn"
                        onclick="deleteAdminTimelineEntry()">Delete</button>` : ''}
                <button type="button" class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary ${adminTlDirty && d.id != null ? '' : 'hidden'}"
                        id="admin-tl-revert-btn" onclick="revertAdminTimelineEntry()">Revert</button>
                <button type="button" class="admin-pid-refresh-btn" id="admin-tl-save-btn"
                        onclick="saveAdminTimelineEntry()" ${adminTlDirty && !adminTlSaving ? '' : 'disabled'}>${d.id != null ? 'Save' : 'Add Event'}</button>
            </div>
        </div>
    `;

    adminTlEnsureSets();
}

function revertAdminTimelineEntry() {
    const entry = adminTlEntries.find(e => e.id === adminTlDraft?.id);
    if (!entry) return;
    adminTlDraft = adminTlDraftFrom(entry);
    adminTlDirty = false;
    renderAdminTimelineEditor();
}

async function saveAdminTimelineEntry() {
    const d = adminTlDraft;
    if (!d || adminTlSaving) return;
    if (!d.title.trim()) return setAdminTimelineMsg('Give the event a title.');
    if (!d.start_date) return setAdminTimelineMsg('Pick a date.');
    if (d.end_date && d.end_date < d.start_date) return setAdminTimelineMsg("The end date can't be before the start.");

    adminTlSaving = true;
    const btn = document.getElementById('admin-tl-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
        const res = await fetch(d.id != null ? `/api/admin/timeline/${d.id}` : '/api/admin/timeline', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                title: d.title, category: d.category, start_date: d.start_date, end_date: d.end_date || null,
                set_prefix: d.set_prefix || null, omnidex_event_id: d.omnidex_event_id, notes: d.notes,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not save the event');

        const entry = data.entry;
        adminTlEntries = adminTlEntries.filter(e => e.id !== entry.id).concat(entry);
        adminTlSortEntries();
        adminTlSelectedId = entry.id;
        adminTlDraft = adminTlDraftFrom(entry);
        adminTlDirty = false;
        adminTlSaving = false;
        syncAdminUrl();
        renderAdminTimelineList({flashId: entry.id});
        renderAdminTimelineEditor();
        setAdminTimelineMsg('Saved.', false);
    } catch (err) {
        adminTlSaving = false;
        if (btn) { btn.disabled = false; btn.textContent = d.id != null ? 'Save' : 'Add Event'; }
        setAdminTimelineMsg(err.message);
    }
}

async function deleteAdminTimelineEntry() {
    const d = adminTlDraft;
    if (!d || d.id == null) return;
    if (!await appConfirm(`Permanently delete "${d.title || 'this event'}" from the timeline?`, {title: 'Delete Event'})) return;

    try {
        const res = await fetch(`/api/admin/timeline/${d.id}`, {method: 'DELETE'});
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not delete the event');

        adminTlEntries = adminTlEntries.filter(e => e.id !== d.id);
        await fadeSwap(document.getElementById('admin-tl-editor'), () => {
            adminTlSelectedId = null;
            adminTlDraft = null;
            adminTlDirty = false;
            syncAdminUrl();
            renderAdminTimelineEditor();
        });
        renderAdminTimelineList();
    } catch (err) {
        setAdminTimelineMsg(err.message);
    }
}

// ── Omnidex link ──

function adminTlOmniHtml() {
    const d = adminTlDraft;
    const id = d.omnidex_event_id;

    if (id != null) {
        const ev = adminTlOmnidex.get(id);
        const facts = ev ? [
            ev.start_at ? adminTlDayLabel(adminTlIsoDay(new Date(ev.start_at)), true) : null,
            typeof eventCategoryLabel === 'function' ? eventCategoryLabel(ev.category) : ev.category,
            ev.player_count ? `${ev.player_count} players` : null,
            ev.host_name,
        ].filter(Boolean) : [];

        return `
            <div class="admin-tl-omni-card">
                <div class="admin-tl-omni-card-main">
                    <span class="admin-tl-omni-name">${ev ? escapeHtml(ev.name) : `Event #${id}`}</span>
                    <span class="admin-tl-omni-facts">${ev
                        ? `#${id} · ${facts.map(escapeHtml).join(' · ')}`
                        : 'Not stored locally yet — fetch it to show its details.'}</span>
                </div>
                <div class="admin-tl-omni-card-actions">
                    ${ev ? `<button type="button" class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary"
                                    onclick="openAdminTimelineOmnidex(${id})">Open ↗</button>`
                         : `<button type="button" class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary"
                                    onclick="linkAdminTimelineOmnidex('${id}')" ${adminTlLinkBusy ? 'disabled' : ''}>Fetch</button>`}
                    <button type="button" class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary"
                            onclick="unlinkAdminTimelineOmnidex()">Unlink</button>
                </div>
            </div>
            <div class="admin-tl-omni-msg" id="admin-tl-omni-msg"></div>`;
    }

    return `
        <div class="admin-tl-omni-search">
            <input type="text" class="input admin-tl-input" id="admin-tl-omni-input" autocomplete="off"
                   placeholder="Search stored events, or paste an Omnidex ID / URL"
                   oninput="renderAdminTlOmniSuggestions()" onkeydown="onAdminTlOmniKeydown(event)">
            <button type="button" class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary" id="admin-tl-omni-link-btn"
                    onclick="linkAdminTimelineOmnidex()" ${adminTlLinkBusy ? 'disabled' : ''}>Link</button>
        </div>
        <div class="admin-tl-omni-suggest" id="admin-tl-omni-suggest">${adminTlOmniSuggestionsHtml()}</div>
        <div class="admin-tl-omni-msg" id="admin-tl-omni-msg"></div>`;
}

// Stored events matching what's typed — or, with nothing typed, the ones
// within a week of the entry's date (likeliest to be the one it's about).
function adminTlOmniSuggestionsHtml() {
    const d = adminTlDraft;
    if (!d || d.omnidex_event_id != null) return '';

    const query = (document.getElementById('admin-tl-omni-input')?.value || '').trim().toLowerCase();
    if (/^#?\d+$/.test(query) || query.includes('events/')) return '';

    const all = [...adminTlOmnidex.values()];
    let picks;
    let heading;
    if (query) {
        picks = all.filter(e => (e.name || '').toLowerCase().includes(query));
        heading = 'Stored events';
    } else {
        const day = adminTlParseDay(d.start_date);
        if (!day) return '';
        const week = 7 * 24 * 3600 * 1000;
        picks = all.filter(e => e.start_at && Math.abs(new Date(e.start_at) - day) <= week);
        heading = 'Stored events near this date';
    }
    picks.sort((a, b) => (b.start_at || '').localeCompare(a.start_at || ''));
    picks = picks.slice(0, 6);
    if (!picks.length) return '';

    return `<span class="admin-tl-omni-suggest-label">${heading}</span>` + picks.map(e => `
        <button type="button" class="admin-tl-omni-option" onclick="linkAdminTimelineStored(${e.event_id})">
            <span class="admin-tl-omni-option-name">${escapeHtml(e.name)}</span>
            <span class="admin-tl-omni-option-meta">${escapeHtml(e.start_at ? adminTlDayLabel(adminTlIsoDay(new Date(e.start_at)), true) : '—')} · #${e.event_id}</span>
        </button>`).join('');
}

function renderAdminTlOmniSuggestions() {
    const el = document.getElementById('admin-tl-omni-suggest');
    if (el) el.innerHTML = adminTlOmniSuggestionsHtml();
}

function onAdminTlOmniKeydown(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        linkAdminTimelineOmnidex();
    }
}

function renderAdminTlOmniBlock() {
    const slot = document.getElementById('admin-tl-omni');
    if (slot) slot.innerHTML = adminTlOmniHtml();
}

function setAdminTlOmniMsg(text) {
    const el = document.getElementById('admin-tl-omni-msg');
    if (el) el.textContent = text;
}

// Links the draft to an Omnidex event. A brand-new entry still on its
// defaults takes the event's name, date and the Tournament category; an
// existing entry only fills a blank title — nothing typed is overwritten.
function adminTlApplyOmnidexLink(ev, {render = true} = {}) {
    const d = adminTlDraft;
    if (!d) return;

    d.omnidex_event_id = ev.event_id;
    const fresh = d.id == null && !d.title.trim();
    if (!d.title.trim()) d.title = ev.name || '';
    if (fresh) {
        d.category = 'tournament';
        if (ev.start_at) d.start_date = adminTlIsoDay(new Date(ev.start_at));
    }

    if (render) {
        renderAdminTimelineEditor();
        setAdminTimelineDirty(true);
    }
}

function linkAdminTimelineStored(eventId) {
    const ev = adminTlOmnidex.get(eventId);
    if (ev) adminTlApplyOmnidexLink(ev);
}

// By ID / URL — through the Events page's lookup, which fetches and stores an
// event that isn't stored yet. `value` defaults to the search box.
async function linkAdminTimelineOmnidex(value) {
    if (!adminTlDraft || adminTlLinkBusy) return;
    value = String(value ?? document.getElementById('admin-tl-omni-input')?.value ?? '').trim();
    if (!value) return setAdminTlOmniMsg('Type a stored event name, or paste an Omnidex event ID / URL.');

    adminTlLinkBusy = true;
    setAdminTlOmniMsg('Looking it up…');
    const draft = adminTlDraft;
    const btn = document.getElementById('admin-tl-omni-link-btn');
    if (btn) btn.disabled = true;

    try {
        const res = await fetch('/api/events/lookup', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({event: value}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Lookup failed');

        adminTlLinkBusy = false;
        adminTlOmnidex.set(data.event.event_id, data.event);
        if (adminTlDraft !== draft) return;
        adminTlApplyOmnidexLink(data.event);
        if (data.fetched) setAdminTlOmniMsg('Fetched from the Omnidex and stored on the Events page.');
    } catch (err) {
        adminTlLinkBusy = false;
        if (adminTlDraft !== draft) return;
        // Leave what was typed in place so it can be corrected.
        const freshBtn = document.getElementById('admin-tl-omni-link-btn');
        if (freshBtn) freshBtn.disabled = false;
        setAdminTlOmniMsg(err.message);
    }
}

function unlinkAdminTimelineOmnidex() {
    if (!adminTlDraft) return;
    adminTlDraft.omnidex_event_id = null;
    renderAdminTlOmniBlock();
    setAdminTimelineDirty(true);
}

async function openAdminTimelineOmnidex(eventId) {
    if (!await adminTlConfirmDiscard()) return;
    adminTlDirty = false;
    navigate(`/events?event=${eventId}`);
}

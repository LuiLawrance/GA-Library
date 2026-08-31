let adminActiveSection = 'pricing';
let adminCardsView = 'pricing';
let adminPidDetailMode = 'regular';
let adminSystemLoaded = false;
let adminUsersLoaded = false;
let adminUsersData = [];
let adminUserDetailSelected = null;
let adminUserDetailInventory = null;
let adminUserDetailDecks = null;
let adminPidLoaded = false;
let adminPidData = [];
let adminPidSelected = new Set();
// Sets panel's single selection (click a row to select it, like the card
// list's own adminPidDetailSelected) — the header's Search/Clear/Sync
// buttons act on whichever one set this is. null when nothing's selected.
let adminSetsSelectedSlug = null;
let adminPidRefreshStatus = {};
let adminPidRefreshing = false;
let adminPidSetFilter = new Set();
let adminPidSetFilterOpen = false;
let adminPidRarityFilter = new Set();
let adminPidRarityFilterOpen = false;
let adminPidFindingIds = new Set();
// Whether Postgres is the backing store right now (Use JSON off — mirrors
// is_db_mode() server-side), refreshed from GET /api/admin/pricing/product-ids
// and kept live when the toggle is flipped (see updateAdminSystemSetting).
// The live TCGPlayer controls on the Pricing page — Refresh Sales/Listings/
// Selected and the per-row 🔍 auto product-ID buttons — are shown only when
// this is on (see updateAdminPidRefreshButton / adminPidProductIdFieldHtml).
let adminDbModeOn = false;
// Edition IDs currently toggled to show/edit their Curio Foil's own product
// ID (see e.curio, from GET /api/admin/pricing/product-ids) instead of the
// edition's regular one, and to filter the detail panel's Sales/Listings
// down to just that foil's own separate TCGPlayer product page.
let adminPidCurioViewSelected = new Set();

let adminPidDetailSelected = null;
let adminPidDetailHistory = null;
let adminPidDetailFoils = null;
let adminPidAddEntryOpenType = null;
let adminPidAddEntryFoilId = null;
let adminPidAddEntryCondition = null;
let adminPidAddEntryPending = false;
let adminPidBulkPasteOpen = false;
let adminPidBulkPastePending = false;

// Matches CONDITION_MAP in api_tcgplayer.py, so manual entries use the same
// grading vocabulary as scraped TCGPlayer data.
const ADMIN_PID_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

// Suggested marketplace options for manual entries — the field itself still
// accepts arbitrary free text, these are just one-click shortcuts.
const ADMIN_PID_MARKETPLACE_OPTIONS = ['TCGPlayer', 'Manual'];

// Matches RARITY_MAP's value order in pricing_ga.py, so the rarity filter
// lists options from most common to rarest instead of alphabetically.
const ADMIN_PID_RARITY_ORDER = ['C', 'U', 'R', 'SR', 'UR', 'PR', 'CSR', 'CUR', 'CPR'];

// Matches NO_LISTINGS_SENTINEL in api_tcgplayer.py — admins enter this instead
// of a real product ID for cards confirmed to have no TCGPlayer listings at
// all, so it's not mistaken for "not yet looked up".
const ADMIN_PID_NO_LISTINGS_SENTINEL = '~';

// True only for a product ID that's actually worth sending to a refresh —
// excludes both a blank/missing ID and the "~" no-listings marker.
function adminPidIsScrapable(productId) {
    return !!productId && productId !== ADMIN_PID_NO_LISTINGS_SENTINEL;
}

// positionPillIndicator (used below for the Cards section's two pill
// toggles: Info/Pricing, Regular/Discord) now lives in modal-anim.js, shared
// alongside the rest of this page's animation helpers (animateBoxResize,
// fadeSwap) for any future page that wants the same sliding-pill look.

// Keeps the address bar in sync with whichever Admin section/sub-view is
// currently showing (see the routes table in app.js, and initAdmin which
// reads this same shape back out on load) — replaceState rather than
// pushState since switching tabs happens casually and often repeatedly, and
// pushState per click would flood browser history with one entry per tab
// glanced at (same reasoning showPriceGraph in prices.js uses for its own
// URL sync).
function syncAdminUrl() {
    let path;
    if (adminActiveSection === 'system') {
        path = '/admin/system';
    } else if (adminActiveSection === 'users') {
        path = '/admin/users';
    } else {
        path = `/admin/cards/${adminCardsView}`;
    }
    if (window.location.pathname !== path) {
        window.history.replaceState({}, '', path);
    }
}

async function switchAdminSection(section) {
    const page = document.getElementById('admin-page');
    if (!page || adminActiveSection === section) return;

    const content = page.querySelector('.admin-content');
    content?.classList.add('fade-out');
    await sleep(150);

    adminActiveSection = section;
    syncAdminUrl();

    page.querySelectorAll('.admin-subnav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.section === section);
    });

    page.querySelectorAll('.admin-section').forEach(panel => {
        panel.classList.toggle('hidden', panel.id !== `admin-section-${section}`);
    });

    if (section === 'pricing' && !adminPidLoaded) {
        loadAdminPricingIds();
    }

    if (section === 'users' && !adminUsersLoaded) {
        loadAdminUsers();
    }

    if (section === 'system' && !adminSystemLoaded) {
        loadAdminSystemSettings();
    }

    if (section === 'pricing') {
        // Just became visible (or already was) — reposition without sliding from a
        // stale/never-measured spot.
        positionPillIndicator(document.querySelector('.admin-cards-subnav'));
        positionPillIndicator(document.getElementById('admin-pid-source-toggle'));
    }

    if (section === 'system') {
        document.querySelectorAll('.admin-system-option-toggle').forEach(positionPillIndicator);
    }

    content?.classList.remove('fade-out');
    content?.classList.add('fade-in');
    setTimeout(() => content?.classList.remove('fade-in'), 200);
}

// Switches between the Cards section's own sub-views (Info / Pricing) — a
// pill toggle inside the section itself, separate from switchAdminSection()
// above which switches the top-level Cards/Users tabs. Info and Pricing are
// NOT two separate panels: they share the one grid list + card info window
// (see #admin-cards-view in admin.html), and selecting a card shows the exact
// same info window in either sub-view.
//
// The list's row content (Card/Rarity/Set only vs. the full Pricing set) is
// hidden (fadeSwap) and blanked before the resize below — with thousands of
// editions potentially loaded, every row is width:100% of .admin-pricing-list,
// so leaving them mounted while that width changes (even smoothly, even with
// no per-row CSS transition of its own) still forces every one of them to
// reflow on every animation frame, which read as glitchy.
//
// The card info window (.admin-pricing-image-col/.admin-pricing-detail) is
// deliberately NOT part of that fade — it stays visible throughout and
// simply gets carried along for free by animateGridColumns below (see
// modal-anim.js): that animates .admin-pricing-layout's own
// grid-template-columns rather than giving the list item an explicit width
// of its own to animate, so the info window sitting in the NEXT track over
// visibly slides with the list as the grid recalculates each frame, instead
// of needing a separate hide/reposition/reveal of its own. Its content still
// updates instantly (inside the same mutate, right before that slide starts)
// since the card selection itself IS reset on every switch — see below.
async function switchAdminCardsView(view) {
    const section = document.getElementById('admin-section-pricing');
    if (!section || adminCardsView === view) return;

    section.querySelectorAll('.admin-cards-subnav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    positionPillIndicator(section.querySelector('.admin-cards-subnav'));

    const layout = section.querySelector('.admin-pricing-layout');
    const header = document.getElementById('admin-pid-table-header');
    const table = document.getElementById('admin-pid-table');
    const enteringInfo = view === 'info';

    await fadeSwap([header, table], async () => {
        // Deselect whatever card was open (and clear its bulk-refresh
        // checkboxes) rather than carrying it — and its now-stale Sales/
        // Listings history/foils/popover state — across into the other
        // sub-view. Same reset selectAdminPricingDetail() does when
        // switching to a DIFFERENT card, just landing on "nothing selected"
        // instead of a new editionId.
        adminPidDetailSelected = null;
        adminPidDetailHistory = null;
        adminPidDetailFoils = null;
        adminPidAddEntryOpenType = null;
        adminPidAddEntryFoilId = null;
        adminPidAddEntryCondition = ADMIN_PID_CONDITIONS[0];
        adminPidBulkPasteOpen = false;
        adminPidSelected = new Set();

        // Set ahead of both render calls below (rather than inside
        // animateGridColumns' own mutate) — renderAdminPricingImageCol's
        // empty-state wording and renderAdminPricingDetail's early return
        // both read this, and need the NEW mode's value from the moment
        // they're called, not just once the grid animation's mutate runs.
        adminCardsView = view;
        syncAdminUrl();

        header.innerHTML = '';
        table.innerHTML = '';

        // Updates the (now-deselected, so always "Select a card…") info
        // window's content ahead of the slide below, so it's already showing
        // the right thing by the time that's visible instead of changing
        // mid-slide.
        renderAdminPricingDetailAll();

        await animateGridColumns(layout, () => {
            section.classList.toggle('admin-cards-mode-info', enteringInfo);
        });

        renderAdminPricingIds();
    });

    // The list itself is shared, so either sub-view being opened first needs
    // it loaded — not just 'pricing' like before.
    if (!adminPidLoaded) {
        loadAdminPricingIds();
    }
}

async function loadAdminSystemSettings() {
    const container = document.getElementById('admin-system-settings');
    if (!container) return;

    try {
        const res = await fetch('/api/admin/settings');
        if (!res.ok) throw new Error('Failed to load settings');
        const data = await res.json();

        adminSystemLoaded = true;
        adminDbModeOn = !data.use_json;

        for (const key of ['store_images_locally', 'use_json']) {
            renderAdminSystemToggle(key, !!data[key]);
        }
        renderSyncPanelVisibility(!!data.use_json);
        loadAdminSystemDatabaseSettings();
    } catch (err) {
        // Leave the toggles at their last-known state rather than blanking
        // the whole panel — same as the other admin sections' load failures.
    }
}

// Sets which pill button is active for one System setting's toggle and
// slides .pill-indicator to match (same positionPillIndicator used by the
// Cards section's own Info/Pricing and Regular/Discord pills).
function renderAdminSystemToggle(key, value) {
    const toggle = document.querySelector(`.admin-system-option-toggle[data-setting="${key}"]`);
    if (!toggle) return;

    toggle.querySelectorAll('.admin-pid-source-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', (btn.dataset.value === 'true') === value);
    });
    positionPillIndicator(toggle);
}

// The Database Connection / Sync / Wipe panel is shown whenever Use JSON is
// off (the app is on Postgres), and also stays available while a switch is
// being staged so the connection can be set up first. Takes the raw
// use_json value (hide-when-true — every call site has that value on hand,
// not its inverse). Instant, unanimated — used on page load, where nothing
// should animate in (only a live toggle click animates, via
// animateSystemPanelsForUseJson).
function renderSyncPanelVisibility(useJson) {
    const panel = document.getElementById('admin-system-sync-panel');
    if (panel) panel.classList.toggle('hidden', useJson);
}

// Phase 2's vertical reveal of the sync panel — a height "wipe" (0 <-> its
// natural height, overflow clipped), NOT a fade or a scale/zoom. Same 300ms
// height-animation technique as the staging confirm bar's own wipe
// (_playStagingBarWipe), so when a switch is being staged the bar and this
// panel open / collapse in lockstep. Only the height moves here — the
// panel's horizontal space is already claimed in phase 1 (see
// _slideSettingsCard).
const ADMIN_SYNC_PANEL_WIPE_MS = 300;

// Tracks the panel's in-flight wipe (only ever one such element, so a
// single variable does — unlike animateBoxResize's per-box WeakMap). A
// rapid re-toggle cancels the previous wipe rather than leaving two racing
// on the same element and ending on whichever finishes last.
let _adminSyncPanelAnim = null;

// Clears the inline styles a height wipe leaves on the panel, handing
// sizing back to CSS. Safe to call anytime.
function _clearSyncPanelWipeStyles() {
    const panel = document.getElementById('admin-system-sync-panel');
    if (!panel) return;
    for (const prop of ['height', 'overflow', 'paddingTop', 'paddingBottom']) {
        panel.style[prop] = '';
    }
}

// Plays the panel's vertical wipe — entering (0 -> open height) or leaving
// (open height -> 0). Vertical padding collapses with the height so the
// panel wipes down to nothing rather than leaving a thin bar of its own
// padding. The panel is already un-hidden and holding its horizontal space
// (phase 1) before an entering wipe; the caller adds .hidden after a
// leaving one. Resolves on a plain timer, not anim.finished — see
// animateBoxResize's comment on why.
function _playSyncPanelWipe(entering) {
    const panel = document.getElementById('admin-system-sync-panel');
    if (!panel) return Promise.resolve();

    _adminSyncPanelAnim?.cancel();

    // Clear the pins phase 1 left (height/padding at 0) so
    // getComputedStyle/getBoundingClientRect read the true open box, then
    // clip overflow for the tween.
    panel.style.height = '';
    panel.style.paddingTop = '';
    panel.style.paddingBottom = '';
    panel.style.overflow = 'hidden';
    const cs = getComputedStyle(panel);
    const openPadTop = cs.paddingTop;
    const openPadBottom = cs.paddingBottom;
    const openHeight = panel.getBoundingClientRect().height;

    const shut = {height: '0px', paddingTop: '0px', paddingBottom: '0px'};
    const open = {height: openHeight + 'px', paddingTop: openPadTop, paddingBottom: openPadBottom};

    const anim = panel.animate(
        entering ? [shut, open] : [open, shut],
        // fill:'backwards' holds the 0 frame from the instant this is
        // called (no delay) so an opening panel never flashes at full
        // height first; fill:'forwards' holds the 0 frame after a closing
        // wipe until the caller adds .hidden (see
        // _adminSyncPanelCleanupAfterHide).
        {
            duration: ADMIN_SYNC_PANEL_WIPE_MS,
            easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
            fill: entering ? 'backwards' : 'forwards',
        },
    );
    _adminSyncPanelAnim = anim;

    return sleep(ADMIN_SYNC_PANEL_WIPE_MS).then(() => {
        if (_adminSyncPanelAnim !== anim) return; // superseded by a later toggle

        if (entering) {
            anim.cancel();
            _adminSyncPanelAnim = null;
            _clearSyncPanelWipeStyles();
        }
        // Leaving: keep the held 0-height state until .hidden is actually
        // in place — releasing it now would flash the panel back to full
        // height for a frame. _adminSyncPanelCleanupAfterHide does it.
    });
}

// Releases a closing wipe's held 0-height state — call only once .hidden is
// on the panel, never before.
function _adminSyncPanelCleanupAfterHide() {
    _adminSyncPanelAnim?.cancel();
    _adminSyncPanelAnim = null;
    _clearSyncPanelWipeStyles();
}

// Phase 1 (horizontal) of animateSystemPanelsForUseJson — the settings
// card's own horizontal position shifts as a side effect of
// #admin-system-panels' justify-content:center re-centering around however
// many flex items are actually visible (the card alone vs. paired with the
// sync panel) — not a fixed pixel value there's any CSS property to
// hand-animate. Uses the FLIP technique instead: measure the card's
// position before `mutate` changes what's visible, apply it, measure
// again, then play the resulting visual jump back down to zero so it reads
// as a slide instead of a snap.
function _slideSettingsCard(mutate) {
    const card = document.getElementById('admin-system-settings');
    if (!card) { mutate(); return Promise.resolve(); }

    const before = card.getBoundingClientRect().left;
    mutate();
    const after = card.getBoundingClientRect().left;
    const deltaX = before - after;

    if (!deltaX) return Promise.resolve();

    card.style.transform = `translateX(${deltaX}px)`;
    card.getBoundingClientRect(); // flush layout so that jump is committed before animating away from it
    const duration = 280;
    const anim = card.animate(
        [{transform: `translateX(${deltaX}px)`}, {transform: 'translateX(0)'}],
        {duration, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards'},
    );

    return new Promise(resolve => {
        setTimeout(() => {
            anim.cancel();
            card.style.transform = '';
            resolve();
        }, duration);
    });
}

// Bumped once per animateSystemPanelsForUseJson call. Each phase re-checks
// it after its await and bails if a newer toggle has since started, so a
// stale run can't drive phase 2, slide the card, or hide the panel out
// from under the latest one (rapid double-toggling the switch).
let _adminSystemPanelsGen = 0;

// Click-triggered reveal/hide of the Database Connection / Sync / Wipe panel
// beside the settings card, which only applies once Use JSON is off. Two
// distinct phases, not everything at once — the menus settle their HORIZONTAL
// positions first, then the panel wipes in VERTICALLY:
//
//   Showing:  1) un-hide the sync panel but pin it to zero height, so it
//             claims only its width; the settings card slides across to its
//             paired position around that (see _slideSettingsCard).
//             2) THEN the sync panel wipes open downward (_playSyncPanelWipe).
//
//   Hiding:   the exact reverse — 1) the panel collapses its height to zero,
//             2) THEN it's dropped (releasing its width) and the settings
//             card slides back to centered.
async function animateSystemPanelsForUseJson(useJson) {
    const syncPanel = document.getElementById('admin-system-sync-panel');
    if (!syncPanel) return;

    const gen = ++_adminSystemPanelsGen;

    if (!useJson) {
        await _slideSettingsCard(() => {
            syncPanel.classList.remove('hidden');
            syncPanel.style.height = '0px';
            syncPanel.style.paddingTop = '0px';
            syncPanel.style.paddingBottom = '0px';
            syncPanel.style.overflow = 'hidden';
        });
        if (gen !== _adminSystemPanelsGen) return; // a newer toggle took over
        await _playSyncPanelWipe(true);
    } else {
        await _playSyncPanelWipe(false);
        if (gen !== _adminSystemPanelsGen) return; // a newer toggle took over
        await _slideSettingsCard(() => {
            syncPanel.classList.add('hidden');
        });
        if (gen !== _adminSystemPanelsGen) return;
        _adminSyncPanelCleanupAfterHide();
    }
}

async function updateAdminSystemSetting(key, value) {
    // Clicking "On" while a Use JSON → database-mode switch is still staged
    // just backs the staging out — nothing was written to undo.
    if (key === 'use_json' && value === true && adminUseJsonStaging) {
        cancelUseJsonStaging();
        return;
    }

    const prevValue = document.querySelector(`.admin-system-option-toggle[data-setting="${key}"] .active`)?.dataset.value === 'true';
    renderAdminSystemToggle(key, value);

    if (key === 'use_json') {
        animateSystemPanelsForUseJson(value);
    }

    try {
        const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({[key]: value}),
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.detail || 'Failed to update setting.');
            renderAdminSystemToggle(key, prevValue);
            if (key === 'use_json') {
                animateSystemPanelsForUseJson(prevValue);
            }
            return;
        }

        // Use JSON gates the Pricing page's live TCGPlayer controls (they only
        // apply when Postgres is the store) — reflect a flip there right away,
        // even though that section is a different (currently hidden) tab, so
        // it's already correct when the admin navigates back to it
        // (switchAdminSection doesn't re-render it). This path only fires for
        // Off → On (On → Off goes through the staged confirm, which reloads).
        if (key === 'use_json') {
            adminDbModeOn = !value;
            if (adminPidLoaded) renderAdminPricingIds();
            if (adminPidDetailSelected) renderAdminPricingImageCol();
            updateAdminPidRefreshButton();
        }
    } catch (err) {
        alert('Failed to update setting.');
        renderAdminSystemToggle(key, prevValue);
        if (key === 'use_json') {
            animateSystemPanelsForUseJson(prevValue);
        }
    }
}

// ── Use JSON → database mode: staged confirmation ───────────────────────
// Turning Use JSON off switches the whole app onto Postgres, where auth
// reads it and never USERS.json — so doing it before the owner account
// exists in Postgres 403-locks the admin out of the console (and out of the
// Database Connection panel that could fix a bad URL). See
// _db_mode_switch_blocker in app.py for the matching server guard.
//
// So the Off button doesn't write anything: it enters this staged state
// instead. The Database Connection / Sync panel is revealed exactly as if
// use_json were already off (reusing animateSystemPanelsForUseJson), a
// confirm bar appears on top with a live checklist, and nothing is persisted
// until Confirm. Cancel — or clicking On — backs out with no server write.
let adminUseJsonStaging = false;

// Vertical height "wipe" for the confirm bar — the same technique and 300ms
// timing as _playSyncPanelWipe (the Database Connection panel just below it),
// so the bar and the panels it sits above open / collapse in lockstep. Runs
// on the #admin-system-staging-wrap clipper (overflow:hidden, flex-shrink:0 in
// CSS) rather than the bar itself: the bar keeps its natural flex layout while
// only the wrap's height animates 0 ↔ natural. entering: 0 → natural; leaving:
// natural → 0 (the caller adds .hidden to the wrap afterwards, then calls
// _stagingBarWipeCleanup). One such element ever, so a single module-level
// handle tracks the in-flight anim — a rapid re-toggle cancels the previous.
const ADMIN_STAGING_BAR_WIPE_MS = 300;
let _adminStagingBarAnim = null;

function _playStagingBarWipe(entering) {
    const wrap = document.getElementById('admin-system-staging-wrap');
    if (!wrap) return Promise.resolve();

    _adminStagingBarAnim?.cancel();

    // Clear any height pin a previous wipe left so the natural (open) height
    // reads true.
    wrap.style.height = '';
    const openHeight = wrap.getBoundingClientRect().height;

    const anim = wrap.animate(
        entering
            ? [{height: '0px'}, {height: openHeight + 'px'}]
            : [{height: openHeight + 'px'}, {height: '0px'}],
        {
            duration: ADMIN_STAGING_BAR_WIPE_MS,
            easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
            // backwards: hold the 0 frame from the instant this is called so an
            // opening bar never flashes at full height first. forwards: hold the
            // 0 frame after a closing wipe until the caller adds .hidden.
            fill: entering ? 'backwards' : 'forwards',
        },
    );
    _adminStagingBarAnim = anim;

    // Timer, not anim.finished — see animateBoxResize's comment on why.
    return sleep(ADMIN_STAGING_BAR_WIPE_MS).then(() => {
        if (_adminStagingBarAnim !== anim) return; // superseded by a later toggle
        if (entering) {
            anim.cancel();
            _adminStagingBarAnim = null;
            wrap.style.height = '';
        }
        // Leaving: keep the held 0-height state until .hidden is in place —
        // _stagingBarWipeCleanup releases it.
    });
}

// Release a closing wipe's held 0-height state — call only once .hidden is on
// the wrap, never before (releasing early flashes it back to full height).
function _stagingBarWipeCleanup() {
    _adminStagingBarAnim?.cancel();
    _adminStagingBarAnim = null;
    const wrap = document.getElementById('admin-system-staging-wrap');
    if (wrap) wrap.style.height = '';
}

function beginUseJsonStaging() {
    if (adminUseJsonStaging) return;
    adminUseJsonStaging = true;

    renderAdminSystemToggle('use_json', false);   // visual pill only — no fetch
    animateSystemPanelsForUseJson(false);          // reveal the DB Connection panel

    const wrap = document.getElementById('admin-system-staging-wrap');
    if (wrap) {
        wrap.classList.remove('hidden');
        _playStagingBarWipe(true);                  // wipe down, concurrent with the panels
    }
    _setStagingError('');
    refreshDbModePrecheck();
}

async function cancelUseJsonStaging() {
    if (!adminUseJsonStaging) return;
    adminUseJsonStaging = false;

    renderAdminSystemToggle('use_json', true);
    animateSystemPanelsForUseJson(true);
    _setStagingError('');

    const wrap = document.getElementById('admin-system-staging-wrap');
    if (wrap) {
        await _playStagingBarWipe(false);          // wipe up, concurrent with the panels
        if (adminUseJsonStaging) return;           // re-opened mid-collapse — leave it shown
        wrap.classList.add('hidden');
        _stagingBarWipeCleanup();
    }
}

function _setStagingError(text) {
    const el = document.getElementById('admin-system-staging-error');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
}

// state: 'ok' | 'pending' | 'fail'
function _setStagingCheck(name, state, label) {
    const li = document.querySelector(`#admin-system-staging-checklist li[data-check="${name}"]`);
    if (!li) return;
    li.dataset.state = state;
    if (label) {
        const labelEl = li.querySelector('.admin-system-staging-check-label');
        if (labelEl) labelEl.textContent = label;
    }
}

// Polls the server for whether it's safe to flip into DB mode and drives the
// checklist + Confirm gating. Called on entry, and again after every Save /
// Test / Port Owner so the bar tracks edits live. No-ops once staging ends.
async function refreshDbModePrecheck() {
    if (!adminUseJsonStaging) return;

    const confirmBtn = document.getElementById('admin-system-staging-confirm-btn');
    if (confirmBtn) confirmBtn.disabled = true;
    _setStagingCheck('connection', 'pending');
    _setStagingCheck('owner', 'pending');

    let data;
    try {
        const res = await fetch('/api/admin/system/db-mode-precheck');
        if (!res.ok) throw new Error();
        data = await res.json();
    } catch (err) {
        _setStagingCheck('connection', 'fail', 'Database connection (check failed)');
        _setStagingCheck('owner', 'fail');
        return;
    }
    if (!adminUseJsonStaging) return; // cancelled while the request was in flight

    _setStagingCheck(
        'connection',
        data.connection_ok ? 'ok' : 'fail',
        data.connection_ok
            ? 'Database connection'
            : (data.database_url_set ? 'Database connection (failed)' : 'Database connection (not configured)'),
    );

    // No owner account anywhere ⇒ nothing to copy, not a blocker (first
    // signup in DB mode becomes owner).
    const ownerSatisfied = data.owner_in_db || !data.owner_username;
    _setStagingCheck(
        'owner',
        ownerSatisfied ? 'ok' : 'fail',
        data.owner_username
            ? `Owner account "${data.owner_username}" in database`
            : 'Owner account in database (none to copy)',
    );

    if (confirmBtn) confirmBtn.disabled = !(data.connection_ok && ownerSatisfied);
}

async function confirmUseJsonStaging() {
    const confirmBtn = document.getElementById('admin-system-staging-confirm-btn');
    if (confirmBtn) confirmBtn.disabled = true;
    _setStagingError('');

    try {
        const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({use_json: false}),
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            _setStagingError(data.detail || 'Failed to turn off Use JSON.');
            if (confirmBtn) confirmBtn.disabled = false;
            return;
        }

        // DB mode is live now — reload so checkAuth() (app.js) re-runs against
        // Postgres instead of the page carrying stale JSON-mode state.
        window.location.reload();
    } catch (err) {
        _setStagingError('Failed to turn off Use JSON.');
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

// Port Owner → Database button (inside the Database Connection panel). Copies
// just the auth_type=="owner" account from USERS.json into Postgres via
// /api/admin/system/port-owner-to-database. Idempotent (upsert), so it's also
// safe to press outside the staging flow.
async function portOwnerToDatabase() {
    const btn = document.getElementById('admin-system-db-port-owner-btn');
    const status = document.getElementById('admin-system-db-port-owner-status');

    if (btn) btn.disabled = true;
    if (status) {
        status.textContent = 'Copying owner account…';
        status.classList.remove('hidden', 'admin-system-db-status-error', 'admin-system-db-status-ok');
    }

    try {
        const res = await fetch('/api/admin/system/port-owner-to-database', {method: 'POST'});
        const data = await res.json().catch(() => ({}));

        if (status) {
            status.classList.remove('hidden');
            if (!res.ok) {
                status.textContent = data.detail || 'Failed to copy the owner account.';
                status.classList.add('admin-system-db-status-error');
            } else {
                status.textContent = `Owner account "${data.owner}" copied to the database.`;
                status.classList.add('admin-system-db-status-ok');
            }
        }
    } catch (err) {
        if (status) {
            status.classList.remove('hidden');
            status.textContent = 'Failed to copy the owner account.';
            status.classList.add('admin-system-db-status-error');
        }
    } finally {
        if (btn) btn.disabled = false;
        refreshDbModePrecheck();
    }
}

// ── Database Connection panel ───────────────────────────────────────────
// Reads/writes the pieces of DATABASE_URL via /api/admin/system/database-url
// (see app.py). There is no Save button — an edit to any field auto-saves
// (debounced): the POST writes .env + os.environ and resets the engine
// server-side, no reload needed. Each field carries a pip
// (.admin-system-db-pip) showing that edit's save state — amber pending,
// green saved, red failed.
const ADMIN_DB_FIELDS = ['host', 'port', 'database', 'username', 'password', 'sslmode'];
const ADMIN_DB_AUTOSAVE_MS = 800;

function _adminDbInput(name) {
    return document.getElementById(`admin-system-db-${name}`);
}

function _readAdminDbFields() {
    const out = {};
    for (const name of ADMIN_DB_FIELDS) {
        out[name] = _adminDbInput(name)?.value ?? '';
    }
    return out;
}

function _setAdminDbStatus(text, kind) {
    const el = document.getElementById('admin-system-db-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
    el.classList.toggle('admin-system-db-status-error', kind === 'error');
    el.classList.toggle('admin-system-db-status-ok', kind === 'ok');
}

// Per-field save-state dot in the field's label. state: '' (clean) | 'dirty'
// | 'saving' | 'saved' | 'error'.
function _setAdminDbPip(field, state) {
    const pip = document.querySelector(`.admin-system-db-pip[data-field="${field}"]`);
    if (pip) pip.dataset.state = state || '';
}

function _setAdminDbPips(fields, state) {
    for (const f of fields) _setAdminDbPip(f, state);
}

function _clearAllAdminDbPips() {
    document.querySelectorAll('.admin-system-db-pip').forEach(p => { p.dataset.state = ''; });
}

// ── Auto-save ──────────────────────────────────────────────────────────
// Fields edited since the last successful save. The save is atomic (the
// whole DATABASE_URL is recomposed from every field each time), so on
// success every field in this set flips to 'saved' together, then fades
// back to clean.
let _adminDbDirty = new Set();
let _adminDbAutosaveTimer = null;
let _adminDbSaveInFlight = false;
let _adminDbSaveQueued = false;
let _adminDbSavedFadeTimer = null;

// oninput on a field — mark it pending and (re)arm the debounce.
function scheduleAdminDbAutosave(field) {
    if (field) {
        _adminDbDirty.add(field);
        _setAdminDbPip(field, 'dirty');
    }
    clearTimeout(_adminDbAutosaveTimer);
    _adminDbAutosaveTimer = setTimeout(_runAdminDbAutosave, ADMIN_DB_AUTOSAVE_MS);
}

// onchange (blur) / dropdown pick — commit now instead of waiting out the
// debounce.
function flushAdminDbAutosave() {
    if (!_adminDbDirty.size) return;
    clearTimeout(_adminDbAutosaveTimer);
    _runAdminDbAutosave();
}

// SSL dropdown option click — the shared selectAdminPidDropdownOption writes
// the hidden #admin-system-db-sslmode value; wrap it so a pick also triggers
// the same auto-save as a text-field edit.
function selectAdminDbSsl(value, label) {
    selectAdminPidDropdownOption('admin-system-db-ssl-menu', 'admin-system-db-ssl-btn',
        'admin-system-db-sslmode', 'admin-system-db-ssl-label', value, label);
    _adminDbDirty.add('sslmode');
    _setAdminDbPip('sslmode', 'dirty');
    flushAdminDbAutosave();
}

async function _runAdminDbAutosave() {
    if (!_adminDbDirty.size) return;
    if (_adminDbSaveInFlight) { _adminDbSaveQueued = true; return; }

    const fields = _readAdminDbFields();

    // compose_database_url (app.py) needs both host and database — don't POST
    // an un-composable URL (it would 400 on every keystroke while a fresh
    // connection is still half-entered). Hold the pending state and wait for
    // more input.
    const missing = [];
    if (!fields.host.trim()) missing.push('Host');
    if (!fields.database.trim()) missing.push('Database');
    if (missing.length) {
        _setAdminDbStatus(`Enter ${missing.join(' and ')} to save.`, null);
        return;
    }

    const saving = new Set(_adminDbDirty);
    _adminDbSaveInFlight = true;
    clearTimeout(_adminDbSavedFadeTimer);
    _setAdminDbPips(saving, 'saving');
    _setAdminDbStatus('Saving…', null);

    try {
        const res = await fetch('/api/admin/system/database-url', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(fields),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            _setAdminDbStatus(data.detail || 'Failed to save connection.', 'error');
            _setAdminDbPips(saving, 'error');
            return; // leave them in _adminDbDirty so a later edit retries
        }

        // Reflect exactly what got parsed back out — but never clobber a field
        // the user has kept editing (still dirty) or is focused in right now.
        for (const name of ADMIN_DB_FIELDS) {
            const input = _adminDbInput(name);
            if (input && !_adminDbDirty.has(name) && document.activeElement !== input) {
                input.value = data[name] ?? '';
            }
        }
        _syncAdminDbSslDropdown();

        for (const f of saving) _adminDbDirty.delete(f);
        _setAdminDbPips(saving, 'saved');
        _setAdminDbStatus('Saved.', 'ok');
        // One shared fade timer — each save pushes it out, then it clears
        // EVERY still-showing 'saved' pip at once (not just this save's set,
        // or an earlier save's green dot would never fade).
        _adminDbSavedFadeTimer = setTimeout(() => {
            document.querySelectorAll('.admin-system-db-pip[data-state="saved"]').forEach(p => {
                if (!_adminDbDirty.has(p.dataset.field)) p.dataset.state = '';
            });
            _setAdminDbStatus('', null);
        }, 1600);

        // In the staged switch flow, the checklist tracks the saved connection.
        if (adminUseJsonStaging) refreshDbModePrecheck();
    } catch (err) {
        _setAdminDbStatus('Failed to save connection.', 'error');
        _setAdminDbPips(saving, 'error');
    } finally {
        _adminDbSaveInFlight = false;
        // A field edited while the request was in flight (queued flag, or
        // still-dirty entries) — run again.
        if (_adminDbSaveQueued || _adminDbDirty.size) {
            _adminDbSaveQueued = false;
            scheduleAdminDbAutosave();
        }
    }
}

// The SSL field is an .admin-pid-dropdown widget (rotating arrow +
// dropdownReveal, same as the Cards page filters — see admin.html) over a
// hidden <input id="admin-system-db-sslmode"> that _readAdminDbFields /
// load / save treat like any other field. After those write the hidden
// value, mirror it onto the visible button label and the menu's .selected
// row (which a user click keeps in sync itself via selectAdminPidDropdownOption).
function _syncAdminDbSslDropdown() {
    const hidden = document.getElementById('admin-system-db-sslmode');
    const label = document.getElementById('admin-system-db-ssl-label');
    const menu = document.getElementById('admin-system-db-ssl-menu');
    if (!hidden || !label || !menu) return;

    const value = hidden.value || '';
    let matched = null;
    menu.querySelectorAll('.admin-pid-dropdown-option').forEach(opt => {
        const on = opt.dataset.value === value;
        opt.classList.toggle('selected', on);
        if (on) matched = opt;
    });
    label.textContent = matched ? matched.textContent.trim() : (value || 'default');
}

function _resetAdminDbAutosaveState() {
    clearTimeout(_adminDbAutosaveTimer);
    clearTimeout(_adminDbSavedFadeTimer);
    _adminDbDirty.clear();
    _adminDbSaveQueued = false;
    _clearAllAdminDbPips();
    _setAdminDbStatus('', null);
}

async function loadAdminSystemDatabaseSettings() {
    if (!document.getElementById('admin-system-db-host')) return;

    try {
        const res = await fetch('/api/admin/system/database-url');
        if (!res.ok) throw new Error('Failed to load connection');
        const data = await res.json();

        // Direct .value assignment doesn't fire oninput, so this never trips
        // the auto-save — but clear any stale pending state anyway.
        for (const name of ADMIN_DB_FIELDS) {
            const input = _adminDbInput(name);
            if (input) input.value = data[name] ?? '';
        }
        _syncAdminDbSslDropdown();
        _resetAdminDbAutosaveState();
    } catch (err) {
        // Leave fields as-is, same as the toggle-load failure path.
    }
}

async function testAdminSystemDatabaseConnection() {
    const btn = document.getElementById('admin-system-db-test-btn');
    if (btn) btn.disabled = true;
    _setAdminDbStatus('Testing…', null);

    try {
        const res = await fetch('/api/admin/system/database-url/test', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(_readAdminDbFields()),
        });
        const data = await res.json().catch(() => ({}));

        if (data.ok) {
            _setAdminDbStatus('Connection succeeded.', 'ok');
        } else {
            _setAdminDbStatus(data.error || 'Connection failed.', 'error');
        }
    } catch (err) {
        _setAdminDbStatus('Connection failed.', 'error');
    } finally {
        if (btn) btn.disabled = false;
        if (adminUseJsonStaging) refreshDbModePrecheck();
    }
}

// Sync Now — runs scripts/migrate_json_to_pg.py's full migration via the
// background job pattern (see _run_sync_job/api_admin_sync_to_database_*
// in app.py; same start-a-job-then-poll-its-status shape as e.g.
// runAdminPricingRefresh), and renders its captured stdout log in place.
// The safety guard that refuses to wipe price_listings/price_sales/
// card_errors when the JSON source looks suspiciously empty (see
// _guard_full_replace in migrate_json_to_pg.py) surfaces here as an "ok:
// false" job with an "error" message — same as any other failure — not a
// distinct UI state, since from this button's point of view both just mean
// "didn't finish cleanly, here's why."
async function runAdminSystemSync() {
    const btn = document.getElementById('admin-system-sync-btn');
    const log = document.getElementById('admin-system-sync-log');
    if (!btn || !log) return;

    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    log.classList.remove('hidden', 'admin-system-sync-log-error');
    log.textContent = 'Running…';

    try {
        const startRes = await fetch('/api/admin/system/sync-to-database/start', {method: 'POST'});
        if (!startRes.ok) {
            const data = await startRes.json().catch(() => ({}));
            throw new Error(data.detail || 'Failed to start sync.');
        }
        const {job_id} = await startRes.json();

        let result;
        while (true) {
            await new Promise(r => setTimeout(r, 800));
            const statusRes = await fetch(`/api/admin/system/sync-to-database/status/${job_id}`);
            if (!statusRes.ok) throw new Error('Lost track of the sync job.');
            const snapshot = await statusRes.json();
            if (snapshot.status === 'done' || snapshot.status === 'error') {
                result = snapshot;
                break;
            }
        }

        if (result.ok) {
            log.textContent = result.log || '(no output)';
        } else {
            log.classList.add('admin-system-sync-log-error');
            log.textContent = (result.error ? `${result.error}\n\n` : '') + (result.log || '');
        }
    } catch (err) {
        log.classList.add('admin-system-sync-log-error');
        log.textContent = err.message || 'Sync failed.';
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}

// Wipe Database — deletes every row from every Postgres table except
// `users` (see wipe_database in scripts/migrate_json_to_pg.py for why
// users is kept, and for the deliberate choice to put no safety guard
// there the way Sync has: this action is SUPPOSED to destroy data, so the
// only thing standing between a misclick and an irreversible wipe is the
// confirmation right here). Runs synchronously (no job/polling — a
// TRUNCATE is near-instant, unlike Sync's row-by-row work) and shares
// Sync's own result log area.
async function runAdminSystemWipe() {
    const typed = prompt(
        'This permanently deletes every card, pricing, inventory, deck, and watchlist row from the ' +
        'database. Your user accounts are kept. This cannot be undone.\n\nType DELETE to confirm:'
    );
    if (typed !== 'DELETE') return;

    const btn = document.getElementById('admin-system-wipe-btn');
    const log = document.getElementById('admin-system-sync-log');
    if (!btn || !log) return;

    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Wiping…';
    log.classList.remove('hidden', 'admin-system-sync-log-error');
    log.textContent = 'Running…';

    try {
        const res = await fetch('/api/admin/system/wipe-database', {method: 'POST'});
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            throw new Error(data.detail || 'Wipe failed.');
        }

        log.textContent = data.log || '(no output)';
    } catch (err) {
        log.classList.add('admin-system-sync-log-error');
        log.textContent = err.message || 'Wipe failed.';
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}

async function loadAdminUsers() {
    const summary = document.getElementById('admin-user-summary');
    const table = document.getElementById('admin-user-table');
    if (!summary || !table) return;

    summary.textContent = 'Loading...';
    table.innerHTML = '';

    try {
        const res = await fetch('/api/admin/users');
        if (!res.ok) throw new Error('Failed to load users');
        const data = await res.json();

        adminUsersData = data.users || [];
        adminUsersLoaded = true;
        renderAdminUserRows();
    } catch (err) {
        summary.textContent = 'Failed to load users.';
    }
}

function renderAdminUserRows() {
    const summary = document.getElementById('admin-user-summary');
    const table = document.getElementById('admin-user-table');
    if (!summary || !table) return;

    const query = (document.getElementById('admin-user-search')?.value || '').trim().toLowerCase();

    const filtered = adminUsersData.filter(u => {
        if (!query) return true;
        return u.username.toLowerCase().includes(query);
    });

    summary.textContent = `${adminUsersData.length} user(s)`
        + (filtered.length !== adminUsersData.length ? ` — showing ${filtered.length}` : '');

    // The logged-in admin can never delete themselves or anyone at or above
    // their own rank in RANK_ORDER (lower index = higher privilege) — only
    // users strictly below them are deletable.
    const viewerIndex = RANK_ORDER.indexOf(adminUsersData.find(u => u.username === currentUser)?.auth_type);

    const rows = filtered.map(u => {
        const canDelete = viewerIndex >= 0 && u.username !== currentUser && RANK_ORDER.indexOf(u.auth_type) > viewerIndex;
        const deleteBtn = canDelete
            ? `<button type="button" class="admin-pid-detail-delete-btn" title="Delete user"
                   onclick="event.stopPropagation(); deleteAdminUser('${escapeHtml(u.username)}')">&times;</button>`
            : '';

        return `
            <div class="admin-user-row ${u.username === adminUserDetailSelected ? 'admin-user-row-active' : ''}"
                 onclick="selectAdminUserDetail('${escapeHtml(u.username)}')">
                <span class="admin-user-col-name">${escapeHtml(u.username)}</span>
                <span class="admin-user-col-role">${escapeHtml(u.auth_type || '—')}</span>
                <span class="admin-user-col-delete">${deleteBtn}</span>
            </div>
        `;
    }).join('');

    table.innerHTML = rows || '<div class="admin-pid-empty">No users match.</div>';
    syncAdminUserHeaderScrollbarOffset();
}

// Mirrors syncAdminPidHeaderScrollbarOffset() — the header row lives outside
// the scrollable body, so when a scrollbar appears it eats into the body's
// width but not the header's, drifting the Role column out of line with the
// data underneath it unless the header reserves the same strip.
function syncAdminUserHeaderScrollbarOffset() {
    const scrollEl = document.querySelector('#admin-user-list .admin-user-table-scroll');
    const header = document.getElementById('admin-user-table-header');
    if (!scrollEl || !header) return;

    const scrollbarWidth = scrollEl.offsetWidth - scrollEl.clientWidth;
    header.style.paddingRight = `${scrollbarWidth}px`;
}

async function deleteAdminUser(username) {
    const confirmed = await appConfirm(
        `Delete user "${username}"? This permanently removes their account, inventory, and decks.`,
        {title: 'Delete User', confirmLabel: 'Delete'}
    );
    if (!confirmed) return;

    try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, {method: 'DELETE'});
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.detail || 'Failed to delete user.');
            return;
        }

        adminUsersData = adminUsersData.filter(u => u.username !== username);

        if (adminUserDetailSelected === username) {
            adminUserDetailSelected = null;
            adminUserDetailInventory = null;
            adminUserDetailDecks = null;
            renderAdminUserProfileCol();
            renderAdminUserDetail();
            updateAdminUserRoleButtons();
        }

        renderAdminUserRows();
    } catch (err) {
        alert('Request failed.');
    }
}

// Promote/demote move the selected user one step up/down RANK_ORDER from
// their CURRENT rank — there's no fixed target rank anymore now that there
// are 4 tiers instead of a binary admin/local toggle.
function promoteAdminUser() {
    const record = adminUsersData.find(u => u.username === adminUserDetailSelected);
    if (!record) return;
    const idx = RANK_ORDER.indexOf(record.auth_type);
    if (idx <= 0) return;
    setAdminUserRole(RANK_ORDER[idx - 1]);
}

function demoteAdminUser() {
    const record = adminUsersData.find(u => u.username === adminUserDetailSelected);
    if (!record) return;
    const idx = RANK_ORDER.indexOf(record.auth_type);
    if (idx < 0 || idx >= RANK_ORDER.length - 1) return;
    setAdminUserRole(RANK_ORDER[idx + 1]);
}

async function setAdminUserRole(authType) {
    const username = adminUserDetailSelected;
    if (!username) return;

    const promoteBtn = document.getElementById('admin-user-promote-btn');
    const demoteBtn = document.getElementById('admin-user-demote-btn');
    if (promoteBtn) promoteBtn.disabled = true;
    if (demoteBtn) demoteBtn.disabled = true;

    try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/role`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({auth_type: authType}),
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            alert(data.detail || 'Failed to update role.');
            updateAdminUserRoleButtons();
            return;
        }

        const record = adminUsersData.find(u => u.username === username);
        if (record) record.auth_type = authType;

        renderAdminUserRows();
        renderAdminUserProfileCol();
        updateAdminUserRoleButtons();
    } catch (err) {
        alert('Request failed.');
        updateAdminUserRoleButtons();
    }
}

// Buttons "light up" (become enabled) only when a user is selected and the
// action would actually do something. Mirrors the backend's checks in
// api_admin_set_user_role(): the viewer can't touch anyone at or above their
// own rank at all, can't promote someone up to (or past) their own rank, and
// can't demote anyone already at the bottom "user" tier. Also blocks acting
// on yourself, same as before (avoids an admin accidentally locking
// themselves out mid-session).
function updateAdminUserRoleButtons() {
    const promoteBtn = document.getElementById('admin-user-promote-btn');
    const demoteBtn = document.getElementById('admin-user-demote-btn');
    if (!promoteBtn || !demoteBtn) return;

    const record = adminUsersData.find(u => u.username === adminUserDetailSelected);
    const viewerRecord = adminUsersData.find(u => u.username === currentUser);
    const isSelf = adminUserDetailSelected === currentUser;

    if (!record || !viewerRecord || isSelf) {
        promoteBtn.disabled = true;
        demoteBtn.disabled = true;
        return;
    }

    const viewerIndex = RANK_ORDER.indexOf(viewerRecord.auth_type);
    const targetIndex = RANK_ORDER.indexOf(record.auth_type);

    if (targetIndex <= viewerIndex) {
        promoteBtn.disabled = true;
        demoteBtn.disabled = true;
        return;
    }

    promoteBtn.disabled = (targetIndex - 1) <= viewerIndex;
    demoteBtn.disabled = targetIndex >= RANK_ORDER.length - 1;
}

async function selectAdminUserDetail(username) {
    if (adminUserDetailSelected === username) return;

    const profileCol = document.getElementById('admin-user-profile-col');
    const detail = document.getElementById('admin-user-detail');

    profileCol?.classList.add('fade-out');
    detail?.classList.add('fade-out');
    await sleep(150);

    adminUserDetailSelected = username;
    adminUserDetailInventory = null;
    adminUserDetailDecks = null;

    renderAdminUserRows();
    renderAdminUserProfileCol();
    renderAdminUserDetail();
    updateAdminUserRoleButtons();

    profileCol?.classList.remove('fade-out');
    detail?.classList.remove('fade-out');
    profileCol?.classList.add('fade-in');
    detail?.classList.add('fade-in');
    setTimeout(() => {
        profileCol?.classList.remove('fade-in');
        detail?.classList.remove('fade-in');
    }, 200);

    await Promise.all([loadAdminUserInventory(), loadAdminUserDecks()]);
}

async function loadAdminUserInventory() {
    const username = adminUserDetailSelected;
    if (!username) return;

    try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/inventory`);
        if (!res.ok) throw new Error('Failed to load inventory');
        const data = await res.json();

        if (adminUserDetailSelected !== username) return;
        adminUserDetailInventory = data.bins || [];
    } catch (err) {
        if (adminUserDetailSelected !== username) return;
        adminUserDetailInventory = [];
    }

    renderAdminUserProfileCol();
    renderAdminUserDetail();
}

async function loadAdminUserDecks() {
    const username = adminUserDetailSelected;
    if (!username) return;

    try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}/decks`);
        if (!res.ok) throw new Error('Failed to load decks');
        const data = await res.json();

        if (adminUserDetailSelected !== username) return;
        adminUserDetailDecks = data.decks || [];
    } catch (err) {
        if (adminUserDetailSelected !== username) return;
        adminUserDetailDecks = [];
    }

    renderAdminUserProfileCol();
    renderAdminUserDetail();
}

function renderAdminUserProfileCol() {
    const col = document.getElementById('admin-user-profile-col');
    if (!col) return;

    if (!adminUserDetailSelected) {
        col.innerHTML = '<div class="admin-pid-detail-empty">Select a user from the list to view their profile.</div>';
        return;
    }

    const record = adminUsersData.find(u => u.username === adminUserDetailSelected);
    if (!record) {
        col.innerHTML = '<div class="admin-pid-detail-empty">User not found.</div>';
        return;
    }

    const binsLoaded = !!adminUserDetailInventory;
    const decksLoaded = !!adminUserDetailDecks;
    const binCount = binsLoaded ? adminUserDetailInventory.length : null;
    const cardCount = binsLoaded ? adminUserDetailInventory.reduce((sum, b) => sum + b.card_count, 0) : null;
    const deckCount = decksLoaded ? adminUserDetailDecks.length : null;

    col.innerHTML = `
        <div class="admin-pid-detail-header">
            <span class="admin-user-profile-name">${escapeHtml(record.username)}</span>
            <span class="admin-user-profile-role">${escapeHtml(record.auth_type || '—')}</span>
        </div>
        <div class="drawer-stats">
            <div class="drawer-stat">
                <span class="drawer-stat-label">Bins</span>
                <span class="drawer-stat-value">${binCount ?? '…'}</span>
            </div>
            <div class="drawer-stat">
                <span class="drawer-stat-label">Cards</span>
                <span class="drawer-stat-value">${cardCount ?? '…'}</span>
            </div>
            <div class="drawer-stat">
                <span class="drawer-stat-label">Decks</span>
                <span class="drawer-stat-value">${deckCount ?? '…'}</span>
            </div>
        </div>
    `;
}

function renderAdminUserDetail() {
    const panel = document.getElementById('admin-user-detail');
    if (!panel) return;

    if (!adminUserDetailSelected) {
        panel.innerHTML = '';
        return;
    }

    const invLoaded = !!adminUserDetailInventory;
    const decksLoaded = !!adminUserDetailDecks;

    panel.innerHTML = `
        <div class="admin-pid-detail-section" id="admin-user-section-inventory">
            <div class="admin-pid-detail-section-header">
                <span class="admin-pid-detail-section-title">Inventory</span>
            </div>
            ${adminUserBinTilesHtml(invLoaded)}
        </div>
        <div class="admin-pid-detail-section" id="admin-user-section-decks">
            <div class="admin-pid-detail-section-header">
                <span class="admin-pid-detail-section-title">Decks</span>
            </div>
            ${adminUserDeckTilesHtml(decksLoaded)}
        </div>
    `;
}

// Mirrors buildBinTile() in inventory.js (static/css/inventory.css .inv-bin-tile*),
// minus the qty-edit affordances and price-value badge that don't apply to a
// read-only admin overview of someone else's inventory.
function adminUserBinTilesHtml(loaded) {
    if (!loaded) return '<div class="admin-pid-detail-loading">Loading…</div>';
    if (!adminUserDetailInventory.length) return '<div class="admin-pid-detail-empty-small">No inventory bins.</div>';

    const tiles = adminUserDetailInventory.map(b => {
        const banner = b.banner
            ? `<div class="inv-bin-banner" style="background-image: url('/images/${encodeURIComponent(b.banner)}.jpg')"></div>`
            : '';

        return `
            <div class="inv-bin-tile admin-user-tile ${b.default ? 'default-bin' : ''} ${b.banner ? 'has-banner' : ''}">
                ${banner}
                <div class="inv-bin-icon-row">
                    <span class="inv-bin-icon">${b.default ? '📦' : '⬡'}</span>
                    ${b.default ? '<span class="inv-bin-default-badge">Default</span>' : ''}
                </div>
                <div class="inv-bin-name">${escapeHtml(b.name)}</div>
                <div class="inv-bin-desc">${escapeHtml(b.desc || '')}</div>
                <div class="inv-bin-meta-row">
                    <div class="inv-bin-meta">${b.card_count} card${b.card_count !== 1 ? 's' : ''}
                        · ${b.section_count} section${b.section_count !== 1 ? 's' : ''}</div>
                </div>
            </div>
        `;
    }).join('');

    return `<div class="admin-user-tile-grid">${tiles}</div>`;
}

// Mirrors buildDeckTile() in decks_ga.js (static/css/decks_ga.css .dga-deck-tile*),
// read-only — no click-through, since there's no admin deck-detail view.
function adminUserDeckTilesHtml(loaded) {
    if (!loaded) return '<div class="admin-pid-detail-loading">Loading…</div>';
    if (!adminUserDetailDecks.length) return '<div class="admin-pid-detail-empty-small">No decks.</div>';

    const tiles = adminUserDetailDecks.map(d => {
        const banner = d.banner
            ? `<div class="dga-tile-banner" style="background-image: url('/images/${encodeURIComponent(d.banner)}.jpg')"></div>`
            : '';
        const format = d.format ? `<span class="dga-tile-format">${escapeHtml(d.format)}</span>` : '';

        return `
            <div class="dga-deck-tile admin-user-tile ${d.banner ? 'has-banner' : ''}">
                ${banner}
                <div class="dga-tile-icon">⬡</div>
                <div class="dga-tile-name">${escapeHtml(d.name)}${format}</div>
                <div class="dga-tile-desc">${escapeHtml(d.desc || '')}</div>
                <div class="dga-tile-meta">${d.card_count} card${d.card_count !== 1 ? 's' : ''}</div>
            </div>
        `;
    }).join('');

    return `<div class="admin-user-tile-grid">${tiles}</div>`;
}

async function loadAdminPricingIds() {
    const summary = document.getElementById('admin-pid-summary');
    const table = document.getElementById('admin-pid-table');
    if (!summary || !table) return;

    summary.textContent = 'Loading...';
    table.innerHTML = '';

    try {
        const res = await fetch('/api/admin/pricing/product-ids');
        if (!res.ok) throw new Error('Failed to load product IDs');
        const data = await res.json();

        adminPidData = data.editions || [];
        adminDbModeOn = !!data.database_mode;
        adminPidLoaded = true;
        renderAdminPricingIds();
        loadAdminFeaturedSets();
        loadAdminSetSearches();
    } catch (err) {
        summary.textContent = 'Failed to load product IDs.';
    }
}

// release name -> {sets: [{prefix, slug}, ...]} for whichever releases were
// last recorded as Featured (see sync_featured_sets in api_ga.py) — empty
// until loadAdminFeaturedSets resolves, which is fine: renderAdminInfoSetsPanel
// treats "nothing recorded yet" as "nothing is featured" rather than a
// loading state, so the Sets panel just shows a plain list until then.
let adminFeaturedSets = {};

// Flattens adminFeaturedSets (grouped by release) down to just the set of
// slugs that are featured, regardless of which release each came from —
// renderAdminInfoSetsPanel only needs membership, not which release.
function adminFeaturedSlugs() {
    const slugs = new Set();
    for (const group of Object.values(adminFeaturedSets)) {
        for (const s of group.sets || []) {
            if (s.slug) slugs.add(s.slug);
        }
    }
    return slugs;
}

// Plain read of whatever was last recorded — not a live check against
// api.gatcg.com (see checkFeaturedSets for that). Called once when the list
// loads so the Sets panel can group by Featured/Other from the start.
async function loadAdminFeaturedSets() {
    try {
        const res = await fetch('/api/admin/featured-sets');
        if (!res.ok) throw new Error('Failed to load featured sets');
        const data = await res.json();
        adminFeaturedSets = data.featured || {};
    } catch (err) {
        adminFeaturedSets = {};
    }
    renderAdminInfoSetsPanel();
}

// set_filter (same slug scheme as _set_slug in api_ga.py) -> ISO date last
// set-searched (see _set_search_cache in app.py) — which sets have already
// had "Search Set" (searchSelectedAdminSet below) run on them, whether from
// here or from the Cards page's own "$prefix" search (they share the same
// job/cache).
let adminSetSearches = {};

async function loadAdminSetSearches() {
    try {
        const res = await fetch('/api/admin/set-searches');
        if (!res.ok) throw new Error('Failed to load set searches');
        const data = await res.json();
        adminSetSearches = data.searches || {};
    } catch (err) {
        adminSetSearches = {};
    }
    renderAdminInfoSetsPanel();
}

// Info mode's fourth panel — how many editions are loaded locally for each
// set, grouped by set_prefix (matching the same grouping the Set filter
// dropdown uses — see adminPidSetFilterHtml), and split into Featured/Other
// groups once adminFeaturedSets has anything recorded (see
// loadAdminFeaturedSets/checkFeaturedSets) — before that, or if nothing's
// ever been recorded, it's just one plain list with no group labels. Static
// regardless of selection/search/filters, so the counts render once here
// from the full adminPidData when it loads rather than on every filtered row
// re-render (renderAdminPidRows runs far more often, e.g. every search
// keystroke, and would recompute the exact same counts each time for no
// reason).
function renderAdminInfoSetsPanel() {
    const panel = document.getElementById('admin-pricing-sets');
    if (!panel) return;

    // panel.innerHTML below rebuilds .admin-pricing-sets-list from scratch —
    // a brand new element always starts scrolled to the top, so without
    // saving/restoring this, every re-render (e.g. refreshAdminPidData()
    // after a set search finishes) would silently reset however far down the
    // admin had scrolled, even for a set search triggered from near the
    // bottom of a long list.
    const scrollTop = panel.querySelector('.admin-pricing-sets-list')?.scrollTop || 0;

    const counts = new Map(); // set_prefix -> {name, count}
    for (const e of adminPidData) {
        const prefix = e.set_prefix || 'Unknown';
        const entry = counts.get(prefix);
        if (entry) {
            entry.count++;
        } else {
            counts.set(prefix, {name: e.set_name || prefix, count: 1});
        }
    }

    const rows = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));

    // Same scheme _set_slug() (api_ga.py) derives each set's own
    // DATA_GA/SETS_GA/*.json filename from — lowercased, spaces to
    // underscores — not the raw prefix these rows are keyed by. Shared by
    // the Featured lookup below and each row's own "already searched" one.
    const setSlug = prefix => prefix.toLowerCase().replace(/ /g, '_');

    const rowHtml = ([prefix, {name, count}]) => {
        const slug = setSlug(prefix);
        const searchedOn = adminSetSearches[slug]?.last_searched;
        const groupId = adminSetSearches[slug]?.tcgplayer_group_id || '';
        const active = slug === adminSetsSelectedSlug;

        // Clicking anywhere on the row selects it (see selectAdminSet) — the
        // Group ID field and searched badge sit in their own
        // event.stopPropagation()-ed span so editing/reading them doesn't
        // also trigger a selection change.
        return `
            <div class="admin-pricing-sets-row ${active ? 'admin-pricing-sets-row-active' : ''}"
                 id="admin-pricing-sets-row-${escapeHtml(slug)}"
                 onclick="selectAdminSet('${escapeHtml(slug)}')">
                <span class="admin-pricing-sets-name" title="${escapeHtml(name)}">
                    ${escapeHtml(name)} <span class="admin-pricing-sets-prefix">${escapeHtml(prefix)}</span>
                </span>
                <span class="admin-pricing-sets-row-actions" onclick="event.stopPropagation()">
                    <input type="text" class="admin-pricing-sets-groupid" value="${escapeHtml(groupId)}"
                           placeholder="Group ID" inputmode="numeric" autocomplete="off"
                           title="TCGplayer Group ID (tcgcsv.com) for this set"
                           onkeydown="if (event.key === 'Enter') this.blur()"
                           onchange="saveAdminSetGroupId('${escapeHtml(slug)}', this)">
                    <span class="admin-pricing-sets-searched ${searchedOn ? 'admin-pricing-sets-searched-done' : ''}"
                          title="${searchedOn ? `Set-searched ${escapeHtml(searchedOn)}` : 'Not yet set-searched'}">${searchedOn ? '✓' : '—'}</span>
                    <span class="admin-pricing-sets-count">${count}</span>
                </span>
            </div>
        `;
    };

    const groupHtml = (label, groupRows, featured) => !groupRows.length ? '' : `
        <div class="admin-pricing-sets-group-label ${featured ? 'admin-pricing-sets-group-label-featured' : ''}">${escapeHtml(label)}</div>
        ${groupRows.map(rowHtml).join('')}
    `;

    const featuredSlugs = adminFeaturedSlugs();
    const featuredRows = rows.filter(([prefix]) => featuredSlugs.has(setSlug(prefix)));
    const otherRows = rows.filter(([prefix]) => !featuredSlugs.has(setSlug(prefix)));

    // Only actually split into labeled groups once there's a real Featured
    // set to contrast against — otherwise every row would fall into "Other"
    // with a group label sitting over what's really just the whole list.
    const rowsHtml = featuredRows.length
        ? groupHtml('Featured', featuredRows, true) + groupHtml('Other', otherRows, false)
        : rows.map(rowHtml).join('');

    // The three action buttons (Search/Clear/Sync) act on whichever one set
    // is currently selected (see selectAdminSet, searchSelectedAdminSet,
    // clearSelectedAdminSetIds, syncSelectedAdminSetTcgcsv).
    const anySelected = !!adminSetsSelectedSlug;

    panel.innerHTML = `
        <div class="admin-pricing-sets-header">
            <span class="admin-pricing-sets-title">Sets</span>
            <span class="admin-pricing-sets-header-actions">
                <button type="button" class="admin-pricing-sets-action-btn" id="admin-pricing-sets-action-sync" ${anySelected ? '' : 'disabled'}
                        title="Import product IDs from tcgcsv.com for the selected set" onclick="syncSelectedAdminSetTcgcsv()">♻️</button>
                <button type="button" class="admin-pricing-sets-action-btn" id="admin-pricing-sets-action-search" ${anySelected ? '' : 'disabled'}
                        title="Search Set (download cards) for the selected set" onclick="searchSelectedAdminSet()">📥</button>
                <button type="button" class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary admin-pricing-sets-featured-btn"
                        onclick="checkFeaturedSets(this)">Check Featured</button>
                <button type="button" class="admin-pricing-sets-action-btn admin-pricing-sets-action-btn-danger" id="admin-pricing-sets-action-clear" ${anySelected ? '' : 'disabled'}
                        title="Clear saved TCGplayer product IDs for the selected set" onclick="clearSelectedAdminSetIds()">❌</button>
                <a class="admin-pricing-sets-action-btn" href="https://tcgcsv.com" target="_blank" rel="noopener noreferrer"
                   title="Open tcgcsv.com">🌐</a>
            </span>
        </div>
        <div class="admin-pricing-sets-status" id="admin-pricing-sets-status"></div>
        <div class="admin-pricing-sets-progress-wrap hidden" id="admin-pricing-sets-progress-wrap"></div>
        <div class="admin-pricing-sets-list">
            ${rowsHtml || '<div class="admin-pid-detail-empty-small">No cards loaded.</div>'}
        </div>
    `;

    const list = panel.querySelector('.admin-pricing-sets-list');
    if (list) list.scrollTop = scrollTop;
}

// "Check Featured" button in the Sets panel — fetches api.gatcg.com's current
// Featured Sets list via the backend (sync_featured_sets in api_ga.py) and
// records which local set prefixes belong to one, then re-renders the panel
// so the Featured/Other split reflects the fresh check immediately. Manually
// triggered rather than automatic since Featured Sets change infrequently
// (new set releases).
async function checkFeaturedSets(btnEl) {
    const status = document.getElementById('admin-pricing-sets-status');
    if (!status) return;

    btnEl.disabled = true;
    status.classList.remove('admin-pricing-sets-status-error');
    status.textContent = 'Checking…';

    try {
        const res = await fetch('/api/admin/featured-sets/refresh', {method: 'POST'});
        if (!res.ok) throw new Error('Request failed');
        const data = await res.json();

        adminFeaturedSets = data.featured || {};
        const releaseCount = Object.keys(adminFeaturedSets).length;
        const setCount = adminFeaturedSlugs().size;

        // Rebuilds the whole panel (button included, freshly enabled) to
        // reflect the new grouping — the `status`/`btnEl` references above
        // are stale after this, so re-select rather than reuse them.
        renderAdminInfoSetsPanel();
        const newStatus = document.getElementById('admin-pricing-sets-status');
        if (newStatus) {
            newStatus.textContent = `Recorded ${setCount} featured set${setCount === 1 ? '' : 's'} `
                + `across ${releaseCount} release${releaseCount === 1 ? '' : 's'}.`;
        }
    } catch (err) {
        status.classList.add('admin-pricing-sets-status-error');
        status.textContent = 'Failed to check featured sets.';
        btnEl.disabled = false;
    }
}

// Clicking a Sets panel row selects it (mirrors the card list's own
// adminPidDetailSelected single-selection) — the header's Search/Clear/Sync
// buttons act on whichever one set this is. Clicking the already-selected
// row deselects it (unlike the card list, which always has some card open) —
// worth having here since one of those three buttons is destructive, so
// leaving the previous click's target selected by default isn't assumed safe.
function selectAdminSet(slug) {
    adminSetsSelectedSlug = adminSetsSelectedSlug === slug ? null : slug;
    renderAdminInfoSetsPanel();
}

// force=true always disables the three action buttons regardless of
// selection (used while one of them is already mid-run); otherwise it's
// purely "is a set currently selected". A full renderAdminInfoSetsPanel()
// call already sets these correctly from adminSetsSelectedSlug on its own,
// so this is only needed to restore them after an action finishes without
// itself triggering a re-render (e.g. the catch branch below).
function setAdminSetActionButtonsDisabled(force) {
    const disabled = force || !adminSetsSelectedSlug;
    ['admin-pricing-sets-action-search', 'admin-pricing-sets-action-clear', 'admin-pricing-sets-action-sync'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = disabled;
    });
}

// Progress bar for the "Search Set" download — same visual language as the
// Cards page's own set-search progress bar (cardsSetSearchProgressInnerHTML/
// showCardsSetSearchProgress/updateCardsSetSearchProgress/
// hideCardsSetSearchProgress in cards.js), just scoped to this panel's own
// element IDs rather than sharing cards.js's (separate pages, so no
// collision risk either way, but keeping them distinct avoids any confusion
// reading the two side by side).
function adminSetsProgressInnerHTML(done, total, slug, currentCard) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const label = currentCard
        ? `Fetching ${slug.toUpperCase()} — ${done}/${total} — ${currentCard}`
        : `Fetching ${slug.toUpperCase()}${total ? ` — ${done}/${total}` : '…'}`;
    return `
        <div class="admin-pricing-sets-progress-label" id="admin-pricing-sets-progress-label">${escapeHtml(label)}</div>
        <div class="admin-pricing-sets-progress-track">
            <div class="admin-pricing-sets-progress-bar" id="admin-pricing-sets-progress-bar" style="width:${pct}%"></div>
        </div>`;
}

function showAdminSetsProgress(done, total, slug, currentCard) {
    const wrap = document.getElementById('admin-pricing-sets-progress-wrap');
    if (!wrap) return;
    wrap.innerHTML = adminSetsProgressInnerHTML(done, total, slug, currentCard);
    wrap.classList.remove('hidden');
}

function updateAdminSetsProgress(done, total, slug, currentCard) {
    const label = document.getElementById('admin-pricing-sets-progress-label');
    const bar = document.getElementById('admin-pricing-sets-progress-bar');
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (label) {
        label.textContent = currentCard
            ? `Fetching ${slug.toUpperCase()} — ${done}/${total} — ${currentCard}`
            : `Fetching ${slug.toUpperCase()}${total ? ` — ${done}/${total}` : '…'}`;
    }
    if (bar) bar.style.width = `${pct}%`;
}

function hideAdminSetsProgress() {
    const wrap = document.getElementById('admin-pricing-sets-progress-wrap');
    if (!wrap) return;
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
}

// "Search Set" (📥) — starts the SAME background job the Cards page's own
// "$prefix" search bar starts (POST /api/sets/search/start, see
// api_sets_search_start in app.py), which runs set_search() (api_ga.py) to
// download every card in the selected set. Reuses that endpoint rather than
// a separate admin-only one, so a set searched from either place counts for
// both.
//
// Card data only — deliberately does NOT also sync TCGPlayer product IDs;
// that's the ♻ button's job (syncSelectedAdminSetTcgcsv), kept separate so
// an admin can re-download cards without touching product IDs, or vice versa.
async function searchSelectedAdminSet() {
    const slug = adminSetsSelectedSlug;
    if (!slug) return;

    setAdminSetActionButtonsDisabled(true);
    const status = document.getElementById('admin-pricing-sets-status');
    if (status) {
        status.classList.remove('admin-pricing-sets-status-error');
        status.textContent = '';
    }
    showAdminSetsProgress(0, 0, slug, null);

    let message;
    let isError = false;

    try {
        const startRes = await fetch(`/api/sets/search/start?prefix=${encodeURIComponent(slug)}`, {method: 'POST'});
        if (!startRes.ok) throw new Error('Failed to start set search');
        const startData = await startRes.json();

        if (startData.job_id) {
            await pollAdminSetSearchJob(startData.job_id, slug);
        } else {
            // "cached" fast-path — api_sets_search_start's own freshness
            // check decided this set didn't need re-fetching, so there's no
            // job (and no per-card progress) to show — just report it done.
            updateAdminSetsProgress(1, 1, slug, null);
        }

        adminSetSearches[slug] = {...(adminSetSearches[slug] || {}), last_searched: new Date().toISOString().split('T')[0]};
        message = `Downloaded ${slug.toUpperCase()}.`;

        // set_search() may have just downloaded new cards — refreshAdminPidData()
        // re-fetches adminPidData and re-renders the list/Sets panel so counts
        // and "already searched" indicators update immediately. That rebuilds
        // the whole panel (status div included), so the message is set
        // afterward via a fresh lookup rather than the `status` reference above.
        await refreshAdminPidData();
    } catch (err) {
        message = `Failed to search ${slug.toUpperCase()}.`;
        isError = true;
    }

    // refreshAdminPidData() already rebuilds the progress wrap back to its
    // default hidden state on success — this is what actually clears it on
    // the error path, where that rebuild never happened.
    hideAdminSetsProgress();

    const freshStatus = document.getElementById('admin-pricing-sets-status');
    if (freshStatus) {
        freshStatus.classList.toggle('admin-pricing-sets-status-error', isError);
        freshStatus.textContent = message;
    }
    setAdminSetActionButtonsDisabled(false);
}

// "Clear Product IDs" (🗑️) — wipes every saved TCGPlayer product ID (main and
// Curio Foil override alike) for the selected set (POST
// /api/admin/set-searches/{slug}/clear-product-ids, see
// api_admin_clear_set_product_ids in app.py and clear_product_ids_for_set in
// pricing_ga.py). For when a batch of IDs turns out wrong — a tcgcsv
// mismatch, a stale Playwright auto-detect, a manual typo, whatever the
// cause — and needs to be wiped and rechecked from scratch rather than fixed
// one card at a time.
async function clearSelectedAdminSetIds() {
    const slug = adminSetsSelectedSlug;
    if (!slug) return;

    setAdminSetActionButtonsDisabled(true);
    let message;
    let isError = false;

    try {
        const res = await fetch(`/api/admin/set-searches/${encodeURIComponent(slug)}/clear-product-ids`, {method: 'POST'});
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Clear failed');

        message = `Cleared ${data.cleared_main} product ID${data.cleared_main === 1 ? '' : 's'}`
            + (data.cleared_foil ? ` + ${data.cleared_foil} Curio Foil` : '')
            + ` from ${slug.toUpperCase()}.`;

        await refreshAdminPidData();
    } catch (err) {
        message = err.message || 'Clear failed.';
        isError = true;
    }

    const status = document.getElementById('admin-pricing-sets-status');
    if (status) {
        status.classList.toggle('admin-pricing-sets-status-error', isError);
        status.textContent = message;
    }
    setAdminSetActionButtonsDisabled(false);
}

// "Sync from tcgcsv" (♻️) — backfills product IDs for the selected set from
// tcgcsv.com by collector number (POST
// /api/admin/set-searches/{slug}/import-tcgcsv, see api_admin_import_tcgcsv
// in app.py and import_product_ids_from_tcgcsv in pricing_ga.py) instead of
// the fuzzy Playwright search "Auto-detect from TCGPlayer" falls back to.
// 400s (surfaced as a failure below) if this set has no Group ID saved (see
// saveAdminSetGroupId) — tcgcsv needs it to know which set to fetch.
async function syncSelectedAdminSetTcgcsv() {
    const slug = adminSetsSelectedSlug;
    if (!slug) return;

    setAdminSetActionButtonsDisabled(true);
    let message;
    let isError = false;

    try {
        const res = await fetch(`/api/admin/set-searches/${encodeURIComponent(slug)}/import-tcgcsv`, {method: 'POST'});
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Import failed');

        message = `Matched ${data.matched_main} product ID${data.matched_main === 1 ? '' : 's'}`
            + (data.matched_foil ? ` + ${data.matched_foil} Curio Foil` : '')
            + ` from ${data.total_products} tcgcsv product${data.total_products === 1 ? '' : 's'}`
            // A card whose Collector-rarity print keeps the base card's
            // number can otherwise look like an unambiguous number-only
            // match — surfaced here rather than silently folded into
            // "matched" or a generic skip count (see TCGCSV_RARITY_CODE in
            // pricing_ga.py) so a run that's quietly rejecting mismatches
            // doesn't just look identical to one with nothing to reject.
            + (data.skipped_rarity_mismatch
                ? ` (${data.skipped_rarity_mismatch} rarity mismatch${data.skipped_rarity_mismatch === 1 ? '' : 'es'} skipped)`
                : '')
            + '.';

        await refreshAdminPidData();
    } catch (err) {
        message = err.message || 'Import failed.';
        isError = true;
    }

    const status = document.getElementById('admin-pricing-sets-status');
    if (status) {
        status.classList.toggle('admin-pricing-sets-status-error', isError);
        status.textContent = message;
    }
    setAdminSetActionButtonsDisabled(false);
}

// Per-row TCGplayer Group ID field in the Sets panel — saves to
// SET_SEARCHES.json via PATCH /api/admin/set-searches/{slug} (see
// api_admin_set_group_id in app.py). tcgcsv.com's Group ID isn't discoverable
// through anything this app can query on its own, so it's entered manually
// by an admin here rather than looked up automatically. Updates
// adminSetSearches in place rather than re-rendering the whole panel, since a
// full renderAdminInfoSetsPanel() call would rebuild this very input out from
// under the change event that's still firing on it.
async function saveAdminSetGroupId(slug, inputEl) {
    const value = inputEl.value.trim();
    inputEl.disabled = true;
    inputEl.classList.remove('admin-pricing-sets-groupid-error');

    try {
        const res = await fetch(`/api/admin/set-searches/${encodeURIComponent(slug)}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({tcgplayer_group_id: value})
        });
        if (!res.ok) throw new Error('Failed to save group ID');
        const data = await res.json();

        const entry = {...(adminSetSearches[slug] || {})};
        if (data.tcgplayer_group_id) entry.tcgplayer_group_id = data.tcgplayer_group_id;
        else delete entry.tcgplayer_group_id;
        adminSetSearches[slug] = entry;

        inputEl.value = data.tcgplayer_group_id || '';
    } catch (err) {
        inputEl.classList.add('admin-pricing-sets-groupid-error');
    } finally {
        inputEl.disabled = false;
    }
}

// Silent background refresh of adminPidData (e.g. after a bulk action just
// changed product IDs or downloaded new cards) — re-fetches the same data
// loadAdminPricingIds() does and re-renders the list/Sets panel, but without
// that function's "Loading…"/table-clearing side effects, since this isn't
// the page's own initial load. Leaves the previous data in place if the
// refresh itself fails, rather than clearing what was already showing.
async function refreshAdminPidData() {
    try {
        const res = await fetch('/api/admin/pricing/product-ids');
        if (!res.ok) throw new Error('Failed to refresh product IDs');
        const data = await res.json();
        adminPidData = data.editions || [];
    } catch (err) {
        return;
    }
    renderAdminPricingIds();
    renderAdminInfoSetsPanel();
}

// Polls GET /api/sets/search/status/{job_id} (same endpoint pollSetSearchJob
// in cards.js polls) until the job finishes or errors, driving this panel's
// own progress bar (updateAdminSetsProgress) off the same done/total/
// current_card fields cards.js's own poller reads.
async function pollAdminSetSearchJob(jobId, slug) {
    while (true) {
        const res = await fetch(`/api/sets/search/status/${encodeURIComponent(jobId)}`);
        if (!res.ok) return; // job expired/not found — treat as done

        const data = await res.json();

        if (data.status === 'done') {
            // Force the bar to visibly reach 100% (done/total may lag by one
            // tick) before returning — same reasoning as cards.js's poller.
            const total = data.total || data.done || 1;
            updateAdminSetsProgress(total, total, slug, null);
            return;
        }

        updateAdminSetsProgress(data.done || 0, data.total || 0, slug, data.current_card);

        if (data.status === 'error') throw new Error(data.error || 'Set search failed');

        await sleep(500);
    }
}

// Renders one Import-from-JSON button + popover for the row list header
// (see renderAdminPidHeader) — idPrefix must be unique per instance and is
// what ties the button/menu/textarea/status/submit-button together (see
// toggleAdminPidImportPopover/submitAdminPidImport, which read/write these
// same ids). submitFnName is the (unquoted) name of the onclick handler to
// call on Import, e.g. 'submitAdminPidImportIds'.
function adminPidImportPopoverHtml(idPrefix, title, hint, placeholder, submitFnName) {
    return `
        <div class="admin-pid-import-wrap">
            <button type="button" class="admin-pid-import-btn" id="${idPrefix}-btn"
                    onclick="event.stopPropagation(); toggleAdminPidImportPopover('${idPrefix}')" title="${escapeHtml(title)}">📥</button>
            <div class="admin-pid-add-entry-menu admin-pid-import-menu hidden" id="${idPrefix}-menu" onclick="event.stopPropagation()">
                <span class="admin-pid-import-hint">${escapeHtml(hint)}</span>
                <textarea class="admin-pid-import-textarea" id="${idPrefix}-textarea"
                          placeholder='${placeholder}'></textarea>
                <div class="admin-pid-import-actions">
                    <button type="button" class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary"
                            id="${idPrefix}-submit-btn" onclick="${submitFnName}()">Import</button>
                    <span class="admin-pid-import-status" id="${idPrefix}-status"></span>
                </div>
            </div>
        </div>
    `;
}

// Rebuilds just the header row (including the Set filter dropdown), without
// touching the data rows below it — opening/closing the dropdown doesn't
// change which rows are visible, so re-rendering all of them on every click
// (previously ~600ms+ with thousands of editions loaded) was pure waste.
//
// In Info mode (adminCardsView) this renders only Card/Rarity/Set — no
// Check/Product ID/Sales/Listings, which are pricing-only — using the
// .admin-pid-row-info grid-template-columns (admin.css) instead of the full
// 7-column one. See switchAdminCardsView for why that swap isn't animated
// column-by-column.
function renderAdminPidHeader() {
    const header = document.getElementById('admin-pid-table-header');
    if (!header) return;

    const infoMode = adminCardsView === 'info';

    // header.innerHTML below rebuilds both filter dropdowns from scratch, which
    // would otherwise silently reset their option lists back to the top (and
    // replay their open animation) — save/restore each one's scroll position
    // across the rebuild. Scoped per-column since both share the same
    // .set-dropdown-menu class.
    const prevRarityMenu = header.querySelector('.admin-pid-col-rarity .set-dropdown-menu');
    const rarityMenuScrollTop = prevRarityMenu ? prevRarityMenu.scrollTop : 0;
    const prevSetMenu = header.querySelector('.admin-pid-col-set .set-dropdown-menu');
    const setMenuScrollTop = prevSetMenu ? prevSetMenu.scrollTop : 0;

    // Same idea for the select-all checkbox: its checked/indeterminate state is
    // derived from the current row selection by renderAdminPidRows(), which this
    // header-only rebuild doesn't call — save/restore it so it doesn't flash back
    // to an unchecked default every time the header is rebuilt. Not rendered at
    // all in Info mode, so there's nothing to save/restore there.
    const prevSelectAll = document.getElementById('admin-pid-select-all');
    const selectAllChecked = prevSelectAll ? prevSelectAll.checked : false;
    const selectAllIndeterminate = prevSelectAll ? prevSelectAll.indeterminate : false;

    // Same idea for the three Import popovers (Product IDs, Sales,
    // Listings) — an admin mid-paste shouldn't lose that text (or have the
    // popover silently snap shut) just because something else (e.g. a
    // background refresh job finishing) happened to trigger a header
    // rebuild.
    const importPopoverState = ['admin-pid-import-ids', 'admin-pid-import-sales', 'admin-pid-import-listings'].map(prefix => {
        const menu = document.getElementById(`${prefix}-menu`);
        const status = document.getElementById(`${prefix}-status`);
        return {
            prefix,
            open: menu ? !menu.classList.contains('hidden') : false,
            textareaValue: document.getElementById(`${prefix}-textarea`)?.value || '',
            statusHtml: status ? status.innerHTML : '',
            statusClass: status ? status.className : '',
        };
    });

    header.innerHTML = infoMode ? `
        <div class="admin-pid-row admin-pid-row-header admin-pid-row-info">
            <span class="admin-pid-col-name">CARD</span>
            <span class="admin-pid-col-rarity">${adminPidRarityFilterHtml()}</span>
            <span class="admin-pid-col-set">${adminPidSetFilterHtml()}</span>
        </div>
    ` : `
        <div class="admin-pid-row admin-pid-row-header">
            <span class="admin-pid-col-check">
                <input type="checkbox" id="admin-pid-select-all" onchange="toggleSelectAllAdminPricing(this)">
            </span>
            <span class="admin-pid-col-name">CARD</span>
            <span class="admin-pid-col-rarity">${adminPidRarityFilterHtml()}</span>
            <span class="admin-pid-col-set">${adminPidSetFilterHtml()}</span>
            <span class="admin-pid-col-status">
                <input type="checkbox" class="admin-pid-curio-select-all" id="admin-pid-curio-select-all"
                       title="Toggle Curio Foil view for every visible card" onchange="toggleAllAdminPidCurioView(this)">
                Product ID
                ${adminPidImportPopoverHtml('admin-pid-import-ids', 'Import Product IDs from JSON',
                    'Paste ID_TCGPLAYER.json-formatted JSON — only fills in missing product IDs, never overwrites existing ones.',
                    '{"edition_id": {"product_id": "123456"}}', 'submitAdminPidImportIds')}
            </span>
            <span class="admin-pid-col-sales">
                Sales
                ${adminPidImportPopoverHtml('admin-pid-import-sales', 'Import Sales from JSON',
                    'Paste SALES.json-formatted JSON — only adds entries not already stored, so re-importing never creates duplicates.',
                    '{"card_id": {"edition_id": {"foil_id": [{"date": "...", "marketplace": "...", "price": 0, "quantity": 1, "condition": "..."}]}}}',
                    'submitAdminPidImportSales')}
            </span>
            <span class="admin-pid-col-listings">
                Listings
                ${adminPidImportPopoverHtml('admin-pid-import-listings', 'Import Listings from JSON',
                    'Paste LISTINGS.json-formatted JSON — only adds entries not already stored, so re-importing never creates duplicates.',
                    '{"card_id": {"edition_id": {"foil_id": [{"date": "...", "marketplace": "...", "price": 0, "quantity": 1, "condition": "..."}]}}}',
                    'submitAdminPidImportListings')}
            </span>
        </div>
    `;

    const newRarityMenu = header.querySelector('.admin-pid-col-rarity .set-dropdown-menu');
    if (newRarityMenu) newRarityMenu.scrollTop = rarityMenuScrollTop;

    const newSetMenu = header.querySelector('.admin-pid-col-set .set-dropdown-menu');
    if (newSetMenu) newSetMenu.scrollTop = setMenuScrollTop;

    const newSelectAll = document.getElementById('admin-pid-select-all');
    if (newSelectAll) {
        newSelectAll.checked = selectAllChecked;
        newSelectAll.indeterminate = selectAllIndeterminate;
    }

    importPopoverState.forEach(({prefix, open, textareaValue, statusHtml, statusClass}) => {
        const menu = document.getElementById(`${prefix}-menu`);
        if (menu) {
            menu.classList.toggle('hidden', !open);
            document.getElementById(`${prefix}-btn`)?.classList.toggle('open', open);
        }
        const textarea = document.getElementById(`${prefix}-textarea`);
        if (textarea) textarea.value = textareaValue;
        const status = document.getElementById(`${prefix}-status`);
        if (status) {
            status.innerHTML = statusHtml;
            status.className = statusClass;
        }
    });

    updateAdminPidCurioSelectAllState();
}

// Recomputes the header's "select all Curio Foil toggles" checkbox
// (checked/indeterminate/disabled) from current state, the same way
// renderAdminPidRows() derives admin-pid-select-all's — but computed fresh
// each call instead of snapshot-restored across a header rebuild, since
// unlike that one this doesn't need the row list itself to derive it from.
// Scoped to the currently-filtered rows, matching toggleSelectAllAdminPricing's
// own scope (filtered out rows aren't touched by either "select all").
function updateAdminPidCurioSelectAllState() {
    const box = document.getElementById('admin-pid-curio-select-all');
    if (!box) return;

    const curioEligibleIds = adminPidFilteredEditions().filter(e => e.curio).map(e => e.edition_id);
    const onCount = curioEligibleIds.filter(id => adminPidCurioViewSelected.has(id)).length;

    box.disabled = curioEligibleIds.length === 0;
    box.checked = curioEligibleIds.length > 0 && onCount === curioEligibleIds.length;
    box.indeterminate = onCount > 0 && !box.checked;
}

// Header checkbox counterpart to the per-row Curio Foil toggle — turns it
// on/off for every currently-filtered curio-eligible card at once, the same
// way admin-pid-select-all does for row checkboxes (see
// toggleSelectAllAdminPricing). Reuses toggleAdminPidCurioView() per row
// (only actually flipping rows not already at the target state) rather than
// duplicating its DOM-update/fade-animation logic here.
function toggleAllAdminPidCurioView(headerCheckbox) {
    const targetState = headerCheckbox.checked;
    const curioEligible = adminPidFilteredEditions().filter(e => e.curio);

    curioEligible.forEach(e => {
        if (adminPidCurioViewSelected.has(e.edition_id) !== targetState) {
            toggleAdminPidCurioView(e.edition_id, true);
        }
    });

    headerCheckbox.indeterminate = false;
}

function renderAdminPricingIds() {
    renderAdminPidHeader();
    renderAdminPidRows();
}

// Shared by renderAdminPidRows() (needs the actual rows) and
// updateAdminPidSummaryText() (only needs the count) so the two can't drift
// out of sync with each other.
function adminPidFilteredEditions() {
    const query = (document.getElementById('admin-pid-search')?.value || '').trim().toLowerCase();
    const missingOnly = document.getElementById('admin-pid-missing-only')?.checked;

    return adminPidData.filter(e => {
        if (missingOnly && e.product_id) return false;

        if (adminPidSetFilter.size > 0 && !adminPidSetFilter.has(e.set_prefix)) return false;

        if (adminPidRarityFilter.size > 0 && !adminPidRarityFilter.has(e.rarity)) return false;

        if (query) {
            const haystack = `${e.name} ${e.set_prefix || ''} ${e.set_name || ''}`.toLowerCase();
            if (!haystack.includes(query)) return false;
        }

        return true;
    });
}

// Recomputes just the "X of Y editions have a product ID" line — cheap enough
// to call after a single product ID save instead of re-rendering every row
// just to reflect one changed count. Both numbers are scoped to whatever's
// currently filtered/visible (search, Set/Rarity filters, Missing only) —
// not the full unfiltered adminPidData — so the line stays an accurate
// description of the list actually on screen instead of drifting from it
// the moment any filter is active. Per row, checks whichever product ID
// that row is actually showing right now — its Curio Foil's if that row's
// toggle is on, its regular one otherwise — same as adminPidProductIdFieldHtml
// itself picks, so e.g. 3 curio-toggled cards with no curio ID set yet read
// as missing here even though their (currently hidden) regular ID is filled.
function updateAdminPidSummaryText() {
    const summary = document.getElementById('admin-pid-summary');
    if (!summary) return;

    const filtered = adminPidFilteredEditions();
    const withId = filtered.filter(e => {
        const curioView = e.curio && adminPidCurioViewSelected.has(e.edition_id);
        return curioView ? e.curio.product_id : e.product_id;
    }).length;

    summary.textContent = `${withId} of ${filtered.length} editions have a product ID`;
}

// Rebuilds just the row list (and summary/select-all/refresh-button state that
// depend on it) without touching the header — toggling a single set in the Set
// filter calls this directly instead of renderAdminPricingIds() so the dropdown
// menu itself is never recreated, which would otherwise reset its scroll and
// replay its open animation (a visible "flash") on every checkbox click.
function renderAdminPidRows() {
    const summary = document.getElementById('admin-pid-summary');
    const table = document.getElementById('admin-pid-table');
    if (!summary || !table) return;

    const infoMode = adminCardsView === 'info';
    const filtered = adminPidFilteredEditions();
    updateAdminPidSummaryText();

    const rows = filtered.map(e => infoMode ? `
        <div class="admin-pid-row admin-pid-row-info ${e.edition_id === adminPidDetailSelected ? 'admin-pid-row-active' : ''}"
             data-edition-id="${escapeHtml(e.edition_id)}"
             onclick="selectAdminPricingDetail('${escapeHtml(e.edition_id)}')">
            <span class="admin-pid-col-name">${escapeHtml(e.name)}</span>
            <span class="admin-pid-col-rarity">${escapeHtml(e.rarity || '—')}</span>
            <span class="admin-pid-col-set">${escapeHtml(e.set_prefix || '—')}</span>
        </div>
    ` : `
        <div class="admin-pid-row ${e.edition_id === adminPidDetailSelected ? 'admin-pid-row-active' : ''}"
             data-edition-id="${escapeHtml(e.edition_id)}"
             onclick="selectAdminPricingDetail('${escapeHtml(e.edition_id)}')">
            <span class="admin-pid-col-check" onclick="event.stopPropagation()">
                <input type="checkbox" class="admin-pid-row-check" data-edition-id="${escapeHtml(e.edition_id)}"
                       ${adminPidSelected.has(e.edition_id) ? 'checked' : ''}
                       onchange="onAdminPidRowCheckToggle(this)">
            </span>
            <span class="admin-pid-col-name">${escapeHtml(e.name)}</span>
            <span class="admin-pid-col-rarity">${escapeHtml(e.rarity || '—')}</span>
            <span class="admin-pid-col-set">${escapeHtml(e.set_prefix || '—')}</span>
            <span class="admin-pid-col-status" onclick="event.stopPropagation()">
                ${adminPidProductIdFieldHtml(e)}
            </span>
            <span class="admin-pid-col-sales">${adminPidLastUpdatedFieldMarkup(e, 'sales')}</span>
            <span class="admin-pid-col-listings">${adminPidLastUpdatedFieldMarkup(e, 'listings')}</span>
        </div>
    `).join('');

    table.innerHTML = rows || '<div class="admin-pid-empty">No editions match.</div>';

    // Select-all/refresh state only exists in Pricing mode's markup — Info
    // mode has no checkboxes at all, so there's nothing for these to sync.
    if (!infoMode) {
        const filteredIds = filtered.map(e => e.edition_id);
        const selectedInFiltered = filteredIds.filter(id => adminPidSelected.has(id));
        const selectAllBox = document.getElementById('admin-pid-select-all');

        if (selectAllBox) {
            selectAllBox.checked = filteredIds.length > 0 && selectedInFiltered.length === filteredIds.length;
            selectAllBox.indeterminate = selectedInFiltered.length > 0 && !selectAllBox.checked;
        }

        updateAdminPidRefreshButton();
        updateAdminPidCurioSelectAllState();
    }

    syncAdminPidHeaderScrollbarOffset();
}

// The header row lives outside .admin-pid-table-scroll, but the data rows
// live inside it — when there are enough rows for a scrollbar, the browser
// reserves its width from that container only, so the header's identical
// grid-template-columns resolves slightly wider than the rows' and every
// column past the flexible ones (Card/Rarity/Set) drifts right relative to
// the data underneath it. Measuring and mirroring the actual reserved width
// as padding on the header keeps both computing against the same available
// width, whether or not a scrollbar happens to be showing right now.
function syncAdminPidHeaderScrollbarOffset() {
    const scrollEl = document.querySelector('.admin-pid-table-scroll');
    const header = document.getElementById('admin-pid-table-header');
    if (!scrollEl || !header) return;

    const scrollbarWidth = scrollEl.offsetWidth - scrollEl.clientWidth;
    header.style.paddingRight = `${scrollbarWidth}px`;
}

// Used both by the row list (renderAdminPidRows) and the detail panel's own
// product-ID field (renderAdminPricingImageCol) — the same e.curio /
// adminPidCurioViewSelected state drives both, so toggling from the row list
// also switches the open detail panel's field (and, via
// renderAdminPricingDetail's curio filtering, its Sales/Listings) to match.
//
// The toggle button and the 🔍 find button always both render, at the same
// size/spacing, regardless of e.curio or the toggle state — only the find
// button's disabled/grayed state and the input's bound value/handlers change
// between regular and Curio Foil view. This is deliberate: an earlier version
// hid the find button and let the input grow into its place when toggled to
// Curio Foil view, which meant the input visibly resized on every toggle
// click — annoying since Curio Foils don't support auto-detect anyway (no
// way to disambiguate which TCGPlayer listing is the Curio Foil one), so
// graying out the (inert either way) find button instead keeps the layout
// completely static across a toggle click.
//
// The find button IS fully hidden (findBtnHidden) when Use JSON is on —
// auto-detect writes TCGPlayer product IDs and only makes sense against the
// Postgres-backed store. That's a mode-level state, not a per-toggle one, so
// it doesn't reintroduce the resize-on-toggle problem above.
function adminPidProductIdFieldHtml(e) {
    const curioView = e.curio && adminPidCurioViewSelected.has(e.edition_id);
    const finding = adminPidFindingIds.has(e.edition_id);
    const findBtnHidden = adminDbModeOn ? '' : 'hidden';

    const toggleHtml = e.curio ? `
        <button type="button" class="admin-pid-curio-toggle ${curioView ? 'active' : ''}"
                title="${escapeHtml(e.curio.kind)} — toggle to show/edit its own product ID and Sales/Listings"
                onclick="toggleAdminPidCurioView('${escapeHtml(e.edition_id)}')">✨</button>
    ` : '';

    if (curioView) {
        const productId = e.curio.product_id;
        const noListings = productId === ADMIN_PID_NO_LISTINGS_SENTINEL;
        const inputStateClass = noListings ? 'admin-pid-input-no-listings' : productId ? 'admin-pid-input-filled' : '';

        return `
            <div class="admin-pid-pid-wrap">
                ${toggleHtml}
                <input type="text" class="admin-pid-input ${inputStateClass}"
                       data-edition-id="${escapeHtml(e.edition_id)}"
                       data-foil-id="${escapeHtml(e.curio.foil_id)}"
                       value="${escapeHtml(productId || '')}"
                       placeholder="Curio Foil"
                       title="${noListings ? 'Marked as having no TCGPlayer listings' : 'Curio Foil'}"
                       onkeydown="if (event.key === 'Enter') this.blur()"
                       onblur="saveAdminFoilProductId(this)">
                <button type="button" class="admin-pid-find-btn ${findBtnHidden}" disabled
                        title="Curio Foils require manual entry — auto-detect disabled">🔍</button>
            </div>
        `;
    }

    const noListings = e.product_id === ADMIN_PID_NO_LISTINGS_SENTINEL;
    const inputStateClass = noListings ? 'admin-pid-input-no-listings' : e.product_id ? 'admin-pid-input-filled' : '';
    // A card printed ONLY as its special foil (e.curio_only — see
    // _curio_foil_id_for_edition's comment in app.py) has no toggle at all
    // (there's nothing else to toggle to), but its one product ID still IS
    // that Curio Foil's — so its empty-state placeholder says as much,
    // matching what toggled-on curio view would show, even though this is
    // just the ordinary (untoggled) field.
    const missingLabel = e.curio_only ? 'Curio Foil' : 'Missing';

    return `
        <div class="admin-pid-pid-wrap">
            ${toggleHtml}
            <input type="text" class="admin-pid-input ${inputStateClass}"
                   data-edition-id="${escapeHtml(e.edition_id)}"
                   value="${escapeHtml(e.product_id || '')}"
                   placeholder="${missingLabel}"
                   title="${noListings ? 'Marked as having no TCGPlayer listings' : e.curio_only ? 'Curio Foil' : ''}"
                   ${finding ? 'disabled' : ''}
                   onkeydown="if (event.key === 'Enter') this.blur()"
                   onblur="saveAdminProductId(this)">
            <button type="button" class="admin-pid-find-btn ${finding ? 'finding' : ''} ${findBtnHidden}"
                    title="${noListings ? 'Marked as having no TCGPlayer listings — auto-detect disabled' : 'Auto-detect from TCGPlayer'}"
                    ${finding || noListings || !adminDbModeOn ? 'disabled' : ''}
                    onclick="findAdminProductId('${escapeHtml(e.edition_id)}')">${finding ? '…' : noListings ? '🚫' : '🔍'}</button>
        </div>
    `;
}

// Toggles a row between showing/editing its edition-level product ID and its
// Curio Foil's own separate one, and — if that card's detail panel happens
// to be open — re-renders it so the Sales/Listings tables and product-ID
// field switch to match (see renderAdminPricingDetail's curio filtering).
// Targeted DOM update rather than a full renderAdminPidRows() call, matching
// this table's established no-full-re-render performance pattern.
//
// bulk=true (only ever passed by toggleAllAdminPidCurioView) swaps in the
// slower curio-fade-*-bulk timing instead of curio-fade-*/in — a header
// "select all" click reads as rushed at the single-row pace, even though
// it's still only ever animating this one panel (whichever card happens to
// be open), same as an individual row's click.
async function toggleAdminPidCurioView(editionId, bulk = false) {
    if (adminPidCurioViewSelected.has(editionId)) {
        adminPidCurioViewSelected.delete(editionId);
    } else {
        adminPidCurioViewSelected.add(editionId);
    }

    const record = adminPidData.find(e => e.edition_id === editionId);
    if (!record) return;

    const row = document.querySelector(`#admin-pid-table .admin-pid-row[data-edition-id="${CSS.escape(editionId)}"]`);
    const statusCell = row?.querySelector('.admin-pid-col-status');
    if (statusCell) statusCell.innerHTML = adminPidProductIdFieldHtml(record);

    const salesCell = row?.querySelector('.admin-pid-col-sales');
    if (salesCell) salesCell.innerHTML = adminPidLastUpdatedFieldMarkup(record, 'sales');

    const listingsCell = row?.querySelector('.admin-pid-col-listings');
    if (listingsCell) listingsCell.innerHTML = adminPidLastUpdatedFieldMarkup(record, 'listings');

    updateAdminPidCurioSelectAllState();
    updateAdminPidSummaryText();

    if (adminPidDetailSelected === editionId) {
        // The add-entry foil dropdown is filtered by curio-toggle state (see
        // adminPidAddEntryFoilOptions) — the currently-selected foil_id may
        // no longer be one of the options after this toggle, so re-pick a
        // valid default instead of leaving it pointing at a filtered-out one.
        const options = adminPidAddEntryFoilOptions();
        if (!options?.some(f => f.foil_id === adminPidAddEntryFoilId)) {
            adminPidAddEntryFoilId = options?.[0]?.foil_id ?? null;
        }

        // Same kind of fade selectAdminPricingDetail() plays when switching
        // between cards, scoped to just the Sales/Listings panel here rather
        // than the image column too — but with its own slightly slower
        // timing (curio-fade-out/in in admin.css) rather than reusing
        // fade-out/fade-in's exact numbers: fading only this one (smaller)
        // panel instead of both panels together otherwise reads as quicker
        // even though it's the same kind of change.
        const detail = document.getElementById('admin-pricing-detail');
        await fadeSwap(detail, () => renderAdminPricingDetailAll(), {
            outClass: bulk ? 'curio-fade-out-bulk' : 'curio-fade-out',
            inClass: bulk ? 'curio-fade-in-bulk' : 'curio-fade-in',
            outMs: bulk ? 450 : 300,
            inMs: bulk ? 500 : 350,
        });
    }
}

async function saveAdminFoilProductId(input) {
    const editionId = input.dataset.editionId;
    const foilId = input.dataset.foilId;
    const value = input.value.trim();
    const record = adminPidData.find(e => e.edition_id === editionId);
    if (!record || !record.curio) return;

    if ((record.curio.product_id || '') === value) return;

    try {
        const res = await fetch('/api/admin/pricing/product-id', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({edition_id: editionId, foil_id: foilId, product_id: value})
        });
        const data = await res.json();

        if (!res.ok) {
            input.value = record.curio.product_id || '';
            input.classList.add('admin-pid-input-error');
            input.title = data.detail || 'Failed to save';
            setTimeout(() => {
                input.classList.remove('admin-pid-input-error');
                input.title = '';
            }, 3000);
            return;
        }

        record.curio.product_id = data.product_id;

        // The Curio Foil's product ID field can be showing in both the row
        // list and the open detail panel ("card info") at once — same
        // record, but two separate DOM nodes (see adminPidProductIdFieldHtml,
        // used by both renderAdminPidRows and renderAdminPricingImageCol).
        // Sync every matching instance, not just the one that was actually
        // edited, so a save in either place is reflected in the other.
        document.querySelectorAll(
            `.admin-pid-input[data-edition-id="${CSS.escape(editionId)}"][data-foil-id="${CSS.escape(foilId)}"]`
        ).forEach(el => {
            el.value = data.product_id || '';
            el.classList.toggle('admin-pid-input-filled', adminPidIsScrapable(data.product_id));
            el.classList.toggle('admin-pid-input-no-listings', data.product_id === ADMIN_PID_NO_LISTINGS_SENTINEL);
        });

        if (adminPidDetailSelected === editionId) renderAdminPricingDetail();
    } catch (err) {
        input.value = record.curio.product_id || '';
        input.classList.add('admin-pid-input-error');
        setTimeout(() => input.classList.remove('admin-pid-input-error'), 3000);
    }
}

function adminPidSetFilterHtml() {
    const sets = [...new Set(adminPidData.map(e => e.set_prefix).filter(Boolean))].sort();

    const optionsHtml = sets.map(set => `
        <div class="set-dropdown-option ${adminPidSetFilter.has(set) ? 'selected' : ''}" data-set="${escapeHtml(set)}"
             onclick="event.stopPropagation(); toggleAdminPidSetFilterOption('${escapeHtml(set)}')">
            <span>${escapeHtml(set)}</span>
            <div class="set-toggle"></div>
        </div>
    `).join('');

    return `
        <span class="set-dropdown-wrap">
            <button type="button" class="set-dropdown-btn ${adminPidSetFilterOpen ? 'open' : ''}"
                    onclick="event.stopPropagation(); toggleAdminPidSetFilter()">
                <span>Set</span>
                <span class="set-dropdown-arrow">&#8249;</span>
            </button>
            <div class="set-dropdown-menu ${adminPidSetFilterOpen ? '' : 'hidden'}">
                ${optionsHtml || '<div class="admin-pid-detail-empty-small">No sets</div>'}
            </div>
        </span>
    `;
}

// Toggles the button/menu's classes on the existing DOM nodes rather than
// going through renderAdminPidHeader() — rebuilding the header's innerHTML
// would replace the arrow <span> with a fresh element that has no prior
// rotation to transition from, so the CSS rotation (matching the Cards page)
// would snap instantly instead of animating.
function applyAdminPidSetFilterOpenState() {
    const btn = document.querySelector('.admin-pid-col-set .set-dropdown-btn');
    const menu = document.querySelector('.admin-pid-col-set .set-dropdown-menu');
    if (btn) btn.classList.toggle('open', adminPidSetFilterOpen);
    if (menu) menu.classList.toggle('hidden', !adminPidSetFilterOpen);
}

function toggleAdminPidSetFilter() {
    adminPidSetFilterOpen = !adminPidSetFilterOpen;
    applyAdminPidSetFilterOpenState();
}

function closeAdminPidSetFilter() {
    if (!adminPidSetFilterOpen) return;
    adminPidSetFilterOpen = false;
    applyAdminPidSetFilterOpenState();
}

function toggleAdminPidSetFilterOption(set) {
    if (adminPidSetFilter.has(set)) {
        adminPidSetFilter.delete(set);
    } else {
        adminPidSetFilter.add(set);
    }

    // Flip this option's own checkmark in place instead of going through
    // renderAdminPricingIds() — rebuilding the header would recreate the whole
    // dropdown menu and replay its open animation on every click.
    document.querySelectorAll('.admin-pid-col-set .set-dropdown-option').forEach(opt => {
        if (opt.dataset.set === set) opt.classList.toggle('selected', adminPidSetFilter.has(set));
    });

    renderAdminPidRows();
}

// Rarity filter — same dropdown widget/styling as the Set filter above
// (shares its .set-dropdown-* CSS), just scoped to the Rarity column and
// sorted by ADMIN_PID_RARITY_ORDER instead of alphabetically.
function adminPidRarityFilterHtml() {
    const rarities = [...new Set(adminPidData.map(e => e.rarity).filter(Boolean))].sort((a, b) => {
        const ai = ADMIN_PID_RARITY_ORDER.indexOf(a);
        const bi = ADMIN_PID_RARITY_ORDER.indexOf(b);
        if (ai === -1 && bi === -1) return a.localeCompare(b);
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
    });

    const optionsHtml = rarities.map(rarity => `
        <div class="set-dropdown-option ${adminPidRarityFilter.has(rarity) ? 'selected' : ''}" data-rarity="${escapeHtml(rarity)}"
             onclick="event.stopPropagation(); toggleAdminPidRarityFilterOption('${escapeHtml(rarity)}')">
            <span>${escapeHtml(rarity)}</span>
            <div class="set-toggle"></div>
        </div>
    `).join('');

    return `
        <span class="set-dropdown-wrap">
            <button type="button" class="set-dropdown-btn ${adminPidRarityFilterOpen ? 'open' : ''}"
                    onclick="event.stopPropagation(); toggleAdminPidRarityFilter()">
                <span>Rarity</span>
                <span class="set-dropdown-arrow">&#8249;</span>
            </button>
            <div class="set-dropdown-menu ${adminPidRarityFilterOpen ? '' : 'hidden'}">
                ${optionsHtml || '<div class="admin-pid-detail-empty-small">No rarities</div>'}
            </div>
        </span>
    `;
}

// Same reasoning as applyAdminPidSetFilterOpenState() above.
function applyAdminPidRarityFilterOpenState() {
    const btn = document.querySelector('.admin-pid-col-rarity .set-dropdown-btn');
    const menu = document.querySelector('.admin-pid-col-rarity .set-dropdown-menu');
    if (btn) btn.classList.toggle('open', adminPidRarityFilterOpen);
    if (menu) menu.classList.toggle('hidden', !adminPidRarityFilterOpen);
}

function toggleAdminPidRarityFilter() {
    adminPidRarityFilterOpen = !adminPidRarityFilterOpen;
    applyAdminPidRarityFilterOpenState();
}

function closeAdminPidRarityFilter() {
    if (!adminPidRarityFilterOpen) return;
    adminPidRarityFilterOpen = false;
    applyAdminPidRarityFilterOpenState();
}

function toggleAdminPidRarityFilterOption(rarity) {
    if (adminPidRarityFilter.has(rarity)) {
        adminPidRarityFilter.delete(rarity);
    } else {
        adminPidRarityFilter.add(rarity);
    }

    document.querySelectorAll('.admin-pid-col-rarity .set-dropdown-option').forEach(opt => {
        if (opt.dataset.rarity === rarity) opt.classList.toggle('selected', adminPidRarityFilter.has(rarity));
    });

    renderAdminPidRows();
}

// field is 'sales' or 'listings' — each has its own column now, and its own
// slice of adminPidRefreshStatus[editionId] (a refresh can target just one
// of them, so their running/error states are tracked independently).
function adminPidLastUpdatedFieldMarkup(e, field) {
    const status = adminPidRefreshStatus[e.edition_id]?.[field];

    if (status?.state === 'running') {
        return '<span class="admin-pid-updated-running">Running…</span>';
    }

    if (status?.state === 'error') {
        return `<span class="admin-pid-updated-error" title="${escapeHtml(status.message)}">${escapeHtml(status.message)}</span>`;
    }

    // Shows what a just-finished refresh actually changed (e.g. "+1") instead
    // of immediately collapsing back to a day count — sticks around until the
    // admin leaves the pricing screen and comes back, which resets
    // adminPidRefreshStatus (see initAdmin()) and re-fetches real day counts.
    if (status?.state === 'done') {
        return `<span class="admin-pid-updated-done">${escapeHtml(status.message)}</span>`;
    }

    // The Curio Foil's own product page is scraped independently from the
    // edition's regular one (see pricing_ga.py's merge-based scrape
    // orchestration), so it has its own separate last-scraped clock too —
    // show that day count instead of the edition's when toggled on.
    const curioView = e.curio && adminPidCurioViewSelected.has(e.edition_id);
    const days = curioView
        ? (field === 'sales' ? e.curio.sales_days_since : e.curio.listings_days_since)
        : (field === 'sales' ? e.sales_days_since : e.listings_days_since);
    const title = `${field === 'sales' ? 'Sales' : 'Listings'}: ${adminPidDaysSinceLabel(days, true)}`;

    return `<span class="admin-pid-updated-idle" title="${escapeHtml(title)}">`
        + `${escapeHtml(adminPidDaysSinceLabel(days))}</span>`;
}

function adminPidDaysSinceLabel(days, verbose) {
    if (days == null) return verbose ? 'never' : '—';
    if (days === 0) return verbose ? 'today' : '0d';
    return verbose ? `${days} day(s) ago` : `${days}d`;
}

function onAdminPidRowCheckToggle(checkbox) {
    const editionId = checkbox.dataset.editionId;

    if (checkbox.checked) {
        adminPidSelected.add(editionId);
    } else {
        adminPidSelected.delete(editionId);
    }

    updateAdminPidRefreshButton();

    const selectAllBox = document.getElementById('admin-pid-select-all');
    if (selectAllBox) {
        const allChecked = Array.from(document.querySelectorAll('.admin-pid-row-check'))
            .every(cb => cb.checked);
        const anyChecked = Array.from(document.querySelectorAll('.admin-pid-row-check'))
            .some(cb => cb.checked);
        selectAllBox.checked = allChecked;
        selectAllBox.indeterminate = anyChecked && !allChecked;
    }
}

function toggleSelectAllAdminPricing(headerCheckbox) {
    document.querySelectorAll('.admin-pid-row-check').forEach(cb => {
        cb.checked = headerCheckbox.checked;

        if (cb.checked) {
            adminPidSelected.add(cb.dataset.editionId);
        } else {
            adminPidSelected.delete(cb.dataset.editionId);
        }
    });

    headerCheckbox.indeterminate = false;
    updateAdminPidRefreshButton();
}

function getAdminPidRefreshTargets() {
    if (adminPidSelected.size > 0) return Array.from(adminPidSelected);
    return adminPidDetailSelected ? [adminPidDetailSelected] : [];
}

function updateAdminPidRefreshButton() {
    const salesBtn = document.getElementById('admin-pid-refresh-btn-sales');
    const listingsBtn = document.getElementById('admin-pid-refresh-btn-listings');
    const bothBtn = document.getElementById('admin-pid-refresh-btn-both');
    if (!salesBtn || !listingsBtn || !bothBtn) return;

    // The live TCGPlayer refresh controls only apply when Postgres is the
    // backing store — hide the whole group (and keep it inert) otherwise.
    const group = salesBtn.closest('.admin-pid-refresh-group');
    if (group) group.classList.toggle('hidden', !adminDbModeOn);

    const targets = getAdminPidRefreshTargets();
    const disabled = !adminDbModeOn || targets.length === 0 || adminPidRefreshing;
    salesBtn.disabled = disabled;
    listingsBtn.disabled = disabled;
    bothBtn.disabled = disabled;

    bothBtn.textContent = targets.length > 0
        ? `Refresh Selected (${targets.length})`
        : 'Refresh Selected';
}

function updateAdminPidTcgButton() {
    const btn = document.getElementById('admin-pid-tcg-btn');
    if (btn) btn.disabled = !adminPidDetailSelected;
}

// Import [Product IDs/Sales/Listings] buttons — each lives in the row
// list's own header, right above the column it bulk-fills (Product ID,
// Sales, Listings respectively — see renderAdminPidHeader and
// adminPidImportPopoverHtml). idPrefix identifies which one, matching the
// `${idPrefix}-btn`/`-menu`/`-textarea`/`-status`/`-submit-btn` ids
// adminPidImportPopoverHtml() renders.
function toggleAdminPidImportPopover(idPrefix) {
    const btn = document.getElementById(`${idPrefix}-btn`);
    const menu = document.getElementById(`${idPrefix}-menu`);
    if (!btn || !menu) return;

    const opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !opening);
    btn.classList.toggle('open', opening);
}

// Closes every OTHER open import popover than the one e.target is inside —
// called from the page's global outside-click handler. Structural
// (.admin-pid-import-wrap/-menu/-btn) rather than a fixed list of id
// prefixes, so a future 4th import button doesn't need this touched too.
function closeAdminPidImportPopoversOutside(target) {
    document.querySelectorAll('.admin-pid-import-wrap').forEach(wrap => {
        if (wrap.contains(target)) return;

        const menu = wrap.querySelector('.admin-pid-import-menu');
        const btn = wrap.querySelector('.admin-pid-import-btn');
        if (menu && !menu.classList.contains('hidden')) {
            menu.classList.add('hidden');
            btn?.classList.remove('open');
        }
    });
}

// Shared submit handler for all three import popovers — differ only in
// which textarea/status/button to read and update, which endpoint to post
// the parsed JSON to, how to phrase a success message from that endpoint's
// response, and (optionally) what to refresh afterward.
async function submitAdminPidImport(idPrefix, endpoint, buildMessage, afterSuccess) {
    const textarea = document.getElementById(`${idPrefix}-textarea`);
    const status = document.getElementById(`${idPrefix}-status`);
    const btn = document.getElementById(`${idPrefix}-submit-btn`);
    const text = textarea.value.trim();

    if (!text) {
        status.textContent = 'Paste some JSON first.';
        status.className = 'admin-pid-import-status admin-pid-refresh-error';
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        status.textContent = 'Invalid JSON — check for a trailing comma or unclosed brace.';
        status.className = 'admin-pid-import-status admin-pid-refresh-error';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Importing…';
    status.textContent = '';
    status.className = 'admin-pid-import-status';

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({data: parsed}),
        });
        const data = await res.json();

        btn.disabled = false;
        btn.textContent = 'Import';

        if (!res.ok) {
            status.textContent = data.detail || 'Import failed.';
            status.className = 'admin-pid-import-status admin-pid-refresh-error';
            return;
        }

        status.textContent = buildMessage(data);
        textarea.value = '';

        if (afterSuccess) await afterSuccess();
    } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Import';
        status.textContent = 'Import failed — check your connection and try again.';
        status.className = 'admin-pid-import-status admin-pid-refresh-error';
    }
}

// Backfills ID_TCGPLAYER.json (see import_ids() in api_tcgplayer.py for the
// merge rules: only fills in missing product IDs, never overwrites an
// existing one, never imports last_sales/last_listings). Reloads the whole
// product-ID list afterward so newly-imported IDs (and their effect on the
// summary line, day-count badges, etc.) show up immediately.
function submitAdminPidImportIds() {
    return submitAdminPidImport('admin-pid-import-ids', '/api/admin/pricing/import-ids', data => {
        const parts = [`Added ${data.added_main} product ID(s)`];
        if (data.added_foil) parts.push(`${data.added_foil} Curio Foil override(s)`);
        return parts.join(', ') + '.';
    }, loadAdminPricingIds);
}

// Backfills SALES.json/LISTINGS.json (see import_sales()/import_listings()
// in pricing_ga.py: an entry is added only if no exact match — same date,
// marketplace, price, quantity, condition — already exists for that
// card/edition/foil, so re-importing the same export twice is a no-op but
// two genuinely distinct sales/listings sharing a date both come through).
// Refreshes the open card's own Sales/Listings tables afterward, if one's
// open — nothing else on this list changes from a sales/listings import.
// data.skipped_unknown_foil is DB-mode only — entries whose edition/foil
// isn't in the catalog (price rows FK to it, so they can't be inserted blind
// the way a JSON bucket can be).
function adminPidImportSkippedSuffix(data) {
    return data.skipped_unknown_foil
        ? ` (${data.skipped_unknown_foil} skipped — unknown edition/foil)`
        : '';
}

function submitAdminPidImportSales() {
    return submitAdminPidImport('admin-pid-import-sales', '/api/admin/pricing/import-sales',
        data => `Added ${data.added} sale(s)${adminPidImportSkippedSuffix(data)}.`,
        () => adminPidDetailSelected ? loadAdminPricingDetailHistory() : null);
}

function submitAdminPidImportListings() {
    return submitAdminPidImport('admin-pid-import-listings', '/api/admin/pricing/import-listings',
        data => `Added ${data.added} listing(s)${adminPidImportSkippedSuffix(data)}.`,
        () => adminPidDetailSelected ? loadAdminPricingDetailHistory() : null);
}

function openAdminPidTcgPlayer() {
    const record = adminPidData.find(e => e.edition_id === adminPidDetailSelected);
    if (!record) return;

    // When toggled to the Curio Foil view, open its own separate TCGPlayer
    // product page instead of the edition's regular one.
    const curioView = record.curio && adminPidCurioViewSelected.has(record.edition_id);
    const productId = curioView ? record.curio.product_id : record.product_id;
    const searchName = curioView ? `${record.name} ${record.curio.kind}` : record.name;

    // "~" is a real, saved product_id (meaning "confirmed no listings"), but
    // it isn't an actual TCGPlayer product to link to — fall back to a name
    // search the same as a genuinely missing product_id would.
    const url = adminPidIsScrapable(productId)
        ? `https://www.tcgplayer.com/product/${encodeURIComponent(productId)}`
        : `https://www.tcgplayer.com/search/grand-archive/product?q=${encodeURIComponent(searchName)}&productLineName=grand-archive`;

    window.open(url, '_blank', 'noopener');
}

async function saveAdminProductId(input) {
    const editionId = input.dataset.editionId;
    const value = input.value.trim();
    const record = adminPidData.find(e => e.edition_id === editionId);
    if (!record) return;

    if ((record.product_id || '') === value) return;

    try {
        const res = await fetch('/api/admin/pricing/product-id', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({edition_id: editionId, product_id: value})
        });
        const data = await res.json();

        if (!res.ok) {
            input.value = record.product_id || '';
            input.classList.add('admin-pid-input-error');
            input.title = data.detail || 'Failed to save';
            setTimeout(() => {
                input.classList.remove('admin-pid-input-error');
                input.title = '';
            }, 3000);
            return;
        }

        record.product_id = data.product_id;

        if (document.getElementById('admin-pid-missing-only')?.checked) {
            // Whether this row still belongs in the filtered list may have
            // just changed (product ID went from missing to filled, or back)
            // — needs an actual row re-render for correctness, not just a
            // style update. Still skips the header rebuild renderAdminPricingIds()
            // would otherwise do (the Set/Rarity dropdowns don't depend on this).
            renderAdminPidRows();
        } else {
            // Regenerates the whole field (input + find button) rather than
            // just toggling admin-pid-input-filled on the input — the "~"
            // no-listings state also needs admin-pid-input-no-listings and
            // the find button's disabled/🚫 state, which a lone class toggle
            // here previously missed entirely (typing "~" wouldn't visibly
            // gray anything out or lock auto-detect until the next full
            // reload re-rendered the row from scratch).
            const row = document.querySelector(`#admin-pid-table .admin-pid-row[data-edition-id="${CSS.escape(editionId)}"]`);
            const statusCell = row?.querySelector('.admin-pid-col-status');
            if (statusCell) statusCell.innerHTML = adminPidProductIdFieldHtml(record);
            updateAdminPidSummaryText();
        }

        if (adminPidDetailSelected === editionId) renderAdminPricingDetailAll();
    } catch (err) {
        input.value = record.product_id || '';
        input.classList.add('admin-pid-input-error');
        setTimeout(() => input.classList.remove('admin-pid-input-error'), 3000);
    }
}

// Resets the open card's Last Sales/Last Listings clock back to never-scraped
// — mainly useful for forcing past the 7-day listings-refresh gate
// (_listings_gate_result) without waiting it out, or just correcting a badge
// that shouldn't have been marked updated. Clears whichever clock the detail
// panel is actually showing right now — the Curio Foil's own separate one if
// toggled on, the edition's main one otherwise (same product the Last
// Sales/Listings badge and the field below it already reflect).
async function clearAdminPidLastUpdated(field) {
    const editionId = adminPidDetailSelected;
    if (!editionId) return;

    const record = adminPidData.find(e => e.edition_id === editionId);
    if (!record) return;

    const curioView = record.curio && adminPidCurioViewSelected.has(editionId);
    const foilId = curioView ? record.curio.foil_id : undefined;

    try {
        const res = await fetch('/api/admin/pricing/clear-last-updated', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({edition_id: editionId, field, foil_id: foilId}),
        });
        if (!res.ok) return;

        const daysSinceKey = field === 'sales' ? 'sales_days_since' : 'listings_days_since';
        (curioView ? record.curio : record)[daysSinceKey] = null;

        const row = document.querySelector(`#admin-pid-table .admin-pid-row[data-edition-id="${CSS.escape(editionId)}"]`);
        const cell = row?.querySelector(field === 'sales' ? '.admin-pid-col-sales' : '.admin-pid-col-listings');
        if (cell) cell.innerHTML = adminPidLastUpdatedFieldMarkup(record, field);

        // Re-fetches last_sales/last_listings (and curio_last_sales/listings)
        // fresh from the backend rather than hand-patching adminPidDetailHistory
        // locally — already re-renders the image column + detail panel on
        // completion, so the badge and its now-disabled clear button update too.
        await loadAdminPricingDetailHistory();
    } catch (err) {
        // No local state changed yet if the request itself failed — safe to
        // just leave the badge as-is; the admin can retry the click.
    }
}

// Starts a product-ID lookup job and polls it to completion, invoking
// onResult(editionId, {ok, product_id, error}) as each edition finishes.
async function runProductIdJob(editionIds, onResult) {
    const startRes = await fetch('/api/admin/pricing/find-product-ids/start', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({edition_ids: editionIds}),
    });

    if (!startRes.ok) {
        const errData = await startRes.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to start lookup');
    }

    const {job_id} = await startRes.json();
    const seen = new Set();

    while (true) {
        await new Promise(r => setTimeout(r, 1200));

        const statusRes = await fetch(`/api/admin/pricing/find-product-ids/status/${job_id}`);
        if (!statusRes.ok) throw new Error('Lost track of lookup job');

        const job = await statusRes.json();

        for (const [editionId, result] of Object.entries(job.results || {})) {
            if (seen.has(editionId)) continue;
            seen.add(editionId);
            onResult(editionId, result);
        }

        if (job.status === 'error') throw new Error(job.error || 'Unknown error');
        if (job.status === 'done') break;
    }
}

async function findAdminProductId(editionId) {
    if (adminPidFindingIds.has(editionId)) return;

    adminPidFindingIds.add(editionId);
    renderAdminPricingIds();
    if (adminPidDetailSelected === editionId) renderAdminPricingDetailAll();

    try {
        await runProductIdJob([editionId], (eid, result) => {
            const record = adminPidData.find(e => e.edition_id === eid);
            if (record && result.ok) record.product_id = result.product_id;
        });
    } catch (err) {
        // Leave the field as-is — the admin can still type it in manually.
    }

    adminPidFindingIds.delete(editionId);
    renderAdminPricingIds();
    if (adminPidDetailSelected === editionId) renderAdminPricingDetailAll();
}

async function refreshSelectedAdminPricing(target) {
    const requestedIds = getAdminPidRefreshTargets();
    if (adminPidRefreshing || requestedIds.length === 0) return;

    const progress = document.getElementById('admin-pid-progress');

    // Each card refreshes ONLY whichever product its row is currently
    // toggled to — the edition's main (regular) product, or its Curio Foil's
    // own separate one — never both at once, matching whatever the admin is
    // actually looking at for that row (see adminPidProductIdFieldHtml and
    // renderAdminPricingDetail's own curio-scoped filtering). "main" is a
    // literal scope value scrape_batch_tcg_by_editions() understands, not
    // just an absence of scoping.
    const foilScopes = {};
    requestedIds.forEach(id => {
        const record = adminPidData.find(e => e.edition_id === id);
        const curioView = record?.curio && adminPidCurioViewSelected.has(id);
        foilScopes[id] = curioView ? record.curio.foil_id : 'main';
    });

    // A card with no product ID — or "~", which admins enter to mark a card as
    // confirmed to have no TCGPlayer listings at all — can't be scraped: filter
    // those out up front instead of sending them to the batch job (which would
    // otherwise open a browser and try to navigate to a product page that
    // doesn't exist). If that's every requested card (in particular, the
    // common single-card case), cancel the refresh outright instead of
    // starting a job with nothing left to do. Scrapability is checked against
    // whichever product this card is actually scoped to above, not "either".
    const editionIds = requestedIds.filter(id => {
        const record = adminPidData.find(e => e.edition_id === id);
        const productId = foilScopes[id] === 'main' ? record?.product_id : record?.curio?.product_id;
        return adminPidIsScrapable(productId);
    });
    const skippedCount = requestedIds.length - editionIds.length;

    if (editionIds.length === 0) {
        if (progress) {
            progress.classList.remove('hidden');
            progress.textContent = requestedIds.length === 1
                ? 'Cancelled — this card has no TCGPlayer listings to refresh.'
                : `Cancelled — none of the ${requestedIds.length} selected cards have TCGPlayer listings to refresh.`;
            setTimeout(() => progress.classList.add('hidden'), 4000);
        }
        return;
    }

    adminPidRefreshing = true;
    updateAdminPidRefreshButton();

    editionIds.forEach(id => {
        adminPidRefreshStatus[id] = {
            sales: target !== 'listings' ? {state: 'running', message: ''} : null,
            listings: target !== 'sales' ? {state: 'running', message: ''} : null,
        };
    });
    renderAdminPricingIds();

    if (progress) {
        progress.classList.remove('hidden');
        progress.textContent = `Refreshing 0 of ${editionIds.length}…`;
    }

    const markRemainingAsError = (seen, message) => {
        editionIds.forEach(id => {
            if (!seen.has(id)) {
                adminPidRefreshStatus[id] = {
                    sales: target !== 'listings' ? {state: 'error', message} : null,
                    listings: target !== 'sales' ? {state: 'error', message} : null,
                };
            }
        });
        renderAdminPricingIds();
    };

    try {
        const scopedFoilScopes = {};
        editionIds.forEach(id => { scopedFoilScopes[id] = foilScopes[id]; });

        const startRes = await fetch('/api/pricing/refresh/batch/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({edition_ids: editionIds, target, foil_scopes: scopedFoilScopes}),
        });

        if (!startRes.ok) {
            const errData = await startRes.json().catch(() => ({}));
            markRemainingAsError(new Set(), errData.detail || 'Failed to start refresh');
        } else {
            const {job_id} = await startRes.json();
            const seen = new Set();

            while (true) {
                await new Promise(r => setTimeout(r, 1200));

                const statusRes = await fetch(`/api/pricing/refresh/batch/status/${job_id}`);
                if (!statusRes.ok) {
                    markRemainingAsError(seen, 'Lost track of refresh job');
                    break;
                }

                const job = await statusRes.json();

                for (const [editionId, result] of Object.entries(job.results || {})) {
                    if (seen.has(editionId)) continue;
                    seen.add(editionId);

                    const record = adminPidData.find(r => r.edition_id === editionId);
                    if (record) {
                        // Only the side this edition was actually scoped to
                        // (see foilScopes above) was scraped — reset that
                        // one's day counts, not both.
                        const target = scopedFoilScopes[editionId] === 'main' ? record : record.curio;
                        if (target) {
                            if (result.sales?.ok) target.sales_days_since = 0;
                            if (result.listings?.ok && !result.listings.gated) target.listings_days_since = 0;
                        }
                    }

                    adminPidRefreshStatus[editionId] = summarizeAdminPricingRefresh(result.sales, result.listings);

                    if (adminPidDetailSelected === editionId) {
                        await loadAdminPricingDetailHistory();
                    }
                }

                renderAdminPricingIds();

                if (progress) {
                    progress.textContent = `Refreshing ${job.done} of ${job.total}…`;
                }

                if (job.status === 'error') {
                    markRemainingAsError(seen, job.error || 'Unknown error');
                    break;
                }

                if (job.status === 'done') break;
            }
        }
    } catch (err) {
        markRemainingAsError(new Set(), 'Request failed');
    }

    adminPidRefreshing = false;

    if (progress) {
        progress.textContent = `Done refreshing ${editionIds.length} edition(s)`
            + (skippedCount > 0 ? `, skipped ${skippedCount} with no TCGPlayer listings to refresh` : '') + '.';
        setTimeout(() => progress.classList.add('hidden'), 4000);
    }

    updateAdminPidRefreshButton();
}

// sales/listings are each either null (not targeted by this refresh), an
// {ok: false, error} failure, or an {ok: true, stored, ...} success — mirrors
// the shape scrape_sales_and_listings_tcg_by_edition() returns per side.
function summarizeAdminPricingRefresh(sales, listings) {
    return {
        sales: !sales ? null
            : !sales.ok ? {state: 'error', message: sales.error}
            : {state: 'done', message: `+${sales.stored ?? 0}`},
        listings: !listings ? null
            : !listings.ok ? {state: 'error', message: listings.error}
            : listings.gated ? {state: 'done', message: 'gated'}
            : {state: 'done', message: `+${listings.stored ?? 0}`},
    };
}

// Moves the "active" highlight to the clicked row by toggling classes on the
// two affected DOM nodes directly, instead of going through renderAdminPricingIds()
// — with thousands of editions loaded, re-rendering the entire header + row
// list on every card click (previously ~800ms) was pure waste: nothing about
// the row list's content changes when merely switching which card's detail
// view is showing, only which single row is highlighted.
function setAdminPricingActiveRow(editionId) {
    document.querySelectorAll('#admin-pid-table .admin-pid-row.admin-pid-row-active').forEach(row => {
        row.classList.remove('admin-pid-row-active');
    });

    if (!editionId) return;

    const row = document.querySelector(`#admin-pid-table .admin-pid-row[data-edition-id="${CSS.escape(editionId)}"]`);
    row?.classList.add('admin-pid-row-active');
}

async function selectAdminPricingDetail(editionId) {
    if (adminPidDetailSelected === editionId) return;

    const imageCol = document.getElementById('admin-pricing-image-col');
    const detail = document.getElementById('admin-pricing-detail');

    await fadeSwap([imageCol, detail], () => {
        adminPidDetailSelected = editionId;
        adminPidDetailHistory = null;
        adminPidDetailFoils = null;
        adminPidAddEntryOpenType = null;
        adminPidAddEntryFoilId = null;
        adminPidAddEntryCondition = ADMIN_PID_CONDITIONS[0];
        adminPidBulkPasteOpen = false;

        setAdminPricingActiveRow(editionId);
        renderAdminPricingDetailAll();
        updateAdminPidTcgButton();
        // getAdminPidRefreshTargets() falls back to the open detail card when no
        // row checkboxes are checked — without this, selecting a card that way
        // left Refresh Sales/Listings/Selected stuck in whatever disabled state
        // they started in, only ever updating from a checkbox click.
        updateAdminPidRefreshButton();
    });

    await Promise.all([loadAdminPricingDetailHistory(), loadAdminPricingDetailFoils()]);
}

// Restricts the manual add-entry foil choices to whichever side of the row's
// Curio Foil toggle is currently active — Nonfoil/regular Foil (the
// top-level, non-variant options) when off, the Curio Foil variant when on —
// mirroring the same segregation the refresh buttons already enforce (see
// refreshSelectedAdminPricing). Never shows the variant's own specific name
// (e.g. "Aurora Curio Foil") as the option label — this dropdown picks a
// condition-style Nonfoil/Foil split, not a product name — so the curio
// option is labeled with whichever top-level kind it actually nests under
// (its `parent_kind`, from GET .../foils — see the comment there). That's
// virtually always "Foil" in practice, but read from the real data rather
// than assumed, so this stays consistent with how the non-curio side already
// only lists whichever Nonfoil/Foil printings actually exist for the card.
function adminPidAddEntryFoilOptions() {
    if (!adminPidDetailFoils) return null;

    const curioView = adminPidDetailSelected && adminPidCurioViewSelected.has(adminPidDetailSelected);

    if (curioView) {
        const curio = adminPidDetailFoils.find(f => f.is_variant);
        return curio ? [{foil_id: curio.foil_id, kind: curio.parent_kind || 'Foil'}] : [];
    }

    return adminPidDetailFoils.filter(f => !f.is_variant);
}

async function loadAdminPricingDetailFoils() {
    const editionId = adminPidDetailSelected;
    if (!editionId) return;

    try {
        const res = await fetch(`/api/admin/pricing/${editionId}/foils`);
        if (!res.ok) throw new Error('Failed to load foils');
        const data = await res.json();

        if (adminPidDetailSelected !== editionId) return;
        adminPidDetailFoils = data.foils || [];
    } catch (err) {
        if (adminPidDetailSelected !== editionId) return;
        adminPidDetailFoils = [];
    }

    const options = adminPidAddEntryFoilOptions();
    if (!adminPidAddEntryFoilId && options?.length > 0) {
        adminPidAddEntryFoilId = options[0].foil_id;
    }

    // Also re-renders the image column, not just the detail sections — its
    // per-variant product-ID rows (see renderAdminPricingImageCol) depend on
    // adminPidDetailFoils too, and this fetch runs in parallel with
    // loadAdminPricingDetailHistory() with no ordering guarantee between them.
    renderAdminPricingDetailAll();
}

async function loadAdminPricingDetailHistory() {
    const editionId = adminPidDetailSelected;
    if (!editionId) return;

    try {
        const res = await fetch(`/api/admin/pricing/${editionId}/history`);
        if (!res.ok) throw new Error('Failed to load history');
        const data = await res.json();

        if (adminPidDetailSelected !== editionId) return;
        adminPidDetailHistory = data;
    } catch (err) {
        if (adminPidDetailSelected !== editionId) return;
        adminPidDetailHistory = {sales: [], listings: [], last_sales: null, last_listings: null};
    }

    renderAdminPricingDetailAll();
}

function renderAdminPricingDetailAll() {
    renderAdminPricingImageCol();
    renderAdminPricingDetail();
}

function renderAdminPricingImageCol() {
    const col = document.getElementById('admin-pricing-image-col');
    if (!col) return;

    if (!adminPidDetailSelected) {
        const emptyMessage = adminCardsView === 'info'
            ? 'Select a card from the list to view its details.'
            : 'Select a card from the list to view its pricing details.';
        col.innerHTML = `<div class="admin-pid-detail-empty">${emptyMessage}</div>`;
        return;
    }

    const record = adminPidData.find(e => e.edition_id === adminPidDetailSelected);
    if (!record) {
        col.innerHTML = '<div class="admin-pid-detail-empty">Card not found.</div>';
        return;
    }

    const infoMode = adminCardsView === 'info';

    let statsHtml, pidRowHtml;
    if (infoMode) {
        // Info mode isn't about pricing — Released/Last Updated (the
        // edition's own Grand Archive sync dates, see release_date/
        // last_updated on the /api/admin/pricing/product-ids response) swap
        // in for the Last Sales/Last Listings scrape clocks below, and the
        // Product ID field is dropped entirely rather than shown blank.
        statsHtml = `
            <div class="drawer-stats admin-pid-scrape-stats">
                <div class="drawer-stat">
                    <span class="drawer-stat-label">Released</span>
                    <span class="drawer-stat-value">${escapeHtml(record.release_date || 'Unknown')}</span>
                </div>
                <div class="drawer-stat">
                    <span class="drawer-stat-label">Last Updated</span>
                    <span class="drawer-stat-value">${escapeHtml(record.last_updated || 'Unknown')}</span>
                </div>
            </div>
        `;
        pidRowHtml = '';
    } else {
        // The Curio Foil's own product page is scraped/refreshed
        // independently from the edition's regular one (see pricing_ga.py's
        // merge-based scrape orchestration), so it has its own separate
        // last-scraped clocks too — show those instead of the edition's when
        // toggled to Curio Foil view.
        const curioView = record.curio && adminPidCurioViewSelected.has(record.edition_id);
        const historyLoaded = !!adminPidDetailHistory;
        const lastSales = historyLoaded
            ? ((curioView ? adminPidDetailHistory.curio_last_sales : adminPidDetailHistory.last_sales) || 'Never')
            : '…';
        const lastListings = historyLoaded
            ? ((curioView ? adminPidDetailHistory.curio_last_listings : adminPidDetailHistory.last_listings) || 'Never')
            : '…';

        statsHtml = `
            <div class="drawer-stats admin-pid-scrape-stats">
                <div class="drawer-stat">
                    <button type="button" class="admin-pid-clear-last-btn" title="Clear Last Sales date"
                            ${lastSales === 'Never' ? 'disabled' : ''}
                            onclick="clearAdminPidLastUpdated('sales')">❌</button>
                    <span class="drawer-stat-label">Last Sales</span>
                    <span class="drawer-stat-value">${escapeHtml(lastSales)}</span>
                </div>
                <div class="drawer-stat">
                    <button type="button" class="admin-pid-clear-last-btn" title="Clear Last Listings date"
                            ${lastListings === 'Never' ? 'disabled' : ''}
                            onclick="clearAdminPidLastUpdated('listings')">❌</button>
                    <span class="drawer-stat-label">Last Listings</span>
                    <span class="drawer-stat-value">${escapeHtml(lastListings)}</span>
                </div>
            </div>
        `;
        pidRowHtml = `
            <div class="admin-pid-detail-pid-row">
                <label class="admin-pid-detail-label">${(curioView || record.curio_only) ? 'Curio Foil' : 'Product ID'}</label>
                ${adminPidProductIdFieldHtml(record)}
            </div>
        `;
    }

    col.innerHTML = `
        <div class="admin-pid-detail-header">
            <span class="admin-pid-detail-name">${escapeHtml(record.name)}</span>
            <span class="drawer-set">${drawerSetLineHTML(record)}</span>
        </div>
        <div class="admin-pid-detail-image-wrap">
            <div class="tile-img-spinner">${TILE_SPINNER_SVG}</div>
            <img class="admin-pid-detail-image" src="/images/${escapeHtml(record.edition_id)}.jpg" alt="${escapeHtml(record.name)}"
                 onload="revealTileImage(this)" onerror="revealTileImage(this)">
        </div>
        ${statsHtml}
        ${pidRowHtml}
    `;

    const img = col.querySelector('.admin-pid-detail-image');
    if (img && document.getElementById('card-drawer')) {
        img.onclick = () => openCardDrawer(record.card_id, record.edition_id, record.name);
    }
}

function renderAdminPricingDetail() {
    const panel = document.getElementById('admin-pricing-detail');
    if (!panel) return;

    if (!adminPidDetailSelected) {
        panel.innerHTML = '';
        return;
    }

    const record = adminPidData.find(e => e.edition_id === adminPidDetailSelected);
    if (!record) {
        panel.innerHTML = '';
        return;
    }

    // Sales/Listings (and their Refresh/Add Entry actions) are pricing-only
    // — this panel shows the card's raw identifiers instead in Info mode
    // (see renderAdminInfoIdsPanel), a genuinely different "third menu" next
    // to the card info window rather than nothing.
    if (adminCardsView === 'info') {
        renderAdminInfoIdsPanel(panel, record);
        return;
    }

    if (adminPidDetailMode === 'discord') {
        panel.innerHTML = '<div class="admin-pid-detail-empty">Discord listings management is coming soon.</div>';
        panel.classList.remove('admin-pid-popover-open');
        panel.closest('.admin-pricing-layout')?.classList.remove('admin-pid-popover-open');
        return;
    }

    // A Curio Foil has its own separate TCGPlayer product page — its sales
    // and listings never mix with the edition's regular nonfoil+foil ones,
    // so when toggled on (from the row list, see toggleAdminPidCurioView)
    // the tables below show ONLY that foil's rows, and when off they show
    // everything else (i.e. with the Curio Foil's own rows excluded).
    const curioFoilId = record.curio?.foil_id;
    const curioView = !!curioFoilId && adminPidCurioViewSelected.has(record.edition_id);
    const filterByCurio = rows => !curioFoilId ? rows : rows.filter(r => curioView ? r.foil_id === curioFoilId : r.foil_id !== curioFoilId);

    const historyLoaded = !!adminPidDetailHistory;
    const salesRows = historyLoaded ? filterByCurio(adminPidDetailHistory.sales) : [];
    const listingsRows = historyLoaded ? filterByCurio(adminPidDetailHistory.listings) : [];
    // A curio_only card (no toggle at all — see e.curio_only's comment)
    // still has all of its history belonging to that one Curio Foil, so the
    // suffix shows unconditionally for it, same as toggled-on curio view.
    const curioTitleSuffix = (curioView || record.curio_only) ? ' — Curio Foil' : '';

    panel.innerHTML = `
        <div class="admin-pid-detail-section" id="admin-pid-section-sales">
            <div class="admin-pid-detail-section-header">
                <span class="admin-pid-detail-section-title">Sales${curioTitleSuffix}</span>
                <div class="admin-pid-section-actions">
                    ${adminPidBulkPasteTriggerHtml()}
                    ${adminPidAddEntryTriggerHtml('sales')}
                </div>
            </div>
            ${adminPidDetailHistoryTableHtml(salesRows, historyLoaded, 'sales')}
        </div>
        <div class="admin-pid-detail-section" id="admin-pid-section-listings">
            <div class="admin-pid-detail-section-header">
                <span class="admin-pid-detail-section-title">Listings${curioTitleSuffix}</span>
                ${adminPidAddEntryTriggerHtml('listings')}
            </div>
            ${adminPidDetailHistoryTableHtml(listingsRows, historyLoaded, 'listings')}
        </div>
    `;

    // Lifts each ancestor's own overflow clipping while its popup (bulk-paste or
    // add-entry) is open so the dropdown isn't cut off, without needing any
    // JS-computed positioning — the popup itself stays on plain CSS positioning
    // (see .admin-pid-add-entry-menu), since this page's global `zoom` scale
    // doesn't compose correctly with manually-set position values. Three levels
    // need lifting: the section, the detail panel, and .admin-pricing-layout
    // (the list/image/detail column row) — a popup nested deep enough (e.g. the
    // marketplace dropdown inside the add-entry popup) reaches past all three.
    const salesPopoverOpen = adminPidBulkPasteOpen || adminPidAddEntryOpenType === 'sales';
    const listingsPopoverOpen = adminPidAddEntryOpenType === 'listings';
    const anyPopoverOpen = salesPopoverOpen || listingsPopoverOpen;
    panel.classList.toggle('admin-pid-popover-open', anyPopoverOpen);
    panel.closest('.admin-pricing-layout')?.classList.toggle('admin-pid-popover-open', anyPopoverOpen);
    document.getElementById('admin-pid-section-sales')?.classList.toggle('admin-pid-popover-open', salesPopoverOpen);
    document.getElementById('admin-pid-section-listings')?.classList.toggle('admin-pid-popover-open', listingsPopoverOpen);
}

// Info mode's third panel (renderAdminPricingDetail's own track, next to the
// card info window) — the card's raw identifiers rather than anything
// pricing-related, as a tree: Card → Edition → each Nonfoil/Foil/Curio Foil
// variant, matching how they actually nest in the data rather than a flat
// list. card_id/edition_id are both already on `record`, no extra fetch;
// adminPidDetailFoils is already being fetched regardless of mode (see
// selectAdminPricingDetail), so this only needs to handle it not having
// arrived yet.
// Small "LABEL value" chip used both for the Edition node's own metadata
// (rarity/dates/illustrator) and each foil leaf's population — falls back to
// an em dash for a missing value rather than omitting the chip entirely, so
// the set of fields shown stays consistent from row to row.
function adminInfoTreeMetaChip(label, value) {
    return `<span class="admin-pid-id-tree-meta-item">
        <span class="admin-pid-id-tree-meta-label">${escapeHtml(label)}</span> ${escapeHtml(value || '—')}
    </span>`;
}

function renderAdminInfoIdsPanel(panel, record) {
    let foilsHtml;
    if (!adminPidDetailFoils) {
        foilsHtml = '<li class="admin-pid-id-tree-node"><span class="admin-pid-id-tree-row"><span class="admin-pid-detail-loading">Loading…</span></span></li>';
    } else if (adminPidDetailFoils.length === 0) {
        foilsHtml = '<li class="admin-pid-id-tree-node"><span class="admin-pid-id-tree-row"><span class="admin-pid-detail-empty-small">No foils found.</span></span></li>';
    } else {
        // Printing (Nonfoil/Foil/Curio Foil, etc.) is f.kind, already shown as
        // this leaf's own label — Population is the one additional per-foil
        // stat (see /api/admin/pricing/{edition_id}/foils in app.py).
        foilsHtml = adminPidDetailFoils.map(f => `
            <li class="admin-pid-id-tree-node">
                <span class="admin-pid-id-tree-row">
                    <span class="admin-pid-detail-label">${escapeHtml(f.kind)}</span>
                    <span class="admin-pid-detail-id-value">${escapeHtml(f.foil_id)}</span>
                    ${adminInfoTreeMetaChip('Pop', f.population != null ? String(f.population) : null)}
                </span>
            </li>
        `).join('');
    }

    // Rarity/dates/illustrator describe the EDITION node itself, not a child
    // of it — rendered as a sibling block between its own row and its foils
    // list, indented by that node's own padding (no separate margin needed)
    // rather than as another branch in the tree.
    const editionMetaHtml = `
        <div class="admin-pid-id-tree-meta">
            ${adminInfoTreeMetaChip('Rarity', record.rarity)}
            ${adminInfoTreeMetaChip('Released', record.release_date)}
            ${adminInfoTreeMetaChip('Created', record.created_date)}
            ${adminInfoTreeMetaChip('Updated', record.last_updated)}
            ${adminInfoTreeMetaChip('Illustrator', record.illustrator)}
        </div>
    `;

    panel.innerHTML = `
        <div class="admin-pid-detail-section">
            <div class="admin-pid-detail-section-header">
                <span class="admin-pid-detail-section-title">Identifiers</span>
            </div>
            <ul class="admin-pid-id-tree-list">
                <li class="admin-pid-id-tree-node admin-pid-id-tree-node-root">
                    <span class="admin-pid-id-tree-row">
                        <span class="admin-pid-detail-label">Card</span>
                        <span class="admin-pid-detail-id-value">${escapeHtml(record.card_id)}</span>
                    </span>
                    <ul class="admin-pid-id-tree-list">
                        <li class="admin-pid-id-tree-node">
                            <span class="admin-pid-id-tree-row">
                                <span class="admin-pid-detail-label">Edition</span>
                                <span class="admin-pid-detail-id-value">${escapeHtml(record.edition_id)}</span>
                            </span>
                            ${editionMetaHtml}
                            <ul class="admin-pid-id-tree-list">
                                ${foilsHtml}
                            </ul>
                        </li>
                    </ul>
                </li>
            </ul>
            <div class="admin-pid-id-tree-footer">
                <div class="drawer-stat admin-pid-id-tree-synced-stat">
                    <span class="drawer-stat-label">Last Synced</span>
                    <span class="drawer-stat-value">${escapeHtml(record.system_updated || 'Never')}</span>
                </div>
                <button type="button" class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary admin-pid-id-tree-refresh-btn"
                        onclick="refreshAdminCard('${escapeHtml(record.edition_id)}', this)">Refresh Card</button>
            </div>
        </div>
    `;
}

// Bottom-left "Refresh Card" button in the Identifiers panel — forces a full
// re-fetch of the selected card (POST /api/admin/pricing/{edition_id}/refresh-card,
// see api_admin_refresh_card in app.py, which calls card_reset in api_ga.py)
// rather than waiting for UPDATE_THRESHOLD's normal staleness window. On
// success, refreshes adminPidData (so the Last Synced stat next to this
// button, the Sets panel counts, etc. all reflect whatever just changed) and
// re-renders this same card's detail — the edition_id passed in is fixed at
// the time the button was rendered, so if the admin has since selected a
// DIFFERENT card, this intentionally does nothing to the (now stale) button
// click rather than refreshing the wrong card's view.
async function refreshAdminCard(editionId, btnEl) {
    if (btnEl.disabled) return;

    const originalText = btnEl.textContent;
    btnEl.disabled = true;
    btnEl.textContent = 'Refreshing…';

    try {
        const res = await fetch(`/api/admin/pricing/${editionId}/refresh-card`, {method: 'POST'});
        if (!res.ok) throw new Error('Refresh failed');

        await refreshAdminPidData();
        if (adminPidDetailSelected === editionId) {
            renderAdminPricingDetailAll();
        }
    } catch (err) {
        btnEl.textContent = 'Refresh failed';
        btnEl.disabled = false;
        setTimeout(() => {
            btnEl.textContent = originalText;
        }, 2000);
    }
}

// Regular/Discord pill — swaps the whole detail panel's content (both Sales
// and Listings sections together) for the currently-selected card, since
// Discord listings need an entirely different UI (sporadic chat-server
// posts) rather than just a different filter on the same sections. The card
// list and image column are unaffected — picking a card works the same
// either way, only what's shown once one's selected changes.
function switchAdminPidDetailMode(mode) {
    if (adminPidDetailMode === mode) return;
    adminPidDetailMode = mode;

    document.querySelectorAll('#admin-pid-source-toggle .admin-pid-source-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    positionPillIndicator(document.getElementById('admin-pid-source-toggle'));

    renderAdminPricingDetail();
}

function adminPidAddEntryTriggerHtml(type) {
    const isOpen = adminPidAddEntryOpenType === type;

    return `
        <div class="admin-pid-add-entry-wrap">
            <button class="admin-pid-add-entry-toggle ${isOpen ? 'open' : ''}" onclick="toggleAdminPidAddEntry('${type}')">+</button>
            ${isOpen ? adminPidAddEntryFormHtml(type) : ''}
        </div>
    `;
}

function toggleAdminPidAddEntry(type) {
    adminPidAddEntryOpenType = adminPidAddEntryOpenType === type ? null : type;
    if (adminPidAddEntryOpenType !== null) adminPidBulkPasteOpen = false;
    renderAdminPricingDetail();
}

function closeAdminPidAddEntry() {
    if (adminPidAddEntryOpenType === null) return;
    adminPidAddEntryOpenType = null;
    renderAdminPricingDetail();
}

function adminPidBulkPasteTriggerHtml() {
    const isOpen = adminPidBulkPasteOpen;

    return `
        <div class="admin-pid-add-entry-wrap admin-pid-bulk-paste-wrap">
            <button class="admin-pid-add-entry-toggle ${isOpen ? 'open' : ''}" title="Paste bulk sales from TCGPlayer"
                    onclick="toggleAdminPidBulkPaste()">&#9113;</button>
            ${isOpen ? adminPidBulkPasteFormHtml() : ''}
        </div>
    `;
}

function toggleAdminPidBulkPaste() {
    adminPidBulkPasteOpen = !adminPidBulkPasteOpen;
    if (adminPidBulkPasteOpen) adminPidAddEntryOpenType = null;
    renderAdminPricingDetail();
}

function closeAdminPidBulkPaste() {
    if (!adminPidBulkPasteOpen) return;
    adminPidBulkPasteOpen = false;
    renderAdminPricingDetail();
}

function adminPidBulkPasteFormHtml() {
    const record = adminPidData.find(e => e.edition_id === adminPidDetailSelected);
    const curioView = record?.curio && adminPidCurioViewSelected.has(adminPidDetailSelected);

    return `
        <div class="admin-pid-add-entry-menu admin-pid-bulk-paste-menu">
            <span class="admin-pid-bulk-paste-hint">
                Highlight and copy the sales history table straight off TCGPlayer, then paste it here —
                works around the ~5-row cap when scraping while logged out.
                ${curioView ? ' Imports to the Curio Foil, not the regular product.' : ''}
            </span>
            <textarea class="admin-pid-bulk-paste-textarea" id="admin-pid-bulk-paste-textarea"
                      placeholder="7/9/26&#10;NM&#10;1&#9;$0.05"></textarea>
            <div class="admin-pid-add-entry-actions">
                <button class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary" id="admin-pid-bulk-paste-btn"
                        onclick="submitAdminPidBulkPasteSales()">Import</button>
                <span class="admin-pid-add-entry-status" id="admin-pid-bulk-paste-status"></span>
            </div>
        </div>
    `;
}

async function submitAdminPidBulkPasteSales() {
    const editionId = adminPidDetailSelected;
    if (!editionId || adminPidBulkPastePending) return;

    const btn = document.getElementById('admin-pid-bulk-paste-btn');
    const status = document.getElementById('admin-pid-bulk-paste-status');
    const textarea = document.getElementById('admin-pid-bulk-paste-textarea');
    const text = textarea.value.trim();

    if (!text) {
        status.textContent = 'Paste some sales data first.';
        status.className = 'admin-pid-add-entry-status admin-pid-refresh-error';
        return;
    }

    adminPidBulkPastePending = true;
    btn.disabled = true;
    btn.textContent = 'Importing…';
    status.textContent = '';
    status.className = 'admin-pid-add-entry-status';

    // Segregated the same way refresh/manual-add already are (see
    // refreshSelectedAdminPricing, adminPidAddEntryFoilOptions): pasted rows
    // come from whichever product's page the admin actually copied them from,
    // so toggled-on attributes every row to the Curio Foil, never mixing it
    // with the edition's regular nonfoil/foil data.
    const record = adminPidData.find(e => e.edition_id === editionId);
    const curioView = record?.curio && adminPidCurioViewSelected.has(editionId);
    const foilId = curioView ? record.curio.foil_id : undefined;

    try {
        const res = await fetch(`/api/admin/pricing/${editionId}/import-sales`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({text, foil_id: foilId}),
        });
        const data = await res.json();

        adminPidBulkPastePending = false;
        if (adminPidDetailSelected !== editionId) return;

        if (!res.ok) {
            btn.disabled = false;
            btn.textContent = 'Import';
            status.textContent = data.detail || 'Failed to import sales.';
            status.className = 'admin-pid-add-entry-status admin-pid-refresh-error';
            return;
        }

        const parts = [`Imported ${data.stored} sale(s)`];
        if (data.skipped_duplicate) parts.push(`${data.skipped_duplicate} already recorded`);
        if (data.skipped_today) parts.push(`${data.skipped_today} from today excluded`);
        if (data.skipped_unrecognized) parts.push(`${data.skipped_unrecognized} unrecognized variant(s)`);
        if (data.parse_errors && data.parse_errors.length) parts.push(`${data.parse_errors.length} line(s) unparsed`);

        // A successful import (res.ok) always reached the point in
        // import_pasted_sales_tcg_by_edition() that stamps last_sales, even if
        // every entry turned out to be a duplicate — keep the row's badge in sync.
        const record = adminPidData.find(r => r.edition_id === editionId);
        if (record) {
            record.sales_days_since = 0;
            renderAdminPidRows();
        }

        await loadAdminPricingDetailHistory();

        const freshStatus = document.getElementById('admin-pid-bulk-paste-status');
        if (freshStatus) {
            freshStatus.textContent = parts.join(' · ');
            freshStatus.className = `admin-pid-add-entry-status admin-pid-refresh-${data.stored > 0 ? 'done' : 'error'}`;
        }

        const freshTextarea = document.getElementById('admin-pid-bulk-paste-textarea');
        if (freshTextarea) freshTextarea.value = '';

        const freshBtn = document.getElementById('admin-pid-bulk-paste-btn');
        if (freshBtn) {
            freshBtn.disabled = false;
            freshBtn.textContent = 'Import';
        }
    } catch (err) {
        adminPidBulkPastePending = false;
        if (adminPidDetailSelected !== editionId) return;
        btn.disabled = false;
        btn.textContent = 'Import';
        status.textContent = 'Request failed.';
        status.className = 'admin-pid-add-entry-status admin-pid-refresh-error';
    }
}

function adminPidTodayIso() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function adminPidAddEntryFormHtml(type) {
    const foilOptions = adminPidAddEntryFoilOptions();
    const foilsLoaded = !!foilOptions;
    const selectedFoil = foilsLoaded ? foilOptions.find(f => f.foil_id === adminPidAddEntryFoilId) : null;
    const foilLabel = !foilsLoaded ? 'Loading…' : (selectedFoil ? selectedFoil.kind : 'No options');

    const foilDropdown = adminPidDropdownHtml({
        wrapId: 'admin-pid-foil-dropdown-wrap',
        menuId: 'admin-pid-foil-dropdown-menu',
        btnId: 'admin-pid-foil-dropdown-btn',
        labelId: 'admin-pid-foil-dropdown-label',
        hiddenId: 'admin-pid-add-foil',
        label: foilLabel,
        value: adminPidAddEntryFoilId,
        disabled: !foilsLoaded,
        options: foilsLoaded ? foilOptions.map(f => ({value: f.foil_id, label: f.kind})) : [],
        onSelect: 'selectAdminPidFoilOption',
    });

    const conditionDropdown = adminPidDropdownHtml({
        wrapId: 'admin-pid-condition-dropdown-wrap',
        menuId: 'admin-pid-condition-dropdown-menu',
        btnId: 'admin-pid-condition-dropdown-btn',
        labelId: 'admin-pid-condition-dropdown-label',
        hiddenId: 'admin-pid-add-condition',
        label: adminPidAddEntryCondition,
        value: adminPidAddEntryCondition,
        disabled: false,
        options: ADMIN_PID_CONDITIONS.map(c => ({value: c, label: c})),
        onSelect: 'selectAdminPidConditionOption',
    });

    return `
        <div class="admin-pid-add-entry-menu">
            ${foilDropdown}
            <div class="admin-pid-add-entry-row">
                <input type="number" step="0.01" min="0" class="admin-pid-add-entry-input" id="admin-pid-add-price" placeholder="Price">
                <input type="number" min="1" step="1" class="admin-pid-add-entry-input admin-pid-add-entry-qty" id="admin-pid-add-qty" placeholder="Qty" value="1">
            </div>
            <input type="date" class="admin-pid-add-entry-input" id="admin-pid-add-date" value="${adminPidTodayIso()}" max="${adminPidTodayIso()}">
            ${conditionDropdown}
            ${adminPidMarketplaceFieldHtml()}
            <div class="admin-pid-add-entry-actions">
                <button class="admin-pid-refresh-btn admin-pid-refresh-btn-secondary" id="admin-pid-add-entry-btn"
                        onclick="submitAdminPricingManualEntry('${type}')" ${foilsLoaded ? '' : 'disabled'}>Add</button>
                <span class="admin-pid-add-entry-status" id="admin-pid-add-entry-status"></span>
            </div>
        </div>
    `;
}

function adminPidDropdownHtml({wrapId, menuId, btnId, labelId, hiddenId, label, value, disabled, options, onSelect}) {
    const optionsHtml = options.map(o => `
        <div class="admin-pid-dropdown-option ${o.value === value ? 'selected' : ''}"
             data-value="${escapeHtml(o.value)}"
             onclick="${onSelect}('${escapeHtml(o.value)}', '${escapeHtml(o.label)}')">
            ${escapeHtml(o.label)}
        </div>
    `).join('');

    return `
        <div class="admin-pid-dropdown-wrap" id="${wrapId}">
            <button type="button" class="admin-pid-dropdown-btn" id="${btnId}"
                    onclick="toggleAdminPidDropdown('${menuId}', '${btnId}')" ${disabled ? 'disabled' : ''}>
                <span id="${labelId}">${escapeHtml(label || '')}</span>
                <span class="admin-pid-dropdown-arrow">&#8249;</span>
            </button>
            <div class="admin-pid-dropdown-menu hidden" id="${menuId}">
                ${optionsHtml}
            </div>
            <input type="hidden" id="${hiddenId}" value="${escapeHtml(value || '')}">
        </div>
    `;
}

function toggleAdminPidDropdown(menuId, btnId) {
    const menu = document.getElementById(menuId);
    const btn = document.getElementById(btnId);
    if (!menu || !btn) return;

    const isOpen = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden', isOpen);
    btn.classList.toggle('open', !isOpen);
}

function closeAdminPidDropdown(menuId, btnId) {
    document.getElementById(menuId)?.classList.add('hidden');
    document.getElementById(btnId)?.classList.remove('open');
}

function selectAdminPidDropdownOption(menuId, btnId, hiddenId, labelId, value, label) {
    const hidden = document.getElementById(hiddenId);
    const labelEl = document.getElementById(labelId);
    if (hidden) hidden.value = value;
    if (labelEl) labelEl.textContent = label;

    document.querySelectorAll(`#${menuId} .admin-pid-dropdown-option`).forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.value === value);
    });

    closeAdminPidDropdown(menuId, btnId);
}

function selectAdminPidFoilOption(foilId, kind) {
    adminPidAddEntryFoilId = foilId;
    selectAdminPidDropdownOption('admin-pid-foil-dropdown-menu', 'admin-pid-foil-dropdown-btn', 'admin-pid-add-foil', 'admin-pid-foil-dropdown-label', foilId, kind);
}

function closeAdminPidFoilDropdown() {
    closeAdminPidDropdown('admin-pid-foil-dropdown-menu', 'admin-pid-foil-dropdown-btn');
}

function selectAdminPidConditionOption(condition) {
    adminPidAddEntryCondition = condition;
    selectAdminPidDropdownOption('admin-pid-condition-dropdown-menu', 'admin-pid-condition-dropdown-btn', 'admin-pid-add-condition', 'admin-pid-condition-dropdown-label', condition, condition);
}

function closeAdminPidConditionDropdown() {
    closeAdminPidDropdown('admin-pid-condition-dropdown-menu', 'admin-pid-condition-dropdown-btn');
}

// Marketplace field — styled like the foil/condition dropdowns above (shares
// their .admin-pid-dropdown-* CSS), but unlike those it's a real text input,
// not a hidden-value + label pair: picking an option just fills the input,
// and the admin can still type anything else over it.
function adminPidMarketplaceFieldHtml() {
    // Reads the value back out via this.dataset rather than interpolating it
    // into the onclick string directly — escapeHtml() only HTML-escapes (so
    // "Merlin's" becomes Merlin&#39;s), and the browser decodes that entity
    // back to a literal ' before the onclick text is parsed as JS, which
    // would terminate the string early and break the handler.
    const optionsHtml = ADMIN_PID_MARKETPLACE_OPTIONS.map(m => `
        <div class="admin-pid-dropdown-option" data-value="${escapeHtml(m)}"
             onclick="selectAdminPidMarketplaceOption(this.dataset.value)">
            ${escapeHtml(m)}
        </div>
    `).join('');

    return `
        <div class="admin-pid-dropdown-wrap" id="admin-pid-marketplace-dropdown-wrap">
            <div class="admin-pid-dropdown-btn" id="admin-pid-marketplace-dropdown-btn">
                <input type="text" class="admin-pid-marketplace-input" id="admin-pid-add-marketplace"
                       placeholder="Marketplace" value="TCGPlayer" onfocus="openAdminPidMarketplaceDropdown()">
                <span class="admin-pid-dropdown-arrow"
                      onclick="toggleAdminPidDropdown('admin-pid-marketplace-dropdown-menu', 'admin-pid-marketplace-dropdown-btn')">&#8249;</span>
            </div>
            <div class="admin-pid-dropdown-menu hidden" id="admin-pid-marketplace-dropdown-menu">
                ${optionsHtml}
            </div>
        </div>
    `;
}

function openAdminPidMarketplaceDropdown() {
    document.getElementById('admin-pid-marketplace-dropdown-menu')?.classList.remove('hidden');
    document.getElementById('admin-pid-marketplace-dropdown-btn')?.classList.add('open');
}

function closeAdminPidMarketplaceDropdown() {
    closeAdminPidDropdown('admin-pid-marketplace-dropdown-menu', 'admin-pid-marketplace-dropdown-btn');
}

function selectAdminPidMarketplaceOption(value) {
    const input = document.getElementById('admin-pid-add-marketplace');
    if (input) input.value = value;

    document.querySelectorAll('#admin-pid-marketplace-dropdown-menu .admin-pid-dropdown-option').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.value === value);
    });

    // Stays open after picking an option — closing here (even briefly, before
    // input.focus() below reopens it via its own onfocus) produced a visible
    // flicker. It now only closes on an actual outside click, same as the
    // other dropdowns in this menu.
    input?.focus();
}

async function submitAdminPricingManualEntry(type) {
    const editionId = adminPidDetailSelected;
    if (!editionId || adminPidAddEntryPending) return;

    const btn = document.getElementById('admin-pid-add-entry-btn');
    const status = document.getElementById('admin-pid-add-entry-status');
    const foilId = document.getElementById('admin-pid-add-foil').value;
    const priceInput = document.getElementById('admin-pid-add-price');
    const qtyInput = document.getElementById('admin-pid-add-qty');
    const dateInput = document.getElementById('admin-pid-add-date');
    const conditionInput = document.getElementById('admin-pid-add-condition');
    const marketplaceInput = document.getElementById('admin-pid-add-marketplace');

    const price = parseFloat(priceInput.value);
    const quantity = parseInt(qtyInput.value, 10) || 1;

    if (!foilId) {
        status.textContent = 'Select a foil/variant first.';
        status.className = 'admin-pid-add-entry-status admin-pid-refresh-error';
        return;
    }

    if (isNaN(price) || price < 0) {
        status.textContent = 'Enter a valid price.';
        status.className = 'admin-pid-add-entry-status admin-pid-refresh-error';
        return;
    }

    if (dateInput.value && dateInput.value > adminPidTodayIso()) {
        status.textContent = 'Date cannot be in the future.';
        status.className = 'admin-pid-add-entry-status admin-pid-refresh-error';
        return;
    }

    adminPidAddEntryPending = true;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    status.textContent = '';
    status.className = 'admin-pid-add-entry-status';

    try {
        const res = await fetch(`/api/admin/pricing/${editionId}/entry`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                type,
                foil_id: foilId,
                price,
                quantity,
                date: dateInput.value,
                condition: conditionInput.value.trim(),
                marketplace: marketplaceInput.value.trim() || 'Manual',
            })
        });
        const data = await res.json();

        adminPidAddEntryPending = false;
        if (adminPidDetailSelected !== editionId) return;

        if (!res.ok) {
            btn.disabled = false;
            btn.textContent = 'Add';
            status.textContent = data.detail || 'Failed to add entry.';
            status.className = 'admin-pid-add-entry-status admin-pid-refresh-error';
            return;
        }

        // Matches add_manual_entry() in pricing_ga.py, which now stamps
        // last_sales/last_listings for a manual entry the same as a scrape or
        // pasted import would — keep the row's badge in sync with that.
        const record = adminPidData.find(r => r.edition_id === editionId);
        if (record) {
            if (type === 'sales') record.sales_days_since = 0;
            else record.listings_days_since = 0;
            renderAdminPidRows();
        }

        // Success re-renders the whole detail panel (fresh, empty form) via the
        // history reload, so the "Added." confirmation must target the new DOM node.
        await loadAdminPricingDetailHistory();
        const freshStatus = document.getElementById('admin-pid-add-entry-status');
        if (freshStatus) {
            freshStatus.textContent = 'Added.';
            freshStatus.className = 'admin-pid-add-entry-status admin-pid-refresh-done';
        }
    } catch (err) {
        adminPidAddEntryPending = false;
        if (adminPidDetailSelected !== editionId) return;
        btn.disabled = false;
        btn.textContent = 'Add';
        status.textContent = 'Request failed.';
        status.className = 'admin-pid-add-entry-status admin-pid-refresh-error';
    }
}

function adminPidDetailHistoryTableHtml(rows, loaded, type) {
    if (!loaded) return '<div class="admin-pid-detail-loading">Loading…</div>';
    if (!rows.length) return '<div class="admin-pid-detail-empty-small">No records.</div>';

    const rowsHtml = rows.map(r => `
        <div class="admin-pid-detail-row">
            <span>${escapeHtml(r.date)}</span>
            <span>${escapeHtml(r.condition || '')}</span>
            <span>$${Number(r.price).toFixed(2)}</span>
            <span>×${escapeHtml(String(r.quantity))}</span>
            <button type="button" class="admin-pid-detail-delete-btn" title="Delete entry"
                    onclick="deleteAdminPidEntry('${type}', '${escapeHtml(r.foil_id)}', ${r.index}, this)">&times;</button>
        </div>
    `).join('');

    return `
        <div class="admin-pid-detail-row admin-pid-detail-row-header">
            <span>Date</span><span>Condition</span><span>Price</span><span>Qty</span><span></span>
        </div>
        <div class="admin-pid-detail-table-scroll">
            <div class="admin-pid-detail-table">${rowsHtml}</div>
        </div>
    `;
}

async function deleteAdminPidEntry(entryType, foilId, index, btnEl) {
    const editionId = adminPidDetailSelected;
    if (!editionId) return;

    if (!confirm(`Delete this ${entryType === 'sales' ? 'sale' : 'listing'} entry?`)) return;

    btnEl.disabled = true;

    try {
        const res = await fetch(`/api/admin/pricing/${editionId}/entry`, {
            method: 'DELETE',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({foil_id: foilId, entry_type: entryType, index}),
        });

        if (!res.ok) {
            btnEl.disabled = false;
            return;
        }

        if (adminPidDetailSelected === editionId) {
            await loadAdminPricingDetailHistory();
        }
    } catch (err) {
        btnEl.disabled = false;
    }
}

// Deep-linkable section/sub-view URLs (see the routes table in app.js and
// switchAdminSection/switchAdminCardsView, which keep the address bar synced
// to whichever one is showing via history.replaceState):
//   /admin, /admin/cards, /admin/cards/pricing  → Cards section, Pricing
//   /admin/cards/info                           → Cards section, Info
//   /admin/users                                → Users section
function initAdmin() {
    const path = window.location.pathname;
    if (path.startsWith('/admin/system')) {
        adminActiveSection = 'system';
    } else if (path.startsWith('/admin/users')) {
        adminActiveSection = 'users';
    } else {
        adminActiveSection = 'pricing';
    }
    // The Cards section's own Info/Pricing sub-view — reset (from the URL,
    // defaulting to Pricing) rather than left at whatever it was, since
    // adminCardsView is a plain JS variable that survives navigating away
    // and back (this module isn't reloaded, only the page's HTML is) —
    // without resetting it here too, leaving on Info and coming back to a
    // Pricing URL would render Info's reduced list columns (see
    // renderAdminPidHeader/renderAdminPidRows) inside the fresh, unmorphed
    // Pricing-width layout, rather than actually starting on Pricing.
    adminCardsView = path === '/admin/cards/info' ? 'info' : 'pricing';

    // Normalizes the address bar to whichever specific sub-view that just
    // resolved to — e.g. clicking the top-level Admin nav link lands on the
    // bare /admin, which defaults here to Cards → Pricing, but should then
    // read as /admin/cards/pricing rather than staying on the generic /admin
    // while that's what's actually on screen.
    syncAdminUrl();

    adminSystemLoaded = false;
    adminUseJsonStaging = false;
    _adminStagingBarAnim = null;
    adminUsersLoaded = false;
    adminUsersData = [];
    adminUserDetailSelected = null;
    adminUserDetailInventory = null;
    adminUserDetailDecks = null;
    adminPidLoaded = false;
    adminPidData = [];
    adminDbModeOn = false;
    adminPidSelected = new Set();
    adminSetsSelectedSlug = null;
    adminPidRefreshStatus = {};
    adminPidRefreshing = false;
    adminPidSetFilter = new Set();
    adminPidSetFilterOpen = false;
    adminPidRarityFilter = new Set();
    adminPidRarityFilterOpen = false;
    adminPidCurioViewSelected = new Set();
    adminPidDetailSelected = null;
    adminPidDetailHistory = null;
    adminPidDetailFoils = null;
    adminPidDetailMode = 'regular';
    adminPidAddEntryOpenType = null;
    adminPidAddEntryFoilId = null;
    adminPidAddEntryCondition = null;
    adminPidAddEntryPending = false;
    adminPidBulkPasteOpen = false;
    adminPidBulkPastePending = false;
    _resetAdminDbAutosaveState();

    // Renders the deep-linked section/sub-view directly — no fade/resize
    // animation here, since this is the page settling into its starting
    // state rather than a user click (switchAdminSection/
    // switchAdminCardsView are for that, and would also no-op here anyway:
    // their own guards compare against the values just set above).
    const page = document.getElementById('admin-page');
    page?.querySelectorAll('.admin-subnav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.section === adminActiveSection);
    });
    page?.querySelectorAll('.admin-section').forEach(panel => {
        panel.classList.toggle('hidden', panel.id !== `admin-section-${adminActiveSection}`);
    });

    const cardsSection = document.getElementById('admin-section-pricing');
    cardsSection?.querySelectorAll('.admin-cards-subnav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === adminCardsView);
    });
    cardsSection?.classList.toggle('admin-cards-mode-info', adminCardsView === 'info');

    document.querySelector('.footer')?.classList.add('footer-hidden');
    updateAdminPidTcgButton();
    updateAdminUserRoleButtons();
    positionPillIndicator(document.querySelector('.admin-cards-subnav'));
    positionPillIndicator(document.getElementById('admin-pid-source-toggle'));
    document.querySelectorAll('.admin-system-option-toggle').forEach(positionPillIndicator);

    if (adminActiveSection === 'system') {
        loadAdminSystemSettings();
    } else if (adminActiveSection === 'users') {
        loadAdminUsers();
    } else {
        loadAdminPricingIds();
    }
}

document.addEventListener('click', e => {
    if (!e.target.closest('.admin-pid-add-entry-wrap')) closeAdminPidAddEntry();
    if (!e.target.closest('.admin-pid-bulk-paste-wrap')) closeAdminPidBulkPaste();
    closeAdminPidImportPopoversOutside(e.target);
    if (!e.target.closest('#admin-pid-foil-dropdown-wrap')) closeAdminPidFoilDropdown();
    if (!e.target.closest('#admin-pid-condition-dropdown-wrap')) closeAdminPidConditionDropdown();
    if (!e.target.closest('#admin-pid-marketplace-dropdown-wrap')) closeAdminPidMarketplaceDropdown();
    if (!e.target.closest('.admin-pid-col-rarity .set-dropdown-wrap')) closeAdminPidRarityFilter();
    if (!e.target.closest('.admin-pid-col-set .set-dropdown-wrap')) closeAdminPidSetFilter();
    if (!e.target.closest('#admin-system-db-ssl-wrap')) closeAdminPidDropdown('admin-system-db-ssl-menu', 'admin-system-db-ssl-btn');
}, true);

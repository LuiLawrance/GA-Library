let adminActiveSection = 'pricing';
let adminCardsView = 'pricing';
let adminPidDetailMode = 'regular';
let adminUsersLoaded = false;
let adminUsersData = [];
let adminUserDetailSelected = null;
let adminUserDetailInventory = null;
let adminUserDetailDecks = null;
let adminPidLoaded = false;
let adminPidData = [];
let adminPidSelected = new Set();
let adminPidRefreshStatus = {};
let adminPidRefreshing = false;
let adminPidSetFilter = new Set();
let adminPidSetFilterOpen = false;
let adminPidRarityFilter = new Set();
let adminPidRarityFilterOpen = false;
let adminPidFindingIds = new Set();
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

async function switchAdminSection(section) {
    const page = document.getElementById('admin-page');
    if (!page || adminActiveSection === section) return;

    const content = page.querySelector('.admin-content');
    content?.classList.add('fade-out');
    await sleep(150);

    adminActiveSection = section;

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

    if (section === 'pricing') {
        // Just became visible (or already was) — reposition without sliding from a
        // stale/never-measured spot.
        positionPillIndicator(document.querySelector('.admin-cards-subnav'));
        positionPillIndicator(document.getElementById('admin-pid-source-toggle'));
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
        adminPidLoaded = true;
        renderAdminPricingIds();
    } catch (err) {
        summary.textContent = 'Failed to load product IDs.';
    }
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
            </span>
            <span class="admin-pid-col-sales">Sales</span>
            <span class="admin-pid-col-listings">Listings</span>
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
function adminPidProductIdFieldHtml(e) {
    const curioView = e.curio && adminPidCurioViewSelected.has(e.edition_id);
    const finding = adminPidFindingIds.has(e.edition_id);

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
                <button type="button" class="admin-pid-find-btn" disabled
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
            <button type="button" class="admin-pid-find-btn ${finding ? 'finding' : ''}"
                    title="${noListings ? 'Marked as having no TCGPlayer listings — auto-detect disabled' : 'Auto-detect from TCGPlayer'}"
                    ${finding || noListings ? 'disabled' : ''}
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

    const targets = getAdminPidRefreshTargets();
    const disabled = targets.length === 0 || adminPidRefreshing;
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
            input.classList.toggle('admin-pid-input-filled', !!data.product_id);
            updateAdminPidSummaryText();
        }

        if (adminPidDetailSelected === editionId) renderAdminPricingDetailAll();
    } catch (err) {
        input.value = record.product_id || '';
        input.classList.add('admin-pid-input-error');
        setTimeout(() => input.classList.remove('admin-pid-input-error'), 3000);
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

    // The Curio Foil's own product page is scraped/refreshed independently
    // from the edition's regular one (see pricing_ga.py's merge-based scrape
    // orchestration), so it has its own separate last-scraped clocks too —
    // show those instead of the edition's when toggled to Curio Foil view.
    const curioView = record.curio && adminPidCurioViewSelected.has(record.edition_id);
    const historyLoaded = !!adminPidDetailHistory;
    const lastSales = historyLoaded
        ? ((curioView ? adminPidDetailHistory.curio_last_sales : adminPidDetailHistory.last_sales) || 'Never')
        : '…';
    const lastListings = historyLoaded
        ? ((curioView ? adminPidDetailHistory.curio_last_listings : adminPidDetailHistory.last_listings) || 'Never')
        : '…';

    col.innerHTML = `
        <div class="admin-pid-detail-header">
            <span class="admin-pid-detail-name">${escapeHtml(record.name)}</span>
            <span class="drawer-set">${drawerSetLineHTML(record)}</span>
        </div>
        <div class="admin-pid-detail-image-wrap">
            <img class="admin-pid-detail-image" src="/images/${escapeHtml(record.edition_id)}.jpg" alt="${escapeHtml(record.name)}">
        </div>
        <div class="drawer-stats admin-pid-scrape-stats">
            <div class="drawer-stat">
                <span class="drawer-stat-label">Last Sales</span>
                <span class="drawer-stat-value">${escapeHtml(lastSales)}</span>
            </div>
            <div class="drawer-stat">
                <span class="drawer-stat-label">Last Listings</span>
                <span class="drawer-stat-value">${escapeHtml(lastListings)}</span>
            </div>
        </div>
        <div class="admin-pid-detail-pid-row">
            <label class="admin-pid-detail-label">${(curioView || record.curio_only) ? 'Curio Foil' : 'Product ID'}</label>
            ${adminPidProductIdFieldHtml(record)}
        </div>
    `;

    const img = col.querySelector('.admin-pid-detail-image');
    if (img && document.getElementById('card-drawer')) {
        img.onclick = () => openCardDrawer(record.card_id, record.edition_id, record.name);
    }
}

function renderAdminPricingDetail() {
    const panel = document.getElementById('admin-pricing-detail');
    if (!panel) return;

    // Sales/Listings (and their Refresh/Add Entry actions) are pricing-only
    // — the panel's own grid track also collapses to 0 width in this mode
    // (see .admin-cards-mode-info .admin-pricing-layout in admin.css), but
    // leaving its content rendering here too would mean it's just sitting
    // there built and clipped behind overflow:hidden for nothing.
    if (adminCardsView === 'info') {
        panel.innerHTML = '';
        return;
    }

    if (!adminPidDetailSelected) {
        panel.innerHTML = '';
        return;
    }

    const record = adminPidData.find(e => e.edition_id === adminPidDetailSelected);
    if (!record) {
        panel.innerHTML = '';
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

function initAdmin() {
    adminActiveSection = 'pricing';
    adminUsersLoaded = false;
    adminUsersData = [];
    adminUserDetailSelected = null;
    adminUserDetailInventory = null;
    adminUserDetailDecks = null;
    adminPidLoaded = false;
    adminPidData = [];
    adminPidSelected = new Set();
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
    document.querySelector('.footer')?.classList.add('footer-hidden');
    updateAdminPidTcgButton();
    updateAdminUserRoleButtons();
    positionPillIndicator(document.querySelector('.admin-cards-subnav'));
    positionPillIndicator(document.getElementById('admin-pid-source-toggle'));
    loadAdminPricingIds();
}

document.addEventListener('click', e => {
    if (!e.target.closest('.admin-pid-add-entry-wrap')) closeAdminPidAddEntry();
    if (!e.target.closest('.admin-pid-bulk-paste-wrap')) closeAdminPidBulkPaste();
    if (!e.target.closest('#admin-pid-foil-dropdown-wrap')) closeAdminPidFoilDropdown();
    if (!e.target.closest('#admin-pid-condition-dropdown-wrap')) closeAdminPidConditionDropdown();
    if (!e.target.closest('#admin-pid-marketplace-dropdown-wrap')) closeAdminPidMarketplaceDropdown();
    if (!e.target.closest('.admin-pid-col-rarity .set-dropdown-wrap')) closeAdminPidRarityFilter();
    if (!e.target.closest('.admin-pid-col-set .set-dropdown-wrap')) closeAdminPidSetFilter();
}, true);

// ── State ──
let currentUser = null;
let isAdmin = false;
let loginMode = 'login';

// Highest to lowest privilege — mirrors RANK_ORDER in user.py. Shared
// globally (classic <script>s on one page see each other's top-level
// const/let) so admin.js's promote/demote logic can reuse it.
const RANK_ORDER = ['owner', 'admin', 'moderator', 'user'];
const ADMIN_CONSOLE_RANKS = new Set(['owner', 'admin', 'moderator']);

// ── Router ──
const routes = {
    '/': '/fragments/home',
    '/login': '/fragments/login',
    '/cards': '/fragments/cards',
    '/collection': '/fragments/collection',
    '/decks': '/fragments/decks',
    '/prices': '/fragments/prices',
    '/inventory': '/fragments/inventory',
    '/decks_ga': '/fragments/decks_ga',
    '/admin': '/fragments/admin',
    // Deep links into the Admin page's own sub-tabs — all the same fragment
    // as /admin, just parsed by initAdmin() (admin.js) to land on the right
    // section/sub-view instead of always defaulting to Cards → Pricing.
    '/admin/cards': '/fragments/admin',
    '/admin/cards/info': '/fragments/admin',
    '/admin/cards/pricing': '/fragments/admin',
    '/admin/users': '/fragments/admin',
    '/admin/system': '/fragments/admin',
    '/profile': '/fragments/profile',
};

async function navigate(path, pushState = true) {
    const content = document.getElementById('content');

    closeUserMenu();

    let pathname;
    await fadeSwap(content, async () => {
        // Reset drawer tab states when navigating away
        if (typeof drawerActiveTab !== 'undefined') drawerActiveTab = 'info';
        if (typeof invDrawerActiveTab !== 'undefined') invDrawerActiveTab = 'info';

        // Reset card drawer globals so stale state from deck page doesn't bleed into inventory
        if (typeof selectedCardId !== 'undefined') selectedCardId = null;
        if (typeof drawerIsOpen !== 'undefined') drawerIsOpen = false;

        // Same, for the inventory page's drawer instance (inv-card-drawer) — a stale
        // value here caused openDrawer() to think a freshly-loaded, empty drawer was
        // already open and populated.
        if (typeof selectedInvCardId !== 'undefined') selectedInvCardId = null;
        if (typeof invDrawerIsOpen !== 'undefined') invDrawerIsOpen = false;

        if (pushState) {
            window.history.pushState({}, '', path);
        }

        pathname = path.split('?')[0];

        document.querySelectorAll('.navbar a').forEach(a => {
            const href = a.getAttribute('href');
            // Prefix match (not just exact) so a deep link into a sub-page —
            // e.g. /admin/cards/info — still marks its top-level nav link
            // (/admin) active, the same as being on /admin itself. href==='/'
            // is exact-only, otherwise EVERY page would match root's prefix.
            const active = href === '/' ? pathname === '/' : (pathname === href || pathname.startsWith(href + '/'));
            a.classList.toggle('active', active);
        });

        // "/@<omnidex_id>" is how the public profile is routed internally
        // (the user-facing URL is the hash "/#<omnidex_id>" — see
        // routeCurrentLocation). Same fragment as /profile; profile.js branches.
        const fragment = routes[pathname] || (pathname.startsWith('/@') ? '/fragments/profile' : routes['/']);
        const res = await fetch(fragment);
        const html = await res.text();

        content.innerHTML = html;
    });

    loginMode = 'login';

    // Reset footer visibility when navigating — then hide it outright on the
    // profile pages (/profile and the public /#<omnidex_id>), which manage
    // their own scrolling and have no use for it.
    document.querySelector('.footer').classList.toggle(
        'footer-hidden', pathname === '/profile' || pathname.startsWith('/@'));

    if (pathname === '/cards') {
        selectedSets.clear();
        updateSetDropdownLabel();
        await loadSets();
        // Reset card search filter state
        if (typeof cardSearchResults !== 'undefined') {
            cardSearchResults = [];
            cardFilters.sort = 'collector';
            cardFilters.rarity = '';
            cardFilters.element = '';
        }
        const binWrap = document.getElementById('default-bin-wrap');
        if (binWrap) {
            if (currentUser) {
                binWrap.classList.remove('hidden');
                if (typeof initDefaultBinPicker === 'function') initDefaultBinPicker();
            } else {
                binWrap.classList.add('hidden');
            }
        }
        setTimeout(setupFooterScroll, 100);

        // ── Restore search from URL params ──
        const urlParams = new URLSearchParams(window.location.search);
        const setPrefix = urlParams.get('set_prefix');
        const q = urlParams.get('q');
        const sets = urlParams.getAll('set');

        if (setPrefix) {
            document.getElementById('card-search').value = `$${setPrefix}`;
            await searchCards();
        } else if (q || sets.length) {
            document.getElementById('card-search').value = q || '';
            selectedSets = new Set(sets);
            updateSetDropdownLabel();
            renderSetOptions();
            await searchCards();
        } else if (typeof loadFeaturedSets === 'function') {
            await loadFeaturedSets();
        }

        // Restore an opened card drawer from the URL (?card_id=&edition_id=)
        // — e.g. a shared/bookmarked link, or the page being refreshed while
        // a card was open. Runs after the search restore above on purpose (the
        // drawer opens on top of restored results) — but that means updateUrl
        // must stay true here despite already matching the URL: searchCards()
        // just above does its own pushState carrying only q/set, which wipes
        // card_id/edition_id from the URL before this ever runs, so they need
        // to be written back rather than trusted to already be there.
        const cardId = urlParams.get('card_id');
        const editionId = urlParams.get('edition_id');
        if (cardId && editionId && typeof openCardDrawer === 'function') {
            await openCardDrawer(cardId, editionId, null, true);
        }
    }

    if (pathname === '/inventory') {
        if (typeof window.initInventory === 'function') {
            await window.initInventory();
        }
        setTimeout(setupInvFooterScroll, 100);
    }

    if (pathname === '/decks_ga') {
        if (typeof window.initDecksGa === 'function') {
            await window.initDecksGa();
        }
        setTimeout(setupDgaFooterScroll, 100);
    }

    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
        if (typeof window.initAdmin === 'function') {
            window.initAdmin();
        }
    }

    if (pathname === '/prices') {
        if (typeof window.initPrices === 'function') {
            await window.initPrices();
        }
    }

    if (pathname === '/profile') {
        if (!currentUser) {
            navigate('/login');
            return;
        }
        if (typeof window.initProfile === 'function') {
            await window.initProfile();
        }
    }

    if (pathname.startsWith('/@')) {
        // Public profile (reached via the "/#<omnidex_id>" hash route).
        // initPublicProfile resolves the ID and redirects to /profile if it's
        // the signed-in user's own.
        const omnidexId = decodeURIComponent(pathname.slice(2));
        if (typeof window.initPublicProfile === 'function') {
            await window.initPublicProfile(omnidexId);
        }
    }

    _renderedLocation = window.location.pathname + window.location.search + window.location.hash;
}

// ── Location routing ──
// Normal pages use History-API pathname routing; the public profile is a
// hash route (/#<omnidex_id>) so its share links need no server config. This
// dispatches either way, and dedupes the back/forward case where popstate and
// hashchange both fire for the same destination.
let _renderedLocation = null;

function publicProfileHashId() {
    const m = window.location.hash.match(/^#(\d{1,20})$/);
    return m ? m[1] : null;
}

async function routeCurrentLocation() {
    const loc = window.location.pathname + window.location.search + window.location.hash;
    if (loc === _renderedLocation) return;

    const omnidexId = publicProfileHashId();
    if (omnidexId) {
        await navigate('/@' + omnidexId, false);
    } else {
        await navigate(window.location.pathname + window.location.search, false);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function setupInvFooterScroll() {
    const gridWrap = document.querySelector('.inv-card-grid-wrap');
    const footer = document.querySelector('.footer');

    if (!gridWrap || !footer) return;

    gridWrap.addEventListener('scroll', () => {
        if (gridWrap.scrollTop > 150) {
            footer.classList.add('footer-hidden');
        } else if (gridWrap.scrollTop === 0) {
            footer.classList.remove('footer-hidden');
        }
    });
}

function setupDgaFooterScroll() {
    const gridWrap = document.querySelector('.dga-card-grid-wrap');
    const footer = document.querySelector('.footer');

    if (!gridWrap || !footer) return;

    gridWrap.addEventListener('scroll', () => {
        if (drawerIsOpen) return;

        if (gridWrap.scrollTop > 150) {
            footer.classList.add('footer-hidden');
        } else if (gridWrap.scrollTop === 0) {
            footer.classList.remove('footer-hidden');
        }
    });
}

// ── Footer hide on scroll ──
function setupFooterScroll() {
    const gridWrap = document.querySelector('.card-grid-wrap');
    const footer = document.querySelector('.footer');

    if (!gridWrap || !footer) return;

    gridWrap.addEventListener('scroll', () => {
        if (drawerIsOpen) return;

        if (gridWrap.scrollTop > 150) {
            footer.classList.add('footer-hidden');
        } else if (gridWrap.scrollTop === 0) {
            footer.classList.remove('footer-hidden');
        }
    });
}

// ── Auth ──
async function checkAuth() {
    try {
        const res = await fetch('/api/me');

        if (res.ok) {
            const data = await res.json();
            currentUser = data.username;
            isAdmin = ADMIN_CONSOLE_RANKS.has(data.auth_type);
            setLoggedIn(currentUser);
            maybeShowAccountSetup(data);
        } else {
            currentUser = null;
            isAdmin = false;
            setLoggedOut();
        }
    } catch {
        currentUser = null;
        isAdmin = false;
        setLoggedOut();
    }
}

// ── Blocking account-setup gate ──
// An admin can clear a user's Omnidex ID and/or password (Admin -> Users). On
// their next /api/me or /api/login the response carries must_set_* flags; this
// puts up a non-dismissible modal that has to be completed before anything
// else. The backend also 403s other /api/ calls until it's done.
let _setupNeeds = {omnidex: false, password: false};

function accountSetupPending(data) {
    return !!(data && (data.must_set_omnidex || data.must_set_password));
}

function maybeShowAccountSetup(data) {
    const modal = document.getElementById('account-setup-modal');
    if (!modal) return false;

    if (!accountSetupPending(data)) {
        modal.classList.add('hidden');
        return false;
    }

    _setupNeeds = {omnidex: !!data.must_set_omnidex, password: !!data.must_set_password};
    document.getElementById('setup-error').classList.remove('visible');
    modal.classList.remove('hidden');
    renderAccountSetupStep();
    return true;
}

function renderAccountSetupStep() {
    const onOmnidex = _setupNeeds.omnidex;
    document.getElementById('setup-step-omnidex').classList.toggle('hidden', !onOmnidex);
    document.getElementById('setup-step-password').classList.toggle('hidden', onOmnidex);
    document.getElementById('setup-title').textContent =
        onOmnidex ? 'Set your Omnidex ID' : 'Set a new password';
    document.getElementById('setup-desc').textContent = onOmnidex
        ? 'An admin cleared your Omnidex ID. Enter a valid one to continue.'
        : 'An admin reset your password. Choose a new one to continue.';
    setTimeout(() => {
        document.getElementById(onOmnidex ? 'setup-omnidex-input' : 'setup-password-input')?.focus();
    }, 50);
}

function setupError(msg) {
    const el = document.getElementById('setup-error');
    el.textContent = msg;
    el.classList.add('visible');
}

async function submitAccountSetup() {
    document.getElementById('setup-error').classList.remove('visible');
    const btn = document.getElementById('setup-submit');
    btn.disabled = true;
    try {
        if (_setupNeeds.omnidex) {
            await submitSetupOmnidex();
        } else {
            await submitSetupPassword();
        }
    } finally {
        btn.disabled = false;
    }
}

async function submitSetupOmnidex() {
    const omnidex_id = document.getElementById('setup-omnidex-input').value.trim();
    if (!/^\d{1,20}$/.test(omnidex_id)) {
        setupError('Omnidex ID must be a number (up to 20 digits).');
        return;
    }
    const res = await fetch('/api/profile/omnidex', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({omnidex_id}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        setupError(data.detail || 'Could not save your Omnidex ID.');
        return;
    }
    _setupNeeds.omnidex = false;
    if (_setupNeeds.password) {
        renderAccountSetupStep();
    } else {
        window.location.reload();
    }
}

async function submitSetupPassword() {
    const pw = document.getElementById('setup-password-input').value;
    const confirm = document.getElementById('setup-password-confirm').value;
    if (!pw) {
        setupError('Password cannot be empty.');
        return;
    }
    if (pw !== confirm) {
        setupError('Passwords do not match.');
        return;
    }
    const res = await fetch('/api/profile/set-password', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({new_password: pw}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        setupError(data.detail || 'Could not set your password.');
        return;
    }
    window.location.reload();
}

function setLoggedIn(username) {
    document.getElementById('topbar-user-name').textContent = username;
    document.getElementById('topbar-user-menu').classList.remove('hidden');
    document.getElementById('topbar-login-btn').classList.add('hidden');
    document.getElementById('nav-inventory').classList.remove('hidden');
    document.getElementById('nav-decks-ga').classList.remove('hidden');
    document.getElementById('nav-admin').classList.toggle('hidden', !isAdmin);
    const binWrap = document.getElementById('default-bin-wrap');
    if (binWrap) binWrap.classList.remove('hidden');
    if (typeof initDefaultBinPicker === 'function') initDefaultBinPicker();
}

function setLoggedOut() {
    closeUserMenu();
    document.getElementById('topbar-user-menu').classList.add('hidden');
    document.getElementById('topbar-login-btn').classList.remove('hidden');
    document.getElementById('nav-inventory').classList.add('hidden');
    document.getElementById('nav-decks-ga').classList.add('hidden');
    document.getElementById('nav-admin').classList.add('hidden');
    const binWrap = document.getElementById('default-bin-wrap');
    if (binWrap) binWrap.classList.add('hidden');
}

async function handleLogout() {
    closeUserMenu();
    await fetch('/api/logout', {method: 'POST'});
    currentUser = null;
    isAdmin = false;
    setLoggedOut();
    navigate('/');
}

// ── Top-bar user dropdown ──
function toggleUserMenu(e) {
    e?.stopPropagation();
    const menu = document.getElementById('topbar-user-dropdown');
    const btn = document.getElementById('topbar-user-btn');
    if (!menu || !btn) return;

    const isOpen = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden', isOpen);
    btn.classList.toggle('open', !isOpen);
}

function closeUserMenu() {
    document.getElementById('topbar-user-dropdown')?.classList.add('hidden');
    document.getElementById('topbar-user-btn')?.classList.remove('open');
}

// Close the dropdown on any click outside it (the toggle itself stops
// propagation, so this only fires for genuine outside clicks).
document.addEventListener('click', e => {
    if (!e.target.closest('#topbar-user-menu')) closeUserMenu();
});

// ── Login / Register ──
function toggleMode() {
    loginMode = loginMode === 'login' ? 'register' : 'login';

    const isRegister = loginMode === 'register';

    document.getElementById('form-title').textContent = isRegister ? 'Create account' : 'Sign in';
    document.getElementById('submit-btn').textContent = isRegister ? 'Create account' : 'Sign in';
    const confirmGroup = document.getElementById('confirm-group');
    confirmGroup.classList.toggle('expanded', isRegister);
    confirmGroup.style.maxHeight = isRegister ? confirmGroup.scrollHeight + 'px' : '0px';
    document.getElementById('switch-text').textContent = isRegister ? 'Already have an account?' : "Don't have an account?";
    document.querySelector('.btn-switch').textContent = isRegister ? 'Sign in' : 'Create account';

    document.getElementById('error-msg').classList.remove('visible');
}

async function handleSubmit() {
    if (loginMode === 'login') {
        await handleLogin();
    } else {
        await handleRegister();
    }
}

async function handleLogin() {
    const username = document.getElementById('username').value.trim();
    // No password check here — an account whose password an admin reset logs
    // in with a blank one, then hits the account-setup gate.
    const password = document.getElementById('password').value;
    const errorMsg = document.getElementById('error-msg');

    errorMsg.classList.remove('visible');

    if (!username) {
        errorMsg.textContent = 'Please enter your username.';
        errorMsg.classList.add('visible');
        return;
    }

    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password', password);

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body: params
        });

        if (res.ok) {
            const data = await res.json();
            currentUser = data.username;
            isAdmin = ADMIN_CONSOLE_RANKS.has(data.auth_type);
            setLoggedIn(currentUser);
            if (!maybeShowAccountSetup(data)) navigate('/');
        } else {
            errorMsg.textContent = 'Invalid username or password.';
            errorMsg.classList.add('visible');
        }
    } catch {
        errorMsg.textContent = 'Invalid username or password.';
        errorMsg.classList.add('visible');
    }
}

async function handleRegister() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const confirm = document.getElementById('confirm-password').value;
    const omnidexId = document.getElementById('omnidex-id').value.trim();
    const errorMsg = document.getElementById('error-msg');

    errorMsg.classList.remove('visible');

    if (!username || !password || !omnidexId) {
        errorMsg.textContent = 'Please fill in all fields.';
        errorMsg.classList.add('visible');
        return;
    }

    if (password !== confirm) {
        errorMsg.textContent = 'Passwords do not match.';
        errorMsg.classList.add('visible');
        return;
    }

    if (!/^\d{1,20}$/.test(omnidexId)) {
        errorMsg.textContent = 'Omnidex ID must be a number.';
        errorMsg.classList.add('visible');
        return;
    }

    // Guard: an Omnidex ID can only belong to one account. (api/register
    // re-checks server-side; this just fails fast with a clear message.)
    try {
        const check = await fetch(`/api/omnidex-taken/${encodeURIComponent(omnidexId)}`);
        if (check.ok && (await check.json()).taken) {
            errorMsg.textContent = 'That Omnidex ID is already registered.';
            errorMsg.classList.add('visible');
            return;
        }
    } catch { /* offline check failed — the server-side check still applies */ }

    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password', password);
    params.append('omnidex_id', omnidexId);

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body: params
        });

        if (res.ok) {
            await handleLogin();
        } else {
            const data = await res.json();
            errorMsg.textContent = data.detail || 'Registration failed.';
            errorMsg.classList.add('visible');
        }
    } catch {
        errorMsg.textContent = 'Registration failed.';
        errorMsg.classList.add('visible');
    }
}

// ── Link interception ──
document.addEventListener('click', e => {
    const link = e.target.closest('[data-link]');

    if (!link) return;

    const href = link.getAttribute('href');

    // Hash links (e.g. a public-profile "#<omnidex_id>") — let the browser
    // set the hash and let the hashchange handler route it.
    if (href.startsWith('#')) return;

    e.preventDefault();
    navigate(href);
});

// ── Browser back/forward + hash edits ──
window.addEventListener('popstate', routeCurrentLocation);
window.addEventListener('hashchange', routeCurrentLocation);

// ── Enter key ──
document.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        if (document.getElementById('username')) {
            handleSubmit();
        }
        // Note: card search Enter-key handling lives in cards.js's handleCardKeydown,
        // bound directly on #card-search via onkeydown. Do not duplicate it here —
        // this listener firing alongside handleCardKeydown caused searchCards() to
        // run twice per Enter press.
    }
});

// If an admin clears your Omni/password while you're mid-session, the next
// gated API call comes back 403 "Account setup required" — re-check auth so
// the setup gate pops up rather than the page just erroring out.
const _appOrigFetch = window.fetch;
window.fetch = function (...args) {
    return _appOrigFetch.apply(this, args).then(res => {
        if (res.status === 403) {
            res.clone().json().then(d => {
                if (d && d.detail === 'Account setup required') checkAuth();
            }).catch(() => {});
        }
        return res;
    });
};

// ── Init ──
(async () => {
    await checkAuth();
    await routeCurrentLocation();
})();
// ── Global confirmation modal (replaces browser confirm()) ──
let _appConfirmResolver = null;

function appConfirm(message, {title = 'Confirm Delete', confirmLabel = 'Delete'} = {}) {
    document.getElementById('app-confirm-title').textContent = title;
    document.getElementById('app-confirm-message').textContent = message;
    document.getElementById('app-confirm-btn').textContent = confirmLabel;
    // Type-to-confirm gate: reset on every open
    const input = document.getElementById('app-confirm-input');
    input.value = '';
    document.getElementById('app-confirm-btn').disabled = true;
    document.getElementById('app-confirm-modal').classList.remove('hidden');
    setTimeout(() => input.focus(), 60);
    return new Promise(resolve => {
        _appConfirmResolver = resolve;
    });
}

function appConfirmValidate() {
    const ok = document.getElementById('app-confirm-input').value.trim().toLowerCase() === 'confirm';
    document.getElementById('app-confirm-btn').disabled = !ok;
    return ok;
}

function appConfirmKeydown(e) {
    if (e.key === 'Enter' && appConfirmValidate()) appConfirmResolve(true);
}

function appConfirmResolve(result) {
    // The gate is the last line of defense — never resolve true without it
    if (result && !appConfirmValidate()) return;
    document.getElementById('app-confirm-modal').classList.add('hidden');
    _appConfirmResolver?.(result);
    _appConfirmResolver = null;
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('app-confirm-modal')?.classList.contains('hidden')) {
        appConfirmResolve(false);
    }
});
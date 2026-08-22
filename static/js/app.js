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
};

async function navigate(path, pushState = true) {
    const content = document.getElementById('content');

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

        const fragment = routes[pathname] || routes['/'];
        const res = await fetch(fragment);
        const html = await res.text();

        content.innerHTML = html;
    });

    loginMode = 'login';

    // Reset footer visibility when navigating
    document.querySelector('.footer').classList.remove('footer-hidden');

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

function setLoggedIn(username) {
    document.getElementById('topbar-user').textContent = username;
    document.getElementById('topbar-user').classList.remove('hidden');
    document.getElementById('topbar-login-btn').classList.add('hidden');
    document.getElementById('topbar-logout-btn').classList.remove('hidden');
    document.getElementById('nav-inventory').classList.remove('hidden');
    document.getElementById('nav-decks-ga').classList.remove('hidden');
    document.getElementById('nav-admin').classList.toggle('hidden', !isAdmin);
    const binWrap = document.getElementById('default-bin-wrap');
    if (binWrap) binWrap.classList.remove('hidden');
    if (typeof initDefaultBinPicker === 'function') initDefaultBinPicker();
}

function setLoggedOut() {
    document.getElementById('topbar-user').classList.add('hidden');
    document.getElementById('topbar-login-btn').classList.remove('hidden');
    document.getElementById('topbar-logout-btn').classList.add('hidden');
    document.getElementById('nav-inventory').classList.add('hidden');
    document.getElementById('nav-decks-ga').classList.add('hidden');
    document.getElementById('nav-admin').classList.add('hidden');
    const binWrap = document.getElementById('default-bin-wrap');
    if (binWrap) binWrap.classList.add('hidden');
}

async function handleLogout() {
    await fetch('/api/logout', {method: 'POST'});
    currentUser = null;
    isAdmin = false;
    setLoggedOut();
    navigate('/');
}

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
    const password = document.getElementById('password').value;
    const errorMsg = document.getElementById('error-msg');

    errorMsg.classList.remove('visible');

    if (!username || !password) {
        errorMsg.textContent = 'Please fill in all fields.';
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
            navigate('/');
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
    const errorMsg = document.getElementById('error-msg');

    errorMsg.classList.remove('visible');

    if (!username || !password) {
        errorMsg.textContent = 'Please fill in all fields.';
        errorMsg.classList.add('visible');
        return;
    }

    if (password !== confirm) {
        errorMsg.textContent = 'Passwords do not match.';
        errorMsg.classList.add('visible');
        return;
    }

    const params = new URLSearchParams();
    params.append('username', username);
    params.append('password', password);

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

    e.preventDefault();
    navigate(link.getAttribute('href'));
});

// ── Browser back/forward ──
window.addEventListener('popstate', () => {
    navigate(window.location.pathname + window.location.search, false);
});

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

// ── Init ──
(async () => {
    await checkAuth();
    await navigate(window.location.pathname + window.location.search, false);
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
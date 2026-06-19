// ── State ──
let currentUser = null;
let loginMode = 'login';

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
};

async function navigate(path, pushState = true) {
    const content = document.getElementById('content');

    content.classList.add('fade-out');
    await sleep(150);

    // Reset drawer tab states when navigating away
    if (typeof drawerActiveTab !== 'undefined') drawerActiveTab = 'info';
    if (typeof invDrawerActiveTab !== 'undefined') invDrawerActiveTab = 'info';

    // Reset card drawer globals so stale state from deck page doesn't bleed into inventory
    if (typeof selectedCardId !== 'undefined') selectedCardId = null;
    if (typeof drawerIsOpen !== 'undefined') drawerIsOpen = false;

    if (pushState) {
        window.history.pushState({}, '', path);
    }

    const pathname = path.split('?')[0];

    document.querySelectorAll('.navbar a').forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === pathname);
    });

    const fragment = routes[pathname] || routes['/'];
    const res = await fetch(fragment);
    const html = await res.text();

    content.innerHTML = html;
    content.classList.remove('fade-out');
    content.classList.add('fade-in');

    setTimeout(() => content.classList.remove('fade-in'), 200);

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
            setLoggedIn(currentUser);
        } else {
            currentUser = null;
            setLoggedOut();
        }
    } catch {
        currentUser = null;
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
    const binWrap = document.getElementById('default-bin-wrap');
    if (binWrap) binWrap.classList.add('hidden');
}

async function handleLogout() {
    await fetch('/api/logout', {method: 'POST'});
    currentUser = null;
    setLoggedOut();
    navigate('/');
}

// ── Login / Register ──
function toggleMode() {
    loginMode = loginMode === 'login' ? 'register' : 'login';

    const isRegister = loginMode === 'register';

    document.getElementById('form-title').textContent = isRegister ? 'Create account' : 'Sign in';
    document.getElementById('submit-btn').textContent = isRegister ? 'Create account' : 'Sign in';
    document.getElementById('confirm-group').style.display = isRegister ? 'flex' : 'none';
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
        } else if (document.getElementById('card-search')) {
            searchCards();
        }
    }
});

// ── Init ──
(async () => {
    await checkAuth();
    await navigate(window.location.pathname + window.location.search, false);
})();
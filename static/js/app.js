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
};

async function navigate(path, pushState = true) {
    const content = document.getElementById('content');

    content.classList.add('fade-out');
    await sleep(150);

    if (pushState) {
        window.history.pushState({}, '', path);
    }

    document.querySelectorAll('.navbar a').forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === path);
    });

    const fragment = routes[path] || routes['/'];
    const res = await fetch(fragment);
    const html = await res.text();

    content.innerHTML = html;
    content.classList.remove('fade-out');
    content.classList.add('fade-in');

    setTimeout(() => content.classList.remove('fade-in'), 200);

    loginMode = 'login';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
}

function setLoggedOut() {
    document.getElementById('topbar-user').classList.add('hidden');
    document.getElementById('topbar-login-btn').classList.remove('hidden');
    document.getElementById('topbar-logout-btn').classList.add('hidden');
}

async function handleLogout() {
    await fetch('/api/logout', {method: 'POST'});
    currentUser = null;
    setLoggedOut();
    navigate('/');
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
    navigate(window.location.pathname, false);
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
    await navigate(window.location.pathname, false);
})();
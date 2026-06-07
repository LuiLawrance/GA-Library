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

    // Reset footer visibility when navigating
    document.querySelector('.footer').classList.remove('footer-hidden');

    if (path === '/cards') {
        await loadSets();
        setTimeout(setupFooterScroll, 100);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
}

function setLoggedOut() {
    document.getElementById('topbar-user').classList.add('hidden');
    document.getElementById('topbar-login-btn').classList.remove('hidden');
    document.getElementById('topbar-logout-btn').classList.add('hidden');
    document.getElementById('nav-inventory').classList.add('hidden');
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
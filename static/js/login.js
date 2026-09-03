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
    // No password check — an admin-reset account logs in with a blank one and
    // hits the account-setup gate.
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
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params
        });

        if (res.ok) {
            const data = await res.json();
            currentUser = data.username;
            isAdmin = ADMIN_CONSOLE_RANKS.has(data.auth_type);
            setLoggedIn(currentUser);
            if (typeof maybeShowAccountSetup !== 'function' || !maybeShowAccountSetup(data)) navigate('/');
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
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
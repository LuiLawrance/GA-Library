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
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
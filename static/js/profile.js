// ── Profile page ──
// Two views off the same fragment (see app.js router):
//   /profile         → your own account: overview + stats + editable bio,
//                      password change, delete account.
//   /#<omnidex_id>   → another user's public profile, looked up by their
//                      (unique) Omnidex ID: same overview, stats, decks and
//                      bins, read-only — every account-management control gone.

let profileData = null;
let profileMode = 'self';   // 'self' | 'public'

async function initProfile() {
    profileMode = 'self';
    profileData = null;

    const body = document.getElementById('profile-body');
    if (!body) return;

    document.getElementById('profile-page')?.classList.remove('profile-view-public');
    setProfileHint('profile-bio-hint', '');
    setProfileHint('profile-pw-hint', '');
    setProfileHint('profile-delete-hint', '');

    try {
        const res = await fetch('/api/profile');
        if (!res.ok) throw new Error('Failed to load profile');
        profileData = await res.json();
    } catch (err) {
        body.innerHTML = '<div class="admin-pid-detail-empty">Could not load your profile. Try refreshing.</div>';
        return;
    }

    renderProfile();
}

async function initPublicProfile(omnidexId) {
    profileMode = 'public';
    profileData = null;

    const body = document.getElementById('profile-body');
    if (!body) return;

    document.getElementById('profile-page')?.classList.add('profile-view-public');

    try {
        const res = await fetch(`/api/users/${encodeURIComponent(omnidexId)}`);
        if (res.status === 404) {
            body.innerHTML = `<div class="admin-pid-detail-empty">No user found for Omnidex ID ${escapeHtml(omnidexId)}.</div>`;
            return;
        }
        if (!res.ok) throw new Error('Failed to load profile');
        profileData = await res.json();
    } catch (err) {
        body.innerHTML = '<div class="admin-pid-detail-empty">Could not load this profile. Try refreshing.</div>';
        return;
    }

    // Viewing your own Omnidex ID → hand off to the editable self page.
    if (currentUser && profileData.username === currentUser) {
        navigate('/profile');
        return;
    }

    renderProfile();
}

function renderProfile() {
    if (!profileData) return;

    const isPublic = profileMode === 'public';

    // Header matches the Admin → Users profile panel: the username with the
    // Omnidex ID as a small trailing "#…", the rank on its own line below.
    const omniTrail = profileData.omnidex_id
        ? `<span class="profile-omnidex-trail">#${escapeHtml(profileData.omnidex_id)}</span>`
        : '';
    document.getElementById('profile-name').innerHTML = escapeHtml(profileData.username) + omniTrail;
    document.getElementById('profile-role').textContent = formatRole(profileData.auth_type);

    const sinceBlock = document.getElementById('profile-since-block');
    if (profileData.created_at) {
        sinceBlock.classList.remove('hidden');
        document.getElementById('profile-since').textContent = formatProfileDate(profileData.created_at);
    } else {
        sinceBlock.classList.add('hidden');
    }

    const stats = profileData.stats || {};
    document.getElementById('profile-stat-bins').textContent = stats.bins ?? '—';
    document.getElementById('profile-stat-cards').textContent = stats.cards ?? '—';
    document.getElementById('profile-stat-decks').textContent = stats.decks ?? '—';

    renderProfileAbout(isPublic);

    // Danger zone is self-only; CSS also hides it in the public view, but keep
    // the class in sync. The owner account can't delete itself either.
    document.getElementById('profile-danger').classList.toggle(
        'hidden', isPublic || profileData.auth_type === 'owner');

    renderProfileDecks(profileData.decks || []);
    renderProfileBins(profileData.bins || []);
}

function renderProfileAbout(isPublic) {
    const panel = document.querySelector('.profile-area-about');
    const textarea = document.getElementById('profile-bio');
    const actions = document.getElementById('profile-bio-actions');
    const readonly = document.getElementById('profile-bio-readonly');
    const bio = (profileData.bio || '').trim();

    if (isPublic) {
        panel.classList.toggle('hidden', !bio);   // no bio → drop the panel
        textarea.classList.add('hidden');
        actions.classList.add('hidden');
        readonly.classList.remove('hidden');
        readonly.textContent = bio;
    } else {
        panel.classList.remove('hidden');
        textarea.classList.remove('hidden');
        actions.classList.remove('hidden');
        readonly.classList.add('hidden');
        textarea.value = profileData.bio || '';
    }
}

// Decks / Inventory Bins tiles — the same read-only tile markup the Admin
// Users page renders (adminUserDeckTilesHtml / adminUserBinTilesHtml in
// admin.js); .admin-user-tile strips the click affordance the real pages'
// tiles carry.
function renderProfileDecks(decks) {
    document.getElementById('profile-decks-count').textContent = decks.length || '';

    const menu = document.getElementById('profile-decks-menu');
    menu.classList.toggle('is-empty', !decks.length);

    if (!decks.length) {
        menu.innerHTML = '<div class="profile-menu-empty">No decks yet.</div>';
        return;
    }

    menu.innerHTML = decks.map(d => {
        const banner = d.banner
            ? `<div class="dga-tile-banner" style="background-image: url('/images/${encodeURIComponent(d.banner)}.jpg')"></div>`
            : '';
        const format = d.format ? `<span class="dga-tile-format">${escapeHtml(d.format)}</span>` : '';
        return `
            <div class="dga-deck-tile admin-user-tile ${d.banner ? 'has-banner' : ''}">
                ${banner}
                <div class="dga-tile-icon-row">
                    <span class="dga-tile-icon">⬡</span>
                    ${format}
                </div>
                <div class="dga-tile-name">${escapeHtml(d.name)}</div>
                <div class="dga-tile-desc">${escapeHtml(d.desc || '')}</div>
                <div class="dga-tile-meta">${d.card_count} card${d.card_count !== 1 ? 's' : ''}</div>
            </div>`;
    }).join('');
}

function renderProfileBins(bins) {
    document.getElementById('profile-bins-count').textContent = bins.length || '';

    const menu = document.getElementById('profile-bins-menu');
    menu.classList.toggle('is-empty', !bins.length);

    if (!bins.length) {
        menu.innerHTML = '<div class="profile-menu-empty">No inventory bins yet.</div>';
        return;
    }

    menu.innerHTML = bins.map(b => {
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
            </div>`;
    }).join('');
}

function formatProfileDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString(undefined, {year: 'numeric', month: 'long', day: 'numeric'});
}

function setProfileHint(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('profile-hint-error', 'profile-hint-success');
    if (kind) el.classList.add(`profile-hint-${kind}`);
}

async function saveProfileBio() {
    const btn = document.getElementById('profile-bio-save');
    const bio = document.getElementById('profile-bio').value;

    btn.disabled = true;
    setProfileHint('profile-bio-hint', '');

    try {
        const res = await fetch('/api/profile/bio', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({bio}),
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.detail || 'Save failed');

        if (profileData) profileData.bio = data.bio;
        document.getElementById('profile-bio').value = data.bio;
        setProfileHint('profile-bio-hint', 'Saved.', 'success');
    } catch (err) {
        setProfileHint('profile-bio-hint', err.message || 'Save failed.', 'error');
    } finally {
        btn.disabled = false;
    }
}

async function updateProfilePassword() {
    const currentEl = document.getElementById('profile-pw-current');
    const newEl = document.getElementById('profile-pw-new');
    const confirmEl = document.getElementById('profile-pw-confirm');
    const btn = document.getElementById('profile-pw-save');

    const current_password = currentEl.value;
    const new_password = newEl.value;

    setProfileHint('profile-pw-hint', '');

    if (!current_password || !new_password) {
        setProfileHint('profile-pw-hint', 'Fill in every field.', 'error');
        return;
    }
    if (new_password !== confirmEl.value) {
        setProfileHint('profile-pw-hint', 'New passwords do not match.', 'error');
        return;
    }

    btn.disabled = true;

    try {
        const res = await fetch('/api/profile/password', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({current_password, new_password}),
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data.detail || 'Update failed');

        currentEl.value = '';
        newEl.value = '';
        confirmEl.value = '';
        setProfileHint('profile-pw-hint', 'Password updated.', 'success');
    } catch (err) {
        setProfileHint('profile-pw-hint', err.message || 'Update failed.', 'error');
    } finally {
        btn.disabled = false;
    }
}

async function deleteMyAccount() {
    const ok = await appConfirm(
        `This permanently deletes "${profileData?.username ?? 'your account'}" and all of its data.`,
        {title: 'Delete Account', confirmLabel: 'Delete Account'},
    );
    if (!ok) return;

    setProfileHint('profile-delete-hint', '');

    try {
        const res = await fetch('/api/profile', {method: 'DELETE'});
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.detail || 'Delete failed');
        }
    } catch (err) {
        setProfileHint('profile-delete-hint', err.message || 'Delete failed.', 'error');
        return;
    }

    currentUser = null;
    isAdmin = false;
    setLoggedOut();
    navigate('/');
}

window.initProfile = initProfile;
window.initPublicProfile = initPublicProfile;

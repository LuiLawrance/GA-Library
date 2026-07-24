let adminActiveSection = 'pricing';
let adminPidLoaded = false;
let adminPidData = [];
let adminPidSelected = new Set();
let adminPidRefreshStatus = {};
let adminPidRefreshing = false;

let adminPidDetailSelected = null;
let adminPidDetailHistory = null;

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

    content?.classList.remove('fade-out');
    content?.classList.add('fade-in');
    setTimeout(() => content?.classList.remove('fade-in'), 200);
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

function renderAdminPricingIds() {
    const summary = document.getElementById('admin-pid-summary');
    const header = document.getElementById('admin-pid-table-header');
    const table = document.getElementById('admin-pid-table');
    if (!summary || !header || !table) return;

    const withId = adminPidData.filter(e => e.product_id).length;
    const query = (document.getElementById('admin-pid-search')?.value || '').trim().toLowerCase();
    const missingOnly = document.getElementById('admin-pid-missing-only')?.checked;

    const filtered = adminPidData.filter(e => {
        if (missingOnly && e.product_id) return false;

        if (query) {
            const haystack = `${e.name} ${e.set_prefix || ''} ${e.set_name || ''}`.toLowerCase();
            if (!haystack.includes(query)) return false;
        }

        return true;
    });

    summary.textContent = `${withId} of ${adminPidData.length} editions have a product ID`
        + (filtered.length !== adminPidData.length ? ` — showing ${filtered.length}` : '');

    const rows = filtered.map(e => `
        <div class="admin-pid-row ${e.edition_id === adminPidDetailSelected ? 'admin-pid-row-active' : ''}"
             onclick="selectAdminPricingDetail('${escapeHtml(e.edition_id)}')">
            <span class="admin-pid-col-check" onclick="event.stopPropagation()">
                <input type="checkbox" class="admin-pid-row-check" data-edition-id="${escapeHtml(e.edition_id)}"
                       ${adminPidSelected.has(e.edition_id) ? 'checked' : ''}
                       onchange="onAdminPidRowCheckToggle(this)">
            </span>
            <span class="admin-pid-col-name">${escapeHtml(e.name)}</span>
            <span class="admin-pid-col-set">${escapeHtml(e.set_prefix || '—')}</span>
            <span class="admin-pid-col-status" onclick="event.stopPropagation()">
                <input type="text" class="admin-pid-input ${e.product_id ? 'admin-pid-input-filled' : ''}"
                       data-edition-id="${escapeHtml(e.edition_id)}"
                       value="${escapeHtml(e.product_id || '')}"
                       placeholder="Missing"
                       onkeydown="if (event.key === 'Enter') this.blur()"
                       onblur="saveAdminProductId(this)">
            </span>
            <span class="admin-pid-col-refresh">${adminPidRefreshStatusMarkup(e.edition_id)}</span>
        </div>
    `).join('');

    header.innerHTML = `
        <div class="admin-pid-row admin-pid-row-header">
            <span class="admin-pid-col-check">
                <input type="checkbox" id="admin-pid-select-all" onchange="toggleSelectAllAdminPricing(this)">
            </span>
            <span class="admin-pid-col-name">Card</span>
            <span class="admin-pid-col-set">Set</span>
            <span class="admin-pid-col-status">Product ID</span>
            <span class="admin-pid-col-refresh">Refresh Status</span>
        </div>
    `;

    table.innerHTML = rows || '<div class="admin-pid-empty">No editions match.</div>';

    const filteredIds = filtered.map(e => e.edition_id);
    const selectedInFiltered = filteredIds.filter(id => adminPidSelected.has(id));
    const selectAllBox = document.getElementById('admin-pid-select-all');

    if (selectAllBox) {
        selectAllBox.checked = filteredIds.length > 0 && selectedInFiltered.length === filteredIds.length;
        selectAllBox.indeterminate = selectedInFiltered.length > 0 && !selectAllBox.checked;
    }

    updateAdminPidRefreshButton();
}

function adminPidRefreshStatusMarkup(editionId) {
    const status = adminPidRefreshStatus[editionId];
    if (!status) return '<span class="admin-pid-refresh-idle">—</span>';

    if (status.state === 'running') {
        return '<span class="admin-pid-refresh-running">Running…</span>';
    }

    if (status.state === 'error') {
        return `<span class="admin-pid-refresh-error" title="${escapeHtml(status.message)}">${escapeHtml(status.message)}</span>`;
    }

    return `<span class="admin-pid-refresh-done">${escapeHtml(status.message)}</span>`;
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
        renderAdminPricingIds();
        if (adminPidDetailSelected === editionId) renderAdminPricingDetailAll();
    } catch (err) {
        input.value = record.product_id || '';
        input.classList.add('admin-pid-input-error');
        setTimeout(() => input.classList.remove('admin-pid-input-error'), 3000);
    }
}

async function refreshSelectedAdminPricing(target) {
    const editionIds = getAdminPidRefreshTargets();
    if (adminPidRefreshing || editionIds.length === 0) return;

    adminPidRefreshing = true;
    const progress = document.getElementById('admin-pid-progress');
    updateAdminPidRefreshButton();

    for (let i = 0; i < editionIds.length; i++) {
        const editionId = editionIds[i];

        adminPidRefreshStatus[editionId] = {state: 'running', message: ''};
        renderAdminPricingIds();

        if (progress) {
            progress.classList.remove('hidden');
            progress.textContent = `Refreshing ${i + 1} of ${editionIds.length}…`;
        }

        try {
            adminPidRefreshStatus[editionId] = await runAdminPricingRefreshJob(editionId, target);
        } catch (err) {
            adminPidRefreshStatus[editionId] = {state: 'error', message: 'Request failed'};
        }

        renderAdminPricingIds();

        if (adminPidDetailSelected === editionId) {
            await loadAdminPricingDetailHistory();
        }
    }

    adminPidRefreshing = false;

    if (progress) {
        progress.textContent = `Done refreshing ${editionIds.length} edition(s).`;
        setTimeout(() => progress.classList.add('hidden'), 4000);
    }

    updateAdminPidRefreshButton();
}

async function runAdminPricingRefreshJob(editionId, target) {
    const startRes = await fetch(`/api/pricing/${editionId}/refresh/start?target=${target}`, {method: 'POST'});

    if (!startRes.ok) {
        const errData = await startRes.json().catch(() => ({}));
        return {state: 'error', message: errData.detail || 'Failed to start refresh'};
    }

    const {job_id} = await startRes.json();

    while (true) {
        await new Promise(r => setTimeout(r, 1200));

        const statusRes = await fetch(`/api/pricing/refresh/status/${job_id}`);
        if (!statusRes.ok) {
            return {state: 'error', message: 'Lost track of refresh job'};
        }

        const job = await statusRes.json();
        if (job.status === 'running') continue;

        if (job.status === 'error') {
            return {state: 'error', message: job.error || 'Unknown error'};
        }

        return summarizeAdminPricingRefresh(job.sales, job.listings, target);
    }
}

function summarizeAdminPricingRefresh(sales, listings, target) {
    const salesOk = !sales || sales.ok;
    const listingsOk = !listings || listings.ok;

    const salesText = !sales ? null
        : !sales.ok ? `Sales: ${sales.error}`
        : `Sales: +${sales.stored ?? 0}`;

    const listingsText = !listings ? null
        : !listings.ok ? `Listings: ${listings.error}`
        : listings.gated ? 'Listings: gated'
        : `Listings: +${listings.stored ?? 0}`;

    const parts = [];
    if (target !== 'listings' && salesText) parts.push(salesText);
    if (target !== 'sales' && listingsText) parts.push(listingsText);

    return {
        state: (salesOk && listingsOk) ? 'done' : 'error',
        message: parts.join(' · ') || 'No data'
    };
}

async function selectAdminPricingDetail(editionId) {
    if (adminPidDetailSelected === editionId) return;

    const imageCol = document.getElementById('admin-pricing-image-col');
    const detail = document.getElementById('admin-pricing-detail');

    imageCol?.classList.add('fade-out');
    detail?.classList.add('fade-out');
    await sleep(150);

    adminPidDetailSelected = editionId;
    adminPidDetailHistory = null;

    renderAdminPricingIds();
    renderAdminPricingDetailAll();

    imageCol?.classList.remove('fade-out');
    detail?.classList.remove('fade-out');
    imageCol?.classList.add('fade-in');
    detail?.classList.add('fade-in');
    setTimeout(() => {
        imageCol?.classList.remove('fade-in');
        detail?.classList.remove('fade-in');
    }, 200);

    await loadAdminPricingDetailHistory();
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
        col.innerHTML = '<div class="admin-pid-detail-empty">Select a card from the list to view its pricing details.</div>';
        return;
    }

    const record = adminPidData.find(e => e.edition_id === adminPidDetailSelected);
    if (!record) {
        col.innerHTML = '<div class="admin-pid-detail-empty">Card not found.</div>';
        return;
    }

    const historyLoaded = !!adminPidDetailHistory;
    const lastSales = historyLoaded ? (adminPidDetailHistory.last_sales || 'Never') : '…';
    const lastListings = historyLoaded ? (adminPidDetailHistory.last_listings || 'Never') : '…';

    col.innerHTML = `
        <div class="admin-pid-detail-header">
            <span class="admin-pid-detail-name">${escapeHtml(record.name)}</span>
            <span class="admin-pid-detail-set">${escapeHtml(record.set_name || record.set_prefix || '—')}</span>
        </div>
        <img class="admin-pid-detail-image" src="/images/${escapeHtml(record.edition_id)}.jpg" alt="${escapeHtml(record.name)}">
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
            <label class="admin-pid-detail-label">Product ID</label>
            <input type="text" class="admin-pid-input ${record.product_id ? 'admin-pid-input-filled' : ''}"
                   data-edition-id="${escapeHtml(record.edition_id)}"
                   value="${escapeHtml(record.product_id || '')}"
                   placeholder="Missing"
                   onkeydown="if (event.key === 'Enter') this.blur()"
                   onblur="saveAdminProductId(this)">
        </div>
    `;
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

    const historyLoaded = !!adminPidDetailHistory;
    const salesRows = historyLoaded ? adminPidDetailHistory.sales : [];
    const listingsRows = historyLoaded ? adminPidDetailHistory.listings : [];

    panel.innerHTML = `
        <div class="admin-pid-detail-section">
            <span class="admin-pid-detail-section-title">Sales</span>
            ${adminPidDetailHistoryTableHtml(salesRows, historyLoaded)}
        </div>
        <div class="admin-pid-detail-section">
            <span class="admin-pid-detail-section-title">Listings</span>
            ${adminPidDetailHistoryTableHtml(listingsRows, historyLoaded)}
        </div>
    `;
}

function adminPidDetailHistoryTableHtml(rows, loaded) {
    if (!loaded) return '<div class="admin-pid-detail-loading">Loading…</div>';
    if (!rows.length) return '<div class="admin-pid-detail-empty-small">No records.</div>';

    const rowsHtml = rows.map(r => `
        <div class="admin-pid-detail-row">
            <span>${escapeHtml(r.date)}</span>
            <span>${escapeHtml(r.info || '')}</span>
            <span>$${Number(r.price).toFixed(2)}</span>
            <span>×${escapeHtml(String(r.quantity))}</span>
        </div>
    `).join('');

    return `
        <div class="admin-pid-detail-table">
            <div class="admin-pid-detail-row admin-pid-detail-row-header">
                <span>Date</span><span>Condition</span><span>Price</span><span>Qty</span>
            </div>
            ${rowsHtml}
        </div>
    `;
}

function initAdmin() {
    adminActiveSection = 'pricing';
    adminPidLoaded = false;
    adminPidData = [];
    adminPidSelected = new Set();
    adminPidRefreshStatus = {};
    adminPidRefreshing = false;
    adminPidDetailSelected = null;
    adminPidDetailHistory = null;
    loadAdminPricingIds();
}

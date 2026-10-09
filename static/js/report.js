// "Report an issue" pop-up — the topbar ❓ button (index.html). Open to
// guests too, since the thing that's broken might be logging in. Posts to
// /api/reports (see reports.py); admins review them under Admin -> Reports.

let reportCategory = 'bug';
let reportSubmitting = false;

function openReportModal() {
    reportSubmitting = false;
    document.getElementById('report-form').classList.remove('hidden');
    document.getElementById('report-done').classList.add('hidden');
    document.getElementById('report-error').classList.add('hidden');
    document.getElementById('report-message').value = '';
    document.getElementById('report-page').textContent = `Page: ${window.location.pathname}${window.location.hash}`;
    document.getElementById('report-modal').classList.remove('hidden');
    // Pill indicator needs the track laid out (visible) to measure.
    setReportCategory('bug');
    updateReportSubmit();
    setTimeout(() => document.getElementById('report-message').focus(), 60);
}

function closeReportModal() {
    document.getElementById('report-modal').classList.add('hidden');
}

function setReportCategory(category) {
    reportCategory = category;
    const track = document.getElementById('report-category');
    track.querySelectorAll('.pill-toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.category === category);
    });
    positionPillIndicator(track);
}

function updateReportSubmit() {
    const hasMessage = document.getElementById('report-message').value.trim().length > 0;
    document.getElementById('report-submit').disabled = reportSubmitting || !hasMessage;
}

async function submitReport() {
    const message = document.getElementById('report-message').value.trim();
    if (!message || reportSubmitting) return;

    const errorEl = document.getElementById('report-error');
    errorEl.classList.add('hidden');
    reportSubmitting = true;
    updateReportSubmit();

    try {
        const res = await fetch('/api/reports', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                category: reportCategory,
                message,
                page_url: window.location.pathname + window.location.search + window.location.hash,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Could not send your report.');

        document.getElementById('report-form').classList.add('hidden');
        document.getElementById('report-done').classList.remove('hidden');
    } catch (err) {
        errorEl.textContent = err.message || 'Could not send your report.';
        errorEl.classList.remove('hidden');
    } finally {
        reportSubmitting = false;
        updateReportSubmit();
    }
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('report-modal')?.classList.contains('hidden')) {
        closeReportModal();
    }
});

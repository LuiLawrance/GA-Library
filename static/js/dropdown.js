// ═══════════════════════════════════════
// dropdown.js — shared markup + behavior for a small value-picker dropdown,
// styled to match the app's form controls but with the centralized dropdown
// chrome: the .menu popover (revealDown entrance, animation.css) and the
// rotating .dropdown-arrow chevron (components.css). Behaves like the deck
// format / inventory filter dropdowns, minus the per-instance wiring — one
// delegated capture-phase listener handles every instance on the page.
//
// Used by: the Share dialogs' role pickers (inventory.js, decks_ga.js).
//
//   selectDropdownHTML(options, value)  → HTML string; options = [{value,label}]
//   selectDropdownValue(el)             → the current value of the dropdown
//                                         containing/at `el`
//   setSelectDropdown(el, value)        → set it programmatically (no event)
//
// A pick fires a bubbling `dropdown:change` CustomEvent (detail.value) on the
// `.select-dropdown` element — listen on any ancestor container.
// ═══════════════════════════════════════

// `up: true` opens the menu above the trigger — for a dropdown low in a
// scroll/overflow container (e.g. a collaborator row) where a downward menu
// would be clipped.
function selectDropdownHTML(options, value, {up = false} = {}) {
    const cur = options.find(o => o.value === value) || options[0];
    const opt = o => `<div class="select-dropdown-option${o.value === cur.value ? ' selected' : ''}" `
        + `data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</div>`;
    return `<div class="select-dropdown${up ? ' select-dropdown--up' : ''}" data-value="${escapeHtml(cur.value)}">
        <button type="button" class="select-dropdown-btn">
            <span class="select-dropdown-label">${escapeHtml(cur.label)}</span>
            <span class="dropdown-arrow">&#8249;</span>
        </button>
        <div class="select-dropdown-menu menu hidden">${options.map(opt).join('')}</div>
    </div>`;
}

// `el` may be the .select-dropdown itself, an element inside it, or a wrapper
// element that contains it (e.g. the #inv-share-role span).
function selectDropdownValue(el) {
    const dd = el?.closest?.('.select-dropdown') || el?.querySelector?.('.select-dropdown');
    return dd?.dataset.value ?? null;
}

function setSelectDropdown(el, value) {
    const dd = el?.closest('.select-dropdown') || el?.querySelector?.('.select-dropdown');
    if (!dd) return;
    const opt = dd.querySelector(`.select-dropdown-option[data-value="${CSS.escape(value)}"]`);
    if (!opt) return;
    dd.dataset.value = value;
    dd.querySelector('.select-dropdown-label').textContent = opt.textContent;
    dd.querySelectorAll('.select-dropdown-option').forEach(o => o.classList.toggle('selected', o === opt));
}

function _closeSelectDropdowns(except) {
    document.querySelectorAll('.select-dropdown-btn.open').forEach(btn => {
        if (btn === except) return;
        btn.classList.remove('open');
        btn.nextElementSibling?.classList.add('hidden');
    });
}

// Capture phase: clicks inside .inv-modal don't bubble to document (the modal
// calls event.stopPropagation()), so the toggle/select/outside-close logic has
// to run on the way down — same reason as decks_ga's format dropdown.
document.addEventListener('click', e => {
    const btn = e.target.closest('.select-dropdown-btn');
    if (btn) {
        const opening = !btn.classList.contains('open');
        _closeSelectDropdowns(btn);
        btn.classList.toggle('open', opening);
        btn.nextElementSibling.classList.toggle('hidden', !opening);
        return;
    }
    const opt = e.target.closest('.select-dropdown-option');
    if (opt) {
        const dd = opt.closest('.select-dropdown');
        const value = opt.dataset.value;
        setSelectDropdown(dd, value);
        dd.querySelector('.select-dropdown-btn').classList.remove('open');
        dd.querySelector('.select-dropdown-menu').classList.add('hidden');
        dd.dispatchEvent(new CustomEvent('dropdown:change', {bubbles: true, detail: {value}}));
        return;
    }
    _closeSelectDropdowns(null);
}, true);

// ═══════════════════════════════════════
// modal-anim.js — shared modal/page resize, morph, and fade-swap animations
// Used by: decks_ga (Deck Settings ↔ Import/Export, Import/Export tabs, Add Card),
//          inventory (Bin Settings ↔ Import/Export, Import/Export tabs, Add Card),
//          app.js (page-to-page navigation), admin.js (pricing/user detail panels,
//          Cards section's Info/Pricing sub-view swap, Info/Pricing and
//          Regular/Discord pill toggles), drawer.js (edition switch)
// ═══════════════════════════════════════
//
// Five reusable pieces:
//
//   animateBoxResize(box, mutate) — smoothly resizes a single, persistent box (same
//   overlay throughout) between two states caused by `mutate`, a synchronous DOM/class
//   swap. Used for step swaps within one modal: Import/Export's Import↔Export tabs,
//   Add Card's search↔confirm steps.
//
//   animateGridColumns(el, mutate) — animateBoxResize's sibling for a CSS Grid
//   container's own grid-template-columns instead of a box's width/height. Used for
//   admin's Info/Pricing list-column resize — animating the GRID's tracks (rather than
//   giving the list item its own explicit width to animate) is what makes a sibling
//   sitting in one of the OTHER tracks (the card info window, in the fixed 320px track)
//   visibly slide along for free, as a normal side effect of the grid recalculating each
//   frame, instead of needing its own separate position animation.
//
//   morphBoxIn(box, fromRect) / resetMorphBox(box) — animates a box growing/shrinking
//   from `fromRect`'s size down to its own natural size via transform:scale(), for
//   morphing between two DIFFERENT boxes living in different modal overlays (e.g.
//   Settings → Import/Export) without revealing a second overlay (which needs a fresh
//   backdrop-filter composite and flashes) or animating width/height directly (which
//   fights CSS min/max-width clamps and forces a layout+paint every frame).
//
//   fadeSwap(els, mutate) — fades `els` out, runs `mutate` (the actual content swap),
//   then fades back in. Used any time a whole panel's *content* is being replaced
//   wholesale rather than resized/morphed in place: page navigation, admin detail-panel
//   switches, drawer edition switches.
//
//   positionPillIndicator(container) — measures whichever child of `container` has
//   `.active` and positions a sliding `.pill-indicator` sibling under it via
//   width/height/top + a translateX transform, so a plain CSS transition on
//   `.pill-indicator` (see admin.css) animates it sliding there from wherever it was.
//   Call after toggling which child has `.active`, and again once a previously-hidden
//   container becomes visible (offsetWidth reads 0 while display:none, so a call made
//   while hidden has nothing to measure).
//
// animateBoxResize/morphBoxIn rely on the shared `.morph-resizing` / min-max-width-suspend
// CSS conventions already used by the pages that call them (see inventory.css). fadeSwap
// relies on each caller's own `.fade-out`/`.fade-in` (or equivalently-shaped) CSS class
// pair already defined for the element(s) it's fading (see main.css, admin.css,
// drawer.css) — it only drives the class toggling and timing, not the visual itself.
// positionPillIndicator similarly expects each caller's own container to already have a
// `.pill-indicator` element in it (see admin.css's two pill toggles) — it only computes
// and applies the position, not the pill's look.

const _resizeAnims = new WeakMap();

// Runs `mutate` (any synchronous DOM/class swap that changes `box`'s natural size) and
// smoothly resizes `box` from its size before to its size after. Animates width+height
// together (harmless when only one dimension actually changes). Returns a promise that
// resolves once the resize (if any was needed) finishes — callers that fire a SECOND
// resize on the same box shortly after (e.g. once async data loads in) should await this
// first, since a second call cancels whatever's still running on that box (see below) and
// would otherwise cut the first resize short before it's had any real time to be visible.
function animateBoxResize(box, mutate, {duration = 300} = {}) {
    // Cancel any previous resize animation on THIS box first, before measuring anything —
    // its held fill:'forwards' value overrides CSS regardless of class changes, so
    // measuring "from" and "to" while it's still active would read its stale held size for
    // both, making them look identical and skipping the animation below entirely.
    _resizeAnims.get(box)?.cancel();
    _resizeAnims.delete(box);

    const fromWidth = box.offsetWidth;
    const fromHeight = box.offsetHeight;

    mutate();

    const toWidth = box.offsetWidth;
    const toHeight = box.offsetHeight;

    // Skip animating when the box isn't visible yet, or the size genuinely didn't change.
    if (!fromWidth || !fromHeight || (fromWidth === toWidth && fromHeight === toHeight)) return Promise.resolve();

    // Whatever CSS min/max-width and max-height apply to the box's NEW state are already
    // in effect (mutate() already toggled classes) — e.g. a narrower max-width for the new
    // step would otherwise clamp the box there on frame 0, before the animation gets a
    // chance to ease it there. Suspend the clamps for the animation's duration.
    box.style.overflow = 'hidden';
    box.style.minWidth = '0';
    box.style.maxWidth = 'none';
    box.style.maxHeight = 'none';

    const anim = box.animate([
        {width: fromWidth + 'px', height: fromHeight + 'px'},
        {width: toWidth + 'px', height: toHeight + 'px'}
    ], {duration, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards'});
    _resizeAnims.set(box, anim);

    // Cleanup — and the "done" signal returned to the caller — is driven by a plain
    // timer, not anim.finished: that promise isn't guaranteed to settle promptly (some
    // environments never resolve it at all), and a caller sequencing a second resize
    // after this one needs a reliable signal, not one that can hang indefinitely.
    return sleep(duration).then(() => {
        // Only clean up if nothing newer has already taken over this box — a second
        // animateBoxResize() call on the same box before this timer fires already did
        // its own cancel+takeover, so redoing it here would stomp on that one instead.
        if (_resizeAnims.get(box) !== anim) return;
        anim.cancel();
        _resizeAnims.delete(box);
        box.style.overflow = '';
        box.style.minWidth = '';
        box.style.maxWidth = '';
        box.style.maxHeight = '';
    });
}

// Cancels any in-flight animateBoxResize() animation on `box` and clears the temporary
// inline styles it uses — call when a modal is closing, so a stale fill:'forwards' hold
// can't stick around for the next time it opens.
function resetBoxResize(box) {
    _resizeAnims.get(box)?.cancel();
    _resizeAnims.delete(box);
    box.style.overflow = '';
    box.style.minWidth = '';
    box.style.maxWidth = '';
    box.style.maxHeight = '';
}

const _gridColumnAnims = new WeakMap();

// animateBoxResize's sibling for a CSS Grid container's own grid-template-columns,
// rather than a box's width/height. Runs `mutate` (a synchronous DOM/class swap that
// changes which grid-template-columns rule applies to `el`) and smoothly animates
// between whatever those tracks resolve to before and after.
//
// Reads getComputedStyle(el).gridTemplateColumns for both keyframes rather than the
// authored value (e.g. `minmax(0, 1.4fr)`) — animating a track between an `fr`/minmax()
// value and a plain `<length>` isn't well-defined/animatable per spec (no defined
// interpolation between a flex unit and a length unit), so both endpoints need to
// already be resolved to plain px for a smooth transition to actually happen rather than
// silently snapping. The number of tracks must stay the same across `mutate` for the
// same reason — adding/removing a track isn't animatable either.
//
// Doesn't touch any of `el`'s children directly — anything sitting in a track that
// ISN'T changing size just gets carried along for free as the grid recalculates each
// frame, which is the whole point of animating the grid itself instead of giving one
// item its own explicit width to animate (see animateBoxResize): a sibling in another
// track can visibly slide alongside the resizing one with no separate position
// animation of its own.
function animateGridColumns(el, mutate, {duration = 300} = {}) {
    // Cancel any previous animation on THIS element first, before measuring anything —
    // see animateBoxResize's own comment on this same pattern for why.
    _gridColumnAnims.get(el)?.cancel();
    _gridColumnAnims.delete(el);

    const fromCols = getComputedStyle(el).gridTemplateColumns;

    mutate();

    const toCols = getComputedStyle(el).gridTemplateColumns;

    if (fromCols === toCols) return Promise.resolve();

    const anim = el.animate([
        {gridTemplateColumns: fromCols},
        {gridTemplateColumns: toCols}
    ], {duration, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards'});
    _gridColumnAnims.set(el, anim);

    // Cleanup driven by a plain timer rather than anim.finished — see animateBoxResize's
    // own comment on this same pattern for why.
    return sleep(duration).then(() => {
        if (_gridColumnAnims.get(el) !== anim) return;
        anim.cancel();
        _gridColumnAnims.delete(el);
        el.style.gridTemplateColumns = '';
    });
}

// Animates `box` growing/shrinking from `fromRect` (any {width, height}, e.g. a
// getBoundingClientRect() or a plain object) down to its own natural size, via
// transform:scale(). The caller must already have made `box` the sole visible content of
// its overlay (reparented/unhidden as needed) before calling this — it only handles the
// animation. Adds 'morph-resizing' to suppress .inv-modal's default entrance keyframe
// (modalReveal), which would otherwise restart the instant this box became visible and
// (since its 0% frame is opacity:0) flash it invisible.
function morphBoxIn(box, fromRect, {duration = 350} = {}) {
    const toRect = box.getBoundingClientRect();
    const scaleX = fromRect.width / toRect.width;
    const scaleY = fromRect.height / toRect.height;

    box.classList.add('morph-resizing');

    const anim = box.animate([
        {transform: `scale(${scaleX}, ${scaleY})`},
        {transform: 'scale(1, 1)'}
    ], {duration, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards'});

    anim.finished.then(() => {
        anim.cancel();
        box.style.transform = '';
        // Deliberately NOT removing 'morph-resizing' here — see resetMorphBox().
    }).catch(() => {});
}

// Cleans up a box after morphBoxIn(), for when it's about to be fully hidden/torn down —
// cancels any in-flight animation, clears the leftover transform, and removes the
// 'morph-resizing' suppression. That suppression must only be lifted once the box is no
// longer visible: removing it while still shown restarts modalReveal (flashing the box
// invisible via its opacity:0 starting keyframe), so only call this right before/as the
// box (or its overlay) gets hidden.
function resetMorphBox(box) {
    box.getAnimations().forEach(a => a.cancel());
    box.classList.remove('morph-resizing');
    box.style.transform = '';
}

// Fades `els` out, awaits `mutate` (sync or async — the actual content swap: new innerHTML,
// a re-render, a src change), then fades back in. `els` is a single element or array of
// elements to fade together; falsy entries (e.g. an optional-chained lookup that missed)
// are ignored so callers can pass those straight through.
//
// outClass/inClass/outMs/inMs must match one real CSS class pair already defined for every
// element being faded — fadeSwap only toggles the classes and waits out their durations, it
// doesn't set any styles itself. The default pair is the base 'fade-out'/'fade-in' shape
// (opacity 0→1, translateY(8px)→0, 150ms out / 200ms in) duplicated per-page as
// .content.fade-out/.fade-in (main.css), .admin-content and the pricing/user detail panels
// (admin.css), and .drawer-card-image/.drawer-card-info (drawer.css). Pass a different pair
// for a different pace, e.g. admin.css's slower curio-fade-out/curio-fade-in (300/350ms) or
// curio-fade-out-bulk/curio-fade-in-bulk (450/500ms).
async function fadeSwap(els, mutate, {outClass = 'fade-out', inClass = 'fade-in', outMs = 150, inMs = 200} = {}) {
    const list = (Array.isArray(els) ? els : [els]).filter(Boolean);

    list.forEach(el => el.classList.add(outClass));
    await sleep(outMs);

    await mutate();

    list.forEach(el => {
        el.classList.remove(outClass);
        el.classList.add(inClass);
    });
    setTimeout(() => list.forEach(el => el.classList.remove(inClass)), inMs);
}

// Sliding highlight for a pill-style toggle — measures whichever child of `container`
// currently has `.active` and positions the `.pill-indicator` sibling under it via
// width/height/top + a translateX transform, so a plain CSS transition on
// `.pill-indicator` (not driven by this function — see admin.css) animates it sliding
// there from wherever it was. Call after toggling which child has `.active`, and again
// once a previously-hidden container becomes visible (offsetWidth reads 0 while
// display:none, so a call made while hidden has nothing to measure).
function positionPillIndicator(container) {
    const indicator = container?.querySelector('.pill-indicator');
    const active = container?.querySelector('.active');
    if (!indicator || !active) return;
    indicator.style.width = active.offsetWidth + 'px';
    indicator.style.height = active.offsetHeight + 'px';
    indicator.style.top = active.offsetTop + 'px';
    indicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

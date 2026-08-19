// ═══════════════════════════════════════
// modal-anim.js — shared modal resize/morph animations
// Used by: decks_ga (Deck Settings ↔ Import/Export, Import/Export tabs, Add Card),
//          inventory (Bin Settings ↔ Import/Export, Import/Export tabs, Add Card)
// ═══════════════════════════════════════
//
// Two reusable pieces:
//
//   animateBoxResize(box, mutate) — smoothly resizes a single, persistent box (same
//   overlay throughout) between two states caused by `mutate`, a synchronous DOM/class
//   swap. Used for step swaps within one modal: Import/Export's Import↔Export tabs,
//   Add Card's search↔confirm steps.
//
//   morphBoxIn(box, fromRect) / resetMorphBox(box) — animates a box growing/shrinking
//   from `fromRect`'s size down to its own natural size via transform:scale(), for
//   morphing between two DIFFERENT boxes living in different modal overlays (e.g.
//   Settings → Import/Export) without revealing a second overlay (which needs a fresh
//   backdrop-filter composite and flashes) or animating width/height directly (which
//   fights CSS min/max-width clamps and forces a layout+paint every frame).
//
// Both rely on the shared `.morph-resizing` / min-max-width-suspend CSS conventions
// already used by the pages that call them (see inventory.css).

const _resizeAnims = new WeakMap();

// Runs `mutate` (any synchronous DOM/class swap that changes `box`'s natural size) and
// smoothly resizes `box` from its size before to its size after. Animates width+height
// together (harmless when only one dimension actually changes).
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
    if (!fromWidth || !fromHeight || (fromWidth === toWidth && fromHeight === toHeight)) return;

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

    anim.finished.then(() => {
        anim.cancel();
        if (_resizeAnims.get(box) === anim) _resizeAnims.delete(box);
        box.style.overflow = '';
        box.style.minWidth = '';
        box.style.maxWidth = '';
        box.style.maxHeight = '';
    }).catch(() => {});
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

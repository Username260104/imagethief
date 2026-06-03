# Workbench First Copy VFX Plan

## Goal

When ImageThief successfully copies the object PNG for the first time in a workbench session, play a small VFX that makes the object feel like it was stolen into the app.

The effect should be simple:

1. create a translucent ghost of the copied PNG,
2. place it over the copied object,
3. pull it toward the lower center of the workspace,
4. shrink and fade it out,
5. show a short dark pocket pulse at the destination.

The VFX should play only after a clipboard write actually succeeds.

## Non-Goals

Do not add confetti, fireworks, celebration text, or a large animation library.

Do not play the VFX on every automatic parameter copy.

Do not make the main workbench state depend on the VFX lifecycle. Copy state and VFX lifecycle should stay separate.

Do not block user input while the VFX is playing.

## Current Flow

The relevant copy flow is in `src/workbench/index.ts`.

Current successful copy path:

```text
processSelection()
-> createPngBlob(...)
-> copyCurrentPng("auto-selection" | "auto-parameters")
-> runClipboardCopy(request)
-> writePngToClipboard(request.blob)
-> setState("copied", copySuccessMessage(request.trigger))
```

Manual retry uses the same path through `copyCurrentPng("manual")`.

The correct insertion point is inside `runClipboardCopy()` after:

```ts
await writePngToClipboard(request.blob);
```

and inside the existing freshness guard:

```ts
if (isCurrentClipboardRequest(request)) {
  setState("copied", copySuccessMessage(request.trigger));
}
```

This ensures the VFX does not fire for failed clipboard writes or stale automatic copy requests.

## First Successful Copy Rule

Add one session-scoped flag:

```ts
let hasPlayedFirstCopyVfx = false;
```

On a successful current clipboard write:

```ts
if (!hasPlayedFirstCopyVfx) {
  hasPlayedFirstCopyVfx = true;
  playFirstCopyVfx(request.blob);
}
```

This means:

1. first automatic selection copy succeeds: VFX plays,
2. automatic selection copy fails, then manual retry succeeds: VFX plays on the manual retry,
3. parameter copy succeeds after the first copy already succeeded: VFX does not play,
4. reset selection does not re-arm the VFX in the same workbench session.

If a future product decision wants "first copy per selection" instead of "first copy per session", reset this flag in `resetSelection()`.

## Recommended Implementation

Use DOM elements plus the Web Animations API.

No dependency is needed because the effect is a short transform animation over an image blob.

### VFX Layer

Create a non-interactive absolute overlay inside `.workspace`.

Implementation can either:

1. add a static element to `workbench.html`:

```html
<div id="copy-vfx-layer" class="copy-vfx-layer" aria-hidden="true"></div>
```

or:

2. create it lazily from TypeScript:

```ts
function ensureCopyVfxLayer(): HTMLElement {
  const existing = document.querySelector<HTMLElement>("#copy-vfx-layer");
  if (existing) {
    return existing;
  }

  const layer = document.createElement("div");
  layer.id = "copy-vfx-layer";
  layer.className = "copy-vfx-layer";
  layer.setAttribute("aria-hidden", "true");
  canvas.parentElement?.append(layer);
  return layer;
}
```

Lazy creation avoids adding another required DOM element and keeps the existing workbench markup less fragile.

### Start Position

The source position should come from the copied output bounds, not the lasso bounds.

Use `maskResult.outputBounds` and `displayTransform`:

```ts
const startRect = {
  x: displayTransform.offsetX + maskResult.outputBounds.x * displayTransform.scale,
  y: displayTransform.offsetY + maskResult.outputBounds.y * displayTransform.scale,
  width: maskResult.outputBounds.width * displayTransform.scale,
  height: maskResult.outputBounds.height * displayTransform.scale
};
```

Because `pngBlob` is created from `outputBounds`, an `<img>` rendered at this rect should line up with the copied object.

### Destination

The destination should be the lower center of `.workspace`, roughly where the app feels like it pockets the object.

Suggested target:

```ts
const layerRect = layer.getBoundingClientRect();
const targetX = layerRect.width / 2;
const targetY = Math.max(80, layerRect.height - 72);
```

Keep it inside the workspace so the effect works both in the extension tab and embedded overlay.

### Ghost Element

Use the current `pngBlob` or the successful request blob:

```ts
const objectUrl = URL.createObjectURL(blob);
const ghost = document.createElement("img");
ghost.className = "copy-vfx-ghost";
ghost.src = objectUrl;
```

Set explicit pixel dimensions and transform origin:

```ts
ghost.style.left = `${startRect.x}px`;
ghost.style.top = `${startRect.y}px`;
ghost.style.width = `${startRect.width}px`;
ghost.style.height = `${startRect.height}px`;
ghost.style.transformOrigin = "50% 55%";
```

Revoke the object URL after the animation finishes.

### Animation Shape

Suggested timing:

```text
lift: 80ms
snatch: 360ms
pocket pulse: 140ms
total: about 500ms
```

Suggested ghost keyframes:

```ts
const deltaX = targetX - (startRect.x + startRect.width / 2);
const deltaY = targetY - (startRect.y + startRect.height / 2);

ghost.animate(
  [
    {
      opacity: 0,
      filter: "drop-shadow(0 0 0 rgba(0, 0, 0, 0))",
      transform: "translate(0, 0) scale(1) rotate(0deg)"
    },
    {
      opacity: 0.72,
      filter: "drop-shadow(0 10px 18px rgba(0, 0, 0, 0.28))",
      transform: "translate(0, -8px) scale(1.03) rotate(-1deg)",
      offset: 0.16
    },
    {
      opacity: 0,
      filter: "drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1))",
      transform: `translate(${deltaX}px, ${deltaY}px) scale(0.12) rotate(7deg)`
    }
  ],
  {
    duration: 480,
    easing: "cubic-bezier(0.18, 0.9, 0.22, 1)",
    fill: "forwards"
  }
);
```

Suggested pocket pulse:

```ts
const pocket = document.createElement("div");
pocket.className = "copy-vfx-pocket";
pocket.style.left = `${targetX}px`;
pocket.style.top = `${targetY}px`;
```

Animate it as a tiny dark aperture:

```text
scale 0.35 -> 1.0 -> 0.55
opacity 0 -> 0.32 -> 0
duration 180ms
delay 320ms
```

The pulse should feel like the object disappears into a pocket, not like a success badge.

## CSS

Add styles in `src/workbench/style.css`:

```css
.copy-vfx-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 3;
}

.copy-vfx-ghost {
  position: absolute;
  display: block;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  will-change: opacity, transform, filter;
}

.copy-vfx-pocket {
  position: absolute;
  width: 32px;
  height: 10px;
  border-radius: 999px;
  background: rgba(20, 20, 20, 0.78);
  box-shadow: 0 0 18px rgba(20, 20, 20, 0.24);
  pointer-events: none;
  transform: translate(-50%, -50%) scale(0.4);
  will-change: opacity, transform;
}
```

The VFX layer should sit above the canvas but below blocking messages if those are visible. If it visually conflicts with the parameter panel, keep the layer below the panel by using a lower z-index than `.parameter-panel`.

## Reduced Motion

Respect reduced-motion preferences:

```ts
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
```

If reduced motion is enabled:

1. do not move the ghost across the screen,
2. show a quick fade or outline pulse near the object,
3. keep the duration under 180ms.

This preserves feedback without forcing a snatch motion.

## Failure and Cleanup

The VFX must be best-effort. If anything fails while building the effect, the copy should still be considered successful.

Cleanup requirements:

1. remove ghost and pocket elements after animations finish,
2. revoke the object URL,
3. cancel any currently running first-copy VFX before starting a replacement, even though the flag should normally prevent repeats,
4. never call `setState()` from VFX cleanup.

Suggested cleanup pattern:

```ts
const animation = ghost.animate(...);
animation.finished
  .catch(() => undefined)
  .finally(() => {
    ghost.remove();
    pocket.remove();
    URL.revokeObjectURL(objectUrl);
  });
```

## Implementation Steps

1. Add `hasPlayedFirstCopyVfx` near existing clipboard state variables.
2. Add `playFirstCopyVfx(blob: Blob): void`.
3. Add helper functions for layer creation, start rect calculation, and reduced-motion handling.
4. Call `playFirstCopyVfx(request.blob)` only after current clipboard success and only if the flag is false.
5. Add `.copy-vfx-*` CSS.
6. Run `npm run build`.
7. Manually test in both workbench tab and embedded overlay if available.

## Manual Test Checklist

1. Draw a selection and wait for automatic copy.
2. Confirm the ghost appears once and is pulled toward lower center.
3. Move a parameter slider after the first copy.
4. Confirm the clipboard updates but the VFX does not replay.
5. Press `Copy Again`.
6. Confirm the VFX does not replay if it already played.
7. Simulate first automatic copy failure if possible, then press `Copy Again`.
8. Confirm the VFX plays on the first successful manual retry.
9. Reset selection and draw again in the same workbench session.
10. Confirm the VFX does not replay.
11. Enable reduced motion at OS/browser level.
12. Confirm motion is reduced to a short local fade/pulse.

## Acceptance Criteria

The implementation is done when:

1. the first successful clipboard copy in a workbench session plays the object ghost snatch VFX,
2. failed clipboard writes never play the VFX,
3. stale automatic clipboard requests never play the VFX,
4. later automatic parameter copies do not replay the VFX,
5. the VFX does not block lasso, reset, copy retry, or parameter controls,
6. temporary DOM nodes and blob URLs are cleaned up,
7. reduced-motion users get a non-traveling effect,
8. `npm run build` passes.


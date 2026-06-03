# Workbench Auto Copy Plan

## Goal

After the user selects an object or changes mask parameters, ImageThief should copy the latest transparent PNG to the clipboard automatically.

The user should not need to press `Copy PNG` for the normal path.

Keep the copy button as a retry affordance until automatic copy is proven reliable in both the extension tab and the in-page overlay iframe.

## Current Behavior

The current workbench flow is:

1. The user draws a lasso.
2. `handlePointerUp()` creates `lastSelection`.
3. `processSelection(lastSelection)` creates `maskResult`, `previewCanvas`, and `pngBlob`.
4. The UI enters `preview-ready`.
5. The user presses `Copy PNG`.
6. `copyPng()` writes `pngBlob` to the clipboard with `navigator.clipboard.write(...)`.

Parameter changes currently flow through:

1. `handleParameterInput()`
2. `scheduleParameterReprocess()`
3. a 150ms debounce
4. `processSelection(lastSelection)`
5. a new `pngBlob`
6. manual `Copy PNG`

The right automatic-copy insertion point is after `createPngBlob(...)` succeeds inside `processSelection()`.

## Why Not Just Call `copyPng()`

Calling `copyPng()` directly from `processSelection()` would probably work in simple cases, but it couples automatic copy to button-oriented state behavior.

Problems:

1. `copyPng()` assumes the copy action is user-requested.
2. It sets the main workbench state to `copying` and then `copied`.
3. It reports failure as `Unable to copy PNG`, which is too strong for an automatic attempt when a manual retry remains possible.
4. Rapid parameter changes can create stale async PNG blobs; an older automatic copy must not overwrite a newer result.

The safer implementation is to refactor the clipboard write into a lower-level helper, then use that helper from both automatic copy and manual retry.

## Recommended Design

### Keep Manual Retry

Do not remove the copy button in the first implementation.

Change its role from primary action to retry action:

```text
Before: Copy PNG
After: Copy Again
```

The normal path auto-copies. The button remains useful when:

1. automatic copy fails,
2. embedded iframe clipboard policy behaves differently,
3. the user wants to restore the latest ImageThief result after copying something else,
4. a browser requires a fresh user activation despite extension permissions.

### Add Copy Trigger Types

Introduce an explicit copy reason:

```ts
type CopyTrigger = "auto-selection" | "auto-parameters" | "manual";
```

Use this to tune status messages:

```text
auto-selection:
  "Copied PNG"

auto-parameters:
  "Updated clipboard"

manual:
  "Copied PNG"
```

On automatic failure:

```text
"Auto copy failed. Use Copy Again."
```

On manual failure:

```text
"Unable to copy PNG"
```

### Split Clipboard Write From UI State

Refactor the current `copyPng()` into two layers:

```ts
async function writePngToClipboard(blob: Blob): Promise<void> {
  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": blob
    })
  ]);
}

async function copyCurrentPng(trigger: CopyTrigger): Promise<void> {
  ...
}
```

`copyCurrentPng()` owns UI messages and debug logging. `writePngToClipboard()` only performs the write.

### Track Stale Processing Runs

Add a monotonically increasing run id:

```ts
let selectionProcessRunId = 0;
```

At the start of `processSelection()`:

```ts
const runId = ++selectionProcessRunId;
```

After async work such as `createPngBlob(...)`, ignore stale results:

```ts
if (runId !== selectionProcessRunId) {
  return;
}
```

Also increment `selectionProcessRunId` in `resetSelection()` and at the start of a new lasso drag.

Reason:

Parameter changes are debounced, but PNG creation is async. Without a run id, an older reprocess can finish late and copy an outdated PNG.

### Track Stale Clipboard Writes

Processing-run guards are necessary but not sufficient. Once `navigator.clipboard.write(...)` starts, it cannot be cancelled.

Add a separate clipboard request id:

```ts
let clipboardWriteRequestId = 0;
```

Each automatic copy attempt captures the latest request id:

```ts
const copyRequestId = ++clipboardWriteRequestId;
```

After the write resolves or rejects, update visible status only if the request is still current:

```ts
if (copyRequestId !== clipboardWriteRequestId) {
  return;
}
```

This does not cancel an older browser clipboard write, but it prevents stale UI messages. To reduce the chance of an older write finishing after a newer one, automatic copy requests should be serialized with a small latest-only queue:

```text
if a write is active:
  remember the latest pending blob and trigger
  do not start another write immediately

when the active write finishes:
  if a pending latest blob exists:
    write that latest blob
```

Reason:

Fast slider movement can produce multiple valid PNG blobs in quick succession. The clipboard should converge on the latest preview result, not an intermediate result.

### Keep Automatic Copy Non-Blocking

Manual copy can use the existing `copying` state because it is a direct button action.

Automatic copy should not keep the workbench in `copying` for long-running browser clipboard writes. In the current code, `copying` disables new lasso input and parameter controls. That would make slider tuning feel sticky.

Recommended behavior:

```text
manual copy:
  setState("copying", "Copying PNG...")
  write clipboard
  setState("copied", "Copied PNG")

automatic copy:
  keep the workbench usable
  update status text to "Copying PNG..." or "Updating clipboard..."
  write clipboard through the latest-only queue
  setState("copied", "Copied PNG" / "Updated clipboard") only for the latest result
```

The automatic path may briefly show a copy status message, but it must not leave parameter controls disabled or block a new selection longer than necessary.

### Detect Copy Source

Add a parameter to `processSelection()`:

```ts
async function processSelection(
  selection: ObjectSeedSelection,
  autoCopyReason: "selection" | "parameters"
): Promise<void>
```

Call sites:

```ts
handlePointerUp:
  void processSelection(lastSelection, "selection");

scheduleParameterReprocess:
  void processSelection(lastSelection, "parameters");

resetParameters:
  void processSelection(lastSelection, "parameters");
```

After `pngBlob` is assigned and state is `preview-ready`, call:

```ts
void copyCurrentPng(
  autoCopyReason === "selection" ? "auto-selection" : "auto-parameters"
);
```

The copy should happen after the preview canvas and `pngBlob` are ready, so the visual result and clipboard result match.

## File-Level Plan

### `src/workbench/index.ts`

Implement most of the feature here.

Planned changes:

1. Add `CopyTrigger`.
2. Add `selectionProcessRunId`.
3. Refactor `copyPng()` into `writePngToClipboard()` and `copyCurrentPng(trigger)`.
4. Keep the button handler, but call `copyCurrentPng("manual")`.
5. Update `processSelection()` to accept an auto-copy reason.
6. Trigger automatic copy after `pngBlob = await createPngBlob(...)`.
7. Guard stale processing results with `selectionProcessRunId`.
8. Add latest-only clipboard write tracking.
9. Update status text differently for automatic and manual failure.
10. Ensure parameter controls are not left disabled after automatic copy.

### `workbench.html`

Required first-pass change:

```html
Copy PNG -> Copy Again
```

This keeps the control available without implying that the user must press it every time.

### `src/workbench/style.css`

No required change.

Optional:

Make `Copy Again` slightly less visually dominant after auto-copy is stable.

### `README.md` And `PRD.md`

These currently describe manual-only copy behavior. Once implementation is accepted, update them to say:

```text
The latest PNG is copied automatically after selection or parameter changes.
The copy button remains available as a retry/copy-again action.
```

Do not update product docs before the implementation passes manual clipboard testing.

## State Behavior

Recommended state sequence after selection:

```text
processing-mask
preview-ready
copied
```

Recommended state sequence after parameter change:

```text
status: Adjusting preview...
processing-mask
preview-ready
copied / Updated clipboard
```

Automatic copy should not rely on `copying` as a durable state. The current workbench disables drawing and parameter controls while `state === "copying"`, so automatic copy should keep the UI interactive unless a manual retry is in progress.

Manual copy can keep the existing sequence:

```text
preview-ready / copied
copying
copied
```

If automatic copy fails:

```text
preview-ready
status: Auto copy failed. Use Copy Again.
```

Do not clear `pngBlob` on auto-copy failure. The retry button needs it.

## Clipboard Constraints

The project already has `"clipboardWrite"` in `public/manifest.json`.

Important constraints:

1. The workbench writes PNG data with `navigator.clipboard.write(...)`.
2. Browser clipboard APIs can reject writes with `NotAllowedError`.
3. Embedded iframe behavior must be tested because the workbench can now run inside a page overlay iframe.
4. The overlay iframe already sets `allow="clipboard-write"`, which should remain.
5. If automatic copy fails in the overlay but manual retry succeeds, keep the retry button.
6. If both automatic and manual copy fail in the overlay, add a later fallback to open the same workbench session in a new tab.

References:

1. Chrome extension permissions list: https://developer.chrome.com/docs/extensions/reference/permissions-list
2. MDN WebExtensions clipboard guidance: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Interact_with_the_clipboard
3. MDN `Clipboard.write()`: https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write

## Implementation Phases

### Phase 1: Refactor Without Behavior Change

1. Extract `writePngToClipboard(blob)`.
2. Replace the existing button handler with `copyCurrentPng("manual")`.
3. Confirm manual copy still works.

Acceptance:

The app still behaves exactly as before.

### Phase 2: Auto Copy After Selection

1. Add `selectionProcessRunId`.
2. Add latest-only clipboard write tracking.
3. Update `processSelection(selection, "selection")`.
4. Auto-copy when the first valid `pngBlob` is produced.
5. Keep `Copy Again` enabled after success.

Acceptance:

Drawing a valid lasso copies the PNG without pressing the button.

### Phase 3: Auto Copy After Parameter Changes

1. Pass `"parameters"` from debounced parameter reprocessing.
2. Copy only the latest completed processing run.
3. Keep the 150ms debounce.

Acceptance:

Moving a slider updates the preview and then updates the clipboard with the latest PNG.

### Phase 4: Failure Handling

1. Automatic copy failure leaves preview intact.
2. Retry button stays enabled.
3. Manual retry has the existing stronger failure message.
4. Debug output distinguishes automatic and manual copy.

Acceptance:

Clipboard failure does not destroy the selection or force the user to redraw.

### Phase 5: Product Text Update

After extension-tab and overlay-iframe manual tests pass:

1. Update README.
2. Update PRD manual-only copy statements.
3. Update any manual test checklist entries from `Copy PNG success` to `Auto copy success` plus `Copy Again retry`.

## Manual Test Checklist

Run these in both the extension tab fallback and the overlay iframe path.

1. Draw a normal lasso: clipboard receives a PNG automatically.
2. Paste into an image-capable target: pasted image matches preview.
3. Change sensitivity: clipboard updates after preview updates.
4. Drag a slider quickly: final clipboard content matches the final slider value, not an older intermediate result.
5. Reset selection: no stale auto-copy happens afterward.
6. Draw a too-small lasso: no clipboard write is attempted.
7. Trigger low-confidence mask: no clipboard write is attempted.
8. Press `Copy Again`: latest PNG is copied.
9. Auto-copy failure: preview remains and retry button remains enabled.
10. Overlay iframe: automatic copy works.
11. Overlay iframe: manual retry works.
12. New-tab fallback: automatic copy works.

## Recommendation

Proceed with automatic copy, but keep the copy button as `Copy Again`.

This matches the desired no-extra-click workflow while preserving a practical recovery path for clipboard policy failures.

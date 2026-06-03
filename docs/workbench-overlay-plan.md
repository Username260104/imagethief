# Workbench Overlay Plan

## Question

Can the workbench open as an overlay in the same page where the source image was selected, instead of opening a new tab?

Yes. The safest path is to keep `workbench.html` as the workbench app and load it inside an iframe that the content script injects into the current page.

This keeps most of the current workbench code reusable while changing the launch surface from a new extension tab to an in-page modal overlay.

## Current Flow

The current flow is:

1. The user starts ImageThief from the action button or shortcut.
2. `background.ts` injects `content.js` into the active tab.
3. `content.ts` lets the user pick an image candidate from the page.
4. `content.ts` sends `IMAGE_THIEF_CANDIDATE_SELECTED` to the background service worker.
5. `background.ts` creates a `WorkbenchSession` in `chrome.storage.session`.
6. `background.ts` creates a URL like `workbench.html?sessionId=...`.
7. `background.ts` opens that URL with `chrome.tabs.create(...)`.
8. `workbench.html` loads the session and fetches the original image.

The specific new-tab boundary is in `src/background.ts`, where `openWorkbench()` calls `chrome.tabs.create(...)`.

## Target Flow

The target flow should be:

1. The user selects an image exactly as before.
2. `background.ts` creates the same `WorkbenchSession` as before.
3. `background.ts` builds the same workbench URL.
4. Instead of opening a new tab, `background.ts` sends the selected tab a message:

```text
IMAGE_THIEF_OPEN_WORKBENCH_OVERLAY
```

5. `content.ts` receives that message and injects a fixed-position overlay into the page.
6. The overlay contains an iframe whose `src` is the extension workbench URL.
7. `workbench.html` runs inside the iframe and continues to load the session from `chrome.storage.session`.
8. The workbench close button posts a close message to the parent page.
9. `content.ts` removes the overlay.

The fallback remains the current new-tab behavior when the overlay cannot be opened.

## Recommended Architecture

Use an iframe overlay, not a direct DOM port of the workbench.

Reasons:

1. The existing workbench HTML, CSS, canvas code, and parameter panel can be reused.
2. Page CSS cannot accidentally restyle the workbench.
3. Workbench CSS cannot leak into the host page.
4. The workbench remains an extension page, so `chrome.storage.session` and extension-origin image fetch behavior should stay close to the current implementation.
5. The content script only owns overlay lifecycle, not the workbench application logic.

The content script should create something shaped like:

```text
fixed overlay host
  shadow root
    backdrop
    iframe src="chrome-extension://.../workbench.html?sessionId=..."
```

The shadow root is useful for insulating the overlay shell from page styles. The iframe is still the main isolation boundary for the workbench.

## File-Level Plan

### `public/manifest.json`

Add `web_accessible_resources` for the workbench page and build outputs.

Expected resources:

```json
[
  {
    "resources": [
      "workbench.html",
      "workbench.js",
      "assets/*",
      "chunks/*"
    ],
    "matches": ["http://*/*", "https://*/*"]
  }
]
```

Reason:

The host page must be allowed to load the extension workbench URL in an iframe. Without this, Chrome can block the iframe load.

Security note:

Exposing `workbench.html` as a web-accessible resource is acceptable if the page requires a valid `sessionId` and fails closed when no session exists. A future hardening step can add an unguessable overlay token to the session and URL.

### `src/background.ts`

Change `openWorkbench()` so it prefers overlay launch:

1. Create the session as it does now.
2. Build the workbench URL as it does now.
3. If `openerTabId` exists, send that tab:

```ts
{
  type: "IMAGE_THIEF_OPEN_WORKBENCH_OVERLAY",
  url
}
```

4. If sending the message fails, or there is no opener tab, fall back to `chrome.tabs.create(...)`.

The fallback is important for pages where content scripts cannot run or where iframe embedding fails.

### `src/content.ts`

Extend the controller with overlay lifecycle methods:

```text
openWorkbenchOverlay(url)
closeWorkbenchOverlay()
```

Responsibilities:

1. Stop image selection mode before opening the overlay.
2. Remove any existing ImageThief overlay before creating a new one.
3. Create a full-viewport fixed overlay with a high z-index.
4. Insert an iframe pointed at the workbench URL.
5. Set iframe attributes:

```text
title="ImageThief Workbench"
allow="clipboard-write"
```

6. Listen for close messages from the iframe.
7. Validate that close messages come from the extension origin.
8. Remove the overlay and restore focus when closed.

The content script should keep the overlay shell minimal. The workbench UI should stay in `workbench.html`.

### `src/workbench/index.ts`

Change the close button behavior.

Current behavior:

```ts
window.close();
```

Planned behavior:

```text
if embedded in an iframe:
  post close request to parent
else:
  window.close()
```

The close message does not need to include sensitive data. The content script can validate `event.origin` before acting.

Optional UI improvement:

When the workbench is embedded, the button label can be `Close` instead of `Back`. A query parameter like `embedded=1` can drive that label.

## Fallback Behavior

Keep the new-tab workbench as a fallback.

Fallback triggers:

1. `openerTabId` is missing.
2. `chrome.tabs.sendMessage(...)` fails.
3. The content script cannot inject into the page.
4. The iframe does not finish loading within a short timeout.
5. A restrictive page policy blocks the iframe.
6. Clipboard behavior fails in an embedded frame and cannot be fixed with `allow="clipboard-write"`.

Fallback should preserve the existing user-facing behavior rather than failing silently.

## UX Decisions

Recommended defaults:

1. The overlay should cover the viewport.
2. The workbench itself should fill the iframe.
3. The page behind the overlay should not be interactive.
4. The existing workbench toolbar should remain visible.
5. The close button should remove the overlay and return the user to the original page.
6. A second image selection should replace any existing overlay instead of stacking overlays.

Open question:

Should `Escape` close the overlay when there is no active lasso or preview to reset? The current workbench already uses `Escape` for cancel/reset behavior, so this should be decided deliberately.

## Risks And Constraints

### Web-Accessible Resource Exposure

The workbench page will become loadable by regular web pages. It should not expose useful behavior without a valid session.

Mitigation:

1. Keep the existing session lookup.
2. Fail closed when `sessionId` is absent or invalid.
3. Optionally add a one-time token stored in the session.
4. Optionally expire old sessions based on `createdAt`.

### Clipboard In Iframe

`navigator.clipboard.write(...)` may be affected by iframe permission policy.

Mitigation:

1. Set `allow="clipboard-write"` on the iframe.
2. Keep manual testing for `Copy PNG`.
3. Fall back to opening the workbench in a new tab if embedded clipboard write is blocked.

### Page CSP Or Frame Policy

Some pages may restrict injected frames or behave unpredictably around extension iframes.

Mitigation:

Keep new-tab fallback and test on pages with strict CSP.

### Focus And Keyboard Handling

The iframe should receive focus when opened. The previous focused page element should be restored when the overlay closes.

The workbench's internal keyboard behavior should stay authoritative while the iframe is focused.

### Host Page Interference

Pages with extreme z-index values, fullscreen layouts, or aggressive DOM mutation can interfere with injected UI.

Mitigation:

1. Use a very high z-index.
2. Use a shadow root for the overlay shell.
3. Keep fallback to the extension tab.

## Implementation Phases

### Phase 1: Overlay Shell

1. Add `web_accessible_resources`.
2. Add an overlay-open message type.
3. Inject iframe overlay from `content.ts`.
4. Keep new-tab fallback.
5. Make the workbench close button close the overlay when embedded.

Acceptance:

Selecting an image opens the workbench in the same tab as an overlay.

### Phase 2: Robust Close And Fallback

1. Validate postMessage origin.
2. Add iframe load timeout.
3. Fall back to new tab if overlay load fails.
4. Restore focus after close.
5. Prevent duplicate overlays.

Acceptance:

Overlay open, close, replacement, and fallback are predictable.

### Phase 3: UX Polish

1. Use `Close` label when embedded.
2. Decide `Escape` behavior.
3. Consider a small top-level close affordance outside the iframe only if iframe load fails.
4. Tune overlay backdrop and mobile sizing if full-viewport feels too heavy.

Acceptance:

The overlay feels native to the workflow and does not trap the user.

## Manual Test Checklist

Use `test-pages/manual.html` and at least one real web page.

Test cases:

1. `<img>` source image opens workbench overlay in the same tab.
2. CSS `background-image` source opens workbench overlay in the same tab.
3. Workbench loads the original image.
4. Lasso selection still works.
5. Parameter controls still work.
6. `Copy PNG` still writes an image to the clipboard.
7. `Back` or `Close` removes the overlay.
8. Starting ImageThief again after closing still works.
9. Starting ImageThief while an overlay already exists replaces or closes the old overlay cleanly.
10. Browser zoom does not break overlay sizing.
11. Mobile-sized viewport does not create clipped toolbar controls.
12. Overlay fallback opens a new tab when iframe launch fails.

## Recommendation

Proceed with iframe overlay as the primary implementation path, while preserving the current new-tab workbench as fallback.

This is a contained change: the workbench application remains mostly intact, and the launch behavior moves from `chrome.tabs.create(...)` to a content-script-managed overlay.

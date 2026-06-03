type SourceImageCandidate = {
  kind: "html-img" | "css-background";
  pageUrl: string;
  imageUrl: string;
  currentSrc?: string;
  src?: string;
  elementRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  naturalWidth?: number;
  naturalHeight?: number;
  css?: {
    backgroundSize?: string;
    backgroundPosition?: string;
    backgroundRepeat?: string;
  };
};

type CandidateWithElement = {
  candidate: SourceImageCandidate;
  element: Element;
};

type OpenWorkbenchOverlayMessage = {
  type: "IMAGE_THIEF_OPEN_WORKBENCH_OVERLAY";
  url: string;
};

type ImageThiefController = {
  start(): void;
  stop(): void;
  openWorkbenchOverlay(url: string): Promise<boolean>;
  closeWorkbenchOverlay(): void;
};

type ImageThiefWindow = Window & {
  __imageThiefContent?: ImageThiefController;
};

const win = window as ImageThiefWindow;
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL("")).origin;
const WORKBENCH_OVERLAY_LOAD_TIMEOUT_MS = 3000;
const WORKBENCH_CLOSE_MESSAGE_TYPE = "IMAGE_THIEF_CLOSE_WORKBENCH_OVERLAY";

if (win.__imageThiefContent) {
  win.__imageThiefContent.start();
} else {
  const controller = createController();
  win.__imageThiefContent = controller;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isStartSelectionMessage(message)) {
      controller.start();
      sendResponse({ ok: true });
      return false;
    }

    if (isOpenWorkbenchOverlayMessage(message)) {
      void controller.openWorkbenchOverlay(message.url).then((ok) => {
        sendResponse({ ok });
      });
      return true;
    }

    return false;
  });
  controller.start();
}

function createController(): ImageThiefController {
  let active = false;
  let current: CandidateWithElement | null = null;
  let overlayHost: HTMLElement | null = null;
  let overlayFrame: HTMLIFrameElement | null = null;
  let lastFocusedElement: HTMLElement | null = null;
  let overlayLoadTimer = 0;

  const highlight = document.createElement("div");
  highlight.style.cssText = [
    "position:fixed",
    "display:none",
    "pointer-events:none",
    "box-sizing:border-box",
    "border:2px solid #6b6b6b",
    "background:rgba(0,0,0,0.10)",
    "box-shadow:0 0 0 99999px rgba(0,0,0,0.08)",
    "z-index:2147483647"
  ].join(";");

  const label = document.createElement("div");
  label.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:16px",
    "transform:translateX(-50%)",
    "padding:8px 12px",
    "border-radius:6px",
    "background:#111827",
    "color:white",
    "font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "box-shadow:0 8px 30px rgba(0,0,0,0.22)",
    "z-index:2147483647",
    "pointer-events:none"
  ].join(";");
  label.textContent = "Choose a source image. Press Esc to cancel.";

  const toast = document.createElement("div");
  toast.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:24px",
    "display:none",
    "transform:translateX(-50%)",
    "padding:7px 10px",
    "border-radius:6px",
    "background:#2f2f2f",
    "color:white",
    "font:12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "z-index:2147483647",
    "pointer-events:none"
  ].join(";");

  let toastTimer = 0;

  window.addEventListener("message", handleWorkbenchMessage);

  return {
    start,
    stop,
    openWorkbenchOverlay,
    closeWorkbenchOverlay
  };

  function start(): void {
    if (active) {
      return;
    }

    closeWorkbenchOverlay();
    active = true;
    current = null;
    document.documentElement.append(highlight, label, toast);
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("click", handleClick, true);
    window.addEventListener("keydown", handleKeydown, true);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize, true);
  }

  function stop(): void {
    if (!active) {
      return;
    }

    active = false;
    current = null;
    window.clearTimeout(toastTimer);
    highlight.remove();
    label.remove();
    toast.remove();
    window.removeEventListener("pointermove", handlePointerMove, true);
    window.removeEventListener("click", handleClick, true);
    window.removeEventListener("keydown", handleKeydown, true);
    window.removeEventListener("scroll", handleScrollOrResize, true);
    window.removeEventListener("resize", handleScrollOrResize, true);
  }

  function openWorkbenchOverlay(url: string): Promise<boolean> {
    stop();
    closeWorkbenchOverlay();

    if (!isExtensionWorkbenchUrl(url)) {
      return Promise.resolve(false);
    }

    const activeElement = document.activeElement;
    lastFocusedElement = activeElement instanceof HTMLElement ? activeElement : null;

    const host = document.createElement("div");
    host.style.cssText = [
      "position:fixed",
      "inset:0",
      "width:100vw",
      "height:100vh",
      "z-index:2147483647",
      "background:rgba(0,0,0,0.6)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:24px",
      "pointer-events:auto"
    ].join(";");

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = [
      ":host{all:initial}",
      "iframe{display:block;width:min(1280px,calc(100vw - 48px));height:min(900px,calc(100vh - 48px));border:0;border-radius:8px;background:#f2f2f2;box-shadow:0 24px 80px rgba(0,0,0,0.34);color-scheme:normal}",
      "@media (max-width:640px){iframe{width:calc(100vw - 16px);height:calc(100vh - 16px);border-radius:6px}}"
    ].join("");

    const frame = document.createElement("iframe");
    frame.src = url;
    frame.title = "ImageThief Workbench";
    frame.allow = "clipboard-write";
    shadow.append(style, frame);

    overlayHost = host;
    overlayFrame = frame;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok: boolean): void => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(overlayLoadTimer);
        overlayLoadTimer = 0;
        frame.removeEventListener("load", handleLoad);
        frame.removeEventListener("error", handleError);

        if (!ok) {
          closeWorkbenchOverlay();
        } else {
          requestAnimationFrame(() => frame.focus());
        }

        resolve(ok);
      };
      const handleLoad = (): void => settle(true);
      const handleError = (): void => settle(false);

      frame.addEventListener("load", handleLoad, { once: true });
      frame.addEventListener("error", handleError, { once: true });
      overlayLoadTimer = window.setTimeout(() => settle(false), WORKBENCH_OVERLAY_LOAD_TIMEOUT_MS);
      document.documentElement.append(host);
    });
  }

  function closeWorkbenchOverlay(): void {
    window.clearTimeout(overlayLoadTimer);
    overlayLoadTimer = 0;
    overlayHost?.remove();
    overlayHost = null;
    overlayFrame = null;

    if (lastFocusedElement?.isConnected) {
      lastFocusedElement.focus({ preventScroll: true });
    }
    lastFocusedElement = null;
  }

  function handleWorkbenchMessage(event: MessageEvent): void {
    if (!overlayFrame || event.source !== overlayFrame.contentWindow || event.origin !== EXTENSION_ORIGIN) {
      return;
    }

    if (isWorkbenchCloseMessage(event.data)) {
      closeWorkbenchOverlay();
    }
  }

  function handlePointerMove(event: PointerEvent): void {
    if (!active) {
      return;
    }

    current = findCandidateFromPoint(event.clientX, event.clientY);
    drawHighlight(current?.candidate.elementRect ?? null);
  }

  function handleClick(event: MouseEvent): void {
    if (!active) {
      return;
    }

    const chosen = findCandidateFromPoint(event.clientX, event.clientY) ?? current;
    if (!chosen) {
      event.preventDefault();
      event.stopPropagation();
      showToast("No image selected");
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    stop();
    void chrome.runtime.sendMessage({
      type: "IMAGE_THIEF_CANDIDATE_SELECTED",
      candidate: chosen.candidate
    });
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!active || event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    stop();
  }

  function handleScrollOrResize(): void {
    current = null;
    drawHighlight(null);
  }

  function drawHighlight(rect: SourceImageCandidate["elementRect"] | null): void {
    if (!rect) {
      highlight.style.display = "none";
      return;
    }

    highlight.style.display = "block";
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
  }

  function showToast(message: string): void {
    toast.textContent = message;
    toast.style.display = "block";
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.style.display = "none";
    }, 1200);
  }
}

function findCandidateFromPoint(clientX: number, clientY: number): CandidateWithElement | null {
  const element = document.elementFromPoint(clientX, clientY);
  if (!element) {
    return null;
  }

  for (let current: Element | null = element; current; current = current.parentElement) {
    const imageCandidate = candidateFromImageElement(current);
    if (imageCandidate) {
      return imageCandidate;
    }

    const backgroundCandidate = candidateFromBackgroundElement(current);
    if (backgroundCandidate) {
      return backgroundCandidate;
    }

    if (current === document.documentElement) {
      break;
    }
  }

  return null;
}

function candidateFromImageElement(element: Element): CandidateWithElement | null {
  if (!(element instanceof HTMLImageElement)) {
    return null;
  }

  const imageUrl = normalizeCandidateUrl(element.currentSrc || element.src);
  if (!imageUrl) {
    return null;
  }

  const rect = candidateRect(element);
  if (!rect) {
    return null;
  }

  return {
    element,
    candidate: {
      kind: "html-img",
      pageUrl: location.href,
      imageUrl,
      currentSrc: element.currentSrc || undefined,
      src: element.src || undefined,
      elementRect: rect,
      naturalWidth: element.naturalWidth || undefined,
      naturalHeight: element.naturalHeight || undefined
    }
  };
}

function candidateFromBackgroundElement(element: Element): CandidateWithElement | null {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const style = getComputedStyle(element);
  const rawUrl = parseSingleBackgroundUrl(style.backgroundImage);
  if (!rawUrl) {
    return null;
  }

  const imageUrl = normalizeCandidateUrl(rawUrl);
  if (!imageUrl) {
    return null;
  }

  const rect = candidateRect(element);
  if (!rect) {
    return null;
  }

  return {
    element,
    candidate: {
      kind: "css-background",
      pageUrl: location.href,
      imageUrl,
      elementRect: rect,
      css: {
        backgroundSize: style.backgroundSize,
        backgroundPosition: style.backgroundPosition,
        backgroundRepeat: style.backgroundRepeat
      }
    }
  };
}

function candidateRect(element: Element): SourceImageCandidate["elementRect"] | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  if (rect.right < 0 || rect.bottom < 0 || rect.left > innerWidth || rect.top > innerHeight) {
    return null;
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function normalizeCandidateUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("data:image/svg") && trimmed.length > 50_000) {
    return null;
  }

  try {
    return new URL(trimmed, document.baseURI).href;
  } catch {
    return null;
  }
}

function parseSingleBackgroundUrl(backgroundImage: string): string | null {
  const value = backgroundImage.trim();
  if (!value || value === "none" || value.includes("gradient(")) {
    return null;
  }

  const matches = value.match(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g);
  if (!matches || matches.length !== 1 || matches[0] !== value) {
    return null;
  }

  const inner = value.slice(4, -1).trim();
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    return inner.slice(1, -1);
  }

  return inner;
}

function isStartSelectionMessage(message: unknown): boolean {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "IMAGE_THIEF_START_SELECTION"
  );
}

function isOpenWorkbenchOverlayMessage(message: unknown): message is OpenWorkbenchOverlayMessage {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "IMAGE_THIEF_OPEN_WORKBENCH_OVERLAY" &&
    typeof (message as { url?: unknown }).url === "string"
  );
}

function isWorkbenchCloseMessage(message: unknown): boolean {
  return (
    Boolean(message) &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === WORKBENCH_CLOSE_MESSAGE_TYPE
  );
}

function isExtensionWorkbenchUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === EXTENSION_ORIGIN && url.pathname.endsWith("/workbench.html");
  } catch {
    return false;
  }
}

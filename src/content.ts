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

type ImageThiefWindow = Window & {
  __imageThiefContent?: {
    start(): void;
    stop(): void;
  };
};

const win = window as ImageThiefWindow;

if (win.__imageThiefContent) {
  win.__imageThiefContent.start();
} else {
  const controller = createController();
  win.__imageThiefContent = controller;
  chrome.runtime.onMessage.addListener((message) => {
    if (isStartSelectionMessage(message)) {
      controller.start();
    }
  });
  controller.start();
}

function createController(): { start(): void; stop(): void } {
  let active = false;
  let current: CandidateWithElement | null = null;

  const highlight = document.createElement("div");
  highlight.style.cssText = [
    "position:fixed",
    "display:none",
    "pointer-events:none",
    "box-sizing:border-box",
    "border:2px solid #f97316",
    "background:rgba(249,115,22,0.12)",
    "box-shadow:0 0 0 99999px rgba(17,24,39,0.08)",
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
    "background:#7f1d1d",
    "color:white",
    "font:12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "z-index:2147483647",
    "pointer-events:none"
  ].join(";");

  let toastTimer = 0;

  return {
    start,
    stop
  };

  function start(): void {
    if (active) {
      return;
    }

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

import {
  DEBUG,
  MAX_DECODED_PIXELS,
  MIN_OBJECT_SELECTION_SIZE,
  SESSION_STORAGE_PREFIX
} from "../shared/constants";
import type {
  DisplayTransform,
  ImagePixelPoint,
  ImagePixelRect,
  ObjectSeedSelection,
  WorkbenchSession,
  WorkbenchState
} from "../shared/types";
import { createRoughMask, type MaskResult } from "./segmentation";
import "./style.css";

type DecodedImage = ImageBitmap | HTMLImageElement;

type DragState = {
  pointerId: number;
  start: ImagePixelPoint;
  current: ImagePixelPoint;
};

const canvas = requiredElement<HTMLCanvasElement>("#workbench-canvas");
const statusElement = requiredElement<HTMLElement>("#status");
const metaElement = requiredElement<HTMLElement>("#image-meta");
const debugElement = requiredElement<HTMLElement>("#debug-readout");
const messageElement = requiredElement<HTMLElement>("#message");
const resetButton = requiredElement<HTMLButtonElement>("#reset-button");
const copyButton = requiredElement<HTMLButtonElement>("#copy-button");
const closeButton = requiredElement<HTMLButtonElement>("#close-button");
const context = requiredCanvasContext(canvas);

let state: WorkbenchState = "loading-source";
let session: WorkbenchSession | null = null;
let sourceCanvas: HTMLCanvasElement | null = null;
let displayTransform: DisplayTransform = { scale: 1, offsetX: 0, offsetY: 0 };
let dragState: DragState | null = null;
let lastSelection: ObjectSeedSelection | null = null;
let maskResult: MaskResult | null = null;
let previewCanvas: HTMLCanvasElement | null = null;
let pngBlob: Blob | null = null;

const resizeObserver = new ResizeObserver(() => {
  resizeCanvas();
  draw();
});

resizeObserver.observe(canvas);
canvas.addEventListener("pointerdown", handlePointerDown);
canvas.addEventListener("pointermove", handlePointerMove);
canvas.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener("pointercancel", cancelDrag);
window.addEventListener("keydown", handleKeydown);
resetButton.addEventListener("click", resetSelection);
copyButton.addEventListener("click", () => {
  void copyPng();
});
closeButton.addEventListener("click", () => {
  window.close();
});

void initialize();

async function initialize(): Promise<void> {
  try {
    setState("loading-source", "Loading source...");
    resizeCanvas();
    session = await loadSession();
    metaElement.textContent = hostLabel(session.candidate.imageUrl);
    await loadSourceImage(session.candidate.imageUrl);
    setState("ready", "Drag around an object.");
    draw();
  } catch (error) {
    console.debug("ImageThief load failure", error);
    fail(error instanceof Error ? error.message : "Original image unavailable");
  }
}

async function loadSession(): Promise<WorkbenchSession> {
  const sessionId = new URLSearchParams(location.search).get("sessionId");
  if (!sessionId) {
    throw new Error("No image selected");
  }

  const key = `${SESSION_STORAGE_PREFIX}${sessionId}`;
  const stored = await chrome.storage.session.get(key);
  const loaded = stored[key] as WorkbenchSession | undefined;
  if (!loaded?.candidate?.imageUrl) {
    throw new Error("No image selected");
  }

  return loaded;
}

async function loadSourceImage(imageUrl: string): Promise<void> {
  const response = await fetch(imageUrl, {
    credentials: "include"
  });

  if (!response.ok) {
    debug("fetch status", response.status);
    throw new Error("Original image unavailable");
  }

  const contentType = response.headers.get("content-type") ?? "";
  debug("content-type", contentType);
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("Original image unavailable");
  }

  const blob = await response.blob();
  const decoded = await decodeImage(blob);
  const width = decoded.width;
  const height = decoded.height;

  debug("decoded size", `${width}x${height}`);
  if (width * height > MAX_DECODED_PIXELS) {
    throw new Error("Image is too large");
  }

  const nextCanvas = document.createElement("canvas");
  nextCanvas.width = width;
  nextCanvas.height = height;
  const nextContext = nextCanvas.getContext("2d", { willReadFrequently: true });
  if (!nextContext) {
    throw new Error("Image decode failed");
  }

  nextContext.drawImage(decoded, 0, 0);
  sourceCanvas = nextCanvas;
  metaElement.textContent = `${width} x ${height} px`;
}

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = objectUrl;
      await image.decode();
      return image;
    } catch {
      throw new Error("Image decode failed");
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

function resizeCanvas(): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function draw(): void {
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = "#ded8ce";
  context.fillRect(0, 0, cssWidth, cssHeight);

  if (!sourceCanvas) {
    return;
  }

  displayTransform = computeDisplayTransform(cssWidth, cssHeight, sourceCanvas.width, sourceCanvas.height);
  drawImageBackdrop(sourceCanvas.width, sourceCanvas.height);
  context.imageSmoothingEnabled = true;
  context.drawImage(
    sourceCanvas,
    displayTransform.offsetX,
    displayTransform.offsetY,
    sourceCanvas.width * displayTransform.scale,
    sourceCanvas.height * displayTransform.scale
  );

  if (previewCanvas && maskResult) {
    context.drawImage(
      previewCanvas,
      displayTransform.offsetX + maskResult.workArea.x * displayTransform.scale,
      displayTransform.offsetY + maskResult.workArea.y * displayTransform.scale,
      maskResult.workArea.width * displayTransform.scale,
      maskResult.workArea.height * displayTransform.scale
    );
  }

  if (dragState) {
    drawSelectionRect(rectFromPoints(dragState.start, dragState.current), "#f97316", "rgba(249,115,22,0.18)");
  } else if (lastSelection) {
    drawSelectionRect(lastSelection.bounds, "#1f7a8c", "rgba(31,122,140,0.12)");
  }
}

function computeDisplayTransform(
  canvasWidth: number,
  canvasHeight: number,
  imageWidth: number,
  imageHeight: number
): DisplayTransform {
  const inset = 28;
  const availableWidth = Math.max(1, canvasWidth - inset * 2);
  const availableHeight = Math.max(1, canvasHeight - inset * 2);
  const scale = Math.min(availableWidth / imageWidth, availableHeight / imageHeight, 1);
  return {
    scale,
    offsetX: (canvasWidth - imageWidth * scale) / 2,
    offsetY: (canvasHeight - imageHeight * scale) / 2
  };
}

function drawImageBackdrop(imageWidth: number, imageHeight: number): void {
  const x = displayTransform.offsetX;
  const y = displayTransform.offsetY;
  const width = imageWidth * displayTransform.scale;
  const height = imageHeight * displayTransform.scale;
  const tile = 14;

  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  for (let row = 0; row < height / tile + 1; row += 1) {
    for (let col = 0; col < width / tile + 1; col += 1) {
      context.fillStyle = (row + col) % 2 === 0 ? "#f7f4ed" : "#e6e0d6";
      context.fillRect(x + col * tile, y + row * tile, tile, tile);
    }
  }
  context.restore();
}

function drawSelectionRect(rect: ImagePixelRect, stroke: string, fill: string): void {
  const x = displayTransform.offsetX + rect.x * displayTransform.scale;
  const y = displayTransform.offsetY + rect.y * displayTransform.scale;
  const width = rect.width * displayTransform.scale;
  const height = rect.height * displayTransform.scale;

  context.save();
  context.fillStyle = fill;
  context.strokeStyle = stroke;
  context.lineWidth = 2;
  context.setLineDash([6, 5]);
  context.fillRect(x, y, width, height);
  context.strokeRect(x, y, width, height);
  context.restore();
}

function handlePointerDown(event: PointerEvent): void {
  if (!sourceCanvas || state === "loading-source" || state === "processing-mask" || state === "copying" || state === "failed") {
    return;
  }

  const point = displayPointToImagePoint(event.clientX, event.clientY);
  if (!point) {
    return;
  }

  canvas.setPointerCapture(event.pointerId);
  dragState = {
    pointerId: event.pointerId,
    start: point,
    current: point
  };
  pngBlob = null;
  maskResult = null;
  previewCanvas = null;
  setState("selecting-object", "Selecting object...");
  draw();
}

function handlePointerMove(event: PointerEvent): void {
  if (!dragState) {
    return;
  }

  const point = displayPointToImagePoint(event.clientX, event.clientY);
  if (!point) {
    return;
  }

  dragState.current = point;
  draw();
}

function handlePointerUp(event: PointerEvent): void {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  const selection = rectFromPoints(dragState.start, dragState.current);
  canvas.releasePointerCapture(event.pointerId);
  dragState = null;

  if (selection.width < MIN_OBJECT_SELECTION_SIZE || selection.height < MIN_OBJECT_SELECTION_SIZE) {
    lastSelection = null;
    setState("ready", "Selection is too small");
    draw();
    return;
  }

  lastSelection = {
    kind: "rect",
    bounds: selection
  };
  void processSelection(lastSelection);
}

function cancelDrag(): void {
  dragState = null;
  setState(sourceCanvas ? "ready" : "loading-source", sourceCanvas ? "Drag around an object." : "Loading source...");
  draw();
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") {
    return;
  }

  if (dragState) {
    event.preventDefault();
    cancelDrag();
    return;
  }

  if (maskResult || lastSelection) {
    event.preventDefault();
    resetSelection();
  }
}

async function processSelection(selection: ObjectSeedSelection): Promise<void> {
  if (!sourceCanvas) {
    return;
  }

  try {
    setState("processing-mask", "Creating rough outline...");
    draw();
    await nextFrame();
    maskResult = createRoughMask(sourceCanvas, selection);
    previewCanvas = createPreviewCanvas(maskResult);
    pngBlob = await createPngBlob(sourceCanvas, maskResult);
    setState("preview-ready", maskResult.usedEmergency ? "Preview ready (rough fallback)" : "Preview ready");
    debug("mask foreground ratio", maskResult.foregroundRatio.toFixed(3));
    debug("output bounding box", maskResult.outputBounds);
    debug("output PNG size", pngBlob.size);
    draw();
  } catch (error) {
    console.debug("ImageThief PNG failure", error);
    fail("Unable to create PNG");
  }
}

function resetSelection(): void {
  dragState = null;
  lastSelection = null;
  maskResult = null;
  previewCanvas = null;
  pngBlob = null;
  setState(sourceCanvas ? "ready" : "loading-source", sourceCanvas ? "Drag around an object." : "Loading source...");
  draw();
}

async function copyPng(): Promise<void> {
  if (!pngBlob || !maskResult) {
    setState("preview-ready", "Unable to create PNG");
    return;
  }

  try {
    setState("copying", "Copying PNG...");
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": pngBlob
      })
    ]);
    setState("copied", "Copied PNG");
    debug("clipboard success", true);
  } catch (error) {
    console.debug("ImageThief clipboard failure", error);
    setState("preview-ready", "Unable to copy PNG");
    debug("clipboard success", false);
  }
}

function createPreviewCanvas(result: MaskResult): HTMLCanvasElement {
  const preview = document.createElement("canvas");
  preview.width = result.width;
  preview.height = result.height;
  const previewContext = preview.getContext("2d");
  if (!previewContext) {
    return preview;
  }

  const imageData = previewContext.createImageData(result.width, result.height);
  for (let y = 0; y < result.height; y += 1) {
    for (let x = 0; x < result.width; x += 1) {
      const maskIndex = y * result.width + x;
      const alpha = result.mask[maskIndex];
      if (alpha === 0) {
        continue;
      }

      const index = maskIndex * 4;
      const edge = isMaskEdge(result.mask, result.width, result.height, x, y);
      if (edge) {
        imageData.data[index] = 249;
        imageData.data[index + 1] = 115;
        imageData.data[index + 2] = 22;
        imageData.data[index + 3] = 235;
      } else {
        imageData.data[index] = 31;
        imageData.data[index + 1] = 122;
        imageData.data[index + 2] = 140;
        imageData.data[index + 3] = 82;
      }
    }
  }

  previewContext.putImageData(imageData, 0, 0);
  return preview;
}

async function createPngBlob(source: HTMLCanvasElement, result: MaskResult): Promise<Blob> {
  const output = document.createElement("canvas");
  output.width = result.outputBounds.width;
  output.height = result.outputBounds.height;
  const outputContext = output.getContext("2d", { willReadFrequently: true });
  if (!outputContext) {
    throw new Error("Unable to create PNG");
  }

  outputContext.drawImage(
    source,
    result.outputBounds.x,
    result.outputBounds.y,
    result.outputBounds.width,
    result.outputBounds.height,
    0,
    0,
    result.outputBounds.width,
    result.outputBounds.height
  );

  const outputImage = outputContext.getImageData(0, 0, output.width, output.height);
  for (let y = 0; y < output.height; y += 1) {
    const imageY = result.outputBounds.y + y;
    for (let x = 0; x < output.width; x += 1) {
      const imageX = result.outputBounds.x + x;
      const outputIndex = (y * output.width + x) * 4;
      outputImage.data[outputIndex + 3] = alphaAt(result, imageX, imageY);
    }
  }

  outputContext.putImageData(outputImage, 0, 0);
  return new Promise((resolve, reject) => {
    output.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Unable to create PNG"));
      }
    }, "image/png");
  });
}

function alphaAt(result: MaskResult, imageX: number, imageY: number): number {
  const localX = imageX - result.workArea.x;
  const localY = imageY - result.workArea.y;
  if (localX < 0 || localY < 0 || localX >= result.width || localY >= result.height) {
    return 0;
  }
  return result.mask[localY * result.width + localX];
}

function isMaskEdge(mask: Uint8ClampedArray, width: number, height: number, x: number, y: number): boolean {
  if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
    return true;
  }

  return (
    mask[y * width + x - 1] === 0 ||
    mask[y * width + x + 1] === 0 ||
    mask[(y - 1) * width + x] === 0 ||
    mask[(y + 1) * width + x] === 0
  );
}

function displayPointToImagePoint(clientX: number, clientY: number): ImagePixelPoint | null {
  if (!sourceCanvas) {
    return null;
  }

  const rect = canvas.getBoundingClientRect();
  const canvasX = clientX - rect.left;
  const canvasY = clientY - rect.top;
  const imageX = (canvasX - displayTransform.offsetX) / displayTransform.scale;
  const imageY = (canvasY - displayTransform.offsetY) / displayTransform.scale;

  if (imageX < 0 || imageY < 0 || imageX >= sourceCanvas.width || imageY >= sourceCanvas.height) {
    return null;
  }

  return {
    x: clamp(Math.round(imageX), 0, sourceCanvas.width - 1),
    y: clamp(Math.round(imageY), 0, sourceCanvas.height - 1)
  };
}

function rectFromPoints(start: ImagePixelPoint, end: ImagePixelPoint): ImagePixelRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x) + 1,
    height: Math.abs(end.y - start.y) + 1
  };
}

function setState(nextState: WorkbenchState, message: string): void {
  state = nextState;
  statusElement.textContent = message;
  messageElement.textContent = message;
  messageElement.classList.toggle(
    "visible",
    nextState === "loading-source" || nextState === "processing-mask" || nextState === "failed"
  );
  resetButton.disabled = !sourceCanvas || nextState === "processing-mask" || nextState === "copying";
  copyButton.disabled = !pngBlob || nextState === "processing-mask" || nextState === "copying" || nextState === "failed";
}

function fail(message: string): void {
  setState("failed", message);
  draw();
}

function hostLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol;
  } catch {
    return "Selected image";
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function debug(label: string, value: unknown): void {
  if (!DEBUG) {
    return;
  }

  console.debug(`ImageThief ${label}`, value);
  debugElement.textContent = `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error("Workbench DOM is incomplete");
  }
  return element;
}

function requiredCanvasContext(element: HTMLCanvasElement): CanvasRenderingContext2D {
  const nextContext = element.getContext("2d");
  if (!nextContext) {
    throw new Error("Canvas is unavailable");
  }
  return nextContext;
}

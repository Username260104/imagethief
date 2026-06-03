import {
  DEBUG,
  LASSO_POINT_SPACING_CSS_PX,
  MAX_DECODED_PIXELS,
  MIN_LASSO_AREA_PX,
  MIN_LASSO_POINTS,
  MIN_OBJECT_SELECTION_SIZE,
  SESSION_STORAGE_PREFIX
} from "../shared/constants";
import type {
  DisplayTransform,
  ImagePixelPoint,
  ImagePixelRect,
  LassoSeedSelection,
  ObjectSeedSelection,
  WorkbenchSession,
  WorkbenchState
} from "../shared/types";
import {
  createRoughMask,
  DEFAULT_MASK_TUNING_OPTIONS,
  type MaskResult,
  type MaskTuningOptions
} from "./segmentation";
import "./style.css";

type DecodedImage = ImageBitmap | HTMLImageElement;

type LassoStrokeState = {
  pointerId: number;
  polygon: ImagePixelPoint[];
};

type AutoCopyReason = "selection" | "parameters";

type CopyTrigger = "auto-selection" | "auto-parameters" | "manual";

type ClipboardCopyRequest = {
  blob: Blob;
  trigger: CopyTrigger;
  requestId: number;
};

const EMBEDDED_WORKBENCH = new URLSearchParams(location.search).get("embedded") === "1";
const WORKBENCH_CLOSE_MESSAGE_TYPE = "IMAGE_THIEF_CLOSE_WORKBENCH_OVERLAY";

type ParameterControl = {
  key: keyof MaskTuningOptions;
  input: HTMLInputElement;
  output: HTMLOutputElement;
  kind?: "range" | "toggle";
};

const canvas = requiredElement<HTMLCanvasElement>("#workbench-canvas");
const statusElement = requiredElement<HTMLElement>("#status");
const metaElement = requiredElement<HTMLElement>("#image-meta");
const debugElement = requiredElement<HTMLElement>("#debug-readout");
const messageElement = requiredElement<HTMLElement>("#message");
const resetButton = requiredElement<HTMLButtonElement>("#reset-button");
const copyButton = requiredElement<HTMLButtonElement>("#copy-button");
const closeButton = requiredElement<HTMLButtonElement>("#close-button");
const parameterPanel = requiredElement<HTMLElement>("#parameter-panel");
const resetParametersButton = requiredElement<HTMLButtonElement>("#reset-parameters-button");
const context = requiredCanvasContext(canvas);
const parameterControls: ParameterControl[] = [
  {
    key: "sensitivity",
    input: requiredElement<HTMLInputElement>("#sensitivity-input"),
    output: requiredElement<HTMLOutputElement>("#sensitivity-value")
  },
  {
    key: "expansion",
    input: requiredElement<HTMLInputElement>("#expansion-input"),
    output: requiredElement<HTMLOutputElement>("#expansion-value")
  },
  {
    key: "edgeCleanup",
    input: requiredElement<HTMLInputElement>("#edge-cleanup-input"),
    output: requiredElement<HTMLOutputElement>("#edge-cleanup-value")
  },
  {
    key: "fillHoles",
    input: requiredElement<HTMLInputElement>("#fill-holes-input"),
    output: requiredElement<HTMLOutputElement>("#fill-holes-value"),
    kind: "toggle"
  },
  {
    key: "outputPadding",
    input: requiredElement<HTMLInputElement>("#output-padding-input"),
    output: requiredElement<HTMLOutputElement>("#output-padding-value")
  },
  {
    key: "seedInfluence",
    input: requiredElement<HTMLInputElement>("#seed-influence-input"),
    output: requiredElement<HTMLOutputElement>("#seed-influence-value")
  },
  {
    key: "roughness",
    input: requiredElement<HTMLInputElement>("#roughness-input"),
    output: requiredElement<HTMLOutputElement>("#roughness-value")
  }
];

let state: WorkbenchState = "loading-source";
let session: WorkbenchSession | null = null;
let sourceCanvas: HTMLCanvasElement | null = null;
let displayTransform: DisplayTransform = { scale: 1, offsetX: 0, offsetY: 0 };
let lassoState: LassoStrokeState | null = null;
let lastSelection: ObjectSeedSelection | null = null;
let maskResult: MaskResult | null = null;
let previewCanvas: HTMLCanvasElement | null = null;
let pngBlob: Blob | null = null;
let maskTuningOptions: MaskTuningOptions = cloneDefaultMaskTuningOptions();
let parameterReprocessTimer = 0;
let selectionProcessRunId = 0;
let clipboardWriteRequestId = 0;
let clipboardWriteActive = false;
let pendingClipboardCopy: ClipboardCopyRequest | null = null;

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
  copyCurrentPng("manual");
});
if (EMBEDDED_WORKBENCH) {
  closeButton.textContent = "Close";
}
closeButton.addEventListener("click", closeWorkbench);
resetParametersButton.addEventListener("click", resetParameters);
for (const control of parameterControls) {
  control.input.addEventListener("input", handleParameterInput);
}
syncParameterInputs();

void initialize();

async function initialize(): Promise<void> {
  try {
    setState("loading-source", "Loading source...");
    resizeCanvas();
    session = await loadSession();
    metaElement.textContent = hostLabel(session.candidate.imageUrl);
    await loadSourceImage(session.candidate.imageUrl);
    setState("ready", "Trace inside the object.");
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
  context.fillStyle = "#dcdcdc";
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

  if (lastSelection?.kind === "lasso") {
    drawLassoPath(lastSelection.polygon, {
      fill: "rgba(249,115,22,0.10)",
      stroke: "rgba(249,115,22,0.45)",
      lineWidth: 1.5
    });
  }

  if (previewCanvas && maskResult) {
    context.drawImage(
      previewCanvas,
      displayTransform.offsetX + maskResult.workArea.x * displayTransform.scale,
      displayTransform.offsetY + maskResult.workArea.y * displayTransform.scale,
      maskResult.workArea.width * displayTransform.scale,
      maskResult.workArea.height * displayTransform.scale
    );
  }

  if (lassoState?.polygon.length) {
    drawLassoPath(lassoState.polygon, {
      fill: "rgba(249,115,22,0.14)",
      stroke: "rgba(249,115,22,0.95)",
      lineWidth: 2
    });
  }

  if (lastSelection) {
    drawSelectionBounds(lastSelection.bounds);
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
      context.fillStyle = (row + col) % 2 === 0 ? "#f7f7f7" : "#e5e5e5";
      context.fillRect(x + col * tile, y + row * tile, tile, tile);
    }
  }
  context.restore();
}

function drawSelectionBounds(rect: ImagePixelRect): void {
  const x = displayTransform.offsetX + rect.x * displayTransform.scale;
  const y = displayTransform.offsetY + rect.y * displayTransform.scale;
  const width = rect.width * displayTransform.scale;
  const height = rect.height * displayTransform.scale;

  context.save();
  context.strokeStyle = "#4f4f4f";
  context.lineWidth = 2;
  context.setLineDash([6, 5]);
  context.strokeRect(x, y, width, height);
  context.restore();
}

function drawLassoPath(
  points: ImagePixelPoint[],
  style: { fill: string; stroke: string; lineWidth: number }
): void {
  if (points.length === 0) {
    return;
  }

  context.save();
  context.beginPath();
  const first = points[0];
  context.moveTo(
    displayTransform.offsetX + first.x * displayTransform.scale,
    displayTransform.offsetY + first.y * displayTransform.scale
  );

  for (const point of points.slice(1)) {
    context.lineTo(
      displayTransform.offsetX + point.x * displayTransform.scale,
      displayTransform.offsetY + point.y * displayTransform.scale
    );
  }

  if (points.length > 2) {
    context.closePath();
    context.fillStyle = style.fill;
    context.fill();
  }

  context.strokeStyle = style.stroke;
  context.lineWidth = style.lineWidth;
  context.stroke();
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

  event.preventDefault();
  invalidateSelectionAndClipboardWork();
  window.clearTimeout(parameterReprocessTimer);
  canvas.setPointerCapture(event.pointerId);
  lassoState = {
    pointerId: event.pointerId,
    polygon: [point]
  };
  pngBlob = null;
  maskResult = null;
  previewCanvas = null;
  lastSelection = null;
  setState("selecting-object", "Drawing lasso seed...");
  draw();
}

function handlePointerMove(event: PointerEvent): void {
  if (!lassoState || event.pointerId !== lassoState.pointerId) {
    return;
  }

  const point = displayPointToImagePoint(event.clientX, event.clientY);
  if (!point) {
    return;
  }

  event.preventDefault();
  const lastPoint = lassoState.polygon.at(-1);
  if (!lastPoint || imageDistance(lastPoint, point) >= lassoPointSpacingImagePx()) {
    lassoState.polygon.push(point);
  }
  draw();
}

function handlePointerUp(event: PointerEvent): void {
  if (!lassoState || event.pointerId !== lassoState.pointerId) {
    return;
  }

  const point = displayPointToImagePoint(event.clientX, event.clientY);
  if (point) {
    const lastPoint = lassoState.polygon.at(-1);
    if (!lastPoint || imageDistance(lastPoint, point) >= 1) {
      lassoState.polygon.push(point);
    }
  }

  const selection = selectionFromLassoPoints(lassoState.polygon);
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
  lassoState = null;

  if (isLassoSelectionTooSmall(selection)) {
    lastSelection = null;
    setState("ready", "Selection is too small");
    draw();
    return;
  }

  lastSelection = selection;
  void processSelection(lastSelection, "selection");
}

function cancelDrag(): void {
  lassoState = null;
  setState(sourceCanvas ? "ready" : "loading-source", sourceCanvas ? "Trace inside the object." : "Loading source...");
  draw();
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") {
    return;
  }

  if (lassoState) {
    event.preventDefault();
    cancelDrag();
    return;
  }

  if (maskResult || lastSelection) {
    event.preventDefault();
    resetSelection();
  }
}

async function processSelection(selection: ObjectSeedSelection, autoCopyReason: AutoCopyReason): Promise<void> {
  if (!sourceCanvas) {
    return;
  }

  const runId = ++selectionProcessRunId;
  invalidateClipboardWork();

  try {
    setState("processing-mask", "Creating rough outline...");
    draw();
    await nextFrame();
    if (!isCurrentSelectionProcess(runId)) {
      return;
    }

    const nextMaskResult = createRoughMask(sourceCanvas, selection, maskTuningOptions);
    if (!nextMaskResult) {
      if (!isCurrentSelectionProcess(runId)) {
        return;
      }

      maskResult = null;
      previewCanvas = null;
      pngBlob = null;
      setState("ready", "No confident mask. Adjust parameters or trace a tighter lasso.");
      debug("mask confidence", "empty");
      draw();
      return;
    }

    const nextPreviewCanvas = createPreviewCanvas(nextMaskResult);
    const nextPngBlob = await createPngBlob(sourceCanvas, nextMaskResult);
    if (!isCurrentSelectionProcess(runId)) {
      return;
    }

    maskResult = nextMaskResult;
    previewCanvas = nextPreviewCanvas;
    pngBlob = nextPngBlob;
    setState("preview-ready", nextMaskResult.usedEmergency ? "Preview ready (rough fallback)" : "Preview ready");
    debug("mask foreground ratio", nextMaskResult.foregroundRatio.toFixed(3));
    debug("output bounding box", nextMaskResult.outputBounds);
    debug("output PNG size", nextPngBlob.size);
    draw();
    copyCurrentPng(autoCopyReason === "selection" ? "auto-selection" : "auto-parameters");
  } catch (error) {
    if (!isCurrentSelectionProcess(runId)) {
      return;
    }

    console.debug("ImageThief PNG failure", error);
    fail("Unable to create PNG");
  }
}

function resetSelection(): void {
  invalidateSelectionAndClipboardWork();
  window.clearTimeout(parameterReprocessTimer);
  lassoState = null;
  lastSelection = null;
  maskResult = null;
  previewCanvas = null;
  pngBlob = null;
  setState(sourceCanvas ? "ready" : "loading-source", sourceCanvas ? "Trace inside the object." : "Loading source...");
  draw();
}

function closeWorkbench(): void {
  if (EMBEDDED_WORKBENCH && window.parent !== window) {
    window.parent.postMessage({ type: WORKBENCH_CLOSE_MESSAGE_TYPE }, "*");
    return;
  }

  window.close();
}

function resetParameters(): void {
  window.clearTimeout(parameterReprocessTimer);
  maskTuningOptions = cloneDefaultMaskTuningOptions();
  syncParameterInputs();
  if (lastSelection) {
    void processSelection(lastSelection, "parameters");
    return;
  }

  updateParameterPanelState();
}

function handleParameterInput(): void {
  maskTuningOptions = readMaskTuningOptionsFromInputs();
  syncParameterOutputs();
  scheduleParameterReprocess();
}

function scheduleParameterReprocess(): void {
  window.clearTimeout(parameterReprocessTimer);
  invalidateClipboardWork();
  if (
    !lastSelection ||
    state === "loading-source" ||
    state === "selecting-object" ||
    state === "processing-mask" ||
    state === "copying" ||
    state === "failed"
  ) {
    updateParameterPanelState();
    return;
  }

  pngBlob = null;
  copyButton.disabled = true;
  statusElement.textContent = "Adjusting preview...";
  parameterReprocessTimer = window.setTimeout(() => {
    if (lastSelection) {
      void processSelection(lastSelection, "parameters");
    }
  }, 150);
}

function copyCurrentPng(trigger: CopyTrigger): void {
  if (!pngBlob || !maskResult) {
    setState("preview-ready", "Unable to create PNG");
    return;
  }

  const request: ClipboardCopyRequest = {
    blob: pngBlob,
    trigger,
    requestId: ++clipboardWriteRequestId
  };

  if (clipboardWriteActive) {
    pendingClipboardCopy = request;
    updateCopyStartMessage(trigger);
    return;
  }

  void runClipboardCopy(request);
}

async function runClipboardCopy(request: ClipboardCopyRequest): Promise<void> {
  clipboardWriteActive = true;
  updateCopyStartMessage(request.trigger);

  try {
    await writePngToClipboard(request.blob);
    if (isCurrentClipboardRequest(request)) {
      setState("copied", copySuccessMessage(request.trigger));
      debug("clipboard success", request.trigger);
    }
  } catch (error) {
    console.debug("ImageThief clipboard failure", error);
    if (isCurrentClipboardRequest(request)) {
      setState("preview-ready", request.trigger === "manual" ? "Unable to copy PNG" : "Auto copy failed. Use Copy Again.");
      debug("clipboard success", false);
    }
  } finally {
    const nextRequest = pendingClipboardCopy;
    pendingClipboardCopy = null;
    if (nextRequest && isCurrentClipboardRequest(nextRequest)) {
      void runClipboardCopy(nextRequest);
      return;
    }

    clipboardWriteActive = false;
  }
}

async function writePngToClipboard(blob: Blob): Promise<void> {
  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": blob
    })
  ]);
}

function invalidateSelectionAndClipboardWork(): void {
  selectionProcessRunId += 1;
  invalidateClipboardWork();
}

function invalidateClipboardWork(): void {
  clipboardWriteRequestId += 1;
  pendingClipboardCopy = null;
}

function isCurrentSelectionProcess(runId: number): boolean {
  return runId === selectionProcessRunId;
}

function isCurrentClipboardRequest(request: ClipboardCopyRequest): boolean {
  return request.requestId === clipboardWriteRequestId;
}

function updateCopyStartMessage(trigger: CopyTrigger): void {
  if (trigger === "manual") {
    setState("copying", "Copying PNG...");
    return;
  }

  statusElement.textContent = trigger === "auto-parameters" ? "Updating clipboard..." : "Copying PNG...";
}

function copySuccessMessage(trigger: CopyTrigger): string {
  return trigger === "auto-parameters" ? "Updated clipboard" : "Copied PNG";
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

function selectionFromLassoPoints(points: ImagePixelPoint[]): LassoSeedSelection {
  if (!sourceCanvas || points.length === 0) {
    return {
      kind: "lasso",
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      polygon: []
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  const x = clamp(Math.floor(minX), 0, Math.max(0, sourceCanvas.width - 1));
  const y = clamp(Math.floor(minY), 0, Math.max(0, sourceCanvas.height - 1));
  const right = clamp(Math.ceil(maxX), x + 1, sourceCanvas.width);
  const bottom = clamp(Math.ceil(maxY), y + 1, sourceCanvas.height);

  return {
    kind: "lasso",
    bounds: {
      x,
      y,
      width: right - x,
      height: bottom - y
    },
    polygon: points.slice()
  };
}

function isLassoSelectionTooSmall(selection: LassoSeedSelection): boolean {
  return (
    selection.polygon.length < MIN_LASSO_POINTS ||
    selection.bounds.width < MIN_OBJECT_SELECTION_SIZE ||
    selection.bounds.height < MIN_OBJECT_SELECTION_SIZE ||
    polygonArea(selection.polygon) < MIN_LASSO_AREA_PX
  );
}

function lassoPointSpacingImagePx(): number {
  return Math.max(1, LASSO_POINT_SPACING_CSS_PX / Math.max(0.001, displayTransform.scale));
}

function imageDistance(a: ImagePixelPoint, b: ImagePixelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polygonArea(points: ImagePixelPoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
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
  updateParameterPanelState();
}

function updateParameterPanelState(): void {
  const controlsDisabled =
    !sourceCanvas ||
    !lastSelection ||
    state === "loading-source" ||
    state === "selecting-object" ||
    state === "processing-mask" ||
    state === "copying" ||
    state === "failed";
  parameterPanel.classList.toggle("is-disabled", controlsDisabled);
  for (const control of parameterControls) {
    control.input.disabled = controlsDisabled;
  }

  resetParametersButton.disabled =
    !sourceCanvas ||
    state === "loading-source" ||
    state === "processing-mask" ||
    state === "copying" ||
    state === "failed";
}

function syncParameterInputs(): void {
  for (const control of parameterControls) {
    const value = maskTuningOptions[control.key];
    if (control.kind === "toggle") {
      control.input.checked = value >= 1;
      control.output.textContent = formatToggleValue(value);
    } else {
      control.input.value = String(value);
      control.output.textContent = formatParameterValue(value);
    }
  }
}

function syncParameterOutputs(): void {
  for (const control of parameterControls) {
    const value = maskTuningOptions[control.key];
    control.output.textContent = control.kind === "toggle" ? formatToggleValue(value) : formatParameterValue(value);
  }
}

function readMaskTuningOptionsFromInputs(): MaskTuningOptions {
  const next = cloneDefaultMaskTuningOptions();
  for (const control of parameterControls) {
    next[control.key] = control.kind === "toggle" ? Number(control.input.checked) : Number(control.input.value);
  }
  return next;
}

function cloneDefaultMaskTuningOptions(): MaskTuningOptions {
  return { ...DEFAULT_MASK_TUNING_OPTIONS };
}

function formatParameterValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatToggleValue(value: number): string {
  return value >= 1 ? "켬" : "끔";
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

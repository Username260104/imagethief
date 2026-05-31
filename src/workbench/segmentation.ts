import {
  MAX_FOREGROUND_RATIO,
  MIN_FOREGROUND_RATIO,
  OUTPUT_PADDING_MIN_PX,
  OUTPUT_PADDING_RATIO,
  SELECTION_PADDING_RATIO
} from "../shared/constants";
import type { ImagePixelRect, ObjectSeedSelection } from "../shared/types";

export type MaskResult = {
  workArea: ImagePixelRect;
  width: number;
  height: number;
  mask: Uint8ClampedArray;
  foregroundBounds: ImagePixelRect;
  outputBounds: ImagePixelRect;
  foregroundRatio: number;
  usedEmergency: boolean;
};

type RgbMean = {
  r: number;
  g: number;
  b: number;
  count: number;
};

export function createRoughMask(
  sourceCanvas: HTMLCanvasElement,
  selection: ObjectSeedSelection
): MaskResult {
  const seed = normalizeRect(selection.bounds, sourceCanvas.width, sourceCanvas.height);
  if (seed.width <= 0 || seed.height <= 0) {
    return createEmergencyMask(sourceCanvas, seed);
  }

  const workArea = expandRectByRatio(seed, SELECTION_PADDING_RATIO, sourceCanvas.width, sourceCanvas.height);
  const context = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return createEmergencyMask(sourceCanvas, seed);
  }

  const imageData = context.getImageData(workArea.x, workArea.y, workArea.width, workArea.height);
  const foreground = sampleForeground(imageData.data, workArea, seed);
  const background = sampleBackground(imageData.data, workArea, seed);

  if (foreground.count === 0 || background.count === 0) {
    return createEmergencyMask(sourceCanvas, seed);
  }

  const mask = new Uint8ClampedArray(workArea.width * workArea.height);
  let foregroundCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const centerX = seed.x + seed.width / 2;
  const centerY = seed.y + seed.height / 2;
  const radiusX = Math.max(1, seed.width / 2);
  const radiusY = Math.max(1, seed.height / 2);

  for (let y = 0; y < workArea.height; y += 1) {
    const imageY = workArea.y + y;
    for (let x = 0; x < workArea.width; x += 1) {
      const imageX = workArea.x + x;
      const dataIndex = (y * workArea.width + x) * 4;
      const r = imageData.data[dataIndex];
      const g = imageData.data[dataIndex + 1];
      const b = imageData.data[dataIndex + 2];
      const foregroundDistance = colorDistance(r, g, b, foreground);
      const backgroundDistance = colorDistance(r, g, b, background);
      const normalizedDistance = Math.hypot((imageX - centerX) / radiusX, (imageY - centerY) / radiusY);
      const centerPrior = Math.max(0, 1 - normalizedDistance / 1.5) * 36;
      const insideSeed = pointInRect(imageX, imageY, seed);
      const seedPrior = insideSeed ? 18 : -14;
      const roughNoise = (hashNoise(imageX, imageY) - 0.5) * 30;
      const score = backgroundDistance - foregroundDistance + centerPrior + seedPrior + roughNoise;

      if (score > 8) {
        const maskIndex = y * workArea.width + x;
        mask[maskIndex] = 255;
        foregroundCount += 1;
        minX = Math.min(minX, imageX);
        minY = Math.min(minY, imageY);
        maxX = Math.max(maxX, imageX);
        maxY = Math.max(maxY, imageY);
      }
    }
  }

  const foregroundRatio = foregroundCount / mask.length;
  if (
    foregroundCount === 0 ||
    foregroundRatio < MIN_FOREGROUND_RATIO ||
    foregroundRatio > MAX_FOREGROUND_RATIO
  ) {
    return createEmergencyMask(sourceCanvas, seed);
  }

  const foregroundBounds = {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };

  return {
    workArea,
    width: workArea.width,
    height: workArea.height,
    mask,
    foregroundBounds,
    outputBounds: expandRectByPixels(
      foregroundBounds,
      outputPaddingFor(foregroundBounds),
      sourceCanvas.width,
      sourceCanvas.height
    ),
    foregroundRatio,
    usedEmergency: false
  };
}

function createEmergencyMask(sourceCanvas: HTMLCanvasElement, seed: ImagePixelRect): MaskResult {
  const normalizedSeed = normalizeRect(seed, sourceCanvas.width, sourceCanvas.height);
  const outputBounds = expandRectByPixels(
    normalizedSeed,
    outputPaddingFor(normalizedSeed),
    sourceCanvas.width,
    sourceCanvas.height
  );
  const mask = new Uint8ClampedArray(outputBounds.width * outputBounds.height);
  let foregroundCount = 0;

  for (let y = 0; y < outputBounds.height; y += 1) {
    const imageY = outputBounds.y + y;
    for (let x = 0; x < outputBounds.width; x += 1) {
      const imageX = outputBounds.x + x;
      if (pointInRect(imageX, imageY, normalizedSeed)) {
        mask[y * outputBounds.width + x] = 255;
        foregroundCount += 1;
      }
    }
  }

  return {
    workArea: outputBounds,
    width: outputBounds.width,
    height: outputBounds.height,
    mask,
    foregroundBounds: normalizedSeed,
    outputBounds,
    foregroundRatio: foregroundCount / Math.max(1, mask.length),
    usedEmergency: true
  };
}

function sampleForeground(data: Uint8ClampedArray, workArea: ImagePixelRect, seed: ImagePixelRect): RgbMean {
  const inner = {
    x: Math.round(seed.x + seed.width * 0.25),
    y: Math.round(seed.y + seed.height * 0.25),
    width: Math.max(1, Math.round(seed.width * 0.5)),
    height: Math.max(1, Math.round(seed.height * 0.5))
  };
  return sampleMean(data, workArea, (imageX, imageY) => pointInRect(imageX, imageY, inner));
}

function sampleBackground(data: Uint8ClampedArray, workArea: ImagePixelRect, seed: ImagePixelRect): RgbMean {
  const border = Math.max(2, Math.round(Math.min(workArea.width, workArea.height) * 0.08));
  return sampleMean(data, workArea, (imageX, imageY, localX, localY) => {
    const onBorder =
      localX < border ||
      localY < border ||
      localX >= workArea.width - border ||
      localY >= workArea.height - border;
    return onBorder || !pointInRect(imageX, imageY, seed);
  });
}

function sampleMean(
  data: Uint8ClampedArray,
  workArea: ImagePixelRect,
  shouldSample: (imageX: number, imageY: number, localX: number, localY: number) => boolean
): RgbMean {
  const stride = Math.max(1, Math.floor(Math.sqrt((workArea.width * workArea.height) / 12_000)));
  const mean: RgbMean = { r: 0, g: 0, b: 0, count: 0 };

  for (let y = 0; y < workArea.height; y += stride) {
    const imageY = workArea.y + y;
    for (let x = 0; x < workArea.width; x += stride) {
      const imageX = workArea.x + x;
      if (!shouldSample(imageX, imageY, x, y)) {
        continue;
      }

      const index = (y * workArea.width + x) * 4;
      mean.r += data[index];
      mean.g += data[index + 1];
      mean.b += data[index + 2];
      mean.count += 1;
    }
  }

  if (mean.count > 0) {
    mean.r /= mean.count;
    mean.g /= mean.count;
    mean.b /= mean.count;
  }

  return mean;
}

function colorDistance(r: number, g: number, b: number, mean: RgbMean): number {
  return Math.hypot(r - mean.r, g - mean.g, b - mean.b);
}

function outputPaddingFor(rect: ImagePixelRect): number {
  return Math.max(OUTPUT_PADDING_MIN_PX, Math.round(Math.max(rect.width, rect.height) * OUTPUT_PADDING_RATIO));
}

function normalizeRect(rect: ImagePixelRect, maxWidth: number, maxHeight: number): ImagePixelRect {
  const x = clamp(Math.floor(rect.x), 0, Math.max(0, maxWidth - 1));
  const y = clamp(Math.floor(rect.y), 0, Math.max(0, maxHeight - 1));
  const right = clamp(Math.ceil(rect.x + rect.width), x + 1, maxWidth);
  const bottom = clamp(Math.ceil(rect.y + rect.height), y + 1, maxHeight);
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function expandRectByRatio(
  rect: ImagePixelRect,
  ratio: number,
  maxWidth: number,
  maxHeight: number
): ImagePixelRect {
  const padding = Math.max(1, Math.round(Math.max(rect.width, rect.height) * ratio));
  return expandRectByPixels(rect, padding, maxWidth, maxHeight);
}

function expandRectByPixels(
  rect: ImagePixelRect,
  padding: number,
  maxWidth: number,
  maxHeight: number
): ImagePixelRect {
  const x = clamp(rect.x - padding, 0, Math.max(0, maxWidth - 1));
  const y = clamp(rect.y - padding, 0, Math.max(0, maxHeight - 1));
  const right = clamp(rect.x + rect.width + padding, x + 1, maxWidth);
  const bottom = clamp(rect.y + rect.height + padding, y + 1, maxHeight);
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function pointInRect(x: number, y: number, rect: ImagePixelRect): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function hashNoise(x: number, y: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

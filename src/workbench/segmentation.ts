import {
  MAX_FOREGROUND_RATIO,
  MAX_MASK_WORK_AREA_PIXELS,
  MIN_FOREGROUND_RATIO,
  OUTPUT_PADDING_MIN_PX,
  OUTPUT_PADDING_RATIO,
  SELECTION_PADDING_RATIO
} from "../shared/constants";
import type { BrushSeedPoint, ImagePixelRect, ObjectSeedSelection } from "../shared/types";

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

type BrushMask = {
  mask: Uint8ClampedArray;
  foregroundCount: number;
  bounds: ImagePixelRect | null;
};

export function createRoughMask(
  sourceCanvas: HTMLCanvasElement,
  selection: ObjectSeedSelection
): MaskResult {
  const seedBounds = normalizeRect(selection.bounds, sourceCanvas.width, sourceCanvas.height);
  if (seedBounds.width <= 0 || seedBounds.height <= 0 || selection.points.length === 0) {
    return createEmergencyMask(sourceCanvas, selection);
  }

  const workArea = expandRectByRatio(seedBounds, SELECTION_PADDING_RATIO, sourceCanvas.width, sourceCanvas.height);
  if (workArea.width * workArea.height > MAX_MASK_WORK_AREA_PIXELS) {
    return createEmergencyMask(sourceCanvas, selection);
  }

  const context = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return createEmergencyMask(sourceCanvas, selection);
  }

  const imageData = context.getImageData(workArea.x, workArea.y, workArea.width, workArea.height);
  const seedMask = createBrushMask(workArea, selection.points, 1);
  const nearSeedMask = createBrushMask(workArea, selection.points, 3);
  const foreground = sampleMean(imageData.data, workArea, (_imageX, _imageY, localX, localY) => {
    return seedMask.mask[localY * workArea.width + localX] > 0;
  });
  const background = sampleBackground(imageData.data, workArea, nearSeedMask.mask);

  if (foreground.count === 0 || background.count === 0) {
    return createEmergencyMask(sourceCanvas, selection);
  }

  const mask = new Uint8ClampedArray(workArea.width * workArea.height);
  let foregroundCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const border = Math.max(2, Math.round(Math.min(workArea.width, workArea.height) * 0.04));

  for (let y = 0; y < workArea.height; y += 1) {
    const imageY = workArea.y + y;
    for (let x = 0; x < workArea.width; x += 1) {
      const imageX = workArea.x + x;
      const maskIndex = y * workArea.width + x;
      const dataIndex = maskIndex * 4;
      const r = imageData.data[dataIndex];
      const g = imageData.data[dataIndex + 1];
      const b = imageData.data[dataIndex + 2];
      const foregroundDistance = colorDistance(r, g, b, foreground);
      const backgroundDistance = colorDistance(r, g, b, background);
      const inSeed = seedMask.mask[maskIndex] > 0;
      const nearSeed = nearSeedMask.mask[maskIndex] > 0;
      const onBorder =
        x < border ||
        y < border ||
        x >= workArea.width - border ||
        y >= workArea.height - border;
      const seedPrior = inSeed ? 38 : nearSeed ? 16 : -12;
      const borderPrior = onBorder ? -18 : 0;
      const roughNoise = (hashNoise(imageX, imageY) - 0.5) * 30;
      const score = backgroundDistance - foregroundDistance + seedPrior + borderPrior + roughNoise;

      if (score > 8) {
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
    return createEmergencyMask(sourceCanvas, selection);
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

function createEmergencyMask(sourceCanvas: HTMLCanvasElement, selection: ObjectSeedSelection): MaskResult {
  const seedBounds = normalizeRect(selection.bounds, sourceCanvas.width, sourceCanvas.height);
  const outputBounds = expandRectByPixels(
    seedBounds,
    outputPaddingFor(seedBounds),
    sourceCanvas.width,
    sourceCanvas.height
  );
  const brushMask = createBrushMask(outputBounds, selection.points, 1.5);
  const foregroundBounds = brushMask.bounds ?? seedBounds;

  return {
    workArea: outputBounds,
    width: outputBounds.width,
    height: outputBounds.height,
    mask: brushMask.mask,
    foregroundBounds,
    outputBounds,
    foregroundRatio: brushMask.foregroundCount / Math.max(1, brushMask.mask.length),
    usedEmergency: true
  };
}

function createBrushMask(workArea: ImagePixelRect, points: BrushSeedPoint[], radiusMultiplier: number): BrushMask {
  const mask = new Uint8ClampedArray(workArea.width * workArea.height);
  let foregroundCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    const radius = Math.max(1, Math.round(point.radius * radiusMultiplier));
    const left = clamp(Math.floor(point.x - radius), workArea.x, workArea.x + workArea.width - 1);
    const top = clamp(Math.floor(point.y - radius), workArea.y, workArea.y + workArea.height - 1);
    const right = clamp(Math.ceil(point.x + radius), workArea.x, workArea.x + workArea.width - 1);
    const bottom = clamp(Math.ceil(point.y + radius), workArea.y, workArea.y + workArea.height - 1);

    for (let imageY = top; imageY <= bottom; imageY += 1) {
      const localY = imageY - workArea.y;
      for (let imageX = left; imageX <= right; imageX += 1) {
        const localX = imageX - workArea.x;
        if (Math.hypot(imageX - point.x, imageY - point.y) > radius) {
          continue;
        }

        const maskIndex = localY * workArea.width + localX;
        if (mask[maskIndex] > 0) {
          continue;
        }

        mask[maskIndex] = 255;
        foregroundCount += 1;
        minX = Math.min(minX, imageX);
        minY = Math.min(minY, imageY);
        maxX = Math.max(maxX, imageX);
        maxY = Math.max(maxY, imageY);
      }
    }
  }

  return {
    mask,
    foregroundCount,
    bounds:
      foregroundCount > 0
        ? {
            x: minX,
            y: minY,
            width: maxX - minX + 1,
            height: maxY - minY + 1
          }
        : null
  };
}

function sampleBackground(data: Uint8ClampedArray, workArea: ImagePixelRect, nearSeedMask: Uint8ClampedArray): RgbMean {
  const border = Math.max(2, Math.round(Math.min(workArea.width, workArea.height) * 0.08));
  return sampleMean(data, workArea, (_imageX, _imageY, localX, localY) => {
    const onBorder =
      localX < border ||
      localY < border ||
      localX >= workArea.width - border ||
      localY >= workArea.height - border;
    return onBorder || nearSeedMask[localY * workArea.width + localX] === 0;
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

function hashNoise(x: number, y: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

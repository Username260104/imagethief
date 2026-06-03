import {
  MAX_CONNECTED_ACCEPTED_PIXELS,
  MAX_CONNECTED_GROWTH_AREA_PIXELS,
  MAX_CONNECTED_VISITED_PIXELS,
  MAX_FOREGROUND_RATIO,
  MAX_MASK_WORK_AREA_PIXELS,
  MIN_FOREGROUND_RATIO,
  NEAR_SEED_DILATION_MAX_PX,
  NEAR_SEED_DILATION_MIN_PX,
  OUTPUT_PADDING_MIN_PX,
  OUTPUT_PADDING_RATIO,
  SELECTION_PADDING_RATIO
} from "../shared/constants";
import type { BrushSeedPoint, ImagePixelPoint, ImagePixelRect, ObjectSeedSelection } from "../shared/types";

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

export type MaskTuningOptions = {
  sensitivity: number;
  expansion: number;
  edgeCleanup: number;
  outputPadding: number;
  seedInfluence: number;
  roughness: number;
  fillHoles: number;
};

export const DEFAULT_MASK_TUNING_OPTIONS: MaskTuningOptions = {
  sensitivity: 35,
  expansion: 0,
  edgeCleanup: 0,
  outputPadding: 0,
  seedInfluence: 0,
  roughness: 0,
  fillHoles: 0
};

type RgbMean = {
  r: number;
  g: number;
  b: number;
  count: number;
};

type ResolvedMaskTuning = {
  scoreThreshold: number;
  growthScoreThreshold: number;
  selectionPaddingRatio: number;
  growthRatio: number;
  useFullImageGrowth: boolean;
  nearSeedDilationRatio: number;
  nearSeedDilationMinPx: number;
  nearSeedDilationMaxPx: number;
  inSeedPrior: number;
  nearSeedPrior: number;
  outsideSeedPrior: number;
  borderPenalty: number;
  backgroundBorderRatio: number;
  roughNoiseAmount: number;
  fillHoles: boolean;
  outputPaddingMinPx: number;
  outputPaddingRatio: number;
  maxVisitedPixels: number;
  maxAcceptedPixels: number;
};

type SeedMask = {
  mask: Uint8ClampedArray;
  foregroundCount: number;
  bounds: ImagePixelRect | null;
};

type PixelScoreContext = {
  data: Uint8ClampedArray;
  workArea: ImagePixelRect;
  seedMask: SeedMask;
  nearSeedMask: SeedMask;
  foreground: RgbMean;
  background: RgbMean;
  border: number;
  tuning: ResolvedMaskTuning;
};

type PixelScoreOptions = {
  useSeedPrior: boolean;
};

type MaskAttempt =
  | {
      ok: true;
      result: MaskResult;
    }
  | {
      ok: false;
      reason: "technical" | "low-confidence";
    };

export function createRoughMask(
  sourceCanvas: HTMLCanvasElement,
  selection: ObjectSeedSelection,
  options: MaskTuningOptions = DEFAULT_MASK_TUNING_OPTIONS
): MaskResult | null {
  const tuning = resolveMaskTuning(options);
  const connectedMask = createConnectedMask(sourceCanvas, selection, tuning);
  if (connectedMask.ok) {
    return connectedMask.result;
  }

  const rectangularMask = createRectangularScoredMask(sourceCanvas, selection, tuning);
  if (rectangularMask.ok) {
    return rectangularMask.result;
  }

  if (rectangularMask.reason === "technical") {
    return createEmergencyMask(sourceCanvas, selection, tuning);
  }

  return null;
}

function createConnectedMask(
  sourceCanvas: HTMLCanvasElement,
  selection: ObjectSeedSelection,
  tuning: ResolvedMaskTuning
): MaskAttempt {
  const seedBounds = normalizeRect(selection.bounds, sourceCanvas.width, sourceCanvas.height);
  if (seedBounds.width <= 0 || seedBounds.height <= 0 || !selectionHasSeed(selection)) {
    return { ok: false, reason: "low-confidence" };
  }

  const growthArea = createGrowthArea(seedBounds, sourceCanvas.width, sourceCanvas.height, tuning);
  const growthPixelCount = growthArea.width * growthArea.height;
  if (growthPixelCount <= 0 || growthPixelCount > MAX_CONNECTED_GROWTH_AREA_PIXELS) {
    return { ok: false, reason: "technical" };
  }

  const canvasContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!canvasContext) {
    return { ok: false, reason: "technical" };
  }

  let imageData: ImageData;
  try {
    imageData = canvasContext.getImageData(growthArea.x, growthArea.y, growthArea.width, growthArea.height);
  } catch {
    return { ok: false, reason: "technical" };
  }

  const seedMask = createSeedMask(growthArea, selection);
  if (seedMask.foregroundCount <= 0) {
    return { ok: false, reason: "low-confidence" };
  }

  const maxVisitedPixels = Math.min(tuning.maxVisitedPixels, growthPixelCount);
  const maxAcceptedPixels = Math.min(tuning.maxAcceptedPixels, growthPixelCount);
  if (seedMask.foregroundCount > maxVisitedPixels) {
    return { ok: false, reason: "technical" };
  }

  const nearSeedMask = createNearSeedMask(growthArea, selection, seedMask, tuning);
  const foreground = sampleMean(imageData.data, growthArea, (_imageX, _imageY, localX, localY) => {
    return seedMask.mask[localY * growthArea.width + localX] > 0;
  });
  const background = sampleBackground(imageData.data, growthArea, nearSeedMask.mask, tuning);

  if (foreground.count === 0 || background.count === 0) {
    return { ok: false, reason: "technical" };
  }

  const mask = new Uint8ClampedArray(growthPixelCount);
  const visited = new Uint8Array(growthPixelCount);
  const queue = new Int32Array(maxVisitedPixels);
  let queueStart = 0;
  let queueEnd = 0;
  let visitedCount = 0;
  let acceptedCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const scoreContext: PixelScoreContext = {
    data: imageData.data,
    workArea: growthArea,
    seedMask,
    nearSeedMask,
    foreground,
    background,
    border: Math.max(2, Math.round(Math.min(growthArea.width, growthArea.height) * 0.04)),
    tuning
  };

  for (let index = 0; index < seedMask.mask.length; index += 1) {
    if (seedMask.mask[index] === 0) {
      continue;
    }

    visited[index] = 1;
    queue[queueEnd] = index;
    queueEnd += 1;
    visitedCount += 1;

    const localY = Math.floor(index / growthArea.width);
    const localX = index - localY * growthArea.width;
    const imageX = growthArea.x + localX;
    const imageY = growthArea.y + localY;
    const score = scoreMaskPixel(scoreContext, index, imageX, imageY, localX, localY, {
      useSeedPrior: false
    });

    if (score > tuning.growthScoreThreshold) {
      mask[index] = 255;
      acceptedCount += 1;
      minX = Math.min(minX, imageX);
      minY = Math.min(minY, imageY);
      maxX = Math.max(maxX, imageX);
      maxY = Math.max(maxY, imageY);

      if (acceptedCount >= maxAcceptedPixels) {
        const result = createMaskResultFromBounds(
          sourceCanvas,
          growthArea,
          mask,
          acceptedCount,
          minX,
          minY,
          maxX,
          maxY,
          tuning,
          false
        );
        return result ? { ok: true, result } : { ok: false, reason: "low-confidence" };
      }
    }
  }

  if (visitedCount >= maxVisitedPixels) {
    const result = createMaskResultFromBounds(
      sourceCanvas,
      growthArea,
      mask,
      acceptedCount,
      minX,
      minY,
      maxX,
      maxY,
      tuning,
      false
    );
    return result ? { ok: true, result } : { ok: false, reason: "low-confidence" };
  }

  growthLoop:
  while (queueStart < queueEnd) {
    const currentIndex = queue[queueStart];
    queueStart += 1;
    const currentY = Math.floor(currentIndex / growthArea.width);
    const currentX = currentIndex - currentY * growthArea.width;

    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const localY = currentY + offsetY;
      if (localY < 0 || localY >= growthArea.height) {
        continue;
      }

      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) {
          continue;
        }

        const localX = currentX + offsetX;
        if (localX < 0 || localX >= growthArea.width) {
          continue;
        }

        const neighborIndex = localY * growthArea.width + localX;
        if (visited[neighborIndex] > 0) {
          continue;
        }

        visited[neighborIndex] = 1;
        visitedCount += 1;
        const imageX = growthArea.x + localX;
        const imageY = growthArea.y + localY;
        const score = scoreMaskPixel(scoreContext, neighborIndex, imageX, imageY, localX, localY, {
          useSeedPrior: false
        });

        if (score > tuning.growthScoreThreshold) {
          mask[neighborIndex] = 255;
          queue[queueEnd] = neighborIndex;
          queueEnd += 1;
          acceptedCount += 1;
          minX = Math.min(minX, imageX);
          minY = Math.min(minY, imageY);
          maxX = Math.max(maxX, imageX);
          maxY = Math.max(maxY, imageY);

          if (acceptedCount >= maxAcceptedPixels) {
            break growthLoop;
          }
        }

        if (visitedCount >= maxVisitedPixels) {
          break growthLoop;
        }
      }
    }
  }

  const result = createMaskResultFromBounds(
    sourceCanvas,
    growthArea,
    mask,
    acceptedCount,
    minX,
    minY,
    maxX,
    maxY,
    tuning,
    false
  );
  return result ? { ok: true, result } : { ok: false, reason: "low-confidence" };
}

function createRectangularScoredMask(
  sourceCanvas: HTMLCanvasElement,
  selection: ObjectSeedSelection,
  tuning: ResolvedMaskTuning
): MaskAttempt {
  const seedBounds = normalizeRect(selection.bounds, sourceCanvas.width, sourceCanvas.height);
  if (seedBounds.width <= 0 || seedBounds.height <= 0 || !selectionHasSeed(selection)) {
    return { ok: false, reason: "low-confidence" };
  }

  const workArea = expandRectByRatio(seedBounds, tuning.selectionPaddingRatio, sourceCanvas.width, sourceCanvas.height);
  if (workArea.width * workArea.height > MAX_MASK_WORK_AREA_PIXELS) {
    return { ok: false, reason: "technical" };
  }

  const context = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return { ok: false, reason: "technical" };
  }

  let imageData: ImageData;
  try {
    imageData = context.getImageData(workArea.x, workArea.y, workArea.width, workArea.height);
  } catch {
    return { ok: false, reason: "technical" };
  }

  const seedMask = createSeedMask(workArea, selection);
  const nearSeedMask = createNearSeedMask(workArea, selection, seedMask, tuning);
  const foreground = sampleMean(imageData.data, workArea, (_imageX, _imageY, localX, localY) => {
    return seedMask.mask[localY * workArea.width + localX] > 0;
  });
  const background = sampleBackground(imageData.data, workArea, nearSeedMask.mask, tuning);

  if (foreground.count === 0 || background.count === 0) {
    return { ok: false, reason: "technical" };
  }

  const mask = new Uint8ClampedArray(workArea.width * workArea.height);
  let foregroundCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const scoreContext: PixelScoreContext = {
    data: imageData.data,
    workArea,
    seedMask,
    nearSeedMask,
    foreground,
    background,
    border: Math.max(2, Math.round(Math.min(workArea.width, workArea.height) * 0.04)),
    tuning
  };

  for (let y = 0; y < workArea.height; y += 1) {
    const imageY = workArea.y + y;
    for (let x = 0; x < workArea.width; x += 1) {
      const imageX = workArea.x + x;
      const maskIndex = y * workArea.width + x;
      const score = scoreMaskPixel(scoreContext, maskIndex, imageX, imageY, x, y, {
        useSeedPrior: false
      });

      if (score > tuning.scoreThreshold) {
        mask[maskIndex] = 255;
        foregroundCount += 1;
        minX = Math.min(minX, imageX);
        minY = Math.min(minY, imageY);
        maxX = Math.max(maxX, imageX);
        maxY = Math.max(maxY, imageY);
      }
    }
  }

  const result = createMaskResultFromBounds(
    sourceCanvas,
    workArea,
    mask,
    foregroundCount,
    minX,
    minY,
    maxX,
    maxY,
    tuning,
    true
  );
  return result ? { ok: true, result } : { ok: false, reason: "low-confidence" };
}

function createEmergencyMask(
  sourceCanvas: HTMLCanvasElement,
  selection: ObjectSeedSelection,
  tuning: ResolvedMaskTuning
): MaskResult {
  const seedBounds = normalizeRect(selection.bounds, sourceCanvas.width, sourceCanvas.height);
  const outputBounds = expandRectByPixels(
    seedBounds,
    outputPaddingFor(seedBounds, tuning),
    sourceCanvas.width,
    sourceCanvas.height
  );
  const seedMask = createEmergencySeedMask(outputBounds, selection);
  const foregroundBounds = seedMask.bounds ?? seedBounds;

  return {
    workArea: outputBounds,
    width: outputBounds.width,
    height: outputBounds.height,
    mask: seedMask.mask,
    foregroundBounds,
    outputBounds,
    foregroundRatio: seedMask.foregroundCount / Math.max(1, seedMask.mask.length),
    usedEmergency: true
  };
}

function createMaskResultFromBounds(
  sourceCanvas: HTMLCanvasElement,
  workArea: ImagePixelRect,
  mask: Uint8ClampedArray,
  foregroundCount: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  tuning: ResolvedMaskTuning,
  requireMinimumRatio: boolean
): MaskResult | null {
  let finalForegroundCount = foregroundCount;
  if (tuning.fillHoles) {
    finalForegroundCount += fillMaskHoles(mask, workArea.width, workArea.height);
  }

  const foregroundRatio = finalForegroundCount / Math.max(1, mask.length);
  if (
    finalForegroundCount === 0 ||
    (requireMinimumRatio && foregroundRatio < MIN_FOREGROUND_RATIO) ||
    foregroundRatio > MAX_FOREGROUND_RATIO
  ) {
    return null;
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
      outputPaddingFor(foregroundBounds, tuning),
      sourceCanvas.width,
      sourceCanvas.height
    ),
    foregroundRatio,
    usedEmergency: false
  };
}

function resolveMaskTuning(options: MaskTuningOptions): ResolvedMaskTuning {
  const sensitivity = clamp(options.sensitivity, -50, 50);
  const expansion = clamp(options.expansion, -50, 50);
  const edgeCleanup = clamp(options.edgeCleanup, -50, 50);
  const outputPadding = clamp(options.outputPadding, 0, 50);
  const seedInfluence = clamp(options.seedInfluence, -50, 50);
  const roughness = clamp(options.roughness, 0, 100);
  const fillHoles = clamp(options.fillHoles, 0, 1);
  const roughNoiseAmount = roughness <= 50 ? roughness : 50 + (roughness - 50) * 1.4;
  const scoreThreshold = 8 - sensitivity * 0.4;
  const expansionNormalized = (expansion + 50) / 100;

  return {
    scoreThreshold,
    growthScoreThreshold: scoreThreshold - expansion * 0.12,
    selectionPaddingRatio: clamp(SELECTION_PADDING_RATIO + expansion * 0.0016, 0.02, 0.18),
    growthRatio: clamp(0.35 + expansionNormalized * 1.4, 0.12, 1.75),
    useFullImageGrowth: expansion >= 45,
    nearSeedDilationRatio: clamp(0.03 + expansion * 0.0006 + seedInfluence * 0.00025, 0.01, 0.08),
    nearSeedDilationMinPx: NEAR_SEED_DILATION_MIN_PX,
    nearSeedDilationMaxPx: NEAR_SEED_DILATION_MAX_PX,
    inSeedPrior: 30 + seedInfluence * 0.3,
    nearSeedPrior: 10 + seedInfluence * 0.15,
    outsideSeedPrior: -12 - seedInfluence * 0.08,
    borderPenalty: -18 - edgeCleanup * 0.3,
    backgroundBorderRatio: clamp(0.08 + edgeCleanup * 0.0008, 0.03, 0.14),
    roughNoiseAmount,
    fillHoles: fillHoles >= 1,
    outputPaddingMinPx: OUTPUT_PADDING_MIN_PX + outputPadding,
    outputPaddingRatio: OUTPUT_PADDING_RATIO + outputPadding * 0.001,
    maxVisitedPixels: MAX_CONNECTED_VISITED_PIXELS,
    maxAcceptedPixels: MAX_CONNECTED_ACCEPTED_PIXELS
  };
}

function createGrowthArea(
  seedBounds: ImagePixelRect,
  sourceWidth: number,
  sourceHeight: number,
  tuning: ResolvedMaskTuning
): ImagePixelRect {
  if (tuning.useFullImageGrowth) {
    return {
      x: 0,
      y: 0,
      width: sourceWidth,
      height: sourceHeight
    };
  }

  return expandRectByRatio(seedBounds, tuning.growthRatio, sourceWidth, sourceHeight);
}

function scoreMaskPixel(
  context: PixelScoreContext,
  maskIndex: number,
  imageX: number,
  imageY: number,
  localX: number,
  localY: number,
  options: PixelScoreOptions
): number {
  const dataIndex = maskIndex * 4;
  const r = context.data[dataIndex];
  const g = context.data[dataIndex + 1];
  const b = context.data[dataIndex + 2];
  const foregroundDistance = colorDistance(r, g, b, context.foreground);
  const backgroundDistance = colorDistance(r, g, b, context.background);
  const inSeed = context.seedMask.mask[maskIndex] > 0;
  const nearSeed = context.nearSeedMask.mask[maskIndex] > 0;
  const onBorder =
    localX < context.border ||
    localY < context.border ||
    localX >= context.workArea.width - context.border ||
    localY >= context.workArea.height - context.border;
  const seedPrior = options.useSeedPrior
    ? inSeed
      ? context.tuning.inSeedPrior
      : nearSeed
        ? context.tuning.nearSeedPrior
        : context.tuning.outsideSeedPrior
    : 0;
  const borderPrior = onBorder ? context.tuning.borderPenalty : 0;
  const roughNoise = roughScoreNoise(imageX, imageY, context.tuning.roughNoiseAmount);
  return backgroundDistance - foregroundDistance + seedPrior + borderPrior + roughNoise;
}

function selectionHasSeed(selection: ObjectSeedSelection): boolean {
  switch (selection.kind) {
    case "brush":
      return selection.points.length > 0;
    case "lasso":
      return selection.polygon.length >= 3;
    case "rect":
      return selection.bounds.width > 0 && selection.bounds.height > 0;
  }
}

function createSeedMask(workArea: ImagePixelRect, selection: ObjectSeedSelection): SeedMask {
  switch (selection.kind) {
    case "brush":
      return createBrushMask(workArea, selection.points, 1);
    case "lasso":
      return createLassoMask(workArea, selection.polygon);
    case "rect":
      return createRectMask(workArea, selection.bounds);
  }
}

function createNearSeedMask(
  workArea: ImagePixelRect,
  selection: ObjectSeedSelection,
  seedMask: SeedMask,
  tuning: ResolvedMaskTuning
): SeedMask {
  if (selection.kind === "brush") {
    return createBrushMask(workArea, selection.points, 3);
  }

  return {
    mask: dilateMask(seedMask.mask, workArea.width, workArea.height, seedDilationRadius(workArea, tuning)),
    foregroundCount: seedMask.foregroundCount,
    bounds: seedMask.bounds
  };
}

function createEmergencySeedMask(workArea: ImagePixelRect, selection: ObjectSeedSelection): SeedMask {
  if (selection.kind === "brush") {
    return createBrushMask(workArea, selection.points, 1.5);
  }

  return createSeedMask(workArea, selection);
}

function createBrushMask(workArea: ImagePixelRect, points: BrushSeedPoint[], radiusMultiplier: number): SeedMask {
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

function createLassoMask(workArea: ImagePixelRect, polygon: ImagePixelPoint[]): SeedMask {
  const mask = new Uint8ClampedArray(workArea.width * workArea.height);
  if (polygon.length < 3) {
    return { mask, foregroundCount: 0, bounds: null };
  }

  const canvas = document.createElement("canvas");
  canvas.width = workArea.width;
  canvas.height = workArea.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return { mask, foregroundCount: 0, bounds: null };
  }

  context.fillStyle = "#fff";
  context.beginPath();
  context.moveTo(polygon[0].x - workArea.x, polygon[0].y - workArea.y);
  for (const point of polygon.slice(1)) {
    context.lineTo(point.x - workArea.x, point.y - workArea.y);
  }
  context.closePath();
  context.fill();

  const data = context.getImageData(0, 0, workArea.width, workArea.height).data;
  return maskFromAlphaData(workArea, mask, data);
}

function createRectMask(workArea: ImagePixelRect, rect: ImagePixelRect): SeedMask {
  const mask = new Uint8ClampedArray(workArea.width * workArea.height);
  let foregroundCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const left = clamp(Math.floor(rect.x), workArea.x, workArea.x + workArea.width - 1);
  const top = clamp(Math.floor(rect.y), workArea.y, workArea.y + workArea.height - 1);
  const right = clamp(Math.ceil(rect.x + rect.width), left + 1, workArea.x + workArea.width);
  const bottom = clamp(Math.ceil(rect.y + rect.height), top + 1, workArea.y + workArea.height);

  for (let imageY = top; imageY < bottom; imageY += 1) {
    const localY = imageY - workArea.y;
    for (let imageX = left; imageX < right; imageX += 1) {
      const localX = imageX - workArea.x;
      const maskIndex = localY * workArea.width + localX;
      mask[maskIndex] = 255;
      foregroundCount += 1;
      minX = Math.min(minX, imageX);
      minY = Math.min(minY, imageY);
      maxX = Math.max(maxX, imageX);
      maxY = Math.max(maxY, imageY);
    }
  }

  return seedMaskResult(mask, foregroundCount, minX, minY, maxX, maxY);
}

function maskFromAlphaData(
  workArea: ImagePixelRect,
  mask: Uint8ClampedArray,
  data: Uint8ClampedArray
): SeedMask {
  let foregroundCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (let y = 0; y < workArea.height; y += 1) {
    const imageY = workArea.y + y;
    for (let x = 0; x < workArea.width; x += 1) {
      const dataIndex = (y * workArea.width + x) * 4;
      if (data[dataIndex + 3] === 0) {
        continue;
      }

      const imageX = workArea.x + x;
      const maskIndex = y * workArea.width + x;
      mask[maskIndex] = 255;
      foregroundCount += 1;
      minX = Math.min(minX, imageX);
      minY = Math.min(minY, imageY);
      maxX = Math.max(maxX, imageX);
      maxY = Math.max(maxY, imageY);
    }
  }

  return seedMaskResult(mask, foregroundCount, minX, minY, maxX, maxY);
}

function seedMaskResult(
  mask: Uint8ClampedArray,
  foregroundCount: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): SeedMask {
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

function dilateMask(
  sourceMask: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number
): Uint8ClampedArray {
  if (radius <= 0) {
    return sourceMask.slice();
  }

  const horizontal = new Uint8ClampedArray(sourceMask.length);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    let active = 0;
    for (let x = 0; x <= Math.min(radius, width - 1); x += 1) {
      if (sourceMask[rowOffset + x] > 0) {
        active += 1;
      }
    }

    for (let x = 0; x < width; x += 1) {
      if (active > 0) {
        horizontal[rowOffset + x] = 255;
      }

      const removeX = x - radius;
      if (removeX >= 0 && sourceMask[rowOffset + removeX] > 0) {
        active -= 1;
      }

      const addX = x + radius + 1;
      if (addX < width && sourceMask[rowOffset + addX] > 0) {
        active += 1;
      }
    }
  }

  const result = new Uint8ClampedArray(sourceMask.length);
  for (let x = 0; x < width; x += 1) {
    let active = 0;
    for (let y = 0; y <= Math.min(radius, height - 1); y += 1) {
      if (horizontal[y * width + x] > 0) {
        active += 1;
      }
    }

    for (let y = 0; y < height; y += 1) {
      if (active > 0) {
        result[y * width + x] = 255;
      }

      const removeY = y - radius;
      if (removeY >= 0 && horizontal[removeY * width + x] > 0) {
        active -= 1;
      }

      const addY = y + radius + 1;
      if (addY < height && horizontal[addY * width + x] > 0) {
        active += 1;
      }
    }
  }

  return result;
}

function seedDilationRadius(workArea: ImagePixelRect, tuning: ResolvedMaskTuning): number {
  return clamp(
    Math.round(Math.min(workArea.width, workArea.height) * tuning.nearSeedDilationRatio),
    tuning.nearSeedDilationMinPx,
    tuning.nearSeedDilationMaxPx
  );
}

function sampleBackground(
  data: Uint8ClampedArray,
  workArea: ImagePixelRect,
  nearSeedMask: Uint8ClampedArray,
  tuning: ResolvedMaskTuning
): RgbMean {
  const border = Math.max(2, Math.round(Math.min(workArea.width, workArea.height) * tuning.backgroundBorderRatio));
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

function outputPaddingFor(rect: ImagePixelRect, tuning: ResolvedMaskTuning): number {
  return Math.max(tuning.outputPaddingMinPx, Math.round(Math.max(rect.width, rect.height) * tuning.outputPaddingRatio));
}

function fillMaskHoles(mask: Uint8ClampedArray, width: number, height: number): number {
  const pixelCount = width * height;
  if (pixelCount === 0) {
    return 0;
  }

  const reachableBackground = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueStart = 0;
  let queueEnd = 0;

  const enqueueBackground = (index: number): void => {
    if (index < 0 || index >= pixelCount || mask[index] > 0 || reachableBackground[index] > 0) {
      return;
    }

    reachableBackground[index] = 1;
    queue[queueEnd] = index;
    queueEnd += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueueBackground(x);
    enqueueBackground((height - 1) * width + x);
  }

  for (let y = 1; y < height - 1; y += 1) {
    enqueueBackground(y * width);
    enqueueBackground(y * width + width - 1);
  }

  while (queueStart < queueEnd) {
    const index = queue[queueStart];
    queueStart += 1;
    const y = Math.floor(index / width);
    const x = index - y * width;

    if (x > 0) {
      enqueueBackground(index - 1);
    }
    if (x < width - 1) {
      enqueueBackground(index + 1);
    }
    if (y > 0) {
      enqueueBackground(index - width);
    }
    if (y < height - 1) {
      enqueueBackground(index + width);
    }
  }

  let filledCount = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    if (mask[index] > 0 || reachableBackground[index] > 0) {
      continue;
    }

    mask[index] = 255;
    filledCount += 1;
  }

  return filledCount;
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

function roughScoreNoise(x: number, y: number, amount: number): number {
  if (amount <= 0) {
    return 0;
  }

  const fineAmount = Math.min(amount, 50);
  const extraAmount = Math.max(0, amount - 50);
  const fineNoise = (hashNoise(x, y) - 0.5) * fineAmount;
  if (extraAmount <= 0) {
    return fineNoise;
  }

  const mediumCell = clamp(Math.round(4 + extraAmount * 0.1), 4, 12);
  const broadCell = mediumCell * 3;
  const mediumNoise =
    (hashNoise(Math.floor(x / mediumCell), Math.floor(y / mediumCell)) - 0.5) * extraAmount * 1.4;
  const broadNoise =
    (hashNoise(Math.floor(x / broadCell), Math.floor(y / broadCell)) - 0.5) * extraAmount * 0.8;

  return fineNoise + mediumNoise + broadNoise;
}

function hashNoise(x: number, y: number): number {
  const value = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

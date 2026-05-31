export type ImagePixelPoint = {
  x: number;
  y: number;
};

export type ImagePixelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DisplayTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export type SourceImageCandidate = {
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

export type WorkbenchSession = {
  id: string;
  createdAt: number;
  candidate: SourceImageCandidate;
};

export type BrushSeedPoint = {
  x: number;
  y: number;
  radius: number;
};

export type ObjectSeedSelection = {
  kind: "brush" | "rect" | "lasso";
  bounds: ImagePixelRect;
  points: BrushSeedPoint[];
};

export type WorkbenchState =
  | "loading-source"
  | "ready"
  | "selecting-object"
  | "processing-mask"
  | "preview-ready"
  | "copying"
  | "copied"
  | "failed";

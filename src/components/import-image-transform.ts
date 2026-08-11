export const NORMALIZED_IMPORT_SIZE = 1024;
const fitInset = 1;

export type ImportEditMode = "crop" | "fit";

export interface ImportImageSize {
  width: number;
  height: number;
}

export interface ImportEditState {
  mode: ImportEditMode;
  rotation: number;
  zoom: number;
  panX: number;
  panY: number;
  background: string;
}

export interface ImportRenderTransform {
  scale: number;
  rotationRadians: number;
  panX: number;
  panY: number;
  rotatedWidth: number;
  rotatedHeight: number;
}

export function rotatedBounds(
  source: ImportImageSize,
  rotation: number,
): ImportImageSize {
  assertSize(source);
  const radians = degreesToRadians(rotation);
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  return {
    width: source.width * cosine + source.height * sine,
    height: source.width * sine + source.height * cosine,
  };
}

export function cropTransform(
  source: ImportImageSize,
  viewport: ImportImageSize = {
    width: NORMALIZED_IMPORT_SIZE,
    height: NORMALIZED_IMPORT_SIZE,
  },
  edit: Pick<ImportEditState, "rotation" | "zoom" | "panX" | "panY"> = {
    rotation: 0,
    zoom: 1,
    panX: 0,
    panY: 0,
  },
): ImportRenderTransform {
  assertSize(source);
  assertSize(viewport);
  const radians = degreesToRadians(edit.rotation);
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const requiredSourceWidth = viewport.width * cosine + viewport.height * sine;
  const requiredSourceHeight = viewport.width * sine + viewport.height * cosine;
  const baseScale = Math.max(
    requiredSourceWidth / source.width,
    requiredSourceHeight / source.height,
  );
  const zoom = clamp(edit.zoom, 1, 4);
  const scale = baseScale * zoom;
  const bounds = rotatedBounds(source, edit.rotation);
  const maximumPanX = Math.max(0, (bounds.width * scale - viewport.width) / 2);
  const maximumPanY = Math.max(
    0,
    (bounds.height * scale - viewport.height) / 2,
  );
  return {
    scale,
    rotationRadians: radians,
    panX: clamp(edit.panX, -maximumPanX, maximumPanX),
    panY: clamp(edit.panY, -maximumPanY, maximumPanY),
    rotatedWidth: bounds.width * scale,
    rotatedHeight: bounds.height * scale,
  };
}

export function fitTransform(
  source: ImportImageSize,
  viewport: ImportImageSize = {
    width: NORMALIZED_IMPORT_SIZE,
    height: NORMALIZED_IMPORT_SIZE,
  },
  rotation = 0,
): ImportRenderTransform {
  assertSize(source);
  assertSize(viewport);
  const bounds = rotatedBounds(source, rotation);
  const safeWidth = Math.max(1, viewport.width - fitInset * 2);
  const safeHeight = Math.max(1, viewport.height - fitInset * 2);
  const scale = Math.min(safeWidth / bounds.width, safeHeight / bounds.height);
  return {
    scale,
    rotationRadians: degreesToRadians(rotation),
    panX: 0,
    panY: 0,
    rotatedWidth: bounds.width * scale,
    rotatedHeight: bounds.height * scale,
  };
}

export function transformForEdit(
  source: ImportImageSize,
  edit: ImportEditState,
  viewport?: ImportImageSize,
): ImportRenderTransform {
  return edit.mode === "fit"
    ? fitTransform(source, viewport, edit.rotation)
    : cropTransform(source, viewport, edit);
}

export async function renderNormalizedImport(
  source: CanvasImageSource & ImportImageSize,
  edit: ImportEditState,
): Promise<Blob> {
  const canvas = createCanvas();
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image rendering is unavailable");
  const transform = transformForEdit(source, edit);
  context.save();
  context.fillStyle = edit.mode === "fit" ? edit.background : "#000000";
  context.fillRect(0, 0, NORMALIZED_IMPORT_SIZE, NORMALIZED_IMPORT_SIZE);
  context.translate(
    NORMALIZED_IMPORT_SIZE / 2 + transform.panX,
    NORMALIZED_IMPORT_SIZE / 2 + transform.panY,
  );
  context.rotate(transform.rotationRadians);
  context.scale(transform.scale, transform.scale);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  context.restore();
  return encodePng(canvas);
}

function createCanvas(): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(NORMALIZED_IMPORT_SIZE, NORMALIZED_IMPORT_SIZE);
  }
  if (typeof document === "undefined") {
    throw new Error("Image rendering requires a browser canvas");
  }
  const canvas = document.createElement("canvas");
  canvas.width = NORMALIZED_IMPORT_SIZE;
  canvas.height = NORMALIZED_IMPORT_SIZE;
  return canvas;
}

function encodePng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if (
    typeof OffscreenCanvas !== "undefined" &&
    canvas instanceof OffscreenCanvas
  ) {
    return canvas.convertToBlob({ type: "image/png" });
  }
  const htmlCanvas = canvas as HTMLCanvasElement;
  return new Promise((resolve, reject) => {
    htmlCanvas.toBlob((blob: Blob | null) => {
      if (blob) resolve(blob);
      else reject(new Error("The normalized PNG could not be encoded"));
    }, "image/png");
  });
}

function assertSize(size: ImportImageSize): void {
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new Error("Image dimensions must be positive finite numbers");
  }
}

function degreesToRadians(rotation: number): number {
  if (!Number.isFinite(rotation)) throw new Error("Rotation must be finite");
  return (rotation * Math.PI) / 180;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

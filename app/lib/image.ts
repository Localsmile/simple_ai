const WEBP_QUALITY = 0.82;
const MAX_IMAGE_EDGE = 4096;
const PASSTHROUGH_TYPES = new Set(["image/gif", "image/svg+xml", "image/webp"]);

export const MAX_IMAGE_SOURCE_SIZE = 40 * 1024 * 1024;

function webpName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "") || "image";
  return `${base}.webp`;
}

function loadImage(file: File): Promise<{ image: HTMLImageElement; objectUrl: string }> {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";

  return new Promise((resolve, reject) => {
    image.onload = () => resolve({ image, objectUrl });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("이미지를 읽을 수 없습니다."));
    };
    image.src = objectUrl;
  });
}

function canvasToWebp(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", WEBP_QUALITY));
}

export async function optimizeImageToWebp(file: File): Promise<File> {
  if (PASSTHROUGH_TYPES.has(file.type.toLowerCase())) return file;

  let loaded: { image: HTMLImageElement; objectUrl: string };
  try {
    loaded = await loadImage(file);
  } catch {
    return file;
  }

  try {
    const { naturalWidth, naturalHeight } = loaded.image;
    if (!naturalWidth || !naturalHeight) return file;

    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(loaded.image, 0, 0, width, height);
    const blob = await canvasToWebp(canvas);
    if (!blob || blob.type !== "image/webp" || blob.size >= file.size) return file;

    return new File([blob], webpName(file.name), {
      type: "image/webp",
      lastModified: file.lastModified,
    });
  } finally {
    URL.revokeObjectURL(loaded.objectUrl);
  }
}

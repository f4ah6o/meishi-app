/** Scale factor capping the longest side at maxDim (never upscales). */
export function scaleForMaxDim(width: number, height: number, maxDim: number): number {
  const longest = Math.max(width, height);
  return longest > 0 ? Math.min(1, maxDim / longest) : 1;
}

/**
 * Re-encode a picked photo through canvas: iOS may hand the file input a
 * HEIC image unchanged, which the gateway cannot decode. Safari decodes
 * HEIC into <img>, so drawing it to a canvas and exporting JPEG both
 * normalizes the format and bounds the size for the upload limit.
 */
export async function fileToJpegDataUrl(file: File, maxDim = 2048, quality = 0.9): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("unsupported image"));
      el.src = objectUrl;
    });
    const scale = scaleForMaxDim(img.naturalWidth, img.naturalHeight, maxDim);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

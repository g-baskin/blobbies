/**
 * Photos the Blob can actually see.
 *
 * An attached image is always OCR'd to text (attachments.ts) — that is what a
 * text-only model gets. Alongside it a downscaled JPEG is kept as a base64
 * sidecar in the Blob's home folder; when the selected model accepts images
 * (`modelSeesImages`: Tinfoil's catalog flag, Ollama's capabilities), the
 * newest message's photos go to it as real image content.
 */
import type { Attachment } from "@/lib/attachments";
import type { HomeBackend } from "@/lib/home";

/** Longest edge sent to a vision model; plenty for reading a photo or a page. */
export const VISION_MAX_EDGE = 1024;
const VISION_QUALITY = 0.8;
/** Home-folder files are capped at 256 KB; stay under with margin. */
export const MAX_SIDECAR_CHARS = 240_000;

export const SIDECAR_SUFFIX = ".vision.b64";

export function sidecarName(savedName: string): string {
  return `${savedName}${SIDECAR_SUFFIX}`;
}

/** Downscaled JPEG as bare base64, or undefined where no canvas is available. */
export async function downscaleImage(bytes: Uint8Array): Promise<string | undefined> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return undefined;
  }
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
    if (bitmap.width * bitmap.height > 50_000_000) {
      return undefined;
    }
    for (const edge of [VISION_MAX_EDGE, 768, 512]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (context === null) {
        return undefined;
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", VISION_QUALITY).split(",")[1] ?? "";
      if (data !== "" && data.length <= MAX_SIDECAR_CHARS) {
        return data;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    bitmap?.close();
  }
}

type ImageBlock = { type: "image"; mediaType: string; data: string };
type TextBlock = { type: "text"; text: string };

/**
 * The content of one user message: plain text (OCR path, or a model that
 * cannot see), or text plus image blocks for a vision model.
 */
export function messageContent(
  text: string,
  images: readonly string[],
  seesImages: boolean,
): string | (TextBlock | ImageBlock)[] {
  if (images.length === 0 || !seesImages) {
    return text;
  }
  return [
    { type: "text", text },
    ...images.map((data) => ({ type: "image" as const, mediaType: "image/jpeg", data })),
  ];
}

/** Read back a message's photo sidecars. Missing ones are skipped. */
export async function loadVisionImages(
  home: HomeBackend,
  attachments: readonly Attachment[],
): Promise<string[]> {
  const images: string[] = [];
  for (const attachment of attachments) {
    if (attachment.vision === undefined) {
      continue;
    }
    try {
      const data = (await home.read(attachment.vision)).trim();
      if (/^[A-Za-z0-9+/=]+$/.test(data)) {
        images.push(data);
      }
    } catch {
      // Deleted from the files folder: the OCR text still stands in.
    }
  }
  return images;
}

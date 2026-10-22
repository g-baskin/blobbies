import { describe, expect, it } from "vitest";
import type { HomeBackend } from "@/lib/home";
import { loadVisionImages, messageContent } from "@/lib/vision";

describe("vision vs OCR routing", () => {
  it("keeps plain OCR text for a model that cannot see", () => {
    expect(messageContent("ocr text", ["AAAA"], false)).toBe("ocr text");
    expect(messageContent("ocr text", [], true)).toBe("ocr text");
  });

  it("sends real image content to a vision model", () => {
    expect(messageContent("look", ["AAAA"], true)).toEqual([
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/jpeg", data: "AAAA" },
    ]);
  });

  it("reads sidecars back and skips missing or malformed ones", async () => {
    const files: Record<string, string> = {
      "a.vision.b64": "QUJD\n",
      "bad.vision.b64": "<script>",
    };
    const home = {
      id: "b",
      read: async (path: string) => {
        const f = files[path];
        if (f === undefined) throw new Error("x");
        return f;
      },
    } as unknown as HomeBackend;
    const images = await loadVisionImages(home, [
      { name: "a.png.txt", bytes: 1, vision: "a.vision.b64" },
      { name: "b.png.txt", bytes: 1, vision: "gone.vision.b64" },
      { name: "c.png.txt", bytes: 1, vision: "bad.vision.b64" },
      { name: "plain.txt", bytes: 1 },
    ]);
    expect(images).toEqual(["QUJD"]);
  });
});

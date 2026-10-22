import { describe, expect, it, vi } from "vitest";
import {
  extensionFor,
  pickRecorderMime,
  speechBody,
  synthesize,
  TRANSCRIBE_MODEL,
  transcribe,
} from "@/lib/voice";

describe("voice requests", () => {
  it("builds a whisper transcription request with the right file extension", async () => {
    const fetcher = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: " hello " })),
    );
    const text = await transcribe(new Blob(["x"], { type: "audio/mp4" }), { fetcher });
    expect(text).toBe("hello");
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("/v1/audio/transcriptions");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe(TRANSCRIBE_MODEL);
    expect((form.get("file") as File).name).toBe("speech.m4a");
  });

  it("builds a TTS request and returns wav audio", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const audio = await synthesize("**Hi** [there](https://x.y)", { fetcher });
    expect(audio.type).toBe("audio/wav");
    expect(JSON.parse(speechBody("**Hi** [there](https://x.y)"))).toMatchObject({
      model: "qwen3-tts",
      voice: "serena",
      input: "Hi there",
    });
  });

  it("surfaces HTTP failures", async () => {
    await expect(
      transcribe(new Blob(["x"]), { fetcher: async () => new Response("", { status: 401 }) }),
    ).rejects.toThrow("401");
  });

  it("picks the recorder format per engine", () => {
    expect(pickRecorderMime((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecorderMime((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(extensionFor("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionFor("audio/ogg")).toBe("ogg");
  });
});

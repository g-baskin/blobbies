/**
 * Speech in and out, through Tinfoil enclaves only.
 *
 * Audio is user content, so it goes exactly where text goes: through
 * `tinfoilFetch` (attested enclave, HPKE-encrypted body). Never the Web Speech
 * API — Chrome's SpeechRecognition ships audio to Google.
 *
 * This module imports `@/lib/tinfoil` lazily, so UI code may import it
 * statically without pulling the provider stack into the startup bundle.
 */

export const TRANSCRIBE_MODEL = "whisper-large-v3-turbo";
export const TTS_MODEL = "qwen3-tts";
export const TTS_VOICE = "serena";

/** Spoken replies are clipped: TTS latency grows with length. */
export const MAX_TTS_CHARS = 2_000;

export const NO_KEY_MESSAGE = "Voice needs a Tinfoil key — add one in Settings → Model.";

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

async function defaultFetch(): Promise<Fetcher> {
  const tinfoil = await import("@/lib/tinfoil");
  return (input, init) => tinfoil.tinfoilFetch(input, init);
}

/** True when a Tinfoil key is stored (the only voice backend). */
export async function voiceAvailable(): Promise<boolean> {
  try {
    const tinfoil = await import("@/lib/tinfoil");
    return await tinfoil.configureTinfoilFromKeychain();
  } catch {
    return false;
  }
}

/** File extension for a recorder MIME type (Whisper sniffs by name too). */
export function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.includes("mp4") || base.includes("m4a") || base.includes("aac")) {
    return "m4a";
  }
  if (base.includes("ogg")) {
    return "ogg";
  }
  if (base.includes("wav")) {
    return "wav";
  }
  if (base.includes("mpeg") || base.includes("mp3")) {
    return "mp3";
  }
  return "webm";
}

/** Best recorder format this engine supports: webm on Android/Chrome, mp4 on WebKit. */
export function pickRecorderMime(
  isSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
): string | undefined {
  for (const type of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ]) {
    if (isSupported(type)) {
      return type;
    }
  }
  return undefined;
}

/** The multipart body for `/v1/audio/transcriptions`. */
export function transcriptionForm(audio: Blob): FormData {
  const form = new FormData();
  const type = audio.type === "" ? "audio/webm" : audio.type;
  form.append("file", new File([audio], `speech.${extensionFor(type)}`, { type }));
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  return form;
}

/** Audio → text via Whisper in an enclave. Throws with a user-facing message. */
export async function transcribe(
  audio: Blob,
  options: { signal?: AbortSignal; fetcher?: Fetcher } = {},
): Promise<string> {
  const fetcher = options.fetcher ?? (await defaultFetch());
  const response = await fetcher("/v1/audio/transcriptions", {
    method: "POST",
    body: transcriptionForm(audio),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    throw new Error(`Couldn't transcribe that (HTTP ${response.status}).`);
  }
  const payload = (await response.json()) as { text?: unknown };
  return typeof payload.text === "string" ? payload.text.trim() : "";
}

/** Markdown → something worth saying out loud. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TTS_CHARS);
}

/** The JSON body for `/v1/audio/speech`. */
export function speechBody(text: string): string {
  return JSON.stringify({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: speakableText(text),
    response_format: "wav",
  });
}

/** Text → WAV audio via Tinfoil TTS. */
export async function synthesize(
  text: string,
  options: { signal?: AbortSignal; fetcher?: Fetcher } = {},
): Promise<Blob> {
  const fetcher = options.fetcher ?? (await defaultFetch());
  const response = await fetcher("/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: speechBody(text),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    throw new Error(`Couldn't speak that (HTTP ${response.status}).`);
  }
  return new Blob([await response.arrayBuffer()], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Recording and playback with live level, for the animated avatar.

export interface Recording {
  /** Resolves with the recorded audio once `stop()` is called. */
  done: Promise<Blob>;
  stop: () => void;
  cancel: () => void;
  /** 0..1 input loudness right now. */
  level: () => number;
}

function meter(context: AudioContext, source: AudioNode): () => number {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  return () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const value of data) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    return Math.min(1, Math.sqrt(sum / data.length) * 4);
  };
}

/** Start recording from the microphone. Throws if access is refused. */
export async function startRecording(): Promise<Recording> {
  if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) {
    throw new Error("This device has no microphone access here.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickRecorderMime();
  const recorder = new MediaRecorder(stream, mimeType === undefined ? {} : { mimeType });
  const chunks: Blob[] = [];
  let context: AudioContext | null = null;
  let level = () => 0;
  try {
    context = new AudioContext();
    level = meter(context, context.createMediaStreamSource(stream));
  } catch {
    // No level metering; recording still works.
  }
  const release = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    void context?.close();
  };
  let cancelled = false;
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      release();
      if (cancelled) {
        reject(new Error("cancelled"));
        return;
      }
      resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
    };
  });
  recorder.start();
  return {
    done,
    level,
    stop: () => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    },
    cancel: () => {
      cancelled = true;
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    },
  };
}

export interface Playback {
  done: Promise<void>;
  stop: () => void;
  level: () => number;
}

/** Play audio, exposing its output level. */
export function play(audio: Blob): Playback {
  const url = URL.createObjectURL(audio);
  const element = new Audio(url);
  let level = () => 0;
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    const source = context.createMediaElementSource(element);
    source.connect(context.destination);
    level = meter(context, source);
  } catch {
    // Plays without a meter.
  }
  const cleanup = () => {
    URL.revokeObjectURL(url);
    void context?.close();
  };
  const done = new Promise<void>((resolve) => {
    element.onended = () => {
      cleanup();
      resolve();
    };
    element.onerror = () => {
      cleanup();
      resolve();
    };
    element.play().catch(() => {
      cleanup();
      resolve();
    });
  });
  return {
    done,
    level,
    stop: () => {
      element.pause();
      element.dispatchEvent(new Event("ended"));
    },
  };
}

const READ_ALOUD_KEY = "pref:readRepliesAloud";

export function readRepliesAloud(): boolean {
  try {
    return localStorage.getItem(READ_ALOUD_KEY) === "true";
  } catch {
    return false;
  }
}

export function setReadRepliesAloud(on: boolean): void {
  try {
    localStorage.setItem(READ_ALOUD_KEY, on ? "true" : "false");
  } catch {
    // Not persisted.
  }
}

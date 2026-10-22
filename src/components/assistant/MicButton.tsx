import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./assistant.css";
import type { Recording } from "@/lib/voice";

const loadVoice = () => import("@/lib/voice");

/**
 * Tap to record, tap again to transcribe (Whisper in a Tinfoil enclave).
 * The text lands in the composer through `onText`.
 */
export function MicButton({
  onText,
  onHint,
}: {
  onText: (text: string) => void;
  /** A short explanation to show near the composer, or null to clear it. */
  onHint: (hint: string | null) => void;
}) {
  const [state, setState] = useState<"idle" | "recording" | "working">("idle");
  const recording = useRef<Recording | null>(null);
  // Leaving the chat mid-recording must release the microphone.
  useEffect(
    () => () => {
      const current = recording.current;
      current?.done.catch(() => {});
      current?.cancel();
    },
    [],
  );

  const toggle = async () => {
    if (state === "working") {
      return;
    }
    if (state === "recording") {
      const current = recording.current;
      recording.current = null;
      setState("working");
      current?.stop();
      try {
        const audio = await current?.done;
        const text = audio === undefined ? "" : await (await loadVoice()).transcribe(audio);
        if (text !== "") {
          onText(text);
        }
        onHint(text === "" ? "Didn't catch anything — try again." : null);
      } catch (error) {
        onHint(error instanceof Error ? error.message : "Couldn't transcribe that.");
      } finally {
        setState("idle");
      }
      return;
    }
    if (!(await (await loadVoice()).voiceAvailable())) {
      onHint((await loadVoice()).NO_KEY_MESSAGE);
      return;
    }
    try {
      recording.current = await (await loadVoice()).startRecording();
      setState("recording");
      onHint("Listening… tap again to stop.");
    } catch {
      onHint("Microphone access was refused.");
    }
  };

  return (
    <button
      type="button"
      className="icon-button voice-mic"
      aria-label={state === "recording" ? "Stop recording" : "Dictate a message"}
      data-recording={state === "recording"}
      disabled={state === "working"}
      onClick={() => void toggle()}
    >
      {state === "recording" ? (
        <Square size={13} fill="currentColor" strokeWidth={0} aria-hidden="true" />
      ) : (
        <Mic size={16} strokeWidth={2} aria-hidden="true" />
      )}
    </button>
  );
}

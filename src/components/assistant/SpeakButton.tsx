import { Volume2 } from "lucide-react";
import { useRef, useState } from "react";
import "./assistant.css";
import type { Playback } from "@/lib/voice";

const loadVoice = () => import("@/lib/voice");

/** Per-message "read aloud" through Tinfoil TTS. */
export function SpeakButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [note, setNote] = useState<string | null>(null);
  const playback = useRef<Playback | null>(null);
  const toggle = async () => {
    if (state === "playing") {
      playback.current?.stop();
      return;
    }
    if (!(await (await loadVoice()).voiceAvailable())) {
      setNote((await loadVoice()).NO_KEY_MESSAGE);
      return;
    }
    setState("loading");
    try {
      const current = (await loadVoice()).play(await (await loadVoice()).synthesize(text));
      playback.current = current;
      setState("playing");
      await current.done;
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Couldn't play that.");
    } finally {
      playback.current = null;
      setState("idle");
    }
  };
  return (
    <span>
      <button
        type="button"
        className="turn-failed-action speak-button"
        aria-label={state === "playing" ? "Stop reading aloud" : "Read aloud"}
        disabled={state === "loading"}
        onClick={() => void toggle()}
      >
        <Volume2 size={13} aria-hidden="true" /> {state === "playing" ? "Stop" : "Listen"}
      </button>
      {note === null ? null : <span className="voice-hint">{note}</span>}
    </span>
  );
}

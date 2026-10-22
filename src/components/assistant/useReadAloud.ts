import { useEffect, useRef } from "react";
import type { Message } from "@/data/agents";
import { readPreference } from "@/lib/preferences";

/**
 * "Read replies aloud": when a turn ends, speak the Blob's newest reply
 * through Tinfoil TTS. Off while voice mode runs (it speaks for itself).
 */
export function useReadAloud(messages: readonly Message[], thinking: boolean, paused: boolean) {
  const wasThinking = useRef(thinking);
  useEffect(() => {
    const finished = wasThinking.current && !thinking;
    wasThinking.current = thinking;
    if (!finished || paused || readPreference("pref:readRepliesAloud", "false") !== "true") {
      return;
    }
    const last = messages[messages.length - 1];
    if (last?.kind !== "text" || last.author !== "agent") {
      return;
    }
    const text = last.segments.map((segment) => segment.text).join("");
    void import("@/lib/voice")
      .then(async (voice) => voice.play(await voice.synthesize(text)).done)
      .catch(() => {
        // Without a key or on failure the reply simply stays silent.
      });
  }, [thinking, messages, paused]);
}

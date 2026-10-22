import { useEffect, useRef, useState } from "react";
import "./assistant.css";
import { AnimatedBlob, type BlobMood } from "@/components/assistant/AnimatedBlob";
import type { Agent, Message } from "@/data/agents";
import {
  NO_KEY_MESSAGE,
  type Playback,
  play,
  type Recording,
  speakableText,
  startRecording,
  synthesize,
  transcribe,
  voiceAvailable,
} from "@/lib/voice";

/** Silence after speech that ends a spoken turn. */
const SILENCE_MS = 1_400;
const SPEECH_LEVEL = 0.08;
const MAX_TURN_MS = 30_000;

function lastAgentText(messages: readonly Message[]): { id: string; text: string } | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.kind === "text" && message.author === "agent") {
      return { id: message.id, text: message.segments.map((segment) => segment.text).join("") };
    }
    if (message?.kind === "text" && message.author === "user") {
      return null;
    }
  }
  return null;
}

/**
 * Hands-free conversation with one Blob: listen → think → speak → listen.
 * Turns go through the normal `onSend`, so transcript and memories are the
 * same as typed chat. Tap the Blob to interrupt; End to leave.
 */
export function VoiceMode({
  agent,
  messages,
  thinking,
  onSend,
  onClose,
}: {
  agent: Agent;
  messages: readonly Message[];
  thinking: boolean;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [mood, setMood] = useState<BlobMood>("idle");
  const [caption, setCaption] = useState("");
  const [level, setLevel] = useState<(() => number) | undefined>(undefined);
  const recording = useRef<Recording | null>(null);
  const playback = useRef<Playback | null>(null);
  const awaitingReply = useRef(false);
  const spokenId = useRef<string | null>(lastAgentText(messages)?.id ?? null);
  const closed = useRef(false);

  const listen = async () => {
    if (closed.current) {
      return;
    }
    try {
      const current = await startRecording();
      recording.current = current;
      setLevel(() => current.level);
      setMood("listening");
      setCaption("");
      // End the turn after a pause that follows some speech.
      const started = Date.now();
      let heard = false;
      let quietSince = Date.now();
      const watch = window.setInterval(() => {
        const now = Date.now();
        if (current.level() > SPEECH_LEVEL) {
          heard = true;
          quietSince = now;
        }
        if ((heard && now - quietSince > SILENCE_MS) || now - started > MAX_TURN_MS) {
          window.clearInterval(watch);
          current.stop();
        }
      }, 100);
      const audio = await current.done.finally(() => window.clearInterval(watch));
      recording.current = null;
      setLevel(undefined);
      if (closed.current) {
        return;
      }
      setMood("thinking");
      const text = await transcribe(audio);
      if (text === "") {
        void listen();
        return;
      }
      setCaption(`You: ${text}`);
      awaitingReply.current = true;
      onSend(text);
    } catch (error) {
      recording.current = null;
      setLevel(undefined);
      if (!closed.current && !(error instanceof Error && error.message === "cancelled")) {
        setMood("idle");
        setCaption(error instanceof Error ? error.message : "Something went wrong.");
      }
    }
  };

  // Start once the key is confirmed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only
  useEffect(() => {
    void voiceAvailable().then((ok) => {
      if (ok) {
        void listen();
      } else {
        setCaption(NO_KEY_MESSAGE);
      }
    });
    return () => {
      closed.current = true;
      recording.current?.cancel();
      playback.current?.stop();
    };
  }, []);

  // When the turn finishes, speak the reply and listen again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: driven by turn end
  useEffect(() => {
    if (!awaitingReply.current || thinking) {
      return;
    }
    const reply = lastAgentText(messages);
    if (reply === null || reply.id === spokenId.current) {
      return;
    }
    awaitingReply.current = false;
    spokenId.current = reply.id;
    setCaption(speakableText(reply.text));
    void (async () => {
      try {
        const audio = await synthesize(reply.text);
        if (closed.current) {
          return;
        }
        const current = play(audio);
        playback.current = current;
        setLevel(() => current.level);
        setMood("speaking");
        await current.done;
      } catch {
        // Caption already shows the reply.
      }
      playback.current = null;
      setLevel(undefined);
      void listen();
    })();
  }, [thinking, messages]);

  const interrupt = () => {
    if (mood === "speaking") {
      playback.current?.stop();
    } else if (mood === "listening") {
      recording.current?.stop();
    } else if (mood === "idle") {
      void listen();
    }
  };

  const stateLabel =
    mood === "listening"
      ? "Listening…"
      : mood === "thinking"
        ? "Thinking…"
        : mood === "speaking"
          ? "Speaking — tap to interrupt"
          : "Tap to talk";

  return (
    <div className="voice-mode" role="dialog" aria-label={`Talking with ${agent.name}`}>
      <button type="button" className="voice-mode-stage" onClick={interrupt}>
        <AnimatedBlob
          tone={agent.tone}
          shape={agent.shape}
          size={180}
          mood={thinking && mood !== "speaking" ? "thinking" : mood}
          level={level}
        />
        <span className="voice-mode-state">{stateLabel}</span>
        <span className="voice-mode-caption" aria-live="polite">
          {caption}
        </span>
      </button>
      <button
        type="button"
        className="voice-mode-end"
        onClick={() => {
          closed.current = true;
          onClose();
        }}
      >
        End
      </button>
    </div>
  );
}

import { useEffect, useRef } from "react";
import "./assistant.css";
import { BlobAvatar } from "@/components/BlobAvatar";
import type { AgentShape, AvatarTone } from "@/data/agents";
import { prefersReducedMotion } from "@/lib/motion";

export type BlobMood = "idle" | "listening" | "thinking" | "speaking";

/**
 * The Blob, alive: the same avatar wrapped in a squishy body whose motion
 * follows its state, and — listening or speaking — the live audio level.
 * The level drives one CSS variable per frame; the rest is CSS on
 * `--ease-squish`, switched off under prefers-reduced-motion.
 */
export function AnimatedBlob({
  tone,
  shape,
  size = 160,
  mood,
  level,
}: {
  tone: AvatarTone;
  shape?: AgentShape | undefined;
  size?: number;
  mood: BlobMood;
  /** 0..1 audio level, polled per frame while listening or speaking. */
  level?: (() => number) | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node === null || level === undefined || prefersReducedMotion()) {
      node?.style.setProperty("--blob-level", "0");
      return;
    }
    let frame = 0;
    let smooth = 0;
    const tick = () => {
      smooth = smooth * 0.7 + level() * 0.3;
      node.style.setProperty("--blob-level", smooth.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level]);
  return (
    <div ref={ref} className={`animated-blob animated-blob-${mood}`} data-mood={mood}>
      <BlobAvatar
        tone={tone}
        {...(shape === undefined ? {} : { shape })}
        size={size}
        variant={mood === "thinking" ? "thinking" : "idle"}
      />
    </div>
  );
}

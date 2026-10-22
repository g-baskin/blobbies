import { useState } from "react";
import { type ApprovalMode, readApprovalMode, writeApprovalMode } from "@/lib/approvals";
import { readRepliesAloud, setReadRepliesAloud } from "@/lib/voice";

/** Settings → General: voice and ask-before-acting. Self-contained preferences. */
export function AssistantSettings() {
  const [aloud, setAloud] = useState(readRepliesAloud);
  const [mode, setMode] = useState<ApprovalMode>(readApprovalMode);
  return (
    <>
      <p className="modal-section-label">Assistant</p>
      <div className="modal-card">
        <div className="modal-row modal-row-multiline">
          <span className="modal-row-text">
            <label className="modal-row-title" htmlFor="read-aloud-toggle">
              Read replies aloud
            </label>
            <span className="modal-row-blurb">
              Speak each reply with Tinfoil's private text-to-speech. Needs a Tinfoil key (Settings
              → Model).
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={aloud}
            id="read-aloud-toggle"
            className={aloud ? "toggle toggle-on" : "toggle"}
            onClick={() => {
              setReadRepliesAloud(!aloud);
              setAloud(!aloud);
            }}
          >
            <span className="toggle-knob" aria-hidden="true" />
          </button>
        </div>
        <div className="modal-row modal-row-multiline">
          <span className="modal-row-text">
            <label className="modal-row-title" htmlFor="approval-mode">
              Ask before actions
            </label>
            <span className="modal-row-blurb">
              Sensitive only asks before sending, writing, deleting, running or messaging. Reading
              never asks.
            </span>
          </span>
          <select
            id="approval-mode"
            value={mode}
            onChange={(event) => {
              const next = event.currentTarget.value as ApprovalMode;
              writeApprovalMode(next);
              setMode(next);
            }}
          >
            <option value="sensitive">Sensitive only</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </div>
      </div>
    </>
  );
}

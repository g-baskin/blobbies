import { createPortal } from "react-dom";
import type { ApprovalAnswer } from "@/lib/app-approval";

/** One request as the card shows it. */
export interface AppApprovalPrompt {
  /** The Blob asking, by name. */
  blobName: string;
  /** The app, by its display name ("Gmail"), else its slug. */
  appName: string;
  /** The action in plain words ("Send email"). */
  action: string;
  /** The model's arguments, exactly as it sent them. */
  arguments: string;
}

interface AppApprovalDialogProps {
  prompt: AppApprovalPrompt;
  /** Requests queued behind this one, so a burst does not look like a loop. */
  waiting: number;
  onAnswer: (answer: ApprovalAnswer) => void;
}

/** Longest arguments preview; the rest is cut and says so. */
const MAX_PREVIEW_CHARS = 4000;

/**
 * The arguments, readable: pretty JSON when it parses, the raw text when not.
 * A model's malformed JSON is still exactly what would be sent, so it is
 * shown rather than hidden.
 */
function preview(raw: string): string {
  let text = raw.trim();
  try {
    text = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Shown as sent.
  }
  if (text === "" || text === "{}") {
    return "(no details)";
  }
  return text.length > MAX_PREVIEW_CHARS
    ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n\u2026 (${text.length - MAX_PREVIEW_CHARS} more characters)`
    : text;
}

/**
 * "Scout wants to send an email in Gmail."
 *
 * The one place a person decides whether a Blob may act in their apps with
 * their credentials, so it shows exactly what would be sent and defaults to
 * refusal: Escape, the backdrop and the autofocused button all say no.
 *
 * Everything shown came from the model, which may be repeating an email it
 * just read. React escapes it, and it sits in a <pre> under a label, so it
 * cannot pass itself off as the card's own wording.
 */
export function AppApprovalDialog({ prompt, waiting, onAnswer }: AppApprovalDialogProps) {
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss mirrors Escape
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the dialog
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onAnswer("deny");
        }
      }}
    >
      <div
        className="confirm-dialog approval-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-body"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onAnswer("deny");
          }
        }}
      >
        <h2 className="confirm-title" id="approval-title">
          Allow {prompt.blobName} to use {prompt.appName}?
        </h2>
        <p className="confirm-body" id="approval-body">
          <strong>{prompt.blobName}</strong> wants to <strong>{prompt.action.toLowerCase()}</strong>{" "}
          in <strong>{prompt.appName}</strong> with these details. Nothing is sent until you choose.
          {waiting > 0
            ? ` ${waiting} more ${waiting === 1 ? "request is" : "requests are"} waiting.`
            : ""}
        </p>
        <p className="approval-label">Details</p>
        <pre className="approval-args">{preview(prompt.arguments)}</pre>
        <div className="confirm-actions approval-actions">
          <button
            type="button"
            className="modal-button"
            // biome-ignore lint/a11y/noAutofocus: the safe choice takes focus, so Enter refuses
            autoFocus
            onClick={() => onAnswer("deny")}
          >
            Don't allow
          </button>
          <button type="button" className="modal-button" onClick={() => onAnswer("always")}>
            Always allow {prompt.appName}
          </button>
          <button type="button" className="modal-button" onClick={() => onAnswer("task")}>
            Allow for this task
          </button>
          <button type="button" className="modal-button" onClick={() => onAnswer("once")}>
            Allow once
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { createPortal } from "react-dom";

export type PairPrompt =
  | { kind: "confirm"; url: string }
  | { kind: "connecting" }
  | { kind: "invalid" }
  | { kind: "failed"; error: string };

interface SyncPairDialogProps {
  prompt: PairPrompt;
  onConnect: (url: string) => void;
  onClose: () => void;
}

/** Confirms a pair link before anything is accepted; never auto-accepts. */
export function SyncPairDialog({ prompt, onConnect, onClose }: SyncPairDialogProps) {
  const busy = prompt.kind === "connecting";
  return createPortal(
    <div className="modal-backdrop">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Connect sync"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
        }}
      >
        <h2 className="confirm-title">Sync</h2>
        <p className="confirm-body">
          {prompt.kind === "confirm"
            ? "Connect this phone to your Blobbies sync? Your Blobs and chats from your computer will appear here."
            : prompt.kind === "connecting"
              ? "Connecting… fetching your Blobs."
              : prompt.kind === "invalid"
                ? "That pairing code didn't work. Show a new one on your computer."
                : prompt.error}
        </p>
        <div className="confirm-actions">
          {busy ? null : (
            // biome-ignore lint/a11y/noAutofocus: the safe choice takes focus
            <button type="button" className="modal-button" autoFocus onClick={onClose}>
              {prompt.kind === "confirm" ? "Cancel" : "OK"}
            </button>
          )}
          {prompt.kind === "confirm" ? (
            <button type="button" className="modal-button" onClick={() => onConnect(prompt.url)}>
              Connect
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

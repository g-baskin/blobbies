import { useEffect, useState } from "react";
import "./assistant.css";
import { ModalShell } from "@/components/ModalShell";
import { type ActivityEntry, loadAllActivity, onActivityLogged } from "@/lib/activity-log";

const APPROVAL_LABEL = { auto: "auto", approved: "approved", denied: "denied" } as const;

/** Chronological (newest first) list of every tool call by these Blobs. */
export function ActivityLog({
  blobs,
  onClose,
}: {
  blobs: readonly { id: string; name: string }[];
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const ids = blobs.map((blob) => blob.id).join(",");
  useEffect(() => {
    const list = ids === "" ? [] : ids.split(",");
    const load = () => void loadAllActivity(list).then(setEntries);
    load();
    return onActivityLogged(load);
  }, [ids]);
  const nameOf = (id: string) => blobs.find((blob) => blob.id === id)?.name ?? "";
  return (
    <ModalShell
      title="Activity"
      ariaLabel="Activity log"
      {...(blobs.length === 1 ? { titleNote: blobs[0]?.name ?? "" } : {})}
      onClose={onClose}
    >
      {entries === null ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p>No actions yet.</p>
      ) : (
        <ul className="activity-log">
          {entries.map((entry) => (
            <li key={`${entry.blobId}-${entry.at}-${entry.tool}`}>
              <div className="activity-log-meta">
                {new Date(entry.at).toLocaleString()}
                {blobs.length > 1 ? ` · ${nameOf(entry.blobId)}` : ""} ·{" "}
                {APPROVAL_LABEL[entry.approval]}
              </div>
              <div>
                <strong>{entry.tool}</strong> {entry.args}
              </div>
              <div className={entry.isError ? "activity-log-error" : undefined}>
                {entry.summary}
              </div>
            </li>
          ))}
        </ul>
      )}
    </ModalShell>
  );
}

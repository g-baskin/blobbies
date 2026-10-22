import { Paperclip, X } from "lucide-react";
import { BlobAvatar } from "@/components/BlobAvatar";
import type { Agent } from "@/data/agents";
import type { Group } from "@/lib/groups";
import type { SharedContent } from "@/lib/mobile";

/** Where a share goes: a Blob's own conversation or a group chat. */
export type ShareTarget = { kind: "blob"; id: string } | { kind: "group"; id: string };

interface ShareSheetProps {
  content: SharedContent;
  agents: Agent[];
  groups: Group[];
  onPick: (target: ShareTarget) => void;
  onClose: () => void;
}

/** What the share will put in the composer: subject and text, deduplicated. */
export function shareText(content: SharedContent): string {
  const subject = content.subject.trim();
  const text = content.text.trim();
  if (subject === "" || text.includes(subject)) {
    return text;
  }
  return text === "" ? subject : `${subject}\n${text}`;
}

/**
 * "Send to…": content another app shared, waiting for the user to choose a
 * conversation. Picking one only fills that composer; nothing is sent.
 */
export function ShareSheet({ content, agents, groups, onPick, onClose }: ShareSheetProps) {
  const preview = shareText(content);
  const visible = agents.filter((agent) => agent.hidden !== true);
  const membersOf = (group: Group) =>
    agents.filter((agent) => agent.hidden !== true && agent.section === group.name);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: scrim click-away; the sheet has a Close button
    // biome-ignore lint/a11y/useKeyWithClickEvents: Close button and Android back cover the keyboard path
    <div className="share-scrim" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: containment only */}
      <div
        className="share-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Send to"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="share-sheet-header">
          <h2 className="share-sheet-title">Send to…</h2>
          <button type="button" className="icon-button" aria-label="Cancel share" onClick={onClose}>
            <X size={20} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>
        {preview === "" && content.files.length === 0 ? null : (
          <div className="share-sheet-preview">
            {preview === "" ? null : <p className="share-sheet-text">{preview}</p>}
            {content.files.length === 0 ? null : (
              <p className="share-sheet-files">
                <Paperclip size={14} strokeWidth={1.8} aria-hidden="true" />
                {content.files.map((file) => file.name).join(", ")}
              </p>
            )}
          </div>
        )}
        <ul className="share-sheet-list">
          {groups.map((group) => {
            const members = membersOf(group);
            return (
              <li key={group.id}>
                <button
                  type="button"
                  className="share-sheet-row"
                  onClick={() => onPick({ kind: "group", id: group.id })}
                >
                  <span className="share-sheet-faces" aria-hidden="true">
                    {members.slice(0, 3).map((member) => (
                      <BlobAvatar
                        key={member.id}
                        tone={member.tone}
                        shape={member.shape}
                        size={28}
                      />
                    ))}
                  </span>
                  <span className="share-sheet-name">{group.name}</span>
                  <span className="share-sheet-meta">Group · {members.length}</span>
                </button>
              </li>
            );
          })}
          {visible.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                className="share-sheet-row"
                onClick={() => onPick({ kind: "blob", id: agent.id })}
              >
                <BlobAvatar tone={agent.tone} shape={agent.shape} size={36} />
                <span className="share-sheet-name">{agent.name}</span>
                {agent.title === undefined ? null : (
                  <span className="share-sheet-meta">{agent.title}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

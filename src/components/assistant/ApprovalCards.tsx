import { useState, useSyncExternalStore } from "react";
import "./assistant.css";
import {
  answerApproval,
  describeTool,
  pendingApprovals,
  shortArgs,
  subscribeApprovals,
} from "@/lib/approvals";

/** In-chat "may I?" cards for the tool calls waiting in this conversation. */
export function ApprovalCards({ conversationId }: { conversationId: string }) {
  const all = useSyncExternalStore(subscribeApprovals, pendingApprovals);
  const mine = all.filter((request) => request.conversationId === conversationId);
  const [always, setAlways] = useState<Record<string, boolean>>({});
  if (mine.length === 0) {
    return null;
  }
  return (
    <>
      {mine.map((request) => (
        <div key={request.id} className="approval-card" role="alert">
          <span className="approval-card-title">
            {request.blobName} wants to: {describeTool(request.tool, request.args)}
          </span>
          <span className="approval-card-args">
            {request.tool}
            {Object.keys(request.args).length === 0 ? "" : ` — ${shortArgs(request.args, 400)}`}
          </span>
          <div className="approval-card-actions">
            <button
              type="button"
              className="modal-button"
              onClick={() => answerApproval(request.id, true, always[request.id] === true)}
            >
              Approve
            </button>
            <button
              type="button"
              className="modal-button"
              onClick={() => answerApproval(request.id, false)}
            >
              Deny
            </button>
            <label>
              <input
                type="checkbox"
                checked={always[request.id] === true}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setAlways((previous) => ({ ...previous, [request.id]: checked }));
                }}
              />
              Always allow this for {request.blobName}
            </label>
          </div>
        </div>
      ))}
    </>
  );
}

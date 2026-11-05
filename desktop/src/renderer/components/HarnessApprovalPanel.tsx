import { useEffect, useState } from "react";

import type { DesktopHarnessApprovalView, HarnessApprovalDecision } from "../../shared/harness-approval-api";
import { ActionButton } from "./atoms/ActionButton";
import { Panel } from "./Panel";

export function HarnessApprovalPanel({ runId: selectedRunId }: { runId?: string } = {}) {
  const [manualRunId, setManualRunId] = useState("");
  const runId = selectedRunId ?? manualRunId;
  const [approvals, setApprovals] = useState<DesktopHarnessApprovalView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setApprovals([]);
    if (selectedRunId) void load(selectedRunId);
  }, [selectedRunId]);

  async function load(runOverride?: string): Promise<void> {
    const value = (runOverride ?? runId).trim();
    if (!value) return;
    setBusy("load");
    setError(null);
    setNotice(null);
    const result = await window.sourcenerveDesktop.listHarnessApprovals({
      runId: value,
      status: "pending",
      limit: 100,
    });
    if (result.ok) setApprovals(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function respond(approval: DesktopHarnessApprovalView, decision: HarnessApprovalDecision): Promise<void> {
    const label = decision === "allow_run" ? "Allow this tool up to 12 times in this run (5 minutes)" :
      decision === "allow" ? "Allow once" : "Deny";
    if (decision === "allow_run" && approval.canAllowRun !== true) return;
    const scopeNote = decision === "allow_run"
      ? "Scope: same tool, run, workspace, capability and Git HEAD. Up to 12 executions within 5 minutes. Push, merge, privileged commands and provider creation remain exact-only."
      : "Approval is bound to this exact execution intent.";
    if (!window.confirm(`${label} ${approval.tool}?\n\nRun: ${approval.runId}\nWorkspace: ${approval.workspace}\nHEAD: ${approval.headSha}${approval.externalRequestId ? `\nNative request: ${approval.externalRequestId}` : ""}\nArguments SHA-256: ${approval.argumentSha256}\n\n${scopeNote}`)) return;
    setBusy(approval.id);
    setError(null);
    setNotice(null);
    const result = await window.sourcenerveDesktop.respondHarnessApproval({
      approvalId: approval.id,
      decision,
    });
    if (result.ok) {
      setApprovals((items) => items.filter((item) => item.id !== approval.id));
      setNotice(decision === "allow_run"
        ? `${approval.tool} allowed for this run: at most 12 same-tool executions within 5 minutes, bound to workspace, capability and HEAD.`
        : decision === "allow"
          ? `${approval.tool} allowed once. The waiting Codex request will resume only if the exact run, workspace, HEAD and argument digest still match.`
          : `${approval.tool} denied for this execution intent.`);
    } else setError(result.error.message);
    setBusy(null);
  }

  return (
    <Panel title="Harness approvals" eyebrow="Human-in-the-loop">
      <p className="muted">
        Review pending ASK decisions for a durable Harness run. Allow once stays exact;
        the optional Allow for run grant is explicit, short-lived, same-tool only and
        never available for shell execution, push, merge or irreversible actions.
      </p>
      <div className="form-row">
        {selectedRunId ? (
          <p className="muted grow">Selected run <code>{selectedRunId}</code></p>
        ) : (
          <label className="field grow">
            <span>Harness run ID</span>
            <input
              value={manualRunId}
              onChange={(event) => setManualRunId(event.target.value)}
              placeholder="Paste a run ID from the Harness tool response"
              maxLength={128}
            />
          </label>
        )}
        <ActionButton onClick={() => void load()} disabled={!runId.trim() || busy !== null}>
          {busy === "load" ? "Loading…" : "Load pending"}
        </ActionButton>
      </div>
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      {notice ? <p className="success-banner">{notice}</p> : null}
      {approvals.length === 0 ? (
        <p className="muted">No pending approvals loaded.</p>
      ) : (
        <div className="space-y-3">
          {approvals.map((approval) => (
            <article className="panel nested-panel" key={approval.id}>
              <div className="split-row">
                <div>
                  <strong>{approval.tool}</strong>
                  <p className="muted">{approval.capabilityId}</p>
                </div>
                <span className="status-pill">pending</span>
              </div>
              <dl className="detail-grid">
                <div><dt>Workspace</dt><dd>{approval.workspace}</dd></div>
                <div><dt>HEAD</dt><dd><code>{approval.headSha.slice(0, 12)}</code></dd></div>
                <div><dt>Arguments</dt><dd><code>{approval.argumentSha256.slice(0, 16)}…</code></dd></div>
                {approval.externalRequestId ? <div><dt>Native request</dt><dd><code>{approval.externalRequestId}</code></dd></div> : null}
                <div><dt>Expires</dt><dd>{new Date(approval.expiresAt * 1000).toLocaleTimeString()}</dd></div>
              </dl>
              <div className="button-row">
                <ActionButton onClick={() => void respond(approval, "allow")} disabled={busy !== null}>
                  Allow once
                </ActionButton>
                {approval.canAllowRun === true ? (
                  <ActionButton onClick={() => void respond(approval, "allow_run")} disabled={busy !== null}>
                    Allow for run (12 uses / 5 min)
                  </ActionButton>
                ) : null}
                <ActionButton onClick={() => void respond(approval, "deny")} disabled={busy !== null}>
                  Deny
                </ActionButton>
              </div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}

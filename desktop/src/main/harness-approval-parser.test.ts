import { describe, expect, it } from "vitest";

import { parseHarnessApprovalList, parseHarnessApprovalRespond } from "./harness-approval-parser";

const raw = {
  id: "approval-123", run_id: "run-abc", workspace: "sourcenerve",
  tool: "git_branch_checkout", capability_id: "core.git.mutate",
  argument_sha256: "a".repeat(64), head_sha: "b".repeat(40),
  status: "pending", requested_at: 1_793_844_442, expires_at: 1_793_887_642,
  resolved_at: null, consumed_at: null, external_request_id: null,
  can_allow_run: true,
};

describe("Harness approval scope metadata parsing", () => {
  it("only exposes the server-declared eligibility flag", () => {
    const approvals = parseHarnessApprovalList({ approvals: [raw] });
    expect(approvals[0].canAllowRun).toBe(true);
    expect(approvals[0].tool).toBe("git_branch_checkout");
    expect(approvals[0].expiresAt).toBe(raw.expires_at);
    const response = parseHarnessApprovalRespond({
      approval: { ...raw, can_allow_run: false, status: "allowed" }, replayed: false,
    });
    expect(response.approval.canAllowRun).toBe(false);
    expect(response.replayed).toBe(false);
  });

  it("treats missing metadata conservatively and rejects malformed flags", () => {
    const { can_allow_run: _, ...legacy } = raw;
    expect(parseHarnessApprovalList({ approvals: [legacy] })[0].canAllowRun).toBeUndefined();
    for (const bad of ["yes", 1, null, [], {}]) {
      expect(() => parseHarnessApprovalList({
        approvals: [{ ...raw, can_allow_run: bad }],
      })).toThrow(/run scope eligibility/);
    }
  });
});

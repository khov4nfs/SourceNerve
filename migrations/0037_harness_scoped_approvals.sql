-- Explicit, bounded grants. Existing one-shot decisions retain exact semantics.
ALTER TABLE harness_approvals
    ADD COLUMN approval_scope TEXT NOT NULL DEFAULT 'exact'
    CHECK (approval_scope IN ('exact', 'run'));

ALTER TABLE harness_approvals
    ADD COLUMN uses_remaining INTEGER NOT NULL DEFAULT 1
    CHECK (uses_remaining BETWEEN 0 AND 12);

CREATE INDEX idx_harness_approvals_scope
    ON harness_approvals (
        run_id, principal_id, workspace_id, tool_name, capability_id,
        head_sha, approval_scope, status, expires_at
    );

# Scoped approvals for interactive SourceNerve tasks

This feature reduces repeat consent prompts without treating a user approval as
unlimited authorization. It does **not** relax workspace confinement, OAuth
scope, active MCP policy, Git review gates, or raw shell sandbox boundaries.

## Decisions for `harness_approval_respond`

| Decision | Applies to | Boundaries |
| --- | --- | --- |
| `allow` | Any pending Harness or MCP action | Original exact one-shot behavior; argument hash must match |
| `allow_run` | Eligible first-party Harness operations only (not provider or MCP extension mutations) | Up to 12 calls, within 5 minutes of approval; same authenticated principal, Harness run, workspace, tool, capability, Git HEAD |
| `allow_tool` | Eligible MCP extension actions | Up to 12 calls, within 2 minutes; same authenticated principal and public tool; also same resource ID where exposed |
| `deny` | Any pending action | No execution |

`allow_run` uses a **positive allowlist** of reviewed first-party
operations: `workspace_file_write`, `workspace_file_put`, `patch_apply`,
`task_apply_patch`, `git_branch_checkout`, `task_branch_checkout`,
`git_commit` and `task_git_commit`. New or unknown tools remain exact-only
until reviewed. Remote provider actions and MCP extensions are not on this
allowlist.

The user must **explicitly** choose `allow_run` or `allow_tool`.
Never silently upgrade `allow`; approvals cannot change an effective `deny`.
Unknown/unclassified, disabled or blocked MCP tools still fail closed.

`allow_run` is persisted with the Harness run and atomically decremented for
each call. Changing Git HEAD ends the matching grant; canceled/stale runs cannot
dispatch. `allow_tool` is ephemeral, maintained in the gateway's local memory;
a restart clears these grants. Resource-bound approvals hash external IDs and
paths instead of storing plaintext identifiers in approval caches.

Chrome DevTools screenshot/snapshot, network inspection and wait-for operations
have read-only classification when their downstream metadata does not
contradict that status. Interactive browser mutations still follow MCP policy.

## Desktop and long-running ChatGPT sessions

The Desktop Harness approval view and inline ChatGPT/Codex panel now offer an
explicit **Allow for run (12 uses / 5 min)** action only when the daemon reports
`can_allow_run=true`. Clicking it requires a second confirmation of the exact
run/workspace/HEAD and scope. Existing `Allow once` and `Deny` remain unchanged.
The server, not Desktop, decides if a particular tool is eligible. Native OS
approvals, privileged commands, Git push/merge and public PR/issue creation
remain exact one-shot. Dynamic MCP extension tools use the separate resource-bounded `allow_tool` flow, not `allow_run`. No such broad grant is implied from the original task
request.

Ordinary *pending* approval requests may remain available for **12 hours** to
accommodate human review that spans multiple chat turns. Native permission prompts and raw shell/process execution
approvals continue to expire after 5 minutes. A pending request is **not**
execution authority. After an explicit `allow` or `allow_run`, the grant
expires after **5 minutes from the consent time**, even if the request was
created hours earlier. The existing run, principal, workspace, capability,
tool, argument digest (for exact consent), HEAD and policy checks remain
mandatory.

## Avoiding duplicate approval

When the trusted MCP transport has already consumed an **Ask** approval for
the exact capability and current run, SourceNerve forwards that proof internally
to its MCP gateway, rather than asking the user a second time. The gateway
still re-checks principal authorization, tool enablement, blocked policy,
read/write dispatcher matching, OAuth and downstream availability. No external
API offers a caller-controlled `harness_approved` parameter.

## Security exclusions and diagnostics

Raw `workspace_exec`, `workspace_process_start` and native Codex command /
permission approvals remain exact one-shot. Irreversible Git/provider operations
(merge, push, delete, revoke, deploy, publish and related verbs) are also exact. MCP operations with delete, remove,
reset, revoke, arbitrary evaluation/execution, upload, transfer, permission or
payment verbs also remain exact one-shot.

A persisted approval exposes `approval_scope` and `uses_remaining` for UI
diagnostics. Harness events record scope and selection; MCP gateway responses report
scoped consent while tool invocation audits retain only sanitized metadata.

## Verification

```sh
cargo fmt --all -- --check
cargo test explicit_run_scoped_grant_allows_bounded_changes_but_not_other_tools
cargo test run_scope_never_authorizes_privileged_exec_or_native_permissions
cargo test tool_scope_requires_explicit_decision_and_is_resource_bounded
cargo test browser_observation_tools_do_not_require_write_dispatch
```

A new SQLite migration `0037_harness_scoped_approvals.sql` adds two columns and
a scope lookup index. The required state schema version advances to 37.

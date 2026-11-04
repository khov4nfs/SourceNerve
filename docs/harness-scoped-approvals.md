# Scoped approvals for interactive SourceNerve tasks

This feature reduces repeat consent prompts without treating a user approval as
unlimited authorization. It does **not** relax workspace confinement, OAuth
scope, active MCP policy, Git review gates, or raw shell sandbox boundaries.

## Decisions for `harness_approval_respond`

| Decision | Applies to | Boundaries |
| --- | --- | --- |
| `allow` | Any pending Harness or MCP action | Original exact one-shot behavior; argument hash must match |
| `allow_run` | Harness pending actions other than sensitive shell/native or destructive extension tools | Up to 12 calls, within 5 minutes of approval; same authenticated principal, Harness run, workspace, tool, capability, Git HEAD |
| `allow_tool` | Eligible MCP extension actions | Up to 12 calls, within 2 minutes; same authenticated principal and public tool; also same resource ID where exposed |
| `deny` | Any pending action | No execution |

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

# Agent-first browser MCP support (ChatGPT Chat)

## Goal

Use Chrome DevTools and Desktop Control through the SourceNerve MCP bridge
without first selecting or registering a Git repository. A repository workspace
is still required for repository-bound file operations, shell execution and Git
mutations.

This is a targeted fix for browser tool discovery/classification, not a new
unrestricted host shell or a replacement for the permission system.

## Intended flow

1. Install and enable the Chrome DevTools MCP extension in SourceNerve.
2. Configure permitted tool policies in Plugins + MCP.
3. Grant local desktop/screen permissions where computer use is needed.
4. From ChatGPT Chat, list browser tabs, inspect the AppSheet Editor, then
   interact with permitted controls.
5. Existing persistent STDIO sessions are reused while healthy. SourceNerve
   replaces a closed/poisoned session and reconnects on the next call.

## Classification contract

- Known observational browser operations receive complete read metadata.
- Browser interactions and script evaluation remain write/open-world tools.
- Unknown operations retain conservative classification.
- Tool discovery must not silently enable a tool, change its approval mode,
  grant filesystem access or weaken the runtime sandbox.
- A browser tool with no workspace still respects the configured MCP tool
  policy and the platform's browser/desktop permissions.

## Verification

- Run `cargo fmt --check`.
- Run `cargo test mcp_extension_policy --all-features`.
- Run `cargo test --all-features` and the desktop test suite.
- Confirm `chrome-devtools-mcp-<id>__list_pages` works after the extension
  and read policy have been enabled, without a repository selection.
- Confirm unknown and interactive browser tools are never classified as
  harmless read-only operations and blocked tools remain blocked.
- Confirm a disconnected browser MCP session reconnects on a subsequent call
  without replaying ambiguous writes.

## Persistent Browser and Computer Use sessions

SourceNerve reuses an authorized GUI MCP client within the current service
process, independent of a selected Git repository:

- Browser automation launched as an MCP STDIO extension reuses the same
  connection for tool discovery and later calls.
- The built-in Desktop Control extension (`sourcenerve-desktop-control`)
  uses Streamable HTTP on loopback. Its HTTP client is now kept open for
  discovery and subsequent tool calls.
- Known browser/computer-use HTTP MCP extensions may also reuse a session.
- A changed endpoint, process command, environment or bearer credential
  replaces the matching session. Explicit disable/restart/remove and
  credential/environment updates close the previous session.
- After a SourceNerve restart, no dead process or authorization token is
  restored from disk. The next authorized call reconnects to the current
  extension endpoint; Desktop Control's own reconciler re-registers its
  loopback endpoint when needed.
- A closed or poisoned GUI MCP connection is discarded. **Dispatched GUI
  actions are never retried automatically** because their effects may have
  occurred before a transport failure.

The authenticated `GET /api/v1/mcp/extensions/health` response now exposes
`session_state`: `connected`, `busy`, `idle`, `disconnected`, or
`not-applicable`. These diagnostics intentionally omit credentials and host
paths.

### Session smoke checks

- [ ] Start a browser MCP extension and confirm `session_state=connected`.
- [ ] Make two read-only browser calls; verify they retain the same server
  connection and do not restart Chrome each time.
- [ ] Use Desktop Control across consecutive calls with no repository selected.
- [ ] Stop a GUI MCP server; verify that the next permitted call reconnects
  or returns a bounded transport failure without replaying any action.
- [ ] Rotate a bearer token or extension endpoint; verify the old session
  closes and a new authorized session can connect.
- [ ] Restart SourceNerve; verify health returns `idle` before reconnect,
  then `connected` after a successful call.

## GitHub PR review approvals

`github_pull_review` uses its own `core.provider.review` capability instead of
the generic `core.provider.mutate` capability. An explicitly requested
`APPROVE`, `REQUEST_CHANGES` or `COMMENT` submission is automatically allowed
by the `interactive-local` profile only for a configured writable workspace
with an authorized GitHub connection.

The `guarded-durable` profile still asks; read-only and unattended profiles
deny review writes. PR creation, merge, Git push and other provider mutations
retain their existing policies. Review submission still validates body content,
supports idempotency, and uses GitHub's normal account permission rules.

A previously pending approval ID is not automatically resumed after an
upgrade: restart SourceNerve and submit the exact review action again after
the new capability snapshot is active. GitHub can prohibit approving or
requesting changes on a PR authored by the same user, in which case SourceNerve
may fall back to a clearly labeled comment.

## Non-goals

No universal automatic approval, no bypass of authentication, no
sandbox disablement, no implicit host filesystem access, and no broad shell
execution without a specifically authorized workspace.

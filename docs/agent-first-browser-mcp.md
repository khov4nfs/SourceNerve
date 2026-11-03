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

## Non-goals

No universal automatic approval, no bypass of authentication, no
sandbox disablement, no implicit host filesystem access, and no broad shell
execution without a specifically authorized workspace.

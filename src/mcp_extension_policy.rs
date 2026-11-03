use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalMode {
    Automatic,
    Ask,
    Blocked,
}

impl ApprovalMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Ask => "ask",
            Self::Blocked => "blocked",
        }
    }

    pub fn parse(value: &str) -> AppResult<Self> {
        match value {
            "automatic" => Ok(Self::Automatic),
            "ask" => Ok(Self::Ask),
            "blocked" => Ok(Self::Blocked),
            other => Err(AppError::InvalidRequest(format!(
                "unsupported MCP extension approval mode `{other}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolClassification {
    pub read_only: Option<bool>,
    pub destructive: Option<bool>,
    pub idempotent: Option<bool>,
    pub open_world: Option<bool>,
}

/// Fill in missing classification metadata for recognized Chrome DevTools tools.
///
/// Browsing does not require a Git workspace. This is classification ONLY:
/// the existing per-tool enabled/approval policy and desktop permissions remain
/// authoritative. Unknown tools retain their original (possibly incomplete)
/// metadata and are not silently enabled.
pub fn complete_known_browser_classification(
    public_name: &str,
    hint: ToolClassification,
) -> ToolClassification {
    let Some((namespace, operation)) = public_name.rsplit_once("__") else {
        return hint;
    };
    if !namespace.starts_with("chrome-devtools-mcp-") {
        return hint;
    }

    let read = match operation {
        "get_console_message"
        | "list_console_messages"
        | "list_network_requests"
        | "list_pages"
        | "performance_analyze_insight" => true,
        "click"
        | "close_page"
        | "drag"
        | "emulate"
        | "evaluate_script"
        | "fill"
        | "fill_form"
        | "get_network_request"
        | "handle_dialog"
        | "hover"
        | "lighthouse_audit"
        | "navigate_page"
        | "new_page"
        | "performance_start_trace"
        | "performance_stop_trace"
        | "press_key"
        | "resize_page"
        | "select_page"
        | "take_heapsnapshot"
        | "take_screenshot"
        | "take_snapshot"
        | "type_text"
        | "upload_file" => false,
        _ => return hint,
    };

    // Conflicting downstream hints must never turn an interactive browser
    // operation into a read-only tool.
    let read_only = read && hint.read_only != Some(false) && hint.destructive != Some(true);
    ToolClassification {
        read_only: Some(read_only),
        destructive: Some(!read_only),
        idempotent: Some(read_only && hint.idempotent != Some(false)),
        open_world: Some(true),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolPolicy {
    pub enabled: bool,
    pub approval: ApprovalMode,
    pub classification: ToolClassification,
}

impl Default for ToolPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            approval: ApprovalMode::Blocked,
            classification: ToolClassification::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow,
    RequireApproval,
    Deny,
}

/// Resolve the effective SourceNerve classification for a downstream MCP tool.
///
/// Downstream MCP annotations remain advisory. SourceNerve independently recognizes a
/// deliberately small set of obvious read verbs and mutation verbs from the tool name.
/// Mutation signals always win, so names such as `get_or_create` or `search_and_delete`
/// never become read-only just because they start with a read verb or advertise a
/// `readOnlyHint`.
///
/// Unknown semantics stay conservative: an unrecognized downstream `readOnlyHint: true`
/// is not sufficient by itself to grant read-only treatment, while an explicit false hint
/// is retained as a write/conservative signal.
pub fn resolve_tool_classification(
    tool_name: &str,
    hint: ToolClassification,
) -> ToolClassification {
    let tokens = tool_name_tokens(tool_name);
    let mut resolved = hint;

    match infer_read_only(&tokens) {
        Some(true) => {
            resolved.read_only = Some(true);
            resolved.destructive = Some(false);
        }
        Some(false) => {
            resolved.read_only = Some(false);
            if is_destructive(&tokens) {
                resolved.destructive = Some(true);
            }
        }
        None => {
            // Third-party positive annotations are hints, not authorization authority.
            // Preserve an explicit false because it is already conservative; otherwise
            // leave the semantics unknown so the gateway routes through the write path.
            resolved.read_only = match hint.read_only {
                Some(false) => Some(false),
                _ => None,
            };
        }
    }

    resolved
}

fn infer_read_only(tokens: &[String]) -> Option<bool> {
    let first = tokens.first().map(String::as_str)?;
    let last = tokens.last().map(String::as_str)?;

    const MUTATION_WORDS: &[&str] = &[
        "add",
        "apply",
        "approve",
        "clear",
        "commit",
        "copy",
        "create",
        "delete",
        "deploy",
        "disable",
        "drop",
        "edit",
        "enable",
        "execute",
        "import",
        "ingest",
        "insert",
        "install",
        "manage",
        "merge",
        "move",
        "mutate",
        "patch",
        "publish",
        "push",
        "remove",
        "rename",
        "reset",
        "revoke",
        "save",
        "send",
        "set",
        "start",
        "stop",
        "store",
        "truncate",
        "uninstall",
        "update",
        "upload",
        "upsert",
        "write",
    ];

    if tokens
        .iter()
        .any(|token| MUTATION_WORDS.contains(&token.as_str()))
    {
        return Some(false);
    }

    // `index_repository` / `index_codebase` mutate a local derived index, while
    // `index_status` is an observation. Keep the distinction explicit.
    if matches!(first, "index" | "reindex") && last != "status" {
        return Some(false);
    }
    if matches!(first, "refresh" | "restart" | "run" | "sync") {
        return Some(false);
    }

    const READ_WORDS: &[&str] = &[
        "analyze",
        "analyse",
        "calculate",
        "check",
        "count",
        "describe",
        "detect",
        "diff",
        "explain",
        "fetch",
        "find",
        "get",
        "inspect",
        "list",
        "lookup",
        "preview",
        "query",
        "read",
        "resolve",
        "search",
        "show",
        "status",
        "summarize",
        "trace",
        "view",
    ];

    if READ_WORDS.contains(&first) || last == "status" {
        return Some(true);
    }

    None
}

fn is_destructive(tokens: &[String]) -> bool {
    const DESTRUCTIVE_WORDS: &[&str] = &[
        "clear",
        "delete",
        "drop",
        "remove",
        "reset",
        "truncate",
        "uninstall",
    ];
    tokens
        .iter()
        .any(|token| DESTRUCTIVE_WORDS.contains(&token.as_str()))
}

fn tool_name_tokens(value: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut previous_was_lower_or_digit = false;

    for ch in value.chars() {
        if !ch.is_ascii_alphanumeric() {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
            previous_was_lower_or_digit = false;
            continue;
        }

        if ch.is_ascii_uppercase() && previous_was_lower_or_digit && !current.is_empty() {
            result.push(std::mem::take(&mut current));
        }
        current.push(ch.to_ascii_lowercase());
        previous_was_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
    }

    if !current.is_empty() {
        result.push(current);
    }
    result
}

pub fn evaluate_tool_policy(policy: Option<ToolPolicy>, user_approved: bool) -> PolicyDecision {
    let Some(policy) = policy else {
        return PolicyDecision::Deny;
    };
    if !policy.enabled {
        return PolicyDecision::Deny;
    }
    match policy.approval {
        ApprovalMode::Automatic => PolicyDecision::Allow,
        ApprovalMode::Ask if user_approved => PolicyDecision::Allow,
        ApprovalMode::Ask => PolicyDecision::RequireApproval,
        ApprovalMode::Blocked => PolicyDecision::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tools_fail_closed() {
        assert_eq!(evaluate_tool_policy(None, false), PolicyDecision::Deny);
    }

    #[test]
    fn discovered_tool_default_is_blocked_and_disabled() {
        let policy = ToolPolicy::default();
        assert!(!policy.enabled);
        assert_eq!(policy.approval, ApprovalMode::Blocked);
        assert_eq!(
            evaluate_tool_policy(Some(policy), true),
            PolicyDecision::Deny
        );
    }

    #[test]
    fn ask_requires_explicit_approval() {
        let policy = ToolPolicy {
            enabled: true,
            approval: ApprovalMode::Ask,
            classification: ToolClassification::default(),
        };
        assert_eq!(
            evaluate_tool_policy(Some(policy), false),
            PolicyDecision::RequireApproval
        );
        assert_eq!(
            evaluate_tool_policy(Some(policy), true),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn source_nerve_recognizes_obvious_read_only_extension_tools() {
        for name in [
            "get_file_outline",
            "get_project_summary",
            "search_code",
            "search_symbols",
            "check_index_coverage",
            "detect_changes",
            "get_architecture",
            "get_code_snippet",
            "get_graph_schema",
            "index_status",
            "list_projects",
            "query_graph",
            "search_graph",
            "trace_path",
        ] {
            let resolved = resolve_tool_classification(name, ToolClassification::default());
            assert_eq!(resolved.read_only, Some(true), "{name}");
            assert_eq!(resolved.destructive, Some(false), "{name}");
        }
    }

    #[test]
    fn mutation_signals_override_read_prefixes_and_downstream_hints() {
        for name in [
            "delete_project",
            "index_repository",
            "index_codebase",
            "ingest_traces",
            "manage_adr",
            "get_or_create",
            "search_and_delete",
        ] {
            let resolved = resolve_tool_classification(
                name,
                ToolClassification {
                    read_only: Some(true),
                    destructive: Some(false),
                    idempotent: None,
                    open_world: None,
                },
            );
            assert_eq!(resolved.read_only, Some(false), "{name}");
        }
        assert_eq!(
            resolve_tool_classification("delete_project", ToolClassification::default())
                .destructive,
            Some(true)
        );
    }

    #[test]
    fn recognized_browser_tools_have_complete_safety_metadata() {
        let read = complete_known_browser_classification(
            "chrome-devtools-mcp-6f0fffa__list_pages",
            ToolClassification::default(),
        );
        assert_eq!(read.read_only, Some(true));
        assert_eq!(read.destructive, Some(false));
        assert_eq!(read.idempotent, Some(true));
        assert_eq!(read.open_world, Some(true));

        let interactive = complete_known_browser_classification(
            "chrome-devtools-mcp-6f0fffa__evaluate_script",
            ToolClassification {
                read_only: Some(true),
                destructive: Some(false),
                idempotent: Some(true),
                open_world: Some(false),
            },
        );
        assert_eq!(interactive.read_only, Some(false));
        assert_eq!(interactive.destructive, Some(true));
        assert_eq!(interactive.idempotent, Some(false));
        assert_eq!(interactive.open_world, Some(true));
    }

    #[test]
    fn unknown_browser_operations_keep_conservative_metadata() {
        let unknown = ToolClassification::default();
        assert_eq!(
            complete_known_browser_classification("chrome-devtools-mcp-6f0fffa__unknown", unknown),
            unknown,
        );
        assert_eq!(
            complete_known_browser_classification("another-extension__list_pages", unknown),
            unknown,
        );
        assert_eq!(evaluate_tool_policy(None, true), PolicyDecision::Deny);
    }

    #[test]
    fn unknown_positive_downstream_hint_is_not_authoritative() {
        let resolved = resolve_tool_classification(
            "mystery_operation",
            ToolClassification {
                read_only: Some(true),
                destructive: None,
                idempotent: None,
                open_world: None,
            },
        );
        assert_eq!(resolved.read_only, None);
    }
}

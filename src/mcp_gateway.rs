use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Tool, ToolAnnotations,
};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    mcp_extension_audit::{
        self, ApprovalDecision as AuditApprovalDecision, AuditEvent,
        PolicyDecision as AuditPolicyDecision, ResultCategory as AuditResultCategory,
    },
    mcp_extension_client,
    mcp_extension_policy::{
        ApprovalMode, PolicyDecision, complete_known_browser_classification,
        complete_known_google_workspace_classification, evaluate_tool_policy,
    },
    mcp_extension_registry::{self, ExtensionAuthType, ExtensionRecord, ExtensionToolRecord},
    mcp_extension_runtime,
    principal::Principal,
    service::AppState,
};

pub const APPROVAL_TTL: Duration = Duration::from_secs(120);
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
const MAX_ENV_ENTRIES: usize = 32;
const MAX_ENV_VALUE_BYTES: usize = 32 * 1024;
const MAX_CAPABILITY_TOOL_NAMES: usize = 24;
/// Tool grants are explicit opt-in and short-lived, not a replacement for OAuth or tool policy.
const MAX_TOOL_SCOPE_USES: u8 = 12;

static MATERIALIZED_CREDENTIALS: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
static MATERIALIZED_ENVIRONMENTS: OnceLock<RwLock<HashMap<String, BTreeMap<String, String>>>> =
    OnceLock::new();
static ONE_SHOT_APPROVALS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static SCOPED_ONE_SHOT_APPROVALS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static SCOPED_TOOL_APPROVALS: OnceLock<Mutex<HashMap<String, ScopedToolGrant>>> = OnceLock::new();
static PENDING_EXTENSION_APPROVALS: OnceLock<Mutex<HashMap<String, PendingExtensionApproval>>> =
    OnceLock::new();

#[derive(Debug, Clone)]
struct PendingExtensionApproval {
    public_tool: String,
    principal_id: String,
    argument_sha256: String,
    resource_scope: Option<String>,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
struct ScopedToolGrant {
    expires_at: Instant,
    remaining: u8,
}

#[derive(Debug, Clone)]
struct ToolRoute {
    extension: ExtensionRecord,
    tool: ExtensionToolRecord,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeDispatcher {
    Read,
    Write,
}

impl BridgeDispatcher {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

fn credentials() -> &'static RwLock<HashMap<String, String>> {
    MATERIALIZED_CREDENTIALS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn environments() -> &'static RwLock<HashMap<String, BTreeMap<String, String>>> {
    MATERIALIZED_ENVIRONMENTS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn approvals() -> &'static Mutex<HashMap<String, Instant>> {
    ONE_SHOT_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn scoped_approvals() -> &'static Mutex<HashMap<String, Instant>> {
    SCOPED_ONE_SHOT_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_approvals() -> &'static Mutex<HashMap<String, PendingExtensionApproval>> {
    PENDING_EXTENSION_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tool_approvals() -> &'static Mutex<HashMap<String, ScopedToolGrant>> {
    SCOPED_TOOL_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tool_approval_key(principal_id: &str, public_tool: &str, scope: Option<&str>) -> String {
    format!(
        "{principal_id}\u{1f}{public_tool}\u{1f}{}",
        scope.unwrap_or("")
    )
}

/// Tie a repeated operation to its stable external resource when the tool
/// exposes one. Hash values so approval state never stores private IDs/paths.
fn request_resource_scope(request: &CallToolRequestParams) -> Option<String> {
    let args = request.arguments.as_ref()?;
    for key in [
        "script_id",
        "scriptId",
        "project_id",
        "projectId",
        "app_id",
        "appId",
        "file_id",
        "fileId",
        "document_id",
        "documentId",
        "spreadsheet_id",
        "spreadsheetId",
        "repository",
        "path",
    ] {
        if let Some(value) = args.get(key).and_then(serde_json::Value::as_str)
            && !value.is_empty()
        {
            return Some(format!(
                "{key}:{}",
                hex::encode(Sha256::digest(value.as_bytes()))
            ));
        }
    }
    None
}

/// Explicit scoped consent is unavailable for destructive or arbitrary-code
/// operations; these continue to require exact one-shot confirmation.
pub(crate) fn eligible_for_tool_scope(public_tool: &str) -> bool {
    let operation = public_tool
        .rsplit_once("__")
        .map(|(_, name)| name)
        .unwrap_or(public_tool);
    !operation.split(['_', '-']).any(|word| {
        matches!(
            word,
            "delete"
                | "remove"
                | "drop"
                | "reset"
                | "clear"
                | "revoke"
                | "execute"
                | "eval"
                | "evaluate"
                | "upload"
                | "transfer"
                | "payment"
                | "purchase"
                | "permission"
                | "permissions"
                | "send"
                | "share"
                | "grant"
                | "approve"
        )
    })
}

fn scoped_approval_key(principal_id: &str, public_tool: &str, argument_sha256: &str) -> String {
    format!("{principal_id}\u{1f}{public_tool}\u{1f}{argument_sha256}")
}

fn request_argument_sha256(request: &CallToolRequestParams) -> AppResult<String> {
    let value = request
        .arguments
        .clone()
        .map(serde_json::Value::Object)
        .unwrap_or(serde_json::Value::Null);
    let bytes = serde_json::to_vec(&value).map_err(anyhow::Error::from)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

async fn request_pending_approval(
    principal_id: &str,
    public_tool: &str,
    argument_sha256: &str,
    resource_scope: Option<String>,
) -> (String, u64) {
    let now = Instant::now();
    let mut pending = pending_approvals().lock().await;
    pending.retain(|_, approval| approval.expires_at > now);
    if let Some((id, approval)) = pending.iter().find(|(_, approval)| {
        approval.principal_id == principal_id
            && approval.public_tool == public_tool
            && approval.argument_sha256 == argument_sha256
    }) {
        return (
            id.clone(),
            approval.expires_at.saturating_duration_since(now).as_secs(),
        );
    }
    let id = Uuid::new_v4().to_string();
    let expires_at = now + APPROVAL_TTL;
    pending.insert(
        id.clone(),
        PendingExtensionApproval {
            public_tool: public_tool.to_owned(),
            principal_id: principal_id.to_owned(),
            argument_sha256: argument_sha256.to_owned(),
            resource_scope,
            expires_at,
        },
    );
    (id, APPROVAL_TTL.as_secs())
}

async fn consume_scoped_approval(
    principal_id: &str,
    public_tool: &str,
    argument_sha256: &str,
) -> bool {
    let key = scoped_approval_key(principal_id, public_tool, argument_sha256);
    let mut approvals = scoped_approvals().lock().await;
    let now = Instant::now();
    approvals.retain(|_, expires_at| *expires_at > now);
    approvals
        .remove(&key)
        .is_some_and(|expires_at| expires_at > now)
}

async fn consume_tool_approval(
    principal_id: &str,
    public_tool: &str,
    resource_scope: Option<&str>,
) -> bool {
    let key = tool_approval_key(principal_id, public_tool, resource_scope);
    let mut grants = tool_approvals().lock().await;
    let now = Instant::now();
    grants.retain(|_, grant| grant.expires_at > now && grant.remaining > 0);
    let Some(grant) = grants.get_mut(&key) else {
        return false;
    };
    grant.remaining -= 1;
    if grant.remaining == 0 {
        grants.remove(&key);
    }
    true
}

pub async fn pending_approval_exists(approval_id: &str) -> bool {
    let now = Instant::now();
    let mut pending = pending_approvals().lock().await;
    pending.retain(|_, approval| approval.expires_at > now);
    pending.contains_key(approval_id)
}

pub async fn respond_pending_approval(
    approval_id: &str,
    decision: &str,
    principal_id: &str,
    operator: bool,
) -> AppResult<Option<serde_json::Value>> {
    if !matches!(decision, "allow" | "allow_tool" | "deny") {
        return Err(AppError::InvalidRequest(format!(
            "unsupported MCP extension approval decision `{decision}`; expected allow, allow_tool or deny"
        )));
    }
    let now = Instant::now();
    let mut pending = pending_approvals().lock().await;
    pending.retain(|_, approval| approval.expires_at > now);
    let Some(approval) = pending.get(approval_id).cloned() else {
        return Ok(None);
    };
    if !operator && approval.principal_id != principal_id {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension approval not found: {approval_id}"
        )));
    }
    if decision == "allow_tool" && !eligible_for_tool_scope(&approval.public_tool) {
        return Err(AppError::InvalidRequest(
            "this sensitive MCP operation requires an exact one-shot approval".into(),
        ));
    }
    pending.remove(approval_id);
    drop(pending);

    if decision == "allow_tool" {
        let key = tool_approval_key(
            &approval.principal_id,
            &approval.public_tool,
            approval.resource_scope.as_deref(),
        );
        tool_approvals().lock().await.insert(
            key,
            ScopedToolGrant {
                expires_at: Instant::now() + APPROVAL_TTL,
                remaining: MAX_TOOL_SCOPE_USES,
            },
        );
    } else if decision == "allow" {
        let key = scoped_approval_key(
            &approval.principal_id,
            &approval.public_tool,
            &approval.argument_sha256,
        );
        scoped_approvals()
            .lock()
            .await
            .insert(key, Instant::now() + APPROVAL_TTL);
    }

    Ok(Some(serde_json::json!({
        "approval_id": approval_id,
        "public_tool": approval.public_tool,
        "decision": decision,
        "status": if decision == "deny" { "denied" } else { "allowed" },
        "one_shot": decision != "allow_tool",
        "uses_remaining": if decision == "allow_tool" { MAX_TOOL_SCOPE_USES } else if decision == "allow" { 1 } else { 0 },
        "expires_in_seconds": if decision != "deny" { APPROVAL_TTL.as_secs() } else { 0 },
        "scope": if decision == "allow_tool" { "principal-tool-resource" } else { "exact-principal-tool-arguments" }
    })))
}

pub async fn materialize_credential(extension_id: &str, credential: &str) -> AppResult<()> {
    if !safe_route_key(extension_id, 64) {
        return Err(AppError::InvalidRequest(
            "invalid MCP extension credential target".into(),
        ));
    }
    if credential.is_empty()
        || credential.len() > MAX_CREDENTIAL_BYTES
        || credential.contains(['\r', '\n', '\0'])
    {
        return Err(AppError::InvalidRequest(
            "MCP extension credential material is invalid".into(),
        ));
    }
    credentials()
        .write()
        .await
        .insert(extension_id.to_owned(), credential.to_owned());
    Ok(())
}

pub async fn materialized_credential(extension_id: &str) -> Option<String> {
    credentials().read().await.get(extension_id).cloned()
}

pub async fn clear_materialized_credential(extension_id: &str) {
    credentials().write().await.remove(extension_id);
}

pub async fn materialize_environment(
    extension_id: &str,
    values: &BTreeMap<String, String>,
) -> AppResult<()> {
    if !safe_route_key(extension_id, 64) {
        return Err(AppError::InvalidRequest(
            "invalid MCP extension environment target".into(),
        ));
    }
    if values.len() > MAX_ENV_ENTRIES {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension environment may contain at most {MAX_ENV_ENTRIES} values"
        )));
    }
    for (key, value) in values {
        if !valid_env_key(key) || value.len() > MAX_ENV_VALUE_BYTES || value.contains('\0') {
            return Err(AppError::InvalidRequest(
                "MCP extension environment material is invalid".into(),
            ));
        }
    }
    if values.is_empty() {
        environments().write().await.remove(extension_id);
    } else {
        environments()
            .write()
            .await
            .insert(extension_id.to_owned(), values.clone());
    }
    Ok(())
}

pub async fn materialized_environment(extension_id: &str) -> Option<BTreeMap<String, String>> {
    environments().read().await.get(extension_id).cloned()
}

pub async fn clear_materialized_environment(extension_id: &str) {
    environments().write().await.remove(extension_id);
}

pub async fn approve_once(public_tool: &str) -> AppResult<()> {
    if !safe_route_key(public_tool, 120) {
        return Err(AppError::InvalidRequest(
            "invalid MCP extension public tool name".into(),
        ));
    }
    approvals()
        .lock()
        .await
        .insert(public_tool.to_owned(), Instant::now() + APPROVAL_TTL);
    Ok(())
}

async fn consume_approval(public_tool: &str) -> bool {
    let mut approvals = approvals().lock().await;
    let now = Instant::now();
    approvals.retain(|_, expires_at| *expires_at > now);
    approvals
        .remove(public_tool)
        .is_some_and(|expires_at| expires_at > now)
}

pub async fn list_tools(pool: &SqlitePool, principal: &Principal) -> AppResult<Vec<Tool>> {
    ensure_initial_discovery(pool).await?;
    let mut result = Vec::new();
    for route in routes(pool).await? {
        if !route.tool.policy.enabled || route.tool.policy.approval == ApprovalMode::Blocked {
            continue;
        }
        if !principal_can_use(principal, &route.tool, None) {
            continue;
        }
        match public_tool(&route.tool) {
            Ok(tool) => result.push(tool),
            Err(error) => {
                tracing::warn!(
                    extension = %route.extension.id,
                    tool = %route.tool.public_name,
                    error = %error,
                    "omitting invalid downstream MCP tool schema"
                );
            }
        }
    }
    Ok(result)
}

pub async fn bridge_catalog(pool: &SqlitePool, principal: &Principal) -> AppResult<Vec<Tool>> {
    list_tools(pool, principal).await
}

pub fn extension_capability_summary(tools: &[Tool]) -> serde_json::Value {
    let mut browser_tools = Vec::new();
    let mut apps_script_tools = Vec::new();
    let mut apps_script_backends = BTreeSet::new();
    let mut appsheet_api_tools = Vec::new();
    let mut browser_debug_tools = Vec::new();
    let mut browser_vision_tools = Vec::new();
    let mut browser_visual_observation_tools = Vec::new();
    let mut computer_tools = Vec::new();
    let mut desktop_control_tools = Vec::new();
    let mut desktop_control_has_screenshot = false;
    let mut desktop_control_has_input = false;
    let mut native_application_tools = Vec::new();
    let mut native_application_has_list = false;
    let mut native_application_has_launch = false;
    let mut background_media_tools = Vec::new();
    let mut background_media_has_list = false;
    let mut background_media_has_control = false;
    let mut browser_backends = BTreeSet::new();
    let mut computer_backends = BTreeSet::new();

    for tool in tools {
        let public_name = tool.name.as_ref();
        let normalized = public_name.to_ascii_lowercase();
        let chrome_devtools = normalized.contains("chrome-devtools");
        let playwright = normalized.contains("playwright");
        let browser_use = normalized.contains("browser-use") || normalized.contains("browser_use");
        // Only advertise known clasp MCP operations; capability discovery never
        // changes extension enablement, per-tool policy or OAuth requirements.
        let clasp_operation = normalized.strip_prefix("clasp__");
        let workspace_operation = normalized.strip_prefix("google-workspace__");
        let clasp_known = clasp_operation.is_some_and(|operation| {
            matches!(
                operation,
                "list_projects" | "clone_project" | "create_project" | "pull_files" | "push_files"
            )
        });
        let workspace_script_known = workspace_operation.is_some_and(|operation| {
            matches!(
                operation,
                "apps_script_list_projects"
                    | "apps_script_comment_preview"
                    | "apps_script_comment_apply"
                    | "apps_script_get_project"
                    | "apps_script_get_content"
                    | "apps_script_update_content"
                    | "apps_script_create_version"
                    | "apps_script_create_deployment"
            )
        });
        if (clasp_known || workspace_script_known)
            && apps_script_tools.len() < MAX_CAPABILITY_TOOL_NAMES
        {
            apps_script_tools.push(public_name.to_owned());
            apps_script_backends.insert(if clasp_known {
                "clasp-mcp"
            } else {
                "desktop-oauth-proxy"
            });
        }
        if workspace_operation.is_some_and(|operation| {
            matches!(operation, "appsheet_key_status" | "appsheet_find_rows")
        }) && appsheet_api_tools.len() < MAX_CAPABILITY_TOOL_NAMES
        {
            appsheet_api_tools.push(public_name.to_owned());
        }
        let desktop_control =
            normalized.contains("desktop-control") || normalized.contains("desktop_control");
        let computer_use = normalized.contains("computer-use")
            || normalized.contains("computer_use")
            || desktop_control;

        if chrome_devtools || playwright || browser_use {
            if browser_tools.len() < MAX_CAPABILITY_TOOL_NAMES {
                browser_tools.push(public_name.to_owned());
            }
            if chrome_devtools {
                browser_backends.insert("chrome-devtools");
            }
            if playwright {
                browser_backends.insert("playwright");
            }
            if browser_use && !chrome_devtools && !playwright {
                browser_backends.insert("browser-use");
            }
        }
        if chrome_devtools && browser_debug_tools.len() < MAX_CAPABILITY_TOOL_NAMES {
            browser_debug_tools.push(public_name.to_owned());
        }
        if chrome_devtools
            && normalized.ends_with("__take_screenshot")
            && tool
                .annotations
                .as_ref()
                .and_then(|annotations| annotations.read_only_hint)
                == Some(true)
            && browser_visual_observation_tools.len() < MAX_CAPABILITY_TOOL_NAMES
        {
            browser_visual_observation_tools.push(public_name.to_owned());
        }
        if chrome_devtools
            && normalized.contains("__click_at")
            && browser_vision_tools.len() < MAX_CAPABILITY_TOOL_NAMES
        {
            browser_vision_tools.push(public_name.to_owned());
        }
        if computer_use {
            if desktop_control {
                if desktop_control_tools.len() < MAX_CAPABILITY_TOOL_NAMES {
                    desktop_control_tools.push(public_name.to_owned());
                }
                desktop_control_has_screenshot |= normalized.contains("__get_screenshot");
                desktop_control_has_input |= normalized.contains("__click_screen")
                    || normalized.contains("__move_mouse")
                    || normalized.contains("__press_key")
                    || normalized.contains("__type_text");
                if normalized.contains("__list_native_applications") {
                    native_application_has_list = true;
                    if native_application_tools.len() < MAX_CAPABILITY_TOOL_NAMES {
                        native_application_tools.push(public_name.to_owned());
                    }
                } else if normalized.contains("__launch_native_application") {
                    native_application_has_launch = true;
                    if native_application_tools.len() < MAX_CAPABILITY_TOOL_NAMES {
                        native_application_tools.push(public_name.to_owned());
                    }
                }
                if normalized.contains("__list_media_players") {
                    background_media_has_list = true;
                    if background_media_tools.len() < MAX_CAPABILITY_TOOL_NAMES {
                        background_media_tools.push(public_name.to_owned());
                    }
                } else if normalized.contains("__control_media_player")
                    || normalized.contains("__open_media_uri")
                {
                    background_media_has_control = true;
                    if background_media_tools.len() < MAX_CAPABILITY_TOOL_NAMES {
                        background_media_tools.push(public_name.to_owned());
                    }
                }
            } else {
                if computer_tools.len() < MAX_CAPABILITY_TOOL_NAMES {
                    computer_tools.push(public_name.to_owned());
                }
                computer_backends.insert("computer-use");
            }
        }
    }

    if desktop_control_has_screenshot && desktop_control_has_input {
        let remaining = MAX_CAPABILITY_TOOL_NAMES.saturating_sub(computer_tools.len());
        computer_tools.extend(desktop_control_tools.into_iter().take(remaining));
        computer_backends.insert("desktop-control");
    }

    let has_browser_visual_observation = !browser_visual_observation_tools.is_empty();
    let browser_vision_routable =
        has_browser_visual_observation && !browser_vision_tools.is_empty();

    serde_json::json!({
        "apps_script": {
            "routable": !apps_script_tools.is_empty(),
            "backends": apps_script_backends.into_iter().collect::<Vec<_>>(),
            "tool_names": apps_script_tools,
            "requires_external_oauth": true,
            "scope": "authorized-script-tools-only",
        },
        "appsheet_api": {
            "routable": !appsheet_api_tools.is_empty(),
            "backends": if appsheet_api_tools.is_empty() { Vec::<&str>::new() } else { vec!["desktop-api-key-proxy"] },
            "tool_names": appsheet_api_tools,
            "requires_per_app_key": true,
            "scope": "explicit-app-id-and-region-only",
        },
        "browser_use": {
            "routable": !browser_tools.is_empty(),
            "backends": browser_backends.into_iter().collect::<Vec<_>>(),
            "tool_names": browser_tools,
        },
        "browser_debug": {
            "routable": !browser_debug_tools.is_empty(),
            "backends": if browser_debug_tools.is_empty() { Vec::<&str>::new() } else { vec!["chrome-devtools"] },
            "tool_names": browser_debug_tools,
        },
        // Screenshot observation can be available without coordinate-based
        // browser input. Do not advertise the more powerful browser_vision
        // capability unless a browser-scoped click-at backend really exists.
        "browser_visual_observation": {
            "routable": !browser_visual_observation_tools.is_empty(),
            "backends": if browser_visual_observation_tools.is_empty() {
                Vec::<&str>::new()
            } else {
                vec!["chrome-devtools-screenshot"]
            },
            "tool_names": browser_visual_observation_tools,
            "scope": "selected-browser-page-inline-image-only",
        },
        "browser_vision": {
            "routable": browser_vision_routable,
            "backends": if browser_vision_routable { vec!["chrome-devtools-vision"] } else { Vec::<&str>::new() },
            "tool_names": browser_vision_tools,
            "scope": "browser-viewport-only",
        },
        "native_applications": {
            "routable": native_application_has_list && native_application_has_launch,
            "backends": if native_application_has_list && native_application_has_launch { vec!["desktop-control"] } else { Vec::<&str>::new() },
            "tool_names": native_application_tools,
            "scope": "installed-native-applications-only",
        },
        "background_media": {
            "routable": background_media_has_list && background_media_has_control,
            "backends": if background_media_has_list && background_media_has_control { vec!["desktop-control-mpris"] } else { Vec::<&str>::new() },
            "tool_names": background_media_tools,
            "scope": "semantic-background-control-no-pointer-or-keyboard-injection",
        },
        "computer_use": {
            "routable": !computer_tools.is_empty(),
            "backends": computer_backends.into_iter().collect::<Vec<_>>(),
            "tool_names": computer_tools,
        },
        "routing": "Follow the user's target surface first. For native media, when background_media is routable you must list/control the media player semantically before considering screen observation or pointer/keyboard injection; do not use screenshot, mouse, or keyboard tools for a media action that semantic media control can perform. If the user explicitly asks for a native/desktop application or OS UI, use native_applications/computer_use and never silently substitute a browser or web-app equivalent. Treat desktop pointer/key injection as a foreground fallback only and do not use it without explicit user approval for visible foreground interaction. Prefer Playwright/browser automation only for browser/web tasks, with Chrome DevTools for browser inspection/debugging. A routable capability is still subject to per-tool SourceNerve policy and runtime health at dispatch time."
    })
}

pub async fn bridge_call(
    state: &AppState,
    principal: &Principal,
    public_tool: &str,
    arguments: serde_json::Map<String, serde_json::Value>,
    dispatcher: BridgeDispatcher,
) -> AppResult<CallToolResponse> {
    bridge_call_inner(state, principal, public_tool, arguments, dispatcher, false).await
}

/// Internal only: called by the MCP transport after Harness consumed the
/// corresponding current-run approval. No client-supplied bypass flag exists.
pub(crate) async fn bridge_call_harness_approved(
    state: &AppState,
    principal: &Principal,
    public_tool: &str,
    arguments: serde_json::Map<String, serde_json::Value>,
    dispatcher: BridgeDispatcher,
) -> AppResult<CallToolResponse> {
    bridge_call_inner(state, principal, public_tool, arguments, dispatcher, true).await
}

async fn bridge_call_inner(
    state: &AppState,
    principal: &Principal,
    public_tool: &str,
    arguments: serde_json::Map<String, serde_json::Value>,
    dispatcher: BridgeDispatcher,
    harness_approved: bool,
) -> AppResult<CallToolResponse> {
    let Some(route) = resolve_route(&state.db, public_tool).await? else {
        return Ok(tool_error(format!(
            "MCP extension tool `{public_tool}` is not installed and enabled"
        )));
    };

    let is_read_only = effective_extension_classification(&route.tool).read_only == Some(true);
    let dispatcher_matches = match dispatcher {
        BridgeDispatcher::Read => is_read_only,
        BridgeDispatcher::Write => !is_read_only,
    };
    if !dispatcher_matches {
        return Ok(tool_error(format!(
            "SourceNerve stable extension {} dispatcher rejects `{public_tool}` because its current classification belongs to the {} dispatcher",
            dispatcher.as_str(),
            if is_read_only { "read" } else { "write" }
        )));
    }

    let mut downstream = CallToolRequestParams::new(public_tool.to_owned());
    downstream.arguments = Some(arguments);
    match try_call_inner(state, principal, &downstream, harness_approved).await? {
        Some(response) => Ok(response),
        None => Ok(tool_error(format!(
            "MCP extension tool `{public_tool}` disappeared before dispatch"
        ))),
    }
}

pub async fn try_call(
    state: &AppState,
    principal: &Principal,
    request: &CallToolRequestParams,
) -> AppResult<Option<CallToolResponse>> {
    try_call_inner(state, principal, request, false).await
}

pub(crate) async fn try_call_harness_approved(
    state: &AppState,
    principal: &Principal,
    request: &CallToolRequestParams,
) -> AppResult<Option<CallToolResponse>> {
    try_call_inner(state, principal, request, true).await
}

async fn try_call_inner(
    state: &AppState,
    principal: &Principal,
    request: &CallToolRequestParams,
    harness_approved: bool,
) -> AppResult<Option<CallToolResponse>> {
    let Some(route) = resolve_route(&state.db, request.name.as_ref()).await? else {
        return Ok(None);
    };
    let started = Instant::now();

    // A Chrome observation is read-only only when it returns data inline.
    // take_snapshot/take_screenshot accept filePath and can write arbitrary
    // output files; deny this form even through a direct namespaced MCP call.
    if browser_observation_requests_file_output(&route.tool.public_name, request.arguments.as_ref())
    {
        record_audit(
            state,
            principal,
            None,
            &route,
            AuditPolicyDecision::Blocked,
            AuditApprovalDecision::NotApplicable,
            AuditResultCategory::Denied,
            started,
            None,
            None,
        )
        .await;
        return Ok(Some(tool_error(
            "Chrome observation filePath is not permitted through the read bridge; omit filePath for an inline snapshot",
        )));
    }

    let workspace = request
        .arguments
        .as_ref()
        .and_then(|arguments| arguments.get("workspace"))
        .and_then(serde_json::Value::as_str);
    let principal_id = crate::harness::principal_key(principal);
    let argument_sha256 = request_argument_sha256(request)?;
    let resource_scope = request_resource_scope(request);

    if !principal_can_use(principal, &route.tool, workspace) {
        record_audit(
            state,
            principal,
            workspace,
            &route,
            AuditPolicyDecision::AuthorizationDenied,
            AuditApprovalDecision::NotApplicable,
            AuditResultCategory::Denied,
            started,
            None,
            None,
        )
        .await;
        return Ok(Some(tool_error(
            "authorization denied: SourceNerve identity does not grant this extension tool",
        )));
    }

    let user_approved = if route.tool.policy.approval == ApprovalMode::Ask {
        harness_approved
            || consume_scoped_approval(&principal_id, &route.tool.public_name, &argument_sha256)
                .await
            || (eligible_for_tool_scope(&route.tool.public_name)
                && consume_tool_approval(
                    &principal_id,
                    &route.tool.public_name,
                    resource_scope.as_deref(),
                )
                .await)
            || consume_approval(&route.tool.public_name).await
    } else {
        false
    };
    let approval_decision = match route.tool.policy.approval {
        ApprovalMode::Ask if user_approved => AuditApprovalDecision::Approved,
        ApprovalMode::Ask => AuditApprovalDecision::Missing,
        ApprovalMode::Automatic => AuditApprovalDecision::NotRequired,
        ApprovalMode::Blocked => AuditApprovalDecision::NotApplicable,
    };
    match evaluate_tool_policy(Some(route.tool.policy), user_approved) {
        PolicyDecision::Deny => {
            record_audit(
                state,
                principal,
                workspace,
                &route,
                AuditPolicyDecision::Blocked,
                approval_decision,
                AuditResultCategory::Denied,
                started,
                None,
                None,
            )
            .await;
            tracing::info!(
                extension = %route.extension.id,
                public_tool = %route.tool.public_name,
                policy = "blocked",
                "MCP extension tool call denied by policy"
            );
            return Ok(Some(tool_error(
                "SourceNerve policy blocks this MCP extension tool",
            )));
        }
        PolicyDecision::RequireApproval => {
            let (approval_id, expires_in_seconds) = request_pending_approval(
                &principal_id,
                &route.tool.public_name,
                &argument_sha256,
                resource_scope.clone(),
            )
            .await;
            record_audit(
                state,
                principal,
                workspace,
                &route,
                AuditPolicyDecision::Ask,
                approval_decision,
                AuditResultCategory::ApprovalRequired,
                started,
                None,
                None,
            )
            .await;
            tracing::info!(
                extension = %route.extension.id,
                public_tool = %route.tool.public_name,
                policy = "ask",
                "MCP extension tool call requires explicit approval"
            );
            return Ok(Some(approval_required_error(
                &approval_id,
                &route.tool.public_name,
                expires_in_seconds,
            )));
        }
        PolicyDecision::Allow => {}
    }

    let credential = match route.extension.auth_type {
        ExtensionAuthType::None => None,
        ExtensionAuthType::Bearer | ExtensionAuthType::Oauth => {
            let Some(credential) = materialized_credential(&route.extension.id).await else {
                record_audit(
                    state,
                    principal,
                    workspace,
                    &route,
                    AuditPolicyDecision::ConfigurationError,
                    approval_decision,
                    AuditResultCategory::ConfigurationError,
                    started,
                    Some("credential-unavailable"),
                    Some("Credential is not materialized in SourceNerve secure storage"),
                )
                .await;
                return Ok(Some(tool_error(
                    "This MCP extension requires credential materialization from SourceNerve secure storage",
                )));
            };
            Some(credential)
        }
    };
    let environment = materialized_environment(&route.extension.id).await;

    let call = mcp_extension_client::call_tool(
        &route.extension,
        &route.tool.original_name,
        request.arguments.clone(),
        credential.as_deref(),
        environment.as_ref(),
    )
    .await;
    match call {
        Ok(result) => {
            let downstream_error = result.is_error == Some(true);
            let category = if downstream_error {
                AuditResultCategory::DownstreamError
            } else {
                AuditResultCategory::Success
            };
            let diagnostic = downstream_error
                .then(|| downstream_result_diagnostic(&result))
                .flatten();
            record_audit(
                state,
                principal,
                workspace,
                &route,
                AuditPolicyDecision::Allow,
                approval_decision,
                category,
                started,
                downstream_error.then_some("downstream-tool-error"),
                diagnostic.as_deref(),
            )
            .await;
            tracing::info!(
                extension = %route.extension.id,
                public_tool = %route.tool.public_name,
                downstream_tool = %route.tool.original_name,
                schema_hash = %route.tool.schema_hash,
                approval = %route.tool.policy.approval.as_str(),
                elapsed_ms = started.elapsed().as_millis(),
                "MCP extension tool call completed"
            );
            Ok(Some(ensure_extension_structured_content(result).into()))
        }
        Err(error) => {
            let previous_runtime_failure =
                if mcp_extension_runtime::is_runtime_circuit_open_error(&error)
                    || mcp_extension_runtime::is_fail_closed_error(&error)
                {
                    mcp_extension_runtime::health(&state.db, &route.extension.id)
                        .await
                        .ok()
                        .and_then(|snapshot| snapshot.last_error_category)
                } else {
                    None
                };
            let error_category =
                mcp_extension_runtime::audit_error_category(&error, previous_runtime_failure);
            let diagnostic = mcp_extension_audit::sanitize_diagnostic(&error.to_string());
            record_audit(
                state,
                principal,
                workspace,
                &route,
                AuditPolicyDecision::Allow,
                approval_decision,
                AuditResultCategory::DownstreamError,
                started,
                Some(&error_category),
                diagnostic.as_deref(),
            )
            .await;
            let registry_error = diagnostic.as_deref().unwrap_or(&error_category);
            let _ =
                mcp_extension_registry::mark_error(&state.db, &route.extension.id, registry_error)
                    .await;
            tracing::warn!(
                extension = %route.extension.id,
                public_tool = %route.tool.public_name,
                downstream_tool = %route.tool.original_name,
                elapsed_ms = started.elapsed().as_millis(),
                error_category = %error_category,
                "MCP extension tool call failed"
            );
            Ok(Some(tool_error(format!(
                "downstream MCP extension `{}` failed to execute `{}`: {error}",
                route.extension.name, route.tool.original_name
            ))))
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn record_audit(
    state: &AppState,
    principal: &Principal,
    workspace: Option<&str>,
    route: &ToolRoute,
    policy_decision: AuditPolicyDecision,
    approval_decision: AuditApprovalDecision,
    result_category: AuditResultCategory,
    started: Instant,
    error_category: Option<&str>,
    diagnostic: Option<&str>,
) {
    let event = AuditEvent {
        principal,
        workspace_id: workspace,
        extension_id: &route.extension.id,
        extension_version: &route.extension.version,
        public_tool: &route.tool.public_name,
        original_tool: &route.tool.original_name,
        schema_hash: &route.tool.schema_hash,
        policy_decision,
        approval_decision,
        result_category,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        error_category,
        diagnostic,
    };
    if let Err(error) = mcp_extension_audit::record(&state.db, event).await {
        tracing::error!(
            extension = %route.extension.id,
            public_tool = %route.tool.public_name,
            error = %bounded_error(&error.to_string()),
            "failed to persist MCP invocation audit metadata"
        );
    }
}

pub async fn refresh_extension(
    pool: &SqlitePool,
    extension_id: &str,
    bearer: Option<&str>,
) -> AppResult<Vec<ExtensionToolRecord>> {
    let extension = mcp_extension_registry::get(pool, extension_id)
        .await?
        .ok_or_else(|| {
            AppError::InvalidRequest(format!("MCP extension `{extension_id}` is not registered"))
        })?;
    if !extension.enabled {
        return Err(AppError::InvalidRequest(format!(
            "MCP extension `{extension_id}` must be enabled before discovery"
        )));
    }
    let environment = materialized_environment(extension_id).await;

    match mcp_extension_client::discover_tools(&extension, bearer, environment.as_ref()).await {
        Ok(discovered) => {
            let tools =
                mcp_extension_registry::replace_discovered_tools(pool, extension_id, &discovered)
                    .await?;
            let _ = mcp_extension_registry::set_enabled(pool, extension_id, true).await?;
            tracing::info!(
                extension = %extension.id,
                discovered_tools = tools.len(),
                "MCP extension discovery completed"
            );
            Ok(tools)
        }
        Err(error) => {
            let category = mcp_extension_runtime::classify_error(&error);
            let diagnostic = mcp_extension_audit::sanitize_diagnostic(&error.to_string())
                .unwrap_or_else(|| category.as_str().to_owned());
            let _ = mcp_extension_registry::mark_error(pool, extension_id, &diagnostic).await;
            Err(error)
        }
    }
}

async fn ensure_initial_discovery(pool: &SqlitePool) -> AppResult<()> {
    for extension in mcp_extension_registry::list(pool).await? {
        if !extension.enabled {
            continue;
        }
        let cached = mcp_extension_registry::list_tools(pool, &extension.id).await?;
        if !cached.is_empty() {
            continue;
        }
        let credential = match extension.auth_type {
            ExtensionAuthType::None => None,
            ExtensionAuthType::Bearer | ExtensionAuthType::Oauth => {
                let credential = materialized_credential(&extension.id).await;
                if credential.is_none() {
                    if extension.required {
                        return Err(AppError::InvalidRequest(format!(
                            "required MCP extension `{}` needs secure credential materialization before discovery",
                            extension.id
                        )));
                    }
                    tracing::debug!(
                        extension = %extension.id,
                        "skipping automatic discovery for MCP extension without materialized credential"
                    );
                    continue;
                }
                credential
            }
        };
        if let Err(error) = refresh_extension(pool, &extension.id, credential.as_deref()).await {
            if extension.required {
                return Err(error);
            }
            tracing::warn!(
                extension = %extension.id,
                error = %error,
                "optional MCP extension discovery failed; continuing without its tools"
            );
        }
    }
    Ok(())
}

async fn routes(pool: &SqlitePool) -> AppResult<Vec<ToolRoute>> {
    let mut result = Vec::new();
    for extension in mcp_extension_registry::list(pool).await? {
        if !extension.enabled {
            continue;
        }
        for tool in mcp_extension_registry::list_tools(pool, &extension.id).await? {
            result.push(ToolRoute {
                extension: extension.clone(),
                tool,
            });
        }
    }
    Ok(result)
}

async fn resolve_route(pool: &SqlitePool, public_name: &str) -> AppResult<Option<ToolRoute>> {
    if !safe_route_key(public_name, 120) {
        return Ok(None);
    }
    for route in routes(pool).await? {
        if route.tool.public_name == public_name {
            return Ok(Some(route));
        }
    }
    Ok(None)
}

fn safe_route_key(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|ch| !matches!(ch, '\r' | '\n' | '\0') && !ch.is_control())
}

fn valid_env_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z') | Some(b'_'))
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && value.len() <= 128
}

fn principal_can_use(
    _principal: &Principal,
    _tool: &ExtensionToolRecord,
    _workspace: Option<&str>,
) -> bool {
    true
}

fn extension_output_schema(tool_name: &str) -> Arc<serde_json::Map<String, serde_json::Value>> {
    Arc::new(
        serde_json::json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "description": format!(
                "Structured result forwarded by SourceNerve from MCP extension tool `{tool_name}`."
            ),
            "oneOf": [
                { "type": "object" },
                { "type": "array" },
                { "type": "string" },
                { "type": "number" },
                { "type": "boolean" },
                { "type": "null" }
            ]
        })
        .as_object()
        .expect("extension output schema must be a JSON object")
        .clone(),
    )
}

fn public_tool(tool: &ExtensionToolRecord) -> AppResult<Tool> {
    let schema = tool.input_schema.as_object().ok_or_else(|| {
        AppError::InvalidRequest(format!(
            "MCP extension tool `{}` has a non-object input schema",
            tool.public_name
        ))
    })?;
    let title = format!("MCP Extension · {}", tool.original_name);
    let mut result = Tool::new(
        tool.public_name.clone(),
        tool.description
            .clone()
            .unwrap_or_else(|| format!("Forwarded MCP extension tool `{}`", tool.original_name)),
        Arc::new(schema.clone()),
    );
    let classification = effective_extension_classification(tool);
    result.title = Some(title.clone());
    result.output_schema = Some(extension_output_schema(&tool.public_name));
    result.annotations = Some(
        ToolAnnotations::with_title(title)
            .read_only(classification.read_only.unwrap_or(false))
            .destructive(classification.destructive.unwrap_or(true))
            .idempotent(classification.idempotent.unwrap_or(false))
            .open_world(classification.open_world.unwrap_or(true)),
    );
    Ok(result)
}

fn browser_observation_requests_file_output(
    public_tool: &str,
    arguments: Option<&serde_json::Map<String, serde_json::Value>>,
) -> bool {
    let Some((namespace, operation)) = public_tool.rsplit_once("__") else {
        return false;
    };
    namespace.starts_with("chrome-devtools-mcp-")
        && matches!(operation, "take_snapshot" | "take_screenshot")
        && arguments.is_some_and(|args| args.contains_key("filePath"))
}

fn effective_extension_classification(
    tool: &ExtensionToolRecord,
) -> crate::mcp_extension_policy::ToolClassification {
    let browser =
        complete_known_browser_classification(&tool.public_name, tool.policy.classification);
    complete_known_google_workspace_classification(&tool.extension_id, &tool.public_name, browser)
}

fn ensure_extension_structured_content(mut result: CallToolResult) -> CallToolResult {
    if result.is_error == Some(true) || result.structured_content.is_some() {
        return result;
    }
    result.structured_content = result
        .content
        .iter()
        .find_map(ContentBlock::as_text)
        .map(|text| {
            serde_json::from_str(&text.text)
                .unwrap_or_else(|_| serde_json::Value::String(text.text.clone()))
        })
        .or(Some(serde_json::Value::Null));
    result
}

fn tool_error(message: impl Into<String>) -> CallToolResponse {
    CallToolResult::error(vec![ContentBlock::text(message.into())]).into()
}

fn approval_required_error(
    approval_id: &str,
    public_tool: &str,
    expires_in_seconds: u64,
) -> CallToolResponse {
    let message = format!(
        "⚠️ APPROVAL REQUIRED: SourceNerve policy requires explicit approval before this MCP extension tool can run; approval_id={approval_id} public_tool=`{public_tool}` expires_in_seconds={expires_in_seconds}. Prompt the user to allow this exact action, allow_tool for a limited set of repetitions (where eligible), or deny. Once allowed, call `harness_approval_respond` with approval_id `{approval_id}` and decision `allow`, then retry this action."
    );
    let mut result = CallToolResult::error(vec![ContentBlock::text(message)]);
    result.structured_content = Some(serde_json::json!({
        "status": "approval_required",
        "approval_id": approval_id,
        "public_tool": public_tool,
        "expires_in_seconds": expires_in_seconds,
        "requires_user_confirmation": true,
        "retry": "After allow, retry this exact call. After explicit allow_tool, reuse only the same tool and resource within the limited grant."
    }));
    result.into()
}

fn downstream_result_diagnostic(result: &CallToolResult) -> Option<String> {
    result
        .content
        .iter()
        .find_map(ContentBlock::as_text)
        .and_then(|text| mcp_extension_audit::sanitize_diagnostic(&text.text))
}

fn bounded_error(message: &str) -> String {
    const MAX_ERROR_BYTES: usize = 4096;
    let sanitized = message
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>();
    if sanitized.len() <= MAX_ERROR_BYTES {
        return sanitized;
    }
    let mut end = MAX_ERROR_BYTES;
    while !sanitized.is_char_boundary(end) {
        end -= 1;
    }
    sanitized[..end].to_owned()
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::mcp_extension_policy::{ToolClassification, ToolPolicy};

    fn tool(read_only: Option<bool>) -> ExtensionToolRecord {
        ExtensionToolRecord {
            extension_id: "memory".into(),
            original_name: "search".into(),
            public_name: "memory__search".into(),
            description: Some("Search".into()),
            input_schema: serde_json::json!({ "type": "object" }),
            schema_hash: "abc".into(),
            policy: ToolPolicy {
                enabled: true,
                approval: ApprovalMode::Automatic,
                classification: ToolClassification {
                    read_only,
                    destructive: None,
                    idempotent: None,
                    open_world: None,
                },
            },
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn apps_script_capability_only_lists_known_authorized_clasp_tools() {
        let mut clasp = tool(Some(false));
        clasp.extension_id = "google-clasp-mcp".into();
        clasp.public_name = "clasp__list_projects".into();
        clasp.original_name = "list_projects".into();
        let exposed = public_tool(&clasp).expect("clasp tool");
        let summary = extension_capability_summary(&[exposed]);
        assert_eq!(summary["apps_script"]["routable"], true);
        assert_eq!(summary["apps_script"]["requires_external_oauth"], true);
        assert_eq!(
            summary["apps_script"]["tool_names"][0],
            "clasp__list_projects"
        );
        assert_eq!(summary["browser_use"]["routable"], false);

        clasp.public_name = "clasp__arbitrary_tool".into();
        let unknown = public_tool(&clasp).expect("unknown tool still has schema");
        let summary = extension_capability_summary(&[unknown]);
        assert_eq!(summary["apps_script"]["routable"], false);
        assert!(
            summary["apps_script"]["tool_names"]
                .as_array()
                .expect("tool names array")
                .is_empty()
        );
    }

    #[test]
    fn browser_screenshot_is_observable_without_claiming_coordinate_vision() {
        let mut screenshot = tool(None);
        screenshot.extension_id = "chrome-devtools-mcp-6f0fffa".into();
        screenshot.public_name = "chrome-devtools-mcp-6f0fffa__take_screenshot".into();
        screenshot.original_name = "take_screenshot".into();
        let exposed = public_tool(&screenshot).expect("Chrome screenshot tool");
        assert_eq!(
            exposed
                .annotations
                .as_ref()
                .and_then(|value| value.read_only_hint),
            Some(true)
        );
        let summary = extension_capability_summary(&[exposed]);
        assert_eq!(summary["browser_visual_observation"]["routable"], true);
        assert_eq!(
            summary["browser_visual_observation"]["tool_names"][0],
            "chrome-devtools-mcp-6f0fffa__take_screenshot"
        );
        assert_eq!(
            summary["browser_visual_observation"]["scope"],
            "selected-browser-page-inline-image-only"
        );
        assert_eq!(summary["browser_vision"]["routable"], false);
        assert_eq!(summary["computer_use"]["routable"], false);
    }

    #[test]
    fn browser_vision_requires_both_screenshot_and_coordinate_control() {
        let mut click = tool(Some(false));
        click.extension_id = "chrome-devtools-mcp-6f0fffa".into();
        click.public_name = "chrome-devtools-mcp-6f0fffa__click_at".into();
        click.original_name = "click_at".into();
        let click_tool = public_tool(&click).expect("coordinate tool");
        let without_screenshot = extension_capability_summary(&[click_tool.clone()]);
        assert_eq!(without_screenshot["browser_vision"]["routable"], false);

        let mut screenshot = tool(None);
        screenshot.extension_id = "chrome-devtools-mcp-6f0fffa".into();
        screenshot.public_name = "chrome-devtools-mcp-6f0fffa__take_screenshot".into();
        screenshot.original_name = "take_screenshot".into();
        let with_screenshot = extension_capability_summary(&[
            click_tool,
            public_tool(&screenshot).expect("image observation tool"),
        ]);
        assert_eq!(with_screenshot["browser_vision"]["routable"], true);
    }

    #[test]
    fn desktop_google_workspace_capabilities_never_imply_oauth_or_appsheet_keys() {
        let mut script = tool(Some(false));
        script.extension_id = "sourcenerve-google-workspace".into();
        script.public_name = "google-workspace__apps_script_list_projects".into();
        script.original_name = "apps_script_list_projects".into();
        let mut appsheet = tool(Some(false));
        appsheet.extension_id = "sourcenerve-google-workspace".into();
        appsheet.public_name = "google-workspace__appsheet_find_rows".into();
        appsheet.original_name = "appsheet_find_rows".into();
        let summary = extension_capability_summary(&[
            public_tool(&script).expect("script tool"),
            public_tool(&appsheet).expect("appsheet tool"),
        ]);
        assert_eq!(summary["apps_script"]["routable"], true);
        assert_eq!(summary["apps_script"]["requires_external_oauth"], true);
        assert_eq!(summary["apps_script"]["backends"][0], "desktop-oauth-proxy");
        assert_eq!(
            summary["apps_script"]["tool_names"][0],
            "google-workspace__apps_script_list_projects"
        );
        assert_eq!(summary["appsheet_api"]["routable"], true);
        assert_eq!(summary["appsheet_api"]["requires_per_app_key"], true);
        assert_eq!(
            summary["appsheet_api"]["backends"][0],
            "desktop-api-key-proxy"
        );
        assert_eq!(summary["browser_use"]["routable"], false);
    }

    #[test]
    fn google_script_project_directory_is_routable_through_read_dispatcher() {
        let mut script = tool(None);
        script.extension_id = "sourcenerve-google-workspace".into();
        script.original_name = "apps_script_list_projects".into();
        script.public_name = "google-workspace__apps_script_list_projects".into();
        let annotation = public_tool(&script).expect("built-in script directory");
        assert_eq!(
            annotation
                .annotations
                .as_ref()
                .and_then(|value| value.read_only_hint),
            Some(true)
        );
        assert_eq!(
            effective_extension_classification(&script).read_only,
            Some(true)
        );

        script.extension_id = "untrusted-google-extension".into();
        assert_ne!(
            effective_extension_classification(&script).read_only,
            Some(true)
        );
        script.extension_id = "sourcenerve-google-workspace".into();
        script.original_name = "apps_script_update_content".into();
        script.public_name = "google-workspace__apps_script_update_content".into();
        assert_ne!(
            effective_extension_classification(&script).read_only,
            Some(true)
        );
    }

    #[test]
    fn browser_observation_refuses_filesystem_output_even_on_direct_dispatch() {
        let mut args = serde_json::Map::new();
        assert!(!browser_observation_requests_file_output(
            "chrome-devtools-mcp-6f0fffa__take_snapshot",
            Some(&args)
        ));
        args.insert("filePath".into(), serde_json::json!("/tmp/snapshot.txt"));
        for tool in ["take_snapshot", "take_screenshot"] {
            assert!(browser_observation_requests_file_output(
                &format!("chrome-devtools-mcp-6f0fffa__{tool}"),
                Some(&args),
            ));
        }
        assert!(!browser_observation_requests_file_output(
            "another-extension__take_snapshot",
            Some(&args)
        ));
        assert!(!browser_observation_requests_file_output(
            "chrome-devtools-mcp-6f0fffa__list_pages",
            Some(&args)
        ));
    }

    #[test]
    fn extension_tool_schema_is_exposed_under_public_namespace() {
        let exposed = public_tool(&tool(Some(true))).expect("public tool");
        assert_eq!(exposed.name.as_ref(), "memory__search");
        assert!(exposed.output_schema.is_some());
        assert_eq!(
            exposed
                .annotations
                .as_ref()
                .and_then(|value| value.read_only_hint),
            Some(true)
        );
    }

    #[test]
    fn extension_text_results_receive_structured_content_for_output_schema() {
        let result = CallToolResult::success(vec![ContentBlock::text("plain downstream text")]);
        let result = ensure_extension_structured_content(result);
        assert_eq!(
            result.structured_content,
            Some(serde_json::Value::String("plain downstream text".into()))
        );
    }

    #[test]
    fn downstream_error_diagnostic_is_sanitized_before_audit() {
        let result = CallToolResult::error(vec![ContentBlock::text(
            "401 Unauthorized token=super-secret-value Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        )]);
        let diagnostic = downstream_result_diagnostic(&result).expect("diagnostic");
        assert!(diagnostic.contains("401 Unauthorized"));
        assert!(!diagnostic.contains("super-secret-value"));
        assert!(!diagnostic.contains("abcdefghijklmnopqrstuvwxyz"));
    }

    #[test]
    fn downstream_error_text_is_bounded_and_single_line_safe() {
        let sanitized = bounded_error("boom\nwith\rcontrol");
        assert_eq!(sanitized, "boom with control");
    }

    #[test]
    fn route_keys_reject_control_characters() {
        assert!(safe_route_key("memory__search", 120));
        assert!(!safe_route_key("memory__search\nother", 120));
    }

    #[test]
    fn environment_keys_are_restricted() {
        assert!(valid_env_key("GITHUB_TOKEN"));
        assert!(!valid_env_key("github_token"));
        assert!(!valid_env_key("BAD-NAME"));
    }

    #[tokio::test]
    async fn tool_scope_requires_explicit_decision_and_is_resource_bounded() {
        let name = format!(
            "google-workspace__apps_script_update_content_{}",
            Uuid::new_v4()
        );
        let principal = "scoped-tool-principal";
        let scope = Some("scriptId:hash-a".to_owned());
        let (id, _) =
            request_pending_approval(principal, &name, "hash-of-first-code", scope.clone()).await;
        let response = respond_pending_approval(&id, "allow_tool", principal, false)
            .await
            .expect("allow scoped tool")
            .expect("pending approval");
        assert_eq!(response["one_shot"], false);
        assert_eq!(response["uses_remaining"], MAX_TOOL_SCOPE_USES);
        assert!(!consume_tool_approval(principal, &name, Some("scriptId:hash-b")).await);
        assert!(!consume_tool_approval("other-user", &name, scope.as_deref()).await);
        for _ in 0..MAX_TOOL_SCOPE_USES {
            assert!(consume_tool_approval(principal, &name, scope.as_deref()).await);
        }
        assert!(!consume_tool_approval(principal, &name, scope.as_deref()).await);
    }

    #[tokio::test]
    async fn sensitive_extension_tools_cannot_receive_tool_scope() {
        let name = format!("files__delete_{}", Uuid::new_v4());
        let (id, _) =
            request_pending_approval("sensitive-principal", &name, "arguments", None).await;
        assert!(
            respond_pending_approval(&id, "allow_tool", "sensitive-principal", false)
                .await
                .is_err()
        );
        assert!(pending_approval_exists(&id).await);
    }

    #[tokio::test]
    async fn extension_approval_is_exact_reused_while_pending_and_one_shot_after_allow() {
        let public_tool = format!("desktop-control__test_{}", Uuid::new_v4());
        let principal_id = "approval-test-principal";
        let argument_sha256 = hex::encode(Sha256::digest(b"exact-arguments"));

        let (first_id, _) =
            request_pending_approval(principal_id, &public_tool, &argument_sha256, None).await;
        let (second_id, _) =
            request_pending_approval(principal_id, &public_tool, &argument_sha256, None).await;
        assert_eq!(first_id, second_id);
        assert!(pending_approval_exists(&first_id).await);

        let response = respond_pending_approval(&first_id, "allow", principal_id, false)
            .await
            .expect("respond approval")
            .expect("pending extension approval");
        assert_eq!(response["status"], "allowed");
        assert!(!pending_approval_exists(&first_id).await);
        assert!(consume_scoped_approval(principal_id, &public_tool, &argument_sha256).await);
        assert!(!consume_scoped_approval(principal_id, &public_tool, &argument_sha256).await);
    }
}

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};

use crate::{
    mcp::SourceNerveMcp,
    observability,
    ops::AuditQuery,
    publication_http, runtime,
    service::{AppState, PatchRequest, ReadFileRequest, WorkspaceArg},
    state_backup::{BackupCreateRequest, BackupValidateRequest},
};

const PUBLIC_MCP_HOST: &str = "sourcenerve.fogewise.io.vn";

#[derive(Clone)]
struct AuthState {
    token: Arc<String>,
}

fn extract_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

async fn auth_middleware(
    State(auth): State<AuthState>,
    headers: HeaderMap,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    match extract_token(&headers) {
        Some(token) if token.as_bytes() == auth.token.as_bytes() => Ok(next.run(request).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

async fn mcp_middleware(mut request: Request<axum::body::Body>, next: Next) -> Response {
    request
        .extensions_mut()
        .insert(crate::principal::Principal::Operator);

    let origin = request.headers().get(header::ORIGIN).cloned();
    let allow_origin = match origin.as_ref().and_then(|h| h.to_str().ok()) {
        Some(o) if !o.is_empty() => {
            HeaderValue::from_str(o).unwrap_or_else(|_| HeaderValue::from_static("*"))
        }
        _ => HeaderValue::from_static("*"),
    };

    // Handle OPTIONS (CORS preflight for gemini.google.com and other web clients)
    if request.method() == Method::OPTIONS {
        let mut response = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(axum::body::Body::empty())
            .unwrap_or_default();
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, DELETE, OPTIONS, HEAD"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(
                "Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, X-Requested-With, Cache-Control, Mcp-Protocol-Version",
            ),
        );
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("Mcp-Session-Id, Content-Type, Mcp-Protocol-Version"),
        );
        headers.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("86400"),
        );
        if origin.is_some() {
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
                HeaderValue::from_static("true"),
            );
            headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        }
        return response;
    }

    // Handle HEAD probe
    if request.method() == Method::HEAD {
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .body(axum::body::Body::empty())
            .unwrap_or_default();
        let headers = response.headers_mut();
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        if origin.is_some() {
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
                HeaderValue::from_static("true"),
            );
            headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        }
        return response;
    }

    // Handle GET probe when not an established SSE stream
    if request.method() == Method::GET {
        let has_session = request.headers().contains_key("mcp-session-id");
        let has_last_event = request.headers().contains_key("last-event-id");
        let is_sse_accept = request
            .headers()
            .get(header::ACCEPT)
            .and_then(|h| h.to_str().ok())
            .map(|h| h.contains("text/event-stream"))
            .unwrap_or(false);

        // If client sends GET without session ID, rmcp returns 400 Bad Request: Session ID is required.
        // Google Gemini and other validators probe GET /mcp to verify endpoint liveness.
        if !has_session && !has_last_event && !is_sse_accept {
            let body = serde_json::json!({
                "status": "ok",
                "service": "sourcenerve",
                "protocol": "mcp",
                "transport": "streamable-http",
                "version": env!("CARGO_PKG_VERSION")
            });
            let mut response = axum::Json(body).into_response();
            let headers = response.headers_mut();
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
            if origin.is_some() {
                headers.insert(
                    header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
                    HeaderValue::from_static("true"),
                );
                headers.insert(header::VARY, HeaderValue::from_static("Origin"));
            }
            return response;
        }

        // Ensure SSE accept header is set so rmcp doesn't fail with 406
        if !is_sse_accept {
            request.headers_mut().insert(
                header::ACCEPT,
                HeaderValue::from_static("text/event-stream"),
            );
        }
    }

    // Normalize POST Accept header for rmcp compatibility
    if request.method() == Method::POST {
        let needs_accept_fix = request
            .headers()
            .get(header::ACCEPT)
            .and_then(|h| h.to_str().ok())
            .map(|h| !h.contains("application/json") || !h.contains("text/event-stream"))
            .unwrap_or(true);

        if needs_accept_fix {
            request.headers_mut().insert(
                header::ACCEPT,
                HeaderValue::from_static("application/json, text/event-stream"),
            );
        }
    }

    // Normalize Host header so internal rmcp host-validation does not reject valid public tunnel routes
    request
        .headers_mut()
        .insert(header::HOST, HeaderValue::from_static("127.0.0.1"));

    // Call rmcp service
    let mut response = next.run(request).await;

    // Inject CORS headers on response
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, DELETE, OPTIONS, HEAD"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "Authorization, Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, X-Requested-With, Cache-Control, Mcp-Protocol-Version",
        ),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Mcp-Session-Id, Content-Type, Mcp-Protocol-Version"),
    );
    if origin.is_some() {
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    }

    response
}

fn mcp_server_config() -> StreamableHttpServerConfig {
    // Session-era MCP clients need the standalone SSE stream for server-initiated
    // notifications such as notifications/tools/list_changed. Keep the session
    // transport enabled while still using guarded host validation.
    StreamableHttpServerConfig::default()
        .with_legacy_session_mode(true)
        .with_json_response(true)
        .with_allowed_hosts(["localhost", "127.0.0.1", "::1", PUBLIC_MCP_HOST])
}

pub fn router(
    state: AppState,
    bearer_token: String,
    webhook_secret: Option<String>,
    github_webhook_secret: Option<String>,
    callback_enabled: bool,
) -> Router {
    let api_auth = AuthState {
        token: Arc::new(bearer_token.clone()),
    };
    let mcp_state = state.clone();
    let mcp_service = StreamableHttpService::new(
        move || Ok(SourceNerveMcp::new(mcp_state.clone())),
        LocalSessionManager::default().into(),
        mcp_server_config(),
    );

    let mut api = Router::new()
        .route("/status", get(service_status))
        .route("/readiness", get(readiness))
        .route("/state/backup", post(state_backup_create))
        .route("/state/backup/validate", post(state_backup_validate))
        .route("/audit", post(audit_events))
        .route("/workspaces", get(list_workspaces))
        .route("/snapshot", post(snapshot))
        .route("/read", post(read_file))
        .route("/diff", post(diff))
        .route("/patch/preview", post(preview_patch))
        .route("/patch/apply", post(apply_patch))
        .merge(crate::mcp_extension_http::router())
        .merge(crate::mcp_extension_activity_http::router())
        .merge(crate::plugin_hub_runtime::router())
        .merge(crate::workflow_http::router())
        .merge(crate::harness_http::router())
        .merge(crate::task_http::router())
        .merge(crate::job_http::api_router());
    if callback_enabled {
        api = api.merge(crate::callback_http::router());
    }
    if observability::metrics_enabled() {
        api = api.merge(crate::observability_http::protected_router());
    }
    let api = api.with_state(state.clone());

    let protected_api = Router::new()
        .nest("/api/v1", api)
        .route_layer(middleware::from_fn_with_state(api_auth, auth_middleware));
    let public_mcp = Router::new()
        .nest_service("/mcp", mcp_service)
        .route_layer(middleware::from_fn(mcp_middleware));

    let readiness_state = state.clone();
    let mut public = Router::new()
        .route("/healthz", get(health))
        .route("/gpt-actions/openapi.json", get(gpt_actions_openapi))
        .route(
            "/readyz",
            get(move || {
                let state = readiness_state.clone();
                async move { public_readiness(state).await }
            }),
        )
        .merge(publication_http::router());
    if observability::metrics_public() {
        public = public.merge(crate::observability_http::public_router());
    }
    if let Some(secret) = webhook_secret {
        public = public.merge(crate::job_http::webhook_router(state.clone(), secret));
    }
    if let Some(secret) = github_webhook_secret {
        public = public.merge(crate::github_webhook_http::router(state, secret));
    }
    public
        .merge(protected_api)
        .merge(public_mcp)
        .layer(middleware::from_fn(observability::request_middleware))
}

fn safe_forwarded_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)?
        .to_str()
        .ok()?
        .split(',')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn safe_public_host(value: &str) -> Option<&str> {
    if value.len() > 255
        || !value.is_ascii()
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']')
        })
    {
        return None;
    }
    Some(value)
}

fn public_origin(headers: &HeaderMap) -> String {
    let scheme = safe_forwarded_value(headers, "x-forwarded-proto")
        .filter(|value| matches!(*value, "http" | "https"))
        .unwrap_or("http");
    let host = safe_forwarded_value(headers, "x-forwarded-host")
        .and_then(safe_public_host)
        .or_else(|| {
            headers
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .and_then(safe_public_host)
        })
        .unwrap_or("127.0.0.1:7331");
    format!("{scheme}://{host}")
}

async fn gpt_actions_openapi(headers: HeaderMap) -> Response {
    let body = include_str!("../docs/gpt-actions-openapi.json")
        .replace("__SOURCENERVE_BASE_URL__", &public_origin(&headers));
    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

async fn health() -> Json<serde_json::Value> {
    let identity = runtime::identity();
    Json(serde_json::json!({
        "status": "ok",
        "service": identity.service,
        "version": identity.version,
        "build_commit": identity.build_commit,
        "state_schema_version": identity.state_schema_version,
    }))
}

async fn public_readiness(state: AppState) -> Response {
    let report = state.readiness().await;
    observability::set_readiness(report.ready);
    let status = if report.ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    let value = if report.ready { "ready" } else { "not_ready" };
    (status, Json(serde_json::json!({ "status": value }))).into_response()
}

async fn service_status(State(s): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::to_value(s.service_status()).unwrap())
}

async fn readiness(State(s): State<AppState>) -> Json<serde_json::Value> {
    let report = s.readiness().await;
    observability::set_readiness(report.ready);
    Json(serde_json::to_value(report).unwrap())
}

async fn state_backup_create(
    State(s): State<AppState>,
    Json(a): Json<BackupCreateRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.state_backup_create(a).await?).unwrap(),
    ))
}

async fn state_backup_validate(
    State(s): State<AppState>,
    Json(a): Json<BackupValidateRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.state_backup_validate(a).await?).unwrap(),
    ))
}

async fn audit_events(
    State(s): State<AppState>,
    Json(a): Json<AuditQuery>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.audit_events(a).await?).unwrap(),
    ))
}

async fn list_workspaces(
    State(s): State<AppState>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.list_workspaces().await?).unwrap(),
    ))
}

async fn snapshot(
    State(s): State<AppState>,
    Json(a): Json<WorkspaceArg>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.snapshot(&a.workspace).await?).unwrap(),
    ))
}

async fn read_file(
    State(s): State<AppState>,
    Json(a): Json<ReadFileRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(serde_json::to_value(s.read_file(a).await?).unwrap()))
}

async fn diff(
    State(s): State<AppState>,
    Json(a): Json<WorkspaceArg>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::json!({"diff":s.diff(&a.workspace).await?}),
    ))
}

async fn preview_patch(
    State(s): State<AppState>,
    Json(a): Json<PatchRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(
        serde_json::to_value(s.preview_patch(a).await?).unwrap(),
    ))
}

async fn apply_patch(
    State(s): State<AppState>,
    Json(a): Json<PatchRequest>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    Ok(Json(serde_json::to_value(s.apply_patch(a).await?).unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_server_config_allows_public_host_without_disabling_host_guard() {
        let config = mcp_server_config();
        assert!(config.legacy_session_mode);
        assert!(
            config
                .allowed_hosts
                .iter()
                .any(|host| host == PUBLIC_MCP_HOST)
        );
        assert!(config.allowed_hosts.iter().any(|host| host == "localhost"));
        assert!(!config.allowed_hosts.is_empty());
    }

    #[test]
    fn gpt_actions_origin_prefers_forwarded_https_host() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("x-forwarded-host", "source.example.test".parse().unwrap());
        headers.insert(header::HOST, "127.0.0.1:7331".parse().unwrap());

        assert_eq!(public_origin(&headers), "https://source.example.test");
    }

    #[test]
    fn gpt_actions_origin_rejects_unsafe_forwarded_host() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        headers.insert("x-forwarded-host", "bad/host".parse().unwrap());
        headers.insert(header::HOST, "127.0.0.1:7331".parse().unwrap());

        assert_eq!(public_origin(&headers), "https://127.0.0.1:7331");
    }

    #[tokio::test]
    async fn mcp_cors_preflight_and_probe_support_gemini() {
        let state_dir = tempfile::tempdir().expect("state tempdir");
        let registry = crate::workspace::WorkspaceRegistry::build(&[]).expect("empty registry");
        let pool = crate::db::connect(state_dir.path()).await.expect("db");
        let state = AppState {
            workspaces: registry,
            db: pool,
            mutation_lock: Arc::new(tokio::sync::Mutex::new(())),
            github_token: None,
        };
        let app = router(state, "test-bearer".to_string(), None, None, false);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("local address");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve router");
        });

        let client = reqwest::Client::new();
        let mcp_url = format!("http://{address}/mcp");

        // 1. OPTIONS preflight from gemini.google.com
        let res = client
            .request(reqwest::Method::OPTIONS, &mcp_url)
            .header("Origin", "https://gemini.google.com")
            .header("Access-Control-Request-Method", "POST")
            .header(
                "Access-Control-Request-Headers",
                "content-type,mcp-session-id",
            )
            .send()
            .await
            .expect("send options");
        assert_eq!(res.status(), reqwest::StatusCode::NO_CONTENT);
        assert_eq!(
            res.headers().get("access-control-allow-origin").unwrap(),
            "https://gemini.google.com"
        );
        assert!(res.headers().contains_key("access-control-allow-methods"));
        assert!(res.headers().contains_key("access-control-allow-headers"));

        // 2. HEAD probe
        let res = client
            .head(&mcp_url)
            .header("Origin", "https://gemini.google.com")
            .send()
            .await
            .expect("send head");
        assert_eq!(res.status(), reqwest::StatusCode::OK);
        assert_eq!(
            res.headers().get("access-control-allow-origin").unwrap(),
            "https://gemini.google.com"
        );

        // 3. GET probe without session
        let res = client
            .get(&mcp_url)
            .header("Origin", "https://gemini.google.com")
            .send()
            .await
            .expect("send get");
        assert_eq!(res.status(), reqwest::StatusCode::OK);
        assert_eq!(
            res.headers().get("access-control-allow-origin").unwrap(),
            "https://gemini.google.com"
        );
        let body: serde_json::Value = res.json().await.expect("parse json");
        assert_eq!(body["status"], "ok");
        assert_eq!(body["protocol"], "mcp");

        // 4. POST initialize with Accept: application/json
        let res = client
            .post(&mcp_url)
            .header("Origin", "https://gemini.google.com")
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "gemini-test", "version": "1.0" }
                }
            }))
            .send()
            .await
            .expect("send post initialize");
        assert_eq!(res.status(), reqwest::StatusCode::OK);
        assert_eq!(
            res.headers().get("access-control-allow-origin").unwrap(),
            "https://gemini.google.com"
        );
    }
}

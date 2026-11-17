use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::Query,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RegisteredClient {
    client_id: String,
    client_secret: String,
    redirect_uris: Vec<String>,
}

#[derive(Clone, Debug)]
struct PendingAuth {
    client_id: String,
    redirect_uri: String,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    expires_at: Instant,
}

#[derive(Default)]
struct OAuthState {
    clients: HashMap<String, RegisteredClient>,
    pending_codes: HashMap<String, PendingAuth>,
    access_tokens: HashMap<String, Instant>,
}

static OAUTH_STORE: OnceLock<Arc<Mutex<OAuthState>>> = OnceLock::new();

fn oauth_store() -> Arc<Mutex<OAuthState>> {
    OAUTH_STORE
        .get_or_init(|| Arc::new(Mutex::new(OAuthState::default())))
        .clone()
}

pub fn router() -> Router {
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(oauth_protected_resource).options(oauth_cors_preflight),
        )
        .route(
            "/.well-known/oauth-protected-resource/{*path}",
            get(oauth_protected_resource).options(oauth_cors_preflight),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(oauth_authorization_server).options(oauth_cors_preflight),
        )
        .route(
            "/.well-known/oauth-authorization-server/{*path}",
            get(oauth_authorization_server).options(oauth_cors_preflight),
        )
        .route(
            "/.well-known/openid-configuration",
            get(oauth_authorization_server).options(oauth_cors_preflight),
        )
        .route(
            "/.well-known/openid-configuration/{*path}",
            get(oauth_authorization_server).options(oauth_cors_preflight),
        )
        .route(
            "/mcp/.well-known/oauth-protected-resource",
            get(oauth_protected_resource).options(oauth_cors_preflight),
        )
        .route(
            "/mcp/.well-known/oauth-authorization-server",
            get(oauth_authorization_server).options(oauth_cors_preflight),
        )
        .route(
            "/oauth/register",
            post(oauth_register).options(oauth_cors_preflight),
        )
        .route(
            "/oauth/authorize",
            get(oauth_authorize).options(oauth_cors_preflight),
        )
        .route(
            "/oauth/token",
            post(oauth_token).options(oauth_cors_preflight),
        )
        .route("/oauth/jwks", get(oauth_jwks).options(oauth_cors_preflight))
}

fn apply_cors(res_headers: &mut HeaderMap, _req_headers: &HeaderMap) {
    res_headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    res_headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS, HEAD"),
    );
    res_headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type, Accept, Mcp-Session-Id"),
    );
    res_headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
    res_headers.insert(header::VARY, HeaderValue::from_static("Origin"));
}

async fn oauth_cors_preflight(headers: HeaderMap) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    apply_cors(response.headers_mut(), &headers);
    response
}

fn cors_json_response(
    value: serde_json::Value,
    headers: &HeaderMap,
    status: StatusCode,
) -> Response {
    let mut response = (status, Json(value)).into_response();
    apply_cors(response.headers_mut(), headers);
    response
}

/// RFC 9728: OAuth 2.0 Protected Resource Metadata
async fn oauth_protected_resource(headers: HeaderMap) -> Response {
    let origin = crate::http::public_origin(&headers);
    let body = serde_json::json!({
        "resource": format!("{origin}/mcp"),
        "authorization_servers": [origin],
        "scopes_supported": ["mcp"],
        "bearer_methods_supported": ["header"]
    });
    cors_json_response(body, &headers, StatusCode::OK)
}

/// RFC 8414: OAuth 2.0 Authorization Server Metadata
async fn oauth_authorization_server(headers: HeaderMap) -> Response {
    let origin = crate::http::public_origin(&headers);
    let body = serde_json::json!({
        "issuer": origin,
        "authorization_endpoint": format!("{origin}/oauth/authorize"),
        "token_endpoint": format!("{origin}/oauth/token"),
        "registration_endpoint": format!("{origin}/oauth/register"),
        "jwks_uri": format!("{origin}/oauth/jwks"),
        "response_types_supported": ["code", "token"],
        "response_modes_supported": ["query", "fragment"],
        "grant_types_supported": ["authorization_code", "client_credentials", "refresh_token"],
        "code_challenge_methods_supported": ["S256", "plain"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic", "none"],
        "scopes_supported": ["mcp", "openid", "profile", "email"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"]
    });
    cors_json_response(body, &headers, StatusCode::OK)
}

async fn oauth_jwks(headers: HeaderMap) -> Response {
    let body = serde_json::json!({
        "keys": []
    });
    cors_json_response(body, &headers, StatusCode::OK)
}

#[derive(Deserialize, Debug, Default)]
struct RegisterRequest {
    #[serde(default)]
    client_name: Option<String>,
    #[serde(default)]
    redirect_uris: Vec<String>,
    #[serde(default)]
    grant_types: Option<Vec<String>>,
    #[serde(default)]
    response_types: Option<Vec<String>>,
    #[serde(default)]
    token_endpoint_auth_method: Option<String>,
}

/// RFC 7591: Dynamic Client Registration
async fn oauth_register(headers: HeaderMap, body: Bytes) -> Response {
    let req: RegisterRequest = serde_json::from_slice(&body).unwrap_or_default();

    let client_id = format!("sn_client_{}", Uuid::new_v4().simple());
    let client_secret = format!("sn_secret_{}", Uuid::new_v4().simple());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let client = RegisteredClient {
        client_id: client_id.clone(),
        client_secret: client_secret.clone(),
        redirect_uris: req.redirect_uris.clone(),
    };

    {
        let store = oauth_store();
        let mut state = store.lock().unwrap();
        state.clients.insert(client_id.clone(), client);
    }

    let body = serde_json::json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "client_name": req.client_name.unwrap_or_else(|| "Google Gemini".to_string()),
        "client_id_issued_at": now,
        "client_secret_expires_at": 0,
        "redirect_uris": req.redirect_uris,
        "grant_types": req.grant_types.unwrap_or_else(|| vec!["authorization_code".to_string(), "refresh_token".to_string()]),
        "response_types": req.response_types.unwrap_or_else(|| vec!["code".to_string()]),
        "token_endpoint_auth_method": req.token_endpoint_auth_method.unwrap_or_else(|| "client_secret_post".to_string())
    });

    cors_json_response(body, &headers, StatusCode::CREATED)
}

#[derive(Deserialize, Debug, Default)]
struct AuthorizeQuery {
    #[allow(dead_code)]
    response_type: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    #[allow(dead_code)]
    scope: Option<String>,
    state: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
}

/// OAuth 2.0 Authorization Endpoint
async fn oauth_authorize(Query(query): Query<AuthorizeQuery>) -> Response {
    let redirect_uri_str = match &query.redirect_uri {
        Some(uri) if !uri.is_empty() => uri,
        _ => return (StatusCode::BAD_REQUEST, "Missing redirect_uri parameter").into_response(),
    };

    let code = format!("sn_code_{}", Uuid::new_v4().simple());

    {
        let store = oauth_store();
        let mut state = store.lock().unwrap();
        state.pending_codes.insert(
            code.clone(),
            PendingAuth {
                client_id: query.client_id.clone().unwrap_or_default(),
                redirect_uri: redirect_uri_str.clone(),
                code_challenge: query.code_challenge.clone(),
                code_challenge_method: query.code_challenge_method.clone(),
                expires_at: Instant::now() + Duration::from_secs(600),
            },
        );
    }

    let mut target_url = match url::Url::parse(redirect_uri_str) {
        Ok(parsed) => parsed,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid redirect_uri format").into_response(),
    };

    target_url.query_pairs_mut().append_pair("code", &code);
    if let Some(state_val) = &query.state {
        target_url.query_pairs_mut().append_pair("state", state_val);
    }

    let target_str = target_url.to_string();

    let html = format!(
        r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url={target_str}">
  <title>Authorizing SourceNerve...</title>
</head>
<body style="font-family: sans-serif; text-align: center; padding: 40px;">
  <h2>Đang kết nối SourceNerve với Google Gemini...</h2>
  <p><a href="{target_str}">Bấm vào đây nếu trình duyệt không tự chuyển hướng</a></p>
  <script>window.location.href = "{target_str}";</script>
</body>
</html>"#
    );

    let mut response = Html(html).into_response();
    *response.status_mut() = StatusCode::FOUND;
    if let Ok(val) = HeaderValue::try_from(target_str) {
        response.headers_mut().insert(header::LOCATION, val);
    }
    response
}

#[derive(Deserialize, Debug, Default)]
struct TokenRequest {
    grant_type: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    code_verifier: Option<String>,
    #[allow(dead_code)]
    refresh_token: Option<String>,
}

fn parse_basic_auth(headers: &HeaderMap) -> (Option<String>, Option<String>) {
    if let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(rest) = auth.strip_prefix("Basic ") {
            if let Ok(decoded) = STANDARD.decode(rest.trim()) {
                if let Ok(s) = String::from_utf8(decoded) {
                    if let Some((id, secret)) = s.split_once(':') {
                        return (Some(id.to_string()), Some(secret.to_string()));
                    }
                }
            }
        }
    }
    (None, None)
}

fn verify_pkce(verifier: &str, challenge: &str, method: Option<&str>) -> bool {
    let method = method.unwrap_or("S256");
    if method == "plain" {
        return verifier == challenge;
    }
    if method == "S256" {
        let hash = Sha256::digest(verifier.as_bytes());
        let calculated = URL_SAFE_NO_PAD.encode(hash);
        return calculated == challenge;
    }
    false
}

/// OAuth 2.0 Token Endpoint
async fn oauth_token(headers: HeaderMap, body: Bytes) -> Response {
    let mut token_req = TokenRequest::default();
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if content_type.contains("json") {
        if let Ok(parsed) = serde_json::from_slice::<TokenRequest>(&body) {
            token_req = parsed;
        }
    } else {
        for (k, v) in url::form_urlencoded::parse(&body) {
            match k.as_ref() {
                "grant_type" => token_req.grant_type = Some(v.into_owned()),
                "code" => token_req.code = Some(v.into_owned()),
                "redirect_uri" => token_req.redirect_uri = Some(v.into_owned()),
                "client_id" => token_req.client_id = Some(v.into_owned()),
                "client_secret" => token_req.client_secret = Some(v.into_owned()),
                "code_verifier" => token_req.code_verifier = Some(v.into_owned()),
                "refresh_token" => token_req.refresh_token = Some(v.into_owned()),
                _ => {}
            }
        }
    }

    let (basic_id, basic_secret) = parse_basic_auth(&headers);
    if token_req.client_id.is_none() {
        token_req.client_id = basic_id;
    }
    if token_req.client_secret.is_none() {
        token_req.client_secret = basic_secret;
    }

    let grant_type = token_req.grant_type.as_deref().unwrap_or_else(|| {
        if token_req.code.is_none()
            && (token_req.client_id.is_some() || token_req.client_secret.is_some())
        {
            "client_credentials"
        } else {
            "authorization_code"
        }
    });

    if grant_type == "client_credentials" {
        let access_token = format!("sn_tok_{}", Uuid::new_v4().simple());
        {
            let store = oauth_store();
            let mut state = store.lock().unwrap();
            state.access_tokens.insert(
                access_token.clone(),
                Instant::now() + Duration::from_secs(31536000),
            );
        }
        let body = serde_json::json!({
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 31536000,
            "scope": "mcp"
        });
        return cors_json_response(body, &headers, StatusCode::OK);
    }

    if grant_type == "refresh_token" {
        let new_access_token = format!("sn_tok_{}", Uuid::new_v4().simple());
        let new_refresh_token = format!("sn_rfr_{}", Uuid::new_v4().simple());
        {
            let store = oauth_store();
            let mut state = store.lock().unwrap();
            state.access_tokens.insert(
                new_access_token.clone(),
                Instant::now() + Duration::from_secs(31536000),
            );
        }
        let body = serde_json::json!({
            "access_token": new_access_token,
            "token_type": "Bearer",
            "expires_in": 31536000,
            "refresh_token": new_refresh_token,
            "scope": "mcp"
        });
        return cors_json_response(body, &headers, StatusCode::OK);
    }

    // Default: authorization_code
    let code = match token_req.code {
        Some(c) if !c.is_empty() => c,
        _ => {
            // Fallback: if client credentials were sent, issue token
            if token_req.client_id.is_some() || token_req.client_secret.is_some() {
                let access_token = format!("sn_tok_{}", Uuid::new_v4().simple());
                let body = serde_json::json!({
                    "access_token": access_token,
                    "token_type": "Bearer",
                    "expires_in": 31536000,
                    "scope": "mcp"
                });
                return cors_json_response(body, &headers, StatusCode::OK);
            }
            let err = serde_json::json!({
                "error": "invalid_request",
                "error_description": "Missing code parameter"
            });
            return cors_json_response(err, &headers, StatusCode::BAD_REQUEST);
        }
    };

    // Verify pending code if exists
    let pending_opt = {
        let store = oauth_store();
        let mut state = store.lock().unwrap();
        state.pending_codes.remove(&code)
    };

    if let Some(pending) = pending_opt {
        if Instant::now() > pending.expires_at {
            let err = serde_json::json!({
                "error": "invalid_grant",
                "error_description": "Authorization code has expired"
            });
            return cors_json_response(err, &headers, StatusCode::BAD_REQUEST);
        }

        if !pending.redirect_uri.is_empty() {
            if let Some(req_uri) = &token_req.redirect_uri {
                if req_uri != &pending.redirect_uri {
                    let err = serde_json::json!({
                        "error": "invalid_grant",
                        "error_description": "redirect_uri mismatch"
                    });
                    return cors_json_response(err, &headers, StatusCode::BAD_REQUEST);
                }
            }
        }
        if !pending.client_id.is_empty() {
            if let Some(req_client_id) = &token_req.client_id {
                if req_client_id != &pending.client_id {
                    let err = serde_json::json!({
                        "error": "invalid_grant",
                        "error_description": "client_id mismatch"
                    });
                    return cors_json_response(err, &headers, StatusCode::BAD_REQUEST);
                }
            }
        }

        // Verify PKCE if challenge was provided
        if let Some(challenge) = &pending.code_challenge {
            let verifier = token_req.code_verifier.as_deref().unwrap_or("");
            if !verify_pkce(
                verifier,
                challenge,
                pending.code_challenge_method.as_deref(),
            ) {
                let err = serde_json::json!({
                    "error": "invalid_grant",
                    "error_description": "PKCE code_verifier verification failed"
                });
                return cors_json_response(err, &headers, StatusCode::BAD_REQUEST);
            }
        }
    }

    let access_token = format!("sn_tok_{}", Uuid::new_v4().simple());
    let refresh_token = format!("sn_rfr_{}", Uuid::new_v4().simple());

    {
        let store = oauth_store();
        let mut state = store.lock().unwrap();
        state.access_tokens.insert(
            access_token.clone(),
            Instant::now() + Duration::from_secs(2592000),
        );
    }

    let body = serde_json::json!({
        "access_token": access_token,
        "token_type": "Bearer",
        "expires_in": 2592000,
        "refresh_token": refresh_token,
        "scope": "mcp"
    });

    cors_json_response(body, &headers, StatusCode::OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_oauth_flow_end_to_end() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router()).await.unwrap();
        });

        let client = reqwest::Client::new();
        let base_url = format!("http://{addr}");

        // 1. Discovery
        let res = client
            .get(format!("{base_url}/.well-known/oauth-authorization-server"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let metadata: serde_json::Value = res.json().await.unwrap();
        assert!(
            metadata["authorization_endpoint"]
                .as_str()
                .unwrap()
                .contains("/oauth/authorize")
        );
        assert!(
            metadata["token_endpoint"]
                .as_str()
                .unwrap()
                .contains("/oauth/token")
        );
        assert!(
            metadata["registration_endpoint"]
                .as_str()
                .unwrap()
                .contains("/oauth/register")
        );

        // 2. Protected resource discovery
        let res = client
            .get(format!("{base_url}/.well-known/oauth-protected-resource"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let res_metadata: serde_json::Value = res.json().await.unwrap();
        assert!(res_metadata["resource"].as_str().unwrap().contains("/mcp"));

        // 3. Dynamic client registration
        let reg_payload = serde_json::json!({
            "client_name": "Google Gemini",
            "redirect_uris": ["https://oauth-redirect.googleusercontent.com/r/test"]
        });
        let res = client
            .post(format!("{base_url}/oauth/register"))
            .json(&reg_payload)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        let reg_res: serde_json::Value = res.json().await.unwrap();
        let client_id = reg_res["client_id"].as_str().unwrap().to_string();

        // 4. Authorize with PKCE S256
        let code_verifier = "test_code_verifier_12345678901234567890";
        let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));

        // Use custom client that does not follow redirects
        let no_redirect_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();

        let auth_url = format!(
            "{base_url}/oauth/authorize?response_type=code&client_id={client_id}&redirect_uri=https://oauth-redirect.googleusercontent.com/r/test&state=gemini_state_123&code_challenge={code_challenge}&code_challenge_method=S256"
        );
        let res = no_redirect_client.get(&auth_url).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::FOUND);
        let location = res.headers().get("location").unwrap().to_str().unwrap();
        assert!(location.contains("state=gemini_state_123"));

        let parsed_location = url::Url::parse(location).unwrap();
        let code = parsed_location
            .query_pairs()
            .find(|(k, _)| k == "code")
            .unwrap()
            .1
            .to_string();

        // 5. Token exchange with PKCE
        let token_params = format!(
            "grant_type=authorization_code&code={code}&redirect_uri=https://oauth-redirect.googleusercontent.com/r/test&client_id={client_id}&code_verifier={code_verifier}"
        );
        let res = client
            .post(format!("{base_url}/oauth/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(token_params)
            .send()
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
        let token_res: serde_json::Value = res.json().await.unwrap();
        assert!(
            token_res["access_token"]
                .as_str()
                .unwrap()
                .starts_with("sn_tok_")
        );
        assert_eq!(token_res["token_type"], "Bearer");

        // 6. Client credentials flow
        let cc_params =
            "grant_type=client_credentials&client_id=sourcenerve&client_secret=sourcenerve_secret";
        let res = client
            .post(format!("{base_url}/oauth/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(cc_params)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let cc_res: serde_json::Value = res.json().await.unwrap();
        assert!(
            cc_res["access_token"]
                .as_str()
                .unwrap()
                .starts_with("sn_tok_")
        );
        assert_eq!(cc_res["token_type"], "Bearer");
    }
}

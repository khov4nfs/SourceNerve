# SourceNerve Google OAuth / Apps Script / AppSheet — thiết kế ủy quyền

**Trạng thái:** Design + policy contract; **chưa** phải OAuth connection đang hoạt động. SourceNerve Desktop hiện có `McpExtensionOAuthManager` với PKCE/loopback và encrypted secret store. Đã bổ sung `access_type=offline` cho URL Google OAuth chính thức để chuẩn bị refresh token, có unit test chống áp dụng cho provider khác. `include_granted_scopes` không được dùng vì OAuth Desktop không hỗ trợ incremental consent. Tuy vậy cơ chế hiện tại materialize **Bearer token vào HTTP MCP transport**; `@google/clasp mcp` là STDIO và yêu cầu credentials riêng trong HOME. Không được mô tả `OAuth connected` cho clasp chỉ vì đã lấy được token.

## Tách ba loại quyền

| Mục đích | Cơ chế | Điều kiện |
| --- | --- | --- |
| **Apps Script REST API** | Google OAuth 2.0 Authorization Code + PKCE S256 từ SourceNerve Desktop | Google Cloud OAuth client loại Desktop, Apps Script API được bật, OAuth consent, Apps Script dashboard cho phép API access |
| **AppSheet Editor** (Views, Actions, Bots, Expressions) | Người dùng đăng nhập Google vào phiên browser riêng, SourceNerve thao tác giao diện qua Chrome DevTools | Tài khoản đăng nhập có quyền editor trên đúng app, Browser Use được bật |
| **AppSheet REST API** (Find/Add/Edit/Delete/Invoke Action) | `ApplicationAccessKey` theo từng App ID trong OS secure storage | AppSheet Enterprise hỗ trợ API, app đã bật API, key còn hiệu lực |

Không dùng Google OAuth access token thay `ApplicationAccessKey` cho AppSheet REST; không dùng AppSheet key như credential cho Editor hoặc Google Apps Script. Google OAuth không tự cho quyền điều khiển mọi AppSheet Editor.

## Kiến trúc được đề xuất

```text
ChatGPT Chat (tiếng Việt)
  -> SourceNerve MCP (identity + tool policy + approval + audit)
      -> SourceNerve Desktop Main: GoogleWorkspaceConnectionManager
          -> OAuth browser consent + PKCE S256 + localhost callback
          -> OS EncryptedSecretStore [per installation / account / scope set]
          -> Refresh / revoke; Google API bearer injected only into HTTPS request
      -> Apps Script REST adapter
          -> script.projects read/create/update, versions, deployments (per scope)
      -> Authorized Git workspace
          -> optional env_file (.env) for sandboxed project process
          -> lint/test/review/PR
      -> AppSheet Editor (Chrome DevTools browser session)
          -> view/action/bot/expression before+after verification
      -> AppSheet REST adapter (optional, Enterprise)
          -> app ID allowlist + per-app ApplicationAccessKey
```

**Clasp MCP:** giữ như extension tùy chọn để phát triển local. Clasp mặc định đọc `.clasprc.json` trong HOME. Sandbox của SourceNerve tách HOME, vì vậy không đọc được host login. Không copy `~/.clasprc.json` host, không cho phép bật `--danger-full-access` chỉ để chạy clasp. Hướng production nên ưu tiên **Apps Script REST adapter của SourceNerve** sử dụng access token ở tầng Desktop broker thay vì materialize refresh token xuống STDIO. Nếu chọn hỗ trợ `clasp mcp` trực tiếp, cần thêm credential broker riêng cho sandbox; token refresh không được lộ trong tool arguments, logs, environment hay repository; mất quyền hoặc token hết hạn phải fail closed. Thiết kế credential broker là một giai đoạn triển khai tiếp theo, **chưa có**.

## Luồng OAuth (Google APIs)

1. Người dùng vào **SourceNerve → Settings → Google Workspace → Connect Google** (UI đề xuất, chưa xây dựng) và chọn tài khoản Google. Không mặc định tái sử dụng danh tính GitHub hay Google Drive connector.
2. Desktop Main nhận Google Cloud **Desktop OAuth Client ID** qua cấu hình/secure install; xác minh ID thuộc ứng dụng SourceNerve đã cấu hình; không đưa client secret vào frontend hoặc repo. External OAuth app cần cấu hình consent screen, test users/verification theo yêu cầu Google.
3. Desktop tạo state (ít nhất 256-bit), PKCE verifier và SHA256 challenge S256. Bind listener tạm thời ở `127.0.0.1` cổng ngẫu nhiên; không dùng callback công khai trên Cloudflare MCP tunnel. Gọi URL Google `accounts.google.com/o/oauth2/v2/auth` có `response_type=code`, `state`, `code_challenge`, `code_challenge_method=S256`, `access_type=offline` và scope yêu cầu theo chế độ đã chọn. Google Desktop không hỗ trợ incremental authorization: khi đổi từ read sang edit/deploy phải yêu cầu consent lại, không tự nâng scope trong nền.
4. Mở trình duyệt hệ thống; người dùng trực tiếp duyệt scope. Listener xác thực loopback peer, đường callback, state, một lần sử dụng, thời gian hết hạn; đổi code tại `oauth2.googleapis.com/token` với `code_verifier`, không log URL có mã hoặc token.
5. Lưu refresh token và thông tin account **chỉ** trong OS encrypted secret store. Access token ngắn hạn được giữ trong bộ nhớ hoặc secure store, gắn với connection/account/scope; không chia sẻ vào ChatGPT tool result, `.env`, Git, shell, renderer hoặc browser JavaScript.
6. Kiểm tra `granted_scopes` thực tế, account identity và Apps Script API readiness trước khi hiện `Apps Script connected`. Nếu thiếu scope, cần incremental consent; không tự nâng quyền.
7. Refresh token theo expiry và skew; xử lý token rotation, 401/invalid_grant -> `reauth_required`; revoke Google token qua `oauth2.googleapis.com/revoke`, xóa local tokens và chặn hành động khi người dùng Disconnect.
8. Khi gửi API request, Desktop tạo HTTP Authorization header cho Google Apps Script REST **chỉ** sau khi SourceNerve kiểm tra tool approval, script ID và scope; không cấp bearer token trần cho extension bất kỳ.

### Các cấp quyền OAuth

Được khai báo ở `integrations/google-workspace/google-oauth.policy.json`, các chế độ quyền được chọn rõ trước khi kết nối; đổi chế độ sẽ vô hiệu hóa token cũ và yêu cầu consent lại:

- Nhận diện: `openid`, `userinfo.email` nếu cần xác nhận đúng tài khoản.
- Đọc script: `script.projects.readonly`, `script.deployments.readonly`.
- Sửa project: `script.projects` — cần thao tác edit cụ thể có approval / diff.
- Deploy: `script.deployments` — quyền độc lập, cần user xác nhận deployment/version đích.
- Nếu tác vụ cần Drive metadata hoặc API executable: xin scope riêng theo yêu cầu thực tế; không tự thêm `drive`, `gmail`, `cloud-platform`.

Việc cấp OAuth scope **không thay thế** SourceNerve approval tại tool dispatch. Đối với `projects.updateContent`, cần kiểm tra remote project/revision và danh sách file, do API có thể thay toàn bộ source. Đối với deploy, cần giữ version và deployment IDs được API xác nhận.

## AppSheet

**Editor:** chỉ dùng phiên browser đăng nhập thực tế. Chrome DevTools không được lách Google OAuth, mượn cookie từ API connector, hoặc tự tạo session. Tiến trình có thể tái kết nối nhưng đăng nhập có thể hết hạn; trả về trạng thái `editor_signin_required`.

**AppSheet REST:** API key thuộc **một App ID** và được nhập vào SourceNerve Desktop UI (secure store), không được viết vào `.env`/GitHub/ChatGPT. Kết nối phải kiểm tra plan Enterprise, app API enabled, key còn hiệu lực và bảng/action được cho phép. Header `ApplicationAccessKey` chỉ gửi qua TLS đến endpoint AppSheet chính thức; không đưa key vào URL/query. Đây là API dữ liệu và invoke action, không có API tổng quát để sửa Views/Bots/Expressions trong Editor.

**Team administration:** API quản trị nhóm sử dụng key/UserId và quyền team admin riêng; không mặc định được bật theo AppSheet app key.

## State machine và UI đề xuất

`disconnected` → `consent_pending` → `oauth_connected` → `apps_script_api_verified`.

Trạng thái lỗi: `reauth_required`, `scope_missing`, `api_disabled`, `script_access_denied`.

AppSheet có **hai kết nối độc lập**:
- `appsheet_editor: signed_out | signed_in | insufficient_permissions`
- `appsheet_api: unconfigured | app_key_verified | enterprise_required | key_revoked`

UI không hiển thị `Google connected = AppSheet connected`. Mỗi tài khoản Google và AppSheet App ID có bản ghi riêng; mọi log/telemetry/audit đều chỉ chứa trạng thái, scope IDs và key fingerprint đã băm nếu cần, **không** chứa token, .env value, callback code hay cookies.

## Bộ kiểm thử bắt buộc trước rollout

1. OAuth PKCE: state mismatch, expired/duplicate callback, invalid redirect/cert, denied consent, missing scopes, token rotation, revoke, offline refresh.
2. Identity: hai Google account cùng máy không dùng nhầm token; workspace của tài khoản A không được gọi với account B.
3. Script: read-only OAuth không push/deploy được; mỗi thao tác write phải có SourceNerve approval; project ID sai fail closed.
4. Browser: hết session AppSheet Editor phải báo đăng nhập; không tự dùng Google OAuth token thay cookie Editor.
5. AppSheet: không có key/không phải Enterprise thì disable REST action; API key chỉ được gửi header, không có trong output/log.
6. Secret handling: dump logs, sandbox env, script output, Git diff không chứa Google refresh token, AppSheet key hoặc OAuth code.
7. End-to-end: user consent, chọn Script ID, đọc code, lint/test, review, push, version/deploy, smoke test và revoke thành công.

## Phần đã có trong Desktop (PR #244, chưa phát hành)

- `desktop/src/main/google-workspace-manager.ts`: first-party Google Desktop OAuth (PKCE qua `McpExtensionOAuthManager`), hỗ trợ client secret tùy chọn được lưu riêng trong OS secure store khi cấu hình Google yêu cầu; access token được lấy nội bộ từ OS secure store; **không** materialize xuống clasp STDIO hoặc gửi token đến renderer.
- `desktop/src/main/google-workspace-ipc.ts`, `desktop/src/shared/google-workspace-api.ts`, `desktop/src/preload.ts`: cầu Electron IPC kiểm tra trusted renderer và schema; không có đường IPC trả về token.
- `desktop/src/renderer/components/GoogleWorkspacePanel.tsx`: giao diện tiếng Việt nhập Google OAuth Desktop Client ID, chọn quyền read/edit/deploy, duyệt consent, xem nguồn Apps Script và lưu AppSheet API key theo App ID / region.
- `desktop/src/main/google-workspace-mcp-server.ts`: MCP server loopback với Bearer ngẫu nhiên trong bộ nhớ. SourceNerve đăng ký thành `sourcenerve-google-workspace` / namespace `google-workspace`. `apps_script_get_project`, `google_workspace_status`, `appsheet_key_status` là công cụ đọc; `apps_script_get_content` và `appsheet_find_rows` dùng Ask vì có thể trả dữ liệu nhạy cảm; `apps_script_update_content`, `apps_script_create_version`, `apps_script_create_deployment` dùng Ask, yêu cầu xác nhận bổ sung tại request. Việc cấp Google OAuth **không cấp quyền ghi tự động**.
- `src/mcp_gateway.rs` hiển thị `capabilities.apps_script` và `capabilities.appsheet_api` cho ChatGPT theo tool thực sự đã đăng ký.
- Apps Script API adapter đọc project/content và có optimistic full-file SHA256 check ngay trước khi overwrite. API không hỗ trợ conditional atomic update cho toàn bộ file, vì vậy vẫn có khả năng race bên ngoài giữa GET và PUT; ứng dụng phải đọc lại và review trước write. AppSheet REST adapter mới có `Find` (không sửa dữ liệu).

**Lưu ý:** Đã implement code nhưng chưa có credential Google thật và AppSheet Enterprise app để test E2E. `googleStatus.connected` chỉ là token còn hiệu lực theo metadata, **chưa** xác minh account identity/scopes thực tế bằng Google API. Các lời gọi dự án thực tế sẽ báo 401/403 nếu tài khoản thiếu scope hoặc Apps Script API chưa bật.

## Phần chưa triển khai

- Google Workspace OAuth connection UI và provider REST adapter cho Apps Script trong SourceNerve Desktop. [ĐÃ CODE, CHƯA TEST E2E]
- Cầu credential an toàn để `@google/clasp mcp` nhận authorization trong HOME biệt lập.
- AppSheet API-key secure UI và adapter riêng theo App ID.
- Kiểm thử thật với Google OAuth client và AppSheet app có quyền Editor/Enterprise.

Mọi mục trên cần Google Cloud OAuth Client ID được cấu hình hợp lệ, account đích được người dùng chọn và quyền tại ứng dụng thật; không thể xác thực thay người dùng chỉ bằng PR này.

## Nguồn chính thức

- https://developers.google.com/identity/protocols/oauth2/native-app
- https://developers.google.com/identity/protocols/oauth2/resources/best-practices
- https://developers.google.com/apps-script/api/how-tos/enable
- https://developers.google.com/identity/protocols/oauth2/scopes
- https://support.google.com/appsheet/answer/10105769
- https://support.google.com/appsheet/answer/11628886
- https://github.com/google/clasp

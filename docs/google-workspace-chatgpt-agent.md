# ChatGPT Chat → SourceNerve MCP → Google Apps Script / AppSheet

Tài liệu triển khai bước tiếp theo sau PR #241 (Browser / Computer Use). Mục tiêu là **ChatGPT Chat tiếng Việt** điều phối SourceNerve MCP, phát triển Apps Script có Git review/test/deploy, và chỉnh AppSheet Editor có kiểm chứng trước/sau.

## Phạm vi hiện tại

| Bề mặt | Công cụ | Khả năng | Lưu ý |
| --- | --- | --- | --- |
| Apps Script project | `@google/clasp@3.4.1 mcp` hoặc Apps Script API | Liệt kê, tạo, clone, pull, push (MCP phiên bản thử nghiệm); API hỗ trợ getContent/updateContent, versions, deployments | Cần OAuth được cấp hợp lệ trong sandbox MCP |
| GitHub | SourceNerve Git workspace hoặc GitHub connector | Đọc, sửa, test, PR, kiểm tra CI | Không tự commit/merge/deploy nếu chưa được yêu cầu |
| AppSheet Editor | Chrome DevTools Browser Use | Kiểm tra/sửa Views, Actions, Bots, Expressions qua UI đã đăng nhập | AppSheet data API không thay thế cấu hình Editor |
| Computer Use | SourceNerve Desktop Control | Ảnh màn hình và foreground fallback | Chỉ khi người dùng cho phép foreground interaction |
| AppSheet REST API | REST API theo App ID | Bảng dữ liệu Add/Edit/Delete/Find, invoke Actions | Không cung cấp cách sửa toàn bộ cấu hình Editor qua API |

## Sửa comment Apps Script bằng bản vá tối thiểu

Nếu chỉ thêm một comment đơn dòng, dùng `google-workspace__apps_script_comment_preview` (đọc nội bộ Desktop, chỉ trả tên file và SHA-256) trước; sau khi người dùng xác nhận, dùng `google-workspace__apps_script_comment_apply` với `confirmed:true` và `expectedFingerprint`, **không** đưa toàn bộ source code 64 KB+ vào ChatGPT. Preview không cần Ask trên cấu hình mặc định; apply yêu cầu Ask một lần. Nếu host hoặc policy vẫn chặn, dừng, không dùng cách khác để lách chặn; người dùng thao tác trực tiếp tại SourceNerve Desktop → Google Workspace → Thêm một dòng comment. Xem `docs/google-workspace-comment-patch.md`.

## Liệt kê Apps Script projects (Drive metadata-only)

Trong SourceNerve Desktop chọn **Google Workspace → Cấp quyền Drive metadata và ủy quyền lại**.
OAuth sẽ yêu cầu thêm scope `drive.metadata.readonly` (restricted scope, có thể cần Google verification) và giữ lại các quyền Apps Script đã chọn. Việc nâng scope là opt-in, xóa token cũ rồi yêu cầu consent mới; không đòi nhập lại Google Desktop OAuth Client ID.

Sau khi consent, ChatGPT dùng `google-workspace__apps_script_list_projects` (MCP read) với `pageSize` 1..100 và `pageToken` tùy chọn. Kết quả có `projects: [{name, scriptId, modifiedTime, editorUrl}]`, `nextPageToken`, `incompleteSearch`. Công cụ này chỉ liệt kê **standalone scripts** trong Google Drive, không liệt kê script gắn Sheets/Docs/Forms/Slides. Xem `docs/google-workspace-script-discovery.md` để biết quy tắc quyền và phân trang.

**Bound scripts:** `google-workspace__apps_script_list_containers` chỉ tìm Sheet/Doc ứng viên theo tên (Drive metadata-only). Chọn container, mở **Extensions → Apps Script → Project Settings** để sao chép Script ID rồi dùng `google-workspace__apps_script_check_bound` so khớp `parentId` qua Apps Script API. Nếu Google không trả `parentId`, hiển thị `unconfirmed` và không đoán Script ID. Hai công cụ này là read-only; `apps_script_patch_preview` / `apps_script_comment_preview` và Chrome DevTools `take_snapshot` / `take_screenshot` cũng được định tuyến read khi phân loại đúng, nhưng không bỏ qua chính sách Ask đã cấu hình.

## Luồng đề xuất sau PR #244: first-party OAuth + SourceNerve MCP

Bản Desktop có Google Workspace panel (Plugins + MCP → Google Workspace):

1. Nhập **Google Cloud Desktop OAuth Client ID** của app do người dùng kiểm soát, chọn scope mode `read` / `edit` / `deploy` (mặc định `read`). Khi đổi mode phải consent lại theo quy tắc OAuth Desktop của Google. Có thể nhập client secret tùy chọn vào secure store nếu Google OAuth Client cần khi token exchange.
2. Chọn `Đăng nhập Google`: Desktop mở trình duyệt hệ thống, PKCE + 127.0.0.1 loopback; OS secure store giữ token. SourceNerve không đẩy token xuống clasp STDIO.
3. Khi `sourcenerve-google-workspace` đã được SourceNerve MCP gateway đăng ký, `mcp_extension_catalog` cung cấp namespace `google-workspace` và `capabilities.apps_script` / `capabilities.appsheet_api`. Các tool có thể sử dụng:
   - `google_workspace_status` và `apps_script_get_project`: read-only.
   - `apps_script_get_content`: Ask vì nội dung source có thể nhạy cảm.
   - `apps_script_update_content`: Ask + full-file replacement + expected SHA256 fingerprint + `confirmed=true`.
   - `apps_script_create_version`, `apps_script_create_deployment`: Ask + quyền thích hợp + xác nhận + version đích.
   - `appsheet_key_status`, `appsheet_find_rows`: key được lưu tại Desktop; `Find` dùng Ask vì trả dữ liệu bảng.
4. AppSheet REST key được nhập riêng cho App ID và vùng dữ liệu Global/EU/Asia Pacific; AppSheet Editor vẫn cần một phiên Browser Use đã đăng nhập, không thể thay bằng key.
5. Không khởi chạy deploy tự động sau khi đọc dự án. SourceNerve vẫn thực hiện approval trước từng tool write; thao tác Google có timeout không được replay khi không biết kết quả.

**Chưa xác thực trên dữ liệu thật và chưa deploy:** Cần OAuth client hợp lệ, consent, Apps Script API enabled, đúng Script ID và (đối với AppSheet REST) ứng dụng Enterprise cùng key có hiệu lực.

### clasp MCP (tùy chọn, riêng biệt)

## 1. Chuẩn bị clasp MCP

SourceNerve có registry và gateway cho extension STDIO. Mẫu cấu hình:
[`integrations/google-workspace/clasp-mcp.extension.json`](../../integrations/google-workspace/clasp-mcp.extension.json).

```json
{
  "id": "google-clasp-mcp",
  "name": "Google Apps Script (clasp MCP)",
  "version": "3.4.1",
  "namespace": "clasp",
  "source": "https://github.com/google/clasp",
  "transport": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@google/clasp@3.4.1", "mcp"]
  },
  "auth_type": "none",
  "required": false,
  "update_channel": "stable"
}
```

Mở SourceNerve Desktop → **Plugins + MCP** → đăng ký extension STDIO theo các trường trên, sau đó enable/discover công cụ và cấu hình chính sách riêng cho từng tool. Không tự động bật mọi write tool. Mẫu chỉ là registration, **không** mang OAuth token.

Theo upstream clasp v3.4.1, MCP có các công cụ `list_projects`, `clone_project`, `create_project`, `pull_files`, `push_files`. Upstream công bố chúng với `readOnlyHint=false`; SourceNerve phải xử lý theo chính sách write hiện tại, không tự quảng cáo `list_projects` là read-only khi downstream chưa xác nhận.

### OAuth / cách ly file

1. Người dùng kích hoạt Apps Script API tại https://script.google.com/home/usersettings.
2. Đăng nhập `clasp login` bằng tài khoản sở hữu script, trong bối cảnh OAuth do người dùng cho phép.
3. **Quan trọng:** SourceNerve STDIO sandbox dùng `HOME` riêng cho extension. Login bằng `clasp login` trên host **không tự động đăng nhập** cho `clasp mcp` trong SourceNerve. Chưa có cơ chế import OAuth credential có kiểm soát ở SourceNerve: không thể coi connector này là production-ready trước khi có đường cấp credential an toàn và kiểm thử end-to-end.
4. Không gửi `.clasprc.json`, `refresh_token`, OAuth client secret hay cookie qua ChatGPT, file GitHub hoặc issue/PR. Không tắt sandbox hay mount toàn bộ HOME. Nếu chưa cấu hình được OAuth trong sandbox, báo trạng thái **BLOCKED: clasp OAuth**.

Phiên bản `@google/clasp@3.4.1` được pin để tránh thay đổi ngầm. Trước khi nâng version, review release notes, security advisories và smoke test MCP tool schema.

## 1b. Run project dùng .env trong sandbox

Khi người dùng yêu cầu chạy project, `workspace_exec` và `workspace_process_start` có trường `env_file` **tùy chọn**. Ví dụ MCP arguments cho `workspace_process_start`:

```json
{
  "workspace": "authorized-project-workspace",
  "program": "npm",
  "args": ["run", "dev"],
  "cwd": "web-app",
  "env_file": ".env"
}
```

- Chỉ cho phép tên file `.env` hoặc `.env.<name>` ở cwd đã chọn; giới hạn 64 KiB / 128 biến / 8 KiB mỗi giá trị. Không đọc file symlink; không nhận đường dẫn tuyệt đối hoặc `..`.
- Nạp sau khi thiết lập sanitized command environment để chỉ child nhận biến trong project. Các key có thể phá ranh giới sandbox, ví dụ `PATH`, `HOME`, `SOURCENERVE_*`, `LD_*`, `GIT_*`, `NODE_OPTIONS`, bị chặn.
- `env_file` mặc định là null để test/build thông thường không tự nhận bí mật. File thực tế cần tồn tại trong workspace/cwd, không phải `.env` của daemon SourceNerve. Không log giá trị, không tự push hay đọc key vào chat; ứng dụng được chạy **có thể tự in bí mật** nếu code của chính nó làm vậy nên phải review commands/logs.
- Đường chạy qua native Harness command API cũng hỗ trợ `env_file`; các phiên chưa cập nhật SourceNerve sẽ chưa hỗ trợ tham số này.

## 2. Apps Script: read → edit → test → push → deploy

- **Discover:** dùng `mcp_extension_catalog` → `capabilities.apps_script` (chỉ liệt kê các tool clasp đã được đăng ký và bật; `requires_external_oauth=true`). Xác nhận namespaced tool `clasp__list_projects` đã có, schema thực tế và trạng thái per-tool policy.
- **Read:** nếu xác thực, liệt kê project rồi xác định `scriptId` và `projectDir`. `clone_project` và `pull_files` ghi file local: chọn thư mục sạch/được cấp phép, so sánh trước khi ghi.
- **Edit:** giữ code trong Git workspace, kiểm thử lint/unit trước. Không commit credential; giữ manifest `appsscript.json` đúng scope tối thiểu.
- **Review:** diff cụ thể, GitHub feature branch và PR. Dừng nếu remote HEAD đổi hoặc local source khác với bản đã review.
- **Push:** chỉ sau khi xác nhận Script ID và review đủ files. Apps Script API `projects.updateContent` *thay thế toàn bộ project content*, nên phải round-trip và bảo toàn manifest/file không sửa.
- **Deploy:** tạo immutable version, sau đó deployment/version update theo đúng target. Push code HEAD khác với publish deployment. Chạy lại read-back deployment ID và smoke test.
- **Rollback:** sử dụng version/deployment đã biết; không force push/xóa deployment không kiểm chứng.

Official Docs:
- https://developers.google.com/apps-script/guides/clasp
- https://developers.google.com/apps-script/api/reference/rest
- https://github.com/google/clasp/tree/v3.4.1

## 3. AppSheet Editor: Views, Actions, Bots, Expressions

Trình tự dùng Chrome DevTools MCP:

1. `list_pages`. Nếu browser chưa ở AppSheet Editor, mở app do người dùng cung cấp hoặc danh sách app chính thức.
2. Kiểm tra login. Nếu trang `Account/Login`, dừng và yêu cầu người dùng đăng nhập trực tiếp trên browser họ kiểm soát. Không dùng cookies/session từ Drive connector.
3. `take_snapshot` để xác nhận app thật, loại editor, tên View, Action, Bot hoặc Expression.
4. Ghi trạng thái trước và tạo thay đổi nhỏ, từng đối tượng một. Tất cả hành động thao tác editor phải đi qua SourceNerve gateway; ưu tiên locator từ a11y snapshot mới nhất.
5. Kiểm tra validation/Expression Assistant, trạng thái lưu (bao gồm auto-save nếu có), Preview, rồi đọc lại đối tượng và ghi before/after.
6. Với Bots có side effect (send email, webhook, update nhiều rows), cần môi trường thử nghiệm hoặc xác nhận rõ trước khi kích hoạt.

Nếu Chrome DevTools không thể chọn đúng phần tử, sử dụng Desktop Control để quan sát và chỉ thực hiện **foreground** click/typing khi user đã đồng ý cho hành động cụ thể đó.

AppSheet API chính thức chỉ mô tả inbound data/Action và outbound webhooks:
https://support.google.com/appsheet/answer/11628886

## 4. Ma trận hoàn thành

| Kiểm tra | Kết quả hiện tại | Điều kiện PASS |
| --- | --- | --- |
| SourceNerve MCP | Đã thấy Browser/Computer Use qua catalog | Chrome `list_pages`, Desktop state trả về thành công |
| clasp MCP template | Có mẫu pin v3.4.1 trên GitHub | Lắp đặt rồi khám phá được 5 upstream tools |
| Apps Script OAuth | Chưa xác thực từ sandbox | `list_projects` chạy dưới account đúng |
| Apps Script edit/test | Chưa có project được chọn | Có script ID, diff, test evidence |
| Apps Script deploy | Chưa phát hành | Có deployment ID, version và smoke proof |
| AppSheet Editor | Browser mới chỉ tới trang đăng nhập | Người dùng login; xác định đúng app ID |
| Views/Actions/Bots/Expressions | Chưa có app target | Có before/after và validation trong Editor |

## 5. Lệnh kiểm chứng repository

```bash
node scripts/verify-google-workspace-bridge.mjs
```

Kiểm tra cấu hình extension, bản clasp đã pin, tên skill, thông tin security boundary và việc nối plugin package; không cần OAuth và không gọi Google API. **PASS kiểm tra repository không có nghĩa là đã kết nối/deploy Google Workspace.**

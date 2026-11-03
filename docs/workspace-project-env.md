# Run project với .env trong SourceNerve sandbox

**Có trong PR #244; chỉ khả dụng sau khi merge và cập nhật SourceNerve runtime.**

## Vì sao trước đây thiếu biến môi trường?

`src/sandbox.rs` sử dụng `command.env_clear()` để tránh truyền token riêng của SourceNerve/daemon vào tiến trình dự án. File `.env` trong repository có thể vẫn tồn tại, nhưng shell/Node/process được khởi chạy không tự đọc hoặc export file này. Việc chạy `npm run dev` không đảm bảo bản thân ứng dụng đã gọi dotenv.

Thay đổi mới giữ nguyên sanitized environment và cho phép **opt-in** đọc `.env` từ đúng thư mục `cwd` của workspace ngay trước khi spawn subprocess. Biến môi trường không được gán cho process SourceNerve cha.

## Qua ChatGPT Chat → SourceNerve MCP

### Project server chạy lâu

```json
{
  "workspace": "workspace-id-authorized",
  "program": "npm",
  "args": ["run", "dev"],
  "cwd": "packages/web",
  "env_file": ".env",
  "request_id": "launch-web-project-001"
}
```

Dùng công cụ `workspace_process_start`, sau đó dùng `workspace_process_logs` / `workspace_process_stop` với `session_id` trả về. `workspace_process_start` vẫn chịu chính sách Sandbox/Harness của SourceNerve, không tự bypass approval.

### Lệnh build/test ngắn

```json
{
  "workspace": "workspace-id-authorized",
  "program": "npm",
  "args": ["run", "test"],
  "cwd": "packages/web",
  "env_file": ".env.test",
  "timeout_ms": 120000,
  "request_id": "test-web-project-001"
}
```

Dùng `workspace_exec` hoặc qua HTTP Harness command nếu đã được cấp quyền. Khi `env_file` không có hoặc null, mọi biến project chỉ có trong file, **không** được inject vào child.

## Chính sách an toàn

- Chỉ tên `.env` hoặc `.env.<suffix>` trong `cwd`; không chấp nhận đường dẫn tuyệt đối, `..`, hoặc symlink, kể cả file trỏ vào ngoài workspace.
- File tối đa 64 KiB; 128 key; value không quá 8 KiB; strict `KEY=VALUE` parser (có hỗ trợ quote và chú thích, không chạy shell expansion hay `source`).
- Các biến có thể can thiệp SourceNerve/sandbox bị chặn: `SOURCENERVE_*`, `HOME`, `PATH`, `LD_*`, `DYLD_*`, `GIT_*`, `NODE_OPTIONS`, `BASH_ENV`, và các khóa điều khiển tiến trình khác.
- File được mở qua workspace canonicalized, không ghi file mới và không sync bí mật vào GitHub, OAuth, stdout hay logs.
- Chỉ biến đã được người dùng cho phép trong file project mới được chuyển đến **một process con**. Không lưu giá trị sang run khác hoặc vào database.
- Ứng dụng được chạy hoàn toàn có thể chủ động in secret qua stdout/stderr; chỉ chạy code tin cậy, không yêu cầu tool `cat .env` hoặc `printenv` trong ChatGPT Chat.
- Nếu dự án yêu cầu nhiều file dotenv cần hợp nhất theo thứ tự, bản đầu hiện hỗ trợ **một file cụ thể mỗi lần gọi**. Không giả định kế thừa quy tắc `.env.local` của framework.
- OAuth Google Apps Script và AppSheet App Access Key phải được quản lý bằng OS encrypted secure storage / authenticated broker, **không** truyền bằng biến `.env` của project.

## Kiểm thử

`cargo test workspace_env --all-features`: parser, từ chối protected keys, symlink, file lớn, traversal, opt-in.

`cargo test workspace_exec_loads_project_env_only_for_explicitly_selected_command --all-features`: xác nhận lệnh chạy trong sandbox chỉ nhận `PROJECT_GREETING` khi truyền `env_file`.

`cargo test workspace_process_start_uses_explicit_project_env_file --all-features`: xác nhận tiến trình chạy lâu nhận biến, không vô tình ghi secret fixture vào log.

CI đầy đủ: `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all-features`.

Không làm `env_file` trở thành mặc định cho shell/workspace ngoài yêu cầu và không sao chép file vào HOME biệt lập của MCP extension.

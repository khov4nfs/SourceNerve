---
name: google-workspace-apps-script-appsheet
description: Use ChatGPT Chat through SourceNerve MCP to inspect, edit, test, and deploy a user's Google Apps Script project through clasp, and to inspect and edit AppSheet Editor Views, Actions, Bots and Expressions through Chrome DevTools. Requires an authorized project/editor session; never infer a project or bypass approval.
---

# ChatGPT Chat → SourceNerve → Apps Script / AppSheet

**Ngôn ngữ:** Giao tiếp, kế hoạch thay đổi và báo cáo kết quả bằng tiếng Việt. Giữ nguyên tên API, tool, view, action, expression và error message khi cần tính chính xác.

## 1. Chọn đúng bề mặt

- **Apps Script source:** Ưu tiên extension MCP `clasp` đã đăng ký trong SourceNerve; với repository code đã được cấu hình, có thể dùng SourceNerve workspace file/Git và `workspace_exec` để lint/test. GitHub là nơi review và lưu nguồn; Google Apps Script là nơi chạy/deploy.
- **AppSheet Editor configuration:** Chỉ dùng Chrome DevTools Browser Use với phiên đã đăng nhập để sửa Views, Actions, Bots và Expressions. Desktop Control chỉ là phương án dự phòng khi browser DOM/a11y không đủ và người dùng cho phép tương tác foreground cụ thể.
- **AppSheet REST API:** Dùng để thao tác bảng dữ liệu hoặc gọi action đã định nghĩa, **không** nhầm API dữ liệu với API sửa cấu hình Views/Bots trong Editor.
- Browser/Computer Use không bắt buộc chọn Git workspace. Thao tác đọc/sửa repository và shell vẫn phải dùng workspace được SourceNerve cho phép.
- Khi user yêu cầu `run project` và dự án có file `.env`, gọi `workspace_process_start` (server chạy lâu) hoặc `workspace_exec` (lệnh ngắn) với `cwd` của project và `env_file: ".env"`. Không tự đọc/dán bí mật vào ChatGPT, không dùng shell `source .env`; chỉ tiến trình con nhận các biến được phép. Khi không yêu cầu file, `env_file=null` và không truyền biến dự án.

## 2. Apps Script — kiểm tra kết nối và quyền

1. Gọi `mcp_extension_catalog`, kiểm tra `capabilities.apps_script.routable` và `tool_names` (nếu SourceNerve đã cập nhật), tìm `clasp__*` và kiểm tra schema/safety của từng tool thay vì đoán tên. Nếu chưa cài, dùng mẫu `integrations/google-workspace/clasp-mcp.extension.json` trong giao diện Plugins + MCP của SourceNerve. Mẫu chạy **@google/clasp@3.4.1**, không dùng `latest`.
2. Bật Google Apps Script API ở `https://script.google.com/home/usersettings` với tài khoản sở hữu script.
3. Đảm bảo clasp đã được người dùng đăng nhập bằng OAuth trong **HOME riêng của extension**. SourceNerve không chia sẻ `~/.clasprc.json` của host với MCP sandbox. Không yêu cầu người dùng dán refresh token, mật khẩu hoặc `.clasprc.json` vào hội thoại/GitHub; không vô hiệu hóa sandbox. Nếu chưa có luồng cấp OAuth vào môi trường biệt lập một cách hợp lệ, báo **BLOCKED (authentication)**; không đoán rằng `clasp login` ngoài host đã đủ.
4. Dùng `list_projects` để xem script có thể truy cập, sau đó dùng **script ID do kết quả thực hoặc người dùng cung cấp**. Đừng tự chọn một project nếu có nhiều project khả dĩ.
5. Đọc hiện trạng và ghi lại script ID, HEAD project/version, danh sách file cùng manifest. `clasp MCP` hiện là tính năng thử nghiệm và có giới hạn về tool; nếu tool chưa được công bố hoặc chưa được phân loại, không tự thay bằng shell chưa được cấp quyền.

## 3. Đọc → sửa → kiểm thử → deploy Apps Script

1. **Read:** `clone_project` hoặc `pull_files` vào projectDir hợp lệ đã được user/SourceNerve cho phép. Những tool này **ghi file local** nên cần kiểm tra thư mục đích trước khi pull, không ghi đè file chưa review.
2. **Edit:** Với code trong Git workspace, lấy SHA trước khi sửa, commit lên feature branch và mở PR theo đúng yêu cầu của người dùng. Không đụng `.clasprc.json`, token, API key hoặc file cấu hình riêng của host. Kiểm tra `.clasp.json` để biết đúng script ID; không đưa bí mật vào commit.
3. **Test:** Chạy lint/unit test offline trước, rồi test function qua `clasp run-function` / Apps Script Execution API khi dự án đã publish API Executable và có OAuth scope phù hợp. Kết quả test không được tự suy diễn.
4. **Push:** So sánh nội dung local với remote ngay trước khi push. `clasp push` và Apps Script `projects.updateContent` có thể thay thế **toàn bộ** nội dung script. Không push trên code chưa review hoặc nhầm script ID.
5. **Deploy:** Tạo version rồi deployment chỉ khi người dùng yêu cầu triển khai mục tiêu cụ thể. Phân biệt push code HEAD với phát hành deployment. Sau deploy, đọc lại version/deployment và chạy smoke test. Không dùng `--force`, xóa deployment hoặc đổi production không có phạm vi được đồng ý.
6. Trả về link GitHub PR, script ID (nếu không nhạy cảm), version/deployment ID đã được công cụ xác nhận; nói rõ từng bước code/test/push/deploy đã thực hiện hay đang bị chặn.

## 4. AppSheet Editor — Views, Actions, Bots, Expressions

1. `list_pages` trước. Nếu chưa có AppSheet Editor, mở URL editor được người dùng cung cấp hoặc điều hướng đến danh sách ứng dụng đã được xác thực; **không** đăng nhập thay người dùng hay lấy cookie.
2. Dùng `take_snapshot` để xác nhận app, owner, tên bảng và cấu hình hiện tại. Nếu chỉ thấy trang đăng nhập, dừng tại **BLOCKED (AppSheet sign-in)**.
3. Chọn mục cần sửa theo tên và UID DOM/a11y từ snapshot mới nhất:
   - **Views:** kiểm tra view name, type, source/table/slice, position, display/behavior.
   - **Actions:** kiểm tra action name, target table, action type, conditions/behavior.
   - **Bots:** kiểm tra event, process, step/task, conditions và phụ thuộc.
   - **Expressions:** sao chép nguyên biểu thức trước khi sửa; chỉnh theo kiểu cột/context của AppSheet rồi dùng trình kiểm tra biểu thức của Editor.
4. Mỗi thay đổi phải có before/after: tên thực thể, giá trị cũ/mới, dự kiến tác động, validation của AppSheet, dấu hiệu lưu thành công. Không giả định có nút Save vì Editor có thể auto-save.
5. Kiểm thử trong Preview/Test mode hoặc trên môi trường kiểm thử trước khi thay đổi một bot gửi email/webhook hay action sửa dữ liệu hàng loạt. Kiểm tra bất kỳ side effect nào (thông báo, trigger, thay đổi bảng) trước khi chạy.
6. Không gọi `evaluate_script` để bypass auth, sửa state nội bộ trái quy trình Editor hoặc trích xuất cookie/token. Ưu tiên thao tác UI có thể kiểm chứng. Sau mỗi thao tác UI, lấy snapshot mới.

## 5. Quy tắc quyền và khả năng phục hồi

- Mọi thao tác đi qua SourceNerve MCP gateway và tool policy hiện hành; chỉ bật những tool cần thiết. Tool có `readOnlyHint=false` hoặc không rõ loại được gọi qua dispatcher write và vẫn có thể yêu cầu approval.
- Không retry tự động click, fill, push, deploy, gửi webhook hoặc chạy bot sau timeout không rõ kết quả. Đọc trạng thái trước khi thử tiếp.
- SourceNerve giữ phiên browser/computer trong tiến trình và lazy-reconnect khi lỗi; phiên đăng nhập Google, cửa sổ browser và token OAuth là các lớp trạng thái riêng, không được đảm bảo tái tạo qua mọi restart.
- Không báo đã triển khai lên Apps Script/AppSheet khi mới chỉ tạo PR hoặc khi Browser Use dừng tại trang đăng nhập.

## 6. Mẫu yêu cầu tiếng Việt

- "Liệt kê các Apps Script project mà clasp MCP đã xác thực truy cập được, chưa sửa code."
- "Đọc Apps Script dự án [script ID], mở PR sửa hàm [tên], chạy test và chỉ deploy khi tôi yêu cầu."
- "Mở AppSheet Editor của app [URL], kiểm tra View [tên] và Action [tên], mô tả cấu hình hiện tại."
- "Sửa Expression [tên] theo quy tắc [điều kiện], kiểm chứng bằng AppSheet Editor rồi báo diff before/after."

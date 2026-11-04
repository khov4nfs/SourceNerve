# SourceNerve: lập kế hoạch và thực thi thao tác có kiểm soát (tất cả connector)

## Mục tiêu và giới hạn

Trường hợp lỗi quan sát: người dùng yêu cầu sửa một dòng trong dự án Apps Script nhưng cầu nối cũ đọc toàn bộ source (MCP `Ask`), sau đó gửi toàn bộ `files[].source` qua ChatGPT để ghi (MCP `Ask` lần nữa). Yêu cầu bị hệ thống nền tảng từ chối trước khi đến SourceNerve. Đây là *vấn đề cấu trúc workflow*, không phải một loại comment cụ thể.

Không có thay đổi nào trong SourceNerve có thể hoặc nên tắt lớp kiểm tra an toàn độc lập của ChatGPT. Thay vì tăng quyền đại trà, các adapter nên thực hiện thao tác có phạm vi xác định bằng dữ liệu tối thiểu.

## Contract chung cho code và các thao tác khác

| Giai đoạn | Hành động | Dữ liệu trả ra ChatGPT |
| --- | --- | --- |
| DISCOVER | Tìm capability/tên công cụ, chính sách và scope cần thiết | Danh sách ngắn, không credential |
| PREVIEW (read-only) | Adapter tự đọc trạng thái thực trong trusted executor, kiểm tra payload và tác động dự kiến | Tên target, operations, hash HEAD, hash plan, diff tóm tắt (không source/bí mật) |
| AUTHORIZE | Người dùng kiểm tra và cho phép **đúng kế hoạch**; SourceNerve vẫn giữ các lớp policy/Ask và host safety | Approval cụ thể, không auto-approve |
| APPLY (write) | Trusted executor re-read HEAD; kiểm tra hash, scope, target, constraints; ghi một kế hoạch có thể review | Receipt gọn, hash kết quả, thời điểm, bằng chứng |
| VERIFY | Đọc lại trạng thái đã commit và so khớp kết quả, không tự retry sau timeout | Kết quả `verified` hoặc lỗi chưa rõ trạng thái |

**Kế hoạch phải có một target, tập thao tác cụ thể, giới hạn size, fingerprint đầu vào và digest của toàn bộ arguments.** Mọi thay đổi args sau preview đòi preview lại. Một nhóm nhiều thay đổi có thể dùng một approval **chỉ khi** chúng là **một mutation do adapter thực hiện theo cùng transaction/target** và chính sách hiện hành cho phép. Không gộp arbitrary tool calls, quyền khác scopes, deployment + source update hay quyền của bên thứ ba vào một approval không phân định.

## Hiện đã triển khai trong PR #250

- Apps Script `apps_script_patch_preview` và `apps_script_patch_apply`: nhiều thay đổi mã nguồn theo literal/unique `replace_exact`, `prepend`, `append` trên các file hiện có; tối đa 16 edits, 64 KiB payload, 8 KiB text/mỗi edit. Source được giữ trong Desktop Main và không xuất ra MCP/renderer. Google dùng `projects.updateContent`, nên giữ nguyên mọi file không sửa, kiểm tra fingerprint và GET hậu kiểm.
- Shortcut `apps_script_comment_preview/apply` vẫn hoạt động nhưng **không còn là giải pháp chủ đạo**.
- Luồng Desktop Xem trước/Ghi cho kế hoạch sửa mã và thao tác comment trực tiếp khi host chặn tool call.
- Giữ `apps_script_get_content`/`apps_script_update_content` cho thay đổi lớn có review thủ công; các công cụ nhạy cảm giữ chính sách `Ask`.

## Phần cần mở rộng theo từng connector (chưa triển khai tự động)

- **AppSheet:** các hành động ghi phải có adapter riêng có hiểu biết về bảng, key, action, số dòng dự kiến, mutation receipt và hỗ trợ dry-run theo API. `Find` hiện vẫn là công cụ read nhạy cảm; không tự động cấp quyền `Update`/`Delete`.
- **Browser / Figma / external SaaS:** dùng plan có nghĩa nghiệp vụ (target URL/object ID, thao tác, số đối tượng, thay đổi trường dữ liệu) và executor idempotent khi API hỗ trợ, không replay các tương tác GUI sau timeout.
- **Git / repo code:** tiếp tục dùng `task_propose_patch` → `task_apply_patch` / `patch_preview` → `patch_apply`, revalidate repository HEAD/hash và giữ review guards. Các lệnh push/merge/deploy phải có quyền riêng khi policy yêu cầu.
- **Multi-step workflow:** nếu cần nhiều mutations khác loại thì bộc lộ đúng số approvals theo rủi ro và boundary thực tế, thay vì một nút `always allow`. UI nên trình bày tất cả target/arguments trong một màn review, nhưng quyền runtime có thể vẫn cần từng approval riêng.

## Quy tắc xử lý thất bại

- `host_safety_blocked`: hiển thị lỗi, **dừng** và đề xuất luồng người dùng trực tiếp qua trusted Desktop UI. Không đổi tool/cấu trúc payload nhằm lách chặn.
- `source_conflict`: PREVIEW lại; không ghi.
- `approval_expired`: xin duyệt mới cho đúng kế hoạch; không giả định user đã ủy quyền vĩnh viễn.
- `write_ambiguous`: không retry; GET trạng thái để phân biệt đã ghi/chưa ghi; nếu không xác minh được thì báo chưa rõ.
- `provider_403`: giải quyết OAuth/scope/API chính thống; không nâng scope ngầm.
- `policy_denied`: giữ nguyên; chỉ người có quyền quản trị mới được điều chỉnh policy ngoài một execution.

## Những việc cần làm trong PR tương lai

1. Chuẩn hóa `OperationPreview`/`OperationReceipt` dùng chung, redaction để không có secrets ở MCP boundaries.
2. Thêm registry các adapter hỗ trợ `preview`/`apply` với schema/size/safety policy độc lập từng provider.
3. Dùng chính xác SourceNerve `harness_approval_respond` hiện có để chỉ phê duyệt tool+args hash đã review. **Không tự động cấp phép, không chuyển mode Ask sang Automatic cho writes**.
4. E2E kiểm chứng repo patch, Apps Script, AppSheet có phản hồi 403, multi-connector workflows, gateway restart, race, expiry và host block.

Điều này là thiết kế chung; PR #250 hiện chỉ triển khai trực tiếp adapter Apps Script cho sửa mã. Không được mô tả như đã hỗ trợ mọi thao tác SaaS.

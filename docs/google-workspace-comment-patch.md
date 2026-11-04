# Apps Script single-line comment patch without full-source MCP payloads

## Vấn đề đã quan sát

`apps_script_get_content` yêu cầu nguồn đầy đủ nên chính sách SourceNerve `Ask` là hợp lý. Tuy nhiên, khi chỉ muốn thêm một dòng comment, gọi `apps_script_update_content` yêu cầu gửi **toàn bộ mã nguồn các file** (có thể hàng chục nghìn ký tự) từ ChatGPT, làm tăng dữ liệu nhạy cảm đi qua connector và có thể bị từ chối ngay trước khi SourceNerve nhận yêu cầu. Sau một phê duyệt đọc, phê duyệt ghi mới cũng là hai lần khác nhau.

Không có cách hợp lệ nào để sửa SourceNerve nhằm bỏ qua kiểm tra bảo vệ do nền tảng ChatGPT thực thi. Giải pháp ở đây là **thu hẹp thao tác và giảm kích thước/độ nhạy payload**, không nới lỏng an ninh.

## API mới

`google-workspace__apps_script_comment_preview`: **read-only, automatic** (dùng Google scope `script.projects.readonly` hoặc `script.projects`). Chỉ cần `scriptId`, `commentLine`, và `fileName` tùy chọn. SourceNerve Desktop Main GET toàn bộ HEAD trực tiếp từ Google, nhưng trả **chỉ metadata**:

```json
{
  "scriptId": "abcdefghijklmnopqrstuvwxyz0123456789",
  "commentLine": "// SourceNerve: smoke test",
  "fileName": "Code",
  "position": "file-start",
  "expectedFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "wouldChange": true,
  "fileCount": 2,
  "manifestPreserved": true
}
```

Khi chỉ có một file `SERVER_JS`, không cần cung cấp `fileName`. Nếu có nhiều file JS, caller phải chọn đúng tên file. Preview không tiết lộ code, URL chứa token, hoặc file manifest.

`google-workspace__apps_script_comment_apply`: **write, Ask** (scope `script.projects`). Chỉ gửi:
```json
{
  "scriptId": "abcdefghijklmnopqrstuvwxyz0123456789",
  "fileName": "Code",
  "commentLine": "// SourceNerve: smoke test",
  "expectedFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "confirmed": true
}
```

SourceNerve so khớp fingerprint HEAD trước khi ghi, giữ nguyên toàn bộ các file/manifest trong Main, chèn đúng một dòng ở đầu một file `SERVER_JS` (tôn trọng line endings), ghi Google `projects.updateContent`, so sánh fingerprint phản hồi rồi GET lại HEAD để xác minh. Kết quả là acknowledgement nhỏ: `{scriptId,fileName,previousFingerprint,newFingerprint,changed,verified}`. Nếu comment đã tồn tại ngay đầu file, `changed=false` và **không PUT**. Nếu HEAD thay đổi, dừng để preview lại; không tự gộp patch.

## UX — tối đa một phê duyệt MCP cho một thay đổi nhỏ

1. Người dùng chọn dự án và nêu một comment bắt đầu bằng `// `, một dòng, ≤200 ký tự và ≤512 byte UTF-8.
2. ChatGPT gọi `apps_script_comment_preview` qua read dispatcher; không cần gọi `apps_script_get_content` hoặc truyền source vào hội thoại.
3. ChatGPT trình bày tên file, comment và thay đổi một dòng; khi người dùng xác nhận, gọi `apps_script_comment_apply` một lần. SourceNerve có thể yêu cầu một approval **Ask** cho đúng công cụ/đúng hash tham số. Giữ nguyên Ask; không tự approve.
4. Nếu công cụ ghi bị nền tảng từ chối hoặc policy chặn, không retry ồ ạt hoặc đổi sang tool khác để lách chặn. Người dùng có thể vào **SourceNerve Desktop → Google Workspace → Thêm một dòng comment**, bấm Xem trước rồi trực tiếp bấm Ghi. Đây là luồng hành động người dùng trong Desktop, không phải yêu cầu vượt qua host policy.

**Không cung cấp chế độ always allow cho write, không tự merge/deploy, không tự chạy lại khi kết quả PUT chưa chắc chắn.**

## Ranh giới kỹ thuật

- Token Google chỉ nằm trong OS secure store và Main; file source chỉ lưu tạm trong Main, không vào request/response MCP mới hoặc renderer.
- Chỉ cho phép comment `// ` đơn dòng, không chèn JavaScript tùy ý, không sửa manifest hay file khác; giới hạn kích thước và filename.
- `projects.updateContent` của Google thay thế toàn bộ các file HEAD trong một PUT và có thể ảnh hưởng trigger đang chạy. Vì vậy có GET HEAD trước PUT, fingerprint SHA-256 trước/sau, GET xác minh, và không tự retry sau lỗi timeout. API Google **không cung cấp compare-and-swap atomic**; vẫn có rủi ro race nếu một editor khác sửa đúng giữa GET và PUT. Tránh chỉnh đồng thời.
- Sau `apps_script_comment_apply` nhận lỗi verification/timeout, **không** gọi apply lần nữa ngay; dùng preview mới để xác minh trạng thái thực tế, rồi quyết định.
- Tool `apps_script_get_content` và `apps_script_update_content` vẫn tồn tại cho các ca sửa nhiều dòng cần review toàn bộ, và giữ nguyên chính sách `Ask`.
- Tên công cụ mới được phân loại tại `mcp_extension_policy.rs` theo allowlist first-party `sourcenerve-google-workspace`, không tác động đến MCP bên thứ ba.

Google Apps Script API docs: https://developers.google.com/apps-script/api/how-tos/manage-projects và https://developers.google.com/apps-script/api/reference/rest/v1/projects/updateContent .

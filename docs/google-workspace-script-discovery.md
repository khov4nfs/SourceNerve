# Apps Script project discovery via Google Drive metadata (SourceNerve)

## Mục tiêu

SourceNerve MCP `google-workspace__apps_script_list_projects` trả về **một trang** các dự án Apps Script **độc lập** mà tài khoản Google đã ủy quyền có thể xem. Mỗi mục trả về `name`, `scriptId`, `modifiedTime` (có thể `null`) và `editorUrl`. `nextPageToken` dùng để chuyển trang tiếp theo; `incompleteSearch` phản ánh cảnh báo từ Drive.

**Giới hạn:** Google Drive không hiển thị script gắn với Sheets, Docs, Forms hay Slides; không mô tả kết quả này là “tất cả Apps Script của tài khoản”. Dự án gắn container phải lấy Script ID từ Apps Script Editor hoặc ngữ cảnh container đã được người dùng cấp quyền. Các project chỉ tồn tại ở tài khoản Google khác cũng không xuất hiện.

## Chế độ OAuth và ủy quyền lại

Chức năng là **opt-in**, không thay đổi scope mặc định của kết nối Apps Script đang hoạt động.

1. Bật **Google Drive API** trong cùng Google Cloud project chứa OAuth Client Desktop. Apps Script API vẫn cần được bật để đọc/sửa project sau này.
2. Vào SourceNerve Desktop → **Plugins + MCP → Google Workspace**. Không cần nhập lại Client ID khi đã cấu hình trước đó.
3. Nhấn **Cấp quyền Drive metadata và ủy quyền lại**. SourceNerve chỉ thêm `https://www.googleapis.com/auth/drive.metadata.readonly` vào các scope Apps Script đã chọn, xóa access/refresh token cũ khỏi secure store, rồi mở trình duyệt yêu cầu Google OAuth PKCE consent lại.
4. Sau khi Google đồng ý và status `connected=true`, nhấn **Liệt kê Apps Script** hoặc yêu cầu ChatGPT “liệt kê các dự án Apps Script của tôi”. MCP catalog sẽ công bố `google-workspace__apps_script_list_projects`.
5. Muốn chuyển trang: đưa `nextPageToken` của trang trước vào `pageToken` của lần gọi tiếp theo (với `pageSize` 1..100). Không tự phỏng đoán token.

**Restricted scope:** `drive.metadata.readonly` là scope bị Google xếp loại *restricted*. OAuth consent screen của Google Cloud có thể cần cấu hình test users, verification và security assessment theo trường hợp sử dụng, đặc biệt khi phát hành rộng. Không dùng `drive` hay `drive.readonly` để vượt giới hạn khi metadata-only đã đủ.

**Cấu hình OAuth Desktop:** Google native app không hỗ trợ incremental authorization theo cách web app; khi bật discovery, SourceNerve phải bỏ token cũ và yêu cầu consent đầy đủ các scope kết hợp. `prompt=consent` áp dụng **riêng** cho Google Workspace first-party authorization URL, không áp dụng cho MCP provider khác. Không dùng token của Google Drive connector trong ChatGPT thay cho token Desktop; hai kết nối và tài khoản có thể khác nhau.

## Giao thức

```json
{
  "public_tool": "google-workspace__apps_script_list_projects",
  "arguments": { "pageSize": 50 }
}
```

Kết quả ví dụ **minh họa, không phải dữ liệu thật**:

```json
{
  "projects": [
    {
      "name": "Sample standalone script",
      "scriptId": "abcdefghijklmnopqrstuvwxyz0123456789",
      "modifiedTime": "2026-11-03T09:00:00.000Z",
      "editorUrl": "https://script.google.com/d/abcdefghijklmnopqrstuvwxyz0123456789/edit"
    }
  ],
  "nextPageToken": null,
  "incompleteSearch": false
}
```

### Ranh giới bảo mật

- Gọi **duy nhất** `GET https://www.googleapis.com/drive/v3/files` với `q=mimeType = 'application/vnd.google-apps.script' and trashed = false`, `corpora=user`, `spaces=drive`, `fields=nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)`, `orderBy=modifiedTime desc`. Không đọc file content, permissions, owner emails hay download link.
- Query string do code cố định xây dựng bằng `URLSearchParams`; `pageToken` luôn được encode và giới hạn 4096 ký tự. Không nhận URL bất kỳ từ ChatGPT hoặc trả metadata ngoài danh sách trường đã chọn.
- `editorUrl` được xây dựng từ Script ID đã kiểm tra định dạng, theo định dạng chính thức `https://script.google.com/d/{scriptId}/edit`; không tái sử dụng URL do API trả về.
- Google access/refresh token nằm trong OS secure store (Main) và bộ nhớ thực thi HTTPS; không xuất hiện trong MCP tool results, UI, GitHub, .env hay shell.
- `apps_script_list_projects` là công cụ read-only (MCP read dispatcher). Các tool sửa nội dung/version/deployment vẫn chịu chính sách `Ask` như trước.
- Khi Google trả 401/403, kiểm tra API đã được bật, tài khoản Google và scope trong consent; không tự nâng quyền hoặc thử dùng scope toàn Drive.
- Kết quả thực tế chỉ khả dụng **sau khi merge, cài lại SourceNerve Desktop và người dùng thực hiện OAuth re-consent**. PR hoặc kiểm thử mock không xác nhận đã có dữ liệu dự án thật.

Nguồn: https://developers.google.com/apps-script/guides/import-export , https://developers.google.com/apps-script/guides/collaborating , https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list , https://developers.google.com/workspace/drive/api/guides/api-specific-auth , https://developers.google.com/apps-script/api/quickstart/nodejs

import { useEffect, useState } from "react";

import type {
  AppsScriptProjectSummary,
  AppsScriptContainerSummary,
  AppsScriptBoundCheck,
  AppsScriptResolvedReference,
  AppsScriptCommentPreview,
  AppsScriptPatchPreview,
  AppsScriptTextEdit,
  AppsScriptEditOperation,
  GoogleScriptAccessMode,
  GoogleWorkspaceStatus,
} from "../../shared/google-workspace-api";
import { ActionButton } from "./atoms/ActionButton";
import { InlineNotice } from "./molecules/InlineNotice";
import { Panel } from "./Panel";

const fieldClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
const regionalEndpoints = [
  { value: "www.appsheet.com", label: "Global" },
  { value: "eu.appsheet.com", label: "Europe" },
  { value: "asia-southeast.appsheet.com", label: "Asia Pacific" },
] as const;

export function GoogleWorkspacePanel() {
  const [status, setStatus] = useState<GoogleWorkspaceStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [mode, setMode] = useState<GoogleScriptAccessMode>("read");
  const [scriptId, setScriptId] = useState("");
  const [projects, setProjects] = useState<AppsScriptProjectSummary[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [incompleteSearch, setIncompleteSearch] = useState(false);
  const [containerQuery, setContainerQuery] = useState("");
  const [containers, setContainers] = useState<AppsScriptContainerSummary[]>([]);
  const [containerNextPageToken, setContainerNextPageToken] = useState<string | null>(null);
  const [containerId, setContainerId] = useState("");
  const [boundCheck, setBoundCheck] = useState<AppsScriptBoundCheck | null>(null);
  const [scriptReference, setScriptReference] = useState("");
  const [resolvedScripts, setResolvedScripts] = useState<AppsScriptResolvedReference[]>([]);
  const [scriptSummary, setScriptSummary] = useState("");
  const [patchFileName, setPatchFileName] = useState("");
  const [patchOperation, setPatchOperation] = useState<AppsScriptEditOperation>("replace_exact");
  const [patchFindText, setPatchFindText] = useState("");
  const [patchInsertText, setPatchInsertText] = useState("");
  const [patchEdits, setPatchEdits] = useState<AppsScriptTextEdit[]>([]);
  const [patchPreview, setPatchPreview] = useState<AppsScriptPatchPreview | null>(null);
  const [commentFileName, setCommentFileName] = useState("");
  const [commentLine, setCommentLine] = useState("");
  const [commentPreview, setCommentPreview] = useState<AppsScriptCommentPreview | null>(null);
  const [appId, setAppId] = useState("");
  const [region, setRegion] = useState("www.appsheet.com");
  const [key, setKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [table, setTable] = useState("");
  const [rowSummary, setRowSummary] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    const response = await window.sourcenerveGoogleWorkspace.status();
    if (response.ok) {
      setStatus(response.value);
      if (response.value.mode) setMode(response.value.mode);
    } else setError(response.error.message);
  }

  async function perform(name: string, operation: () => Promise<void>) {
    setBusy(name);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Thao tác Google Workspace thất bại");
    } finally {
      setBusy("");
    }
  }

  const api = window.sourcenerveGoogleWorkspace;

  async function fetchProjects(pageToken?: string) {
    const result = await api.listProjects({ pageSize: 50, ...(pageToken ? { pageToken } : {}) });
    if (!result.ok) throw new Error(result.error.message);
    setProjects((existing) => pageToken ? [...existing, ...result.value.projects] : result.value.projects);
    setNextPageToken(result.value.nextPageToken);
    setIncompleteSearch(result.value.incompleteSearch);
    setMessage(pageToken ? "Đã tải thêm một trang Apps Script." : "Đã đọc danh sách Apps Script từ Google Drive metadata.");
  }

  async function fetchContainers(pageToken?: string) {
    const result = await api.listContainers({
      pageSize: 30,
      ...(pageToken ? { pageToken } : {}),
      ...(containerQuery.trim() ? { query: containerQuery.trim() } : {}),
    });
    if (!result.ok) throw new Error(result.error.message);
    setContainers((previous) => pageToken
      ? [...previous, ...result.value.containers] : result.value.containers);
    setContainerNextPageToken(result.value.nextPageToken);
    if (!pageToken) {
      setContainerId("");
      setResolvedScripts([]);
    }
    setBoundCheck(null);
    setMessage(`Tìm thấy ${result.value.containers.length} tài liệu nguồn ứng viên trên trang này; chưa xác định tài liệu nào có Apps Script.`);
  }

  return (
    <Panel title="Google Workspace" eyebrow="OAuth Apps Script · AppSheet API key">
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Kết nối riêng với Google bằng OAuth PKCE. Token được lưu trong secure store của máy;
          AppSheet Editor vẫn yêu cầu đăng nhập trình duyệt, còn REST API dùng Application Access Key riêng.
        </p>
        <div className="rounded-lg border border-border p-3 space-y-3">
          <p className="text-sm font-medium">Apps Script · Google OAuth</p>
          <p className="text-xs text-muted-foreground">
            {status?.connected ? "OAuth đã kết nối" : status?.configured ? "Đã cấu hình, chưa kết nối" : "Chưa cấu hình"}
            {status?.mode ? ` · Phạm vi: ${status.mode}` : ""}
          </p>
          <label className="block text-xs space-y-1">
            <span>Google Cloud Desktop OAuth Client ID</span>
            <input aria-label="Google Cloud Desktop OAuth Client ID" className={fieldClass}
              autoComplete="off" placeholder="000000.apps.googleusercontent.com"
              value={clientId} onChange={(event) => setClientId(event.target.value)} />
          </label>
          <label className="block text-xs space-y-1">
            <span>Client secret (tùy chọn, chỉ nếu Google OAuth Client yêu cầu)</span>
            <input aria-label="Google Desktop OAuth optional client secret" type="password"
              autoComplete="off" className={fieldClass} value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)} />
          </label>
          <label className="block text-xs space-y-1">
            <span>Phạm vi quyền yêu cầu</span>
            <select aria-label="Google Apps Script access mode" className={fieldClass}
              value={mode} onChange={(event) => setMode(event.target.value as GoogleScriptAccessMode)}>
              <option value="read">Chỉ đọc dự án</option>
              <option value="edit">Đọc và sửa source</option>
              <option value="deploy">Đọc, sửa và deploy</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <ActionButton size="sm" disabled={Boolean(busy) || !clientId.trim()}
              onClick={() => void perform("configure", async () => {
                const response = await api.configure(clientId.trim(), mode, clientSecret || undefined);
                if (!response.ok) throw new Error(response.error.message);
                setStatus(response.value);
                setProjects([]);
                setResolvedScripts([]);
                setScriptReference("");
                setContainers([]);
                setContainerNextPageToken(null);
                setContainerId("");
                setBoundCheck(null);
                setNextPageToken(null);
                setCommentPreview(null);
                setPatchPreview(null);
                setPatchEdits([]);
                setMessage("Đã lưu OAuth Desktop Client và phạm vi quyền. Đổi scope sẽ yêu cầu consent lại; chưa tự cấp quyền.");
                setClientId("");
                setClientSecret("");
              })}>Lưu cấu hình</ActionButton>
            <ActionButton size="sm" variant="secondary" disabled={Boolean(busy) || !status?.configured}
              onClick={() => void perform("connect", async () => {
                const response = await api.connect();
                if (!response.ok) throw new Error(response.error.message);
                setStatus(response.value);
                // The next OAuth consent may select a different Google account.
                // Never keep showing project metadata from the prior identity.
                setProjects([]);
                setResolvedScripts([]);
                setScriptReference("");
                setContainers([]);
                setContainerNextPageToken(null);
                setContainerId("");
                setBoundCheck(null);
                setNextPageToken(null);
                setScriptSummary("");
                setCommentPreview(null);
                setPatchPreview(null);
                setPatchEdits([]);
                setMessage("Đã nhận phản hồi OAuth. Hãy kiểm tra quyền API trên tài khoản Google.");
              })}>Đăng nhập Google</ActionButton>
            <ActionButton size="sm" variant="destructive" disabled={Boolean(busy) || !status?.connected}
              onClick={() => void perform("disconnect", async () => {
                const response = await api.disconnect();
                if (!response.ok) throw new Error(response.error.message);
                setStatus(response.value);
                setScriptSummary("");
                setProjects([]);
                setResolvedScripts([]);
                setScriptReference("");
                setContainers([]);
                setContainerNextPageToken(null);
                setContainerId("");
                setBoundCheck(null);
                setNextPageToken(null);
                setCommentPreview(null);
                setPatchPreview(null);
                setPatchEdits([]);
                setMessage("Đã ngắt và thu hồi kết nối Google.");
              })}>Ngắt kết nối</ActionButton>
          </div>
          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium">Danh sách Apps Script từ Google Drive</p>
            <p className="text-xs text-muted-foreground">
              Chỉ đọc metadata (tên, Script ID, thời gian sửa). Google Drive chỉ liệt kê các script
              độc lập; script gắn với Sheets/Docs/Forms không xuất hiện trong kết quả này.
            </p>
            <p className="text-xs text-muted-foreground">
              {status?.projectDiscoveryEnabled
                ? "Đã bật quyền Drive metadata.readonly"
                : "Chưa cấp quyền Drive metadata.readonly"}
            </p>
            {!status?.projectDiscoveryEnabled && (
              <ActionButton size="sm" variant="secondary"
                disabled={Boolean(busy) || !status?.configured}
                onClick={() => void perform("discovery-consent", async () => {
                  const enabled = await api.enableProjectDiscovery();
                  if (!enabled.ok) throw new Error(enabled.error.message);
                  setStatus(enabled.value);
                  setProjects([]);
                setResolvedScripts([]);
                setScriptReference("");
                  setContainers([]);
                  setContainerNextPageToken(null);
                  setContainerId("");
                  setBoundCheck(null);
                  setNextPageToken(null);
                  const connected = await api.connect();
                  if (!connected.ok) throw new Error(connected.error.message);
                  setStatus(connected.value);
                  setMessage("Đã cấp lại OAuth với quyền Drive metadata.readonly. Có thể liệt kê Apps Script.");
                })}>Cấp quyền Drive metadata và ủy quyền lại</ActionButton>
            )}
            {status?.projectDiscoveryEnabled && (
              <ActionButton size="sm" variant="secondary"
                disabled={Boolean(busy) || !status.connected}
                onClick={() => void perform("discovery-list", async () => {
                  await fetchProjects();
                })}>Liệt kê Apps Script</ActionButton>
            )}
            {projects.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{projects.length} dự án đã tải</p>
                <ul className="space-y-2">
                  {projects.map((project) => (
                    <li className="rounded border border-border p-2" key={project.scriptId}>
                      <a className="text-sm underline break-words" href={project.editorUrl}
                        target="_blank" rel="noopener noreferrer">{project.name}</a>
                      <p className="text-xs text-muted-foreground break-all">Script ID: {project.scriptId}</p>
                      <p className="text-xs text-muted-foreground">Cập nhật: {project.modifiedTime ?? "Không có dữ liệu"}</p>
                      <ActionButton size="sm" variant="secondary"
                        onClick={() => { setScriptId(project.scriptId); setCommentPreview(null); }}>Chọn Script ID</ActionButton>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {incompleteSearch && (
              <InlineNotice tone="info" title="Drive">{ "Google Drive chưa tìm kiếm hết tất cả khu vực Drive; danh sách có thể chưa đầy đủ." }</InlineNotice>
            )}
            {nextPageToken && (
              <ActionButton size="sm" variant="secondary" disabled={Boolean(busy)}
                onClick={() => void perform("discovery-more", async () => {
                  await fetchProjects(nextPageToken);
                })}>Tải thêm</ActionButton>
            )}
          </div>
          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium">Tìm Apps Script gắn với Sheets / Docs / Slides / Forms</p>
            <p className="text-xs text-muted-foreground">
              Google không cung cấp API liệt kê Script ID theo tài liệu nguồn. Hãy tìm tài liệu
              bằng Drive metadata, mở Extensions → Apps Script (hoặc menu Apps Script của Forms)
              và sao chép URL Editor trên thanh địa chỉ. Dán URL bên dưới để nhận diện dự án.
              Danh sách tài liệu nguồn không khẳng định có Apps Script.
            </p>
            <label className="block text-xs space-y-1">
              <span>Tìm tên tài liệu nguồn (tùy chọn)</span>
              <input aria-label="Search bound script container" className={fieldClass}
                value={containerQuery} maxLength={128}
                onChange={(event) => {
                  setContainerQuery(event.target.value);
                  setContainerNextPageToken(null);
                  setContainers([]);
                  setContainerId("");
                  setBoundCheck(null);
                  setResolvedScripts([]);
                }}
                placeholder="Tên Google Sheet, Doc, Slide hoặc Form" />
            </label>
            <ActionButton size="sm" variant="secondary"
              disabled={Boolean(busy) || !status?.connected || !status.projectDiscoveryEnabled}
              onClick={() => void perform("containers-list", async () => { await fetchContainers(); })}>
              Tìm tài liệu nguồn ứng viên
            </ActionButton>
            {containers.length > 0 && (
              <ul className="space-y-2">
                {containers.map((container) => (
                  <li className="rounded border border-border p-2 space-y-1" key={container.containerId}>
                    <a className="text-sm underline break-words" href={container.editorUrl}
                      target="_blank" rel="noopener noreferrer">{container.name}</a>
                    <p className="text-xs text-muted-foreground">
                      {container.kind === "sheet" ? "Google Sheets" :
                        container.kind === "doc" ? "Google Docs" :
                        container.kind === "slide" ? "Google Slides" : "Google Forms"} · {container.modifiedTime ?? "Không rõ thời gian sửa"}
                    </p>
                    <ActionButton size="sm" variant="secondary" disabled={Boolean(busy)}
                      onClick={() => {
                        setContainerId(container.containerId);
                        setBoundCheck(null);
                        setResolvedScripts([]);
                      }}>
                      {containerId === container.containerId ? "Đã chọn tài liệu nguồn" : "Chọn tài liệu nguồn"}
                    </ActionButton>
                  </li>
                ))}
              </ul>
            )}
            {containerNextPageToken && (
              <ActionButton size="sm" variant="secondary" disabled={Boolean(busy)}
                onClick={() => void perform("containers-more", async () => {
                  await fetchContainers(containerNextPageToken);
                })}>Tải thêm tài liệu nguồn</ActionButton>
            )}
            {containerId && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground break-all">Container ID: {containerId}</p>
                <ActionButton size="sm" variant="secondary"
                  disabled={Boolean(busy) || !status?.connected || !scriptId.trim()}
                  onClick={() => void perform("bound-check", async () => {
                    const result = await api.checkBoundScript(scriptId.trim(), containerId);
                    if (!result.ok) throw new Error(result.error.message);
                    setBoundCheck(result.value);
                    setMessage(result.value.match === "verified"
                      ? "Google xác nhận Script ID gắn với tài liệu đã chọn."
                      : result.value.match === "mismatch"
                        ? "Script ID thuộc một container khác."
                        : "Google chưa trả parentId. Không thể xác minh liên kết chỉ bằng API.");
                  })}>Đối chiếu Script ID với tài liệu đã chọn</ActionButton>
              </div>
            )}
            {boundCheck && (
              <p className="text-xs text-muted-foreground">
                {boundCheck.scriptTitle ?? "Apps Script"} · {
                  boundCheck.match === "verified" ? "Đã xác minh" :
                  boundCheck.match === "mismatch" ? "Không khớp" : "Chưa xác minh"
                }
              </p>
            )}
          </div>
          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium">Nhận diện Apps Script từ URL Editor</p>
            <p className="text-xs text-muted-foreground">
              Dán Script ID hoặc URL từ script.google.com/d/.../edit hay
              script.google.com/home/projects/.../edit. SourceNerve chỉ trích ID
              để đọc projects.get bằng OAuth hiện tại, không truy cập URL được dán.
              Danh sách vừa nhận diện chỉ lưu trong phiên giao diện này.
            </p>
            <label className="block text-xs space-y-1">
              <span>Script ID hoặc URL Apps Script Editor</span>
              <input aria-label="Apps Script ID or editor URL" className={fieldClass}
                maxLength={512} value={scriptReference}
                onChange={(event) => setScriptReference(event.target.value)}
                placeholder="https://script.google.com/home/projects/.../edit" />
            </label>
            <ActionButton size="sm" variant="secondary"
              disabled={Boolean(busy) || !status?.connected || !scriptReference.trim()}
              onClick={() => void perform("script-resolve", async () => {
                const result = await api.resolveScriptReference(
                  scriptReference.trim(), containerId || undefined,
                );
                if (!result.ok) throw new Error(result.error.message);
                setScriptId(result.value.scriptId);
                setBoundCheck(null);
                setCommentPreview(null);
                setPatchPreview(null);
                setScriptSummary("");
                setResolvedScripts((previous) => [
                  result.value, ...previous.filter((item) => item.scriptId !== result.value.scriptId),
                ].slice(0, 20));
                setMessage(result.value.match === "verified"
                  ? "Đã xác minh Apps Script gắn với tài liệu nguồn đã chọn."
                  : result.value.match === "mismatch"
                    ? "Script đã nhận diện, nhưng thuộc một container khác."
                    : result.value.match === "unconfirmed"
                      ? "Đã nhận diện Script ID; Google không trả parentId nên chưa xác minh được container."
                      : "Đã nhận diện Script ID. Chọn tài liệu nguồn để đối chiếu liên kết.");
              })}>Nhận diện và chọn project</ActionButton>
            {resolvedScripts.length > 0 && (
              <ul className="space-y-2">
                {resolvedScripts.map((project) => (
                  <li className="rounded border border-border p-2 space-y-1" key={project.scriptId}>
                    <a className="text-sm underline break-words" href={project.editorUrl}
                      target="_blank" rel="noopener noreferrer">{project.scriptTitle || "Apps Script"}</a>
                    <p className="text-xs text-muted-foreground break-all">Script ID: {project.scriptId}</p>
                    <p className="text-xs text-muted-foreground">
                      Cập nhật: {project.modifiedTime ?? "Không có dữ liệu"} · {
                        project.match === "verified" ? "Đã xác minh container" :
                        project.match === "mismatch" ? "Container không khớp" :
                        project.match === "unconfirmed" ? "Chưa xác minh container" :
                        "Chưa đối chiếu container"}
                    </p>
                    <ActionButton size="sm" variant="secondary" disabled={Boolean(busy)}
                      onClick={() => { setScriptId(project.scriptId); setBoundCheck(null); }}>
                      Chọn Script ID
                    </ActionButton>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <label className="block text-xs space-y-1">
            <span>Apps Script ID (project được bạn chọn)</span>
            <input aria-label="Apps Script ID" className={fieldClass} value={scriptId}
              placeholder="Script ID" onChange={(event) => {
                setScriptId(event.target.value);
                setCommentPreview(null);
                setBoundCheck(null);
              }} />
          </label>
          <ActionButton size="sm" variant="secondary" disabled={Boolean(busy) || !status?.connected || !scriptId}
            onClick={() => void perform("script", async () => {
              const result = await api.scriptContent(scriptId.trim());
              if (!result.ok) throw new Error(result.error.message);
              setScriptSummary(`${result.value.files.length} tệp · SHA-256 ${result.value.fingerprint.slice(0, 16)}… · ${result.value.files.map((file) => file.name).join(", ")}`);
              setMessage("Đọc source thành công. Chưa push hay deploy.");
            })}>Kiểm tra source</ActionButton>
          {scriptSummary && <p className="text-xs break-all text-muted-foreground">{scriptSummary}</p>}

          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium">Kế hoạch sửa mã nguồn (HEAD)</p>
            <p className="text-xs text-muted-foreground">
              Thay thế đoạn mã khớp chính xác hoặc thêm đầu/cuối file. Có thể gom tối đa 16 chỉnh sửa
              thành một kế hoạch, một lần ghi có phê duyệt. SourceNerve tự giữ tất cả file còn lại
              trong Desktop; không gửi source code toàn dự án qua ChatGPT.
            </p>
            <label className="block text-xs space-y-1">
              <span>Tên file Apps Script (không gồm đuôi .gs/.html)</span>
              <input aria-label="Apps Script patch filename" className={fieldClass}
                value={patchFileName} onChange={(event) => setPatchFileName(event.target.value)}
                placeholder="Code" />
            </label>
            <label className="block text-xs space-y-1">
              <span>Loại chỉnh sửa</span>
              <select aria-label="Apps Script patch operation" className={fieldClass}
                value={patchOperation}
                onChange={(event) => setPatchOperation(event.target.value as AppsScriptEditOperation)}>
                <option value="replace_exact">Thay thế một đoạn khớp chính xác duy nhất</option>
                <option value="prepend">Thêm vào đầu file</option>
                <option value="append">Thêm vào cuối file</option>
              </select>
            </label>
            {patchOperation === "replace_exact" && (
              <label className="block text-xs space-y-1">
                <span>Đoạn cần tìm (khớp chính xác một lần, tối đa 16 KiB)</span>
                <textarea aria-label="Apps Script patch find text" rows={3}
                  className={fieldClass} value={patchFindText}
                  onChange={(event) => setPatchFindText(event.target.value)} />
              </label>
            )}
            <label className="block text-xs space-y-1">
              <span>{patchOperation === "replace_exact" ? "Đoạn thay thế" : "Nội dung cần chèn"} (tối đa 8 KiB)</span>
              <textarea aria-label="Apps Script patch replacement text" rows={3}
                className={fieldClass} value={patchInsertText}
                onChange={(event) => setPatchInsertText(event.target.value)} />
            </label>
            <div className="flex flex-wrap gap-2">
              <ActionButton size="sm" variant="secondary" disabled={Boolean(busy) ||
                patchEdits.length >= 16 || !patchFileName.trim() ||
                (patchOperation !== "replace_exact" && !patchInsertText) ||
                (patchOperation === "replace_exact" && !patchFindText)}
                onClick={() => {
                  setPatchEdits((previous) => [...previous, {
                    fileName: patchFileName.trim(), operation: patchOperation,
                    ...(patchOperation === "replace_exact" ? { findText: patchFindText } : {}),
                    text: patchInsertText,
                  }]);
                  setPatchPreview(null);
                  setPatchFindText("");
                  setPatchInsertText("");
                }}>Thêm vào kế hoạch</ActionButton>
              <ActionButton size="sm" variant="secondary" disabled={Boolean(busy) || patchEdits.length === 0}
                onClick={() => { setPatchEdits([]); setPatchPreview(null); }}>Xóa kế hoạch</ActionButton>
            </div>
            {patchEdits.length > 0 && (
              <div className="text-xs text-muted-foreground space-y-1">
                <p>{patchEdits.length} chỉnh sửa đã chọn:</p>
                <ul className="list-disc pl-4">
                  {patchEdits.map((edit, index) => (
                    <li key={index} className="space-y-1">
                      <p>{edit.fileName} · {edit.operation}</p>
                      {edit.operation === "replace_exact" && (
                        <pre className="overflow-auto whitespace-pre-wrap break-all rounded border border-border p-2">{edit.findText}</pre>
                      )}
                      <p>{edit.operation === "replace_exact" ? "Thành:" : "Chèn:"}</p>
                      <pre className="overflow-auto whitespace-pre-wrap break-all rounded border border-border p-2">{edit.text || "(xóa đoạn khớp)"}</pre>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <ActionButton size="sm" variant="secondary"
                disabled={Boolean(busy) || !status?.connected || !scriptId.trim() || patchEdits.length === 0}
                onClick={() => void perform("patch-preview", async () => {
                  setPatchPreview(null);
                  const result = await api.previewScriptPatch({ scriptId: scriptId.trim(), edits: patchEdits });
                  if (!result.ok) throw new Error(result.error.message);
                  setPatchPreview(result.value);
                  setMessage("Đã xem trước kế hoạch sửa mã; chưa thay đổi Google Apps Script.");
                })}>Xem trước kế hoạch</ActionButton>
              <ActionButton size="sm" disabled={Boolean(busy) || !status?.connected ||
                status.mode === "read" || !patchPreview || !patchPreview.wouldChange ||
                patchPreview.scriptId !== scriptId.trim() ||
                patchPreview.editCount !== patchEdits.length}
                onClick={() => void perform("patch-apply", async () => {
                  if (!patchPreview) return;
                  const result = await api.applyScriptPatch({
                    scriptId: patchPreview.scriptId,
                    edits: patchEdits,
                    expectedFingerprint: patchPreview.expectedFingerprint,
                    expectedPatchedFingerprint: patchPreview.expectedPatchedFingerprint,
                    planFingerprint: patchPreview.planFingerprint,
                    confirmed: true,
                  });
                  if (!result.ok) throw new Error(result.error.message);
                  setPatchPreview(null);
                  setPatchEdits([]);
                  setMessage(result.value.changed
                    ? "Đã ghi và xác minh kế hoạch sửa Apps Script HEAD thành công."
                    : "Kế hoạch đã có sẵn trên HEAD, không cần ghi lại.");
                })}>Ghi kế hoạch đã duyệt</ActionButton>
            </div>
            {patchPreview && (
              <div className="text-xs text-muted-foreground space-y-1">
                <p>{patchPreview.editCount} chỉnh sửa · {patchPreview.changedFiles.length} file sẽ thay đổi</p>
                <p>File: {patchPreview.changedFiles.join(", ") || "Không có thay đổi"}</p>
                <p className="break-all">HEAD: {patchPreview.expectedFingerprint}</p>
                <p className="break-all">Sau khi ghi: {patchPreview.expectedPatchedFingerprint}</p>
                <p>Manifest và các file không được chọn sẽ được giữ nguyên.</p>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border p-3 space-y-2">
            <p className="text-sm font-medium">Thêm một dòng comment (HEAD)</p>
            <p className="text-xs text-muted-foreground">
              Xem trước bằng fingerprint mà không đưa source code qua ChatGPT.
              Nhấn Ghi chỉ sau khi kiểm tra dự án, file và comment. Thay đổi HEAD có thể ảnh hưởng trigger;
              không tạo version hoặc deployment.
            </p>
            <label className="block text-xs space-y-1">
              <span>Tên file .gs (để trống nếu dự án chỉ có một file .gs)</span>
              <input aria-label="Apps Script comment filename" className={fieldClass}
                value={commentFileName} onChange={(event) => {
                  setCommentFileName(event.target.value);
                  setCommentPreview(null);
                }} placeholder="Code" />
            </label>
            <label className="block text-xs space-y-1">
              <span>Đúng một dòng comment, bắt đầu bằng // </span>
              <input aria-label="Apps Script comment text" className={fieldClass}
                value={commentLine} onChange={(event) => {
                  setCommentLine(event.target.value);
                  setCommentPreview(null);
                }} placeholder="// SourceNerve: kiểm tra cập nhật Apps Script từ ChatGPT." />
            </label>
            <div className="flex flex-wrap gap-2">
              <ActionButton size="sm" variant="secondary"
                disabled={Boolean(busy) || !status?.connected || !scriptId.trim() ||
                  !commentLine.startsWith("// ")}
                onClick={() => void perform("comment-preview", async () => {
                  setCommentPreview(null);
                  const result = await api.previewScriptComment({
                    scriptId: scriptId.trim(),
                    commentLine,
                    ...(commentFileName.trim() ? { fileName: commentFileName.trim() } : {}),
                  });
                  if (!result.ok) throw new Error(result.error.message);
                  setCommentPreview(result.value);
                  setMessage("Đã xem trước bản vá nhỏ, chưa ghi Apps Script.");
                })}>Xem trước comment</ActionButton>
              <ActionButton size="sm" disabled={Boolean(busy) || !status?.connected ||
                status.mode === "read" || !commentPreview || !commentPreview.wouldChange ||
                scriptId.trim() !== commentPreview.scriptId ||
                commentLine !== commentPreview.commentLine ||
                (commentFileName.trim() !== "" && commentFileName.trim() !== commentPreview.fileName)}
                onClick={() => void perform("comment-apply", async () => {
                  if (!commentPreview) return;
                  const result = await api.applyScriptComment({
                    scriptId: commentPreview.scriptId,
                    fileName: commentPreview.fileName,
                    commentLine: commentPreview.commentLine,
                    expectedFingerprint: commentPreview.expectedFingerprint,
                    confirmed: true,
                  });
                  if (!result.ok) throw new Error(result.error.message);
                  setCommentPreview(null);
                  setMessage(result.value.changed
                    ? "Đã ghi và kiểm tra lại đúng một dòng comment trên Apps Script HEAD."
                    : "Comment đã tồn tại ở đầu file, không ghi lại.");
                })}>Ghi comment đã duyệt</ActionButton>
            </div>
            {commentPreview && (
              <div className="text-xs text-muted-foreground space-y-1">
                <p>File: {commentPreview.fileName} · {commentPreview.fileCount} tệp được giữ nguyên</p>
                <p className="break-all">Fingerprint: {commentPreview.expectedFingerprint}</p>
                <p>Thay đổi: {commentPreview.wouldChange
                  ? "Thêm đúng một dòng ở đầu file"
                  : "Comment đã có sẵn; không cần ghi"}</p>
                <p>Manifest: giữ nguyên</p>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border p-3 space-y-3">
          <p className="text-sm font-medium">AppSheet · REST API (Enterprise)</p>
          <p className="text-xs text-muted-foreground">
            Editor (Views/Actions/Bots/Expressions) thao tác bằng Browser Use với phiên đăng nhập riêng.
            Khóa API này chỉ dùng để gọi dữ liệu của một App ID qua HTTPS.
          </p>
          <label className="block text-xs space-y-1">
            <span>AppSheet App ID</span>
            <input aria-label="AppSheet App ID" className={fieldClass} value={appId}
              onChange={(event) => { setAppId(event.target.value); setKeyConfigured(null); }} />
          </label>
          <label className="block text-xs space-y-1">
            <span>Data residency region</span>
            <select aria-label="AppSheet region" className={fieldClass} value={region}
              onChange={(event) => { setRegion(event.target.value); setKeyConfigured(null); }}>
              {regionalEndpoints.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="block text-xs space-y-1">
            <span>Application Access Key</span>
            <input aria-label="AppSheet Application Access Key" type="password" autoComplete="off"
              className={fieldClass} value={key} onChange={(event) => setKey(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <ActionButton size="sm" disabled={Boolean(busy) || !appId || !key}
              onClick={() => void perform("appsheet-save", async () => {
                const result = await api.appSheetSetKey({ appId: appId.trim(), region, key });
                setKey("");
                if (!result.ok) throw new Error(result.error.message);
                setKeyConfigured(result.value.configured);
                setMessage("Đã mã hóa và lưu khóa AppSheet cho App ID này.");
              })}>Lưu khóa</ActionButton>
            <ActionButton size="sm" variant="secondary" disabled={Boolean(busy) || !appId}
              onClick={() => void perform("appsheet-status", async () => {
                const result = await api.appSheetKeyStatus(appId.trim(), region);
                if (!result.ok) throw new Error(result.error.message);
                setKeyConfigured(result.value.configured);
              })}>Kiểm tra khóa</ActionButton>
            <ActionButton size="sm" variant="destructive" disabled={Boolean(busy) || !appId}
              onClick={() => void perform("appsheet-revoke", async () => {
                const result = await api.appSheetClearKey(appId.trim(), region);
                if (!result.ok) throw new Error(result.error.message);
                setKeyConfigured(false);
                setMessage("Đã xóa khóa AppSheet khỏi secure store trên máy.");
              })}>Xóa khóa local</ActionButton>
          </div>
          {keyConfigured !== null &&
            <p className="text-xs text-muted-foreground">
              {keyConfigured ? "Có khóa local. Chưa xác minh quyền với AppSheet." : "Chưa lưu khóa cho App ID/region này."}
            </p>}
          <label className="block text-xs space-y-1">
            <span>Tên bảng AppSheet (chỉ đọc)</span>
            <input aria-label="AppSheet table name" className={fieldClass}
              value={table} onChange={(event) => setTable(event.target.value)} />
          </label>
          <ActionButton size="sm" variant="secondary"
            disabled={Boolean(busy) || !appId || !table || keyConfigured !== true}
            onClick={() => void perform("appsheet-find", async () => {
              const result = await api.appSheetFind(appId.trim(), region, table.trim());
              if (!result.ok) throw new Error(result.error.message);
              const count = Array.isArray(result.value) ? result.value.length : "không xác định";
              setRowSummary(`Find thành công · số bản ghi: ${count}`);
              setMessage("Kết nối AppSheet REST đã phản hồi. Không thay đổi bản ghi.");
            })}>Kiểm tra API (Find)</ActionButton>
          {rowSummary && <p className="text-xs text-muted-foreground">{rowSummary}</p>}
        </div>
        {error && <InlineNotice tone="danger" title="Google Workspace">{error}</InlineNotice>}
        {message && <InlineNotice tone="info" title="Google Workspace">{message}</InlineNotice>}
      </div>
    </Panel>
  );
}

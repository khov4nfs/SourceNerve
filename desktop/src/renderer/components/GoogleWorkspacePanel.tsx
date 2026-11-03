import { useEffect, useState } from "react";

import type { GoogleScriptAccessMode, GoogleWorkspaceStatus } from "../../shared/google-workspace-api";
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
  const [scriptSummary, setScriptSummary] = useState("");
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
                setMessage("Đã lưu OAuth Desktop Client và phạm vi quyền. Đổi scope sẽ yêu cầu consent lại; chưa tự cấp quyền.");
                setClientId("");
                setClientSecret("");
              })}>Lưu cấu hình</ActionButton>
            <ActionButton size="sm" variant="secondary" disabled={Boolean(busy) || !status?.configured}
              onClick={() => void perform("connect", async () => {
                const response = await api.connect();
                if (!response.ok) throw new Error(response.error.message);
                setStatus(response.value);
                setMessage("Đã nhận phản hồi OAuth. Hãy kiểm tra quyền API trên tài khoản Google.");
              })}>Đăng nhập Google</ActionButton>
            <ActionButton size="sm" variant="destructive" disabled={Boolean(busy) || !status?.connected}
              onClick={() => void perform("disconnect", async () => {
                const response = await api.disconnect();
                if (!response.ok) throw new Error(response.error.message);
                setStatus(response.value);
                setScriptSummary("");
                setMessage("Đã ngắt và thu hồi kết nối Google.");
              })}>Ngắt kết nối</ActionButton>
          </div>
          <label className="block text-xs space-y-1">
            <span>Apps Script ID (project được bạn chọn)</span>
            <input aria-label="Apps Script ID" className={fieldClass} value={scriptId}
              placeholder="Script ID" onChange={(event) => setScriptId(event.target.value)} />
          </label>
          <ActionButton size="sm" variant="secondary" disabled={Boolean(busy) || !status?.connected || !scriptId}
            onClick={() => void perform("script", async () => {
              const result = await api.scriptContent(scriptId.trim());
              if (!result.ok) throw new Error(result.error.message);
              setScriptSummary(`${result.value.files.length} tệp · SHA-256 ${result.value.fingerprint.slice(0, 16)}… · ${result.value.files.map((file) => file.name).join(", ")}`);
              setMessage("Đọc source thành công. Chưa push hay deploy.");
            })}>Kiểm tra source</ActionButton>
          {scriptSummary && <p className="text-xs break-all text-muted-foreground">{scriptSummary}</p>}
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

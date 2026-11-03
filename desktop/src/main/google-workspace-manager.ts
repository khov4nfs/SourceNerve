import { createHash } from "node:crypto";

import type { EncryptedSecretStore } from "./secure-store";
import { McpExtensionOAuthManager } from "./mcp-extension-oauth";
import type { McpExtensionClient } from "./mcp-extension-client";

const GOOGLE_CONNECTION_ID = "google-workspace";
const CLIENT_ID_KEY = "google-workspace:client-id";
const CLIENT_SECRET_KEY = "google-workspace:oauth-client-secret";
const ACCESS_MODE_KEY = "google-workspace:access-mode";
const APP_SCRIPT_BASE = "https://script.googleapis.com/v1/projects";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const READ_SCOPE = "https://www.googleapis.com/auth/script.projects.readonly";
const EDIT_SCOPE = "https://www.googleapis.com/auth/script.projects";
const DEPLOY_SCOPE = "https://www.googleapis.com/auth/script.deployments";
const DEPLOY_READ_SCOPE = "https://www.googleapis.com/auth/script.deployments.readonly";
const REGIONS = ["www.appsheet.com", "eu.appsheet.com", "asia-southeast.appsheet.com"] as const;

export type GoogleScriptAccessMode = "read" | "edit" | "deploy";
export interface GoogleWorkspaceStatus {
  configured: boolean;
  connected: boolean;
  mode: GoogleScriptAccessMode | null;
  expiresAt?: number;
}
export interface AppSheetAppStatus {
  appId: string;
  region: string;
  configured: boolean;
}
export interface AppsScriptFile {
  name: string;
  type: "SERVER_JS" | "HTML" | "JSON";
  source: string;
}
export interface AppsScriptContent {
  scriptId: string;
  files: AppsScriptFile[];
  fingerprint: string;
}
export interface AppsScriptUpdateInput {
  scriptId: string;
  files: AppsScriptFile[];
  expectedFingerprint: string;
  confirmed: true;
}
export interface AppSheetKeyInput {
  appId: string;
  region: string;
  key: string;
}

export interface GoogleWorkspaceManagerOptions {
  secretStore: EncryptedSecretStore;
  openExternal(url: string): Promise<unknown>;
  fetcher?: typeof fetch;
}

/**
 * Google API credentials remain in the OS secure store. This module is only
 * used inside Electron Main; it never materializes Google tokens into an MCP
 * STDIO sandbox, the renderer, commands, logs or a SourceNerve .env file.
 */
export class GoogleWorkspaceManager {
  private readonly store: EncryptedSecretStore;
  private readonly oauth: McpExtensionOAuthManager;
  private readonly fetcher: typeof fetch;
  constructor(options: GoogleWorkspaceManagerOptions) {
    this.store = options.secretStore;
    this.fetcher = options.fetcher ?? fetch;
    const noMcpMaterialization = {
      materializeCredential: async () => undefined,
      clearCredential: async () => undefined,
    } as unknown as McpExtensionClient;
    this.oauth = new McpExtensionOAuthManager({
      client: noMcpMaterialization,
      secretStore: options.secretStore,
      openExternal: options.openExternal,
    });
  }

  async configureGoogle(
    clientId: string,
    mode: GoogleScriptAccessMode,
    clientSecret?: string,
  ): Promise<GoogleWorkspaceStatus> {
    if (!validGoogleClientId(clientId)) throw new Error("Invalid Google Desktop OAuth client ID");
    if (!validMode(mode)) throw new Error("Invalid Google Apps Script permission mode");
    if (clientSecret !== undefined &&
        (clientSecret.length < 1 || clientSecret.length > 1024 || /[\r\n\0]/.test(clientSecret))) {
      throw new Error("Invalid optional Google Desktop OAuth client secret");
    }
    const oldClientId = await this.store.getOpaque(CLIENT_ID_KEY);
    const oldMode = await this.store.getOpaque(ACCESS_MODE_KEY);
    const oldSecret = await this.store.getOpaque(CLIENT_SECRET_KEY);
    const credentialChanged = oldClientId !== clientId || oldMode !== mode ||
      (clientSecret !== undefined && oldSecret !== clientSecret);
    if (credentialChanged) {
      // Google native apps require fresh consent when scope modes change.
      // Never reuse an earlier token after changing client ID/secret/scopes.
      await this.oauth.remove(GOOGLE_CONNECTION_ID);
      await this.store.setOpaque(CLIENT_ID_KEY, clientId);
      await this.store.setOpaque(ACCESS_MODE_KEY, mode);
      if (oldClientId !== clientId && clientSecret === undefined) {
        await this.store.deleteOpaque(CLIENT_SECRET_KEY);
      }
      if (clientSecret !== undefined) await this.store.setOpaque(CLIENT_SECRET_KEY, clientSecret);
    }
    await this.oauth.saveConfig(GOOGLE_CONNECTION_ID, {
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      revokeEndpoint: "https://oauth2.googleapis.com/revoke",
      clientId,
      scopes: scopesForMode(mode),
    });
    return this.googleStatus();
  }

  async googleStatus(): Promise<GoogleWorkspaceStatus> {
    const [savedId, savedMode, status] = await Promise.all([
      this.store.getOpaque(CLIENT_ID_KEY),
      this.store.getOpaque(ACCESS_MODE_KEY),
      this.oauth.status(GOOGLE_CONNECTION_ID),
    ]);
    const mode = validMode(savedMode) ? savedMode : null;
    return {
      configured: Boolean(savedId && status.configured && mode),
      connected: Boolean(savedId && status.connected && mode),
      mode,
      ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}),
    };
  }

  async connectGoogle(): Promise<GoogleWorkspaceStatus> {
    if (!(await this.googleStatus()).configured) {
      throw new Error("Configure a Google Desktop OAuth client ID before connecting");
    }
    await this.oauth.connect(GOOGLE_CONNECTION_ID);
    return this.googleStatus();
  }

  async disconnectGoogle(): Promise<GoogleWorkspaceStatus> {
    const status = await this.googleStatus();
    if (status.configured) await this.oauth.revoke(GOOGLE_CONNECTION_ID);
    return this.googleStatus();
  }

  async shutdown(): Promise<void> {
    await this.oauth.shutdown();
  }

  async getAppsScriptProject(scriptId: string): Promise<Record<string, unknown>> {
    return this.googleJson("GET", scriptPath(scriptId), "read");
  }

  async getAppsScriptContent(scriptId: string): Promise<AppsScriptContent> {
    const response = await this.googleJson("GET", scriptPath(scriptId) + "/content", "read");
    if (!Array.isArray(response.files) || !response.files.every(validScriptFile)) {
      throw new Error("Google Apps Script returned invalid project content");
    }
    return {
      scriptId,
      files: response.files,
      fingerprint: contentFingerprint(response.files),
    };
  }

  async updateAppsScriptContent(input: AppsScriptUpdateInput): Promise<AppsScriptContent> {
    if (input.confirmed !== true) throw new Error("Explicit Apps Script update confirmation required");
    if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) throw new Error("Invalid expected fingerprint");
    if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 200 ||
        !input.files.every(validScriptFile)) {
      throw new Error("Invalid Apps Script file payload");
    }
    if (!input.files.some((item) => item.name === "appsscript" && item.type === "JSON")) {
      throw new Error("Apps Script update must preserve appsscript.json manifest");
    }
    const body = JSON.stringify({ files: input.files });
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error("Apps Script content too large");
    const mode = (await this.googleStatus()).mode;
    if (!mode || !modeAllows(mode, "edit")) {
      throw new Error("Google Apps Script scope insufficient; reconnect with explicit permission");
    }
    const current = await this.getAppsScriptContent(input.scriptId);
    if (current.fingerprint !== input.expectedFingerprint) {
      throw new Error("Apps Script remote content changed; review the latest files before pushing");
    }
    const response = await this.googleJson("PUT", scriptPath(input.scriptId) + "/content", "edit", body);
    if (!Array.isArray(response.files) || !response.files.every(validScriptFile)) {
      throw new Error("Apps Script update returned malformed content; re-read project state");
    }
    return {
      scriptId: input.scriptId,
      files: response.files,
      fingerprint: contentFingerprint(response.files),
    };
  }

  async createAppsScriptVersion(input: { scriptId: string; description: string; confirmed: true }): Promise<Record<string, unknown>> {
    if (input.confirmed !== true || !boundedLabel(input.description, 0, 250)) {
      throw new Error("Version creation requires explicit confirmation and a valid description");
    }
    return this.googleJson("POST", scriptPath(input.scriptId) + "/versions", "edit", JSON.stringify({
      description: input.description,
    }));
  }

  async createAppsScriptDeployment(input: {
    scriptId: string;
    versionNumber: number;
    description: string;
    confirmed: true;
  }): Promise<Record<string, unknown>> {
    if (input.confirmed !== true || !Number.isSafeInteger(input.versionNumber) ||
        input.versionNumber < 1 || !boundedLabel(input.description, 0, 250)) {
      throw new Error("Deployment requires an explicit version and confirmation");
    }
    return this.googleJson("POST", scriptPath(input.scriptId) + "/deployments", "deploy", JSON.stringify({
      versionNumber: input.versionNumber,
      description: input.description,
      manifestFileName: "appsscript",
    }));
  }

  async configureAppSheetKey(input: AppSheetKeyInput): Promise<AppSheetAppStatus> {
    const { appId, region, key } = input;
    validateAppSheetTarget(appId, region);
    if (typeof key !== "string" || key.length < 16 || key.length > 1024 || /[\r\n\0]/.test(key)) {
      throw new Error("Invalid AppSheet Application Access Key");
    }
    await this.store.setOpaque(appSheetKeyName(appId, region), key);
    return { appId, region, configured: true };
  }

  async appSheetStatus(appId: string, region: string): Promise<AppSheetAppStatus> {
    validateAppSheetTarget(appId, region);
    return { appId, region, configured: await this.store.hasOpaque(appSheetKeyName(appId, region)) };
  }

  async clearAppSheetKey(appId: string, region: string): Promise<AppSheetAppStatus> {
    validateAppSheetTarget(appId, region);
    await this.store.deleteOpaque(appSheetKeyName(appId, region));
    return { appId, region, configured: false };
  }

  async findAppSheetRows(input: { appId: string; region: string; table: string }): Promise<unknown> {
    const { appId, region, table } = input;
    validateAppSheetTarget(appId, region);
    if (!boundedLabel(table, 1, 128)) throw new Error("Invalid AppSheet table name");
    const key = await this.store.getOpaque(appSheetKeyName(appId, region));
    if (!key) throw new Error("AppSheet Application Access Key has not been configured");
    const url = `https://${region}/api/v2/apps/${encodeURIComponent(appId)}/tables/${encodeURIComponent(table)}/Action`;
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", ApplicationAccessKey: key },
      body: JSON.stringify({ Action: "Find", Properties: {}, Rows: [] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    return safeJsonResponse(response, MAX_RESPONSE_BYTES, "AppSheet");
  }

  private async googleJson(
    method: "GET" | "PUT" | "POST",
    path: string,
    requiredMode: GoogleScriptAccessMode,
    body?: string,
  ): Promise<Record<string, unknown>> {
    const mode = (await this.googleStatus()).mode;
    if (!mode || !modeAllows(mode, requiredMode)) {
      throw new Error("Google Apps Script scope insufficient; reconnect with explicit permission");
    }
    const accessToken = await this.oauth.accessTokenForTrustedRequest(GOOGLE_CONNECTION_ID);
    const response = await this.fetcher(APP_SCRIPT_BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    const payload = await safeJsonResponse(response, MAX_RESPONSE_BYTES, "Google Apps Script");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Google Apps Script returned malformed JSON");
    }
    return payload as Record<string, unknown>;
  }
}

export function contentFingerprint(files: AppsScriptFile[]): string {
  const canonical = files.map(({ name, type, source }) => ({ name, type, source }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function scriptPath(scriptId: string): string {
  if (typeof scriptId !== "string" || !/^[A-Za-z0-9_-]{12,160}$/.test(scriptId)) {
    throw new Error("Invalid Apps Script project ID");
  }
  return "/" + encodeURIComponent(scriptId);
}

function validScriptFile(value: unknown): value is AppsScriptFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return typeof file.name === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(file.name) &&
    (file.type === "SERVER_JS" || file.type === "JSON" || file.type === "HTML") &&
    typeof file.source === "string" && Buffer.byteLength(file.source) <= MAX_RESPONSE_BYTES;
}
function boundedLabel(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max &&
    !/[\r\n\0]/.test(value);
}
function validGoogleClientId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{16,256}\.apps\.googleusercontent\.com$/.test(value);
}
function validMode(value: unknown): value is GoogleScriptAccessMode {
  return value === "read" || value === "edit" || value === "deploy";
}
function modeAllows(actual: GoogleScriptAccessMode, requested: GoogleScriptAccessMode): boolean {
  return requested === "read" || actual === "deploy" || (actual === "edit" && requested === "edit");
}
function scopesForMode(mode: GoogleScriptAccessMode): string[] {
  return [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    mode === "read" ? READ_SCOPE : EDIT_SCOPE,
    mode === "deploy" ? DEPLOY_SCOPE : DEPLOY_READ_SCOPE,
  ];
}
function validateAppSheetTarget(appId: string, region: string): void {
  if (typeof appId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(appId)) {
    throw new Error("Invalid AppSheet app ID");
  }
  if (!(REGIONS as readonly string[]).includes(region)) {
    throw new Error("AppSheet region must be a supported official endpoint");
  }
}
function appSheetKeyName(appId: string, region: string): string {
  return `google-workspace:appsheet:${region}:${appId}:key`;
}
async function safeJsonResponse(response: Response, limit: number, service: string): Promise<unknown> {
  const size = response.headers.get("content-length");
  if (size && Number(size) > limit) throw new Error(`${service} response exceeds size limit`);
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${service} response exceeds size limit`);
      }
      chunks.push(value);
    }
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${service} returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) {
    // Do not reflect provider error messages; they might include user data.
    throw new Error(`${service} request failed (HTTP ${response.status})`);
  }
  return value;
}

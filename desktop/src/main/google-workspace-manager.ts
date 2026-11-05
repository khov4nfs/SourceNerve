import { createHash } from "node:crypto";

import type { EncryptedSecretStore } from "./secure-store";
import { McpExtensionOAuthManager } from "./mcp-extension-oauth";
import type { McpExtensionClient } from "./mcp-extension-client";
import { parseAppsScriptReference } from "../shared/apps-script-reference";

const GOOGLE_CONNECTION_ID = "google-workspace";
const CLIENT_ID_KEY = "google-workspace:client-id";
const CLIENT_SECRET_KEY = "google-workspace:oauth-client-secret";
const ACCESS_MODE_KEY = "google-workspace:access-mode";
const DISCOVERY_KEY = "google-workspace:project-discovery-enabled";
const DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const SCRIPT_MIME_TYPE = "application/vnd.google-apps.script";
const CONTAINER_MIME_TYPES = {
  "application/vnd.google-apps.spreadsheet": "sheet",
  "application/vnd.google-apps.document": "doc",
  "application/vnd.google-apps.presentation": "slide",
  "application/vnd.google-apps.form": "form",
} as const;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
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
  projectDiscoveryEnabled: boolean;
  expiresAt?: number;
}
export interface AppSheetAppStatus {
  appId: string;
  region: string;
  configured: boolean;
}
export interface AppsScriptProjectListInput {
  pageSize?: number;
  pageToken?: string;
}
export interface AppsScriptProjectSummary {
  scriptId: string;
  name: string;
  modifiedTime: string | null;
  editorUrl: string;
}
export interface AppsScriptProjectList {
  projects: AppsScriptProjectSummary[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
}
/** Drive can discover containers, not their invisible bound Apps Script IDs. */
export interface AppsScriptContainerListInput extends AppsScriptProjectListInput {
  query?: string;
}
export interface AppsScriptContainerSummary {
  containerId: string;
  name: string;
  kind: "sheet" | "doc" | "slide" | "form";
  modifiedTime: string | null;
  editorUrl: string;
}
export interface AppsScriptContainerList {
  containers: AppsScriptContainerSummary[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
  scriptsEnumerated: false;
}
export interface AppsScriptBoundCheck {
  scriptId: string;
  containerId: string;
  scriptTitle: string | null;
  editorUrl: string;
  match: "verified" | "mismatch" | "unconfirmed";
}
/** Metadata-only identity lookup for a user-supplied project ID or Editor URL. */
export interface AppsScriptResolvedReference {
  scriptId: string;
  scriptTitle: string | null;
  modifiedTime: string | null;
  editorUrl: string;
  containerId: string | null;
  /** Null means no container was selected; unconfirmed means Google omitted parentId. */
  match: "verified" | "mismatch" | "unconfirmed" | null;
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
export type AppsScriptEditOperation = "replace_exact" | "prepend" | "append";
export interface AppsScriptTextEdit {
  fileName: string;
  operation: AppsScriptEditOperation;
  findText?: string;
  text: string;
}
export interface AppsScriptPatchPreviewInput {
  scriptId: string;
  edits: AppsScriptTextEdit[];
}
export interface AppsScriptPatchPreview {
  scriptId: string;
  expectedFingerprint: string;
  expectedPatchedFingerprint: string;
  planFingerprint: string;
  editCount: number;
  changedFiles: string[];
  fileCount: number;
  manifestPreserved: true;
  wouldChange: boolean;
}
export interface AppsScriptPatchApplyInput extends AppsScriptPatchPreviewInput {
  expectedFingerprint: string;
  expectedPatchedFingerprint: string;
  planFingerprint: string;
  confirmed: true;
}
export interface AppsScriptPatchApplyResult {
  scriptId: string;
  previousFingerprint: string;
  newFingerprint: string;
  changedFiles: string[];
  changed: boolean;
  verified: true;
}
export interface AppsScriptCommentPatchInput {
  scriptId: string;
  commentLine: string;
  fileName?: string;
}
export interface AppsScriptCommentPreview {
  scriptId: string;
  fileName: string;
  commentLine: string;
  expectedFingerprint: string;
  position: "file-start";
  wouldChange: boolean;
  fileCount: number;
  manifestPreserved: true;
}
export interface AppsScriptCommentApplyInput extends AppsScriptCommentPatchInput {
  expectedFingerprint: string;
  confirmed: true;
}
export interface AppsScriptCommentApplyResult {
  scriptId: string;
  fileName: string;
  previousFingerprint: string;
  newFingerprint: string;
  changed: boolean;
  verified: true;
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
    discoveryEnabled?: boolean,
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
    const oldDiscoveryEnabled = (await this.store.getOpaque(DISCOVERY_KEY)) === "true";
    const discovery = discoveryEnabled ?? oldDiscoveryEnabled;
    const credentialChanged = oldClientId !== clientId || oldMode !== mode ||
      oldDiscoveryEnabled !== discovery ||
      (clientSecret !== undefined && oldSecret !== clientSecret);
    if (credentialChanged) {
      // Google native apps require fresh consent when scope modes change.
      // Never reuse an earlier token after changing client ID/secret/scopes.
      await this.oauth.remove(GOOGLE_CONNECTION_ID);
      // The shared OAuth cleanup uses best-effort deletes. Never enable a new
      // Google scope if a store failure left an old access/refresh token behind.
      const [staleAccess, staleRefresh] = await Promise.all([
        this.store.getOpaque("mcp-extension:google-workspace:credential"),
        this.store.getOpaque("mcp-extension:google-workspace:oauth-refresh"),
      ]);
      if (staleAccess || staleRefresh) {
        throw new Error("Could not clear previous Google OAuth tokens; reconnect is blocked");
      }
      await this.store.setOpaque(CLIENT_ID_KEY, clientId);
      await this.store.setOpaque(ACCESS_MODE_KEY, mode);
      await this.store.setOpaque(DISCOVERY_KEY, String(discovery));
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
      scopes: scopesForMode(mode, discovery),
    });
    return this.googleStatus();
  }

  async googleStatus(): Promise<GoogleWorkspaceStatus> {
    const [savedId, savedMode, discoveryEnabled, status] = await Promise.all([
      this.store.getOpaque(CLIENT_ID_KEY),
      this.store.getOpaque(ACCESS_MODE_KEY),
      this.store.getOpaque(DISCOVERY_KEY),
      this.oauth.status(GOOGLE_CONNECTION_ID),
    ]);
    const mode = validMode(savedMode) ? savedMode : null;
    return {
      configured: Boolean(savedId && status.configured && mode),
      connected: Boolean(savedId && status.connected && mode),
      mode,
      projectDiscoveryEnabled: discoveryEnabled === "true",
      ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}),
    };
  }

  /**
   * Explicit opt-in to Drive metadata. Native Google OAuth cannot incrementally
   * add a scope to an existing consent, so invalidate the previous token and
   * require the user to complete the loopback OAuth flow again.
   */
  async enableProjectDiscovery(): Promise<GoogleWorkspaceStatus> {
    const [clientId, mode, alreadyEnabled] = await Promise.all([
      this.store.getOpaque(CLIENT_ID_KEY),
      this.store.getOpaque(ACCESS_MODE_KEY),
      this.store.getOpaque(DISCOVERY_KEY),
    ]);
    if (!clientId || !validMode(mode)) {
      throw new Error("Configure Google OAuth before enabling Apps Script discovery");
    }
    if (alreadyEnabled === "true") return this.googleStatus();
    return this.configureGoogle(clientId, mode, undefined, true);
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

  /**
   * Drive metadata only: list standalone Apps Script files accessible to the
   * connected Google account. Bound projects are not files in Drive.
   * Never request content, owner identities, permissions or download URLs.
   */
  async listAppsScriptProjects(input: AppsScriptProjectListInput = {}): Promise<AppsScriptProjectList> {
    const { pageSize = DEFAULT_PAGE_SIZE, pageToken } = input;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new Error("Apps Script pageSize must be an integer from 1 to 100");
    }
    if (pageToken !== undefined && !validPageToken(pageToken)) {
      throw new Error("Invalid Apps Script pagination token");
    }
    const status = await this.googleStatus();
    if (!status.projectDiscoveryEnabled) {
      throw new Error("Google Drive metadata access is not enabled; enable project discovery and authorize again");
    }
    const token = await this.oauth.accessTokenForTrustedRequest(GOOGLE_CONNECTION_ID);
    const url = new URL(DRIVE_FILES_URL);
    url.searchParams.set("q", `mimeType = '${SCRIPT_MIME_TYPE}' and trashed = false`);
    url.searchParams.set("fields", "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)");
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("corpora", "user");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await this.fetcher(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await safeJsonResponse(response, MAX_RESPONSE_BYTES, "Google Drive");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Google Drive returned malformed project list");
    }
    const data = payload as Record<string, unknown>;
    if (!Array.isArray(data.files) || data.files.length > pageSize || !data.files.every(validDriveScript)) {
      throw new Error("Google Drive returned invalid Apps Script metadata");
    }
    if (data.nextPageToken !== undefined && !validPageToken(data.nextPageToken)) {
      throw new Error("Google Drive returned an invalid next-page token");
    }
    return {
      projects: data.files.map((entry: DriveScriptMetadata): AppsScriptProjectSummary => ({
        scriptId: entry.id,
        name: entry.name,
        modifiedTime: entry.modifiedTime ?? null,
        editorUrl: `https://script.google.com/d/${encodeURIComponent(entry.id)}/edit`,
      })),
      nextPageToken: data.nextPageToken ?? null,
      incompleteSearch: data.incompleteSearch === true,
    };
  }

  /**
   * Enumerate possible parent Sheets/Docs/Slides/Forms from Drive metadata. This DOES NOT
   * imply a document contains a bound script: Google does not expose a
   * reverse listing of container-bound script IDs. No content is fetched.
   */
  async listAppsScriptContainers(input: AppsScriptContainerListInput = {}): Promise<AppsScriptContainerList> {
    const { pageSize = DEFAULT_PAGE_SIZE, pageToken, query } = input;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new Error("Apps Script pageSize must be an integer from 1 to 100");
    }
    if (pageToken !== undefined && !validPageToken(pageToken)) {
      throw new Error("Invalid Apps Script pagination token");
    }
    if (query !== undefined && (!boundedLabel(query, 1, 128) || !query.trim())) {
      throw new Error("Invalid container search query");
    }
    if (!(await this.googleStatus()).projectDiscoveryEnabled) {
      throw new Error("Google Drive metadata access is not enabled; enable project discovery and authorize again");
    }
    const token = await this.oauth.accessTokenForTrustedRequest(GOOGLE_CONNECTION_ID);
    const url = new URL(DRIVE_FILES_URL);
    const parts = Object.keys(CONTAINER_MIME_TYPES).map((mime) => `mimeType = '${mime}'`);
    const nameClause = query
      ? ` and name contains '${query.trim().replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
      : "";
    url.searchParams.set("q", `(${parts.join(" or ")}) and trashed = false${nameClause}`);
    url.searchParams.set("fields", "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)");
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("corpora", "user");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await this.fetcher(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = await safeJsonResponse(response, MAX_RESPONSE_BYTES, "Google Drive");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Google Drive returned malformed container list");
    }
    const data = payload as Record<string, unknown>;
    if (!Array.isArray(data.files) || data.files.length > pageSize || !data.files.every(validDriveContainer)) {
      throw new Error("Google Drive returned invalid container metadata");
    }
    if (data.nextPageToken !== undefined && !validPageToken(data.nextPageToken)) {
      throw new Error("Google Drive returned an invalid next-page token");
    }
    return {
      containers: (data.files as DriveContainerMetadata[]).map((file) => ({
        containerId: file.id,
        name: file.name,
        kind: CONTAINER_MIME_TYPES[file.mimeType],
        modifiedTime: file.modifiedTime ?? null,
        editorUrl: containerEditorUrl(file.mimeType, file.id),
      })),
      nextPageToken: data.nextPageToken ?? null,
      incompleteSearch: data.incompleteSearch === true,
      scriptsEnumerated: false,
    };
  }

  /**
   * Read Apps Script metadata for a real user-provided project ID or Editor URL.
   * Never request the pasted URL: only an allowlisted ID is sent to the fixed
   * https://script.googleapis.com/v1/projects/{scriptId} endpoint.
   */
  async resolveAppsScriptReference(
    reference: string, containerId?: string,
  ): Promise<AppsScriptResolvedReference> {
    const scriptId = parseAppsScriptReference(reference);
    if (!scriptId) throw new Error("Invalid Apps Script ID or Editor URL");
    if (containerId !== undefined && !validDriveId(containerId)) {
      throw new Error("Invalid Google Workspace container ID");
    }
    const project = await this.getAppsScriptProject(scriptId);
    if (project.scriptId !== scriptId) throw new Error("Apps Script returned a different project ID");
    const parent = project.parentId;
    return {
      scriptId,
      scriptTitle: safeProjectTitle(project.title),
      modifiedTime: safeProjectTime(project.updateTime),
      editorUrl: `https://script.google.com/d/${encodeURIComponent(scriptId)}/edit`,
      containerId: containerId ?? null,
      match: containerId === undefined ? null : parent === containerId ? "verified" :
        (typeof parent === "string" && validDriveId(parent) ? "mismatch" : "unconfirmed"),
    };
  }

  /** Known Script IDs can be checked directly without exposing other parent IDs. */
  async checkBoundAppsScript(scriptId: string, containerId: string): Promise<AppsScriptBoundCheck> {
    scriptPath(scriptId);
    const resolved = await this.resolveAppsScriptReference(scriptId, containerId);
    return {
      scriptId: resolved.scriptId,
      containerId,
      scriptTitle: resolved.scriptTitle,
      editorUrl: resolved.editorUrl,
      match: resolved.match as "verified" | "mismatch" | "unconfirmed",
    };
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

  /**
   * Generic bounded text patches: the caller sends only exact small edits.
   * Source and manifest remain inside Desktop Main; preview discloses only
   * fingerprints and filenames. Multiple edits are applied in caller order
   * and committed in one guarded write, not as repeated patch approvals.
   */
  async previewAppsScriptPatch(input: AppsScriptPatchPreviewInput): Promise<AppsScriptPatchPreview> {
    scriptPath(input.scriptId);
    validateAppsScriptEdits(input.edits);
    const current = await this.getAppsScriptContent(input.scriptId);
    const planned = buildAppsScriptPatch(current.files, input.edits);
    const expectedPatchedFingerprint = contentFingerprint(planned.files);
    return {
      scriptId: input.scriptId,
      expectedFingerprint: current.fingerprint,
      expectedPatchedFingerprint,
      planFingerprint: patchPlanFingerprint(input.scriptId, current.fingerprint, input.edits),
      editCount: input.edits.length,
      changedFiles: planned.changedFiles,
      fileCount: current.files.length,
      manifestPreserved: true,
      wouldChange: current.fingerprint !== expectedPatchedFingerprint,
    };
  }

  /**
   * One-shot apply for an entire reviewed edit set. No whole-file payload
   * crosses MCP or the renderer. Error/timeout after PUT is never retried
   * automatically; verification is read-only and errors are non-success.
   */
  async applyAppsScriptPatch(input: AppsScriptPatchApplyInput): Promise<AppsScriptPatchApplyResult> {
    scriptPath(input.scriptId);
    validateAppsScriptEdits(input.edits);
    if (input.confirmed !== true || !/^[0-9a-f]{64}$/.test(input.expectedFingerprint) ||
        !/^[0-9a-f]{64}$/.test(input.expectedPatchedFingerprint) ||
        !/^[0-9a-f]{64}$/.test(input.planFingerprint)) {
      throw new Error("Apps Script patch requires explicit confirmation and reviewed fingerprints");
    }
    if (patchPlanFingerprint(input.scriptId, input.expectedFingerprint, input.edits) !== input.planFingerprint) {
      throw new Error("Apps Script patch differs from reviewed edit plan");
    }
    const mode = (await this.googleStatus()).mode;
    if (!mode || !modeAllows(mode, "edit")) {
      throw new Error("Google Apps Script scope insufficient; reconnect with explicit permission");
    }
    const current = await this.getAppsScriptContent(input.scriptId);
    if (current.fingerprint !== input.expectedFingerprint) {
      throw new Error("Apps Script remote content changed; re-preview your patch before writing");
    }
    const planned = buildAppsScriptPatch(current.files, input.edits);
    if (contentFingerprint(planned.files) !== input.expectedPatchedFingerprint) {
      throw new Error("Apps Script planned content differs from reviewed fingerprint");
    }
    if (planned.changedFiles.length === 0) {
      return {
        scriptId: input.scriptId, previousFingerprint: current.fingerprint,
        newFingerprint: current.fingerprint, changedFiles: [],
        changed: false, verified: true,
      };
    }
    const updated = await this.updateAppsScriptContent({
      scriptId: input.scriptId,
      files: planned.files,
      expectedFingerprint: current.fingerprint,
      confirmed: true,
    });
    if (updated.fingerprint !== input.expectedPatchedFingerprint) {
      throw new Error("Apps Script PUT result differs from reviewed patch; re-preview before retrying");
    }
    let verified: AppsScriptContent;
    try { verified = await this.getAppsScriptContent(input.scriptId); }
    catch {
      throw new Error("Apps Script patch may have been applied but verification failed; re-preview before retrying");
    }
    if (verified.fingerprint !== input.expectedPatchedFingerprint) {
      throw new Error("Apps Script post-write verification mismatch; inspect before retrying");
    }
    return {
      scriptId: input.scriptId,
      previousFingerprint: current.fingerprint,
      newFingerprint: verified.fingerprint,
      changedFiles: planned.changedFiles,
      changed: true,
      verified: true,
    };
  }

  /**
   * Preview is metadata-only from the caller's perspective. Read entire source
   * only in the Desktop Main process, then return a small hash and exact intent.
   * No source file contents are returned through the public MCP bridge.
   */
  async previewAppsScriptComment(input: AppsScriptCommentPatchInput): Promise<AppsScriptCommentPreview> {
    validateScriptCommentPatch(input);
    const current = await this.getAppsScriptContent(input.scriptId);
    assertScriptManifest(current.files);
    const file = selectCommentFile(current.files, input.fileName);
    return {
      scriptId: input.scriptId,
      fileName: file.name,
      commentLine: input.commentLine,
      expectedFingerprint: current.fingerprint,
      position: "file-start",
      wouldChange: !startsWithScriptComment(file.source, input.commentLine),
      fileCount: current.files.length,
      manifestPreserved: true,
    };
  }

  /**
   * Intentionally narrow edit operation. The caller supplies only a one-line
   * JavaScript comment + expected HEAD fingerprint; the original project files
   * never travel through ChatGPT, an MCP tool request or the renderer.
   *
   * Google updateContent replaces all HEAD files. Reuse the existing guarded
   * full-content updater inside Main, then re-read once to verify the result.
   * Never automatically retry an ambiguous PUT / timeout.
   */
  async applyAppsScriptComment(input: AppsScriptCommentApplyInput): Promise<AppsScriptCommentApplyResult> {
    validateScriptCommentPatch(input);
    if (input.confirmed !== true || !/^[0-9a-f]{64}$/.test(input.expectedFingerprint)) {
      throw new Error("Apps Script comment requires an explicit confirmation and preview fingerprint");
    }
    const mode = (await this.googleStatus()).mode;
    if (!mode || !modeAllows(mode, "edit")) {
      throw new Error("Google Apps Script scope insufficient; reconnect with explicit permission");
    }
    const current = await this.getAppsScriptContent(input.scriptId);
    if (current.fingerprint !== input.expectedFingerprint) {
      throw new Error("Apps Script remote content changed; preview the comment again before writing");
    }
    assertScriptManifest(current.files);
    const file = selectCommentFile(current.files, input.fileName);
    if (startsWithScriptComment(file.source, input.commentLine)) {
      return {
        scriptId: input.scriptId,
        fileName: file.name,
        previousFingerprint: current.fingerprint,
        newFingerprint: current.fingerprint,
        changed: false,
        verified: true,
      };
    }
    const separator = file.source.includes("\r\n") ? "\r\n" : "\n";
    const files = current.files.map((entry): AppsScriptFile => (
      entry === file ? { ...entry, source: input.commentLine + separator + entry.source } : entry
    ));
    const expectedNextFingerprint = contentFingerprint(files);
    const updated = await this.updateAppsScriptContent({
      scriptId: input.scriptId,
      files,
      expectedFingerprint: input.expectedFingerprint,
      confirmed: true,
    });
    if (updated.fingerprint !== expectedNextFingerprint) {
      throw new Error("Apps Script update response differed from the planned comment; re-preview before retrying");
    }
    let verified: AppsScriptContent;
    try {
      verified = await this.getAppsScriptContent(input.scriptId);
    } catch {
      throw new Error("Apps Script write may have succeeded but verification failed; re-preview before retrying");
    }
    if (verified.fingerprint !== expectedNextFingerprint) {
      throw new Error("Apps Script post-write content differs from the planned comment; inspect before retrying");
    }
    return {
      scriptId: input.scriptId,
      fileName: file.name,
      previousFingerprint: input.expectedFingerprint,
      newFingerprint: expectedNextFingerprint,
      changed: true,
      verified: true,
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

/**
 * Validate and apply small, ordered, exact text edits against a local HEAD
 * snapshot. No arbitrary code execution or provider request occurs here.
 * JSON files must remain valid JSON, including the project manifest.
 */
export function validateAppsScriptEdits(edits: AppsScriptTextEdit[]): void {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 16) {
    throw new Error("Apps Script patch requires 1–16 bounded text edits");
  }
  let combinedBytes = 0;
  for (const edit of edits) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit) ||
        Object.keys(edit).some((key) => !["fileName", "operation", "findText", "text"].includes(key)) ||
        !validScriptFileName(edit.fileName) ||
        !["replace_exact", "prepend", "append"].includes(edit.operation) ||
        typeof edit.text !== "string" || (edit.operation !== "replace_exact" && edit.text.length < 1) ||
        Buffer.byteLength(edit.text) > 8192 ||
        /\0/.test(edit.text)) {
      throw new Error("Invalid Apps Script text edit");
    }
    if (edit.operation === "replace_exact") {
      if (typeof edit.findText !== "string" || edit.findText.length < 1 ||
          Buffer.byteLength(edit.findText) > 16384 || edit.findText.includes("\0")) {
        throw new Error("replace_exact requires a bounded nonempty findText");
      }
    } else if (edit.findText !== undefined) {
      throw new Error("findText is only allowed for replace_exact");
    }
    combinedBytes += Buffer.byteLength(edit.text) +
      (edit.findText === undefined ? 0 : Buffer.byteLength(edit.findText));
  }
  if (combinedBytes > 64 * 1024) {
    throw new Error("Apps Script patch payload exceeds 64 KiB");
  }
}
function validScriptFileName(name: unknown): name is string {
  return typeof name === "string" && name.length >= 1 && name.length <= 128 &&
    name !== "." && name !== ".." && !/[\/\\\r\n\0]/.test(name);
}
function patchPlanFingerprint(scriptId: string, fingerprint: string, edits: AppsScriptTextEdit[]): string {
  return createHash("sha256").update(JSON.stringify({ scriptId, fingerprint, edits })).digest("hex");
}
function buildAppsScriptPatch(
  files: AppsScriptFile[], edits: AppsScriptTextEdit[],
): { files: AppsScriptFile[]; changedFiles: string[] } {
  assertScriptManifest(files);
  const next = files.map((file) => ({ ...file }));
  if (new Set(next.map((file) => file.name)).size !== next.length) {
    throw new Error("Apps Script file names are ambiguous; refusing patch");
  }
  for (const edit of edits) {
    const file = next.find((entry) => entry.name === edit.fileName);
    if (!file) throw new Error("Apps Script patch file not found in HEAD");
    const before = file.source;
    if (edit.operation === "replace_exact") {
      const needle = edit.findText!;
      const first = before.indexOf(needle);
      if (first < 0 || before.indexOf(needle, first + 1) >= 0) {
        throw new Error("Exact patch text must occur exactly once; re-preview with a unique context");
      }
      file.source = before.slice(0, first) + edit.text + before.slice(first + needle.length);
    } else if (edit.operation === "prepend") {
      file.source = before.startsWith(edit.text) ? before : edit.text + before;
    } else {
      file.source = before.endsWith(edit.text) ? before : before + edit.text;
    }
    if (Buffer.byteLength(file.source) > MAX_RESPONSE_BYTES) {
      throw new Error("Apps Script patched file exceeds size limit");
    }
    if (file.type === "JSON") {
      try { JSON.parse(file.source); }
      catch { throw new Error("Apps Script JSON file must remain valid after patch"); }
    }
  }
  if (Buffer.byteLength(JSON.stringify({ files: next })) > MAX_RESPONSE_BYTES) {
    throw new Error("Apps Script patched project exceeds size limit");
  }
  const changedFiles = next.filter((file, index) => file.source !== files[index].source)
    .map((file) => file.name);
  return { files: next, changedFiles };
}
function validateScriptCommentPatch(input: AppsScriptCommentPatchInput): void {
  scriptPath(input.scriptId);
  if (typeof input.commentLine !== "string" || input.commentLine.length < 4 ||
      input.commentLine.length > 200 || Buffer.byteLength(input.commentLine, "utf8") > 512 ||
      !input.commentLine.startsWith("// ") || /[\r\n\0\u2028\u2029]/.test(input.commentLine)) {
    throw new Error("Comment must be a single JavaScript // line, at most 200 characters");
  }
  if (input.fileName !== undefined && (typeof input.fileName !== "string" ||
      input.fileName.length < 1 || input.fileName.length > 128 ||
      input.fileName === "." || input.fileName === ".." ||
      /[\r\n\0/\\]/.test(input.fileName))) {
    throw new Error("Invalid Apps Script source filename");
  }
}
function assertScriptManifest(files: AppsScriptFile[]): void {
  if (!files.some((file) => file.name === "appsscript" && file.type === "JSON")) {
    throw new Error("Apps Script manifest is missing; refusing a comment patch");
  }
}
function selectCommentFile(files: AppsScriptFile[], fileName?: string): AppsScriptFile {
  const targets = files.filter((file) => file.type === "SERVER_JS" &&
    (fileName === undefined || file.name === fileName));
  if (targets.length !== 1) {
    throw new Error("Select exactly one Apps Script SERVER_JS filename for the comment");
  }
  return targets[0];
}
function startsWithScriptComment(source: string, comment: string): boolean {
  return source === comment || source.startsWith(comment + "\n") ||
    source.startsWith(comment + "\r\n");
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

function containerEditorUrl(mime: keyof typeof CONTAINER_MIME_TYPES, id: string): string {
  const path = mime === "application/vnd.google-apps.spreadsheet" ? "spreadsheets" :
    mime === "application/vnd.google-apps.document" ? "document" :
    mime === "application/vnd.google-apps.presentation" ? "presentation" : "forms";
  return `https://docs.google.com/${path}/d/${encodeURIComponent(id)}/edit`;
}
function safeProjectTitle(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\r\n\0]/.test(value) ? value : null;
}
function safeProjectTime(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64 &&
    !Number.isNaN(Date.parse(value)) ? value : null;
}
interface DriveScriptMetadata {
  id: string;
  name: string;
  mimeType: typeof SCRIPT_MIME_TYPE;
  modifiedTime?: string;
}
interface DriveContainerMetadata {
  id: string;
  name: string;
  mimeType: keyof typeof CONTAINER_MIME_TYPES;
  modifiedTime?: string;
}
function validDriveId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{12,160}$/.test(value);
}
function validDriveContainer(value: unknown): value is DriveContainerMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return validDriveId(file.id) &&
    typeof file.name === "string" && file.name.length > 0 && file.name.length <= 512 &&
    typeof file.mimeType === "string" &&
    Object.prototype.hasOwnProperty.call(CONTAINER_MIME_TYPES, file.mimeType) &&
    (file.modifiedTime === undefined || (typeof file.modifiedTime === "string" &&
      !Number.isNaN(Date.parse(file.modifiedTime)) && file.modifiedTime.length <= 64));
}
function validPageToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !/[\r\n\0]/.test(value);
}
function validDriveScript(value: unknown): value is DriveScriptMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return typeof file.id === "string" && /^[A-Za-z0-9_-]{12,160}$/.test(file.id) &&
    typeof file.name === "string" && file.name.length > 0 && file.name.length <= 512 &&
    file.mimeType === SCRIPT_MIME_TYPE &&
    (file.modifiedTime === undefined || (typeof file.modifiedTime === "string" &&
      !Number.isNaN(Date.parse(file.modifiedTime)) && file.modifiedTime.length <= 64));
}
function validScriptFile(value: unknown): value is AppsScriptFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return typeof file.name === "string" && file.name.length >= 1 && file.name.length <= 128 &&
    file.name !== "." && file.name !== ".." && !file.name.includes("/") &&
    !file.name.includes("\\") && !/[\r\n\0]/.test(file.name) &&
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
function scopesForMode(mode: GoogleScriptAccessMode, projectDiscoveryEnabled: boolean): string[] {
  return [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    mode === "read" ? READ_SCOPE : EDIT_SCOPE,
    mode === "deploy" ? DEPLOY_SCOPE : DEPLOY_READ_SCOPE,
    ...(projectDiscoveryEnabled ? [DRIVE_METADATA_SCOPE] : []),
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

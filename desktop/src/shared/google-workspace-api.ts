import type { DesktopResult } from "./desktop-api";

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
export interface AppsScriptResolvedReference {
  scriptId: string;
  scriptTitle: string | null;
  modifiedTime: string | null;
  editorUrl: string;
  containerId: string | null;
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
  fileName: string;
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
export interface GoogleWorkspaceApi {
  status(): Promise<DesktopResult<GoogleWorkspaceStatus>>;
  configure(clientId: string, mode: GoogleScriptAccessMode, clientSecret?: string): Promise<DesktopResult<GoogleWorkspaceStatus>>;
  connect(): Promise<DesktopResult<GoogleWorkspaceStatus>>;
  disconnect(): Promise<DesktopResult<GoogleWorkspaceStatus>>;
  enableProjectDiscovery(): Promise<DesktopResult<GoogleWorkspaceStatus>>;
  listProjects(input?: AppsScriptProjectListInput): Promise<DesktopResult<AppsScriptProjectList>>;
  listContainers(input?: AppsScriptContainerListInput): Promise<DesktopResult<AppsScriptContainerList>>;
  resolveScriptReference(reference: string, containerId?: string): Promise<DesktopResult<AppsScriptResolvedReference>>;
  checkBoundScript(scriptId: string, containerId: string): Promise<DesktopResult<AppsScriptBoundCheck>>;
  scriptProject(scriptId: string): Promise<DesktopResult<Record<string, unknown>>>;
  scriptContent(scriptId: string): Promise<DesktopResult<AppsScriptContent>>;
  updateScript(input: AppsScriptUpdateInput): Promise<DesktopResult<AppsScriptContent>>;
  previewScriptPatch(input: AppsScriptPatchPreviewInput): Promise<DesktopResult<AppsScriptPatchPreview>>;
  applyScriptPatch(input: AppsScriptPatchApplyInput): Promise<DesktopResult<AppsScriptPatchApplyResult>>;
  previewScriptComment(input: AppsScriptCommentPatchInput): Promise<DesktopResult<AppsScriptCommentPreview>>;
  applyScriptComment(input: AppsScriptCommentApplyInput): Promise<DesktopResult<AppsScriptCommentApplyResult>>;
  createVersion(scriptId: string, description: string, confirmed: true): Promise<DesktopResult<Record<string, unknown>>>;
  createDeployment(scriptId: string, versionNumber: number, description: string, confirmed: true): Promise<DesktopResult<Record<string, unknown>>>;
  appSheetKeyStatus(appId: string, region: string): Promise<DesktopResult<AppSheetAppStatus>>;
  appSheetSetKey(input: AppSheetKeyInput): Promise<DesktopResult<AppSheetAppStatus>>;
  appSheetClearKey(appId: string, region: string): Promise<DesktopResult<AppSheetAppStatus>>;
  appSheetFind(appId: string, region: string, table: string): Promise<DesktopResult<unknown>>;
}
export const GOOGLE_WORKSPACE_IPC = {
  status: "desktop:google-workspace-status",
  configure: "desktop:google-workspace-configure",
  connect: "desktop:google-workspace-connect",
  disconnect: "desktop:google-workspace-disconnect",
  enableProjectDiscovery: "desktop:google-workspace-enable-discovery",
  listProjects: "desktop:google-workspace-list-projects",
  listContainers: "desktop:google-workspace-list-containers",
  resolveScriptReference: "desktop:google-workspace-resolve-script-reference",
  checkBoundScript: "desktop:google-workspace-check-bound-script",
  scriptProject: "desktop:google-workspace-script-project",
  scriptContent: "desktop:google-workspace-script-content",
  updateScript: "desktop:google-workspace-script-update",
  previewScriptPatch: "desktop:google-workspace-patch-preview",
  applyScriptPatch: "desktop:google-workspace-patch-apply",
  previewScriptComment: "desktop:google-workspace-comment-preview",
  applyScriptComment: "desktop:google-workspace-comment-apply",
  createVersion: "desktop:google-workspace-script-version",
  createDeployment: "desktop:google-workspace-script-deployment",
  appSheetKeyStatus: "desktop:google-workspace-appsheet-status",
  appSheetSetKey: "desktop:google-workspace-appsheet-set-key",
  appSheetClearKey: "desktop:google-workspace-appsheet-clear-key",
  appSheetFind: "desktop:google-workspace-appsheet-find",
} as const;

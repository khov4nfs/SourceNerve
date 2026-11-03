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
export interface GoogleWorkspaceApi {
  status(): Promise<DesktopResult<GoogleWorkspaceStatus>>;
  configure(clientId: string, mode: GoogleScriptAccessMode, clientSecret?: string): Promise<DesktopResult<GoogleWorkspaceStatus>>;
  connect(): Promise<DesktopResult<GoogleWorkspaceStatus>>;
  disconnect(): Promise<DesktopResult<GoogleWorkspaceStatus>>;
  enableProjectDiscovery(): Promise<DesktopResult<GoogleWorkspaceStatus>>;
  listProjects(input?: AppsScriptProjectListInput): Promise<DesktopResult<AppsScriptProjectList>>;
  scriptProject(scriptId: string): Promise<DesktopResult<Record<string, unknown>>>;
  scriptContent(scriptId: string): Promise<DesktopResult<AppsScriptContent>>;
  updateScript(input: AppsScriptUpdateInput): Promise<DesktopResult<AppsScriptContent>>;
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
  scriptProject: "desktop:google-workspace-script-project",
  scriptContent: "desktop:google-workspace-script-content",
  updateScript: "desktop:google-workspace-script-update",
  createVersion: "desktop:google-workspace-script-version",
  createDeployment: "desktop:google-workspace-script-deployment",
  appSheetKeyStatus: "desktop:google-workspace-appsheet-status",
  appSheetSetKey: "desktop:google-workspace-appsheet-set-key",
  appSheetClearKey: "desktop:google-workspace-appsheet-clear-key",
  appSheetFind: "desktop:google-workspace-appsheet-find",
} as const;

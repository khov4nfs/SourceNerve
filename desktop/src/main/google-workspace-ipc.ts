import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import { GOOGLE_WORKSPACE_IPC, type AppsScriptUpdateInput, type AppSheetKeyInput, type GoogleScriptAccessMode } from "../shared/google-workspace-api";
import type { GoogleWorkspaceManager } from "./google-workspace-manager";

/**
 * Electron's trusted-renderer boundary is mandatory. These APIs are NOT
 * exposed through Public MCP. Workspace/Harness approval must be added before
 * agent-initiated Apps Script writes or AppSheet mutations can be routed here.
 */
export interface GoogleWorkspaceIpcContext {
  manager(): GoogleWorkspaceManager | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

export function installGoogleWorkspaceIpcHandlers(context: GoogleWorkspaceIpcContext): void {
  for (const channel of Object.values(GOOGLE_WORKSPACE_IPC)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      if (!context.isTrustedSender(event)) return fail("forbidden", "Untrusted Desktop IPC sender");
      if (!validateGoogleWorkspaceIpc(channel, args)) return fail("invalid_request", "Invalid Google Workspace request");
      const manager = context.manager();
      if (!manager) return fail("not_ready", "Google Workspace manager is not initialized");
      try {
        switch (channel) {
          case GOOGLE_WORKSPACE_IPC.status: return ok(await manager.googleStatus());
          case GOOGLE_WORKSPACE_IPC.configure: return ok(await manager.configureGoogle(args[0] as string, args[1] as GoogleScriptAccessMode, args[2] as string | undefined));
          case GOOGLE_WORKSPACE_IPC.connect: return ok(await manager.connectGoogle());
          case GOOGLE_WORKSPACE_IPC.disconnect: return ok(await manager.disconnectGoogle());
          case GOOGLE_WORKSPACE_IPC.scriptProject: return ok(await manager.getAppsScriptProject(args[0] as string));
          case GOOGLE_WORKSPACE_IPC.scriptContent: return ok(await manager.getAppsScriptContent(args[0] as string));
          case GOOGLE_WORKSPACE_IPC.updateScript: return ok(await manager.updateAppsScriptContent(args[0] as AppsScriptUpdateInput));
          case GOOGLE_WORKSPACE_IPC.createVersion: return ok(await manager.createAppsScriptVersion({
            scriptId: args[0] as string, description: args[1] as string, confirmed: true,
          }));
          case GOOGLE_WORKSPACE_IPC.createDeployment: return ok(await manager.createAppsScriptDeployment({
            scriptId: args[0] as string, versionNumber: args[1] as number,
            description: args[2] as string, confirmed: true,
          }));
          case GOOGLE_WORKSPACE_IPC.appSheetKeyStatus: return ok(await manager.appSheetStatus(args[0] as string, args[1] as string));
          case GOOGLE_WORKSPACE_IPC.appSheetSetKey: return ok(await manager.configureAppSheetKey(args[0] as AppSheetKeyInput));
          case GOOGLE_WORKSPACE_IPC.appSheetClearKey: return ok(await manager.clearAppSheetKey(args[0] as string, args[1] as string));
          case GOOGLE_WORKSPACE_IPC.appSheetFind: return ok(await manager.findAppSheetRows({
            appId: args[0] as string, region: args[1] as string, table: args[2] as string,
          }));
          default: return fail("invalid_request", "Unsupported Google Workspace IPC channel");
        }
      } catch (error) {
        // Do not reflect provider response bodies or access/refresh tokens.
        const message = error instanceof Error ? error.message : "Google Workspace operation failed";
        const safeMessage = sanitizeGoogleError(message);
        return fail("service_error", safeMessage);
      }
    });
  }
}

export function validateGoogleWorkspaceIpc(channel: string, args: readonly unknown[]): boolean {
  switch (channel) {
    case GOOGLE_WORKSPACE_IPC.status:
    case GOOGLE_WORKSPACE_IPC.connect:
    case GOOGLE_WORKSPACE_IPC.disconnect:
      return args.length === 0;
    case GOOGLE_WORKSPACE_IPC.configure:
      return (args.length === 2 || args.length === 3) && googleClientId(args[0]) &&
        ["read", "edit", "deploy"].includes(args[1] as string) &&
        (args.length === 2 || args[2] === undefined || bounded(args[2], 1, 1024));
    case GOOGLE_WORKSPACE_IPC.scriptProject:
    case GOOGLE_WORKSPACE_IPC.scriptContent:
      return args.length === 1 && scriptId(args[0]);
    case GOOGLE_WORKSPACE_IPC.updateScript: {
      const value = args[0];
      return args.length === 1 && record(value) && Object.keys(value).every((k) =>
        ["scriptId", "files", "expectedFingerprint", "confirmed"].includes(k)) &&
        scriptId(value.scriptId) && value.confirmed === true &&
        typeof value.expectedFingerprint === "string" && /^[0-9a-f]{64}$/.test(value.expectedFingerprint) &&
        Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 200 &&
        value.files.every((file: unknown) => record(file) &&
          Object.keys(file).every((k) => ["name", "source", "type"].includes(k)) &&
          bounded(file.name, 1, 128) && bounded(file.source, 0, 2 * 1024 * 1024) &&
          ["SERVER_JS", "HTML", "JSON"].includes(file.type as string));
    }
    case GOOGLE_WORKSPACE_IPC.createVersion:
      return args.length === 3 && scriptId(args[0]) && bounded(args[1], 0, 250) && args[2] === true;
    case GOOGLE_WORKSPACE_IPC.createDeployment:
      return args.length === 4 && scriptId(args[0]) && Number.isSafeInteger(args[1]) &&
        (args[1] as number) >= 1 && bounded(args[2], 0, 250) && args[3] === true;
    case GOOGLE_WORKSPACE_IPC.appSheetKeyStatus:
    case GOOGLE_WORKSPACE_IPC.appSheetClearKey:
      return args.length === 2 && appId(args[0]) && validRegion(args[1]);
    case GOOGLE_WORKSPACE_IPC.appSheetSetKey:
      return args.length === 1 && record(args[0]) && Object.keys(args[0]).every((k) =>
        ["appId", "region", "key"].includes(k)) &&
        appId(args[0].appId) && validRegion(args[0].region) &&
        bounded(args[0].key, 16, 1024);
    case GOOGLE_WORKSPACE_IPC.appSheetFind:
      return args.length === 3 && appId(args[0]) && validRegion(args[1]) && bounded(args[2], 1, 128);
    default:
      return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bounded(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max &&
    !/[\r\n\0]/.test(value);
}
function scriptId(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_-]{12,160}$/.test(value);
}
function appId(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}
function validRegion(value: unknown): boolean {
  return value === "www.appsheet.com" || value === "eu.appsheet.com" ||
    value === "asia-southeast.appsheet.com";
}
function googleClientId(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._-]{16,256}\.apps\.googleusercontent\.com$/.test(value);
}
function sanitizeGoogleError(message: string): string {
  // Allow safe bounded local validation errors. Never return unexpected
  // network/provider response texts that may contain credentials.
  if (message.length > 256 || /[\r\n\0]/.test(message) ||
      /\b(ya29\.|refresh_token|access_token|ApplicationAccessKey|Bearer\s)/i.test(message)) {
    return "Google Workspace request failed; check the Desktop logs for a redacted status";
  }
  return message;
}
function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}
function fail(code: DesktopError["code"], message: string): DesktopResult<never> {
  return { ok: false, error: { code, message, retryable: false } };
}

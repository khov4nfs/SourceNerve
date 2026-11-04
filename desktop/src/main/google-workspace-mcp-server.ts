import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { GoogleWorkspaceManager } from "./google-workspace-manager";
import type { McpExtensionClient } from "./mcp-extension-client";

const ID = "sourcenerve-google-workspace";
const NAMESPACE = "google-workspace";
const SOURCE = "builtin://sourcenerve/google-workspace";
const CREDENTIAL_REF = `mcp-extension:${ID}:credential`;
const PROTOCOL = "2025-06-18";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024 + 16 * 1024;

type ToolName =
  | "google_workspace_status"
  | "apps_script_list_projects"
  | "apps_script_get_project"
  | "apps_script_get_content"
  | "apps_script_update_content"
  | "apps_script_patch_preview"
  | "apps_script_patch_apply"
  | "apps_script_comment_preview"
  | "apps_script_comment_apply"
  | "apps_script_create_version"
  | "apps_script_create_deployment"
  | "appsheet_key_status"
  | "appsheet_find_rows";
interface Definition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  approval: "automatic" | "ask";
}
const SCRIPT_ID = { type: "string", minLength: 12, maxLength: 160, pattern: "^[A-Za-z0-9_-]+$" };
const APP_ID = { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" };
const REGION = { type: "string", enum: ["www.appsheet.com", "eu.appsheet.com", "asia-southeast.appsheet.com"] };
const SCRIPT_PATCH_EDITS = {
  type: "array", minItems: 1, maxItems: 16,
  items: {
    type: "object", additionalProperties: false,
    properties: {
      fileName: { type: "string", minLength: 1, maxLength: 128 },
      operation: { type: "string", enum: ["replace_exact", "prepend", "append"] },
      findText: { type: "string", minLength: 1, maxLength: 16384 },
      text: { type: "string", minLength: 1, maxLength: 8192 },
    },
    required: ["fileName", "operation", "text"],
  },
};
const TOOL_DEFINITIONS: Definition[] = [
  definition("google_workspace_status", "Read Google OAuth status and scope mode, never return tokens", {}, [], false),
  definition("apps_script_list_projects", "List standalone Apps Script project names, IDs, modified times and Editor links using read-only Google Drive metadata; requires explicit OAuth re-consent, returns one page", {
    pageSize: { type: "integer", minimum: 1, maximum: 100 },
    pageToken: { type: "string", minLength: 1, maxLength: 4096 },
  }, [], false),
  definition("apps_script_get_project", "Read metadata for one explicitly selected Google Apps Script project", { scriptId: SCRIPT_ID }, ["scriptId"], false),
  definition("apps_script_get_content", "Read Apps Script source files and manifest for one explicit script ID; project source may contain sensitive data", { scriptId: SCRIPT_ID }, ["scriptId"], false, "ask"),
  definition("apps_script_patch_preview", "Preview exact bounded edits to existing Apps Script files; returns only filenames and fingerprints, not source", {
    scriptId: SCRIPT_ID, edits: SCRIPT_PATCH_EDITS,
  }, ["scriptId", "edits"], false),
  definition("apps_script_patch_apply", "Apply one reviewed multi-file Apps Script patch in one guarded write. Verifies HEAD, preserves unmodified files, requires one approval, never retries uncertain writes", {
    scriptId: SCRIPT_ID, edits: SCRIPT_PATCH_EDITS,
    expectedFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    expectedPatchedFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    planFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
    confirmed: { type: "boolean", const: true },
  }, ["scriptId", "edits", "expectedFingerprint", "expectedPatchedFingerprint", "planFingerprint", "confirmed"], true, "ask"),
  definition("apps_script_comment_preview", "Preview a single-line JavaScript comment at the start of one Apps Script source file; reads locally and returns only a fingerprint, file name and change summary (never full source)", {
    scriptId: SCRIPT_ID,
    fileName: { type: "string", minLength: 1, maxLength: 128 },
    commentLine: { type: "string", minLength: 4, maxLength: 200, pattern: "^// " },
  }, ["scriptId", "commentLine"], false),
  definition("apps_script_comment_apply", "Apply one previously previewed single-line JavaScript // comment at the start of a source file; Desktop reads and preserves ALL current files, checks exact HEAD fingerprint, and verifies the change; explicit one-shot approval required, never retry on uncertain response", {
    scriptId: SCRIPT_ID,
    fileName: { type: "string", minLength: 1, maxLength: 128 },
    commentLine: { type: "string", minLength: 4, maxLength: 200, pattern: "^// " },
    expectedFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
    confirmed: { type: "boolean", const: true },
  }, ["scriptId", "fileName", "commentLine", "expectedFingerprint", "confirmed"], true, "ask"),
  definition("apps_script_update_content", "Overwrite all Apps Script HEAD files ONLY after reviewing full file list, matching a freshly read SHA-256 fingerprint and receiving explicit confirmation; never retry on timeout", {
    scriptId: SCRIPT_ID,
    files: { type: "array", minItems: 1, maxItems: 200, items: { type: "object",
      properties: { name: { type: "string" }, type: { type: "string", enum: ["SERVER_JS", "HTML", "JSON"] }, source: { type: "string" } },
      required: ["name", "type", "source"], additionalProperties: false } },
    expectedFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
    confirmed: { type: "boolean", const: true },
  }, ["scriptId", "files", "expectedFingerprint", "confirmed"], true, "ask"),
  definition("apps_script_create_version", "Create an immutable version of an authorized Apps Script project only after confirmation", {
    scriptId: SCRIPT_ID, description: { type: "string", maxLength: 250 }, confirmed: { type: "boolean", const: true },
  }, ["scriptId", "description", "confirmed"], true, "ask"),
  definition("apps_script_create_deployment", "Publish one specified Apps Script version only after explicit production confirmation", {
    scriptId: SCRIPT_ID, versionNumber: { type: "integer", minimum: 1 },
    description: { type: "string", maxLength: 250 }, confirmed: { type: "boolean", const: true },
  }, ["scriptId", "versionNumber", "description", "confirmed"], true, "ask"),
  definition("appsheet_key_status", "Report whether AppSheet API key is configured for an App ID and residency region; never return key", {
    appId: APP_ID, region: REGION,
  }, ["appId", "region"], false),
  definition("appsheet_find_rows", "Query AppSheet Enterprise data API with a per-app key saved in Desktop secure store; may return sensitive rows; never mutate data", {
    appId: APP_ID, region: REGION, table: { type: "string", minLength: 1, maxLength: 128 },
  }, ["appId", "region", "table"], false, "ask"),
];

export class GoogleWorkspaceMcpServer {
  private readonly client: McpExtensionClient;
  private readonly manager: GoogleWorkspaceManager;
  private readonly version: string;
  private readonly credential = randomBytes(32).toString("base64url");
  private server: Server | null = null;
  private endpoint = "";
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: { client: McpExtensionClient; manager: GoogleWorkspaceManager; version: string }) {
    this.client = options.client;
    this.manager = options.manager;
    this.version = options.version;
  }

  async start(): Promise<string> {
    if (this.server) return this.endpoint;
    const server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Google Workspace MCP server failed to bind loopback");
    }
    this.endpoint = `http://127.0.0.1:${address.port}/mcp`;
    this.server = server;
    this.timer = setInterval(() => void this.reconcile().catch(() => undefined), 15_000);
    this.timer.unref?.();
    return this.endpoint;
  }

  async reconcile(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const pending = this.reconcileInternal().finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }

  private async reconcileInternal(): Promise<void> {
    if (!this.server) throw new Error("Google Workspace MCP server is not running");
    const listed = await this.client.list();
    if (!Array.isArray(listed)) throw new Error("Invalid MCP extension registry");
    let current = listed.find((item) => asRecord(item)?.id === ID) as Record<string, unknown> | undefined;
    if (current && !this.matchesRegistration(current)) {
      if (current.namespace !== NAMESPACE || current.source !== SOURCE) {
        throw new Error("Google Workspace extension ID is owned by another provider");
      }
      if (current.enabled) await this.client.disable(ID);
      await this.client.remove(ID);
      current = undefined;
    }
    const freshlyRegistered = !current;
    if (!current) {
      await this.client.install({
        id: ID, name: "SourceNerve Google Workspace", version: this.version,
        namespace: NAMESPACE, source: SOURCE,
        transport: { transport: "streamable-http", url: this.endpoint },
        authType: "bearer", required: false, updateChannel: "stable",
      }, CREDENTIAL_REF);
    }
    if (freshlyRegistered || !current?.credential_materialized) {
      await this.client.materializeCredential(ID, this.credential);
    }
    // A user-disabled extension remains disabled on reconciliation. A new
    // endpoint/reinstallation is a distinct registration and gets safe defaults.
    if (freshlyRegistered) await this.client.enable(ID);
    // Respect user-chosen policy for a previously registered extension.
    if (freshlyRegistered) {
      const tools = await this.client.listTools(ID);
      if (!Array.isArray(tools)) throw new Error("Google Workspace tool discovery failed");
      for (const tool of TOOL_DEFINITIONS) {
        if (!tools.some((entry) => asRecord(entry)?.original_name === tool.name)) continue;
        await this.client.updateToolPolicy({
          extensionId: ID, toolName: tool.name, enabled: true, approval: tool.approval,
        });
      }
    }
  }

  url(): string {
    return this.endpoint;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => undefined);
    const current = await this.client.list().then((items) =>
      Array.isArray(items) ? items.find((x) => asRecord(x)?.id === ID) : undefined,
    ).catch(() => undefined);
    if (current && this.matchesRegistration(asRecord(current) ?? {})) {
      await this.client.disable(ID).catch(() => undefined);
    }
    const server = this.server;
    this.server = null;
    this.endpoint = "";
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private matchesRegistration(value: Record<string, unknown>): boolean {
    const transport = asRecord(value.transport);
    return value.namespace === NAMESPACE && value.source === SOURCE &&
      value.version === this.version && value.auth_type === "bearer" &&
      transport?.transport === "streamable-http" && transport.url === this.endpoint;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.url !== "/mcp") return send(response, 404, { error: "not_found" });
      if (!validHost(request.headers.host)) return send(response, 403, { error: "invalid_host" });
      if (!validBearer(request.headers.authorization, this.credential)) {
        response.setHeader("www-authenticate", "Bearer");
        return send(response, 401, { error: "unauthorized" });
      }
      if (request.method === "DELETE") return sendEmpty(response, 204);
      if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
      const rpc = await readRpc(request);
      if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        return rpcError(response, rpc.id, -32600, "Invalid Request");
      }
      if (rpc.method === "notifications/initialized") return sendEmpty(response, 202);
      if (rpc.method === "ping") return rpcResult(response, rpc.id, {});
      if (rpc.method === "initialize") return rpcResult(response, rpc.id, {
        protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: ID, version: this.version },
      });
      if (rpc.method === "tools/list") return rpcResult(response, rpc.id, { tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema, annotations }) => ({
        name, description, inputSchema, annotations,
      })) });
      if (rpc.method === "tools/call") {
        const params = asRecord(rpc.params);
        const name = params?.name;
        const args = asRecord(params?.arguments) ?? {};
        if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
          return rpcError(response, rpc.id, -32602, "Unknown Google Workspace tool");
        }
        try {
          const result = await this.callTool(name as ToolName, args);
          return rpcResult(response, rpc.id, toolResult(result, false));
        } catch (error) {
          return rpcResult(response, rpc.id, toolResult({
            error: safeMessage(error),
          }, true));
        }
      }
      return rpcError(response, rpc.id, -32601, "Method not found");
    } catch {
      return send(response, 400, { error: "invalid_request" });
    }
  }

  private async callTool(name: ToolName, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "google_workspace_status": return this.manager.googleStatus();
      case "apps_script_list_projects": return this.manager.listAppsScriptProjects({
        ...(args.pageSize === undefined ? {} : { pageSize: requirePageSize(args.pageSize) }),
        ...(args.pageToken === undefined ? {} : { pageToken: requiredString(args.pageToken, "pageToken", 4096) }),
      });
      case "apps_script_get_project": return this.manager.getAppsScriptProject(requiredString(args.scriptId, "scriptId", 160));
      case "apps_script_get_content": return this.manager.getAppsScriptContent(requiredString(args.scriptId, "scriptId", 160));
      case "apps_script_patch_preview": return this.manager.previewAppsScriptPatch({
        scriptId: requiredString(args.scriptId, "scriptId", 160),
        edits: requireScriptEdits(args.edits),
      });
      case "apps_script_patch_apply":
        if (args.confirmed !== true) throw new Error("Explicit reviewed Apps Script patch confirmation required");
        return this.manager.applyAppsScriptPatch({
          scriptId: requiredString(args.scriptId, "scriptId", 160),
          edits: requireScriptEdits(args.edits),
          expectedFingerprint: requiredString(args.expectedFingerprint, "expectedFingerprint", 64),
          expectedPatchedFingerprint: requiredString(args.expectedPatchedFingerprint, "expectedPatchedFingerprint", 64),
          planFingerprint: requiredString(args.planFingerprint, "planFingerprint", 64),
          confirmed: true,
        });
      case "apps_script_comment_preview": return this.manager.previewAppsScriptComment({
        scriptId: requiredString(args.scriptId, "scriptId", 160),
        commentLine: requiredString(args.commentLine, "commentLine", 200),
        ...(args.fileName === undefined ? {} : { fileName: requiredString(args.fileName, "fileName", 128) }),
      });
      case "apps_script_comment_apply":
        if (args.confirmed !== true) throw new Error("Explicit Apps Script comment confirmation required");
        return this.manager.applyAppsScriptComment({
          scriptId: requiredString(args.scriptId, "scriptId", 160),
          fileName: requiredString(args.fileName, "fileName", 128),
          commentLine: requiredString(args.commentLine, "commentLine", 200),
          expectedFingerprint: requiredString(args.expectedFingerprint, "expectedFingerprint", 64),
          confirmed: true,
        });
      case "apps_script_update_content": {
        const { scriptId, expectedFingerprint, confirmed, files } = args;
        if (confirmed !== true || !Array.isArray(files)) throw new Error("Explicit file update confirmation is required");
        return this.manager.updateAppsScriptContent({
          scriptId: requiredString(scriptId, "scriptId", 160),
          expectedFingerprint: requiredString(expectedFingerprint, "expectedFingerprint", 64),
          files: files as Parameters<GoogleWorkspaceManager["updateAppsScriptContent"]>[0]["files"],
          confirmed: true,
        });
      }
      case "apps_script_create_version":
        if (args.confirmed !== true) throw new Error("Explicit version confirmation is required");
        return this.manager.createAppsScriptVersion({
          scriptId: requiredString(args.scriptId, "scriptId", 160),
          description: optionalDescription(args.description), confirmed: true,
        });
      case "apps_script_create_deployment":
        if (args.confirmed !== true || !Number.isSafeInteger(args.versionNumber)) {
          throw new Error("Explicit deployment version and confirmation required");
        }
        return this.manager.createAppsScriptDeployment({
          scriptId: requiredString(args.scriptId, "scriptId", 160),
          versionNumber: args.versionNumber as number,
          description: optionalDescription(args.description), confirmed: true,
        });
      case "appsheet_key_status": return this.manager.appSheetStatus(
        requiredString(args.appId, "appId", 128), requiredString(args.region, "region", 80));
      case "appsheet_find_rows": return this.manager.findAppSheetRows({
        appId: requiredString(args.appId, "appId", 128),
        region: requiredString(args.region, "region", 80),
        table: requiredString(args.table, "table", 128),
      });
    }
  }
}

function definition(name: ToolName, description: string,
  properties: Record<string, unknown>, required: string[], writes: boolean,
  approval: "automatic" | "ask" = "automatic"): Definition {
  return {
    name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: {
      title: name, readOnlyHint: !writes, destructiveHint: writes,
      idempotentHint: !writes, openWorldHint: true,
    },
    approval,
  };
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid Google Workspace ${field}`);
  }
  return value;
}
function requireScriptEdits(
  value: unknown,
): Parameters<GoogleWorkspaceManager["previewAppsScriptPatch"]>[0]["edits"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error("Apps Script patch needs 1–16 bounded edits");
  }
  // Desktop Main performs detailed validation at its own trust boundary.
  return value as Parameters<GoogleWorkspaceManager["previewAppsScriptPatch"]>[0]["edits"];
}
function requirePageSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) {
    throw new Error("Invalid Apps Script pageSize");
  }
  return value as number;
}
function optionalDescription(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 250 || /[\r\n\0]/.test(value)) {
    throw new Error("Invalid version or deployment description");
  }
  return value;
}
function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : "Google Workspace request failed";
  if (value.length > 240 || /\b(ya29\.|refresh_token|access_token|ApplicationAccessKey|Bearer\s)/i.test(value)) {
    return "Google Workspace request failed";
  }
  return value;
}
function validHost(value: string | undefined): boolean {
  return typeof value === "string" && /^127\.0\.0\.1(?::\d+)?$/.test(value);
}
function validBearer(value: string | undefined, expected: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const got = Buffer.from(value.slice("Bearer ".length), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return got.length === wanted.length && timingSafeEqual(got, wanted);
}
async function readRpc(request: IncomingMessage): Promise<{ jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown }> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("Request too large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!asRecord(value)) throw new Error("Malformed JSON-RPC request");
  return value as { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
}
function toolResult(value: unknown, isError: boolean) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: asRecord(value) ?? { value },
    isError,
  };
}
function rpcResult(response: ServerResponse, id: string | number | null | undefined, result: unknown): void {
  send(response, 200, { jsonrpc: "2.0", id: id ?? null, result });
}
function rpcError(response: ServerResponse, id: string | number | null | undefined, code: number, message: string): void {
  send(response, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}
function send(response: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(data);
}
function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store" });
  response.end();
}

import { describe, expect, it, vi } from "vitest";

import { GoogleWorkspaceManager, contentFingerprint, scriptPath } from "./google-workspace-manager";
import { GOOGLE_WORKSPACE_IPC } from "../shared/google-workspace-api";
import { validateGoogleWorkspaceIpc } from "./google-workspace-ipc";
import type { EncryptedSecretStore } from "./secure-store";

const CLIENT_ID = "000000000000000000000000.apps.googleusercontent.com";
const SCRIPT_ID = "abcdefghijklmnopqrstuvwxy1234567890";
const APP_ID = "abcdefgh12345678";
const REGION = "www.appsheet.com";
const files = [
  { name: "appsscript", type: "JSON" as const, source: '{"timeZone":"UTC"}' },
  { name: "Code", type: "SERVER_JS" as const, source: "function hello() { return 1; }" },
];

function fixture() {
  const secrets = new Map<string, string>();
  const store = {
    getOpaque: vi.fn(async (key: string) => secrets.get(key) ?? null),
    setOpaque: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
    deleteOpaque: vi.fn(async (key: string) => { secrets.delete(key); }),
    hasOpaque: vi.fn(async (key: string) => secrets.has(key)),
  } as unknown as EncryptedSecretStore;
  const fetcher = vi.fn<typeof fetch>();
  const manager = new GoogleWorkspaceManager({
    secretStore: store, openExternal: async () => undefined, fetcher,
  });
  return { secrets, store, fetcher, manager };
}
async function readConnected(f: ReturnType<typeof fixture>) {
  await f.manager.configureGoogle(CLIENT_ID, "read");
  f.secrets.set("mcp-extension:google-workspace:credential", "test-access-token");
}

describe("Google Workspace Desktop secure adapters", () => {
  it("never moves tokens to an MCP extension and defaults to no authorization", async () => {
    const f = fixture();
    expect(await f.manager.googleStatus()).toEqual({ configured: false, connected: false, mode: null });
    await expect(f.manager.getAppsScriptProject(SCRIPT_ID)).rejects.toThrow(/scope insufficient/);
    const status = await f.manager.configureGoogle(CLIENT_ID, "read");
    expect(status.configured).toBe(true);
    expect(status.connected).toBe(false);
    expect(f.secrets.has("mcp-extension:google-workspace:credential")).toBe(false);
    await f.manager.shutdown();
  });

  it("keeps an optional Google Desktop client secret encrypted and forces re-consent on scope changes", async () => {
    const f = fixture();
    await f.manager.configureGoogle(CLIENT_ID, "read", "desktop-secret-for-test");
    expect(f.secrets.get("google-workspace:oauth-client-secret")).toBe("desktop-secret-for-test");
    f.secrets.set("mcp-extension:google-workspace:credential", "old-read-token");
    await f.manager.configureGoogle(CLIENT_ID, "deploy");
    expect(f.secrets.has("mcp-extension:google-workspace:credential")).toBe(false);
    expect(f.secrets.get("google-workspace:oauth-client-secret")).toBe("desktop-secret-for-test");
    expect((await f.manager.googleStatus()).mode).toBe("deploy");
    expect((await f.manager.googleStatus()).connected).toBe(false);
    await f.manager.shutdown();
  });

  it("reads Apps Script content with Bearer authorization only in a Google HTTPS request", async () => {
    const f = fixture();
    await readConnected(f);
    f.fetcher.mockResolvedValue(new Response(JSON.stringify({ scriptId: SCRIPT_ID, files }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const content = await f.manager.getAppsScriptContent(SCRIPT_ID);
    expect(content.files).toHaveLength(2);
    expect(content.fingerprint).toBe(contentFingerprint([...files].reverse()));
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe(`https://script.googleapis.com/v1/projects/${SCRIPT_ID}/content`);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-access-token");
    expect(JSON.stringify(content)).not.toContain("test-access-token");
    await f.manager.shutdown();
  });

  it("never pushes changed files without edit scope, explicit confirmation and a matching remote fingerprint", async () => {
    const f = fixture();
    await readConnected(f);
    const expectedFingerprint = contentFingerprint(files);
    const request = { scriptId: SCRIPT_ID, files, expectedFingerprint, confirmed: true as const };
    await expect(f.manager.updateAppsScriptContent(request)).rejects.toThrow(/scope insufficient/);
    await f.manager.configureGoogle(CLIENT_ID, "edit");
    f.secrets.set("mcp-extension:google-workspace:credential", "editor-token");
    f.fetcher.mockResolvedValue(new Response(JSON.stringify({ scriptId: SCRIPT_ID, files })));
    await expect(f.manager.updateAppsScriptContent({ ...request, expectedFingerprint: "0".repeat(64) }))
      .rejects.toThrow(/remote content changed/);
    expect(f.fetcher).toHaveBeenCalledTimes(1); // GET only: fail closed, no PUT
    expect(f.fetcher.mock.calls[0][1]?.method).toBe("GET");
    await f.manager.shutdown();
  });

  it("stores AppSheet access keys by app and region; never sends them in URLs or results", async () => {
    const f = fixture();
    await f.manager.configureAppSheetKey({
      appId: APP_ID, region: REGION, key: "appsheet-secret-for-unit-test",
    });
    expect((await f.manager.appSheetStatus(APP_ID, REGION)).configured).toBe(true);
    expect((await f.manager.appSheetStatus(APP_ID, "eu.appsheet.com")).configured).toBe(false);
    f.fetcher.mockResolvedValue(new Response(JSON.stringify([{ Row: 1 }])));
    const rows = await f.manager.findAppSheetRows({ appId: APP_ID, region: REGION, table: "Users" });
    expect(rows).toEqual([{ Row: 1 }]);
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe(`https://www.appsheet.com/api/v2/apps/${APP_ID}/tables/Users/Action`);
    expect((init?.headers as Record<string, string>).ApplicationAccessKey)
      .toBe("appsheet-secret-for-unit-test");
    expect(JSON.stringify(rows)).not.toContain("appsheet-secret-for-unit-test");
    await f.manager.clearAppSheetKey(APP_ID, REGION);
    expect((await f.manager.appSheetStatus(APP_ID, REGION)).configured).toBe(false);
    await f.manager.shutdown();
  });

  it("rejects external endpoints, malicious IDs and unconfirmed write IPC requests", () => {
    for (const id of ["../secrets", "a/b", "test?foo=x", "https://example.com"]) {
      expect(() => scriptPath(id)).toThrow(/Invalid Apps Script/);
    }
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.connect, [])).toBe(true);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.configure, [
      "123.evil.test", "read",
    ])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.updateScript, [{
      scriptId: SCRIPT_ID, files, expectedFingerprint: "0".repeat(64), confirmed: false,
    }])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.createDeployment, [
      SCRIPT_ID, 2, "prod", false,
    ])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.appSheetSetKey, [{
      appId: APP_ID, region: "evil.example.com", key: "not-a-real-secret-123",
    }])).toBe(false);
  });
});

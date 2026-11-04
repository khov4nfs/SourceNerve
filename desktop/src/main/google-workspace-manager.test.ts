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
  { name: "Shared Helpers.v2", type: "SERVER_JS" as const, source: "function hello() { return 1; }" },
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
    expect(await f.manager.googleStatus()).toEqual({
      configured: false, connected: false, mode: null, projectDiscoveryEnabled: false,
    });
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

  it("previews and applies a minimal comment without returning project source through MCP", async () => {
    const f = fixture();
    await f.manager.configureGoogle(CLIENT_ID, "edit");
    f.secrets.set("mcp-extension:google-workspace:credential", "test-edit-token");
    const original = [
      ...files,
      { name: "Other", type: "HTML" as const, source: "<div>keep this private</div>" },
    ];
    const commentLine = "// SourceNerve: kiểm tra cập nhật Apps Script từ ChatGPT.";
    const patched = original.map((file) =>
      file.name === "Shared Helpers.v2"
        ? { ...file, source: commentLine + "\n" + file.source }
        : file,
    );
    const content = (payload: typeof original) => new Response(JSON.stringify({ files: payload }));
    f.fetcher.mockResolvedValueOnce(content(original))  // preview
      .mockResolvedValueOnce(content(original))        // apply preflight
      .mockResolvedValueOnce(content(original))        // updateContent preflight
      .mockResolvedValueOnce(content(patched))         // PUT result
      .mockResolvedValueOnce(content(patched));        // post-write verification

    const preview = await f.manager.previewAppsScriptComment({ scriptId: SCRIPT_ID, commentLine });
    expect(preview).toEqual({
      scriptId: SCRIPT_ID,
      fileName: "Shared Helpers.v2",
      commentLine,
      position: "file-start",
      expectedFingerprint: contentFingerprint(original),
      wouldChange: true,
      fileCount: 3,
      manifestPreserved: true,
    });
    expect(JSON.stringify(preview)).not.toContain("keep this private");
    expect(JSON.stringify(preview)).not.toContain("function hello");

    const applied = await f.manager.applyAppsScriptComment({
      scriptId: SCRIPT_ID, fileName: preview.fileName, commentLine,
      expectedFingerprint: preview.expectedFingerprint, confirmed: true,
    });
    expect(applied).toEqual({
      scriptId: SCRIPT_ID, fileName: "Shared Helpers.v2",
      previousFingerprint: contentFingerprint(original),
      newFingerprint: contentFingerprint(patched),
      changed: true, verified: true,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(5);
    expect(f.fetcher.mock.calls.map(([, init]) => init?.method))
      .toEqual(["GET", "GET", "GET", "PUT", "GET"]);
    const put = f.fetcher.mock.calls[3];
    const body = JSON.parse(put[1]?.body as string) as { files: typeof original };
    expect(body.files).toEqual(patched);
    expect(body.files[0]).toEqual(original[0]); // manifest unchanged
    expect(body.files[2]).toEqual(original[2]); // unrelated file unchanged
    expect(JSON.stringify(applied)).not.toContain("keep this private");
    expect(JSON.stringify(applied)).not.toContain("test-edit-token");
    await f.manager.shutdown();
  });

  it("refuses stale fingerprints and never sends a PUT", async () => {
    const f = fixture();
    await f.manager.configureGoogle(CLIENT_ID, "edit");
    f.secrets.set("mcp-extension:google-workspace:credential", "test-edit-token");
    f.fetcher.mockResolvedValue(new Response(JSON.stringify({ files })));
    const commentLine = "// small safe test";
    await expect(f.manager.applyAppsScriptComment({
      scriptId: SCRIPT_ID, fileName: "Shared Helpers.v2", commentLine,
      expectedFingerprint: "0".repeat(64), confirmed: true,
    })).rejects.toThrow(/remote content changed/);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls[0][1]?.method).toBe("GET");
    await f.manager.shutdown();
  });

  it("is idempotent when the exact first-line comment already exists", async () => {
    const f = fixture();
    await f.manager.configureGoogle(CLIENT_ID, "edit");
    f.secrets.set("mcp-extension:google-workspace:credential", "test-edit-token");
    const commentLine = "// Already present";
    const existing = files.map((file) => file.type === "SERVER_JS"
      ? { ...file, source: commentLine + "\n" + file.source } : file);
    f.fetcher.mockResolvedValue(new Response(JSON.stringify({ files: existing })));
    const preview = await f.manager.previewAppsScriptComment({ scriptId: SCRIPT_ID, commentLine });
    expect(preview.wouldChange).toBe(false);
    const result = await f.manager.applyAppsScriptComment({
      scriptId: SCRIPT_ID, fileName: preview.fileName, commentLine,
      expectedFingerprint: preview.expectedFingerprint, confirmed: true,
    });
    expect(result.changed).toBe(false);
    expect(result.verified).toBe(true);
    expect(f.fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
    await f.manager.shutdown();
  });

  it("rejects multiline and ambiguous or unauthorized comment patches", async () => {
    const f = fixture();
    await readConnected(f); // read-only OAuth mode
    const input = { scriptId: SCRIPT_ID, fileName: "Shared Helpers.v2",
      commentLine: "// Sample", expectedFingerprint: "0".repeat(64), confirmed: true as const };
    await expect(f.manager.applyAppsScriptComment(input)).rejects.toThrow(/scope insufficient/);
    for (const badComment of [
      "function run() {}", "/* comment */", "// two\nlines", "// two\rlines",
      "// hidden\u2028line", "// " + "x".repeat(200),
    ]) {
      await expect(f.manager.previewAppsScriptComment({
        scriptId: SCRIPT_ID, commentLine: badComment,
      })).rejects.toThrow(/single JavaScript/);
    }
    await expect(f.manager.previewAppsScriptComment({
      scriptId: SCRIPT_ID, fileName: "../secret", commentLine: input.commentLine,
    })).rejects.toThrow(/filename/);
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.manager.configureGoogle(CLIENT_ID, "edit");
    f.secrets.set("mcp-extension:google-workspace:credential", "test-edit-token");
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ files: [
      ...files,
      { name: "SecondCode", type: "SERVER_JS", source: "function keep() {}" },
    ] })));
    await expect(f.manager.previewAppsScriptComment({
      scriptId: SCRIPT_ID, commentLine: input.commentLine,
    })).rejects.toThrow(/Select exactly one/);
    await f.manager.shutdown();
  });

  it("never retries an ambiguous Apps Script update or silently reports success", async () => {
    const f = fixture();
    await f.manager.configureGoogle(CLIENT_ID, "edit");
    f.secrets.set("mcp-extension:google-workspace:credential", "test-edit-token");
    const commentLine = "// Bounded single-line edit";
    const changed = files.map((file) => file.type === "SERVER_JS"
      ? { ...file, source: commentLine + "\n" + file.source } : file);
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ files })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: changed })))
      .mockRejectedValueOnce(new Error("network timeout after PUT"));
    await expect(f.manager.applyAppsScriptComment({
      scriptId: SCRIPT_ID, fileName: "Shared Helpers.v2", commentLine,
      expectedFingerprint: contentFingerprint(files), confirmed: true,
    })).rejects.toThrow(/write may have succeeded but verification failed/);
    expect(f.fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "PUT", "GET"]);
    await f.manager.shutdown();
  });

  it("enables metadata discovery without changing deploy scope and clears the old OAuth tokens", async () => {
    const f = fixture();
    await f.manager.configureGoogle(CLIENT_ID, "deploy", "desktop-secret-for-test");
    f.secrets.set("mcp-extension:google-workspace:credential", "previous-access-token");
    f.secrets.set("mcp-extension:google-workspace:oauth-refresh", "previous-refresh-token");
    const enabled = await f.manager.enableProjectDiscovery();
    expect(enabled).toEqual({
      configured: true, connected: false, mode: "deploy", projectDiscoveryEnabled: true,
    });
    expect(f.secrets.has("mcp-extension:google-workspace:credential")).toBe(false);
    expect(f.secrets.has("mcp-extension:google-workspace:oauth-refresh")).toBe(false);
    expect(f.secrets.get("google-workspace:oauth-client-secret")).toBe("desktop-secret-for-test");
    const saved = JSON.parse(f.secrets.get("mcp-extension:google-workspace:oauth-config") ?? "{}") as {
      scopes?: string[];
    };
    expect(saved.scopes).toContain("https://www.googleapis.com/auth/drive.metadata.readonly");
    expect(saved.scopes).toContain("https://www.googleapis.com/auth/script.projects");
    expect(saved.scopes).toContain("https://www.googleapis.com/auth/script.deployments");
    expect(saved.scopes).not.toContain("https://www.googleapis.com/auth/drive");
    await f.manager.shutdown();
  });

  it("fails closed if secure storage cannot delete an old Google token during scope upgrade", async () => {
    const f = fixture();
    await f.manager.configureGoogle(CLIENT_ID, "read");
    f.secrets.set("mcp-extension:google-workspace:credential", "old-consented-token");
    vi.mocked(f.store.deleteOpaque).mockImplementation(async (key: string) => {
      if (key !== "mcp-extension:google-workspace:credential") f.secrets.delete(key);
    });
    await expect(f.manager.enableProjectDiscovery()).rejects.toThrow(
      "Could not clear previous Google OAuth tokens",
    );
    expect((await f.manager.googleStatus()).projectDiscoveryEnabled).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.manager.shutdown();
  });

  it("never sends a Drive request without explicit metadata consent", async () => {
    const f = fixture();
    await readConnected(f);
    await expect(f.manager.listAppsScriptProjects()).rejects.toThrow(/metadata access is not enabled/);
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.manager.enableProjectDiscovery();
    await expect(f.manager.listAppsScriptProjects()).rejects.toThrow(/authorization is required/);
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.manager.shutdown();
  });

  it("lists standalone scripts from Drive metadata only, with safe editor links and opaque pagination", async () => {
    const f = fixture();
    await readConnected(f);
    await f.manager.enableProjectDiscovery();
    f.secrets.set("mcp-extension:google-workspace:credential", "new-consented-token");
    const modifiedTime = "2026-11-04T01:02:03.000Z";
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      files: [
        { id: SCRIPT_ID, name: "My script & helpers", mimeType: "application/vnd.google-apps.script",
          modifiedTime },
      ],
      nextPageToken: "next/page+=token",
      incompleteSearch: false,
    }))).mockResolvedValueOnce(new Response(JSON.stringify({
      files: [{ id: "b".repeat(36), name: "Another script",
        mimeType: "application/vnd.google-apps.script" }],
    })));
    const first = await f.manager.listAppsScriptProjects({ pageSize: 20 });
    expect(first.projects).toEqual([{
      name: "My script & helpers", scriptId: SCRIPT_ID, modifiedTime,
      editorUrl: `https://script.google.com/d/${SCRIPT_ID}/edit`,
    }]);
    expect(first.nextPageToken).toBe("next/page+=token");
    expect(first.incompleteSearch).toBe(false);
    const firstUrl = new URL(f.fetcher.mock.calls[0][0] as string);
    expect(firstUrl.origin).toBe("https://www.googleapis.com");
    expect(firstUrl.pathname).toBe("/drive/v3/files");
    expect(firstUrl.searchParams.get("q")).toBe(
      "mimeType = 'application/vnd.google-apps.script' and trashed = false",
    );
    expect(firstUrl.searchParams.get("fields")).toBe(
      "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)",
    );
    expect(firstUrl.searchParams.get("pageSize")).toBe("20");
    const [, firstRequest] = f.fetcher.mock.calls[0];
    expect(firstRequest?.method).toBe("GET");
    expect((firstRequest?.headers as Record<string, string>).authorization).toBe("Bearer new-consented-token");

    const second = await f.manager.listAppsScriptProjects({
      pageSize: 20, pageToken: first.nextPageToken!,
    });
    expect(second.projects).toHaveLength(1);
    expect(second.projects[0].modifiedTime).toBeNull();
    expect(second.nextPageToken).toBeNull();
    const secondUrl = new URL(f.fetcher.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("pageToken")).toBe("next/page+=token");
    expect(JSON.stringify(first)).not.toContain("new-consented-token");
    await f.manager.shutdown();
  });

  it("rejects malformed Drive metadata, unexpected MIME types and invalid pagination", async () => {
    const f = fixture();
    await readConnected(f);
    await f.manager.enableProjectDiscovery();
    f.secrets.set("mcp-extension:google-workspace:credential", "read-token");
    for (const request of [
      { pageSize: 0 },
      { pageSize: 101 },
      { pageToken: "a\nb" },
      { pageToken: "" },
    ]) {
      await expect(f.manager.listAppsScriptProjects(request))
        .rejects.toThrow(/pageSize|pagination token/);
    }
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      files: [{ id: SCRIPT_ID, name: "Not a script",
        mimeType: "application/vnd.google-apps.spreadsheet" }],
    })));
    await expect(f.manager.listAppsScriptProjects()).rejects.toThrow(/invalid Apps Script metadata/);
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
    const commentBase = { scriptId: SCRIPT_ID, fileName: "Shared Helpers.v2",
      commentLine: "// Small audit comment" };
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.previewScriptComment,
      [{ scriptId: SCRIPT_ID, commentLine: commentBase.commentLine }])).toBe(true);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.previewScriptComment,
      [commentBase])).toBe(true);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.applyScriptComment,
      [{ ...commentBase, expectedFingerprint: "a".repeat(64), confirmed: true }])).toBe(true);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.applyScriptComment,
      [{ ...commentBase, expectedFingerprint: "a".repeat(64), confirmed: false }])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.previewScriptComment,
      [{ ...commentBase, commentLine: "// newline\nrun();" }])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.previewScriptComment,
      [{ ...commentBase, fileName: "../bad" }])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.previewScriptComment,
      [{ ...commentBase, files: [] }])).toBe(false);
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

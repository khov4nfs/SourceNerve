import { describe, expect, it, vi } from "vitest";

import { GoogleWorkspaceManager } from "./google-workspace-manager";
import { GOOGLE_WORKSPACE_IPC } from "../shared/google-workspace-api";
import { validateGoogleWorkspaceIpc } from "./google-workspace-ipc";
import type { EncryptedSecretStore } from "./secure-store";

const CLIENT_ID = "000000000000000000000000.apps.googleusercontent.com";
const SCRIPT_ID = "abcdefghijklmnopqrstuvwxy1234567890";
const SHEET_ID = "sheet0123456789abcdefghijk";
const DOC_ID = "document0123456789abcdefgh";
const MIME_SHEET = "application/vnd.google-apps.spreadsheet";
const MIME_DOC = "application/vnd.google-apps.document";

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
    secretStore: store,
    openExternal: async () => undefined,
    fetcher,
  });
  return { secrets, fetcher, manager };
}

async function authorize(f: ReturnType<typeof fixture>) {
  await f.manager.configureGoogle(CLIENT_ID, "read");
  await f.manager.enableProjectDiscovery();
  f.secrets.set("mcp-extension:google-workspace:credential", "trusted-local-token");
}

describe("Bound Apps Script container discovery (read-only)", () => {
  it("requires explicit Drive metadata consent and never guesses bound Script IDs", async () => {
    const f = fixture();
    await f.manager.configureGoogle(CLIENT_ID, "read");
    f.secrets.set("mcp-extension:google-workspace:credential", "old-script-only-token");
    await expect(f.manager.listAppsScriptContainers())
      .rejects.toThrow(/metadata access is not enabled/);
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.manager.shutdown();
  });

  it("lists only Sheet/Doc candidate metadata with bounded search, opaque pagination, and no content", async () => {
    const f = fixture();
    await authorize(f);
    const first = {
      files: [
        { id: SHEET_ID, name: "PMT's Monthly Plan", mimeType: MIME_SHEET,
          modifiedTime: "2026-11-04T01:02:03Z" },
        { id: DOC_ID, name: "Planning document", mimeType: MIME_DOC },
      ],
      nextPageToken: "opaque/page1+=token",
      incompleteSearch: false,
    };
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(first)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] })));
    const page = await f.manager.listAppsScriptContainers({ pageSize: 5, query: "PMT's \\ schedule" });
    expect(page).toEqual({
      containers: [
        { containerId: SHEET_ID, name: "PMT's Monthly Plan", kind: "sheet",
          modifiedTime: "2026-11-04T01:02:03Z",
          editorUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` },
        { containerId: DOC_ID, name: "Planning document", kind: "doc", modifiedTime: null,
          editorUrl: `https://docs.google.com/document/d/${DOC_ID}/edit` },
      ],
      nextPageToken: "opaque/page1+=token",
      incompleteSearch: false,
      scriptsEnumerated: false,
    });
    const [url, init] = f.fetcher.mock.calls[0];
    const request = new URL(url as string);
    expect(request.hostname).toBe("www.googleapis.com");
    expect(request.pathname).toBe("/drive/v3/files");
    const filter = request.searchParams.get("q") ?? "";
    expect(filter).toContain(`mimeType = '${MIME_SHEET}'`);
    expect(filter).toContain(`mimeType = '${MIME_DOC}'`);
    expect(filter).toContain("trashed = false");
    expect(filter).toContain("name contains 'PMT\\'s");
    expect(filter).toContain("\\\\ schedule'");
    expect(request.searchParams.get("fields")).toBe(
      "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime)",
    );
    expect(request.searchParams.get("pageSize")).toBe("5");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer trusted-local-token");
    expect(init?.method).toBe("GET");
    const next = await f.manager.listAppsScriptContainers({
      pageSize: 5, pageToken: page.nextPageToken!,
    });
    expect(next.containers).toEqual([]);
    expect(new URL(f.fetcher.mock.calls[1][0] as string).searchParams.get("pageToken"))
      .toBe("opaque/page1+=token");
    expect(JSON.stringify(page)).not.toContain("trusted-local-token");
    await f.manager.shutdown();
  });

  it("rejects malformed search or API results without exposing provider bodies", async () => {
    const f = fixture();
    await authorize(f);
    for (const request of [
      { pageSize: 0 }, { pageSize: 101 }, { pageToken: "x\ny" },
      { query: "   " }, { query: "x".repeat(129) }, { query: "bad\rname" },
    ]) {
      await expect(f.manager.listAppsScriptContainers(request))
        .rejects.toThrow(/pageSize|pagination token|search query/);
    }
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      files: [{ id: SHEET_ID, name: "Unexpected", mimeType: "text/plain" }],
    })));
    await expect(f.manager.listAppsScriptContainers()).rejects.toThrow(/invalid container metadata/);
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      files: [{ id: SHEET_ID, name: "Sheet", mimeType: MIME_SHEET }], nextPageToken: "\n",
    })));
    await expect(f.manager.listAppsScriptContainers()).rejects.toThrow(/invalid next-page token/);
    await f.manager.shutdown();
  });

  it("checks a known Script ID using projects.get; missing parentId is unconfirmed, never a match", async () => {
    const f = fixture();
    await f.manager.configureGoogle(CLIENT_ID, "read");
    f.secrets.set("mcp-extension:google-workspace:credential", "read-only-token");
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      scriptId: SCRIPT_ID, parentId: SHEET_ID, title: "Bound project",
      creator: { email: "private@example.com" },
    }))).mockResolvedValueOnce(new Response(JSON.stringify({
      scriptId: SCRIPT_ID, parentId: DOC_ID, title: "Other container",
    }))).mockResolvedValueOnce(new Response(JSON.stringify({
      scriptId: SCRIPT_ID, title: "Unknown parent",
    })));
    const verified = await f.manager.checkBoundAppsScript(SCRIPT_ID, SHEET_ID);
    expect(verified).toEqual({
      scriptId: SCRIPT_ID, containerId: SHEET_ID, scriptTitle: "Bound project",
      editorUrl: `https://script.google.com/d/${SCRIPT_ID}/edit`, match: "verified",
    });
    const mismatch = await f.manager.checkBoundAppsScript(SCRIPT_ID, SHEET_ID);
    expect(mismatch.match).toBe("mismatch");
    const unknown = await f.manager.checkBoundAppsScript(SCRIPT_ID, SHEET_ID);
    expect(unknown.match).toBe("unconfirmed");
    expect(JSON.stringify(verified)).not.toContain("private@example.com");
    expect(f.fetcher.mock.calls.map(([url]) => url))
      .toEqual(Array(3).fill(`https://script.googleapis.com/v1/projects/${SCRIPT_ID}`));
    expect(f.fetcher.mock.calls.map(([, init]) => init?.method))
      .toEqual(["GET", "GET", "GET"]);
    await expect(f.manager.checkBoundAppsScript("bad", SHEET_ID))
      .rejects.toThrow(/Invalid Apps Script project ID/);
    await expect(f.manager.checkBoundAppsScript(SCRIPT_ID, "bad"))
      .rejects.toThrow(/Invalid Google Sheets\/Docs container ID/);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    await f.manager.shutdown();
  });

  it("validates renderer IPC input and fails closed on extra keys", () => {
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.listContainers,
      [{ pageSize: 20, query: "PMT", pageToken: "opaque" }])).toBe(true);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.listContainers, [{}])).toBe(true);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.listContainers,
      [{ query: "hello\nworld" }])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.listContainers,
      [{ query: "PMT", includeContent: true }])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.checkBoundScript,
      [SCRIPT_ID, SHEET_ID])).toBe(true);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.checkBoundScript,
      [SCRIPT_ID, SHEET_ID, true])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.checkBoundScript,
      [SCRIPT_ID, "invalid"])).toBe(false);
  });
});

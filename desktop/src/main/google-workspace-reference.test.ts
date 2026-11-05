import { describe, expect, it, vi } from "vitest";

import { parseAppsScriptReference } from "../shared/apps-script-reference";
import { GOOGLE_WORKSPACE_IPC } from "../shared/google-workspace-api";
import { GoogleWorkspaceManager } from "./google-workspace-manager";
import { validateGoogleWorkspaceIpc } from "./google-workspace-ipc";
import type { EncryptedSecretStore } from "./secure-store";

const CLIENT_ID = "000000000000000000000000.apps.googleusercontent.com";
const SCRIPT_ID = "abcdefghijklmnopqrstuvwxyz0123456789";
const SHEET_ID = "sheet0123456789abcdefghijk";
const OTHER_ID = "anotherDocument012345678901";
const URL_D = `https://script.google.com/d/${SCRIPT_ID}/edit`;
const URL_HOME = `https://script.google.com/home/projects/${SCRIPT_ID}/edit`;

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
  return { manager, secrets, fetcher };
}

async function authorize(f: ReturnType<typeof fixture>, drive = false) {
  await f.manager.configureGoogle(CLIENT_ID, "read");
  if (drive) await f.manager.enableProjectDiscovery();
  f.secrets.set("mcp-extension:google-workspace:credential", "trusted-token");
}

describe("Apps Script Editor reference resolver", () => {
  it("accepts only official Editor project links or raw IDs", () => {
    expect(parseAppsScriptReference(SCRIPT_ID)).toBe(SCRIPT_ID);
    expect(parseAppsScriptReference(` ${SCRIPT_ID} `)).toBe(SCRIPT_ID);
    expect(parseAppsScriptReference(URL_D)).toBe(SCRIPT_ID);
    expect(parseAppsScriptReference(`${URL_HOME}?authuser=1#view`)).toBe(SCRIPT_ID);
    expect(parseAppsScriptReference(`https://script.google.com/home/projects/${SCRIPT_ID}`)).toBe(SCRIPT_ID);
    for (const bad of [
      "", "bad", null, {}, "x".repeat(513), "https://script.google.com/",
      `http://script.google.com/d/${SCRIPT_ID}/edit`,
      `https://script.google.com.attacker.test/d/${SCRIPT_ID}/edit`,
      `https://user:pass@script.google.com/d/${SCRIPT_ID}/edit`,
      `https://script.google.com:444/d/${SCRIPT_ID}/edit`,
      `https://script.google.com/macros/s/${SCRIPT_ID}/exec`,
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
      `https://script.google.com/home/projects/${SCRIPT_ID}/executions`,
      `https://script.google.com/d/%2F${SCRIPT_ID}/edit`,
      `https://script.google.com/d/${SCRIPT_ID}/edit\n`,
      `javascript:https://script.google.com/d/${SCRIPT_ID}/edit`,
    ]) {
      expect(parseAppsScriptReference(bad), String(bad)).toBeNull();
    }
  });

  it("only calls projects.get with the extracted ID; projects metadata is projected safely", async () => {
    const f = fixture();
    await authorize(f);
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      scriptId: SCRIPT_ID, title: "PMT - Lịch hoạt động tự động",
      parentId: SHEET_ID, updateTime: "2026-11-05T01:02:03Z",
      creator: { email: "secret-account@example.com" },
      lastModifyUser: { email: "other@example.com" },
    }))).mockResolvedValueOnce(new Response(JSON.stringify({
      scriptId: SCRIPT_ID, title: "Other", parentId: OTHER_ID,
    }))).mockResolvedValueOnce(new Response(JSON.stringify({
      scriptId: SCRIPT_ID, title: "No parent",
    }))).mockResolvedValueOnce(new Response(JSON.stringify({
      scriptId: SCRIPT_ID, title: "Standalone",
    })));
    const checked = await f.manager.resolveAppsScriptReference(`${URL_HOME}?authuser=1`, SHEET_ID);
    expect(checked).toEqual({
      scriptId: SCRIPT_ID,
      scriptTitle: "PMT - Lịch hoạt động tự động",
      modifiedTime: "2026-11-05T01:02:03Z",
      editorUrl: URL_D,
      containerId: SHEET_ID,
      match: "verified",
    });
    expect((await f.manager.resolveAppsScriptReference(URL_D, SHEET_ID)).match).toBe("mismatch");
    expect((await f.manager.resolveAppsScriptReference(SCRIPT_ID, SHEET_ID)).match).toBe("unconfirmed");
    const unpaired = await f.manager.resolveAppsScriptReference(SCRIPT_ID);
    expect(unpaired.match).toBeNull();
    expect(unpaired.containerId).toBeNull();
    expect(unpaired.modifiedTime).toBeNull();
    expect(JSON.stringify(checked)).not.toContain("secret-account");
    expect(f.fetcher.mock.calls).toHaveLength(4);
    for (const [url, init] of f.fetcher.mock.calls) {
      expect(url).toBe(`https://script.googleapis.com/v1/projects/${SCRIPT_ID}`);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer trusted-token");
    }
    await f.manager.shutdown();
  });

  it("fails closed on mismatched IDs, bad references and bad containers without extra fetches", async () => {
    const f = fixture();
    await authorize(f);
    await expect(f.manager.resolveAppsScriptReference("https://attacker.test/script")).rejects
      .toThrow(/Invalid Apps Script ID or Editor URL/);
    await expect(f.manager.resolveAppsScriptReference(URL_D, "bad")).rejects
      .toThrow(/Invalid Google Workspace container ID/);
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      scriptId: OTHER_ID, title: "Wrong",
    })));
    await expect(f.manager.resolveAppsScriptReference(SCRIPT_ID)).rejects
      .toThrow(/different project ID/);
    await f.manager.shutdown();
  });

  it("lists Docs, Sheets, Slides and Forms without ever claiming scriptsEnumerated", async () => {
    const f = fixture();
    await authorize(f, true);
    const types = [
      ["application/vnd.google-apps.spreadsheet", "sheet", "spreadsheets"],
      ["application/vnd.google-apps.document", "doc", "document"],
      ["application/vnd.google-apps.presentation", "slide", "presentation"],
      ["application/vnd.google-apps.form", "form", "forms"],
    ] as const;
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      files: types.map(([mimeType], index) => ({
        id: `file0123456789abcdef${index}`, name: `Test ${index}`, mimeType,
      })),
    })));
    const page = await f.manager.listAppsScriptContainers({ pageSize: 4 });
    expect(page.scriptsEnumerated).toBe(false);
    expect(page.containers.map((item) => item.kind)).toEqual(types.map(([,kind]) => kind));
    for (let index = 0; index < types.length; index++) {
      expect(page.containers[index].editorUrl).toBe(
        `https://docs.google.com/${types[index][2]}/d/file0123456789abcdef${index}/edit`,
      );
    }
    const filter = new URL(f.fetcher.mock.calls[0][0] as string).searchParams.get("q");
    for (const [mimeType] of types) expect(filter).toContain(`mimeType = '${mimeType}'`);
    expect((f.fetcher.mock.calls[0][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer trusted-token");
    await f.manager.shutdown();
  });

  it("rejects smuggled IPC arguments and forged Editor URLs", () => {
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.resolveScriptReference,
      [URL_HOME])).toBe(true);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.resolveScriptReference,
      [URL_D, SHEET_ID])).toBe(true);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.resolveScriptReference,
      [SCRIPT_ID, undefined])).toBe(true);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.resolveScriptReference,
      [`https://evil.test/d/${SCRIPT_ID}/edit`])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.resolveScriptReference,
      [SCRIPT_ID, "bad"])).toBe(false);
    expect(validateGoogleWorkspaceIpc(GOOGLE_WORKSPACE_IPC.resolveScriptReference,
      [SCRIPT_ID, SHEET_ID, true])).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

import type { GoogleWorkspaceManager } from "./google-workspace-manager";
import type { McpExtensionClient } from "./mcp-extension-client";
import { GoogleWorkspaceMcpServer } from "./google-workspace-mcp-server";

describe("Google Workspace first-party MCP gateway", () => {
  it("requires the local bearer and sends write operations through Ask policies", async () => {
    let record: Record<string, unknown> | null = null;
    let credential = "";
    const policies: Array<{ toolName: string; approval: string }> = [];
    const client = {
      list: vi.fn(async () => record ? [record] : []),
      install: vi.fn(async (input: Record<string, unknown>) => {
        record = {
          id: input.id, namespace: input.namespace, source: input.source,
          version: input.version, transport: input.transport,
          auth_type: "bearer", enabled: false, credential_materialized: false,
        };
        return record;
      }),
      materializeCredential: vi.fn(async (_id: string, bearer: string) => {
        credential = bearer;
        if (record) record.credential_materialized = true;
      }),
      enable: vi.fn(async () => {
        if (record) record.enabled = true;
      }),
      disable: vi.fn(async () => {
        if (record) record.enabled = false;
      }),
      listTools: vi.fn(async () => [
        { original_name: "google_workspace_status" },
        { original_name: "apps_script_get_content" },
        { original_name: "apps_script_list_projects" },
        { original_name: "apps_script_list_containers" },
        { original_name: "apps_script_check_bound" },
        { original_name: "apps_script_patch_preview" },
        { original_name: "apps_script_patch_apply" },
        { original_name: "apps_script_comment_preview" },
        { original_name: "apps_script_comment_apply" },
        { original_name: "apps_script_update_content" },
        { original_name: "apps_script_create_deployment" },
        { original_name: "appsheet_find_rows" },
      ]),
      updateToolPolicy: vi.fn(async (policy: { toolName: string; approval: string }) => {
        policies.push(policy);
      }),
      remove: vi.fn(async () => { record = null; }),
    } as unknown as McpExtensionClient;
    const manager = {
      googleStatus: vi.fn(async () => ({
        configured: false, connected: false, mode: null, projectDiscoveryEnabled: false,
      })),
      previewAppsScriptPatch: vi.fn(async () => ({
        scriptId: "abcdefghijklmnopqrstuvwxy1234567890",
        expectedFingerprint: "a".repeat(64),
        expectedPatchedFingerprint: "b".repeat(64),
        planFingerprint: "c".repeat(64),
        editCount: 2, changedFiles: ["Code", "View"],
        fileCount: 3, manifestPreserved: true, wouldChange: true,
      })),
      applyAppsScriptPatch: vi.fn(async () => ({
        scriptId: "abcdefghijklmnopqrstuvwxy1234567890",
        previousFingerprint: "a".repeat(64),
        newFingerprint: "b".repeat(64),
        changedFiles: ["Code", "View"],
        changed: true, verified: true,
      })),
      previewAppsScriptComment: vi.fn(async () => ({
        scriptId: "abcdefghijklmnopqrstuvwxy1234567890",
        fileName: "Shared Helpers.v2",
        commentLine: "// Safe one-line change",
        expectedFingerprint: "a".repeat(64),
        position: "file-start",
        wouldChange: true,
        fileCount: 2,
        manifestPreserved: true,
      })),
      applyAppsScriptComment: vi.fn(async () => ({
        scriptId: "abcdefghijklmnopqrstuvwxy1234567890",
        fileName: "Shared Helpers.v2",
        previousFingerprint: "a".repeat(64),
        newFingerprint: "b".repeat(64),
        changed: true, verified: true,
      })),
      listAppsScriptContainers: vi.fn(async () => ({
        containers: [{ containerId: "document0123456789abcdefgh", name: "PMT plan",
          kind: "doc", modifiedTime: null,
          editorUrl: "https://docs.google.com/document/d/document0123456789abcdefgh/edit" }],
        nextPageToken: null, incompleteSearch: false, scriptsEnumerated: false,
      })),
      checkBoundAppsScript: vi.fn(async () => ({
        scriptId: "abcdefghijklmnopqrstuvwxy1234567890",
        containerId: "document0123456789abcdefgh", scriptTitle: "PMT Script",
        editorUrl: "https://script.google.com/d/abcdefghijklmnopqrstuvwxy1234567890/edit",
        match: "verified",
      })),
      listAppsScriptProjects: vi.fn(async () => ({
        projects: [{
          scriptId: "abcdefghijklmnopqrstuvwxy1234567890",
          name: "Example project",
          modifiedTime: "2026-11-04T00:00:00.000Z",
          editorUrl: "https://script.google.com/d/abcdefghijklmnopqrstuvwxy1234567890/edit",
        }],
        nextPageToken: "page2",
        incompleteSearch: false,
      })),
    } as unknown as GoogleWorkspaceManager;
    const server = new GoogleWorkspaceMcpServer({ manager, client, version: "0.1.44" });
    await server.start();
    try {
      await server.reconcile();
      expect(credential.length).toBeGreaterThan(30);
      expect(policies.find((p) => p.toolName === "apps_script_update_content")?.approval).toBe("ask");
      expect(policies.find((p) => p.toolName === "apps_script_create_deployment")?.approval).toBe("ask");
      expect(policies.find((p) => p.toolName === "appsheet_find_rows")?.approval).toBe("ask");
      expect(policies.find((p) => p.toolName === "google_workspace_status")?.approval).toBe("automatic");
      expect(policies.find((p) => p.toolName === "apps_script_list_projects")?.approval).toBe("automatic");
      expect(policies.find((p) => p.toolName === "apps_script_list_containers")?.approval).toBe("automatic");
      expect(policies.find((p) => p.toolName === "apps_script_check_bound")?.approval).toBe("automatic");
      expect(policies.find((p) => p.toolName === "apps_script_patch_preview")?.approval).toBe("automatic");
      expect(policies.find((p) => p.toolName === "apps_script_patch_apply")?.approval).toBe("ask");
      expect(policies.find((p) => p.toolName === "apps_script_comment_preview")?.approval).toBe("automatic");
      expect(policies.find((p) => p.toolName === "apps_script_comment_apply")?.approval).toBe("ask");

      const send = async (authorization: string, method: string, params: Record<string, unknown> = {}) => {
        return fetch(server.url(), {
          method: "POST",
          headers: { "content-type": "application/json", authorization },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
      };

      const denied = await send("Bearer wrong", "tools/list");
      expect(denied.status).toBe(401);
      const allowed = await send(`Bearer ${credential}`, "tools/list");
      expect(allowed.status).toBe(200);
      const catalog = await allowed.json() as { result: { tools: Array<{ name: string }> } };
      expect(catalog.result.tools.some((tool) => tool.name === "apps_script_get_content")).toBe(true);
      expect(catalog.result.tools.some((tool) => tool.name === "apps_script_list_projects")).toBe(true);
      expect(catalog.result.tools.some((tool) => tool.name === "apps_script_list_containers")).toBe(true);
      expect(catalog.result.tools.some((tool) => tool.name === "apps_script_check_bound")).toBe(true);
      expect(catalog.result.tools.some((tool) => tool.name === "apps_script_patch_preview")).toBe(true);
      expect(catalog.result.tools.some((tool) => tool.name === "apps_script_patch_apply")).toBe(true);
      expect(catalog.result.tools.some((tool) => tool.name === "apps_script_comment_preview")).toBe(true);
      expect(catalog.result.tools.some((tool) => tool.name === "apps_script_comment_apply")).toBe(true);
      expect(catalog.result.tools.some((tool) => tool.name === "appsheet_key_set")).toBe(false);

      const result = await send(`Bearer ${credential}`, "tools/call", {
        name: "google_workspace_status", arguments: {},
      });
      expect(result.status).toBe(200);
      const payload = await result.json() as { result: { structuredContent: { configured: boolean } } };
      expect(payload.result.structuredContent.configured).toBe(false);
      expect(manager.googleStatus).toHaveBeenCalledTimes(1);

      const listed = await send(`Bearer ${credential}`, "tools/call", {
        name: "apps_script_list_projects",
        arguments: { pageSize: 20, pageToken: "page1" },
      });
      expect(listed.status).toBe(200);
      const listing = await listed.json() as {
        result: { structuredContent: { projects: Array<{ name: string }>; nextPageToken: string } };
      };
      expect(listing.result.structuredContent.projects[0].name).toBe("Example project");
      expect(listing.result.structuredContent.nextPageToken).toBe("page2");
      expect(manager.listAppsScriptProjects).toHaveBeenCalledWith({ pageSize: 20, pageToken: "page1" });

      const containerListed = await send(`Bearer ${credential}`, "tools/call", {
        name: "apps_script_list_containers",
        arguments: { query: "PMT", pageSize: 10 },
      });
      const candidatePayload = await containerListed.json() as {
        result: { structuredContent: { scriptsEnumerated: boolean; containers: Array<{ name: string }> } };
      };
      expect(candidatePayload.result.structuredContent.scriptsEnumerated).toBe(false);
      expect(candidatePayload.result.structuredContent.containers[0].name).toBe("PMT plan");
      expect(manager.listAppsScriptContainers).toHaveBeenCalledWith({ query: "PMT", pageSize: 10 });

      const checked = await send(`Bearer ${credential}`, "tools/call", {
        name: "apps_script_check_bound",
        arguments: { scriptId: "abcdefghijklmnopqrstuvwxy1234567890",
          containerId: "document0123456789abcdefgh" },
      });
      const checkedPayload = await checked.json() as {
        result: { structuredContent: { match: string } };
      };
      expect(checkedPayload.result.structuredContent.match).toBe("verified");
      expect(manager.checkBoundAppsScript).toHaveBeenCalledWith(
        "abcdefghijklmnopqrstuvwxy1234567890", "document0123456789abcdefgh",
      );

      const scriptId = "abcdefghijklmnopqrstuvwxy1234567890";
      const preview = await send(`Bearer ${credential}`, "tools/call", {
        name: "apps_script_comment_preview",
        arguments: { scriptId, commentLine: "// Safe one-line change" },
      });
      const previewPayload = await preview.json() as {
        result: { structuredContent: { expectedFingerprint: string; fileName: string } };
      };
      expect(previewPayload.result.structuredContent.expectedFingerprint).toBe("a".repeat(64));
      expect(previewPayload.result.structuredContent.fileName).toBe("Shared Helpers.v2");
      expect(manager.previewAppsScriptComment).toHaveBeenCalledWith({
        scriptId, commentLine: "// Safe one-line change",
      });

      const applied = await send(`Bearer ${credential}`, "tools/call", {
        name: "apps_script_comment_apply",
        arguments: {
          scriptId, fileName: "Shared Helpers.v2", commentLine: "// Safe one-line change",
          expectedFingerprint: "a".repeat(64), confirmed: true,
        },
      });
      const appliedPayload = await applied.json() as {
        result: { structuredContent: { changed: boolean; verified: boolean } };
      };
      expect(appliedPayload.result.structuredContent).toMatchObject({
        changed: true, verified: true,
      });
      expect(manager.applyAppsScriptComment).toHaveBeenCalledWith({
        scriptId, fileName: "Shared Helpers.v2", commentLine: "// Safe one-line change",
        expectedFingerprint: "a".repeat(64), confirmed: true,
      });

      const edits = [
        { fileName: "Code", operation: "replace_exact", findText: "return 1;", text: "return 2;" },
        { fileName: "View", operation: "prepend", text: "<!-- updated -->" },
      ];
      const patchPreview = await send(`Bearer ${credential}`, "tools/call", {
        name: "apps_script_patch_preview", arguments: { scriptId, edits },
      });
      const patchPreviewPayload = await patchPreview.json() as {
        result: { structuredContent: { editCount: number; planFingerprint: string } };
      };
      expect(patchPreviewPayload.result.structuredContent.editCount).toBe(2);
      expect(patchPreviewPayload.result.structuredContent.planFingerprint).toBe("c".repeat(64));
      expect(manager.previewAppsScriptPatch).toHaveBeenCalledWith({ scriptId, edits });
      const patchApply = await send(`Bearer ${credential}`, "tools/call", {
        name: "apps_script_patch_apply",
        arguments: { scriptId, edits, expectedFingerprint: "a".repeat(64),
          expectedPatchedFingerprint: "b".repeat(64), planFingerprint: "c".repeat(64),
          confirmed: true },
      });
      const patchApplyPayload = await patchApply.json() as {
        result: { structuredContent: { changed: boolean; verified: boolean } };
      };
      expect(patchApplyPayload.result.structuredContent).toMatchObject({
        changed: true, verified: true,
      });
      expect(manager.applyAppsScriptPatch).toHaveBeenCalledWith({
        scriptId, edits, expectedFingerprint: "a".repeat(64),
        expectedPatchedFingerprint: "b".repeat(64), planFingerprint: "c".repeat(64),
        confirmed: true,
      });

      // A user's disable decision must not be undone by periodic discovery.
      await client.disable("sourcenerve-google-workspace");
      const enableCount = vi.mocked(client.enable).mock.calls.length;
      await server.reconcile();
      expect(vi.mocked(client.enable)).toHaveBeenCalledTimes(enableCount);
    } finally {
      await server.stop();
    }
  });
});

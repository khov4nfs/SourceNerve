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
      googleStatus: vi.fn(async () => ({ configured: false, connected: false, mode: null })),
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
      expect(catalog.result.tools.some((tool) => tool.name === "appsheet_key_set")).toBe(false);

      const result = await send(`Bearer ${credential}`, "tools/call", {
        name: "google_workspace_status", arguments: {},
      });
      expect(result.status).toBe(200);
      const payload = await result.json() as { result: { structuredContent: { configured: boolean } } };
      expect(payload.result.structuredContent.configured).toBe(false);
      expect(manager.googleStatus).toHaveBeenCalledTimes(1);

      // A user's disable decision must not be undone by periodic discovery.
      if (record) record.enabled = false;
      const enableCount = vi.mocked(client.enable).mock.calls.length;
      await server.reconcile();
      expect(vi.mocked(client.enable)).toHaveBeenCalledTimes(enableCount);
    } finally {
      await server.stop();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpExtensionClient } from "./mcp-extension-client";
import { McpExtensionOAuthManager, applyGoogleOfflineOAuthParameters } from "./mcp-extension-oauth";
import type { EncryptedSecretStore } from "./secure-store";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Workspace OAuth offline scope handling", () => {
  it("requests offline access only for Google's official authorization endpoint", () => {
    const google = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    google.searchParams.set("code_challenge_method", "S256");
    applyGoogleOfflineOAuthParameters(google);
    expect(google.searchParams.get("access_type")).toBe("offline");
    expect(google.searchParams.get("include_granted_scopes")).toBe("true");
    expect(google.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("does not alter third-party authorization servers or lookalike URLs", () => {
    for (const value of [
      "https://accounts.google.com.evil.test/o/oauth2/v2/auth",
      "https://login.example.test/o/oauth2/v2/auth",
      "https://accounts.google.com/not-an-oauth-endpoint",
    ]) {
      const authorization = new URL(value);
      applyGoogleOfflineOAuthParameters(authorization);
      expect(authorization.searchParams.has("access_type")).toBe(false);
      expect(authorization.searchParams.has("include_granted_scopes")).toBe(false);
    }
  });
});

describe("McpExtensionOAuthManager Dynamic Client Registration", () => {
  it("reports an HTTP registration rejection instead of invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>forbidden</html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    })));
    const values = new Map<string, string>();
    const secretStore = {
      setOpaque: async (key: string, value: string) => { values.set(key, value); },
      getOpaque: async (key: string) => values.get(key) ?? null,
      deleteOpaque: async (key: string) => { values.delete(key); },
    } as unknown as EncryptedSecretStore;
    const client = {
      clearCredential: async () => ({}),
      materializeCredential: async () => ({}),
    } as unknown as McpExtensionClient;
    const manager = new McpExtensionOAuthManager({
      secretStore,
      client,
      openExternal: async () => undefined,
    });
    await manager.saveConfig("example", {
      authorizationEndpoint: "https://auth.example.test/authorize",
      tokenEndpoint: "https://auth.example.test/token",
      registrationEndpoint: "https://auth.example.test/register",
      scopes: ["read"],
    });

    await expect(manager.connect("example")).rejects.toThrow(
      "MCP extension OAuth client registration failed: registration_failed (HTTP 403)",
    );
    await manager.shutdown();
  });
});

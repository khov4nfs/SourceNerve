import type { SourceNerveDesktopApi } from "../shared/desktop-api";
import type { McpExtensionApi } from "../shared/mcp-extension-api";
import type { SourceNerveUpdateApi } from "../shared/update-api";
import type { GoogleWorkspaceApi } from "../shared/google-workspace-api";

declare global {
  interface Window {
    sourcenerveDesktop: SourceNerveDesktopApi;
    sourcenerveMcpExtensions: McpExtensionApi;
    sourcenerveGoogleWorkspace: GoogleWorkspaceApi;
    sourcenerveUpdate: SourceNerveUpdateApi;
  }
}

export {};

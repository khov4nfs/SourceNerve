import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const extensionPath = new URL("../integrations/google-workspace/clasp-mcp.extension.json", import.meta.url);
const skillPath = new URL(
  "../plugins/sourcenerve/skills/google-workspace-apps-script-appsheet/SKILL.md",
  import.meta.url,
);
const pluginPath = new URL("../plugins/sourcenerve/.codex-plugin/plugin.json", import.meta.url);
const documentationPath = new URL("../docs/google-workspace-chatgpt-agent.md", import.meta.url);
const oauthPolicyPath = new URL("../integrations/google-workspace/google-oauth.policy.json", import.meta.url);
const oauthDesignPath = new URL("../docs/google-workspace-oauth-design.md", import.meta.url);

const extension = JSON.parse(await readFile(extensionPath, "utf8"));
const skill = await readFile(skillPath, "utf8");
const plugin = JSON.parse(await readFile(pluginPath, "utf8"));
const doc = await readFile(documentationPath, "utf8");
const oauthPolicy = JSON.parse(await readFile(oauthPolicyPath, "utf8"));
const oauthDesign = await readFile(oauthDesignPath, "utf8");

assert.equal(extension.id, "google-clasp-mcp");
assert.equal(extension.namespace, "clasp");
assert.equal(extension.source, "https://github.com/google/clasp");
assert.equal(extension.transport.transport, "stdio");
assert.equal(extension.transport.command, "npx");
assert.equal(extension.version, "3.4.1");
assert.deepEqual(extension.transport.args, ["-y", "@google/clasp@3.4.1", "mcp"]);
assert.equal(extension.auth_type, "none");
assert.equal(extension.required, false);
assert.equal(extension.update_channel, "stable");
assert.equal(extension.secret_ref, undefined);
assert.equal(extension.credential, undefined);
assert.equal(extension.environment, undefined);
assert.equal(plugin.skills, "./skills/");

assert.match(skill, /^---\nname: google-workspace-apps-script-appsheet\n/);
for (const target of ["Apps Script", "AppSheet Editor", "Views", "Actions", "Bots", "Expressions"]) {
  assert.ok(skill.includes(target), `the Google Workspace skill must cover ${target}`);
}
for (const invariant of [
  "HOME riêng",
  "BLOCKED (authentication)",
  "AppSheet sign-in",
  "review",
  "projects.updateContent",
]) {
  assert.ok(skill.includes(invariant), `the skill must explain ${invariant}`);
}

for (const invariant of [
  "HOME",
  "BLOCKED: clasp OAuth",
  "readOnlyHint=false",
  "Views, Actions, Bots, Expressions",
  "projects.updateContent",
  "chưa",
]) {
  assert.ok(doc.includes(invariant), `the setup guide must describe ${invariant}`);
}

assert.equal(oauthPolicy.provider, "google");
assert.equal(oauthPolicy.authorization_flow, "authorization_code_pkce");
assert.equal(oauthPolicy.client_type, "desktop");
assert.equal(oauthPolicy.pkce_method, "S256");
assert.equal(oauthPolicy.redirect, "http://127.0.0.1:{ephemeral-port}/oauth/callback");
assert.equal(oauthPolicy.authorization_endpoint, "https://accounts.google.com/o/oauth2/v2/auth");
assert.equal(oauthPolicy.token_endpoint, "https://oauth2.googleapis.com/token");
assert.equal(oauthPolicy.credential_storage, "os_encrypted_secure_store_per_account_and_installation");
assert.equal(oauthPolicy.appsheet.data_api, "per_app_application_access_key_enterprise_only");
assert.equal(oauthPolicy.appsheet.editor, "interactive_google_sign_in_in_browser");
assert.equal(oauthPolicy.consent, "explicit_scope_mode_reconsent_for_desktop");
assert.ok(oauthPolicy.scope_sets.apps_script_read.includes("https://www.googleapis.com/auth/script.projects.readonly"));
assert.ok(oauthPolicy.scope_sets.apps_script_edit.includes("https://www.googleapis.com/auth/script.projects"));
assert.ok(oauthPolicy.scope_sets.apps_script_deploy.includes("https://www.googleapis.com/auth/script.deployments"));
assert.deepEqual(oauthPolicy.scope_sets.apps_script_discovery_opt_in, ["https://www.googleapis.com/auth/drive.metadata.readonly"]);
assert.ok(!JSON.stringify(oauthPolicy.scope_sets).includes("https://www.googleapis.com/auth/drive\""));
for (const requirement of ["PKCE", "ApplicationAccessKey", "clasp", "OS EncryptedSecretStore", "oauth2.googleapis.com/revoke", "không"]) {
  assert.ok(oauthDesign.includes(requirement), `OAuth design must document ${requirement}`);
}

for (const [name, contents] of [
  ["registration", JSON.stringify(extension)],
  ["skill", skill],
  ["guide", doc],
  ["oauth policy", JSON.stringify(oauthPolicy)],
  ["oauth design", oauthDesign],
]) {
  assert.doesNotMatch(contents, /\b(ya29\.[a-z0-9._-]{15,}|ghp_[a-z0-9]{20,}|AIza[a-z0-9_-]{30,})/i,
    `${name} must not include live tokens or API keys`);
}

console.log("verified Google Workspace clasp MCP template, OAuth PKCE/AppSheet key policy, skill routing, and auth/deploy safeguards");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const extensionPath = new URL("../integrations/google-workspace/clasp-mcp.extension.json", import.meta.url);
const skillPath = new URL(
  "../plugins/sourcenerve/skills/google-workspace-apps-script-appsheet/SKILL.md",
  import.meta.url,
);
const pluginPath = new URL("../plugins/sourcenerve/.codex-plugin/plugin.json", import.meta.url);
const documentationPath = new URL("../docs/google-workspace-chatgpt-agent.md", import.meta.url);

const extension = JSON.parse(await readFile(extensionPath, "utf8"));
const skill = await readFile(skillPath, "utf8");
const plugin = JSON.parse(await readFile(pluginPath, "utf8"));
const doc = await readFile(documentationPath, "utf8");

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

for (const [name, contents] of [
  ["registration", JSON.stringify(extension)],
  ["skill", skill],
  ["guide", doc],
]) {
  assert.doesNotMatch(contents, /\b(ya29\.[a-z0-9._-]{15,}|ghp_[a-z0-9]{20,}|AIza[a-z0-9_-]{30,})/i,
    `${name} must not include live tokens or API keys`);
}

console.log("verified Google Workspace clasp MCP template, skill routing, and auth/deploy safeguards");

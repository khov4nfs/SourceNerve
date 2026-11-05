/** Resolve only an Apps Script ID or a genuine editor URL, never an arbitrary URL.
 * The returned ID is used solely with the fixed Apps Script projects.get API.
 * Query strings and fragments are discarded and are never sent to Google.
 */
const SCRIPT_ID = /^[A-Za-z0-9_-]{12,160}$/;

export function parseAppsScriptReference(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 512 || /[\u0000-\u001f\u007f]/.test(input)) return null;
  const value = input.trim();
  if (SCRIPT_ID.test(value)) return value;
  if (!value.startsWith("https://")) return null;
  let url: URL;
  try { url = new URL(value); }
  catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "script.google.com" ||
    url.username || url.password || url.port) return null;
  const match = /^\/(?:d|home\/projects)\/([A-Za-z0-9_-]{12,160})(?:\/edit)?\/?$/.exec(url.pathname);
  return match?.[1] ?? null;
}

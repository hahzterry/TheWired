/**
 * Redaction for crash records.
 *
 * A crash record is the one piece of diagnostic state that survives a reload
 * and that a user may paste into a bug report, so it must be safe to share
 * as-is. Error messages and stacks are attacker- and data-influenced: a
 * `JSON.parse` failure quotes the text it choked on, a thrown string can be an
 * event's content, a URL can carry a media token. Everything that reaches the
 * record passes through here first.
 *
 * The rule is "keep the shape, drop the payload": error names, property names
 * and stack frames survive; quoted text, identifiers that can be keys, and
 * anything after a `?` in a URL do not.
 */

const MAX_MESSAGE_CHARS = 300;
const MAX_FRAMES = 20;
const MAX_FRAME_CHARS = 200;
const MAX_COMPONENT_FRAMES = 15;

/** Route segments that are fixed parts of the app's URL space. */
const STATIC_ROUTE_SEGMENTS = new Set([
  "relays",
  "settings",
  "discover",
  "dm",
  "music",
  "album",
  "track",
  "playlist",
  "write",
  "article",
  "note",
  "profile",
  "invite",
]);

// Order matters: URI schemes that embed secrets go first so their payload is
// removed whole, before the narrower patterns could leave fragments behind.
const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:bunker|nostrconnect|nostr\+walletconnect):\/\/[^\s"'`<>)]+/gi, "[redacted-uri]"],
  [/\bnsec1[02-9ac-hj-np-z]+/gi, "[redacted-nsec]"],
  [/\bncryptsec1[02-9ac-hj-np-z]+/gi, "[redacted-ncryptsec]"],
  [/\b(?:npub|note|nevent|nprofile|naddr|nrelay|lnurl|lnbc|cashu[ab])1?[02-9ac-hj-np-z]{20,}/gi, "[redacted-id]"],
  // 64 hex chars is a pubkey, an event id, or a raw secret key. They are
  // indistinguishable, so all of them go.
  [/\b[0-9a-f]{64}\b/gi, "[redacted-hex]"],
  // Longer hex runs: signatures, conversation keys, hashes.
  [/\b[0-9a-f]{40,}\b/gi, "[redacted-hex]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\b(Bearer|Nostr|Basic)\s+[A-Za-z0-9+/=_.-]{16,}/g, "$1 [redacted]"],
  // Query strings and fragments carry tokens (`?tk=`, invite codes, relay auth).
  [/((?:https?|wss?|tauri|blob|file|asset):\/\/[^\s"'`<>)?#]*)[?#][^\s"'`<>):]*/gi, "$1"],
];

/**
 * Any remaining long opaque run: base64 payloads, JWTs, ciphertext. Applied to
 * messages only. Stack frames hold function names and source paths, and a deep
 * source path is itself a long run of these characters.
 */
const OPAQUE_RUN = /[A-Za-z0-9+/_=-]{40,}/g;

/** Strip key material, identifiers and URL parameters from a single string. */
export function redactTokens(input: string): string {
  let out = input;
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Redact an error message. On top of {@link redactTokens}, quoted text is
 * dropped: engines quote the offending input in parse errors
 * (`Unexpected token 'h', "hello wor"... is not valid JSON`), and that input
 * is typically event content or a decrypted message. A single-quoted
 * identifier or index (`reading 'foo'`, `reading '0'`) is kept because it
 * names code, and without source maps it is the most useful part of the line.
 */
export function redactMessage(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  // Only the first line: later lines of a multi-line message are free text.
  const firstLine = raw.split("\n", 1)[0] ?? "";
  let out = redactTokens(firstLine).replace(OPAQUE_RUN, "[redacted-blob]");
  out = out.replace(/"[^"]*"/g, '"[redacted]"');
  out = out.replace(/`[^`]*`/g, "`[redacted]`");
  out = out.replace(/'([^']*)'/g, (match, inner: string) =>
    /^(?:[A-Za-z_$][\w$]{1,39}|\d{1,4})$/.test(inner) ? match : "'[redacted]'",
  );
  out = out.trim();
  if (out.length > MAX_MESSAGE_CHARS) out = `${out.slice(0, MAX_MESSAGE_CHARS)}…`;
  return out || "(no message)";
}

/** True for a line that is a stack frame rather than message text. */
function isStackFrame(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("at ")) return true; // V8 / React component stacks
  // WebKit / Gecko: `fn@url:line:col` or a bare `url:line:col`.
  return /^[^\s@]*@.+:\d+(?::\d+)?$/.test(trimmed) || /^\S+:\/\/\S+:\d+:\d+$/.test(trimmed);
}

function redactFrames(stack: unknown, maxFrames: number): string | undefined {
  if (typeof stack !== "string" || stack.length === 0) return undefined;
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    // Non-frame lines are the message echoed back by the engine. The message
    // is stored separately (redacted), so they are dropped here.
    if (!isStackFrame(line)) continue;
    let frame = redactTokens(line.trim());
    if (frame.length > MAX_FRAME_CHARS) frame = `${frame.slice(0, MAX_FRAME_CHARS)}…`;
    frames.push(frame);
    if (frames.length >= maxFrames) break;
  }
  return frames.length > 0 ? frames.join("\n") : undefined;
}

/** Keep only the frames of a JS stack; the leading message lines are dropped. */
export function redactStack(stack: unknown): string | undefined {
  return redactFrames(stack, MAX_FRAMES);
}

/** Keep only the frames of a React component stack. */
export function redactComponentStack(stack: unknown): string | undefined {
  return redactFrames(stack, MAX_COMPONENT_FRAMES);
}

/**
 * Reduce a pathname to its route pattern. Dynamic segments are pubkeys, note
 * ids, invite codes and slugs, so every segment that is not a known static
 * part of the URL space becomes `:id`. Query and hash are dropped.
 */
export function sanitizeRoute(pathname: unknown): string {
  if (typeof pathname !== "string" || pathname.length === 0) return "/";
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  const segments = path
    .split("/")
    .filter(Boolean)
    .slice(0, 6)
    .map((segment) => (STATIC_ROUTE_SEGMENTS.has(segment) ? segment : ":id"));
  return `/${segments.join("/")}`;
}

/** An error name is code, but it is still attacker-influenced: keep it short and plain. */
export function sanitizeName(name: unknown): string {
  if (typeof name !== "string") return "Error";
  const cleaned = name.replace(/[^\w$.]/g, "").slice(0, 60);
  return cleaned || "Error";
}

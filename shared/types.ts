/**
 * Canonical event shapes shared by the pi observability extension and the
 * Bun observability server.
 *
 * Both sides MUST agree on these. If you change a shape, change it here first
 * and announce it before touching either consumer.
 */

// ─── Event envelope ─────────────────────────────────────────────────────────

export type ObsEventType =
  | "session_start"
  | "session_shutdown"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "model_change"
  | "thinking"
  | "error"
  | "custom"
  | "compaction"
  | "branch_nav";

export interface ObsEventEnvelope<P = unknown> {
  /** uuid v4, client-generated, primary key on the server */
  event_id: string;
  /** ISO-8601 with milliseconds, client clock */
  ts: string;
  /** discriminator for `payload` */
  type: ObsEventType;

  // ── identity ──
  /** pi session uuid (stable for the life of one pi session) */
  session_id: string;
  /** absolute path to session.jsonl, if pi has one */
  session_file?: string;
  /** the agent's working directory at session_start */
  cwd: string;
  /** human-friendly name from --o-name (optional) */
  agent_name?: string;
  /** logical bucket from --o-pool, defaults to "default" */
  pool: string;
  /** flat tag list from --o-tag (may be empty, never undefined) */
  tags: string[];

  // ── model ──
  provider?: string;
  model?: string;

  // ── payload + ordering ──
  payload: P;
  /** monotonic per session_id, starts at 0 */
  seq: number;
}

// ─── Payloads ───────────────────────────────────────────────────────────────

export interface SessionStartPayload {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  pi_version?: string;
  previous_session_file?: string;
}

export interface SessionShutdownPayload {
  reason: "quit" | "reload" | "new" | "resume" | "fork";
}

export interface AgentStartPayload {
  prompt: string;
  images_count: number;
  /** Pi session id this snapshot belongs to. Duplicated from the envelope so a payload-only consumer is self-contained. */
  session_id?: string;
  /** Pi session.jsonl path, when one exists. */
  session_file?: string;
  /** Fully assembled system prompt for this turn. Truncated to MAX_TEXT_FIELD. */
  system_prompt?: string;
  /** Pre-truncation byte length of the system prompt. */
  system_prompt_bytes?: number;
  /** SHA-256 hex digest of the full pre-truncation system prompt. Lets the UI detect drift turn-over-turn without storing the full string. */
  system_prompt_sha256?: string;
  /** Whether system_prompt was truncated to MAX_TEXT_FIELD. */
  system_prompt_truncated?: boolean;
  /** Structured digest of pi's BuildSystemPromptOptions for this turn. */
  system_prompt_options?: SystemPromptOptionsDigest;
}

/** Digest of pi's BuildSystemPromptOptions — what pi loaded into the system prompt for this turn. */
export interface SystemPromptOptionsDigest {
  cwd?: string;
  /** Tool names selected for the prompt (e.g. ["read","bash","edit","write"]). */
  selected_tools?: string[];
  /** Optional one-line tool snippets keyed by tool name. */
  tool_snippets?: Record<string, string>;
  /** Additional guideline bullets appended to the default prompt guidelines. */
  prompt_guidelines?: string[];
  /** Captured when --system-prompt is set. */
  custom_prompt?: PromptText;
  /** Captured when --append-system-prompt is set. */
  append_system_prompt?: PromptText;
  /** Pre-loaded context files (AGENTS.md / CLAUDE.md / etc.). */
  context_files?: ContextFileDigest[];
  /** Pre-loaded skills with file metadata + content digest. */
  skills?: SkillDigest[];
}

/** Captured prompt-text field: truncated text + byte length + sha256 of full pre-truncation content. */
export interface PromptText {
  text: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
}

/** Digest of a single context file pi folded into the system prompt. */
export interface ContextFileDigest {
  path: string;
  bytes: number;
  sha256: string;
  /** File content, truncated to MAX_TEXT_FIELD. */
  content: string;
  truncated: boolean;
}

/** Digest of a single skill loaded for this turn. */
export interface SkillDigest {
  name: string;
  description: string;
  file_path: string;
  base_dir: string;
  /** SourceInfo.scope: "user" | "project" | "temporary". */
  source_scope?: string;
  /** SourceInfo.origin: "package" | "top-level". */
  source_origin?: string;
  /** SourceInfo.source — the package or path the skill came from. */
  source?: string;
  /** SourceInfo.path — full path pi resolved the skill from. */
  source_path?: string;
  disable_model_invocation: boolean;
  /** Skill file body, truncated to MAX_TEXT_FIELD. Empty string when the file could not be read. */
  content: string;
  /** Pre-truncation byte length of the skill file. 0 when unreadable. */
  bytes: number;
  /** SHA-256 hex of the full skill file. Empty string when unreadable. */
  sha256: string;
  truncated: boolean;
  /** Set when fs read failed (file missing, permission, etc.). */
  read_error?: string;
}

export interface AgentEndPayload {
  message_count: number;
}

export interface TurnStartPayload {
  turn_index: number;
}

export interface TurnEndPayload {
  turn_index: number;
  usage?: UsageSummary;
}

export interface UserMessagePayload {
  text: string;
  images_count: number;
}

export interface AssistantMessagePayload {
  text: string;
  thinking: string;
  tool_call_ids: string[];
  stop_reason: "stop" | "length" | "toolUse" | "error" | "aborted" | string;
  usage: UsageSummary;
  error_message?: string;
  /** turn_start → message_end (wall-clock). Includes prefill + generation. */
  latency_ms?: number;
  /** turn_start → first text/thinking delta (TTFT). Missing on non-streaming turns. */
  prefill_ms?: number;
  /** first delta → message_end. Missing on non-streaming turns. */
  generation_ms?: number;
  /** usage.output / (generation_ms / 1000), int-rounded. Missing on non-streaming turns. */
  output_tps?: number;
  turn_index?: number;
}

export interface ToolCallPayload {
  tool_call_id: string;
  tool_name: string;
  /** parsed args; large blobs may be truncated, see args_truncated */
  args: Record<string, unknown>;
  args_truncated: boolean;
}

export interface ToolResultPayload {
  tool_call_id: string;
  tool_name: string;
  /** concatenated text content from result blocks; may be truncated */
  content_text: string;
  content_truncated: boolean;
  is_error: boolean;
  /** small JSON-safe summary of details (exit_code etc.); never the full blob */
  details_summary?: Record<string, unknown>;
}

export interface ModelChangePayload {
  provider: string;
  model: string;
  previous_provider?: string;
  previous_model?: string;
  source: "set" | "cycle" | "restore" | string;
}

export interface ThinkingPayload {
  text: string;
}

export interface ErrorPayload {
  message: string;
  where: string;
}

export interface CustomPayload {
  custom_type: string;
  data: unknown;
}

export interface CompactionPayload {
  reason: "manual" | "auto";
  tokens_before: number;
  first_kept_entry_id: string;
  summary_preview: string;
}

export interface BranchNavPayload {
  from_id: string;
  to_id: string;
  has_summary: boolean;
  summary_preview?: string;
}

export interface UsageSummary {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cost_total: number;
}

// ─── Discriminated union ────────────────────────────────────────────────────

export type ObsEvent =
  | (ObsEventEnvelope<SessionStartPayload> & { type: "session_start" })
  | (ObsEventEnvelope<SessionShutdownPayload> & { type: "session_shutdown" })
  | (ObsEventEnvelope<AgentStartPayload> & { type: "agent_start" })
  | (ObsEventEnvelope<AgentEndPayload> & { type: "agent_end" })
  | (ObsEventEnvelope<TurnStartPayload> & { type: "turn_start" })
  | (ObsEventEnvelope<TurnEndPayload> & { type: "turn_end" })
  | (ObsEventEnvelope<UserMessagePayload> & { type: "user_message" })
  | (ObsEventEnvelope<AssistantMessagePayload> & { type: "assistant_message" })
  | (ObsEventEnvelope<ToolCallPayload> & { type: "tool_call" })
  | (ObsEventEnvelope<ToolResultPayload> & { type: "tool_result" })
  | (ObsEventEnvelope<ModelChangePayload> & { type: "model_change" })
  | (ObsEventEnvelope<ThinkingPayload> & { type: "thinking" })
  | (ObsEventEnvelope<ErrorPayload> & { type: "error" })
  | (ObsEventEnvelope<CustomPayload> & { type: "custom" })
  | (ObsEventEnvelope<CompactionPayload> & { type: "compaction" })
  | (ObsEventEnvelope<BranchNavPayload> & { type: "branch_nav" });

const EVENT_TYPES = new Set<ObsEventType>([
  "session_start",
  "session_shutdown",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "model_change",
  "thinking",
  "error",
  "custom",
  "compaction",
  "branch_nav",
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!plainRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function stringValue(value: unknown): value is string {
  return typeof value === "string";
}

function nonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(stringValue);
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return finiteNonnegative(value) && Number.isInteger(value);
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(record, key) || stringValue(record[key]);
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(record, key) || typeof record[key] === "boolean";
}

function optionalNumber(record: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(record, key) || finiteNonnegative(record[key]);
}

const MAX_JSON_DEPTH = 100;

function jsonValue(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => jsonValue(item, seen, depth + 1))
    : plainRecord(value) && Object.values(value).every((item) => jsonValue(item, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function validateUsage(value: unknown): boolean {
  const keys = ["input", "output", "cache_read", "cache_write", "total_tokens", "cost_total"];
  return exactKeys(value, keys) && keys.every((key) => finiteNonnegative(value[key]));
}

function validatePromptText(value: unknown): boolean {
  return (
    exactKeys(value, ["text", "bytes", "sha256", "truncated"]) &&
    stringValue(value["text"]) &&
    nonnegativeInteger(value["bytes"]) &&
    stringValue(value["sha256"]) &&
    typeof value["truncated"] === "boolean"
  );
}

function validateContextFile(value: unknown): boolean {
  return (
    exactKeys(value, ["path", "bytes", "sha256", "content", "truncated"]) &&
    stringValue(value["path"]) &&
    nonnegativeInteger(value["bytes"]) &&
    stringValue(value["sha256"]) &&
    stringValue(value["content"]) &&
    typeof value["truncated"] === "boolean"
  );
}

function validateSkill(value: unknown): boolean {
  if (
    !exactKeys(
      value,
      [
        "name",
        "description",
        "file_path",
        "base_dir",
        "disable_model_invocation",
        "content",
        "bytes",
        "sha256",
        "truncated",
      ],
      ["source_scope", "source_origin", "source", "source_path", "read_error"],
    )
  )
    return false;
  return (
    stringValue(value["name"]) &&
    stringValue(value["description"]) &&
    stringValue(value["file_path"]) &&
    stringValue(value["base_dir"]) &&
    typeof value["disable_model_invocation"] === "boolean" &&
    stringValue(value["content"]) &&
    nonnegativeInteger(value["bytes"]) &&
    stringValue(value["sha256"]) &&
    typeof value["truncated"] === "boolean" &&
    optionalString(value, "source_scope") &&
    optionalString(value, "source_origin") &&
    optionalString(value, "source") &&
    optionalString(value, "source_path") &&
    optionalString(value, "read_error")
  );
}

function validateStringRecord(value: unknown): boolean {
  return plainRecord(value) && Object.values(value).every(stringValue);
}

function validateSystemPromptOptions(value: unknown): boolean {
  if (
    !exactKeys(
      value,
      [],
      [
        "cwd",
        "selected_tools",
        "tool_snippets",
        "prompt_guidelines",
        "custom_prompt",
        "append_system_prompt",
        "context_files",
        "skills",
      ],
    )
  )
    return false;
  return (
    optionalString(value, "cwd") &&
    (!Object.hasOwn(value, "selected_tools") || stringArray(value["selected_tools"])) &&
    (!Object.hasOwn(value, "tool_snippets") || validateStringRecord(value["tool_snippets"])) &&
    (!Object.hasOwn(value, "prompt_guidelines") || stringArray(value["prompt_guidelines"])) &&
    (!Object.hasOwn(value, "custom_prompt") || validatePromptText(value["custom_prompt"])) &&
    (!Object.hasOwn(value, "append_system_prompt") ||
      validatePromptText(value["append_system_prompt"])) &&
    (!Object.hasOwn(value, "context_files") ||
      (Array.isArray(value["context_files"]) &&
        value["context_files"].every(validateContextFile))) &&
    (!Object.hasOwn(value, "skills") ||
      (Array.isArray(value["skills"]) && value["skills"].every(validateSkill)))
  );
}

function validatePayload(type: ObsEventType, value: unknown): boolean {
  if (!plainRecord(value)) return false;
  switch (type) {
    case "session_start":
      return (
        exactKeys(value, ["reason"], ["pi_version", "previous_session_file"]) &&
        ["startup", "reload", "new", "resume", "fork"].includes(String(value["reason"])) &&
        optionalString(value, "pi_version") &&
        optionalString(value, "previous_session_file")
      );
    case "session_shutdown":
      return (
        exactKeys(value, ["reason"]) &&
        ["quit", "reload", "new", "resume", "fork"].includes(String(value["reason"]))
      );
    case "agent_start":
      return (
        exactKeys(
          value,
          ["prompt", "images_count"],
          [
            "session_id",
            "session_file",
            "system_prompt",
            "system_prompt_bytes",
            "system_prompt_sha256",
            "system_prompt_truncated",
            "system_prompt_options",
          ],
        ) &&
        stringValue(value["prompt"]) &&
        nonnegativeInteger(value["images_count"]) &&
        optionalString(value, "session_id") &&
        optionalString(value, "session_file") &&
        optionalString(value, "system_prompt") &&
        (!Object.hasOwn(value, "system_prompt_bytes") ||
          nonnegativeInteger(value["system_prompt_bytes"])) &&
        optionalString(value, "system_prompt_sha256") &&
        optionalBoolean(value, "system_prompt_truncated") &&
        (!Object.hasOwn(value, "system_prompt_options") ||
          validateSystemPromptOptions(value["system_prompt_options"]))
      );
    case "agent_end":
      return exactKeys(value, ["message_count"]) && nonnegativeInteger(value["message_count"]);
    case "turn_start":
      return exactKeys(value, ["turn_index"]) && nonnegativeInteger(value["turn_index"]);
    case "turn_end":
      return (
        exactKeys(value, ["turn_index"], ["usage"]) &&
        nonnegativeInteger(value["turn_index"]) &&
        (!Object.hasOwn(value, "usage") || validateUsage(value["usage"]))
      );
    case "user_message":
      return (
        exactKeys(value, ["text", "images_count"]) &&
        stringValue(value["text"]) &&
        nonnegativeInteger(value["images_count"])
      );
    case "assistant_message":
      return (
        exactKeys(
          value,
          ["text", "thinking", "tool_call_ids", "stop_reason", "usage"],
          [
            "error_message",
            "latency_ms",
            "prefill_ms",
            "generation_ms",
            "output_tps",
            "turn_index",
          ],
        ) &&
        stringValue(value["text"]) &&
        stringValue(value["thinking"]) &&
        stringArray(value["tool_call_ids"]) &&
        stringValue(value["stop_reason"]) &&
        validateUsage(value["usage"]) &&
        optionalString(value, "error_message") &&
        optionalNumber(value, "latency_ms") &&
        optionalNumber(value, "prefill_ms") &&
        optionalNumber(value, "generation_ms") &&
        optionalNumber(value, "output_tps") &&
        (!Object.hasOwn(value, "turn_index") || nonnegativeInteger(value["turn_index"]))
      );
    case "tool_call":
      return (
        exactKeys(value, ["tool_call_id", "tool_name", "args", "args_truncated"]) &&
        nonblankString(value["tool_call_id"]) &&
        nonblankString(value["tool_name"]) &&
        plainRecord(value["args"]) &&
        jsonValue(value["args"]) &&
        typeof value["args_truncated"] === "boolean"
      );
    case "tool_result":
      return (
        exactKeys(
          value,
          ["tool_call_id", "tool_name", "content_text", "content_truncated", "is_error"],
          ["details_summary"],
        ) &&
        nonblankString(value["tool_call_id"]) &&
        nonblankString(value["tool_name"]) &&
        stringValue(value["content_text"]) &&
        typeof value["content_truncated"] === "boolean" &&
        typeof value["is_error"] === "boolean" &&
        (!Object.hasOwn(value, "details_summary") ||
          (plainRecord(value["details_summary"]) && jsonValue(value["details_summary"])))
      );
    case "model_change":
      return (
        exactKeys(
          value,
          ["provider", "model", "source"],
          ["previous_provider", "previous_model"],
        ) &&
        stringValue(value["provider"]) &&
        stringValue(value["model"]) &&
        stringValue(value["source"]) &&
        optionalString(value, "previous_provider") &&
        optionalString(value, "previous_model")
      );
    case "thinking":
      return exactKeys(value, ["text"]) && stringValue(value["text"]);
    case "error":
      return (
        exactKeys(value, ["message", "where"]) &&
        stringValue(value["message"]) &&
        stringValue(value["where"])
      );
    case "custom":
      return (
        exactKeys(value, ["custom_type", "data"]) &&
        stringValue(value["custom_type"]) &&
        jsonValue(value["data"])
      );
    case "compaction":
      return (
        exactKeys(value, ["reason", "tokens_before", "first_kept_entry_id", "summary_preview"]) &&
        ["manual", "auto"].includes(String(value["reason"])) &&
        nonnegativeInteger(value["tokens_before"]) &&
        stringValue(value["first_kept_entry_id"]) &&
        stringValue(value["summary_preview"])
      );
    case "branch_nav":
      return (
        exactKeys(value, ["from_id", "to_id", "has_summary"], ["summary_preview"]) &&
        stringValue(value["from_id"]) &&
        stringValue(value["to_id"]) &&
        typeof value["has_summary"] === "boolean" &&
        optionalString(value, "summary_preview")
      );
  }
}

/** Validate an untrusted observability event before persistence or broadcast. */
export function validateObsEvent(value: unknown): value is ObsEvent {
  if (
    !exactKeys(
      value,
      ["event_id", "ts", "type", "session_id", "cwd", "pool", "tags", "payload", "seq"],
      ["session_file", "agent_name", "provider", "model"],
    )
  )
    return false;
  const type = value["type"];
  return (
    nonblankString(value["event_id"]) &&
    nonblankString(value["ts"]) &&
    Number.isFinite(Date.parse(value["ts"])) &&
    typeof type === "string" &&
    EVENT_TYPES.has(type as ObsEventType) &&
    nonblankString(value["session_id"]) &&
    stringValue(value["cwd"]) &&
    stringValue(value["pool"]) &&
    stringArray(value["tags"]) &&
    nonnegativeInteger(value["seq"]) &&
    optionalString(value, "session_file") &&
    optionalString(value, "agent_name") &&
    optionalString(value, "provider") &&
    optionalString(value, "model") &&
    validatePayload(type as ObsEventType, value["payload"])
  );
}

// ─── HTTP responses ─────────────────────────────────────────────────────────

export interface IngestResponse {
  ingested: number;
  /** event_ids that were rejected (duplicate or invalid). Empty on full success. */
  rejected: string[];
}

export interface SessionSummary {
  session_id: string;
  pool: string;
  agent_name?: string;
  cwd?: string;
  session_file?: string;
  provider?: string;
  model?: string;
  first_ts: string;
  last_ts: string;
  event_count: number;
  tags: string[];
}

export interface SessionsListResponse {
  sessions: SessionSummary[];
}

export interface HealthResponse {
  ok: true;
  version: string;
  uptime_s: number;
  events_total: number;
  sessions_total: number;
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Strings longer than this are truncated by the extension before sending. */
export const MAX_TEXT_FIELD = 32_000;
/** Args JSON longer than this is truncated. */
export const MAX_ARGS_BYTES = 16_000;
/** Tool result text longer than this is truncated. */
export const MAX_RESULT_BYTES = 32_000;
/** Server-side request body limit. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** Truncate a string to a max byte budget; appends a marker on truncation. */
export function truncateToBytes(s: string, max: number): { text: string; truncated: boolean } {
  if (!s) return { text: s ?? "", truncated: false };
  const buf = Buffer.byteLength(s, "utf8");
  if (buf <= max) return { text: s, truncated: false };
  // Crude byte-aware truncation: slice characters until under budget, then mark.
  const head = max - 64;
  let lo = 0,
    hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= head) lo = mid;
    else hi = mid - 1;
  }
  return { text: s.slice(0, lo) + `\n…[truncated ${buf - max} bytes]`, truncated: true };
}

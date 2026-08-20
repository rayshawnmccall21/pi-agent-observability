import type { ObsEvent } from "../shared/types.js";
export { compactToolOutput } from "./transcript-preview.js";
export { searchTranscript } from "./transcript-search.js";
import { normalizeThinking, thinkingOccurrenceKeys } from "./transcript-thinking.js";
import type { ToolState, ToolTranscriptItem, TranscriptItem } from "./transcript-types.js";

export type {
  AssistantTranscriptItem,
  CompactToolLimits,
  CompactToolPreview,
  ThinkingTranscriptItem,
  ToolState,
  ToolTranscriptItem,
  TranscriptItem,
  UserTranscriptItem,
} from "./transcript-types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function identifier(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function ordered(events: readonly ObsEvent[]): readonly ObsEvent[] {
  return [...events].sort((left, right) => left.seq - right.seq);
}
function toolState(call: ObsEvent | undefined, failed: boolean, output: string): ToolState {
  if (call === undefined) {
    return "orphan";
  }
  if (failed) {
    return "error";
  }
  return output === "" ? "empty" : "success";
}
function toolKey(call: ObsEvent | undefined, result: ObsEvent): string {
  return call === undefined ? `orphan:${result.event_id}` : `tool:${call.event_id}`;
}
function toolEvents(call: ObsEvent | undefined, result: ObsEvent): readonly ObsEvent[] {
  return call === undefined ? [result] : [call, result];
}
function toolItem(call: ObsEvent | undefined, result: ObsEvent): ToolTranscriptItem {
  const callPayload = record(call?.payload) ?? {};
  const resultPayload = record(result.payload) ?? {};
  const output = text(resultPayload["content_text"]);
  return {
    kind: "tool",
    key: toolKey(call, result),
    toolCallId: identifier(callPayload["tool_call_id"] ?? resultPayload["tool_call_id"]),
    toolName: text(callPayload["tool_name"] ?? resultPayload["tool_name"]),
    args: record(callPayload["args"]) ?? {},
    argsTruncated: callPayload["args_truncated"] === true,
    output,
    outputTruncated: resultPayload["content_truncated"] === true,
    state: toolState(call, resultPayload["is_error"] === true, output),
    events: toolEvents(call, result),
  };
}
function pendingTool(call: ObsEvent): ToolTranscriptItem {
  const payload = record(call.payload);
  return {
    kind: "tool",
    key: `tool:${call.event_id}`,
    toolCallId: identifier(payload?.["tool_call_id"]),
    toolName: text(payload?.["tool_name"]),
    args: record(payload?.["args"]) ?? {},
    argsTruncated: payload?.["args_truncated"] === true,
    output: "",
    outputTruncated: false,
    state: "pending",
    events: [call],
  };
}
function toolCallId(event: ObsEvent): string | undefined {
  const value = record(event.payload)?.["tool_call_id"];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
interface ToolCorrelationState {
  unmatched: Map<string, ObsEvent[]>;
  matches: Map<ObsEvent, ObsEvent>;
}
function queueToolCall(event: ObsEvent, id: string, state: ToolCorrelationState): void {
  state.unmatched.set(id, [...(state.unmatched.get(id) ?? []), event]);
}
function matchToolResult(event: ObsEvent, id: string, state: ToolCorrelationState): void {
  const call = state.unmatched.get(id)?.shift();
  if (call !== undefined) {
    state.matches.set(call, event);
  }
}
const TOOL_CORRELATION_HANDLERS: Readonly<Partial<Record<ObsEvent["type"], typeof queueToolCall>>> =
  {
    tool_call: queueToolCall,
    tool_result: matchToolResult,
  };
function correlatedTools(events: readonly ObsEvent[]): ReadonlyMap<ObsEvent, ObsEvent> {
  const state: ToolCorrelationState = { unmatched: new Map(), matches: new Map() };
  for (const event of events) {
    const id = toolCallId(event);
    if (id !== undefined) {
      TOOL_CORRELATION_HANDLERS[event.type]?.(event, id, state);
    }
  }
  return state.matches;
}
interface ProjectionState {
  items: TranscriptItem[];
  capturedThinking: Set<string>;
  thinkingOccurrences: ReadonlyMap<string, string>;
  matches: ReadonlyMap<ObsEvent, ObsEvent>;
  resultIds: ReadonlySet<string>;
  fallback?: ObsEvent;
}
function thinkingDeduplicationKey(
  event: ObsEvent,
  captured: string,
  state: ProjectionState,
): string {
  return `${state.thinkingOccurrences.get(event.event_id) ?? event.event_id}\u0000${normalizeThinking(captured)}`;
}
function addAssistant(
  event: ObsEvent,
  payload: Record<string, unknown> | undefined,
  state: ProjectionState,
): void {
  const exposed = text(payload?.["thinking"]);
  const deduplicationKey = thinkingDeduplicationKey(event, exposed, state);
  if (exposed.trim() !== "" && !state.capturedThinking.has(deduplicationKey)) {
    state.capturedThinking.add(deduplicationKey);
    state.items.push({
      kind: "thinking",
      key: `${event.event_id}:thinking`,
      text: exposed.trim(),
      events: [event],
    });
  }
  const answer = text(payload?.["text"]);
  if (answer.trim() !== "") {
    state.items.push({ kind: "assistant", key: event.event_id, text: answer, events: [event] });
  }
}
function addCaptured(event: ObsEvent, state: ProjectionState, kind: "user" | "thinking"): void {
  const captured = text(record(event.payload)?.["text"]);
  if (captured.trim() === "") {
    return;
  }
  if (kind === "thinking") {
    const deduplicationKey = thinkingDeduplicationKey(event, captured, state);
    if (state.capturedThinking.has(deduplicationKey)) {
      return;
    }
    state.capturedThinking.add(deduplicationKey);
    state.items.push({ kind, key: event.event_id, text: captured.trim(), events: [event] });
  } else {
    state.items.push({ kind, key: event.event_id, text: captured, events: [event] });
  }
}
function addCall(event: ObsEvent, state: ProjectionState): void {
  const result = state.matches.get(event);
  state.items.push(result === undefined ? pendingTool(event) : toolItem(event, result));
}
function addResult(event: ObsEvent, state: ProjectionState): void {
  if (!state.resultIds.has(event.event_id)) {
    state.items.push(toolItem(undefined, event));
  }
}
function addStart(event: ObsEvent, state: ProjectionState): void {
  if (text(record(event.payload)?.["prompt"]).trim() !== "") {
    state.fallback ??= event;
  }
}
type EventHandler = (event: ObsEvent, state: ProjectionState) => void;
const EVENT_HANDLERS: Readonly<Partial<Record<ObsEvent["type"], EventHandler>>> = {
  agent_start: addStart,
  ["user_message"]: (event, state): void => {
    addCaptured(event, state, "user");
  },
  thinking: (event, state): void => {
    addCaptured(event, state, "thinking");
  },
  tool_call: addCall,
  tool_result: addResult,
  ["assistant_message"]: (event, state): void => {
    addAssistant(event, record(event.payload), state);
  },
};
function addEvent(event: ObsEvent, state: ProjectionState): void {
  EVENT_HANDLERS[event.type]?.(event, state);
}
function addFallback(state: ProjectionState): void {
  if (state.items.some((item) => item.kind === "user") || state.fallback === undefined) {
    return;
  }
  state.items.unshift({
    kind: "user",
    key: `${state.fallback.event_id}:prompt`,
    text: text(record(state.fallback.payload)?.["prompt"]),
    events: [state.fallback],
  });
}

/**
 * Projects raw captured events into deterministic content-first transcript items.
 * @param events - Raw captured events to project.
 *
 * @returns Deterministically ordered transcript items.
 *
 * @example `projectTranscript(events)`
 */
export function projectTranscript(events: readonly ObsEvent[]): readonly TranscriptItem[] {
  const sorted = ordered(events);
  const matches = correlatedTools(sorted);
  const state: ProjectionState = {
    items: [],
    capturedThinking: new Set<string>(),
    thinkingOccurrences: thinkingOccurrenceKeys(sorted),
    matches,
    resultIds: new Set(Array.from(matches.values(), (event) => event.event_id)),
  };
  for (const event of sorted) {
    addEvent(event, state);
  }
  addFallback(state);
  return state.items;
}

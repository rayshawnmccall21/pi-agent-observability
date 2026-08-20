import type { ObsEvent } from "../shared/types.js";

function payloadRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Normalize captured thinking for causal equivalence checks.
 * @param value - Captured provider-exposed thinking text.
 *
 * @returns Whitespace-normalized thinking text.
 *
 * @example `normalizeThinking("  inspect   state ")`
 */
export function normalizeThinking(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function explicitTurnKey(event: ObsEvent): string | undefined {
  const turnIndex = payloadRecord(event.payload)?.["turn_index"];
  return typeof turnIndex === "string" || typeof turnIndex === "number"
    ? `turn:${String(turnIndex)}`
    : undefined;
}

function capturedThinking(event: ObsEvent): string {
  const payload = payloadRecord(event.payload);
  if (event.type === "assistant_message") {
    return text(payload?.["thinking"]);
  }
  if (event.type === "thinking") {
    return text(payload?.["text"]);
  }
  return "";
}

function occurrenceBoundary(event: ObsEvent): boolean {
  return ["user_message", "turn_start", "turn_end"].includes(event.type);
}

function equivalentAssistant(
  event: ObsEvent | undefined,
  normalized: string,
): ObsEvent | undefined {
  if (event?.type !== "assistant_message") {
    return undefined;
  }
  return normalizeThinking(capturedThinking(event)) === normalized ? event : undefined;
}

function forwardEquivalentAssistant(
  events: readonly ObsEvent[],
  thinkingIndex: number,
  normalized: string,
): ObsEvent | undefined {
  for (const event of events.slice(thinkingIndex + 1)) {
    if (occurrenceBoundary(event)) {
      return undefined;
    }
    if (event.type === "assistant_message") {
      return equivalentAssistant(event, normalized);
    }
  }
  return undefined;
}

interface StandaloneOccurrenceInput {
  events: readonly ObsEvent[];
  event: ObsEvent;
  index: number;
  captured: string;
  activeTurn: string | undefined;
}

function standaloneOccurrence(input: StandaloneOccurrenceInput): string {
  const normalized = normalizeThinking(input.captured);
  const assistant =
    equivalentAssistant(input.events[input.index - 1], normalized) ??
    forwardEquivalentAssistant(input.events, input.index, normalized);
  return assistant === undefined
    ? input.event.event_id
    : (explicitTurnKey(assistant) ?? assistant.event_id);
}

function thinkingOccurrence(input: StandaloneOccurrenceInput): string {
  return (
    explicitTurnKey(input.event) ??
    input.activeTurn ??
    (input.event.type === "thinking" ? standaloneOccurrence(input) : input.event.event_id)
  );
}

interface TurnBoundary {
  handled: boolean;
  activeTurn: string | undefined;
}

function turnBoundary(event: ObsEvent, activeTurn: string | undefined): TurnBoundary {
  if (event.type === "turn_start") {
    return {
      handled: true,
      activeTurn: explicitTurnKey(event) ?? `turn-event:${event.event_id}`,
    };
  }
  return event.type === "turn_end"
    ? { handled: true, activeTurn: undefined }
    : { handled: false, activeTurn };
}

/**
 * Assign each captured-thinking source to one causal occurrence.
 * @param events - Deterministically ordered raw observability events.
 *
 * @returns Event IDs mapped to causal thinking-occurrence keys.
 *
 * @example `thinkingOccurrenceKeys(events)`
 */
export function thinkingOccurrenceKeys(events: readonly ObsEvent[]): ReadonlyMap<string, string> {
  const occurrences = new Map<string, string>();
  let activeTurn: string | undefined;
  for (const [index, event] of events.entries()) {
    const boundary = turnBoundary(event, activeTurn);
    activeTurn = boundary.activeTurn;
    if (boundary.handled) {
      continue;
    }
    const captured = capturedThinking(event);
    if (captured.trim() === "") {
      continue;
    }
    occurrences.set(
      event.event_id,
      thinkingOccurrence({ events, event, index, captured, activeTurn }),
    );
  }
  return occurrences;
}

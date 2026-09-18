import {
  BMAD_EXPERT_ACTIVITY_CHANNEL,
  BMAD_EXPERT_CUSTOM_TYPE,
  parseBmadExpertActivity,
  type BmadExpertActivity,
} from "./bmad-expert-activity.js";

const SEQUENCE_REGISTRY_KEY = Symbol.for("pi-observability.session-sequences.v1");

/** Minimal shared event bus accepted by the optional capture adapter. */
export interface ActivityEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Exact custom payload emitted to the observability envelope. */
export interface BmadExpertCustomPayload {
  readonly custom_type: typeof BMAD_EXPERT_CUSTOM_TYPE;
  readonly data: BmadExpertActivity;
}

function sequenceRegistry(): Map<string, number> {
  const existing: unknown = Reflect.get(process, SEQUENCE_REGISTRY_KEY);
  if (existing instanceof Map) return existing;
  const created = new Map<string, number>();
  Reflect.set(process, SEQUENCE_REGISTRY_KEY, created);
  return created;
}

/**
 * Allocate a process-stable sequence for one Pi session identity.
 * @param sessionId - Stable Pi session identifier.
 * @returns Next zero-based sequence without reload reuse.
 */
export function nextObservabilitySequence(sessionId: string): number {
  const registry = sequenceRegistry();
  const sequence = registry.get(sessionId) ?? 0;
  registry.set(sessionId, sequence + 1);
  return sequence;
}

/**
 * Subscribe an exact redacted BMAD child activity adapter.
 * @param events - Shared Pi event bus.
 * @param capture - Sink for validated custom payloads.
 * @returns Idempotent event-bus unsubscribe callback.
 */
export function subscribeBmadExpertActivity(
  events: ActivityEventBus,
  capture: (payload: BmadExpertCustomPayload) => void,
): () => void {
  return events.on(BMAD_EXPERT_ACTIVITY_CHANNEL, (input) => {
    const activity = parseBmadExpertActivity(input);
    if (activity === null) return;
    capture({ custom_type: BMAD_EXPERT_CUSTOM_TYPE, data: activity });
  });
}

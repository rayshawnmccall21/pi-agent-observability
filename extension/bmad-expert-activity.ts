/** Optional shared-bus channel produced by pi-bmad-orchestrator. */
export const BMAD_EXPERT_ACTIVITY_CHANNEL = "pi-bmad-orchestrator:expert-activity:v1";
/** P-observability custom event label for one expert child transition. */
export const BMAD_EXPERT_CUSTOM_TYPE = "bmad_query_experts.child";

/** Redacted expert child activity accepted from the shared Pi event bus. */
export interface BmadExpertActivity {
  readonly version: 1;
  readonly parentToolCallId: string;
  readonly activityId: string;
  readonly expert: string;
  readonly index: number;
  readonly total: number;
  readonly phase: "started" | "completed" | "failed" | "cancelled";
  readonly elapsedMs: number;
  readonly updateSeq: number;
  readonly answerChars: number;
  readonly answerTruncated: boolean;
}

const REQUIRED_KEYS = [
  "version",
  "parentToolCallId",
  "activityId",
  "expert",
  "index",
  "total",
  "phase",
  "elapsedMs",
  "updateSeq",
  "answerChars",
  "answerTruncated",
] as const;
const PHASES = new Set(["started", "completed", "failed", "cancelled"]);

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maximum;
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function exactShape(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === REQUIRED_KEYS.length &&
    REQUIRED_KEYS.every((key) => Object.hasOwn(value, key))
  );
}

/**
 * Validate and copy one untrusted BMAD expert activity.
 * @param input - Shared-bus payload from an optional producer.
 * @returns Exact redacted activity, or null when malformed.
 */
export function parseBmadExpertActivity(input: unknown): BmadExpertActivity | null {
  const value = recordOf(input);
  if (
    value === null ||
    !exactShape(value) ||
    value["version"] !== 1 ||
    !boundedString(value["parentToolCallId"], 128) ||
    !boundedString(value["activityId"], 160) ||
    !boundedString(value["expert"], 128) ||
    !boundedInteger(value["index"], 3) ||
    !boundedInteger(value["total"], 4) ||
    Number(value["total"]) < 1 ||
    Number(value["index"]) >= Number(value["total"]) ||
    typeof value["phase"] !== "string" ||
    !PHASES.has(value["phase"]) ||
    !boundedInteger(value["elapsedMs"], 300_000) ||
    !boundedInteger(value["updateSeq"], 1000) ||
    !boundedInteger(value["answerChars"], 48_000) ||
    typeof value["answerTruncated"] !== "boolean"
  ) {
    return null;
  }
  return {
    version: 1,
    parentToolCallId: value["parentToolCallId"],
    activityId: value["activityId"],
    expert: value["expert"],
    index: value["index"],
    total: value["total"],
    phase: value["phase"] as BmadExpertActivity["phase"],
    elapsedMs: value["elapsedMs"],
    updateSeq: value["updateSeq"],
    answerChars: value["answerChars"],
    answerTruncated: value["answerTruncated"],
  };
}

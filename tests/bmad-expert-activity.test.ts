import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BMAD_EXPERT_ACTIVITY_CHANNEL,
  BMAD_EXPERT_CUSTOM_TYPE,
  parseBmadExpertActivity,
} from "../extension/bmad-expert-activity.js";

const validActivity = {
  version: 1,
  parentToolCallId: "tool-call",
  activityId: "tool-call:0",
  expert: "pi-bmad-expert",
  index: 0,
  total: 2,
  phase: "started",
  elapsedMs: 0,
  updateSeq: 0,
  answerChars: 0,
  answerTruncated: false,
} as const;

describe("BMAD expert observability activity", () => {
  it("accepts the exact bounded redacted protocol", () => {
    expect(BMAD_EXPERT_ACTIVITY_CHANNEL).toBe("pi-bmad-orchestrator:expert-activity:v1");
    expect(BMAD_EXPERT_CUSTOM_TYPE).toBe("bmad_query_experts.child");
    expect(parseBmadExpertActivity(validActivity)).toEqual(validActivity);
  });

  it("rejects additive, malformed, oversized, non-finite, and out-of-range input", () => {
    for (const invalid of [
      { ...validActivity, question: "secret" },
      { ...validActivity, phase: "unknown" },
      { ...validActivity, expert: "x".repeat(129) },
      { ...validActivity, elapsedMs: Number.NaN },
      { ...validActivity, answerChars: Number.POSITIVE_INFINITY },
      { ...validActivity, index: 2, total: 2 },
      { ...validActivity, index: 0.5 },
      { ...validActivity, total: 5 },
      { ...validActivity, updateSeq: 1001 },
    ]) {
      expect(parseBmadExpertActivity(invalid)).toBeNull();
    }
  });

  it("wires child activity into capture and a visible dashboard summary", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const extension = readFileSync(`${root}/extension/pi-observability.ts`, "utf8");
    const capture = readFileSync(`${root}/extension/bmad-expert-capture.ts`, "utf8");
    const dashboard = readFileSync(`${root}/apps/observability/public/app.js`, "utf8");

    expect(extension).toContain(`subscribeBmadExpertActivity(pi.events`);
    expect(extension).toContain(`createEventEnvelope("custom"`);
    expect(capture).toContain(`events.on(BMAD_EXPERT_ACTIVITY_CHANNEL`);
    expect(capture).toContain(`parseBmadExpertActivity(input)`);
    expect(dashboard).toContain('p.custom_type === "bmad_query_experts.child"');
    expect(dashboard).toContain("BMAD expert");
  });
});

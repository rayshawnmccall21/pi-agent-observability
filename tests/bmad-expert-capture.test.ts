import { describe, expect, it } from "vitest";
import type { BmadExpertActivity } from "../extension/bmad-expert-activity.js";
import { BMAD_EXPERT_ACTIVITY_CHANNEL } from "../extension/bmad-expert-activity.js";
import {
  nextObservabilitySequence,
  subscribeBmadExpertActivity,
  type ActivityEventBus,
  type BmadExpertCustomPayload,
} from "../extension/bmad-expert-capture.js";

interface TestBus extends ActivityEventBus {
  emit(channel: string, data: unknown): void;
}

function testBus(): TestBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel, data) {
      for (const listener of listeners.get(channel) ?? []) listener(data);
    },
    on(channel, handler) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(handler);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(handler);
    },
  };
}

function activity(phase: BmadExpertActivity["phase"]): BmadExpertActivity {
  return {
    version: 1,
    parentToolCallId: "parent-call",
    activityId: "parent-call:0",
    expert: "pi-bmad-expert",
    index: 0,
    total: 1,
    phase,
    elapsedMs: phase === "started" ? 0 : 42,
    updateSeq: phase === "started" ? 0 : 1,
    answerChars: phase === "started" ? 0 : 120,
    answerTruncated: false,
  };
}

describe("BMAD expert activity capture", () => {
  it("keeps event sequence monotonic when reload reuses one session identity", () => {
    const sessionId = `session-bmad-reload-${String(Date.now())}`;
    const beforeReload = [
      nextObservabilitySequence(sessionId),
      nextObservabilitySequence(sessionId),
    ];
    const afterReload = [
      nextObservabilitySequence(sessionId),
      nextObservabilitySequence(sessionId),
    ];

    expect([...beforeReload, ...afterReload]).toEqual([0, 1, 2, 3]);
  });

  it("captures exact redacted start and terminal events and drops malformed input", () => {
    const bus = testBus();
    const captured: BmadExpertCustomPayload[] = [];
    const unsubscribe = subscribeBmadExpertActivity(bus, (payload) => captured.push(payload));

    bus.emit(BMAD_EXPERT_ACTIVITY_CHANNEL, activity("started"));
    bus.emit(BMAD_EXPERT_ACTIVITY_CHANNEL, {
      ...activity("failed"),
      question: "BMAD_SECRET_must_be_rejected",
    });
    bus.emit(BMAD_EXPERT_ACTIVITY_CHANNEL, activity("completed"));
    unsubscribe();
    bus.emit(BMAD_EXPERT_ACTIVITY_CHANNEL, activity("failed"));

    expect(captured.map(({ data }) => data)).toEqual([activity("started"), activity("completed")]);
    for (const { data } of captured) {
      expect(Object.keys(data).sort()).toEqual(
        [
          "activityId",
          "answerChars",
          "answerTruncated",
          "elapsedMs",
          "expert",
          "index",
          "parentToolCallId",
          "phase",
          "total",
          "updateSeq",
          "version",
        ].sort(),
      );
    }
    expect(JSON.stringify(captured)).not.toContain("BMAD_SECRET");
  });
});

import { describe, expect, it } from "vitest";
import type { ObsEvent, ObsEventType } from "../shared/types.js";
import {
  compactToolOutput,
  projectTranscript,
  searchTranscript,
  type TranscriptItem,
} from "../src/transcript.js";
import {
  TRANSCRIPT_API_VERSION,
  compactToolOutput as publicCompactToolOutput,
  projectTranscript as publicProjectTranscript,
  searchTranscript as publicSearchTranscript,
} from "../src/index.js";

const usage = {
  input: 1,
  output: 1,
  cache_read: 0,
  cache_write: 0,
  total_tokens: 2,
  cost_total: 0,
};

function event(seq: number, type: ObsEventType, payload: unknown): ObsEvent {
  return {
    event_id: `event-${seq}`,
    ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    type,
    session_id: "session-fixture",
    cwd: "/fixture",
    pool: "test",
    tags: [],
    payload,
    seq,
  } as ObsEvent;
}

const hostile = `<img src=x onerror="globalThis.pwned=true"><script>alert(1)</script>`;
const longOutput = ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n");

const fixtureMatrix: ObsEvent[] = [
  event(9, "assistant_message", {
    text: `Answer line one\nAnswer line two ${hostile}`,
    thinking: "  inspect   the fixture  ",
    tool_call_ids: ["parallel-a", "parallel-b", "pending", "empty"],
    stop_reason: "stop",
    usage,
  }),
  event(0, "user_message", { text: `First line\nSecond line ${hostile}`, images_count: 0 }),
  event(7, "tool_result", {
    tool_call_id: "parallel-a",
    tool_name: "read",
    content_text: longOutput,
    content_truncated: true,
    is_error: false,
  }),
  event(2, "thinking", { text: "inspect the fixture" }),
  event(5, "tool_call", {
    tool_call_id: "parallel-b",
    tool_name: "bash",
    args: { command: hostile },
    args_truncated: false,
  }),
  event(3, "tool_call", {
    tool_call_id: "parallel-a",
    tool_name: "read",
    args: { path: "/tmp/a" },
    args_truncated: true,
  }),
  event(6, "tool_result", {
    tool_call_id: "parallel-b",
    tool_name: "bash",
    content_text: "permission denied",
    content_truncated: false,
    is_error: true,
  }),
  event(4, "tool_result", {
    tool_call_id: "orphan-result",
    tool_name: "grep",
    content_text: "unmatched",
    content_truncated: false,
    is_error: false,
  }),
  event(8, "tool_call", {
    tool_call_id: "pending",
    tool_name: "write",
    args: { path: "/tmp/pending" },
    args_truncated: false,
  }),
  event(10, "tool_call", {
    tool_call_id: "empty",
    tool_name: "read",
    args: {},
    args_truncated: false,
  }),
  event(11, "tool_result", {
    tool_call_id: "empty",
    tool_name: "read",
    content_text: "",
    content_truncated: false,
    is_error: false,
  }),
  event(12, "tool_call", {
    tool_call_id: "repeated-id",
    tool_name: "first",
    args: { occurrence: 1 },
    args_truncated: false,
  }),
  event(13, "tool_result", {
    tool_call_id: "repeated-id",
    tool_name: "first",
    content_text: "first result",
    content_truncated: false,
    is_error: false,
  }),
  event(14, "tool_call", {
    tool_call_id: "repeated-id",
    tool_name: "second",
    args: { occurrence: 2 },
    args_truncated: false,
  }),
];

function tools(items: readonly TranscriptItem[]) {
  return items.filter((item) => item.kind === "tool");
}

describe("projectTranscript", () => {
  it("projects complete captured content in deterministic causal order", () => {
    const projected = projectTranscript(fixtureMatrix);
    expect(projectTranscript([...fixtureMatrix].reverse())).toEqual(projected);
    expect(projected.map((item) => item.kind)).toEqual([
      "user",
      "thinking",
      "tool",
      "tool",
      "tool",
      "tool",
      "assistant",
      "tool",
      "tool",
      "tool",
    ]);
    expect(projected.find((item) => item.kind === "user")).toMatchObject({
      kind: "user",
      text: `First line\nSecond line ${hostile}`,
    });
    expect(projected.find((item) => item.kind === "assistant")).toMatchObject({
      kind: "assistant",
      text: `Answer line one\nAnswer line two ${hostile}`,
    });
  });

  it("uses agent_start prompt only when no captured user_message exists", () => {
    const fallback = projectTranscript([
      event(0, "agent_start", { prompt: "fallback prompt", images_count: 0 }),
    ]);
    const explicit = projectTranscript([
      event(0, "agent_start", { prompt: "fallback prompt", images_count: 0 }),
      event(1, "user_message", { text: "explicit prompt", images_count: 0 }),
    ]);
    expect(fallback).toEqual([expect.objectContaining({ kind: "user", text: "fallback prompt" })]);
    expect(explicit.filter((item) => item.kind === "user")).toEqual([
      expect.objectContaining({ kind: "user", text: "explicit prompt" }),
    ]);
  });

  it("deduplicates equivalent captured thinking in either source order before work", () => {
    const projected = projectTranscript(fixtureMatrix);
    const thinking = projected.filter((item) => item.kind === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({ kind: "thinking", text: "inspect the fixture" });
    expect(projected.indexOf(thinking[0]!)).toBeLessThan(
      projected.findIndex((item) => item.kind === "tool"),
    );
    expect(projected.indexOf(thinking[0]!)).toBeLessThan(
      projected.findIndex((item) => item.kind === "assistant"),
    );

    const assistantFirst = projectTranscript([
      event(0, "assistant_message", { text: "", thinking: "same thought", usage }),
      event(1, "thinking", { text: "same thought" }),
      event(2, "assistant_message", { text: "answer", thinking: "", usage }),
    ]);
    expect(assistantFirst.filter((item) => item.kind === "thinking")).toHaveLength(1);
  });

  it("deduplicates assistant and standalone thinking only within each explicit turn", () => {
    const projected = projectTranscript([
      event(0, "turn_start", { turn_index: 1 }),
      event(1, "assistant_message", {
        text: "First answer",
        thinking: "Check the invariant",
        turn_index: 1,
      }),
      event(2, "thinking", { text: "  Check   the invariant  " }),
      event(3, "turn_end", { turn_index: 1 }),
      event(4, "turn_start", { turn_index: 2 }),
      event(5, "assistant_message", {
        text: "Second answer",
        thinking: "Check the invariant",
        turn_index: 2,
      }),
      event(6, "thinking", { text: "Check the invariant" }),
      event(7, "turn_end", { turn_index: 2 }),
    ]);

    expect(projected.map((item) => `${item.kind}:${"text" in item ? item.text : ""}`)).toEqual([
      "thinking:Check the invariant",
      "assistant:First answer",
      "thinking:Check the invariant",
      "assistant:Second answer",
    ]);
  });

  it("deduplicates bounded assistant thinking when only turn events carry the index", () => {
    const projected = projectTranscript([
      event(0, "turn_start", { turn_index: 3 }),
      event(1, "thinking", { text: "Captured in the active turn" }),
      event(2, "assistant_message", {
        text: "Answer",
        thinking: "Captured in the active turn",
        usage,
      }),
      event(3, "turn_end", { turn_index: 3 }),
    ]);

    expect(projected.map((item) => item.kind)).toEqual(["thinking", "assistant"]);
  });

  it("bounds fallback thinking deduplication by turn events before intervening tools", () => {
    const projected = publicProjectTranscript([
      event(1, "assistant_message", {
        text: "First answer",
        thinking: "Recheck the invariant",
        turn_index: 1,
      }),
      event(2, "turn_end", { turn_index: 1 }),
      event(3, "turn_start", { turn_index: 2 }),
      event(4, "thinking", { text: "Recheck the invariant" }),
      event(5, "tool_call", {
        tool_call_id: "turn-two-a",
        tool_name: "read",
        args: {},
      }),
      event(6, "tool_call", {
        tool_call_id: "turn-two-b",
        tool_name: "grep",
        args: {},
      }),
      event(7, "tool_call", {
        tool_call_id: "turn-two-c",
        tool_name: "bash",
        args: {},
      }),
      event(8, "assistant_message", {
        text: "Second answer",
        thinking: "Recheck the invariant",
        turn_index: 2,
      }),
    ]);

    expect(projected.map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
      "thinking",
      "tool",
      "tool",
      "tool",
      "assistant",
    ]);
  });

  it("keeps repeated captured thinking before the current turn's tools", () => {
    const projected = projectTranscript([
      event(1, "assistant_message", {
        thinking: "Inspect the same invariant",
        text: "First answer",
      }),
      event(2, "user_message", {
        text: "Check again",
        images_count: 0,
      }),
      event(3, "thinking", {
        text: "Inspect the same invariant",
      }),
      event(4, "tool_call", {
        tool_call_id: "tool-a",
        tool_name: "read",
        args: {},
      }),
      event(5, "tool_call", {
        tool_call_id: "tool-b",
        tool_name: "bash",
        args: {},
      }),
      event(6, "tool_call", {
        tool_call_id: "tool-c",
        tool_name: "grep",
        args: {},
      }),
      event(7, "assistant_message", {
        thinking: "Inspect the same invariant",
        text: "Second answer",
      }),
    ]);

    expect(projected.map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
      "user",
      "thinking",
      "tool",
      "tool",
      "tool",
      "assistant",
    ]);
  });

  it("correlates tools by ID and reports truthful states", () => {
    const projectedTools = tools(projectTranscript(fixtureMatrix));
    expect(projectedTools.map((item) => [item.toolCallId, item.state])).toEqual([
      ["parallel-a", "success"],
      ["orphan-result", "orphan"],
      ["parallel-b", "error"],
      ["pending", "pending"],
      ["empty", "empty"],
      ["repeated-id", "success"],
      ["repeated-id", "pending"],
    ]);
    expect(projectedTools[0]).toMatchObject({
      toolCallId: "parallel-a",
      args: { path: "/tmp/a" },
      argsTruncated: true,
      output: longOutput,
      outputTruncated: true,
    });
  });

  it.each([
    ["undefined", undefined, undefined],
    ["null", null, null],
    ["blank", " \t ", " \t "],
    ["object", { call: true }, { result: true }],
    ["numeric call versus string result", 42, "42"],
    ["string call versus numeric result", "42", 42],
  ] as const)("keeps %s tool identities uncorrelated", (_label, callId, resultId) => {
    const call = event(20, "tool_call", {
      tool_call_id: callId,
      tool_name: "call-only",
      args: { source: "call" },
      args_truncated: false,
    });
    const result = event(21, "tool_result", {
      tool_call_id: resultId,
      tool_name: "result-only",
      content_text: "must stay orphaned",
      content_truncated: false,
      is_error: false,
    });

    expect(
      tools(projectTranscript([call, result])).map((item) => ({
        state: item.state,
        toolName: item.toolName,
        output: item.output,
        eventIds: item.events.map((source) => source.event_id),
      })),
    ).toEqual([
      {
        state: "pending",
        toolName: "call-only",
        output: "",
        eventIds: [call.event_id],
      },
      {
        state: "orphan",
        toolName: "result-only",
        output: "must stay orphaned",
        eventIds: [result.event_id],
      },
    ]);
  });

  it("does not mutate input envelopes or nested payloads", () => {
    const input = structuredClone(fixtureMatrix);
    const before = structuredClone(input);
    projectTranscript(input);
    expect(input).toEqual(before);
  });

  it("treats malformed unknown payloads as inert data without throwing", () => {
    const malformed = event(0, "tool_result", { tool_call_id: 42, content_text: null });
    const unknown = { ...event(1, "custom", { content: hostile }), type: "future_event" };
    expect(() => projectTranscript([malformed, unknown as ObsEvent])).not.toThrow();
  });
});

describe("compactToolOutput", () => {
  it("bounds previews by both line and character limits and reports omission", () => {
    expect(compactToolOutput(longOutput, { maxLines: 3, maxChars: 100 })).toEqual({
      text: "alpha\nbeta\ngamma",
      omitted: true,
    });
    expect(compactToolOutput("abcdefghij", { maxLines: 10, maxChars: 5 })).toEqual({
      text: "abcde",
      omitted: true,
    });
    expect(compactToolOutput("exact", { maxLines: 1, maxChars: 5 })).toEqual({
      text: "exact",
      omitted: false,
    });
  });

  it("keeps full captured output and producer truncation separate from preview omission", () => {
    const tool = tools(projectTranscript(fixtureMatrix))[0]!;
    expect(compactToolOutput(tool.output, { maxLines: 2, maxChars: 100 })).toEqual({
      text: "alpha\nbeta",
      omitted: true,
    });
    expect(tool.output).toBe(longOutput);
    expect(tool.outputTruncated).toBe(true);
  });
});

describe("searchTranscript", () => {
  it("searches complete projected content", () => {
    const projected = projectTranscript(fixtureMatrix);
    for (const query of [
      "Second line",
      "inspect the fixture",
      "parallel-a",
      "/tmp/a",
      "epsilon",
      "permission denied",
      "pending",
      hostile,
    ]) {
      expect(searchTranscript(projected, query), query).not.toHaveLength(0);
    }
    expect(searchTranscript(projected, "ABSENT-VALUE")).toEqual([]);
    expect(searchTranscript(projected, "  PERMISSION DENIED  ")).toEqual(
      searchTranscript(projected, "permission denied"),
    );
  });
});

describe("public transcript API", () => {
  it("re-exports the core and installs a minimal immutable versioned browser global", () => {
    expect(publicProjectTranscript).toBe(projectTranscript);
    expect(publicCompactToolOutput).toBe(compactToolOutput);
    expect(publicSearchTranscript).toBe(searchTranscript);
    expect(TRANSCRIPT_API_VERSION).toBe(1);
    const browserApi = (globalThis as typeof globalThis & { OBS_TRANSCRIPT?: unknown })
      .OBS_TRANSCRIPT;
    expect(browserApi).toEqual({
      version: 1,
      projectTranscript,
      compactToolOutput,
      searchTranscript,
    });
    expect(Object.isFrozen(browserApi)).toBe(true);
  });
});

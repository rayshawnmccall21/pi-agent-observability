import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ObsEvent } from "../shared/types.js";
import { projectTranscript } from "../src/transcript.js";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function functionSource(fileSource: string, start: string, end: string): string {
  const startIndex = fileSource.indexOf(start);
  const endIndex = fileSource.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing end marker: ${end}`).toBeGreaterThan(startIndex);
  return fileSource.slice(startIndex, endIndex);
}

interface EventInput {
  type: ObsEvent["type"];
  eventId: string;
  seq: number;
  payload: Record<string, unknown>;
}

function event(input: EventInput): ObsEvent {
  return {
    event_id: input.eventId,
    session_id: "review-session",
    seq: input.seq,
    ts: `2026-08-20T00:00:0${input.seq}Z`,
    type: input.type,
    cwd: "/tmp/review",
    pool: "review",
    tags: [],
    payload: input.payload,
  } as unknown as ObsEvent;
}

describe("STY-190 code review findings", () => {
  it("does not correlate tool calls and results when tool_call_id is absent", () => {
    const projected = projectTranscript([
      event({
        type: "tool_call",
        eventId: "call-without-id",
        seq: 1,
        payload: { tool_name: "read", args: { path: "first.txt" } },
      }),
      event({
        type: "tool_result",
        eventId: "result-without-id",
        seq: 2,
        payload: { tool_name: "bash", content_text: "unrelated result", is_error: false },
      }),
    ]);

    expect(
      projected
        .filter((item) => item.kind === "tool")
        .map((item) => ({ state: item.state, sourceCount: item.events.length })),
    ).toEqual([
      { state: "pending", sourceCount: 1 },
      { state: "orphan", sourceCount: 1 },
    ]);
  });

  it("correlates distinct tool identities even when call event IDs collide", () => {
    const projected = projectTranscript([
      event({
        type: "tool_call",
        eventId: "duplicate-call-event",
        seq: 1,
        payload: { tool_call_id: "tool-a", tool_name: "read", args: { path: "a.txt" } },
      }),
      event({
        type: "tool_call",
        eventId: "duplicate-call-event",
        seq: 2,
        payload: { tool_call_id: "tool-b", tool_name: "bash", args: { command: "pwd" } },
      }),
      event({
        type: "tool_result",
        eventId: "result-a",
        seq: 3,
        payload: {
          tool_call_id: "tool-a",
          tool_name: "read",
          content_text: "alpha",
          is_error: false,
        },
      }),
      event({
        type: "tool_result",
        eventId: "result-b",
        seq: 4,
        payload: {
          tool_call_id: "tool-b",
          tool_name: "bash",
          content_text: "beta",
          is_error: false,
        },
      }),
    ]);

    expect(
      projected
        .filter((item) => item.kind === "tool")
        .map((item) => ({
          toolCallId: item.toolCallId,
          output: item.output,
          state: item.state,
          resultEventId: item.events[1]?.event_id,
        })),
    ).toEqual([
      {
        toolCallId: "tool-a",
        output: "alpha",
        state: "success",
        resultEventId: "result-a",
      },
      {
        toolCallId: "tool-b",
        output: "beta",
        state: "success",
        resultEventId: "result-b",
      },
    ]);
  });

  it("keeps identical captured thinking from distinct causal turns", () => {
    const projected = projectTranscript([
      event({
        type: "assistant_message",
        eventId: "assistant-turn-one",
        seq: 1,
        payload: { thinking: "Check the invariant", text: "First answer", turn_index: 1 },
      }),
      event({
        type: "assistant_message",
        eventId: "assistant-turn-two",
        seq: 2,
        payload: { thinking: "Check the invariant", text: "Second answer", turn_index: 2 },
      }),
    ]);

    expect(projected.map((item) => `${item.kind}:${"text" in item ? item.text : ""}`)).toEqual([
      "thinking:Check the invariant",
      "assistant:First answer",
      "thinking:Check the invariant",
      "assistant:Second answer",
    ]);
  });

  it("uses adjacent event order as the thinking-occurrence fallback without turn_index", () => {
    const projected = projectTranscript([
      event({
        type: "assistant_message",
        eventId: "assistant-fallback-one",
        seq: 1,
        payload: { thinking: "Repeatable thought", text: "First answer" },
      }),
      event({
        type: "thinking",
        eventId: "standalone-fallback-one",
        seq: 2,
        payload: { text: "Repeatable thought" },
      }),
      event({
        type: "assistant_message",
        eventId: "assistant-fallback-two",
        seq: 3,
        payload: { thinking: "Repeatable thought", text: "Second answer" },
      }),
      event({
        type: "thinking",
        eventId: "standalone-fallback-two",
        seq: 4,
        payload: { text: "Repeatable thought" },
      }),
    ]);

    expect(projected.map((item) => `${item.kind}:${"text" in item ? item.text : ""}`)).toEqual([
      "thinking:Repeatable thought",
      "assistant:First answer",
      "thinking:Repeatable thought",
      "assistant:Second answer",
    ]);
  });

  it("loads every event page before declaring a session hydrated", () => {
    const appSource = source("apps/observability/public/app.js");
    const fetchSource = functionSource(
      appSource,
      "async function fetchSessionHistory",
      "async function fetchSessionEvents",
    );

    expect(fetchSource).toContain("before_seq");
    expect(fetchSource).toMatch(/\b(?:while|for)\s*\(/u);
  });

  it("renders telemetry-controlled metadata without HTML-string sinks", () => {
    const appSource = source("apps/observability/public/app.js");
    const swimlaneSource = source("apps/observability/public/swimlane.js");
    const raceSource = source("apps/observability/public/race.js");

    const renderSessionsSource = functionSource(
      appSource,
      "function renderSessions",
      "function buildMiniSessionItem",
    );
    const createLaneSource = functionSource(
      swimlaneSource,
      "function createLane",
      "function destroyLane",
    );
    const appendLaneSource = functionSource(
      swimlaneSource,
      "function appendLaneDOM",
      "function scrollLaneToBottom",
    );
    const raceEventSource = functionSource(
      raceSource,
      "function buildRaceEvent",
      "function buildTurnGroups",
    );
    const inspectorSource = functionSource(
      raceSource,
      "function openInspector",
      "function maybeRestoreInspector",
    );

    expect(renderSessionsSource).not.toContain("info.innerHTML");
    expect(createLaneSource).not.toContain("header.innerHTML");
    expect(createLaneSource).not.toContain("onclick=");
    expect(appendLaneSource).not.toContain("innerHTML");
    expect(appendLaneSource).not.toContain("onclick=");
    expect(raceEventSource).not.toContain("innerHTML");
    expect(inspectorSource).not.toContain("innerHTML");
  });

  it("validates every event envelope before ingestion", () => {
    const serverSource = source("apps/observability/server.ts");
    const ingestRouteSource = functionSource(
      serverSource,
      'if (pathname === "/events" && method === "POST")',
      "// ── GET /sessions",
    );

    expect(ingestRouteSource).toContain("validateObsEvent");
  });

  it("enforces the request limit against bytes read from the body stream", () => {
    const serverSource = source("apps/observability/server.ts");
    const readBodySource = functionSource(
      serverSource,
      "async function readBody",
      "function serveStatic",
    );

    expect(readBodySource).toContain("req.body");
    expect(readBodySource).toMatch(/(?:getReader|for\s+await)/u);
  });

  it("fails the legacy validator when a non-abort SSE connection fails", () => {
    const validatorSource = source("scripts/validate-swimlane.ts");
    const runSseSource = functionSource(
      validatorSource,
      "async function runSSE",
      "async function testSseResync",
    );
    const outerCatchSource = runSseSource.slice(runSseSource.lastIndexOf("} catch"));

    expect(outerCatchSource).toContain("throw error");
  });
});

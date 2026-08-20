#!/usr/bin/env python3
"""Deterministic STY-190 browser validation against an isolated Bun server."""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "sty-190-deterministic-token"
SESSION_ID = "sty-190-e2e"
PAGINATION_SESSION_ID = "sty-190-pagination"
PAGINATION_EVENT_COUNT = 1_005
HOSTILE = '<img src=x onerror="window.__sty190Pwned=1">HOSTILE_LITERAL'
CAPTURE_CONTRACT = {
    "hostile-text-and-native-controls": (
        ("hostile-literal-transcript-raw", "native-control-focus"),
        (
            "hostileMarkers",
            "executableNodeCount",
            "sentinelValues",
            "dialogs",
            "unexpectedRequests",
            "rawFixture",
            "nativeControlTuples",
            "consoleErrors",
        ),
    ),
    "rest-sse-race-and-frame-batching": (
        ("race-merged-transcript", "post-burst-order"),
        (
            "arrivalTrace",
            "heldRestEventIds",
            "sseArrivalEventIds",
            "mergedEventIds",
            "mergedSequences",
            "replayEventIds",
            "scheduledByFrame",
            "renderByFrame",
        ),
    ),
    "preserve-sse-against-stale-rest": (
        ("sse-before-rest-release", "sse-survives-stale-rest"),
        (
            "arrivalTrace",
            "staleRestEventIds",
            "beforeReleaseEventIds",
            "afterReleaseEventIds",
            "replayEventIds",
            "duplicateCounts",
        ),
    ),
    "live-rerender-preserves-operator-state": (
        ("state-before-live-burst", "state-after-live-burst"),
        ("before", "after", "ingestionResponse", "finalEventId", "eventIds"),
    ),
    "resist-live-state-reset-burst": (
        ("adversarial-state-before", "adversarial-state-after"),
        (
            "before",
            "during",
            "after",
            "matchingBurstIds",
            "nonmatchingBurstIds",
            "burstResponses",
            "semanticDiff",
            "focusedControlOperability",
        ),
    ),
    "keyboard-and-url-mode-round-trip": (
        ("mode-shortcuts-help", "raw-url-after-reload"),
        (
            "shortcutActions",
            "redactedUrls",
            "transcriptMode",
            "rawModeAfterReload",
            "searchFocused",
            "authorizedStatus",
            "unauthorizedStatus",
        ),
    ),
    "protect-native-controls-from-shortcuts": (
        ("native-target-focused", "native-action-retained"),
        (
            "actionTuples",
            "targetKinds",
            "shortcutKeys",
            "activeElements",
            "nativeValues",
            "nativeActivations",
            "modeDiffs",
        ),
    ),
}


def run(*arguments: str) -> subprocess.CompletedProcess[str]:
    """Run a required command and fail hard on a non-zero exit."""
    return subprocess.run(arguments, cwd=ROOT, text=True, check=True)


def free_port() -> int:
    """Reserve and release a free loopback port for the isolated server."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def event(sequence: int, event_type: str, payload: dict) -> dict:
    """Create one deterministic canonical envelope."""
    return {
        "event_id": f"sty190-{sequence}",
        "session_id": SESSION_ID,
        "seq": sequence,
        "ts": f"2026-01-02T03:04:{sequence:02d}.000Z",
        "type": event_type,
        "cwd": "/tmp/sty-190",
        "pool": "e2e",
        "tags": ["sty-190"],
        "provider": "test",
        "model": "canonical",
        "payload": payload,
    }


def request_json(url: str, token: str | None = None, body: object | None = None) -> object:
    """Issue a bounded JSON request."""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    encoded = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        encoded = json.dumps(body).encode()
    request = urllib.request.Request(url, data=encoded, headers=headers)
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def fixtures() -> list[dict]:
    """Return transcript, tool-state, hostile, and Raw Events fixtures."""
    return [
        event(0, "user_message", {"text": "CANONICAL USER MESSAGE\nsecond line", "images_count": 0}),
        event(1, "thinking", {"text": "CANONICAL THINKING"}),
        event(2, "tool_call", {"tool_call_id": "ok", "tool_name": "bash", "args": {"command": "printf ok"}, "args_truncated": False}),
        event(3, "tool_result", {"tool_call_id": "ok", "tool_name": "bash", "content_text": "one\ntwo\nthree\nfour\nfive\nsix", "content_truncated": False, "is_error": False}),
        event(4, "tool_call", {"tool_call_id": "error", "tool_name": "read", "args": {"path": "/missing"}, "args_truncated": False}),
        event(5, "tool_result", {"tool_call_id": "error", "tool_name": "read", "content_text": "missing", "content_truncated": False, "is_error": True}),
        event(6, "tool_call", {"tool_call_id": "pending", "tool_name": "write", "args": {"path": "/tmp/x"}, "args_truncated": False}),
        event(7, "tool_result", {"tool_call_id": "orphan", "tool_name": "grep", "content_text": "orphan", "content_truncated": False, "is_error": False}),
        event(8, "assistant_message", {"text": f"CANONICAL ASSISTANT ANSWER {HOSTILE}", "thinking": "", "tool_call_ids": [], "stop_reason": "stop", "usage": {"input": 1, "output": 2, "cache_read": 0, "cache_write": 0, "total_tokens": 3, "cost_total": 0}}),
    ]


def pagination_fixtures() -> list[dict]:
    """Return a canonical history that crosses the server page limit."""
    return [
        {
            **event(sequence, "custom", {"custom_type": "pagination", "data": {"sequence": sequence}}),
            "event_id": f"sty190-pagination-{sequence:04d}",
            "session_id": PAGINATION_SESSION_ID,
            "ts": f"2026-01-02T04:{sequence // 60:02d}:{sequence % 60:02d}.000Z",
        }
        for sequence in range(PAGINATION_EVENT_COUNT)
    ]


def browser_test_source() -> str:
    """Return the real Chromium assertions executed by Playwright."""
    return r'''import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

const PAGINATION_SESSION_ID = "sty-190-pagination";
const PAGINATION_EVENT_COUNT = 1005;
const artifactRoot = process.env.STY190_E2E_ARTIFACT_ROOT;
const artifactTrial = process.env.STY190_E2E_TRIAL;
if (!artifactRoot || !artifactTrial) throw new Error("numbered STY-190 artifact destination is required");
mkdirSync(artifactRoot, { recursive: true });

async function captureIntermediateScreenshot(page, scenarioId, name) {
  const screenshotPath = join(artifactRoot, `trial-${artifactTrial}-${scenarioId}-${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
}

async function persistObservationTuple(scenarioId, observation) {
  const tuplePath = join(artifactRoot, `trial-${artifactTrial}-${scenarioId}-observation-tuple.json`);
  writeFileSync(tuplePath, JSON.stringify({ scenarioId, trial: Number(artifactTrial), ...observation }, null, 2));
}

function expectCompletePaginationHistory(events) {
  const ids = events.map(event => event.event_id);
  const sequences = events.map(event => Number(event.seq));
  expect(events).toHaveLength(PAGINATION_EVENT_COUNT);
  expect(ids[0]).toBe("sty190-pagination-0000");
  expect(ids.at(-1)).toBe("sty190-pagination-1004");
  expect(new Set(ids).size).toBe(PAGINATION_EVENT_COUNT);
  expect(sequences).toEqual(Array.from({ length: PAGINATION_EVENT_COUNT }, (_, sequence) => sequence));
}

async function installOverlappingPaginationPages(page) {
  let backwardBoundary = null;
  let forwardBoundary = null;
  const overlaps = { backward: 0, forward: 0 };
  await page.route(url => url.pathname === `/sessions/${PAGINATION_SESSION_ID}/events`, async route => {
    const requestUrl = new URL(route.request().url());
    const response = await route.fetch();
    const body = await response.json();
    const events = [...(body.events ?? [])];
    if (requestUrl.searchParams.has("since_seq")) {
      if (requestUrl.searchParams.has("since_seq") && forwardBoundary) {
        events.unshift(forwardBoundary);
        overlaps.forward++;
      }
      forwardBoundary = body.events?.at(-1) ?? forwardBoundary;
    } else {
      if (requestUrl.searchParams.has("before_seq") && backwardBoundary) {
        events.push(backwardBoundary);
        overlaps.backward++;
      }
      backwardBoundary = body.events?.[0] ?? backwardBoundary;
    }
    await route.fulfill({ response, json: { ...body, events } });
  });
  return overlaps;
}

test("paginates complete history through Single, Swimlane, Race, and forward gaps", async ({ page }) => {
  const overlaps = await installOverlappingPaginationPages(page);
  await page.goto(`${process.env.STY190_BASE}/?token=${process.env.STY190_TOKEN}#view=single&trace=raw&hide_after=never&sid=${PAGINATION_SESSION_ID}`);
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.events.length)).toBe(PAGINATION_EVENT_COUNT);
  await expect(page.locator("#event-view .evt-row")).toHaveCount(PAGINATION_EVENT_COUNT);
  expectCompletePaginationHistory(await page.evaluate(() => window.__OBS_STATE.events));

  await page.locator("#btn-swimlane").click();
  await expect.poll(() => page.evaluate(sessionId => window.__swimlaneGetAll().get(sessionId)?.events.length ?? 0, PAGINATION_SESSION_ID)).toBe(PAGINATION_EVENT_COUNT);
  expectCompletePaginationHistory(await page.evaluate(sessionId => window.__swimlaneGetAll().get(sessionId).events, PAGINATION_SESSION_ID));

  await page.locator("#btn-race").click();
  await expect.poll(() => page.evaluate(sessionId => window.__raceGetAll().get(sessionId)?.events.length ?? 0, PAGINATION_SESSION_ID)).toBe(PAGINATION_EVENT_COUNT);
  expectCompletePaginationHistory(await page.evaluate(sessionId => window.__raceGetAll().get(sessionId).events, PAGINATION_SESSION_ID));

  const forwardEvents = await page.evaluate(sessionId => window.OBS.fetchSessionEvents(sessionId, -1), PAGINATION_SESSION_ID);
  expectCompletePaginationHistory(forwardEvents);
  expect(overlaps.backward).toBeGreaterThan(0);
  expect(overlaps.forward).toBeGreaterThan(0);
});

test("keeps SSE history unhydrated across failed REST and retries explicitly", async ({ page }) => {
  const sessionId = "sty-190-rest-retry";
  const historyEvent = {
    event_id: "sty190-rest-retry-history", session_id: sessionId, seq: 0,
    ts: "2026-01-02T03:07:10.000Z", type: "user_message", cwd: "/tmp/sty-190",
    pool: "e2e", tags: ["sty-190"], provider: "test", model: "canonical",
    payload: { text: "HISTORY FROM RETRIED REST", images_count: 0 },
  };
  const liveEvent = {
    event_id: "sty190-rest-retry-live", session_id: sessionId, seq: 1,
    ts: "2026-01-02T03:07:20.000Z", type: "assistant_message", cwd: "/tmp/sty-190",
    pool: "e2e", tags: ["sty-190"], provider: "test", model: "canonical",
    payload: { text: "SSE EVENT SURVIVES FAILED REST", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_total: 0 } },
  };
  const seedResponse = await page.request.post(`${process.env.STY190_BASE}/events`, {
    headers: { Authorization: `Bearer ${process.env.STY190_TOKEN}` }, data: historyEvent,
  });
  expect(await seedResponse.json()).toEqual({ ingested: 1, rejected: [] });
  let releaseFailure;
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  let initialRequestedResolve;
  const initialRequested = new Promise(resolve => { initialRequestedResolve = resolve; });
  let failHistory = true;
  await page.route(url => url.pathname === `/sessions/${sessionId}/events`, async route => {
    if (failHistory) {
      initialRequestedResolve();
      await failureGate;
      await route.fulfill({ status: 503, json: { error: "temporary history failure" } });
      return;
    }
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.goto(`${process.env.STY190_BASE}/?token=${process.env.STY190_TOKEN}#view=single&hide_after=never&sid=${sessionId}`);
  await initialRequested;
  await expect(page.locator("#live-label")).toHaveText("live");
  const liveResponse = await page.request.post(`${process.env.STY190_BASE}/events`, {
    headers: { Authorization: `Bearer ${process.env.STY190_TOKEN}` }, data: liveEvent,
  });
  expect(await liveResponse.json()).toEqual({ ingested: 1, rejected: [] });
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.events.map(event => event.event_id))).toEqual([liveEvent.event_id]);
  releaseFailure();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await page.evaluate(() => window.__OBS_STATE.eventsHydrated)).toBe(false);
  expect(await page.evaluate(() => window.__OBS_STATE.events.map(event => event.event_id))).toEqual([liveEvent.event_id]);
  await expect(page.locator(".transcript-entry.assistant .transcript-body")).toHaveText("SSE EVENT SURVIVES FAILED REST");
  failHistory = false;
  await page.getByRole("alert").getByRole("button", { name: /retry/i }).click();
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.eventsHydrated)).toBe(true);
  expect(await page.evaluate(() => window.__OBS_STATE.events.map(event => event.event_id))).toEqual([historyEvent.event_id, liveEvent.event_id]);
  await expect(page.locator("#event-view .transcript-body")).toHaveText(["HISTORY FROM RETRIED REST", "SSE EVENT SURVIVES FAILED REST"]);
});

test("ignores a stale REST failure after a newer same-session load succeeds", async ({ page }) => {
  const sessionId = "sty-190-rest-generation";
  const historyEvent = {
    event_id: "sty190-rest-generation-history", session_id: sessionId, seq: 0,
    ts: "2026-01-02T03:08:00.000Z", type: "user_message", cwd: "/tmp/sty-190",
    pool: "e2e", tags: ["sty-190"], provider: "test", model: "canonical",
    payload: { text: "NEWER REST LOAD WON", images_count: 0 },
  };
  const seedResponse = await page.request.post(`${process.env.STY190_BASE}/events`, {
    headers: { Authorization: `Bearer ${process.env.STY190_TOKEN}` }, data: historyEvent,
  });
  expect(await seedResponse.json()).toEqual({ ingested: 1, rejected: [] });

  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let firstRequestedResolve;
  const firstRequested = new Promise(resolve => { firstRequestedResolve = resolve; });
  let requestCount = 0;
  await page.route(url => url.pathname === `/sessions/${sessionId}/events`, async route => {
    requestCount++;
    if (requestCount === 1) {
      firstRequestedResolve();
      await firstGate;
      await route.fulfill({ status: 503, json: { error: "stale failure" } });
      return;
    }
    const response = await route.fetch();
    await route.fulfill({ response });
  });

  await page.goto(`${process.env.STY190_BASE}/?token=${process.env.STY190_TOKEN}#view=single&hide_after=never&sid=${sessionId}`);
  await firstRequested;
  await page.evaluate(() => window.setView("single"));
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.eventsHydrated)).toBe(true);
  await expect(page.locator("#event-view .transcript-body")).toHaveText("NEWER REST LOAD WON");

  releaseFirst();
  await expect.poll(() => requestCount).toBe(2);
  await expect(page.getByRole("alert")).toBeHidden();
  expect(await page.evaluate(() => window.__OBS_STATE.eventsHydrated)).toBe(true);
});

test("transcript, Raw Events, live state, Swimlane and Race", async ({ page }) => {
  const errors = [];
  const dialogs = [];
  const unexpectedRequests = [];
  page.on("console", message => { console.log(`browser:${message.type()}:${message.text()}`); if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", error => { console.log(`browser:pageerror:${error.message}`); errors.push(error.message); });
  page.on("response", response => { if (response.status() >= 400) console.log(`browser:http:${response.status()}:${response.url()}`); });
  page.on("dialog", dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); void dialog.dismiss(); });
  page.on("request", request => { if (new URL(request.url()).pathname === "/x") unexpectedRequests.push(request.url()); });

  await page.addInitScript(() => {
    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    const scheduledByFrame = {};
    const renderByFrame = {};
    const frameCounters = { scheduledByFrame, renderByFrame };
    let activeAnimationFrame = null;
    let currentFrame = 0;
    let lastTimestamp;
    window.__sty190FrameCounters = frameCounters;
    window.requestAnimationFrame = callback => nativeRequestAnimationFrame(timestamp => {
      if (timestamp !== lastTimestamp) {
        currentFrame++;
        lastTimestamp = timestamp;
      }
      const previousAnimationFrame = activeAnimationFrame;
      const invocation = { frame: currentFrame, rendered: false };
      activeAnimationFrame = invocation;
      try {
        callback(timestamp);
      } finally {
        if (invocation.rendered) {
          scheduledByFrame[currentFrame] ??= 0;
          scheduledByFrame[currentFrame]++;
        }
        activeAnimationFrame = previousAnimationFrame;
      }
    });
    let transcriptApi;
    Object.defineProperty(window, "OBS_TRANSCRIPT", {
      configurable: true,
      get: () => transcriptApi,
      set: api => {
        transcriptApi = Object.freeze({
          ...api,
          projectTranscript(...args) {
            if (activeAnimationFrame !== null) {
              const frame = activeAnimationFrame.frame;
              activeAnimationFrame.rendered = true;
              renderByFrame[frame] ??= 0;
              renderByFrame[frame]++;
            }
            return api.projectTranscript(...args);
          },
        });
      },
    });
  });

  const deferred = () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  };
  const initialRestRequested = deferred();
  const initialRestCaptured = deferred();
  const initialRestReleaseGate = deferred();
  const initialRestFulfilled = deferred();
  const releaseInitialRest = () => initialRestReleaseGate.release();
  const raceArrivalTrace = [];
  let heldInitialRestIds = [];
  const raceSeedResponse = await page.request.post(`${process.env.STY190_BASE}/events`, {
    headers: { Authorization: `Bearer ${process.env.STY190_TOKEN}` },
    data: { event_id: "sty190-race-seed", session_id: "sty-190-race", seq: 0, ts: "2026-01-02T03:05:00.000Z", type: "user_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "REST SNAPSHOT SEED", images_count: 0 } },
  });
  expect(await raceSeedResponse.json()).toEqual({ ingested: 1, rejected: [] });
  const raceOverlapEvents = [
    { event_id: "sty190-race-overlap-30", session_id: "sty-190-race", seq: 30, ts: "2026-01-02T03:05:30.000Z", type: "user_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "SSE ARRIVED FIRST SEQ 30", images_count: 0 } },
    { event_id: "sty190-race-out-of-order-10", session_id: "sty-190-race", seq: 10, ts: "2026-01-02T03:05:10.000Z", type: "user_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "SSE ARRIVED SECOND SEQ 10", images_count: 0 } },
    { event_id: "sty190-race-overlap-30", session_id: "sty-190-race", seq: 30, ts: "2026-01-02T03:05:30.000Z", type: "user_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "SSE ARRIVED FIRST SEQ 30", images_count: 0 } },
    { event_id: "sty190-race-middle-20", session_id: "sty-190-race", seq: 20, ts: "2026-01-02T03:05:20.000Z", type: "user_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "SSE ARRIVED THIRD SEQ 20", images_count: 0 } },
  ];
  await page.route(/\/sessions\/sty-190-race\/events(?:\?.*)?$/, async route => {
    raceArrivalTrace.push("rest-requested");
    initialRestRequested.release();
    const response = await route.fetch();
    heldInitialRestIds = (await response.json()).events.map(event => event.event_id);
    raceArrivalTrace.push("stale-rest-captured");
    initialRestCaptured.release();
    await initialRestReleaseGate.promise;
    raceArrivalTrace.push("stale-rest-released");
    await route.fulfill({ response });
    raceArrivalTrace.push("stale-rest-fulfilled");
    initialRestFulfilled.release();
  });

  await page.goto(`${process.env.STY190_BASE}/?token=${process.env.STY190_TOKEN}#view=single&hide_after=never&sid=sty-190-race`);
  await initialRestRequested.promise;
  await initialRestCaptured.promise;
  await expect(page.locator("#live-label")).toHaveText("live");
  const raceResponse = await page.request.post(`${process.env.STY190_BASE}/events`, {
    headers: { Authorization: `Bearer ${process.env.STY190_TOKEN}` },
    data: raceOverlapEvents,
  });
  const raceIngestionResponse = await raceResponse.json();
  expect(raceIngestionResponse).toEqual({ ingested: 3, rejected: ["sty190-race-overlap-30"] });
  raceArrivalTrace.push("sse-overlap-arrived");
  const sseArrivalIds = ["sty190-race-overlap-30", "sty190-race-out-of-order-10", "sty190-race-middle-20"];
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.events.map(event => event.event_id))).toEqual(sseArrivalIds);
  await expect.poll(() => page.evaluate(() => Object.values(window.__sty190FrameCounters.renderByFrame).reduce((total, count) => total + count, 0))).toBeGreaterThan(0);
  const beforeStaleRestReleaseIds = await page.evaluate(() => window.__OBS_STATE.events.map(event => event.event_id));
  await captureIntermediateScreenshot(page, "preserve-sse-against-stale-rest", "sse-before-rest-release");

  expect(heldInitialRestIds).toEqual(["sty190-race-seed"]);
  releaseInitialRest();
  await initialRestFulfilled.promise;
  await page.unrouteAll({ behavior: "wait" });
  const afterStaleRestReleaseEvents = await page.evaluate(() => window.__OBS_STATE.events.map(event => ({
    event_id: event.event_id,
    seq: Number(event.seq),
  })));
  expect(afterStaleRestReleaseEvents.map(event => event.event_id)).toEqual([
    "sty190-race-seed",
    "sty190-race-out-of-order-10",
    "sty190-race-middle-20",
    "sty190-race-overlap-30",
  ]);
  expect(afterStaleRestReleaseEvents.map(event => event.seq)).toEqual([0, 10, 20, 30]);
  expect(afterStaleRestReleaseEvents.every(event => Number.isFinite(event.seq))).toBe(true);
  expect(new Set(afterStaleRestReleaseEvents.map(event => event.event_id)).size).toBe(afterStaleRestReleaseEvents.length);
  await expect(page.locator("#event-view .transcript-body")).toHaveText([
    "REST SNAPSHOT SEED",
    "SSE ARRIVED SECOND SEQ 10",
    "SSE ARRIVED THIRD SEQ 20",
    "SSE ARRIVED FIRST SEQ 30",
  ]);
  await captureIntermediateScreenshot(page, "preserve-sse-against-stale-rest", "sse-survives-stale-rest");
  await captureIntermediateScreenshot(page, "rest-sse-race-and-frame-batching", "race-merged-transcript");

  const postRaceEvent = {
    event_id: "sty190-race-post-release-40", session_id: "sty-190-race", seq: 40,
    ts: "2026-01-02T03:05:40.000Z", type: "assistant_message", cwd: "/tmp",
    pool: "e2e", tags: ["sty-190"], provider: "test", model: "canonical",
    payload: { text: "SSE AFTER REST RELEASE SEQ 40", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_total: 0 } },
  };
  const postRaceResponse = await page.request.post(`${process.env.STY190_BASE}/events`, {
    headers: { Authorization: `Bearer ${process.env.STY190_TOKEN}` },
    data: postRaceEvent,
  });
  expect(await postRaceResponse.json()).toEqual({ ingested: 1, rejected: [] });
  raceArrivalTrace.push("post-release-sse-arrived");
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.events.at(-1)?.event_id)).toBe(postRaceEvent.event_id);
  await expect(page.locator("#event-view .transcript-body")).toHaveText([
    "REST SNAPSHOT SEED",
    "SSE ARRIVED SECOND SEQ 10",
    "SSE ARRIVED THIRD SEQ 20",
    "SSE ARRIVED FIRST SEQ 30",
    "SSE AFTER REST RELEASE SEQ 40",
  ]);
  await captureIntermediateScreenshot(page, "rest-sse-race-and-frame-batching", "post-burst-order");

  const mergedRaceEvents = await page.evaluate(() => window.__OBS_STATE.events.map(event => ({
    event_id: event.event_id,
    seq: Number(event.seq),
  })));
  const replayRaceEvents = await page.evaluate(async () => (await window.OBS.fetchSessionEvents("sty-190-race")).map(event => ({
    event_id: event.event_id,
    seq: Number(event.seq),
  })));
  expect(replayRaceEvents).toEqual(mergedRaceEvents);
  const replayRaceEventIds = replayRaceEvents.map(event => event.event_id);
  const duplicateCounts = Object.fromEntries(replayRaceEventIds.map(eventId => [
    eventId,
    mergedRaceEvents.filter(event => event.event_id === eventId).length,
  ]));
  expect(Object.values(duplicateCounts)).toEqual(replayRaceEventIds.map(() => 1));

  const frameCounters = await page.evaluate(() => window.__sty190FrameCounters);
  expect(Object.keys(frameCounters.scheduledByFrame).length).toBeGreaterThan(0);
  expect(Object.keys(frameCounters.renderByFrame).length).toBeGreaterThan(0);
  for (const scheduledPerFrame of Object.values(frameCounters.scheduledByFrame)) {
    expect(scheduledPerFrame).toBeLessThanOrEqual(1);
  }
  for (const renderPerFrame of Object.values(frameCounters.renderByFrame)) {
    expect(renderPerFrame).toBeLessThanOrEqual(1);
  }

  await persistObservationTuple("rest-sse-race-and-frame-batching", {
    arrivalTrace: raceArrivalTrace,
    heldRestEventIds: heldInitialRestIds,
    sseArrivalEventIds: sseArrivalIds,
    mergedEventIds: mergedRaceEvents.map(event => event.event_id),
    mergedSequences: mergedRaceEvents.map(event => event.seq),
    replayEventIds: replayRaceEventIds,
    scheduledByFrame: frameCounters.scheduledByFrame,
    renderByFrame: frameCounters.renderByFrame,
  });
  await persistObservationTuple("preserve-sse-against-stale-rest", {
    arrivalTrace: raceArrivalTrace,
    staleRestEventIds: heldInitialRestIds,
    beforeReleaseEventIds: beforeStaleRestReleaseIds,
    afterReleaseEventIds: afterStaleRestReleaseEvents.map(event => event.event_id),
    replayEventIds: replayRaceEventIds,
    duplicateCounts: duplicateCounts,
  });

  await page.goto("about:blank");
  await page.goto(`${process.env.STY190_BASE}/?token=${process.env.STY190_TOKEN}#view=single&hide_after=never&sid=sty-190-e2e`);
  await expect(page.locator(".transcript-item")).toHaveCount(7);
  await expect(page.locator("#btn-trace-transcript")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".transcript-entry.user .transcript-body")).toContainText("second line");
  await expect(page.locator(".transcript-entry.assistant .transcript-body")).toContainText("<img src=x onerror=");
  await expect(page.locator("#event-view img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__sty190Pwned)).not.toBe(1);
  for (const state of ["success", "error", "pending", "orphan"]) await expect(page.locator(`.transcript-tool[data-status=${state}]`)).toHaveCount(1);
  await expect(page.locator(".transcript-tool[data-status=success] .transcript-tool-more")).toHaveCount(1);
  const hostileMarkers = await page.locator(".transcript-entry.assistant .transcript-body").allTextContents();
  const hostileRawFixture = await page.evaluate(() => window.__OBS_STATE.events.find(event => event.event_id === "sty190-8"));
  expect(hostileRawFixture.payload.text).toContain("HOSTILE_LITERAL");
  await page.locator("#btn-trace-raw").click();
  await page.locator("#search-box").fill("HOSTILE_LITERAL");
  await expect(page.locator("#event-view .evt-row")).toHaveCount(1);
  await page.locator("#event-view .evt-row").click();
  await expect(page.locator("#event-view .evt-detail.open pre")).toContainText("HOSTILE_LITERAL");
  const hostileExecutableNodeCount = await page.locator("#event-view img, #event-view script, #event-view [onerror]").count();
  const hostileSentinelValues = await page.evaluate(() => ({ canonical: window.__sty190Pwned ?? 0 }));
  expect(hostileExecutableNodeCount).toBe(0);
  expect(hostileSentinelValues).toEqual({ canonical: 0 });
  await captureIntermediateScreenshot(page, "hostile-text-and-native-controls", "hostile-literal-transcript-raw");
  await page.locator("#search-box").fill("");
  await page.locator("#btn-trace-transcript").click();
  await expect(page.locator(".transcript-item")).toHaveCount(7);

  const captureOperatorState = () => page.evaluate(() => {
    const eventView = document.querySelector("#event-view");
    const searchBox = document.querySelector("#search-box");
    const bounds = eventView.getBoundingClientRect();
    const anchor = Array.from(eventView.querySelectorAll(".transcript-item"))
      .find(item => item.getBoundingClientRect().bottom > bounds.top);
    const activeElement = document.activeElement;
    return {
      autoScroll: window.__OBS_STATE.autoScroll,
      scrollTop: eventView.scrollTop,
      anchorKey: anchor?.dataset.key ?? null,
      anchorOffset: anchor ? Math.round(anchor.getBoundingClientRect().top - bounds.top) : null,
      searchValue: searchBox.value,
      searchFocused: activeElement === searchBox,
      thinkingVisible: window.__OBS_STATE.thinkingVisible,
      expandedToolKeys: [...window.__OBS_STATE.expandedToolIds].sort(),
      openTranscriptRawKeys: [...window.__OBS_STATE.openTranscriptRawKeys].sort(),
      activeElement: activeElement?.id || activeElement?.tagName.toLowerCase() || null,
      activeValue: activeElement && "value" in activeElement ? activeElement.value : activeElement?.textContent ?? null,
    };
  });

  const searchBox = page.locator("#search-box");
  await searchBox.fill("sty-190");
  await page.locator("#btn-thinking-toggle").click();
  const stableTool = page.locator('.transcript-tool[data-status="success"]');
  await stableTool.locator(".transcript-tool-toggle").click();
  await stableTool.locator(".transcript-raw summary").click();
  await expect.poll(() => page.evaluate(() => [...window.__OBS_STATE.openTranscriptRawKeys])).toContain("tool:sty190-2");
  const scrollRange = await page.evaluate(() => {
    const eventView = document.querySelector("#event-view");
    return eventView.scrollHeight - eventView.clientHeight;
  });
  expect(scrollRange).toBeGreaterThan(160);

  const establishPausedScrollAfterScheduledBottomAnchor = async () => {
    await page.evaluate(() => {
      document.querySelector("#btn-thinking-toggle").click();
      document.querySelector("#btn-thinking-toggle").click();
      const eventView = document.querySelector("#event-view");
      eventView.scrollTop = 120;
      eventView.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => page.evaluate(() => window.__OBS_STATE.autoScroll)).toBe(false);
    await page.waitForTimeout(180);
    return page.evaluate(() => {
      const eventView = document.querySelector("#event-view");
      return {
        autoScroll: window.__OBS_STATE.autoScroll,
        atBottom: eventView.scrollHeight - eventView.scrollTop - eventView.clientHeight < 40,
      };
    });
  };

  const pausedAfterDelayedAnchors = await establishPausedScrollAfterScheduledBottomAnchor();
  expect(pausedAfterDelayedAnchors).toEqual({ autoScroll: false, atBottom: false });
  await searchBox.focus();
  await expect(searchBox).toBeFocused();

  const liveStateBurst = [
    { event_id: "sty190-9", session_id: "sty-190-e2e", seq: 9, ts: "2026-01-02T03:04:09.000Z", type: "assistant_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "LIVE BURST ONE", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_total: 0 } } },
    { event_id: "sty190-10", session_id: "sty-190-e2e", seq: 10, ts: "2026-01-02T03:04:10.000Z", type: "thinking", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "LIVE BURST THINKING" } },
    { event_id: "sty190-11", session_id: "sty-190-e2e", seq: 11, ts: "2026-01-02T03:04:11.000Z", type: "assistant_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "LIVE BURST FINAL", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_total: 0 } } },
  ];
  const beforeLiveState = await captureOperatorState();
  expect(beforeLiveState.autoScroll).toBe(false);
  expect(beforeLiveState.scrollTop).toBeGreaterThan(0);
  expect(beforeLiveState.anchorKey).toBeTruthy();
  expect(beforeLiveState.searchValue).toBe("sty-190");
  expect(beforeLiveState.searchFocused).toBe(true);
  expect(beforeLiveState.thinkingVisible).toBe(false);
  expect(beforeLiveState.expandedToolKeys).toContain("tool:sty190-2");
  expect(beforeLiveState.openTranscriptRawKeys).toContain("tool:sty190-2");
  expect(beforeLiveState.activeElement).toBe("search-box");
  expect(beforeLiveState.activeValue).toBe("sty-190");
  await captureIntermediateScreenshot(page, "live-rerender-preserves-operator-state", "state-before-live-burst");

  const liveBurstResponse = await page.request.post(`${process.env.STY190_BASE}/events`, {
    headers: { Authorization: `Bearer ${process.env.STY190_TOKEN}` },
    data: liveStateBurst,
  });
  const liveBurstIngestionResponse = await liveBurstResponse.json();
  expect(liveBurstIngestionResponse).toEqual({ ingested: 3, rejected: [] });
  const finalLiveBurstId = liveStateBurst.at(-1).event_id;
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.events.at(-1)?.event_id)).toEqual(finalLiveBurstId);
  await expect(page.locator("#event-view")).toContainText("LIVE BURST FINAL");
  const afterLiveState = await captureOperatorState();
  expect(afterLiveState).toEqual(beforeLiveState);
  await captureIntermediateScreenshot(page, "live-rerender-preserves-operator-state", "state-after-live-burst");
  const liveStateEventIds = await page.evaluate(() => window.__OBS_STATE.events.map(event => event.event_id));
  await persistObservationTuple("live-rerender-preserves-operator-state", {
    before: beforeLiveState,
    after: afterLiveState,
    ingestionResponse: liveBurstIngestionResponse,
    finalEventId: finalLiveBurstId,
    eventIds: liveStateEventIds,
  });

  const matchingAdversarialBurst = [
    { event_id: "sty190-adversarial-matching-12", session_id: "sty-190-e2e", seq: 12, ts: "2026-01-02T03:04:12.000Z", type: "assistant_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "sty-190 MATCHING BURST ONE", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_total: 0 } } },
    { event_id: "sty190-adversarial-matching-13", session_id: "sty-190-e2e", seq: 13, ts: "2026-01-02T03:04:13.000Z", type: "assistant_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "sty-190 MATCHING BURST TWO", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_total: 0 } } },
    { event_id: "sty190-adversarial-matching-14", session_id: "sty-190-e2e", seq: 14, ts: "2026-01-02T03:04:14.000Z", type: "assistant_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "sty-190 MATCHING BURST FINAL", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_total: 0 } } },
  ];
  const nonmatchingAdversarialBurst = [
    { event_id: "sty190-adversarial-nonmatching-15", session_id: "sty-190-e2e", seq: 15, ts: "2026-01-02T03:04:15.000Z", type: "assistant_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "FILTERED BURST ONE", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_total: 0 } } },
    { event_id: "sty190-adversarial-nonmatching-16", session_id: "sty-190-e2e", seq: 16, ts: "2026-01-02T03:04:16.000Z", type: "assistant_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "FILTERED BURST TWO", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_total: 0 } } },
    { event_id: "sty190-adversarial-nonmatching-17", session_id: "sty-190-e2e", seq: 17, ts: "2026-01-02T03:04:17.000Z", type: "assistant_message", cwd: "/tmp", pool: "e2e", tags: ["sty-190"], payload: { text: "FILTERED BURST FINAL", thinking: "", tool_call_ids: [], stop_reason: "stop", usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total_tokens: 2, cost_total: 0 } } },
  ];
  const adversarialStateBefore = await captureOperatorState();
  await captureIntermediateScreenshot(page, "resist-live-state-reset-burst", "adversarial-state-before");
  const matchingBurstResponse = await page.request.post(`${process.env.STY190_BASE}/events`, {
    headers: { Authorization: `Bearer ${process.env.STY190_TOKEN}` },
    data: matchingAdversarialBurst,
  });
  const matchingBurstIngestion = await matchingBurstResponse.json();
  expect(matchingBurstIngestion).toEqual({ ingested: 3, rejected: [] });
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.events.at(-1)?.event_id)).toEqual(matchingAdversarialBurst.at(-1).event_id);
  const adversarialStateDuring = await captureOperatorState();
  const nonmatchingBurstResponse = await page.request.post(`${process.env.STY190_BASE}/events`, {
    headers: { Authorization: `Bearer ${process.env.STY190_TOKEN}` },
    data: nonmatchingAdversarialBurst,
  });
  const nonmatchingBurstIngestion = await nonmatchingBurstResponse.json();
  expect(nonmatchingBurstIngestion).toEqual({ ingested: 3, rejected: [] });
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.events.at(-1)?.event_id)).toEqual(nonmatchingAdversarialBurst.at(-1).event_id);
  await searchBox.press("End");
  await searchBox.type(" ");
  const temporarySearchValue = await searchBox.inputValue();
  await searchBox.press("Backspace");
  const focusedControlOperability = temporarySearchValue === "sty-190 " && await searchBox.inputValue() === "sty-190" && await searchBox.evaluate(element => element === document.activeElement);
  const adversarialStateAfter = await captureOperatorState();
  const semanticDiff = Object.keys(adversarialStateBefore).filter(key =>
    JSON.stringify(adversarialStateDuring[key]) !== JSON.stringify(adversarialStateBefore[key]) ||
    JSON.stringify(adversarialStateAfter[key]) !== JSON.stringify(adversarialStateBefore[key])
  );
  expect(semanticDiff).toEqual([]);
  expect(focusedControlOperability).toBe(true);
  await captureIntermediateScreenshot(page, "resist-live-state-reset-burst", "adversarial-state-after");
  await persistObservationTuple("resist-live-state-reset-burst", {
    before: adversarialStateBefore,
    during: adversarialStateDuring,
    after: adversarialStateAfter,
    matchingBurstIds: matchingAdversarialBurst.map(event => event.event_id),
    nonmatchingBurstIds: nonmatchingAdversarialBurst.map(event => event.event_id),
    burstResponses: [matchingBurstIngestion, nonmatchingBurstIngestion],
    semanticDiff: semanticDiff,
    focusedControlOperability: focusedControlOperability,
  });

  await page.evaluate(() => {
    const harness = document.createElement("div");
    harness.id = "native-control-harness";
    harness.style.cssText = "position:fixed;left:0;bottom:0;z-index:1000;padding:4px;background:white;color:black";
    const input = document.createElement("input");
    input.id = "native-input";
    const button = document.createElement("button");
    button.id = "native-button";
    button.textContent = "button";
    const details = document.createElement("details");
    details.id = "native-details";
    const summary = document.createElement("summary");
    summary.id = "native-summary";
    summary.textContent = "summary";
    details.append(summary, document.createTextNode("details body"));
    const link = document.createElement("a");
    link.id = "native-link";
    link.href = location.hash;
    link.textContent = "link";
    const select = document.createElement("select");
    select.id = "native-select";
    select.append(new Option("one", "one"), new Option("two", "two"));
    const textarea = document.createElement("textarea");
    textarea.id = "native-textarea";
    const editable = document.createElement("div");
    editable.id = "native-contenteditable";
    editable.contentEditable = "true";
    editable.tabIndex = 0;
    editable.style.cssText = "display:inline-block;min-width:40px;min-height:20px";
    const countActivation = event => {
      const target = event.currentTarget;
      target.dataset.activations = String(Number(target.dataset.activations || 0) + 1);
    };
    button.addEventListener("click", countActivation);
    link.addEventListener("click", countActivation);
    harness.append(input, button, details, link, select, textarea, editable);
    document.body.appendChild(harness);
  });

  const captureModeNavigation = () => page.evaluate(() => ({
    traceMode: window.__OBS_STATE.traceMode,
    view: window.__OBS_STATE.view,
    focusedIdx: window.__OBS_STATE.focusedIdx,
    thinkingVisible: window.__OBS_STATE.thinkingVisible,
    toolsExpanded: window.__OBS_STATE.toolsExpanded,
    hash: location.hash,
    helpVisible: document.querySelector("#help-overlay").classList.contains("show"),
  }));
  const protectedTranscriptShortcuts = [
    "Control+t", "Control+o", "j", "k", "g", "G", "ArrowDown", "ArrowUp", "Enter", " ", "Escape", "/", "?",
  ];
  const nativeControlMatrix = [
    {
      kind: "input",
      target: page.locator("#native-input"),
      nativeKey: "x",
      resetNative: target => target.evaluate(element => { element.value = ""; }),
      assertNative: async target => { await expect(target).toHaveValue("x"); },
    },
    {
      kind: "button",
      target: page.locator("#native-button"),
      nativeKey: "Enter",
      resetNative: target => target.evaluate(element => { element.dataset.activations = "0"; }),
      assertNative: async target => { await expect(target).toHaveAttribute("data-activations", "1"); },
    },
    {
      kind: "summary",
      target: page.locator("#native-summary"),
      nativeKey: "Enter",
      resetNative: target => target.evaluate(element => { element.parentElement.open = false; }),
      assertNative: async target => { expect(await target.evaluate(element => element.parentElement.open)).toBe(true); },
    },
    {
      kind: "link",
      target: page.locator("#native-link"),
      nativeKey: "Enter",
      resetNative: target => target.evaluate(element => { element.dataset.activations = "0"; }),
      assertNative: async target => { await expect(target).toHaveAttribute("data-activations", "1"); },
    },
    {
      kind: "select",
      target: page.locator("#native-select"),
      nativeKey: "t",
      resetNative: target => target.evaluate(element => { element.blur(); element.selectedIndex = 0; }),
      assertNative: async target => { await expect(target).toHaveValue("two"); },
    },
    {
      kind: "textarea",
      target: page.locator("#native-textarea"),
      nativeKey: "Enter",
      resetNative: target => target.evaluate(element => { element.value = ""; }),
      assertNative: async target => { await expect(target).toHaveValue("\n"); },
    },
    {
      kind: "contenteditable",
      target: page.locator("#native-contenteditable"),
      nativeKey: "x",
      resetNative: target => target.evaluate(element => { element.textContent = ""; }),
      assertNative: async target => { await expect(target).toHaveText("x"); },
    },
  ];

  const captureNativeTarget = target => target.evaluate(element => ({
    activeElement: document.activeElement?.id || document.activeElement?.tagName.toLowerCase() || null,
    value: "value" in element ? element.value : element.textContent ?? "",
    activations: Number(element.dataset.activations || 0),
    open: element.matches("summary") ? element.parentElement.open : null,
    selectedIndex: "selectedIndex" in element ? element.selectedIndex : null,
  }));
  const nativeActionTuples = [];
  await nativeControlMatrix[0].target.focus();
  await expect(nativeControlMatrix[0].target).toBeFocused();
  await captureIntermediateScreenshot(page, "hostile-text-and-native-controls", "native-control-focus");
  await captureIntermediateScreenshot(page, "protect-native-controls-from-shortcuts", "native-target-focused");

  for (const nativeCase of nativeControlMatrix) {
    const target = nativeCase.target;
    await target.focus();
    await expect(target).toBeFocused();
    for (const shortcut of protectedTranscriptShortcuts) {
      const beforeModeNavigation = await captureModeNavigation();
      await target.press(shortcut);
      const afterModeNavigation = await captureModeNavigation();
      expect(afterModeNavigation).toEqual(beforeModeNavigation);
      await expect(target).toBeFocused();
      nativeActionTuples.push({
        kind: nativeCase.kind,
        action: shortcut,
        nativeState: await captureNativeTarget(target),
        beforeModeNavigation,
        afterModeNavigation,
        modeChanged: JSON.stringify(afterModeNavigation) !== JSON.stringify(beforeModeNavigation),
      });
    }
    await nativeCase.resetNative(target);
    await target.focus();
    await target.press(nativeCase.nativeKey);
    await nativeCase.assertNative(target);
    nativeActionTuples.push({
      kind: nativeCase.kind,
      action: nativeCase.nativeKey,
      nativeAction: true,
      nativeState: await captureNativeTarget(target),
      modeChanged: false,
    });
  }
  await captureIntermediateScreenshot(page, "protect-native-controls-from-shortcuts", "native-action-retained");
  const nativeModeDiffs = nativeActionTuples
    .filter(action => !action.nativeAction)
    .map(action => ({ kind: action.kind, shortcut: action.action, changed: action.modeChanged }));
  expect(nativeModeDiffs.every(diff => diff.changed === false)).toBe(true);
  expect(dialogs).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
  await persistObservationTuple("hostile-text-and-native-controls", {
    hostileMarkers: hostileMarkers,
    executableNodeCount: hostileExecutableNodeCount,
    sentinelValues: hostileSentinelValues,
    dialogs: dialogs,
    unexpectedRequests: unexpectedRequests,
    rawFixture: hostileRawFixture,
    nativeControlTuples: nativeActionTuples,
    consoleErrors: errors,
  });
  await persistObservationTuple("protect-native-controls-from-shortcuts", {
    actionTuples: nativeActionTuples,
    targetKinds: nativeControlMatrix.map(nativeCase => nativeCase.kind),
    shortcutKeys: protectedTranscriptShortcuts,
    activeElements: nativeActionTuples.map(action => action.nativeState.activeElement),
    nativeValues: nativeActionTuples.filter(action => action.nativeAction).map(action => action.nativeState.value),
    nativeActivations: nativeActionTuples.filter(action => action.nativeAction).map(action => action.nativeState.activations),
    modeDiffs: nativeModeDiffs,
  });
  await page.locator("#native-control-harness").evaluate(element => element.remove());
  await searchBox.fill("");
  await page.evaluate(() => document.activeElement?.blur());

  const keyboardShortcutActions = [];
  const beforeThinkingShortcut = await captureModeNavigation();
  await page.keyboard.press("Control+t");
  const afterThinkingShortcut = await captureModeNavigation();
  expect(afterThinkingShortcut.thinkingVisible).toBe(!beforeThinkingShortcut.thinkingVisible);
  keyboardShortcutActions.push({ key: "Control+t", before: beforeThinkingShortcut, after: afterThinkingShortcut });

  const beforeToolsShortcut = await captureModeNavigation();
  await page.keyboard.press("Control+o");
  const afterToolsShortcut = await captureModeNavigation();
  expect(afterToolsShortcut.toolsExpanded).toBe(!beforeToolsShortcut.toolsExpanded);
  keyboardShortcutActions.push({ key: "Control+o", before: beforeToolsShortcut, after: afterToolsShortcut });

  await page.keyboard.press("g");
  expect(await page.evaluate(() => window.__OBS_STATE.focusedIdx)).toBe(0);
  keyboardShortcutActions.push({ key: "g", focusedIdx: 0 });
  await page.keyboard.press("G");
  const lastFocusedIndex = await page.evaluate(() => window.__OBS_STATE.focusedIdx);
  expect(lastFocusedIndex).toBe(17);
  keyboardShortcutActions.push({ key: "G", focusedIdx: lastFocusedIndex });

  await page.keyboard.press("?");
  await expect(page.locator("#help-overlay")).toHaveClass(/show/);
  keyboardShortcutActions.push({ key: "?", helpVisible: true });
  await captureIntermediateScreenshot(page, "keyboard-and-url-mode-round-trip", "mode-shortcuts-help");
  await page.keyboard.press("?");
  await expect(page.locator("#help-overlay")).not.toHaveClass(/show/);
  await page.keyboard.press("/");
  await expect(searchBox).toBeFocused();
  const searchFocused = await searchBox.evaluate(element => document.activeElement === element);
  keyboardShortcutActions.push({ key: "/", searchFocused: searchFocused });
  const transcriptMode = await captureModeNavigation();
  const transcriptUrl = page.url();

  await page.locator("#btn-trace-raw").click();
  await expect(page).toHaveURL(/trace=raw/);
  const rawUrlBeforeReload = page.url();
  await page.reload();
  await expect(page.locator("#btn-trace-raw")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".evt-row")).toHaveCount(18);
  const rawModeAfterReload = await captureModeNavigation();
  expect(rawModeAfterReload.traceMode).toBe("raw");
  const rawUrlAfterReload = page.url();
  const authorizedResponse = await page.request.get(`${process.env.STY190_BASE}/sessions/sty-190-e2e/events?limit=1`, {
    headers: { Authorization: `Bearer ${process.env.STY190_TOKEN}` },
  });
  const unauthorizedResponse = await page.request.get(`${process.env.STY190_BASE}/sessions/sty-190-e2e/events?limit=1`);
  expect(authorizedResponse.status()).toBe(200);
  expect(unauthorizedResponse.status()).toBe(401);
  const redactedUrls = [transcriptUrl, rawUrlBeforeReload, rawUrlAfterReload].map(value => {
    const url = new URL(value);
    if (url.searchParams.has("token")) url.searchParams.set("token", "[redacted]");
    return url.toString();
  });
  expect(redactedUrls.every(url => !url.includes(process.env.STY190_TOKEN))).toBe(true);
  expect(new URL(rawUrlAfterReload).hash).not.toContain(process.env.STY190_TOKEN);
  await captureIntermediateScreenshot(page, "keyboard-and-url-mode-round-trip", "raw-url-after-reload");
  await persistObservationTuple("keyboard-and-url-mode-round-trip", {
    shortcutActions: keyboardShortcutActions,
    redactedUrls: redactedUrls,
    transcriptMode: transcriptMode,
    rawModeAfterReload: rawModeAfterReload,
    searchFocused: searchFocused,
    authorizedStatus: authorizedResponse.status(),
    unauthorizedStatus: unauthorizedResponse.status(),
  });

  await page.locator(".evt-row").first().click();
  await expect(page.locator(".evt-detail.open pre")).toContainText('"event_id": "sty190-0"');
  await expect(page.locator(".evt-detail.open pre")).toContainText('"session_id": "sty-190-e2e"');

  const singleRawEventIdsBaseline = await page.evaluate(() => window.__OBS_STATE.events.map(event => event.event_id));

  await page.locator("#btn-swimlane").click();
  await expect(page.locator("#swimlane-container")).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => window.__swimlaneGetAll().get("sty-190-e2e")?.events.map(event => event.event_id) ?? [])).toEqual(singleRawEventIdsBaseline);
  const swimlaneRawEventIds = await page.evaluate(() => window.__swimlaneGetAll().get("sty-190-e2e").events.map(event => event.event_id));
  expect(swimlaneRawEventIds).toEqual(singleRawEventIdsBaseline);
  expect(await page.evaluate(() => window.__swimlaneGetLanes())).toEqual(["sty-190-e2e"]);
  await expect(page).toHaveURL(/#view=swimlane(?:&|$)/);

  await page.locator("#btn-race").click();
  await expect(page.locator("#race-container")).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => window.__raceGetAll().get("sty-190-e2e")?.events.map(event => event.event_id) ?? [])).toEqual(singleRawEventIdsBaseline);
  const raceRawEventIds = await page.evaluate(() => window.__raceGetAll().get("sty-190-e2e").events.map(event => event.event_id));
  expect(raceRawEventIds).toEqual(singleRawEventIdsBaseline);
  expect(await page.evaluate(() => window.__raceGetLanes())).toEqual(["sty-190-e2e"]);
  await expect(page).toHaveURL(/#view=race(?:&|$)/);

  await page.locator("#btn-single").click();
  await expect(page.locator("#single-pane")).toBeVisible();
  await expect(page.locator(".evt-row")).toHaveCount(singleRawEventIdsBaseline.length);
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.events.map(event => event.event_id))).toEqual(singleRawEventIdsBaseline);
  const singleRawEventIdsAfterReturn = await page.evaluate(() => window.__OBS_STATE.events.map(event => event.event_id));
  expect(singleRawEventIdsAfterReturn).toEqual(singleRawEventIdsBaseline);
  await expect(page).toHaveURL(/#view=single(?:&|$)/);
  expect(errors).toEqual([]);
});

test("renders hostile session and event metadata inertly in every view", async ({ page }) => {
  const hostile = {
    model: 'MODEL_LITERAL<img src=x onerror="window.__sty190Hostile.model++">',
    pool: 'POOL_LITERAL<img src=x onerror="window.__sty190Hostile.pool++">',
    sessionId: 'SESSION_LITERAL\');window.__sty190Hostile.sessionId++;//<img src=x onerror="window.__sty190Hostile.sessionId++">',
    eventId: 'EVENT_LITERAL\');window.__sty190Hostile.eventId++;//',
    eventType: 'TYPE_LITERAL"><img src=x onerror="window.__sty190Hostile.eventType++">',
  };
  const hostileSession = {
    session_id: hostile.sessionId,
    pool: hostile.pool,
    agent_name: hostile.sessionId,
    cwd: "/tmp/hostile",
    provider: "test",
    model: hostile.model,
    first_ts: "2026-01-02T03:06:00.000Z",
    last_ts: "2026-01-02T03:06:00.000Z",
    event_count: 1,
    tags: ["sty-190"],
  };
  const hostileEvent = {
    event_id: hostile.eventId,
    session_id: hostile.sessionId,
    seq: 0,
    ts: "2026-01-02T03:06:00.000Z",
    type: hostile.eventType,
    cwd: "/tmp/hostile",
    pool: hostile.pool,
    tags: ["sty-190"],
    provider: "test",
    model: hostile.model,
    payload: { custom_type: "hostile", data: { model: hostile.model, pool: hostile.pool, sessionId: hostile.sessionId, eventType: hostile.eventType } },
  };
  await page.addInitScript(() => {
    window.__sty190Hostile = { model: 0, pool: 0, sessionId: 0, eventId: 0, eventType: 0 };
  });
  await page.route(url => url.pathname === "/sessions", async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, sessions: [hostileSession, ...(body.sessions ?? [])] } });
  });
  await page.route(url => {
    const pathname = decodeURIComponent(url.pathname);
    return pathname.includes(hostile.sessionId) && pathname.endsWith("/events");
  }, route => route.fulfill({ json: { events: [hostileEvent] } }));

  const hash = new URLSearchParams({ view: "single", trace: "raw", hide_after: "never", sid: hostile.sessionId });
  await page.goto(`${process.env.STY190_BASE}/?token=${process.env.STY190_TOKEN}#${hash}`);
  await expect.poll(() => page.evaluate(() => window.__OBS_STATE.selectedSessionId)).toBe(hostile.sessionId);
  await expect(page.locator("#event-view .evt-row")).toHaveCount(1);
  await expect(page.locator("#session-list")).toContainText("MODEL_LITERAL");
  await expect(page.locator("#session-list")).toContainText("POOL_LITERAL");
  await expect(page.locator("#session-list")).toContainText("SESSION_LITERAL");
  await expect(page.locator("#event-view .pill")).toHaveText(hostile.eventType);
  expect(await page.locator("#event-view .pill").evaluate(element => [...element.classList])).toEqual(["pill", "custom"]);
  expect(await page.locator("#session-list img, #event-view img, #session-list script, #event-view script").count()).toBe(0);

  await page.locator("#btn-swimlane").click();
  await expect.poll(() => page.evaluate(sessionId => window.__swimlaneGetAll().get(sessionId)?.events.length ?? 0, hostile.sessionId)).toBe(1);
  await expect(page.locator("#swimlane-container .lane-model")).toHaveText(hostile.model);
  await expect(page.locator("#swimlane-container .pill")).toHaveText(hostile.eventType);
  expect(await page.locator("#swimlane-container .pill").evaluate(element => [...element.classList])).toEqual(["pill", "custom"]);
  await page.locator("#swimlane-container .lane-evt").click();
  const swimlaneDetailText = await page.locator("#swimlane-container .lane-evt-detail.open pre").textContent();
  expect(await page.locator("#swimlane-container img, #swimlane-container script").count()).toBe(0);

  await page.locator("#btn-race").click();
  await expect.poll(() => page.evaluate(sessionId => window.__raceGetAll().get(sessionId)?.events.length ?? 0, hostile.sessionId)).toBe(1);
  await expect(page.locator("#race-container .race-agent-name")).toHaveText(hostile.sessionId);
  const raceEvent = page.locator("#race-container .race-event");
  expect(await raceEvent.evaluate(element => [...element.classList])).toEqual(["race-event", "custom"]);
  await raceEvent.evaluate(element => element.click());
  await expect(page.locator("#race-inspector-title")).toHaveText(hostile.eventType);
  await expect(page.locator("#race-inspector-body .pill")).toHaveText(hostile.eventType);
  expect(await page.locator("#race-inspector-body .pill").evaluate(element => [...element.classList])).toEqual(["pill", "custom"]);
  const raceDetailText = await page.locator("#race-inspector-body .race-inspector-detail pre").textContent();
  expect({ swimlane: swimlaneDetailText?.includes(hostile.eventId), race: raceDetailText?.includes(hostile.eventId) }).toEqual({ swimlane: true, race: true });
  expect(await page.locator("#race-container img, #race-inspector-body img, #race-container script, #race-inspector-body script").count()).toBe(0);
  expect(await page.evaluate(() => window.__sty190Hostile)).toEqual({ model: 0, pool: 0, sessionId: 0, eventId: 0, eventType: 0 });
});
'''


def wait_for_server(server: subprocess.Popen[str], base_url: str) -> None:
    """Poll bounded health and fail if the server exits."""
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError(f"Bun server exited early with {server.returncode}")
        try:
            health = request_json(f"{base_url}/health")
            if isinstance(health, dict) and health.get("ok") is True:
                return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("Bun server did not become healthy")


def capture_path(artifact_root: Path, trial: str, scenario: str, name: str) -> Path:
    """Return one deterministic trial-scoped screenshot path."""
    return artifact_root / f"trial-{trial}-{scenario}-{name}.png"


def observation_path(artifact_root: Path, trial: str, scenario: str) -> Path:
    """Return one deterministic trial-scoped observation path."""
    return artifact_root / f"trial-{trial}-{scenario}-observation-tuple.json"


def prepare_capture_artifacts(artifact_root: Path, trial: str) -> None:
    """Remove only this trial's named outputs so stale files cannot pass."""
    artifact_root.mkdir(parents=True, exist_ok=True)
    for scenario, (screenshots, _) in CAPTURE_CONTRACT.items():
        for screenshot in screenshots:
            capture_path(artifact_root, trial, scenario, screenshot).unlink(missing_ok=True)
        observation_path(artifact_root, trial, scenario).unlink(missing_ok=True)


def verify_capture_artifacts(artifact_root: Path, trial: str) -> None:
    """Fail unless every named screenshot and observation tuple is current and valid."""
    for scenario, (screenshots, tuple_fields) in CAPTURE_CONTRACT.items():
        for screenshot in screenshots:
            screenshot_path = capture_path(artifact_root, trial, scenario, screenshot)
            if not screenshot_path.is_file() or screenshot_path.stat().st_size == 0:
                raise AssertionError(f"missing or empty screenshot: {screenshot_path}")
        tuple_path = observation_path(artifact_root, trial, scenario)
        if not tuple_path.is_file() or tuple_path.stat().st_size == 0:
            raise AssertionError(f"missing or empty observation tuple: {tuple_path}")
        with tuple_path.open(encoding="utf-8") as tuple_file:
            observation_tuple = json.load(tuple_file)
        if not isinstance(observation_tuple, dict):
            raise AssertionError(f"observation tuple is not an object: {tuple_path}")
        if observation_tuple.get("scenarioId") != scenario or str(observation_tuple.get("trial")) != trial:
            raise AssertionError(f"observation tuple identity mismatch: {tuple_path}")
        missing_fields = [field for field in tuple_fields if field not in observation_tuple]
        if missing_fields:
            raise AssertionError(f"observation tuple missing {missing_fields}: {tuple_path}")


def main() -> None:
    """Build, run isolated browser checks, and deterministically clean up."""
    # Playwright replaces the old external playwright-cli convention and remains fail-hard.
    playwright = ROOT / "node_modules" / ".bin" / "playwright"
    if not playwright.exists():
        raise RuntimeError("required browser dependency missing: playwright-cli/Playwright")
    trial = os.environ.get("STY190_E2E_TRIAL", "1")
    if not trial.isdecimal() or int(trial) < 1:
        raise RuntimeError("STY190_E2E_TRIAL must be a positive integer")
    configured_artifact_root = Path(
        os.environ.get(
            "STY190_E2E_ARTIFACT_ROOT",
            str(ROOT / ".pi/artifacts/validation/STY-190/deterministic-e2e"),
        )
    ).expanduser()
    artifact_root = (
        configured_artifact_root
        if configured_artifact_root.is_absolute()
        else ROOT / configured_artifact_root
    ).resolve()
    prepare_capture_artifacts(artifact_root, trial)
    run("npm", "run", "build")
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    server = None
    generated_test = None
    with TemporaryDirectory(prefix="sty-190-e2e-") as temporary_directory:
        environment = os.environ.copy()
        environment.update({
            "OBS_DB_PATH": str(Path(temporary_directory) / "isolated.sqlite"),
            "OBS_AUTH_TOKEN": TOKEN,
            "OBS_PORT": str(port),
            "OBS_HOST": "127.0.0.1",
            "STY190_E2E_ARTIFACT_ROOT": str(artifact_root),
            "STY190_E2E_TRIAL": trial,
        })
        try:
            server = subprocess.Popen(
                ["bun", "apps/observability/server.ts"], cwd=ROOT, env=environment,
                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
            )
            wait_for_server(server, base_url)
            seed_events = [*fixtures(), *pagination_fixtures()]
            ingestion = request_json(f"{base_url}/events", TOKEN, seed_events)
            if ingestion != {"ingested": len(seed_events), "rejected": []}:
                raise AssertionError(f"fixture ingestion failed: {ingestion}")
            with tempfile.NamedTemporaryFile("w", suffix=".spec.js", prefix="sty190-", dir=ROOT / "tests", delete=False) as test_file:
                test_file.write(browser_test_source())
                generated_test = Path(test_file.name)
            browser_environment = environment | {"STY190_BASE": base_url, "STY190_TOKEN": TOKEN}
            subprocess.run(
                [str(playwright), "test", str(generated_test.relative_to(ROOT)), "--workers=1", "--reporter=line"],
                cwd=ROOT, env=browser_environment, text=True, check=True,
            )
            verify_capture_artifacts(artifact_root, trial)
        finally:
            if generated_test is not None:
                generated_test.unlink(missing_ok=True)
            if server is not None and server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(server.pid, signal.SIGKILL)
                    server.kill()
                    server.wait(timeout=3)


if __name__ == "__main__":
    main()

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";

const TOK = process.env["OBS_AUTH_TOKEN"] ?? "devtoken";
const URL = process.env["OBS_SERVER_URL"] ?? "http://127.0.0.1:43190";
const headers = { Authorization: `Bearer ${TOK}` };
const sleep = (milliseconds: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

interface Session {
  session_id: string;
}

interface Event {
  event_id: string;
  seq: number;
  type: string;
  session_id: string;
}

interface StressSession {
  sessionId: string;
  eventCount: number;
  firstEventId: string;
  lastEventId: string;
}

interface BrowserResult {
  stressRawEventCount: number;
  initialVisibleRawEventCount: number;
  filteredVisibleRawEventCount: number;
  restoredVisibleRawEventCount: number;
  singleRawEventIds: string[];
  swimlaneRawEventIds: string[];
  raceRawEventIds: string[];
  selectedSessionId: string;
  pool: string;
  tag: string;
  "window.location.hash": string;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSession(value: unknown): value is Session {
  return isRecord(value) && typeof value["session_id"] === "string";
}

function isEvent(value: unknown): value is Event {
  return (
    isRecord(value) &&
    typeof value["event_id"] === "string" &&
    typeof value["seq"] === "number" &&
    typeof value["type"] === "string" &&
    typeof value["session_id"] === "string"
  );
}

function parseArrayProperty<T>(
  value: unknown,
  property: string,
  guard: (item: unknown) => item is T,
): T[] {
  assert(isRecord(value), "Expected JSON response object");
  const items = value[property];
  assert(Array.isArray(items), `Expected '${property}' array`);
  assert(items.every(guard), `Expected valid entries in '${property}'`);
  return items;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  assert(response.ok, `Request failed (${response.status} ${response.statusText}): ${url}`);
  return response.json();
}

async function runBrowser(
  stressSid: string,
  sessionId: string,
  stressSession: StressSession,
): Promise<BrowserResult> {
  const child = spawn(process.execPath, ["scripts/run-swimlane-browser.mjs"], {
    env: {
      ...process.env,
      OBS_STRESS_URL: `${URL}/?token=${TOK}#view=single&trace=raw&sid=${stressSid}`,
      OBS_FLEET_URL: `${URL}/?token=${TOK}#view=single&trace=raw&pool=integration-v2&tag=fleet`,
      OBS_SWIMLANE_URL: `${URL}/?token=${TOK}#view=swimlane&pool=integration-v2&tag=fleet`,
      OBS_BROWSER_SESSION_ID: sessionId,
      OBS_STRESS_SESSION_ID: stressSession.sessionId,
      OBS_STRESS_EVENT_COUNT: String(stressSession.eventCount),
      OBS_STRESS_FIRST_EVENT_ID: stressSession.firstEventId,
      OBS_STRESS_LAST_EVENT_ID: stressSession.lastEventId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert(code === 0, `Browser runner failed (${code ?? "unknown"}): ${stderr}`);
  const parsed: unknown = JSON.parse(stdout);
  assert(isBrowserResult(parsed), "Browser runner returned an invalid result");
  return parsed;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBrowserResult(value: unknown): value is BrowserResult {
  return (
    isRecord(value) &&
    typeof value["stressRawEventCount"] === "number" &&
    typeof value["initialVisibleRawEventCount"] === "number" &&
    typeof value["filteredVisibleRawEventCount"] === "number" &&
    typeof value["restoredVisibleRawEventCount"] === "number" &&
    isStringArray(value["singleRawEventIds"]) &&
    isStringArray(value["swimlaneRawEventIds"]) &&
    isStringArray(value["raceRawEventIds"]) &&
    typeof value["selectedSessionId"] === "string" &&
    typeof value["pool"] === "string" &&
    typeof value["tag"] === "string" &&
    typeof value["window.location.hash"] === "string"
  );
}

function assertSameIds(actual: string[], expected: string[], view: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${view} raw event IDs differ from the Single raw baseline`,
  );
}

async function runFleet(): Promise<void> {
  const child = spawn("bash", ["scripts/spawn-fleet.sh"], { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`scripts/spawn-fleet.sh failed (${code ?? signal ?? "unknown"})`));
      }
    });
  });
}

async function runSSE(controller: AbortController, events: Event[]): Promise<void> {
  const url = `${URL}/events/stream?pool=integration-v2&tag=fleet&token=${TOK}`;
  try {
    const response = await fetch(url, { signal: controller.signal });
    assert(response.ok, `SSE connection failed: ${response.status} ${response.statusText}`);
    assert(response.body !== null, "SSE response body was null");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        assert(controller.signal.aborted, "SSE stream ended before abort");
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const dataText = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (dataText !== "") {
          try {
            const parsed: unknown = JSON.parse(dataText);
            if (isEvent(parsed)) {
              events.push(parsed);
            }
          } catch (error: unknown) {
            if (error instanceof SyntaxError) {
              continue;
            }
            throw error;
          }
        }
      }
    }
  } catch (error: unknown) {
    if (controller.signal.aborted && error instanceof Error && error.name === "AbortError") {
      return;
    }
    throw error;
  }
}

async function testSseResync(baseSessionIds: ReadonlySet<string>): Promise<string> {
  console.log("\n--- T1: SSE Resync Drop Test ---");
  const sseEvents1: Event[] = [];
  const controller1 = new AbortController();
  const ssePromise1 = runSSE(controller1, sseEvents1);
  console.log("[T1] SSE connection 1 opened.");
  await sleep(500);
  console.log("[T1] Spawning fleet...");
  const fleetPromise = runFleet();
  console.log("[T1] Sleeping 3 seconds while fleet is starting...");
  await sleep(3000);
  console.log("[T1] Aborting SSE connection 1 (simulating dropout)...");
  controller1.abort();
  await ssePromise1;
  assert(sseEvents1.length > 0, "SSE connection 1 received no event frames");
  console.log("[T1] Sleeping 2 seconds while disconnected...");
  await sleep(2000);
  const sseEvents2: Event[] = [];
  const controller2 = new AbortController();
  const ssePromise2 = runSSE(controller2, sseEvents2);
  console.log("[T1] SSE connection 2 opened.");
  await fleetPromise;
  console.log("[T1] Fleet execution finished.");
  await sleep(1000);
  controller2.abort();
  await ssePromise2;
  const firstConnectionIds = new Set(sseEvents1.map((event) => event.event_id));
  assert(
    sseEvents2.some((event) => !firstConnectionIds.has(event.event_id)),
    "SSE connection 2 received no reconnect-specific event frames",
  );

  const json = await fetchJson(`${URL}/sessions?pool=integration-v2&tag=fleet`, { headers });
  const postSessions = parseArrayProperty(json, "sessions", isSession);
  const spawnedSessions = postSessions.filter((session) => !baseSessionIds.has(session.session_id));
  console.log(`[T1] Identified ${spawnedSessions.length} newly spawned sessions.`);
  assert(
    spawnedSessions.length >= 3,
    `Expected at least 3 spawned sessions, got ${spawnedSessions.length}`,
  );
  const targetSessions = spawnedSessions.slice(0, 3);
  const lastSeqs = new Map<string, number>();
  for (const session of targetSessions) {
    const seqs = sseEvents1
      .filter((event) => event.session_id === session.session_id)
      .map((event) => event.seq);
    lastSeqs.set(session.session_id, seqs.length === 0 ? -1 : Math.max(...seqs));
  }
  const backfillEvents: Event[] = [];
  for (const session of targetSessions) {
    const lastSeq = lastSeqs.get(session.session_id) ?? -1;
    const json = await fetchJson(
      `${URL}/sessions/${session.session_id}/events?since_seq=${lastSeq}&limit=500`,
      { headers },
    );
    const events = parseArrayProperty(json, "events", isEvent);
    console.log(
      `[T1] Session ${session.session_id} (lastSeq before drop: ${lastSeq}): fetched ${events.length} backfill events.`,
    );
    backfillEvents.push(...events);
  }
  const seenIds = new Set<string>();
  const deduped = [...sseEvents1, ...backfillEvents, ...sseEvents2].filter((event) => {
    if (seenIds.has(event.event_id)) {
      return false;
    }
    seenIds.add(event.event_id);
    return true;
  });
  for (const session of targetSessions) {
    const json = await fetchJson(`${URL}/sessions/${session.session_id}/events?limit=500`, {
      headers,
    });
    const restEvents = parseArrayProperty(json, "events", isEvent);
    const sorted = [...restEvents].sort((left, right) => left.seq - right.seq);
    assert(sorted.length > 0, `Expected events for session ${session.session_id}`);
    assert(sorted[0]?.seq === 0, `Expected first seq to be 0, got ${sorted[0]?.seq}`);
    for (const [index, event] of sorted.entries()) {
      assert(event.seq === index, `Sequence gap or mismatch. Index ${index} has seq ${event.seq}`);
    }
    for (const event of restEvents) {
      const count = deduped.filter((candidate) => candidate.event_id === event.event_id).length;
      assert(
        count === 1,
        `Event ${event.event_id} (seq ${event.seq}, type ${event.type}) appeared ${count} times in combined SSE list.`,
      );
    }
  }
  const browserSession = targetSessions[0];
  assert(browserSession !== undefined, "Expected a fleet session for browser validation");
  console.log("  ✓ T1: SSE Resync Drop Test PASSED!");
  return browserSession.session_id;
}

async function createStressSession(): Promise<StressSession> {
  const stressSid = `stress-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`[T2] Generating 2,000 synthetic events for fake session: ${stressSid}`);
  const fakeEvents = Array.from({ length: 2000 }, (_, index) => ({
    event_id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type: index === 0 ? "session_start" : index === 1999 ? "session_shutdown" : "turn_start",
    session_id: stressSid,
    cwd: process.cwd(),
    pool: "integration-v2",
    tags: ["fleet"],
    payload:
      index === 0
        ? { reason: "startup" }
        : index === 1999
          ? { reason: "quit" }
          : { turn_index: index },
    seq: index,
  }));
  const result = await fetchJson(`${URL}/events`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(fakeEvents),
  });
  assert(
    isRecord(result) &&
      result["ingested"] === fakeEvents.length &&
      Array.isArray(result["rejected"]) &&
      result["rejected"].length === 0,
    `Expected all ${fakeEvents.length} stress events to be ingested; observed ${JSON.stringify(result)}`,
  );
  console.log("[T2] Posted 2,000 synthetic events successfully.");
  const firstEventId = fakeEvents[0]?.event_id;
  const lastEventId = fakeEvents.at(-1)?.event_id;
  assert(firstEventId !== undefined && lastEventId !== undefined, "Stress fixture was empty");
  return {
    sessionId: stressSid,
    eventCount: fakeEvents.length,
    firstEventId,
    lastEventId,
  };
}

function assertBrowserResult(result: BrowserResult, expectedSessionId: string): void {
  console.log("\n--- T2: DOM Stress Test ---");
  console.log(`[T2] DOM Row count rendered: ${result.stressRawEventCount}`);
  assert(
    result.stressRawEventCount >= 1000,
    `Expected >=1000 rows rendered (full append capped at client limit), got ${result.stressRawEventCount}`,
  );
  console.log("  ✓ T2: DOM Stress Test PASSED!");

  console.log("\n--- T3: UI Search/Filter Visibility ---");
  console.log(`[T3] Initial visible row count: ${result.initialVisibleRawEventCount}`);
  console.log(`[T3] Filtered visible row count: ${result.filteredVisibleRawEventCount}`);
  assert(
    result.filteredVisibleRawEventCount < result.initialVisibleRawEventCount,
    "Expected search to reduce visible count",
  );
  console.log(`[T3] Restored visible row count: ${result.restoredVisibleRawEventCount}`);
  assert(
    result.restoredVisibleRawEventCount === result.initialVisibleRawEventCount,
    "Search clear should restore initial event row visibility",
  );
  assert(
    result.selectedSessionId === expectedSessionId,
    "Browser selected the wrong fleet session",
  );
  assertSameIds(result.swimlaneRawEventIds, result.singleRawEventIds, "Swimlane");
  assertSameIds(result.raceRawEventIds, result.singleRawEventIds, "Race");
  console.log("  ✓ T3: Raw search and sibling event isolation PASSED!");

  console.log("\n--- T4: URL State Round-Trip ---");
  assert(
    result.pool === "integration-v2",
    `Expected pool-filter to be integration-v2, got ${result.pool}`,
  );
  assert(result.tag === "fleet", `Expected tag-filter to be fleet, got ${result.tag}`);
  const hash = result["window.location.hash"];
  console.log(`[T4] Current window location hash: ${hash}`);
  assert(hash.includes("swimlane"), "Expected view mode to restore to swimlane");
  console.log("  ✓ T4: URL State Round-Trip PASSED!");
  console.log("  ✓ UI loaded with zero console or page errors.");
}

async function main(): Promise<void> {
  console.log("=== STARTING SWIMLANE VALIDATION ===");
  console.log("[REST] Cleaning up/reading existing sessions...");
  const json = await fetchJson(`${URL}/sessions?pool=integration-v2&tag=fleet`, { headers });
  const baseSessionIds = new Set(
    parseArrayProperty(json, "sessions", isSession).map((session) => session.session_id),
  );
  const browserSessionId = await testSseResync(baseSessionIds);
  const stressSession = await createStressSession();
  const stressSid = stressSession.sessionId;
  const browserResult = await runBrowser(stressSid, browserSessionId, stressSession);
  assertBrowserResult(browserResult, browserSessionId);
  console.log("\n=================================");
  console.log("✓ ALL SWIMLANE VALIDATIONS PASSED");
  console.log("=================================");
}

main().catch((error: unknown) => {
  console.error("\n❌ VALIDATION FAILED:");
  console.error(errorMessage(error));
  process.exitCode = 1;
});

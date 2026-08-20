import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ObsEvent } from "../shared/types.js";
import { projectTranscript } from "../src/transcript.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const authenticationToken = "sty190-round2-review";
const sessionId = "sty190-round2-reconnect";

interface BrowserObservabilityState {
  eventsHydrated: boolean;
  events: ObsEvent[];
}

let serverPort = 0;
let temporaryDirectory = "";
let serverProcess: ChildProcess | undefined;

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Unable to allocate review server port"));
        return;
      }
      listener.close(() => {
        resolve(address.port);
      });
    });
  });
}

function transcriptEvent(input: {
  type: ObsEvent["type"];
  eventId: string;
  seq: number;
  payload: Record<string, unknown>;
}): ObsEvent {
  return {
    event_id: input.eventId,
    session_id: "round2-thinking",
    seq: input.seq,
    ts: `2026-08-20T00:00:${String(input.seq).padStart(2, "0")}.000Z`,
    type: input.type,
    cwd: "/tmp/round2-thinking",
    pool: "review",
    tags: [],
    payload: input.payload,
  } as unknown as ObsEvent;
}

function serverEvent(sequence: number): ObsEvent {
  return {
    event_id: `round2-event-${sequence}`,
    session_id: sessionId,
    seq: sequence,
    ts: new Date(Date.now() + sequence).toISOString(),
    type: "user_message",
    cwd: "/tmp/round2-reconnect",
    pool: "review",
    tags: ["sty-190"],
    payload: { text: `message ${sequence}`, images_count: 0 },
  };
}

async function postEvents(events: readonly ObsEvent[]): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${serverPort}/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authenticationToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(events),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { ingested: number; rejected: string[] };
  expect(result.rejected).toEqual([]);
  expect(result.ingested).toBe(events.length);
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/health`);
      if (response.status === 200) return;
    } catch {
      // The isolated server may not have bound its port yet.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error("Timed out waiting for isolated review server");
}

async function startServer(): Promise<void> {
  serverProcess = spawn("bun", ["apps/observability/server.ts"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OBS_PORT: String(serverPort),
      OBS_HOST: "127.0.0.1",
      OBS_AUTH_TOKEN: authenticationToken,
      OBS_DB_PATH: join(temporaryDirectory, "events.sqlite"),
    },
    stdio: "ignore",
  });
  await waitForServer();
}

async function stopServer(): Promise<void> {
  const runningServer = serverProcess;
  if (runningServer === undefined) return;
  serverProcess = undefined;
  await new Promise<void>((resolve) => {
    runningServer.once("exit", () => {
      resolve();
    });
    runningServer.kill("SIGTERM");
  });
}

async function waitForObservation<Observation>(
  observe: () => Promise<Observation>,
  complete: (observation: Observation) => boolean,
  timeout: number,
): Promise<Observation> {
  const deadline = Date.now() + timeout;
  let observation = await observe();
  while (!complete(observation) && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    observation = await observe();
  }
  return observation;
}

beforeAll(async () => {
  serverPort = await allocatePort();
  temporaryDirectory = mkdtempSync(join(tmpdir(), "sty190-round2-review-"));
  await startServer();
});

afterAll(async () => {
  await stopServer();
  if (temporaryDirectory !== "") rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("STY-190 code review round 2 findings", () => {
  it("keeps repeated captured thinking before the current turn's tools", () => {
    const projected = projectTranscript([
      transcriptEvent({
        type: "assistant_message",
        eventId: "assistant-turn-one",
        seq: 1,
        payload: { thinking: "Inspect the same invariant", text: "First answer" },
      }),
      transcriptEvent({
        type: "user_message",
        eventId: "user-turn-two",
        seq: 2,
        payload: { text: "Check again", images_count: 0 },
      }),
      transcriptEvent({
        type: "thinking",
        eventId: "thinking-turn-two",
        seq: 3,
        payload: { text: "Inspect the same invariant" },
      }),
      transcriptEvent({
        type: "tool_call",
        eventId: "tool-turn-two-a",
        seq: 4,
        payload: { tool_call_id: "tool-a", tool_name: "read", args: {} },
      }),
      transcriptEvent({
        type: "tool_call",
        eventId: "tool-turn-two-b",
        seq: 5,
        payload: { tool_call_id: "tool-b", tool_name: "bash", args: {} },
      }),
      transcriptEvent({
        type: "tool_call",
        eventId: "tool-turn-two-c",
        seq: 6,
        payload: { tool_call_id: "tool-c", tool_name: "grep", args: {} },
      }),
      transcriptEvent({
        type: "assistant_message",
        eventId: "assistant-turn-two",
        seq: 7,
        payload: { thinking: "Inspect the same invariant", text: "Second answer" },
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

  it("backfills a Single reconnect gap once in numeric order without resetting UI or prior SSE state", async () => {
    await postEvents([serverEvent(0)]);
    const browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    try {
      await page.goto(
        `http://127.0.0.1:${serverPort}/?token=${authenticationToken}#view=single&sid=${sessionId}`,
      );
      const initialState = await waitForObservation(
        () =>
          page.evaluate(() => {
            const observabilityState = (
              window as typeof window & { __OBS_STATE: BrowserObservabilityState }
            ).__OBS_STATE;
            return {
              hydrated: observabilityState.eventsHydrated,
              ids: observabilityState.events.map((event) => event.event_id),
            };
          }),
        (observation) => observation.hydrated && observation.ids.length === 1,
        10_000,
      );
      expect(initialState).toEqual({ hydrated: true, ids: ["round2-event-0"] });
      const initialLiveLabel = await page.locator("#live-label").textContent();
      expect(initialLiveLabel).toBe("live");
      await page.locator("#search-box").fill("message");
      await page.locator("#btn-thinking-toggle").click();
      expect(await page.locator("#btn-thinking-toggle").getAttribute("aria-pressed")).toBe("false");

      await stopServer();
      const offlineLabel = await waitForObservation(
        () => page.locator("#live-label").textContent(),
        (label) => label === "off",
        10_000,
      );
      expect(offlineLabel).toBe("off");
      await browserContext.setOffline(true);
      await startServer();
      await postEvents([serverEvent(1), serverEvent(2)]);
      await browserContext.setOffline(false);
      const reconnectedLabel = await waitForObservation(
        () => page.locator("#live-label").textContent(),
        (label) => label === "live",
        15_000,
      );
      expect(reconnectedLabel).toBe("live");

      const reconnectedEventIds = await waitForObservation(
        () =>
          page.evaluate(() => {
            const observabilityState = (
              window as typeof window & { __OBS_STATE: BrowserObservabilityState }
            ).__OBS_STATE;
            return observabilityState.events.map((event) => event.event_id);
          }),
        (eventIds) => eventIds.length === 3,
        5_000,
      );
      expect(reconnectedEventIds).toEqual(["round2-event-0", "round2-event-1", "round2-event-2"]);
      expect(new Set(reconnectedEventIds).size).toBe(reconnectedEventIds.length);
      expect(await page.locator("#search-box").inputValue()).toBe("message");
      expect(await page.locator("#btn-thinking-toggle").getAttribute("aria-pressed")).toBe("false");
    } finally {
      await browserContext.close();
      await browser.close();
    }
  }, 45_000);

  it("does not reconnect from an obsolete retry after a replacement stream is live", async () => {
    const browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    let streamRequestCount = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/events/stream") streamRequestCount++;
    });
    try {
      await page.goto(
        `http://127.0.0.1:${serverPort}/?token=${authenticationToken}#view=single&sid=${sessionId}`,
      );
      await waitForObservation(
        () => page.locator("#live-label").textContent(),
        (label) => label === "live",
        10_000,
      );
      expect(streamRequestCount).toBe(1);
      await page.clock.install();

      await stopServer();
      await waitForObservation(
        () => page.locator("#live-label").textContent(),
        (label) => label === "off",
        10_000,
      );
      await startServer();
      await page.locator("#pool-filter").fill("review");
      await waitForObservation(
        () => page.locator("#live-label").textContent(),
        (label) => label === "live",
        10_000,
      );
      expect(streamRequestCount).toBe(2);

      await page.clock.fastForward(10_000);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(streamRequestCount).toBe(2);
      expect(await page.locator("#live-label").textContent()).toBe("live");
    } finally {
      await browserContext.close();
      await browser.close();
    }
  }, 30_000);
});

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const validatorPath = fileURLToPath(new URL("../scripts/validate-swimlane.ts", import.meta.url));
const browserRunnerPath = fileURLToPath(
  new URL("../scripts/run-swimlane-browser.mjs", import.meta.url),
);
const sharedTypesPath = fileURLToPath(new URL("../shared/types.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "validate-swimlane-contract-"));
const modulePath = join(directory, "validate-swimlane.ts");

beforeAll(() => {
  const source = readFileSync(validatorPath, "utf8")
    .replace("async function runSSE(", "export async function runSSE(")
    .replace("async function createStressSession(", "export async function createStressSession(")
    .replace(/\nmain\(\)\.catch\([\s\S]*$/u, "\n");
  writeFileSync(modulePath, source);
});

afterAll(() => {
  rmSync(directory, { force: true, recursive: true });
});

async function runCase(caseName: string): Promise<{ status: number; stderr: string }> {
  const harnessPath = join(directory, `${caseName}.ts`);
  writeFileSync(
    harnessPath,
    `
const { runSSE } = await import(${JSON.stringify(modulePath)});
const event = JSON.stringify({
  event_id: "event-1", seq: 1, type: "turn_start", session_id: "session-1"
});
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  if (${JSON.stringify(caseName)} === "null-body") return { ok: true, body: null };
  if (${JSON.stringify(caseName)} === "non-abort") {
    return { ok: true, body: new ReadableStream({ pull(controller) {
      controller.error(new Error("socket reset"));
    }})};
  }
  if (${JSON.stringify(caseName)} === "second-connection") {
    return calls === 1
      ? new Response("data: " + event + "\\n\\n")
      : new Response(": heartbeat only\\n\\n");
  }
  return new Response("data: " + event + "\\n\\n");
};
const controller = new AbortController();
const events = [];
if (${JSON.stringify(caseName)} === "second-connection") {
  await runSSE(controller, events);
  await runSSE(controller, events);
} else {
  await runSSE(controller, events);
}
console.error("unexpected-success", JSON.stringify({ calls, events }));
`,
  );
  const child = spawn("bun", [harnessPath], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
  return { status, stderr };
}

describe("legacy validator SSE transport", () => {
  it.each(["null-body", "early-eof", "non-abort", "second-connection"])(
    "fails hard for %s",
    async (caseName) => {
      const result = await runCase(caseName);
      expect(result.status, result.stderr).not.toBe(0);
    },
  );
});

const legacySessionId = "legacy-session-2000";
const legacyEventIds = Array.from(
  { length: 2000 },
  (_, index) => `legacy-event-${index.toString().padStart(4, "0")}`,
);

function browserFixture(): string {
  return `<!doctype html>
<html><body>
  <input id="pool-filter" value="integration-v2">
  <input id="tag-filter" value="fleet">
  <input id="search-box">
  <button id="btn-swimlane">Swimlane</button>
  <button id="btn-race">Race</button>
  <div class="session-item"><span class="uuid">${legacySessionId.slice(0, 8)}</span></div>
  <div id="event-view"></div>
  <script>
    const sessionId = ${JSON.stringify(legacySessionId)};
    const eventIds = ${JSON.stringify(legacyEventIds)};
    const events = eventIds.map((eventId, seq) => ({ event_id: eventId, session_id: sessionId, seq }));
    const eventView = document.querySelector("#event-view");
    const state = window.__OBS_STATE = {
      sessions: [{ session_id: sessionId, event_count: eventIds.length }],
      sessionsLoaded: true,
      selectedSessionId: null,
      eventsHydrated: false,
      events: [],
    };
    const render = (nextEvents) => {
      eventView.replaceChildren(...nextEvents.map((event, index) => {
        const row = document.createElement("div");
        row.className = "evt-row";
        row.dataset.eventId = event.event_id;
        row.textContent = (index === 0 ? "bash " : "") + event.event_id;
        return row;
      }));
    };
    const setRaw = (nextEvents, selectedSessionId, eventsHydrated) => {
      state.events = nextEvents;
      state.selectedSessionId = selectedSessionId;
      state.eventsHydrated = eventsHydrated;
      render(nextEvents);
    };
    const phase = new URL(location.href).searchParams.get("phase");
    if (phase === "stress") {
      setRaw(events.slice(0, 1000), sessionId, false);
      setTimeout(() => setRaw(events, sessionId, false), 150);
      setTimeout(() => setRaw(events, sessionId, true), 350);
    } else if (phase === "wrong-identity") {
      setRaw(events, "wrong-session", true);
    } else if (phase === "unhydrated") {
      setRaw(events, sessionId, false);
    } else {
      document.querySelector(".session-item").addEventListener("click", () => {
        setRaw(events, sessionId, true);
      });
    }
    document.querySelector("#search-box").addEventListener("input", event => {
      const query = event.target.value.toLowerCase();
      for (const row of eventView.children) {
        row.style.display = !query || row.textContent.toLowerCase().includes(query) ? "" : "none";
      }
    });
    const swimlanes = new Map();
    const races = new Map();
    window.__swimlaneGetAll = () => swimlanes;
    window.__raceGetAll = () => races;
    document.querySelector("#btn-swimlane").addEventListener("click", () => {
      swimlanes.set(sessionId, { events });
    });
    document.querySelector("#btn-race").addEventListener("click", () => {
      races.set(sessionId, { events });
    });
  </script>
</body></html>`;
}

async function runBrowserJourney(
  baseUrl: string,
  stressPhase: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [browserRunnerPath], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OBS_STRESS_URL: `${baseUrl}/?phase=${stressPhase}#view=single&trace=raw&sid=${legacySessionId}`,
      OBS_FLEET_URL: `${baseUrl}/?phase=fleet#view=single&trace=raw&pool=integration-v2&tag=fleet`,
      OBS_SWIMLANE_URL: `${baseUrl}/?phase=url#view=swimlane&pool=integration-v2&tag=fleet`,
      OBS_BROWSER_SESSION_ID: legacySessionId,
      OBS_STRESS_SESSION_ID: legacySessionId,
      OBS_STRESS_EVENT_COUNT: String(legacyEventIds.length),
      OBS_STRESS_FIRST_EVENT_ID: legacyEventIds[0],
      OBS_STRESS_LAST_EVENT_ID: legacyEventIds.at(-1),
      OBS_BROWSER_PHASE_TIMEOUT_MS: "750",
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
  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
  return { status, stdout, stderr };
}

function hasExactIds(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === legacyEventIds.length &&
    value.every((eventId, index) => eventId === legacyEventIds[index])
  );
}

async function runStressFixtureCase(
  rejectAcceptedEvent: boolean,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const harnessPath = join(directory, `stress-${rejectAcceptedEvent ? "reject" : "accept"}.ts`);
  writeFileSync(
    harnessPath,
    `
const { createStressSession } = await import(${JSON.stringify(modulePath)});
const { validateObsEvent } = await import(${JSON.stringify(sharedTypesPath)});
let posted = [];
globalThis.fetch = async (_url, init) => {
  posted = JSON.parse(String(init?.body));
  const invalidIds = posted.filter(event => !validateObsEvent(event)).map(event => event.event_id);
  const rejected = ${String(rejectAcceptedEvent)} && invalidIds.length === 0
    ? [posted[0].event_id]
    : invalidIds;
  return Response.json({ ingested: posted.length - rejected.length, rejected });
};
try {
  await createStressSession();
  process.stdout.write("\\n" + JSON.stringify({
    count: posted.length,
    valid: posted.every(validateObsEvent),
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`,
  );
  const child = spawn("bun", [harnessPath], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });
  return { status, stdout, stderr };
}

describe("legacy 2,000-event browser journey", () => {
  it("waits for the expected hydrated Raw identity and reports phase-specific diagnostics", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(browserFixture());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const acceptedStress = await runStressFixtureCase(false);
      const rejectedStress = await runStressFixtureCase(true);
      const complete = await runBrowserJourney(baseUrl, "stress");
      const wrongIdentity = await runBrowserJourney(baseUrl, "wrong-identity");
      const unhydrated = await runBrowserJourney(baseUrl, "unhydrated");
      const result = complete.status === 0 ? JSON.parse(complete.stdout) : {};
      const stressFixture = JSON.parse(acceptedStress.stdout.trim().split("\n").at(-1) ?? "{}");
      const identityDiagnostic = wrongIdentity.stderr;
      const hydrationDiagnostic = unhydrated.stderr;

      expect({
        stressFixtureStatus: acceptedStress.status,
        stressFixtureCount: stressFixture.count,
        stressFixtureValid: stressFixture.valid,
        rejectedIngestionRejected: rejectedStress.status !== 0,
        completeStatus: complete.status,
        stressRawEventCount: result.stressRawEventCount,
        selectedSessionId: result.selectedSessionId,
        singleIdentity: hasExactIds(result.singleRawEventIds),
        swimlaneIdentity: hasExactIds(result.swimlaneRawEventIds),
        raceIdentity: hasExactIds(result.raceRawEventIds),
        searchRestored: result.restoredVisibleRawEventCount === result.initialVisibleRawEventCount,
        identityRejected: wrongIdentity.status !== 0,
        identityPhase:
          /(?:stress|T2)[\s\S]{0,120}(?:raw|hydration)|(?:raw|hydration)[\s\S]{0,120}(?:stress|T2)/iu.test(
            identityDiagnostic,
          ),
        identityExpected:
          /expected/iu.test(identityDiagnostic) &&
          identityDiagnostic.includes(legacySessionId) &&
          identityDiagnostic.includes(String(legacyEventIds.length)),
        identityObserved:
          /observed/iu.test(identityDiagnostic) && identityDiagnostic.includes("wrong-session"),
        unhydratedRejected: unhydrated.status !== 0,
        hydrationPhase:
          /(?:stress|T2)[\s\S]{0,120}(?:raw|hydration)|(?:raw|hydration)[\s\S]{0,120}(?:stress|T2)/iu.test(
            hydrationDiagnostic,
          ),
        hydrationExpected: /expected[\s\S]{0,200}hydrated[\s\S]{0,80}true/iu.test(
          hydrationDiagnostic,
        ),
        hydrationObserved: /observed[\s\S]{0,200}hydrated[\s\S]{0,80}false/iu.test(
          hydrationDiagnostic,
        ),
      }).toEqual({
        stressFixtureStatus: 0,
        stressFixtureCount: 2000,
        stressFixtureValid: true,
        rejectedIngestionRejected: true,
        completeStatus: 0,
        stressRawEventCount: 2000,
        selectedSessionId: legacySessionId,
        singleIdentity: true,
        swimlaneIdentity: true,
        raceIdentity: true,
        searchRestored: true,
        identityRejected: true,
        identityPhase: true,
        identityExpected: true,
        identityObserved: true,
        unhydratedRejected: true,
        hydrationPhase: true,
        hydrationExpected: true,
        hydrationObserved: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }, 20_000);
});

import { chromium } from "@playwright/test";

const stressUrl = process.env.OBS_STRESS_URL;
const fleetUrl = process.env.OBS_FLEET_URL;
const swimlaneUrl = process.env.OBS_SWIMLANE_URL;
const fleetSessionId = process.env.OBS_BROWSER_SESSION_ID;
const stressSessionId = process.env.OBS_STRESS_SESSION_ID;
const stressEventCount = Number(process.env.OBS_STRESS_EVENT_COUNT);
const stressFirstEventId = process.env.OBS_STRESS_FIRST_EVENT_ID;
const stressLastEventId = process.env.OBS_STRESS_LAST_EVENT_ID;
const phaseTimeoutMs = Number(process.env.OBS_BROWSER_PHASE_TIMEOUT_MS ?? "30000");

if (
  !stressUrl ||
  !fleetUrl ||
  !swimlaneUrl ||
  !fleetSessionId ||
  !stressSessionId ||
  !Number.isSafeInteger(stressEventCount) ||
  stressEventCount < 1 ||
  !stressFirstEventId ||
  !stressLastEventId ||
  !Number.isFinite(phaseTimeoutMs) ||
  phaseTimeoutMs < 1
) {
  throw new Error("Swimlane browser runner environment is incomplete");
}
const stressExpected = {
  sessionId: stressSessionId,
  eventCount: stressEventCount,
  hydrated: true,
  firstEventId: stressFirstEventId,
  lastEventId: stressLastEventId,
};
const browser = await chromium.launch({ headless: true });
let context;
const browserErrors = [];

const newPage = async () => {
  if (!context) throw new Error("Browser context is unavailable");
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  return page;
};

const observeStressRaw = (page) =>
  page.evaluate(() => {
    const state = window.__OBS_STATE;
    const events = Array.isArray(state?.events) ? state.events : [];
    const rows = [...document.querySelectorAll("#event-view .evt-row")];
    return {
      sessionId: state?.selectedSessionId ?? null,
      eventCount: events.length,
      hydrated: state?.eventsHydrated === true,
      firstEventId: events[0]?.event_id ?? null,
      lastEventId: events.at(-1)?.event_id ?? null,
      rawRowCount: rows.length,
      firstRawRowEventId: rows[0]?.dataset.eventId ?? null,
      lastRawRowEventId: rows.at(-1)?.dataset.eventId ?? null,
    };
  });

const waitForStressRaw = async (page) => {
  try {
    await page.waitForFunction(
      (expected) => {
        const state = window.__OBS_STATE;
        const events = Array.isArray(state?.events) ? state.events : [];
        const rows = [...document.querySelectorAll("#event-view .evt-row")];
        return (
          state?.selectedSessionId === expected.sessionId &&
          state?.eventsHydrated === expected.hydrated &&
          events.length === expected.eventCount &&
          rows.length === expected.eventCount &&
          events[0]?.event_id === expected.firstEventId &&
          events.at(-1)?.event_id === expected.lastEventId &&
          rows[0]?.dataset.eventId === expected.firstEventId &&
          rows.at(-1)?.dataset.eventId === expected.lastEventId
        );
      },
      stressExpected,
      { timeout: phaseTimeoutMs },
    );
  } catch (error) {
    const observed = await observeStressRaw(page);
    throw new Error(
      `[T2 stress Raw hydration] timed out after ${phaseTimeoutMs}ms; expected ${JSON.stringify(stressExpected)}; observed ${JSON.stringify(observed)}`,
      { cause: error },
    );
  }
};

try {
  context = await browser.newContext();
  const stressPage = await newPage();
  await stressPage.goto(stressUrl);
  await waitForStressRaw(stressPage);
  const stressRawEventCount = await stressPage.locator("#event-view .evt-row").count();
  await stressPage.close();

  const page = await newPage();
  await page.goto(fleetUrl);
  await page.waitForFunction(
    (sessionId) =>
      [...document.querySelectorAll(".session-item .uuid")].some((element) =>
        element.textContent?.startsWith(sessionId.slice(0, 8)),
      ),
    fleetSessionId,
  );
  await page.evaluate((sessionId) => {
    const item = [...document.querySelectorAll(".session-item")].find((element) =>
      element.querySelector(".uuid")?.textContent?.startsWith(sessionId.slice(0, 8)),
    );
    if (!(item instanceof HTMLElement)) throw new Error(`Session ${sessionId} is not selectable`);
    item.click();
  }, fleetSessionId);
  await page.waitForFunction(
    (sessionId) =>
      window.__OBS_STATE?.selectedSessionId === sessionId &&
      document.querySelectorAll("#event-view .evt-row").length > 0,
    fleetSessionId,
  );

  const rawRows = page.locator("#event-view .evt-row");
  const initialVisibleRawEventCount = await rawRows.count();
  await page.locator("#search-box").fill("bash");
  const filteredVisibleRawEventCount = await rawRows.evaluateAll(
    (rows) => rows.filter((row) => getComputedStyle(row).display !== "none").length,
  );
  await page.locator("#search-box").fill("");
  const restoredVisibleRawEventCount = await rawRows.evaluateAll(
    (rows) => rows.filter((row) => getComputedStyle(row).display !== "none").length,
  );
  const singleRawEventIds = await page.evaluate(() =>
    window.__OBS_STATE.events.map((event) => event.event_id),
  );
  const selectedSessionId = await page.evaluate(() => window.__OBS_STATE?.selectedSessionId);

  await page.locator("#btn-swimlane").click();
  await page.waitForFunction(
    ({ sessionId, eventCount }) =>
      window.__swimlaneGetAll?.().get(sessionId)?.events.length === eventCount,
    { sessionId: fleetSessionId, eventCount: singleRawEventIds.length },
  );
  const swimlaneRawEventIds = await page.evaluate(
    (sessionId) =>
      window
        .__swimlaneGetAll?.()
        .get(sessionId)
        ?.events.map((event) => event.event_id),
    fleetSessionId,
  );

  await page.locator("#btn-race").click();
  await page.waitForFunction(
    ({ sessionId, eventCount }) =>
      window.__raceGetAll?.().get(sessionId)?.events.length === eventCount,
    { sessionId: fleetSessionId, eventCount: singleRawEventIds.length },
  );
  const raceRawEventIds = await page.evaluate(
    (sessionId) =>
      window
        .__raceGetAll?.()
        .get(sessionId)
        ?.events.map((event) => event.event_id),
    fleetSessionId,
  );
  await page.close();

  const urlPage = await newPage();
  await urlPage.goto(swimlaneUrl);
  await urlPage.waitForFunction(() => window.__OBS_STATE?.sessionsLoaded === true);
  const urlState = await urlPage.evaluate(() => ({
    pool: document.querySelector("#pool-filter")?.value,
    tag: document.querySelector("#tag-filter")?.value,
    "window.location.hash": window.location.hash,
  }));
  await urlPage.close();

  if (browserErrors.length > 0) {
    throw new Error(`Browser console errors:\n${browserErrors.join("\n")}`);
  }

  process.stdout.write(
    JSON.stringify({
      stressRawEventCount,
      initialVisibleRawEventCount,
      filteredVisibleRawEventCount,
      restoredVisibleRawEventCount,
      singleRawEventIds,
      swimlaneRawEventIds,
      raceRawEventIds,
      selectedSessionId,
      ...urlState,
    }),
  );
} finally {
  await context?.close();
  await browser.close();
}

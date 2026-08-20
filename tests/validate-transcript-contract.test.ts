import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const launcherPath = fileURLToPath(new URL("../scripts/run-transcript-e2e.mjs", import.meta.url));
const launcherSource = existsSync(launcherPath) ? readFileSync(launcherPath, "utf8") : "";
const runnerPath = fileURLToPath(new URL("../scripts/validate-transcript.py", import.meta.url));
const runnerSource = existsSync(runnerPath) ? readFileSync(runnerPath, "utf8") : "";
const browserSource =
  /def browser_test_source\(\) -> str:[\s\S]*?return r'''([\s\S]*?)'''/u.exec(runnerSource)?.[1] ??
  "";

function expectPatternsInOrder(source: string, patterns: RegExp[]): void {
  let offset = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(source.slice(offset));
    expect(match, `missing ordered runner pattern ${pattern}`).not.toBeNull();
    if (match === null) return;
    offset += match.index + match[0].length;
  }
}

describe("deterministic transcript E2E runner", () => {
  it("builds, isolates, validates browser modes, and cleans up fail-hard", () => {
    expect(chromium.name()).toBe("chromium");
    expect(existsSync(runnerPath), "scripts/validate-transcript.py must exist").toBe(true);
    if (!existsSync(runnerPath)) return;
    for (const token of [
      "TemporaryDirectory",
      "OBS_DB_PATH",
      "OBS_AUTH_TOKEN",
      "OBS_PORT",
      "npm",
      "run",
      "build",
      "playwright-cli",
      "user_message",
      "thinking",
      "tool_call",
      "tool_result",
      "assistant_message",
      "trace=raw",
      "swimlane",
      "race",
      "onerror",
      "finally",
      "terminate",
      "kill",
    ])
      expect(runnerSource).toContain(token);
    expect(runnerSource).toContain("check=True");
    expect(runnerSource).toContain("127.0.0.1");
  });

  it("holds the initial session REST response behind a real browser route barrier", () => {
    expect(browserSource, "the initial session-events request must be intercepted").toMatch(
      /page\.route\([\s\S]*?sessions[\s\S]*?events[\s\S]*?async\s*\(?\s*route\s*\)?\s*=>/u,
    );
    expect(browserSource, "REST must be captured before its release gate is opened").toMatch(
      /route\.fetch\(\)[\s\S]*?await\s+[\w.]*initialRest[\w.]*(?:release|barrier|gate)[\w.]*[\s\S]*?route\.fulfill\(/iu,
    );
    expect(browserSource, "the REST gate must be an explicit controllable promise").toMatch(
      /(?:new Promise|Promise\.withResolvers)[\s\S]{0,500}initialRest/iu,
    );
    expectPatternsInOrder(browserSource, [/page\.route\(/u, /page\.goto\(/u]);
  });

  it("injects overlapping SSE after REST is held and before REST is released", () => {
    expect(browserSource, "the race needs a named SSE overlap event").toMatch(
      /event_id:\s*["'][^"']*(?:race|overlap)[^"']*["']/iu,
    );
    expectPatternsInOrder(browserSource, [
      /page\.goto\(/u,
      /await\s+[\w.]*initialRest[\w.]*(?:requested|captured|held|started)[\w.]*/iu,
      /await\s+expect\(page\.locator\(["']#live-label["']\)\)\.toHaveText\(["']live["']\)/u,
      /(?:page\.request\.post|inject\w*Sse\w*|__\w*Sse\w*\.emit)\s*\(/iu,
      /(?:release\w*initialRest|initialRest\w*release)\w*\s*\(/iu,
    ]);
  });

  it("asserts duplicate out-of-arrival envelopes once in numeric seq order", () => {
    const arrivalBlock =
      /const\s+\w*(?:race|overlap)\w*(?:events|envelopes)\w*\s*=\s*\[([\s\S]*?)\];/iu.exec(
        browserSource,
      )?.[1];
    expect(arrivalBlock, "the runner needs an explicit race arrival fixture").toBeDefined();
    if (arrivalBlock === undefined) return;

    const sequences = [...arrivalBlock.matchAll(/seq:\s*(\d+)/gu)].map((match) => Number(match[1]));
    const eventIds = [...arrivalBlock.matchAll(/event_id:\s*["']([^"']+)["']/gu)].map(
      (match) => match[1],
    );
    expect(sequences.length).toBeGreaterThanOrEqual(3);
    expect(sequences.some((sequence, index) => index > 0 && sequence < sequences[index - 1]!)).toBe(
      true,
    );
    expect(new Set(eventIds).size).toBeLessThan(eventIds.length);
    expect(browserSource).toMatch(
      /window\.__OBS_STATE\.events[\s\S]{0,500}event_id[\s\S]{0,300}Number\([^)]*seq[^)]*\)/u,
    );
    expect(browserSource).toMatch(/expect\([^;]*(?:order|events|ids)[^;]*\)\.toEqual\(\[/iu);
    expect(browserSource).toMatch(/expect\(new Set\([\s\S]{0,300}\.size\)\.toBe\([^)]*\.length\)/u);
  });

  it("counts requestAnimationFrame schedules and renders per frame", () => {
    expect(browserSource, "rAF must be instrumented before app.js boots").toMatch(
      /page\.addInitScript\([\s\S]*?requestAnimationFrame\s*=\s*/u,
    );
    expectPatternsInOrder(browserSource, [/page\.addInitScript\(/u, /page\.goto\(/u]);
    expect(browserSource, "scheduled transcript renders need a per-frame counter").toMatch(
      /scheduled\w*ByFrame[\s\S]{0,200}(?:\+\+|\.set\()/iu,
    );
    expect(browserSource, "completed transcript renders need a per-frame counter").toMatch(
      /(?:MutationObserver|projectTranscript)[\s\S]*?render\w*ByFrame[\s\S]{0,200}(?:\+\+|\.set\()/iu,
    );
    expect(browserSource).toMatch(/page\.evaluate\([\s\S]*?\w*frame\w*(?:counters|stats)/iu);
    expect(browserSource).toMatch(/scheduled\w*ByFrame[\s\S]{0,500}toBeLessThanOrEqual\(1\)/iu);
    expect(browserSource).toMatch(/render\w*ByFrame[\s\S]{0,500}toBeLessThanOrEqual\(1\)/iu);
  });

  it("compares the complete operator-state tuple across a live burst", () => {
    expect(browserSource, "the runner needs a reusable browser-side state capture").toMatch(
      /const\s+\w*(?:capture|snapshot)\w*(?:state|tuple)\w*\s*=\s*(?:async\s*)?\(\)\s*=>\s*page\.evaluate\(/iu,
    );
    for (const [label, field] of [
      ["paused/live intent", /\bautoScroll\s*:/u],
      ["scroll position", /\bscrollTop\s*:/u],
      ["stable scroll anchor", /\banchorKey\s*:/u],
      ["scroll anchor offset", /\banchorOffset\s*:/u],
      ["search value", /\bsearchValue\s*:/u],
      ["search focus", /\bsearchFocused\s*:/u],
      ["thinking visibility", /\bthinkingVisible\s*:/u],
      ["expanded tool", /\bexpandedToolKeys\s*:/u],
      ["open transcript raw details", /\bopenTranscriptRawKeys\s*:/u],
      ["native active control", /\bactiveElement\s*:/u],
      ["native control value", /\bactiveValue\s*:/u],
    ] as const) {
      expect(browserSource, `live-burst tuple must include ${label}`).toMatch(field);
    }

    const burstBlock = /const\s+\w*live\w*burst\w*\s*=\s*\[([\s\S]*?)\];/iu.exec(
      browserSource,
    )?.[1];
    expect(burstBlock, "the state check must inject a multi-event live burst").toBeDefined();
    if (burstBlock === undefined) return;
    expect([...burstBlock.matchAll(/event_id:\s*["'][^"']+["']/gu)].length).toBeGreaterThan(1);

    expect(
      browserSource,
      "the runner must wait for the final burst event before taking the after tuple",
    ).toMatch(
      /page\.request\.post\([\s\S]*?data:\s*\w*live\w*burst\w*[\s\S]*?await\s+expect(?:\.poll)?\([\s\S]{0,1000}(?:#event-view|event_id|\.at\(-1\)|\w*(?:final|last)\w*burst|\w*burst\w*(?:final|last))[\s\S]{0,1000}\)\.(?:toContain|toContainText|toEqual|toHaveText)/iu,
    );
    expect(
      browserSource,
      "before and after must come from the same capture and compare as one tuple",
    ).toMatch(
      /const\s+(\w*before\w*)\s*=\s*await\s+(\w*(?:capture|snapshot)\w*(?:state|tuple)\w*)\(\);[\s\S]*?page\.request\.post\([\s\S]*?data:\s*\w*live\w*burst\w*[\s\S]*?const\s+(\w*after\w*)\s*=\s*await\s+\2\(\);[\s\S]*?expect\(\3\)\.toEqual\(\1\)/iu,
    );
    expect(browserSource).toMatch(/expect\(\w*before\w*\.autoScroll\)\.toBe\(false\)/iu);
    expect(browserSource).toMatch(/expect\(\w*before\w*\.scrollTop\)\.toBeGreaterThan\(0\)/iu);
    expect(browserSource).toMatch(
      /expect\(\w*before\w*\.anchorKey\)\.(?:toBeTruthy\(\)|not\.toBe(?:Null|Undefined)\(\))/iu,
    );
    expect(browserSource).toMatch(/expect\(\w*before\w*\.searchValue\)\.toBe\(["'][^"']+["']\)/iu);
    expect(browserSource).toMatch(/expect\(\w*before\w*\.searchFocused\)\.toBe\(true\)/iu);
    expect(browserSource).toMatch(/expect\(\w*before\w*\.thinkingVisible\)\.toBe\(false\)/iu);
    for (const field of ["expandedToolKeys", "openTranscriptRawKeys"]) {
      expect(browserSource).toMatch(
        new RegExp(
          `expect\\(\\w*before\\w*\\.${field}\\)\\.(?:toContain\\([^)]*\\)|not\\.toHaveLength\\(0\\)|toEqual\\(\\[[^\\]]+\\]\\))`,
          "iu",
        ),
      );
    }
    expect(browserSource).toMatch(
      /expect\(\w*before\w*\.activeElement\)\.toBe\(["'][^"']+["']\)/iu,
    );
    expect(browserSource).toMatch(/expect\(\w*before\w*\.activeValue\)\.toBe\(["'][^"']+["']\)/iu);
  });

  it("keeps paused scroll intent beyond every delayed bottom anchor", () => {
    expect(browserSource).toMatch(
      /const\s+establishPausedScrollAfterScheduledBottomAnchor\s*=\s*async/u,
    );
    expectPatternsInOrder(browserSource, [
      /#btn-thinking-toggle[\s\S]*?\.click\(\)/u,
      /scrollTop\s*=\s*120/u,
      /dispatchEvent\(new Event\(["']scroll["']\)\)/u,
      /expect\.poll\([\s\S]*?autoScroll[\s\S]*?toBe\(false\)/u,
      /waitForTimeout\(180\)/u,
      /atBottom:\s*eventView\.scrollHeight\s*-\s*eventView\.scrollTop\s*-\s*eventView\.clientHeight\s*<\s*40/u,
      /expect\(pausedAfterDelayedAnchors\)\.toEqual\(\{\s*autoScroll:\s*false,\s*atBottom:\s*false\s*\}\)/u,
    ]);
  });

  it("parameterizes native-control key actions without changing mode or navigation", () => {
    const matrixMatch =
      /const\s+(\w*native\w*(?:cases|matrix|targets)\w*)\s*=\s*\[([\s\S]*?)\];/iu.exec(
        browserSource,
      );
    const matrixName = matrixMatch?.[1];
    const matrixSource = matrixMatch?.[2];
    expect(matrixSource, "the runner needs a parameterized native-control matrix").toBeDefined();
    if (matrixName === undefined || matrixSource === undefined) return;

    for (const target of [
      "input",
      "button",
      "summary",
      "link",
      "select",
      "textarea",
      "contenteditable",
    ]) {
      expect(matrixSource, `native-control matrix must include ${target}`).toMatch(
        new RegExp(`(?:kind|name|target|type):\\s*["']${target}["']`, "u"),
      );
    }
    expect([...matrixSource.matchAll(/\bnativeKey\s*:/gu)]).toHaveLength(7);
    expect([...matrixSource.matchAll(/\bassertNative\s*:/gu)]).toHaveLength(7);

    const shortcutsMatch =
      /const\s+(\w*(?:protected|global|transcript)\w*shortcut\w*)\s*=\s*\[([\s\S]*?)\];/iu.exec(
        browserSource,
      );
    const shortcutsName = shortcutsMatch?.[1];
    const shortcutsSource = shortcutsMatch?.[2];
    expect(shortcutsSource, "the matrix needs shared shortcut key actions").toBeDefined();
    if (shortcutsName === undefined || shortcutsSource === undefined) return;
    expect(shortcutsSource).toMatch(/Control\+(?:Key)?[tT]/u);
    expect(shortcutsSource).toMatch(/Control\+(?:Key)?[oO]/u);
    expect(shortcutsSource).toMatch(/["'](?:j|k|g|G|ArrowDown|ArrowUp)["']/u);
    expect(shortcutsSource).toMatch(/["']\/["']/u);
    expect(shortcutsSource).toMatch(/["']\?["']/u);

    expect(browserSource, "mode/navigation capture must run in the browser").toMatch(
      /const\s+\w*(?:capture|snapshot)\w*(?:mode|navigation)\w*\s*=\s*(?:async\s*)?\(\)\s*=>\s*page\.evaluate\(/iu,
    );
    for (const field of [
      /\btraceMode\s*:/u,
      /\bview\s*:/u,
      /\bfocusedIdx\s*:/u,
      /\bthinkingVisible\s*:/u,
      /\btoolsExpanded\s*:/u,
      /\b(?:hash|url)\s*:/iu,
    ])
      expect(browserSource, "mode/navigation snapshot is incomplete").toMatch(field);

    expect(
      browserSource,
      "every target and shortcut must use target-originated keys and compare mode/navigation",
    ).toMatch(
      new RegExp(
        `for\\s*\\(\\s*const\\s+(?:\\{[^}]+\\}|\\w+)\\s+of\\s+${matrixName}\\s*\\)[\\s\\S]*?for\\s*\\(\\s*const\\s+\\w+\\s+of\\s+${shortcutsName}\\s*\\)[\\s\\S]*?const\\s+(\\w*before\\w*(?:mode|navigation)\\w*)\\s*=\\s*await\\s+(\\w*(?:capture|snapshot)\\w*(?:mode|navigation)\\w*)\\(\\);[\\s\\S]*?(?:\\.press|keyboard\\.press)\\([^)]*(?:shortcut|key)[^)]*\\)[\\s\\S]*?const\\s+(\\w*after\\w*(?:mode|navigation)\\w*)\\s*=\\s*await\\s+\\2\\(\\);[\\s\\S]*?expect\\(\\3\\)\\.toEqual\\(\\1\\)`,
        "iu",
      ),
    );
    expect(browserSource).toMatch(/await\s+expect\([^)]*\)\.toBeFocused\(\)/u);
    expect(browserSource).toMatch(/\.press\([^)]*\.nativeKey\)[\s\S]*?\.assertNative\(/u);
  });
});

const intermediateCaptureContracts = [
  {
    scenarioId: "hostile-text-and-native-controls",
    screenshots: ["hostile-literal-transcript-raw", "native-control-focus"],
    tupleFields: [
      "hostileMarkers",
      "executableNodeCount",
      "sentinelValues",
      "dialogs",
      "unexpectedRequests",
      "rawFixture",
      "nativeControlTuples",
      "consoleErrors",
    ],
  },
  {
    scenarioId: "rest-sse-race-and-frame-batching",
    screenshots: ["race-merged-transcript", "post-burst-order"],
    tupleFields: [
      "arrivalTrace",
      "heldRestEventIds",
      "sseArrivalEventIds",
      "mergedEventIds",
      "mergedSequences",
      "replayEventIds",
      "scheduledByFrame",
      "renderByFrame",
    ],
  },
  {
    scenarioId: "preserve-sse-against-stale-rest",
    screenshots: ["sse-before-rest-release", "sse-survives-stale-rest"],
    tupleFields: [
      "arrivalTrace",
      "staleRestEventIds",
      "beforeReleaseEventIds",
      "afterReleaseEventIds",
      "replayEventIds",
      "duplicateCounts",
    ],
  },
  {
    scenarioId: "live-rerender-preserves-operator-state",
    screenshots: ["state-before-live-burst", "state-after-live-burst"],
    tupleFields: ["before", "after", "ingestionResponse", "finalEventId", "eventIds"],
  },
  {
    scenarioId: "resist-live-state-reset-burst",
    screenshots: ["adversarial-state-before", "adversarial-state-after"],
    tupleFields: [
      "before",
      "during",
      "after",
      "matchingBurstIds",
      "nonmatchingBurstIds",
      "burstResponses",
      "semanticDiff",
      "focusedControlOperability",
    ],
  },
  {
    scenarioId: "keyboard-and-url-mode-round-trip",
    screenshots: ["mode-shortcuts-help", "raw-url-after-reload"],
    tupleFields: [
      "shortcutActions",
      "redactedUrls",
      "transcriptMode",
      "rawModeAfterReload",
      "searchFocused",
      "authorizedStatus",
      "unauthorizedStatus",
    ],
  },
  {
    scenarioId: "protect-native-controls-from-shortcuts",
    screenshots: ["native-target-focused", "native-action-retained"],
    tupleFields: [
      "actionTuples",
      "targetKinds",
      "shortcutKeys",
      "activeElements",
      "nativeValues",
      "nativeActivations",
      "modeDiffs",
    ],
  },
] as const;

interface LauncherInvocation {
  pid: number;
  trial: string;
  artifactRoot: string;
}

function escapePattern(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function observationTupleBody(scenarioId: string): string {
  const match = new RegExp(
    `persistObservationTuple\\(\\s*["']${escapePattern(scenarioId)}["']\\s*,\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
    "u",
  ).exec(browserSource);
  expect(match, `${scenarioId} must persist a machine-readable observation tuple`).not.toBeNull();
  return match?.[1] ?? "";
}

it("defines a distinct adversarial repeated-burst capture in Python and executable Chromium", () => {
  const scenarioId = "resist-live-state-reset-burst";
  const captureContract = /CAPTURE_CONTRACT\s*=\s*\{([\s\S]*?)\n\}/u.exec(runnerSource)?.[1] ?? "";

  expect(captureContract).toMatch(
    /["']resist-live-state-reset-burst["'][\s\S]*?["']adversarial-state-before["'][\s\S]*?["']adversarial-state-after["']/u,
  );
  for (const field of [
    "before",
    "during",
    "after",
    "matchingBurstIds",
    "nonmatchingBurstIds",
    "burstResponses",
    "semanticDiff",
    "focusedControlOperability",
  ]) {
    expect(captureContract, `CAPTURE_CONTRACT must require ${field}`).toContain(`"${field}"`);
  }

  expect(
    browserSource,
    "matching and nonmatching bursts must be distinct repeated fixtures",
  ).toMatch(
    /const\s+\w*matching\w*burst\w*\s*=\s*\[[\s\S]*?\];[\s\S]*?const\s+\w*nonmatching\w*burst\w*\s*=\s*\[[\s\S]*?\];/iu,
  );
  expect(browserSource, "the adversarial scenario must capture before, during, and after").toMatch(
    /const\s+\w*before\w*\s*=\s*await\s+\w*(?:capture|snapshot)\w*\(\);[\s\S]*?const\s+\w*during\w*\s*=\s*await\s+\w*(?:capture|snapshot)\w*\(\);[\s\S]*?const\s+\w*after\w*\s*=\s*await\s+\w*(?:capture|snapshot)\w*\(\)/iu,
  );
  const tupleBody = observationTupleBody(scenarioId);
  expect(tupleBody).toMatch(/semanticDiff\s*:\s*\w+/u);
  expect(tupleBody).toMatch(/focusedControlOperability\s*:\s*\w+/u);
  expect(browserSource).toMatch(/expect\(\w*semanticDiff\w*\)\.toEqual\(\[\]\)/u);
  expect(browserSource).toMatch(/expect\(\w*focusedControlOperability\w*\)\.toBe\(true\)/u);
});

describe("run-5 two-trial intermediate capture contract", () => {
  it("launches two independently numbered Python trials", () => {
    const directory = mkdtempSync(join(tmpdir(), "sty190-e2e-launcher-"));
    const fakePython = join(directory, "python3");
    const invocationLog = join(directory, "invocations.jsonl");
    writeFileSync(
      fakePython,
      `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.STY190_E2E_PROBE_LOG, JSON.stringify({
  pid: process.pid,
  trial: process.env.STY190_E2E_TRIAL,
  artifactRoot: process.env.STY190_E2E_ARTIFACT_ROOT,
}) + "\\n");
`,
    );
    chmodSync(fakePython, 0o755);

    try {
      const artifactRoot = join(directory, "artifacts");
      const result = spawnSync(process.execPath, [launcherPath], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"] ?? ""}`,
          STY190_E2E_ARTIFACT_ROOT: artifactRoot,
          STY190_E2E_PROBE_LOG: invocationLog,
        },
      });
      const invocations = existsSync(invocationLog)
        ? readFileSync(invocationLog, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line): LauncherInvocation => JSON.parse(line) as LauncherInvocation)
        : [];

      expect(result.status, result.stderr).toBe(0);
      expect(invocations).toHaveLength(2);
      expect(invocations.map((invocation) => invocation.trial)).toEqual(["1", "2"]);
      expect(new Set(invocations.map((invocation) => invocation.pid)).size).toBe(2);
      expect(invocations.map((invocation) => invocation.artifactRoot)).toEqual([
        artifactRoot,
        artifactRoot,
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("writes trial-scoped screenshots and JSON tuples to preserved artifacts", () => {
    expect(
      browserSource.includes("STY190_E2E_ARTIFACT_ROOT"),
      "browser captures need a preserved artifact root",
    ).toBe(true);
    expect(
      browserSource.includes("STY190_E2E_TRIAL"),
      "browser captures need the numbered trial",
    ).toBe(true);
    expect(browserSource).toMatch(
      /(?:async function captureIntermediateScreenshot|const captureIntermediateScreenshot\s*=\s*async)[\s\S]*page\.screenshot\(/u,
    );
    expect(browserSource).toMatch(
      /(?:async function persistObservationTuple|const persistObservationTuple\s*=\s*async)[\s\S]*(?:writeFile|writeFileSync)\([\s\S]*JSON\.stringify\(/u,
    );
    expect(browserSource).toMatch(/trial-[^\n]*\.png/u);
    expect(browserSource).toMatch(/trial-[^\n]*(?:observation|tuple)[^\n]*\.json/iu);

    const verificationSource = `${launcherSource}\n${runnerSource}`;
    expect(verificationSource).toMatch(/(?:statSync|\.stat\(\)|getsize)[\s\S]*\.size|st_size/u);
    expect(verificationSource).toMatch(/(?:JSON\.parse|json\.load)[\s\S]*(?:observation|tuple)/iu);
  });

  it.each(intermediateCaptureContracts)(
    "preserves $scenarioId named screenshots and observation tuple",
    ({ scenarioId, screenshots, tupleFields }) => {
      for (const screenshot of screenshots) {
        const callPattern = new RegExp(
          `captureIntermediateScreenshot\\(\\s*page\\s*,\\s*["']${escapePattern(scenarioId)}["']\\s*,\\s*["']${escapePattern(screenshot)}["']\\s*\\)`,
          "u",
        );
        expect(
          callPattern.test(browserSource),
          `${scenarioId} must preserve ${screenshot}.png in each trial`,
        ).toBe(true);
      }

      const tupleBody = observationTupleBody(scenarioId);
      for (const field of tupleFields) {
        expect(tupleBody, `${scenarioId} observation must include ${field}`).toMatch(
          new RegExp(`\\b${escapePattern(field)}\\s*:`, "u"),
        );
      }
    },
  );
});

it("compares exact raw IDs and restores sibling selection, hashes, and Single baseline", () => {
  expect(
    browserSource,
    "the journey must capture the immutable Single raw-event ID baseline",
  ).toMatch(
    /const\s+(\w*single\w*(?:raw\w*)?(?:baseline|ids)\w*)\s*=\s*await\s+page\.evaluate\(\(\)\s*=>\s*window\.__OBS_STATE\.events\.map\(event\s*=>\s*event\.event_id\)\)/iu,
  );

  expectPatternsInOrder(browserSource, [
    /const\s+\w*single\w*(?:baseline|ids)\w*\s*=\s*await\s+page\.evaluate\(/iu,
    /#btn-swimlane/iu,
    /window\.__swimlaneGetAll\(\)[\s\S]{0,300}events\.map\(event\s*=>\s*event\.event_id\)/iu,
    /expect\([^;]*swimlane[^;]*(?:ids|event)[^;]*\)\.toEqual\([^;]*single[^;]*(?:baseline|ids)[^;]*\)/iu,
    /#btn-race/iu,
    /window\.__raceGetAll\(\)[\s\S]{0,300}events\.map\(event\s*=>\s*event\.event_id\)/iu,
    /expect\([^;]*race[^;]*(?:ids|event)[^;]*\)\.toEqual\([^;]*single[^;]*(?:baseline|ids)[^;]*\)/iu,
    /#btn-single/iu,
    /window\.__OBS_STATE\.events\.map\(event\s*=>\s*event\.event_id\)/iu,
    /expect\([^;]*single[^;]*(?:return|restored|after)[^;]*\)\.toEqual\([^;]*single[^;]*(?:baseline|ids)[^;]*\)/iu,
  ]);

  expect(browserSource, "Swimlane must assert its selected lane/session state").toMatch(
    /expect\(await\s+page\.evaluate\(\(\)\s*=>\s*window\.__swimlaneGetLanes\(\)\)\)\.toEqual\(\[[^\]]+\]\)/iu,
  );
  expect(browserSource, "Race must assert its selected lane/session state").toMatch(
    /expect\(await\s+page\.evaluate\(\(\)\s*=>\s*window\.__raceGetLanes\(\)\)\)\.toEqual\(\[[^\]]+\]\)/iu,
  );

  for (const mode of ["swimlane", "race", "single"]) {
    expect(browserSource, `${mode} must assert mode-specific URL hash restoration`).toMatch(
      new RegExp(
        `expect\\([^;]*(?:hash|page)[^;]*\\)\\.(?:toBe|toEqual|toHaveURL)\\([^;]*view=${mode}[^;]*\\)`,
        "iu",
      ),
    );
  }
});

interface EvidenceArtifact {
  artifact: string;
  sha256: string;
}

interface ParityEvidenceArtifact extends EvidenceArtifact {
  runId: string;
  sessionId: string;
}

interface AttemptTwoEvidenceManifest {
  storyId: string;
  run: number;
  attempt: number;
  sourceSha: string;
  capturedAt: string;
  command: string;
  runIdentity: { runId: string; sessionId: string };
  browserIdentity: {
    name: string;
    version: string;
    os: string;
    device: string;
    viewport: { width: number; height: number; devicePixelRatio: number };
  };
  redactions: string[];
  artifacts: {
    piTuiCapture: ParityEvidenceArtifact;
    browserScreenshot: ParityEvidenceArtifact;
    qualityTerminalCapture: EvidenceArtifact;
    qualityProbeTerminalCapture: EvidenceArtifact;
  };
}

const attemptTwoEvidenceRoot = join(
  repositoryRoot,
  ".pi/artifacts/implementation/stories/STY-190/evidence/e2e-verification-run-5-attempt-2",
);
const attemptTwoValidationRoot = join(
  repositoryRoot,
  ".pi/artifacts/validation/STY-190/e2e-verification-run-5-attempt-2",
);
const attemptTwoManifestPath = join(attemptTwoEvidenceRoot, "manifest.json");

function expectHashedCapture(artifact: EvidenceArtifact, expectedRoot: string): void {
  expect(isAbsolute(artifact.artifact), "evidence paths must be repository-relative").toBe(false);
  expect(artifact.artifact).toMatch(/\.png$/iu);

  const capturePath = resolve(repositoryRoot, artifact.artifact);
  const scopedPath = relative(expectedRoot, capturePath);
  expect(
    scopedPath !== ".." && !scopedPath.startsWith(`..${sep}`) && !isAbsolute(scopedPath),
    `${artifact.artifact} must be scoped to the attempt-2 evidence run`,
  ).toBe(true);
  expect(existsSync(capturePath), `${artifact.artifact} must exist`).toBe(true);
  if (!existsSync(capturePath)) return;

  const capture = readFileSync(capturePath);
  expect(capture.byteLength, `${artifact.artifact} must be nonempty`).toBeGreaterThan(0);
  expect(artifact.sha256).toMatch(/^[a-f\d]{64}$/u);
  expect(createHash("sha256").update(capture).digest("hex")).toBe(artifact.sha256);
}

describe("run-5 attempt-2 final evidence contract", () => {
  it("binds current-source parity and locked-quality captures in a redacted manifest", () => {
    expect(
      existsSync(attemptTwoManifestPath),
      "run-5 attempt-2 must add a run-scoped evidence manifest",
    ).toBe(true);
    if (!existsSync(attemptTwoManifestPath)) return;

    const manifestText = readFileSync(attemptTwoManifestPath, "utf8");
    const manifest = JSON.parse(manifestText) as AttemptTwoEvidenceManifest;
    const git = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(git.status, git.stderr).toBe(0);
    expect(structuredClone(manifest)).toMatchObject({
      storyId: "STY-190",
      run: 5,
      attempt: 2,
      sourceSha: git.stdout.trim(),
      capturedAt: expect.stringMatching(/\S/u),
      command: expect.stringMatching(/\S/u),
      runIdentity: {
        runId: expect.stringMatching(/\S/u),
        sessionId: expect.stringMatching(/\S/u),
      },
      browserIdentity: {
        name: expect.stringMatching(/\S/u),
        version: expect.stringMatching(/\S/u),
        os: expect.stringMatching(/\S/u),
        device: expect.stringMatching(/\S/u),
      },
    });
    expect(Number.isNaN(Date.parse(manifest.capturedAt))).toBe(false);
    expect(manifest.browserIdentity.viewport.width).toBeGreaterThan(0);
    expect(manifest.browserIdentity.viewport.height).toBeGreaterThan(0);
    expect(manifest.browserIdentity.viewport.devicePixelRatio).toBeGreaterThan(0);

    const redactions = manifest.redactions.join("\n");
    expect(redactions).toMatch(/(?:auth|credential|token).*?(?:redact|omit)/iu);
    expect(redactions).toMatch(/(?:absolute|local).*?path.*?(?:redact|omit)/iu);
    const safeMetadata = manifestText.replaceAll(
      /(?:<redacted>|\[redacted\]|\bredacted\b|<omitted>|\[omitted\]|\bomitted\b)/giu,
      "SAFE_REDACTION",
    );
    expect(safeMetadata).not.toMatch(
      /(?:\bBearer\s+(?!SAFE_REDACTION\b)[^\s"',}]+|[?&]token=(?!SAFE_REDACTION\b)[^&\s"',}]+|\bOBS_AUTH_TOKEN\s*=\s*(?!SAFE_REDACTION\b)[^\s"',}]+|["']?(?:auth(?:entication)?_?token|authorization|token)["']?\s*[:=]\s*["']?(?!SAFE_REDACTION\b)[^\s"',}]+)/iu,
    );
    expect(safeMetadata).not.toMatch(
      /(?:file:\/\/)?\/(?:Users|home|tmp|private\/(?:tmp|var)|var\/folders)\/[^\s"',}]+|[A-Za-z]:\\(?:Users|Temp)\\[^\s"',}]+/u,
    );

    const { piTuiCapture, browserScreenshot, qualityTerminalCapture, qualityProbeTerminalCapture } =
      manifest.artifacts;
    expect([piTuiCapture.runId, piTuiCapture.sessionId]).toEqual([
      manifest.runIdentity.runId,
      manifest.runIdentity.sessionId,
    ]);
    expect([browserScreenshot.runId, browserScreenshot.sessionId]).toEqual([
      manifest.runIdentity.runId,
      manifest.runIdentity.sessionId,
    ]);
    expect(
      new Set([
        piTuiCapture.artifact,
        browserScreenshot.artifact,
        qualityTerminalCapture.artifact,
        qualityProbeTerminalCapture.artifact,
      ]).size,
    ).toBe(4);

    expectHashedCapture(piTuiCapture, attemptTwoEvidenceRoot);
    expectHashedCapture(browserScreenshot, attemptTwoEvidenceRoot);
    expectHashedCapture(qualityTerminalCapture, attemptTwoValidationRoot);
    expectHashedCapture(qualityProbeTerminalCapture, attemptTwoValidationRoot);
  });
});

interface HandoffValidationStage {
  id: string;
  status: string;
}

interface AttemptTwoHandoffReport {
  storyId: string;
  status: string;
  generatedAt: string;
  stages: HandoffValidationStage[];
}

it("records the run-5 dev-story attempt-2 handoff without self-certifying downstream gates", () => {
  const storyRecord = readFileSync(
    join(repositoryRoot, ".pi/artifacts/implementation/stories/STY-190.md"),
    "utf8",
  );
  const sprintStatus = readFileSync(
    join(repositoryRoot, ".pi/artifacts/implementation/sprint-status.yaml"),
    "utf8",
  );
  const report = JSON.parse(
    readFileSync(join(repositoryRoot, ".pi/artifacts/validation/validation-report.json"), "utf8"),
  ) as AttemptTwoHandoffReport;
  const requiredGates = [
    ["stage-tests", "bun test"],
    ["stage-typecheck", "bun run typecheck"],
    ["stage-lint", "bun run lint"],
    ["stage-e2e", "npm run test:e2e"],
    ["stage-quality-probe", "npm run quality:probe"],
    ["stage-check", "npm run check"],
  ] as const;

  expect(report).toEqual({
    storyId: "STY-190",
    status: "passed",
    generatedAt: expect.stringMatching(/\S/u),
    stages: [
      { id: "stage-tests", status: "passed" },
      { id: "stage-typecheck", status: "passed" },
      { id: "stage-lint", status: "passed" },
    ],
  });
  expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);

  const debugLog = /### Debug Log([\s\S]*?)### Completion Notes/u.exec(storyRecord)?.[1] ?? "";
  const handoff =
    /\*\*E2E Run 5[^*\n]*dev-story attempt 2[^*\n]*handoff[^*\n]*:\*\*([\s\S]*?)(?=\n\*\*|\n###|$)/iu.exec(
      debugLog,
    )?.[0] ?? "";
  expect(handoff, "Debug Log must contain the run-5 dev-story attempt-2 handoff").not.toBe("");
  for (const [, command] of requiredGates) {
    expect(handoff).toMatch(
      new RegExp(`\`${escapePattern(command)}\`[^\\n]*(?:pass(?:ed)?|exit(?:ed)? 0)`, "iu"),
    );
  }
  expect(handoff).toMatch(/ready-for-review/iu);
  for (const gate of ["independent (?:code )?review", "PR", "merge"]) {
    expect(handoff).toMatch(new RegExp(`${gate}[^\\n]*pending`, "iu"));
  }

  const changeLog = /## Change Log([\s\S]*?)## Status/u.exec(storyRecord)?.[1] ?? "";
  expect(changeLog).toMatch(/E2E Run 5[^\n]*dev-story attempt 2[^\n]*handoff/iu);
  expect(storyRecord.match(/^## Senior Developer Review(?: \(AI\))?$/gmu) ?? []).toHaveLength(1);
  expect(storyRecord).toMatch(/## Status[\s\S]*?\*\*Current:\*\* `ready-for-review`/u);
  expect(sprintStatus).toMatch(/developmentStatus:\s*\n\s*STY-190: ready-for-review/u);
  expect(sprintStatus).toMatch(/- id: STY-190[\s\S]*?\n\s*status: ready-for-review/u);

  const lastUpdated = /^lastUpdated:\s*(\S+)/mu.exec(sprintStatus)?.[1] ?? "";
  expect(Number.isNaN(Date.parse(lastUpdated))).toBe(false);
  expect(Date.parse(lastUpdated)).toBeGreaterThanOrEqual(Date.parse(report.generatedAt));
});

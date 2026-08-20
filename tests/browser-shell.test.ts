import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  fileURLToPath(new URL("../apps/observability/public/index.html", import.meta.url)),
  "utf8",
);
const appSource = readFileSync(
  fileURLToPath(new URL("../apps/observability/public/app.js", import.meta.url)),
  "utf8",
);
const fleetSource = readFileSync(
  fileURLToPath(new URL("../scripts/spawn-fleet.sh", import.meta.url)),
  "utf8",
);
const validatorSource = readFileSync(
  fileURLToPath(new URL("../scripts/validate-swimlane.ts", import.meta.url)),
  "utf8",
);
function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  return startIndex >= 0 && endIndex > startIndex ? source.slice(startIndex, endIndex) : "";
}

describe("Single transcript shell", () => {
  it("declares accessible transcript and raw controls", () => {
    expect(html).toMatch(/id="trace-toggle"[^>]*aria-label="Single view display"/u);
    expect(html).toMatch(/id="btn-trace-transcript"[^>]*aria-pressed="true"[^>]*>Transcript</u);
    expect(html).toMatch(/id="btn-trace-raw"[^>]*aria-pressed="false"[^>]*>Raw Events</u);
    expect(html).toContain('id="btn-thinking-toggle"');
    expect(html).toContain('id="btn-tools-toggle"');
  });

  it("documents transcript shortcuts and wraps complete content", () => {
    expect(html).toContain("Ctrl+T");
    expect(html).toContain("Ctrl+O");
    expect(html).toMatch(
      /\.transcript-body\s*\{[^}]*white-space:\s*pre-wrap[^}]*overflow-wrap:\s*anywhere/u,
    );
  });

  it("loads the generated classic bundle immediately before app.js", () => {
    expect(html).toMatch(
      /<script src="transcript\.js"><\/script>\s*<script src="app\.js"><\/script>/u,
    );
    expect(html).not.toMatch(/<script[^>]*(?:async|defer|type="module")[^>]*src="transcript\.js"/u);
  });

  it("wires transcript mode without replacing raw or sibling consumers", () => {
    expect(appSource).toContain('traceMode: "transcript"');
    expect(appSource).toMatch(
      /const TRANSCRIPT_API = window\.OBS_TRANSCRIPT;[\s\S]*throw new Error/u,
    );
    expect(appSource).toMatch(/p\.get\("trace"\) === "raw"/u);
    expect(appSource).toMatch(/STATE\.view === "single" && STATE\.traceMode === "raw"/u);
    expect(appSource).toContain("TRANSCRIPT_API.projectTranscript(STATE.events)");
    expect(appSource).not.toContain("function projectTranscript(");
    expect(appSource).toContain("function renderRawEvents()");
    expect(appSource).toContain("async function fetchSessionEvents");
    expect(appSource).toContain("window.__swimlaneOnEvent");
    expect(appSource).toContain("window.__raceOnEvent");
  });

  it("lets fleet children auto-discover observability without duplicate extension loading", () => {
    const fleetRunSource = sourceBetween(fleetSource, "run() {", "run planner");

    expect(fleetRunSource).not.toMatch(/\bpi\s+-e\s+["']?\$EXT/u);
    expect(fleetRunSource).toContain("--o-pool integration-v2");
    expect(fleetRunSource).toContain("--o-tag fleet");
    expect(fleetRunSource).toContain('--o-name "$name"');
  });

  it("keeps the legacy raw validator on Raw only for T2 and T3", () => {
    expect(validatorSource).toContain("#view=single&trace=raw&sid=${stressSid}");
    expect(validatorSource).toContain("#view=single&trace=raw&pool=integration-v2&tag=fleet");
    expect(validatorSource.match(/trace=raw/gu) ?? []).toHaveLength(2);
    expect(validatorSource).toContain("/events/stream?pool=integration-v2&tag=fleet&token=${TOK}");
    expect(validatorSource).toContain("view=swimlane&pool=integration-v2&tag=fleet");
  });

  it("uses the locked project Playwright runner", () => {
    expect(validatorSource).not.toContain("playwright-cli");
    expect(validatorSource).toContain("scripts/run-swimlane-browser.mjs");
  });
});

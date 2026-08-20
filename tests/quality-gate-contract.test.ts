import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const probePath = fileURLToPath(new URL("../scripts/validate-quality-gates.mjs", import.meta.url));
const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
  scripts?: Record<string, string>;
};
const probeSource = existsSync(probePath) ? readFileSync(probePath, "utf8") : "";

describe("locked quality-gate probe", () => {
  it("exposes a stable public quality probe command", () => {
    expect(packageJson.scripts?.["quality:probe"]).toBe("node scripts/validate-quality-gates.mjs");
  });

  it("rejects isolated coverage, test-focus, and stale-asset weakening", () => {
    expect(existsSync(probePath), "scripts/validate-quality-gates.mjs must exist").toBe(true);
    if (!existsSync(probePath)) return;

    expect(probeSource).toMatch(/vitest\.config\.ts/u);
    expect(probeSource).toMatch(
      /thresholds[\s\S]*(?:statements|branches|functions|lines)[\s\S]*90/u,
    );
    expect(probeSource).toMatch(/(?:exclude|include)[\s\S]*src/u);
    expect(probeSource).toMatch(/(?:\.only|\.skip|describe\.only|it\.only|test\.only)/u);
    expect(probeSource).toMatch(/apps\/observability\/public\/transcript\.js/u);

    expect(probeSource).toMatch(/(?:spawnSync|execFileSync|execSync)[\s\S]*test:coverage/u);
    expect(probeSource).toMatch(
      /(?:spawnSync|execFileSync|execSync)[\s\S]*(?:npm["',\s]+run["',\s]+test|vitest)/u,
    );
    expect(probeSource).toMatch(/(?:spawnSync|execFileSync|execSync)[\s\S]*(?:build|test:e2e)/u);
    expect(probeSource).toMatch(
      /(?:status|exitCode)[\s\S]*(?:!==?\s*0|toBeNonzero|expectFailure)/u,
    );
  });

  it("restores exact bytes and hashes in finally after every probe", () => {
    expect(probeSource).toMatch(/createHash\(["']sha256["']\)/u);
    expect(probeSource).toMatch(/readFileSync\([^,)]*\)(?!\s*,\s*["'])/u);
    expect(probeSource).toMatch(
      /finally\s*\{[\s\S]*writeFileSync\([^,]+,\s*[^)]+\)[\s\S]*sha256/iu,
    );
    expect(probeSource).toMatch(/(?:original|before)[\w]*Hash[\s\S]*(?:restored|after)[\w]*Hash/u);
    expect(probeSource).toMatch(
      /(?:restored|after)[\w]*Hash[\s\S]*(?:!==?|===?)\s*(?:original|before)[\w]*Hash/u,
    );
  });

  it("runs two clean aggregate trials and proves browser bundle reproducibility", () => {
    expect(probeSource).toMatch(/for\s*\([^)]*(?:<\s*2|of\s*\[\s*1\s*,\s*2\s*\])/u);
    expect(probeSource).toMatch(/npm["',\s]+run["',\s]+check/u);
    expect(probeSource).toMatch(/(?:status|exitCode)[\s\S]*(?:===?\s*0|expectSuccess)/u);
    expect(probeSource).toMatch(
      /(?:build|browser bundle)[\s\S]*sha256[\s\S]*(?:build|browser bundle)[\s\S]*sha256/iu,
    );
    expect(probeSource).toMatch(/(?:first|before)[\w]*Hash[\s\S]*(?:second|after)[\w]*Hash/u);
  });

  it("persists attempt-4 tool, config, asset, command, and pass-two evidence", () => {
    expect(probeSource).toContain(
      ".pi/artifacts/validation/STY-190/dev-story-attempt-4/quality-evidence.json",
    );
    expect(probeSource).toMatch(
      /toolVersions[\s\S]*node[\s\S]*npm[\s\S]*bun[\s\S]*python[\s\S]*playwright/u,
    );
    expect(probeSource).toMatch(
      /lockedConfigHashes[\s\S]*vitest\.config\.ts[\s\S]*eslint\.config\.js/u,
    );
    expect(probeSource).toMatch(
      /generatedAsset[\s\S]*apps\/observability\/public\/transcript\.js[\s\S]*sha256/u,
    );
    expect(probeSource).toMatch(
      /aggregateTrials[\s\S]*trial[\s\S]*(?:exitCode|status)[\s\S]*result/u,
    );
    expect(probeSource).toMatch(/writeFileSync[\s\S]*qualityEvidence/u);
    expect(probeSource).toMatch(
      /aggregateTrials\.push[\s\S]*writeQualityEvidence[\s\S]*expectSuccess/u,
    );
  });
});

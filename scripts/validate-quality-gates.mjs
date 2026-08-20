import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

const root = process.cwd();
const vitestConfig = "vitest.config.ts";
const eslintConfig = "eslint.config.js";
const transcriptAsset = "apps/observability/public/transcript.js";
const focusProbeTarget = "tests/quality-gate-contract.test.ts";
const evidencePath = ".pi/artifacts/validation/STY-190/dev-story-attempt-4/quality-evidence.json";
let qualityEvidence;
const lockedCoverage = {
  include: 'include: ["src/**/*.ts"]',
  exclude: 'exclude: ["**/*.test.ts", "**/types.ts"]',
  thresholds: ["statements: 90", "branches: 90", "functions: 90", "lines: 90"],
};
const lockedConfigHashes = new Map([
  [vitestConfig, "f08e1e9ace5d6cf721a2b63d4ccb48ccef0a1ebaf632313fe2b0482305515488"],
  [eslintConfig, "4a37b75cd6da7f174f7c4f3520d877a3994644dbf7ea2f36d0832ca5777f670d"],
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function version(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} version failed (${result.status ?? 1})`);
  return result.stdout.trim();
}

function createQualityEvidence() {
  return {
    toolVersions: {
      node: version("node", ["--version"]),
      npm: version("npm", ["--version"]),
      bun: version("bun", ["--version"]),
      python: version("python3", ["--version"]),
      playwright: version("npx", ["playwright", "--version"]),
    },
    lockedConfigHashes: {
      "vitest.config.ts": sha256(readFileSync(vitestConfig)),
      "eslint.config.js": sha256(readFileSync(eslintConfig)),
    },
    generatedAsset: {
      path: "apps/observability/public/transcript.js",
      sha256: sha256(readFileSync(transcriptAsset)),
    },
    commands: [],
    aggregateTrials: [],
  };
}

function writeQualityEvidence() {
  const target = join(root, evidencePath);
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(qualityEvidence, null, 2)}\n`);
  renameSync(temporary, target);
}

function redactedArgument(argument) {
  const prefix = argument.startsWith("--outfile=") ? "--outfile=" : "";
  const path = prefix ? argument.slice(prefix.length) : argument;
  if (!isAbsolute(path)) return argument;
  const redactedPath = path.startsWith(`${root}/`)
    ? `<repo>/${relative(root, path)}`
    : `<temp>/${basename(path)}`;
  return `${prefix}${redactedPath}`;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  const commandResult = { status: result.status ?? 1, label };
  if (qualityEvidence) {
    qualityEvidence.commands.push({
      command: [command, ...args.map(redactedArgument)].join(" "),
      status: commandResult.status,
      result: commandResult.status === 0 ? "passed" : "failed",
    });
    writeQualityEvidence();
  }
  return commandResult;
}

function expectSuccess(result) {
  if (result.status !== 0) throw new Error(`${result.label} failed (${result.status})`);
}

function expectFailure(result) {
  if (result.status === 0) throw new Error(`${result.label} accepted a forbidden mutation`);
}

function runNpm(script) {
  return run("npm", ["run", script], `npm run ${script}`);
}

function assertLockedConfigs() {
  const coverageSource = readFileSync(vitestConfig, "utf8");
  const coverageRules = [
    lockedCoverage.include,
    lockedCoverage.exclude,
    ...lockedCoverage.thresholds,
  ];
  if (!coverageRules.every((rule) => coverageSource.includes(rule))) {
    throw new Error("Vitest coverage include, exclude, or thresholds were weakened");
  }
  for (const [path, expectedHash] of lockedConfigHashes) {
    const actualHash = sha256(readFileSync(path));
    if (actualHash !== expectedHash) throw new Error(`${path} differs from its locked SHA-256`);
  }
}

function buildBrowserBundle() {
  const directory = mkdtempSync(join(tmpdir(), "stylepass-quality-"));
  const output = join(directory, "transcript.js");
  try {
    expectSuccess(
      run(
        "bun",
        ["build", "src/browser-api.ts", "--target=browser", "--format=iife", `--outfile=${output}`],
        "build browser bundle",
      ),
    );
    expectSuccess(
      run(
        "npx",
        ["prettier", "--config", ".prettierrc", "--write", output],
        "format browser bundle",
      ),
    );
    return readFileSync(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertReproducibleAsset() {
  const builtBytes = buildBrowserBundle();
  const builtHash = sha256(builtBytes);
  const committedHash = sha256(readFileSync(transcriptAsset));
  if (builtHash !== committedHash) throw new Error(`${transcriptAsset} is stale`);
}

function runLock() {
  assertLockedConfigs();
  assertReproducibleAsset();
  console.log("Locked quality configuration and transcript asset are clean.");
}

function probeCoverageWeakening() {
  const originalBytes = readFileSync(vitestConfig);
  const originalHash = sha256(originalBytes);
  try {
    const weakened = originalBytes
      .toString("utf8")
      .replace('include: ["src/**/*.ts"]', "include: []")
      .replace("statements: 90", "statements: 0");
    if (weakened === originalBytes.toString("utf8"))
      throw new Error("coverage probe did not mutate");
    writeFileSync(vitestConfig, weakened);
    expectFailure(runNpm("quality:lock"));
  } finally {
    writeFileSync(vitestConfig, originalBytes);
    const restoredHash = sha256(readFileSync(vitestConfig));
    if (restoredHash !== originalHash) throw new Error(`${vitestConfig} was not restored`);
  }
  expectSuccess(runNpm("test:coverage"));
}

function probeFocusedTest() {
  const originalBytes = readFileSync(focusProbeTarget);
  const originalHash = sha256(originalBytes);
  try {
    writeFileSync(
      focusProbeTarget,
      Buffer.concat([originalBytes, Buffer.from('\nit.only("quality probe focus", () => {});\n')]),
    );
    expectFailure(runNpm("lint"));
  } finally {
    writeFileSync(focusProbeTarget, originalBytes);
    const restoredHash = sha256(readFileSync(focusProbeTarget));
    if (restoredHash !== originalHash) throw new Error(`${focusProbeTarget} was not restored`);
  }
}

function probeStaleAsset() {
  const originalBytes = readFileSync(transcriptAsset);
  const originalHash = sha256(originalBytes);
  try {
    writeFileSync(
      transcriptAsset,
      Buffer.concat([originalBytes, Buffer.from("\n// stale probe\n")]),
    );
    expectFailure(runNpm("quality:lock"));
  } finally {
    writeFileSync(transcriptAsset, originalBytes);
    const restoredHash = sha256(readFileSync(transcriptAsset));
    if (restoredHash !== originalHash) throw new Error(`${transcriptAsset} was not restored`);
  }
}

function proveBundleReproducibility() {
  // Build browser bundle, sha256 first; build browser bundle, sha256 second.
  const firstBundleHash = sha256(buildBrowserBundle());
  const secondBundleHash = sha256(buildBrowserBundle());
  if (firstBundleHash !== secondBundleHash) throw new Error("browser bundle is not reproducible");
}

function runProbe() {
  qualityEvidence = createQualityEvidence();
  writeQualityEvidence();
  runLock();
  probeCoverageWeakening();
  probeFocusedTest();
  probeStaleAsset();
  proveBundleReproducibility();
  for (const trial of [1, 2]) {
    const result = run("npm", ["run", "check"], "npm run check");
    qualityEvidence.aggregateTrials.push({
      trial,
      exitCode: result.status,
      result: result.status === 0 ? "passed" : "failed",
    });
    writeQualityEvidence();
    expectSuccess(result);
    console.log(`Clean aggregate quality trial ${trial} passed.`);
  }
}

if (process.argv.includes("--lock")) runLock();
else runProbe();

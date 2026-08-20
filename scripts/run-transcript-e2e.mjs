import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const artifactRoot =
  process.env.STY190_E2E_ARTIFACT_ROOT ??
  resolve(".pi/artifacts/validation/STY-190/deterministic-e2e");

for (const trial of ["1", "2"]) {
  const result = spawnSync("python3", ["scripts/validate-transcript.py"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STY190_E2E_ARTIFACT_ROOT: artifactRoot,
      STY190_E2E_TRIAL: trial,
    },
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}

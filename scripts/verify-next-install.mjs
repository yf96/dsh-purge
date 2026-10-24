import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { inspectNextDesktopInstallation, restartPlan } from "../lib/desktop.js";
import { detectSurface } from "../lib/surface.js";

const exe = process.argv[2];
if (!exe) throw new Error('Usage: node scripts/verify-next-install.mjs "<DSH NEXT executable>"');
const info = inspectNextDesktopInstallation(exe);
assert.ok(info, "Expected a DSH NEXT executable");
const identity = () => {
  const file = info.sealed ? info.asar : `${info.appDir}/package.json`;
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
};
const before = identity();
assert.equal(detectSurface({ execPath: exe, argv: [], env: {}, resourcesPath: "", parentPort: null }), "desktop");
assert.equal(restartPlan({ execPath: exe, argv: [], env: {}, resourcesPath: "" }).execPath, exe);
assert.equal(identity(), before);
console.log(JSON.stringify({ ...info, readOnly: true, sha256: before }, null, 2));

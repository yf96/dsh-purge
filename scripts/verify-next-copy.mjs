// Exercise the actual release's patches only on a fresh disposable copy, never the live installation.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "../lib/core.js";
import * as desktop from "../lib/desktop.js";

const exe = process.argv[2];
if (!exe) throw new Error('Usage: node scripts/verify-next-copy.mjs "<DSH NEXT executable>"');
const original = desktop.inspectNextDesktopInstallation(exe);
if (!original?.sealed) throw new Error("Expected a sealed DSH NEXT installation");
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const originalHash = hash(original.asar);
const scratch = path.resolve(".scratch");
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, "next-copy-"));
const copyExe = path.join(root, "DSH NEXT.exe");
const copyAsar = path.join(root, "resources", "app.asar");
const home = path.join(root, "home");
fs.mkdirSync(path.dirname(copyAsar), { recursive: true });
fs.mkdirSync(path.join(home, "profiles", "desktop"), { recursive: true });
fs.writeFileSync(copyExe, "verification fixture; never execute");
fs.copyFileSync(original.asar, copyAsar);
const savedEnv = { ...process.env };
const savedExe = process.execPath;
const savedArgv = process.argv;
try {
  process.execPath = copyExe;
  process.argv = [copyExe, path.join(root, "resources", "app.asar", "lib", "host.js")];
  for (const key of ["DSH_HOME", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"]) process.env[key] = home;
  for (const key of ["DSH_BASE", "DSH_SURFACE", "DSH_DESKTOP_INSTALL"]) delete process.env[key];
  core.resetPathMemo();
  const located = await core.openSealedDesktopHost({ forApply: true });
  const profileDir = path.join(root, "loader-profile");
  fs.mkdirSync(path.join(profileDir, "node_modules"), { recursive: true });
  fs.symlinkSync(path.resolve(fileURLToPath(new URL("..", import.meta.url))), path.join(profileDir, "node_modules", "dsh-purge"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify({
    name: "dsh-profile-desktop", private: true,
    dependencies: { "dsh-purge": "file:../../../.." },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-purge"] } },
  }));
  const appDir = path.join(root, "resources", "app");
  const boot = await import(pathToFileURL(path.join(appDir, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js")));
  const profile = boot.loadProfileDirectory("verification", profileDir, path.join(appDir, "package.json"), { userLayer: false });
  if (profile.skippedBundles.length) throw new Error(JSON.stringify(profile.skippedBundles));
  const loaderWarnings = [];
  const entries = boot.composeEntries(profile.layers.map((layer) => layer.patches), (message) => loaderWarnings.push(message));
  const pluginEntries = entries.filter((entry) => entry.name === "dsh-purge" || entry.name?.startsWith("dsh-purge/"));
  if (pluginEntries.length !== 4 || pluginEntries.filter((entry) => entry.name === "dsh-purge").length !== 1) {
    throw new Error(`Unexpected plugin composition: ${JSON.stringify(pluginEntries)}`);
  }
  if (loaderWarnings.some((message) => message.includes("dsh-purge"))) throw new Error(JSON.stringify(loaderWarnings));
  const files = core.targetFiles(located.aiBase);
  const targets = [...new Set(Object.values(files).flat().filter(Boolean))];
  for (const file of targets) {
    if (!path.resolve(file).startsWith(root + path.sep)) throw new Error(`Target escaped fixture: ${file}`);
  }
  const baselines = new Map(targets.map((file) => [file, hash(file)]));
  const backup = await core.backupAll(located.aiBase);
  if (backup.errors.length) throw new Error(JSON.stringify(backup.errors));
  const report = await core.applyPatches(located.aiBase, core.ALL_PATCHES, { forApply: true });
  const summary = core.summarizeApplyReport(report);
  const changed = targets.filter((file) => hash(file) !== baselines.get(file));
  const syntaxErrors = [];
  for (const file of changed.filter((file) => /\.(?:js|mjs|cjs)$/.test(file))) {
    const check = spawnSync(savedExe, ["--check", file], { encoding: "utf8", windowsHide: true });
    if (check.status !== 0) syntaxErrors.push({ file: path.relative(root, file), error: check.stderr });
  }
  const revert = await core.revertAll(located.aiBase);
  const mismatches = targets.filter((file) => hash(file) !== baselines.get(file));
  const result = {
    source: { product: original.product, version: original.version, dshVersion: original.dshVersion, sha256: originalHash },
    fixtureRoot: root, targetCount: targets.length, changedFiles: changed.map((file) => path.relative(root, file)),
    loaderComponents: pluginEntries.map((entry) => entry.name),
    patchSummary: { applied: summary.applied, already: summary.already, failed: summary.failed },
    syntaxErrors, revertErrors: revert.errors, restoredBytesExactly: mismatches.length === 0,
    mismatchFiles: mismatches.map((file) => path.relative(root, file)), originalArchiveUnchanged: hash(original.asar) === originalHash,
  };
  fs.writeFileSync(path.join(root, "verification.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (syntaxErrors.length || revert.errors.length || mismatches.length || !result.originalArchiveUnchanged) process.exitCode = 1;
} finally {
  process.execPath = savedExe;
  process.argv = savedArgv;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}

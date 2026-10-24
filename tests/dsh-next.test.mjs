import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { needsDesktopArchiveHandoff } from "../lib/settle-policy.js";
import { detectSurface } from "../lib/surface.js";
import * as desktop from "../lib/desktop.js";
import * as core from "../lib/core.js";
import { readAsarFile, renameAsarAside } from "../lib/extract-asar.js";
import { windowsDesktopPidScript, windowsIndependentPowerShellPlan } from "../lib/desktop-process.js";
import { safeUpdateRef, archiveTarballUrl as tarballUrl } from "../lib/update.js";

// A small real ASAR fixture, including the product and upstream manifests.
function archive(file, members) {
  const header = { files: {} };
  const data = [];
  let offset = 0;
  for (const [member, value] of Object.entries(members)) {
    const parts = member.split("/");
    let node = header;
    for (const part of parts.slice(0, -1)) node = node.files[part] ??= { files: {} };
    const bytes = Buffer.from(value);
    node.files[parts.at(-1)] = { size: bytes.length, offset: String(offset) };
    data.push(bytes);
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const headerBytes = 8 + json.length + (4 - json.length % 4) % 4;
  const prefix = Buffer.alloc(8 + headerBytes);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerBytes, 4);
  prefix.writeUInt32LE(headerBytes - 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([prefix, ...data]));
}

function fixture(version = "2.0.19-next") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-next-"));
  const exe = path.join(root, "DSH NEXT.exe");
  const asar = path.join(root, "resources", "app.asar");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, "profiles", "desktop"), { recursive: true });
  fs.writeFileSync(exe, "fixture; never execute");
  archive(asar, {
    "package.json": JSON.stringify({ name: "dsh-desktop-next", version, main: "lib/main.js" }),
    "node_modules/@deepseek-ai/dsh/package.json": JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.2" }),
    "node_modules/@deepseek-ai/cordis/package.json": JSON.stringify({ name: "@deepseek-ai/cordis", version: "4.0.5" }),
    "node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js": "export const fixture = 'original';\n",
    "node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js": "export const fixture = 'original';\n",
    "lib/main.js": "// fixture main\n",
  });
  return { root, exe, asar, home };
}

async function inHost(f, run) {
  const execPath = process.execPath;
  const argv = process.argv;
  const env = { ...process.env };
  try {
    process.execPath = f.exe;
    process.argv = [f.exe, path.join(f.root, "resources", "app.asar", "lib", "host.js")];
    for (const key of ["DSH_HOME", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"]) process.env[key] = f.home;
    delete process.env.DSH_SURFACE;
    delete process.env.DSH_BASE;
    delete process.env.DSH_DESKTOP_INSTALL;
    core.resetPathMemo();
    return await run();
  } finally {
    process.execPath = execPath;
    process.argv = argv;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    core.resetPathMemo();
    assert.equal(path.dirname(f.root), os.tmpdir());
    assert.ok(path.basename(f.root).startsWith("dsh-purge-next-"));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

test("Next detection preserves Web, official Desktop and explicit surface selection", () => {
  const base = { env: {}, resourcesPath: "", argv: [], parentPort: null };
  assert.equal(detectSurface({ ...base, execPath: path.resolve("DSH NEXT.exe") }), "desktop");
  assert.equal(detectSurface({ ...base, execPath: path.resolve("DSH NEXT") }), "desktop");
  assert.equal(detectSurface({ ...base, execPath: path.resolve("DeepSeek Harness.exe") }), "desktop");
  assert.equal(detectSurface({ ...base, execPath: process.execPath }), "web");
  assert.equal(detectSurface({ ...base, execPath: path.resolve("DSH NEXT/npm/node.exe") }), "web");
  assert.equal(detectSurface({ ...base, execPath: path.resolve("DSH NEXT.exe"), env: { DSH_SURFACE: "web" } }), "web");
  assert.equal(desktop.isOfficialHarnessExecutable(path.resolve("DSH NEXT.exe")), false);
  assert.equal(desktop.isSealedHarnessExecutable(path.resolve("DSH NEXT.exe")), true);
});

test("sealed Next inspection and restart planning are read-only and scoped", async () => {
  const f = fixture();
  await inHost(f, async () => {
    const before = fs.readFileSync(f.asar);
    assert.equal(desktop.inspectNextDesktopInstallation(f.exe).dshVersion, "0.2.1-rc.2");
    assert.equal(desktop.findDesktopAppExecutable(), f.exe);
    assert.equal(core.sealedAsarHandoff().exe, f.exe);
    assert.equal(core.findAiBase(), null);
    assert.deepEqual(core.enumeratePatchAiBases(), []);
    assert.equal(desktop.restartPlan().execPath, f.exe);
    assert.equal(desktop.desktopRestartChoice({ exe: f.exe, platform: "win32", asarSealed: true }), "asar-swap");
    assert.equal(desktop.desktopRestartChoice({ exe: f.exe, platform: "win32", asarSealed: false }), "helper");
    assert.equal(desktop.desktopRestartChoice({ exe: f.exe, openBrowser: false }), "skip");
    assert.ok(fs.readFileSync(f.asar).equals(before));
    assert.equal(fs.existsSync(desktop.appDirForExecutable(f.exe)), false);
  });
});

test("unknown Next releases are rejected before extraction", async () => {
  const f = fixture("2.0.20-next");
  await inHost(f, async () => {
    const before = fs.readFileSync(f.asar);
    await assert.rejects(core.openSealedDesktopHost({ forApply: true }), /compatibility requires/);
    assert.equal(fs.existsSync(desktop.appDirForExecutable(f.exe)), false);
    assert.ok(fs.readFileSync(f.asar).equals(before));
    process.env.DSH_SURFACE = "web";
    assert.deepEqual(await core.resolveOfficialAiBase(null), { aiBase: null, handoff: null });
  });
});

test("isolated extraction, patch backup, repeat application and byte-exact revert", async () => {
  const f = fixture();
  await inHost(f, async () => {
    const before = fs.readFileSync(f.asar);
    const result = await core.openSealedDesktopHost({ forApply: true });
    assert.equal(result.extracted, true);
    const aiBase = path.join(f.root, "resources", "app", "node_modules", "@deepseek-ai");
    assert.equal(result.aiBase, aiBase);
    core.resetPathMemo();
    const otherBase = path.join(f.home, "profiles", "web", "node_modules", "@deepseek-ai");
    fs.mkdirSync(path.join(otherBase, "dsh-agent-instructions", "lib"), { recursive: true });
    process.env.DSH_BASE = otherBase;
    assert.deepEqual(core.enumeratePatchAiBases(), [aiBase]);
    assert.equal(desktop.isInsideDesktopInstall(aiBase), true);
    const target = path.join(aiBase, "dsh-agent-instructions", "lib", "index.js");
    const original = fs.readFileSync(target);
    const patch = { id: 9991, name: "fixture", file: "agent-instructions", replacements: [{ pattern: "'original'", replace: "'modified'; // dsh-purge fixture" }], markers: ["'modified'"] };
    await core.backupAll(aiBase);
    const first = await core.applyPatches(aiBase, [patch]);
    assert.equal(first[0].status, "applied");
    assert.match(fs.readFileSync(target, "utf8"), /modified/);
    assert.ok(fs.readFileSync(target + ".dshpurge.bak").equals(original));
    assert.equal((await core.applyPatches(aiBase, [patch]))[0].status, "already");
    const reverted = await core.revertAll(aiBase);
    assert.equal(reverted.errors.length, 0);
    assert.ok(fs.readFileSync(target).equals(original), JSON.stringify({ reverted, target, text: fs.readFileSync(target, "utf8"), backupExists: fs.existsSync(target + ".dshpurge.bak") }));
    assert.ok(fs.readFileSync(f.asar).equals(before));
    // Exercise archive handoff only in this fixture, without any process operations.
    assert.equal(renameAsarAside(f.asar).renamed, true);
    assert.equal(desktop.inspectNextDesktopInstallation(f.exe).sealed, false);
    assert.equal(desktop.restartPlan().execPath, f.exe);
    assert.ok(fs.readFileSync(f.asar + ".bak").equals(before));
  });
});

test("archive inspection bounds and member traversal are checked", async () => {
  const f = fixture();
  await inHost(f, async () => {
    assert.throws(() => readAsarFile(f.asar, "../package.json"), /invalid/);
    assert.throws(() => readAsarFile(f.asar, "package.json", 1), /size invalid/);
    assert.throws(() => readAsarFile(f.asar, "missing.json"), /unavailable/);
  });
});

test("restart process query quotes literal paths and never uses broad image matching", () => {
  const script = windowsDesktopPidScript("D:\\Apps\\Someone's app\\DSH NEXT.exe");
  assert.ok(script.includes("Someone''s app"));
  assert.match(script, /ExecutablePath -ieq \$target/);
  assert.doesNotMatch(script, /Stop-Process|taskkill|Start-Process| -like /);
});

test("fork update URL retains the compatibility branch", () => {
  assert.equal(safeUpdateRef("compat/dsh-next"), "compat/dsh-next");
  assert.equal(safeUpdateRef("../other"), "");
  assert.match(tarballUrl("compat/dsh-next"), /yf96\/dsh-purge\/tar\.gz\/refs\/heads\/compat%2Fdsh-next$/);
});

test("archive handoff remains visible after a Host-only restart but not before application", () => {
  const written = { surface: "desktop", sealed: true, aiBase: "owned-app/node_modules/@deepseek-ai", hasBackup: true, hostWritten: true };
  assert.equal(needsDesktopArchiveHandoff(written), true);
  for (const field of ["sealed", "aiBase", "hasBackup", "hostWritten"]) {
    assert.equal(needsDesktopArchiveHandoff({ ...written, [field]: false }), false);
  }
  assert.equal(needsDesktopArchiveHandoff({ ...written, surface: "web" }), false);
});

test("Next handoff delegates full application shutdown without requesting a Host-only restart", { skip: process.platform !== "win32" }, async () => {
  const f = fixture();
  await inHost(f, async () => {
    let restarts = 0;
    const launches = [];
    const child = new EventEmitter();
    child.unref = () => {};
    child.pid = 123456;
    const ctx = { get: () => ({ requestRestart: () => { restarts++; } }) };
    const result = desktop.scheduleAsarSwapRestart({ exe: f.exe, asar: f.asar, exit: true, ctx }, {
      scriptDir: f.root, log: () => {},
      spawn: (...args) => { launches.push(args); return child; },
    });
    assert.equal(result.scheduled, true);
    assert.equal(launches.length, 1);
    assert.match(launches[0][0], /WindowsPowerShell.*powershell\.exe$/);
    assert.equal(launches[0][2].detached, false);
    assert.equal(launches[0][2].windowsHide, true);
    const bootstrap = Buffer.from(launches[0][1].at(-1), "base64").toString("utf16le");
    assert.match(bootstrap, /Start-Process.*-WindowStyle Hidden/);
    assert.equal(restarts, 0);
    assert.equal(fs.existsSync(f.asar), true);
  });
});

test("Next Windows helper executes hidden and survives its Node parent exiting", { skip: process.platform !== "win32" }, async () => {
  const f = fixture();
  try {
    const scriptDir = path.join(f.root, "中文 user's helper");
    fs.mkdirSync(scriptDir);
    const marker = path.join(scriptDir, "survived.txt");
    const parent = path.join(f.root, "parent.mjs");
    const desktopUrl = pathToFileURL(path.resolve("lib/desktop.js")).href;
    fs.writeFileSync(parent, `
      import fs from 'node:fs';
      import path from 'node:path';
      import {spawn} from 'node:child_process';
      import {scheduleAsarSwapRestart} from ${JSON.stringify(desktopUrl)};
      let child;
      scheduleAsarSwapRestart(${JSON.stringify({ exe: f.exe, asar: f.asar, exit: true })}, {
        scriptDir: ${JSON.stringify(scriptDir)}, log: () => {},
        spawn: (file, args, options) => {
          // Replace the generated destructive helper before it can execute.
          const script = path.join(${JSON.stringify(scriptDir)}, 'dsh-purge-asar-swap-' + process.pid + '.ps1');
          const marker = ${JSON.stringify(marker)};
          fs.writeFileSync(script, "\\uFEFFparam([int]$WaitPid,[string]$AsarPath,[string]$ExePath)\\r\\nStart-Sleep -Seconds 1\\r\\n[IO.File]::WriteAllText('" + marker.replaceAll("'", "''") + "','survived')\\r\\n", 'utf8');
          child = spawn(file, args, options);
          return child;
        }
      });
      child.ref();
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      if (code !== 0) throw new Error('Launcher exit ' + code);
    `, "utf8");
    execFileSync(process.execPath, [parent], { windowsHide: true, timeout: 15000 });
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(fs.existsSync(marker), true, "hidden helper must execute after its parent exits");
    assert.equal(fs.readFileSync(marker, "utf8"), "survived");
    assert.equal(fs.existsSync(f.asar), true);
  } finally {
    assert.equal(path.dirname(f.root), os.tmpdir());
    assert.ok(path.basename(f.root).startsWith("dsh-purge-next-"));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

for (const failure of [false, true]) {
  test(`Windows archive swap ${failure ? "does not launch after a nonterminating move error" : "launches only after the original archive is preserved"}`, { skip: process.platform !== "win32" }, async () => {
    const f = fixture();
    await inHost(f, async () => {
      const script = path.join(f.root, "swap.ps1");
      const resultFile = path.join(f.root, "result.json");
      fs.writeFileSync(script, "\uFEFF" + desktop.asarSwapScript(), "utf8");
      const literal = (value) => "'" + value.replace(/'/g, "''") + "'";
      const ps = [
        "$ProgressPreference='SilentlyContinue'",
        "function Get-CimInstance { return @() }",
        "function Get-Process { return $null }",
        "function Stop-Process { throw 'Process operations forbidden in this test' }",
        "function Start-Sleep {}",
        "function Start-Process { [CmdletBinding()]param([string]$FilePath) $script:launched=$true }",
        ...(failure ? ["function Move-Item { [CmdletBinding()]param([string]$LiteralPath,[string]$Destination,[switch]$Force) Write-Error 'Simulated archive move failure' }"] : []),
        `. ${literal(script)} -WaitPid 2147483647 -AsarPath ${literal(f.asar)} -ExePath ${literal(f.exe)}`,
        `[PSCustomObject]@{OriginalExists=(Test-Path -LiteralPath ${literal(f.asar)});BackupExists=(Test-Path -LiteralPath ${literal(f.asar + ".bak")});LaunchRequested=[bool]$script:launched}|ConvertTo-Json -Compress|Set-Content -LiteralPath ${literal(resultFile)} -Encoding utf8`,
      ].join("\n");
      const runner = path.join(f.root, "isolated-runner.ps1");
      fs.writeFileSync(runner, "\uFEFF" + ps, "utf8");
      const launch = windowsIndependentPowerShellPlan(runner, []);
      execFileSync(launch.file, launch.args, { ...launch.options, timeout: 15000 });
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(resultFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
      const result = JSON.parse(fs.readFileSync(resultFile, "utf8").replace(/^\uFEFF/, "").trim());
      assert.equal(result.LaunchRequested, !failure);
      assert.equal(result.BackupExists, !failure);
      assert.equal(result.OriginalExists, failure);
      const log = fs.readFileSync(script + ".log", "utf8");
      assert.match(log, failure ? /handoff failed; client was not relaunched/ : /archive moved to/);
    });
  });
}

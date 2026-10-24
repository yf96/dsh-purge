import path from "node:path";

/** Read-only process query scoped to the selected desktop executable, including paths with quotes. */
export function windowsDesktopPidScript(exe) {
  const literal = String(exe || "").replace(/'/g, "''");
  if (!literal) throw new Error("desktop executable required");
  return `$ProgressPreference = 'SilentlyContinue'; $target = '${literal}'; Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $target } | ForEach-Object { $_.ProcessId }`;
}
/** PowerShell 5.1 can exit without executing when Node uses DETACHED_PROCESS.
 * A short attached launcher asks Windows to create a hidden, independent helper.
 * UTF-16 encoded commands preserve literal Unicode paths through both launches.
 */
export function windowsIndependentPowerShellPlan(script, parameters) {
  const literal = value => "'" + String(value).replace(/'/g, "''") + "'";
  const encode = value => Buffer.from(value, "utf16le").toString("base64");
  const file = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const argumentsText = parameters.map((value, index) => {
    if (index % 2) return literal(value);
    if (!/^-[A-Za-z]+$/.test(value)) throw new Error("invalid PowerShell parameter name");
    return value;
  }).join(" ");
  const invocation = `& ${literal(script)} ${argumentsText}`;
  const launchLog = literal(script + ".launch.log");
  const command = [
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'",
    `function Write-LaunchLog([string]$Text) { Add-Content -LiteralPath ${launchLog} -Value ((Get-Date).ToString('o')+' '+$Text) -Encoding utf8 -ErrorAction SilentlyContinue }`,
    `try { $helper=Start-Process -FilePath ${literal(file)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encode(invocation)}') -WindowStyle Hidden -PassThru -ErrorAction Stop; Write-LaunchLog ('helper pid='+$helper.Id) } catch { Write-LaunchLog ('launch failed: '+$_.Exception.Message); exit 1 }`,
  ].join("\n");
  return {
    file,
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encode(command)],
    options: { detached: false, stdio: "ignore", windowsHide: true, shell: false },
  };
}

/** Read-only process query scoped to the selected desktop executable, including paths with quotes. */
export function windowsDesktopPidScript(exe) {
  const literal = String(exe || "").replace(/'/g, "''");
  if (!literal) throw new Error("desktop executable required");
  return `$ProgressPreference = 'SilentlyContinue'; $target = '${literal}'; Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $target } | ForEach-Object { $_.ProcessId }`;
}

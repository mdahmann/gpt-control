const BASE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
]);

function copyAllowedEnvironment(env, allow) {
  const output = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && (BASE_ENV_KEYS.has(key) || allow(key))) output[key] = value;
  }
  return output;
}

/** Environment passed to an external protocol-v2 browser driver. */
export function sanitizeBrowserDriverEnv(env) {
  return copyAllowedEnvironment(env, (key) => key.startsWith("GPT_CONTROL_DRIVER_") || key.startsWith("CHROME_BRIDGE_"));
}

/** Environment passed to the installed GPT-Control MCP broker. */
export function sanitizeGptControlBrokerEnv(env) {
  return copyAllowedEnvironment(env, (key) => key.startsWith("GPT_CONTROL_") || key === "CODEX_THREAD_ID");
}

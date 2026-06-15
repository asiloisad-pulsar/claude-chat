/** @babel */

/**
 * Centralized configuration helper for claude-chat package.
 * Eliminates repeated atom.config.get() calls with fallback handling.
 */

const CONFIG_PREFIX = "claude-chat";

/**
 * Get a config value with optional default
 */
function get(key, defaultValue) {
  const value = atom.config.get(`${CONFIG_PREFIX}.${key}`);
  return value ?? defaultValue;
}

/**
 * Set a config value
 */
function set(key, value) {
  atom.config.set(`${CONFIG_PREFIX}.${key}`, value);
}

/**
 * Observe config changes
 */
function observe(key, callback) {
  return atom.config.observe(`${CONFIG_PREFIX}.${key}`, callback);
}

/**
 * Config accessor object with typed getters
 */
export const Config = {
  // Raw access
  get,
  set,
  observe,

  // Panel settings
  panelPosition: () => get("panelPosition", "right"),

  // Claude CLI settings
  claudePath: () => get("claudePath", "claude"),
  model: () => get("model", "sonnet"),
  customModel: () => get("customModel", ""),
  customBaseUrl: () => get("customBaseUrl", ""),

  // Permission mode
  permissionMode: () => get("permissionMode", "default"),

  // All valid permission modes
  permissionModes: [
    { value: "default", label: "Ask permissions", icon: "shield", key: "1" },
    { value: "acceptEdits", label: "Accept edits", icon: "pencil", key: "2" },
    { value: "plan", label: "Plan mode", icon: "list-unordered", key: "3" },
    { value: "auto", label: "Auto mode", icon: "zap", key: "4" },
  ],

  // Cycleable model options (excludes "custom" which needs its own field)
  models: [
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
    { value: "haiku", label: "Haiku" },
    { value: "fable", label: "Fable" },
  ],

  // Effort mode
  effortMode: () => get("effortMode", "medium"),

  // All valid effort modes (ordered low→high)
  effortModes: [
    { value: "low", label: "Low", dots: 1 },
    { value: "medium", label: "Medium", dots: 2 },
    { value: "high", label: "High", dots: 3 },
    { value: "xhigh", label: "XHigh", dots: 4 },
    { value: "max", label: "Max", dots: 5 },
  ],
};

export default Config;

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

function customModelsRaw() {
  return get("customModels", "") || get("customModel", "");
}

function parseCustomModels(raw) {
  const seen = new Set();
  return String(raw || "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [modelPart, ...descriptionParts] = entry.split("#").map((part) => part.trim());
      const [valuePart, labelPart] = modelPart.split("|").map((part) => part.trim());
      const value = valuePart;
      const description = descriptionParts.join("#").trim();
      return {
        value,
        label: labelPart || value,
        description: description || "Custom model",
        custom: true,
      };
    })
    .filter((model) => {
      if (!model.value) return false;
      if (seen.has(model.value)) return false;
      seen.add(model.value);
      return true;
    });
}

function parseModelEntry(raw, fallbackDescription = "Configured model") {
  return parseCustomModels(raw).map((model) =>
    model.description === "Custom model" ? { ...model, description: fallbackDescription } : model,
  )[0];
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
  model: () => parseModelEntry(get("model", "sonnet"), "Default model")?.value || "sonnet",
  defaultModel: () => parseModelEntry(get("model", "sonnet"), "Default model"),
  customModelsRaw,
  customModels: () => parseCustomModels(customModelsRaw()),
  customModel: () => customModelsRaw(),
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

  // Built-in Claude CLI model aliases shown by the model picker.
  models: [
    { value: "sonnet", label: "Sonnet", description: "Newest Sonnet, balanced default" },
    { value: "opus", label: "Opus", description: "Newest Opus, most capable" },
    { value: "haiku", label: "Haiku", description: "Newest Haiku, fast and lightweight" },
    { value: "fable", label: "Fable", description: "Newest Fable, creative writing" },
  ],

  modelOptions() {
    const options = [...this.models, ...this.customModels()];
    const defaultModel = this.defaultModel();
    if (defaultModel && !options.some((model) => model.value === defaultModel.value)) {
      options.push(defaultModel);
    }
    return options;
  },

  findModel(value) {
    const modelValue = value || "sonnet";
    return (
      this.modelOptions().find((model) => model.value === modelValue) || {
        value: modelValue,
        label: modelValue,
        description: "Configured model",
        custom: true,
      }
    );
  },

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

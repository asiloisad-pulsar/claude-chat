/** @babel */
/** @jsx h */

import { h, render } from "preact";
import { useRef, useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { CompositeDisposable, Emitter, Disposable, TextEditor } from "atom";
import { clipboard } from "electron";
import ClaudeConnection from "./claude-connection";
import Config from "./utils/config";
import { renderMessages, renderStreamingMessage, renderWelcomePage } from "./message-renderer";
import { saveSession, saveSessionSync, deleteSession } from "./session-store";
import { createLogger } from "./utils/log";

const log = createLogger("ChatPanel");

const URI_PREFIX = "atom://claude-chat";

const MODE_LABELS = {
  acceptEdits: "Accept Edits",
  auto: "Auto",
  bypassPermissions: "Bypass",
  plan: "Plan",
};

const SILENT_SYSTEM_SUBTYPES = new Set([
  "init",
  "compact_boundary",
  "status",
  "thinking_tokens",
]);

function isSilentSystemMessage(message) {
  return message?.role === "system" && SILENT_SYSTEM_SUBTYPES.has(message.subtype);
}

function tokenCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function hasTokenUsage(usage) {
  return usage?.input != null && usage?.output != null;
}

function formatTokenCount(value) {
  const count = tokenCount(value);
  if (count >= 1000000) {
    const millions = count / 1000000;
    return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, "") : Math.round(millions)}M`;
  }
  if (count >= 1000) {
    const thousands = count / 1000;
    return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`;
  }
  return count.toLocaleString();
}

/**
 * Extract displayable suggestion buttons from permission_suggestions.
 * Returns array of { label, suggestions }, each is a subset to send as updatedPermissions.
 */
function getSuggestionButtons(suggestions) {
  if (!suggestions?.length) return [];
  const buttons = [];
  const allowRule = suggestions.filter((s) => s.type === "addRules" && s.behavior === "allow");
  if (allowRule.length) {
    buttons.push({
      label: "Always Allow",
      detail: allowRule.map(formatPermissionUpdate).join("\n"),
      permissions: allowRule,
    });
  }
  const modeChange = suggestions.find((s) => s.type === "setMode" && MODE_LABELS[s.mode]);
  if (modeChange) {
    buttons.push({
      label:
        modeChange.mode === "bypassPermissions"
          ? "Restart in Bypass"
          : MODE_LABELS[modeChange.mode] + " Mode",
      detail: formatPermissionUpdate(modeChange),
      mode: modeChange.mode,
      permissions: modeChange.mode === "bypassPermissions" ? [] : [modeChange],
    });
  }
  return buttons;
}

function formatPermissionUpdate(update) {
  if (!update) return "";

  if (update.type === "setMode" && MODE_LABELS[update.mode]) {
    return `Switch permission mode to ${MODE_LABELS[update.mode]}.`;
  }

  if (update.type === "addRules") {
    const behavior = update.behavior || "allow";
    const rules = update.rules || update.rule || update.permissions || [];
    const values = Array.isArray(rules) ? rules : [rules];
    const summary = formatPermissionRules(values, behavior);
    return summary || `Add ${behavior} rule.`;
  }

  return JSON.stringify(update);
}

function formatPermissionRules(rules, behavior) {
  const groups = [];
  const unknownRules = [];

  for (const rule of rules.filter(Boolean)) {
    if (typeof rule === "string") {
      unknownRules.push(rule);
      continue;
    }

    if (rule.toolName && rule.ruleContent) {
      let group = groups.find((item) => item.toolName === rule.toolName);
      if (!group) {
        group = { toolName: rule.toolName, rules: [] };
        groups.push(group);
      }
      group.rules.push(rule.ruleContent);
      continue;
    }

    unknownRules.push(JSON.stringify(rule));
  }

  const action = behavior === "allow" ? "Allow" : `Add ${behavior} rule for`;
  const lines = groups.map((group) =>
    [`${action} ${group.toolName}:`, ...group.rules.map((rule) => `  ${rule}`)].join("\n"),
  );

  if (unknownRules.length) {
    lines.push(`Add ${behavior} rule:\n${unknownRules.map((rule) => `  ${rule}`).join("\n")}`);
  }

  return lines.join("\n");
}

function isShellCommandTool(toolName) {
  return ["Bash", "PowerShell", "Powershell", "powershell", "ShellCommand", "shell_command"].includes(
    toolName,
  );
}

function dataUrlToBase64(dataUrl) {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

function imageToContentBlock(image) {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: image.mimeType || "image/png",
      data: image.base64 || dataUrlToBase64(image.dataUrl || ""),
    },
  };
}

function getPastedImageLabel(image, index = 0) {
  return image?.name || `Pasted image ${index + 1}`;
}

export default class ChatPanel {
  static URI_PREFIX = URI_PREFIX;

  constructor(props = {}) {
    log.debug("Creating ChatPanel", {
      sessionId: props.sessionId,
      messagesCount: props.messages?.length || 0,
    });
    this.props = props;
    this.imageEditor = props.imageEditor || null;
    this.sessionId = props.sessionId || null;

    // Ensure all tool messages have an id (for sessions saved before id was added)
    const initialMessages = props.messages || [];
    let idCounter = 0;
    for (const msg of initialMessages) {
      if (msg.role === "tool" && !msg.id) {
        msg.id = `legacy-${idCounter++}`;
      }
    }

    // Session metadata (not reactive — never read in render tree)
    this.projectPaths = props.projectPaths || atom.project.getPaths();
    this.createdAt = props.createdAt || new Date().toISOString();
    this.previousPermissionMode = null;

    // Internal streaming accumulators — never read by render tree directly
    this.pendingDelta = "";
    this.pendingThinkingDelta = "";
    this.updateScheduled = false;
    this.nextQueuedMessageId = 0;
    this.stopRequested = false;
    this.activeCompactSystemMessageId = null;

    // All reactive state as signals
    this.signals = {
      // High-frequency streaming (surgical DOM updates via StreamingArea)
      currentText: signal(""),
      currentThinking: signal(""),
      isLoading: signal(false),
      // Lower-frequency UI state
      messages: signal(initialMessages),
      pendingPermission: signal(null),
      pendingAnswers: signal(null),
      pendingQuestionSelections: signal(null),
      attachContext: signal([]),
      pastedImages: signal([]),
      permissionMode: signal(props.permissionMode || Config.permissionMode()),
      effortMode: signal(props.effortMode || Config.effortMode()),
      model: signal(Config.model()),
      tokenUsage: signal(props.tokenUsage || { input: 0, output: 0 }),
      tokenUsageAvailable: signal(!props.tokenUsage || hasTokenUsage(props.tokenUsage)),
      defaultToolCollapsed: signal(null),
      hasEditorInput: signal(false),
      queuedMessages: signal([]),
    };

    // Create connection
    this.connection = new ClaudeConnection({
      sessionId: this.sessionId,
      permissionMode: this.signals.permissionMode.value,
      effortMode: this.signals.effortMode.value,
      model: this.signals.model.value,
      worktree: props.worktree ?? null,
    });

    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();

    // Tool handlers for renderers
    this.toolHandlers = {
      toggle: (id) => this.toggleToolCollapse(id),
      openFile: (filePath, line) => this.handleOpenFile(filePath, line),
    };

    this.tooltipDisposables = new CompositeDisposable();

    // Save session synchronously on window reload/close
    this._beforeUnload = () => this.saveCurrentSessionSync();
    window.addEventListener("beforeunload", this._beforeUnload);

    // DOM refs populated by ChatApp's useEffect after each render
    this._refs = {};
    // Ref to Atom TextEditor DOM element — set in setupEditor, appended in ChatApp useEffect
    this._promptEditorElementRef = { current: null };
    // Flag: scroll to bottom after the first render's effects fire
    this._needsInitialScroll = true;

    // Mount Preact tree into the host element
    this.element = document.createElement("div");
    this.element.classList.add("claude-chat-host");
    render(
      <ChatApp
        signals={this.signals}
        callbacks={this._buildCallbacks()}
        promptEditorElementRef={this._promptEditorElementRef}
      />,
      this.element,
    );

    this.setupConnection();
    this.setupEditor();
    this.setupImagePaste();
    this.setupCommands();
    this.setupPaneObserver();
  }

  // ============================================================================
  // Callbacks object (stable reference passed to ChatApp)
  // ============================================================================

  _buildCallbacks() {
    return {
      toolHandlers: this.toolHandlers,
      handleSend: () => this.handleSend(),
      handleStop: () => this.handleStop(),
      handlePermissionModeChange: (mode) => this.handlePermissionModeChange(mode),
      handlePermissionAccept: (perms) => this.handlePermissionAccept(perms),
      handlePermissionAcceptEdited: () => this.handlePermissionAcceptEdited(),
      handlePermissionDeny: () => this.handlePermissionDeny(),
      handlePermissionDenyWithReason: () => this.handlePermissionDenyWithReason(),
      handleToggleBypassMode: () => this.toggleBypassMode(),
      handleQuestionAnswer: (q, a) => this.handleQuestionAnswer(q, a),
      handleQuestionMultiToggle: (q, a) => this.handleQuestionMultiToggle(q, a),
      handleQuestionSubmit: (q) => this.handleQuestionSubmit(q),
      handleQuestionAnswerOther: (q) => this.handleQuestionAnswerOther(q),
      handleQueuedMessageDelete: (id) => this.deleteQueuedMessage(id),
      handleQueuedMessageEdit: (id) => this.moveQueuedMessageToPrompt(id),
      handleQueuedMessageReorder: (draggedId, targetId, position) =>
        this.reorderQueuedMessage(draggedId, targetId, position),
      handleQueuedMessageSteer: (id) => this.steerQueuedMessage(id),
      openPastedImage: (image) => this.openPastedImage(image),
      clearAttachContext: () => this.clearAttachContext(),
      removeAttachContext: (index) => this.removeAttachContext(index),
      removePastedImage: (index) => this.removePastedImage(index),
      cycleEffortMode: () => this.cycleEffortMode(),
      cycleModel: () => this.cycleModel(),
      onRefsReady: (refs) => {
        this._refs = refs;
        this.updateTooltips();
        if (this._needsInitialScroll) {
          this._needsInitialScroll = false;
          this.scrollToBottom();
        }
      },
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Add a message to the messages signal (immutable update)
   */
  addMessage(role, content, extras = {}) {
    const message = { role, content, timestamp: new Date().toISOString(), ...extras };
    this.signals.messages.value = [...this.signals.messages.value, message];
    return message;
  }

  async openPastedImage(image) {
    if (!image?.dataUrl) return;

    let service =
      this.imageEditor || atom.packages.getActivePackage("image-editor")?.mainModule;
    if (!service?.openFromDataUrl) {
      try {
        service = (await atom.packages.activatePackage("image-editor"))?.mainModule;
      } catch {}
    }
    if (service?.openFromDataUrl) {
      atom.workspace.getCenter().getActivePane().activate();
      service.openFromDataUrl(image.dataUrl, image.name || "Pasted image");
      return;
    }

    atom.notifications.addWarning("Claude Chat: image-editor is not available", {
      description: "Enable the image-editor package to preview pasted images.",
      dismissable: true,
    });
  }

  setImageEditorService(service) {
    this.imageEditor = service;
  }

  /**
   * Finalize accumulated thinking as a message.
   * Merges into the previous thinking message if it's the last one.
   */
  finalizeThinking() {
    const thinking = this.signals.currentThinking.value;
    if (!thinking) return;
    const msgs = this.signals.messages.value;
    const last = msgs[msgs.length - 1];
    if (last?.role === "thinking") {
      const newMsgs = [...msgs];
      newMsgs[newMsgs.length - 1] = { ...last, content: last.content + thinking };
      this.signals.messages.value = newMsgs;
    } else {
      this.signals.messages.value = [
        ...msgs,
        {
          role: "thinking",
          content: thinking,
          id: `thinking-${Date.now()}`,
          collapsed: false,
          timestamp: new Date().toISOString(),
        },
      ];
    }
    const streamingEl = this.element.querySelector(".thinking-streaming .thinking-content");
    const wasAtBottom = streamingEl
      ? streamingEl.scrollHeight - streamingEl.scrollTop - streamingEl.clientHeight < 10
      : true;
    this.signals.currentThinking.value = "";
    if (wasAtBottom) {
      queueMicrotask(() => {
        const els = this.element.querySelectorAll(".message-thinking .thinking-content");
        const el = els[els.length - 1];
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }

  /**
   * Disconnect the CLI process.
   */
  disconnect() {
    if (this.connection.isRunning()) {
      this.connection.kill();
    }
  }

  /**
   * Disconnect once the current turn finishes. If no turn is in flight,
   * disconnect immediately. The flag is drained in the `result` and `exit`
   * handlers in setupConnection().
   */
  queueDisconnect() {
    if (!this.connection.isRunning()) {
      this.pendingDisconnect = false;
      return;
    }
    if (this.signals.isLoading.value) {
      this.pendingDisconnect = true;
      atom.notifications.addInfo("Claude Chat: disconnect queued", {
        description: "The CLI process will be stopped after the current turn finishes.",
      });
    } else {
      this.pendingDisconnect = false;
      this.connection.kill();
    }
  }

  /**
   * Fork the current session: branch off a copy under a new session ID. The
   * existing transcript stays; the next message resumes the forked copy via
   * `--resume <id> --fork-session`, and the new ID is captured from the CLI.
   */
  forkSession() {
    if (!this.sessionId) {
      atom.notifications.addWarning("Claude Chat: nothing to fork", {
        description: "Start a conversation before forking the session.",
      });
      return;
    }

    if (this.connection.isRunning()) {
      this.connection.kill();
    }
    this.connection.destroy();
    this.connection = new ClaudeConnection({
      sessionId: this.sessionId,
      permissionMode: this.signals.permissionMode.value,
      effortMode: this.signals.effortMode.value,
      model: this.signals.model.value,
      forkSession: true,
    });
    this.setupConnection();

    atom.notifications.addInfo("Claude Chat: session forked", {
      description: "The next message will branch off a copy with a new session ID.",
    });
  }

  /**
   * Recreate the connection with current settings.
   */
  recreateConnection() {
    if (this.connection.isRunning()) {
      this.connection.kill();
    }
    this.connection.destroy();
    this.connection = new ClaudeConnection({
      sessionId: this.sessionId,
      permissionMode: this.signals.permissionMode.value,
      effortMode: this.signals.effortMode.value,
      model: this.signals.model.value,
    });
    this.setupConnection();
  }

  async toggleBypassMode() {
    const isBypassMode = this.signals.permissionMode.value === "bypassPermissions";
    const configuredMode = Config.permissionMode();
    const nextMode = isBypassMode
      ? this.previousPermissionMode ||
        (configuredMode === "bypassPermissions" ? "default" : configuredMode)
      : "bypassPermissions";

    if (this.connection.isRunning()) {
      this.handleStop();
    }

    await this.saveCurrentSession();

    if (!isBypassMode) {
      this.previousPermissionMode =
        this.signals.permissionMode.value === "bypassPermissions"
          ? configuredMode
          : this.signals.permissionMode.value;
      if (this.previousPermissionMode === "bypassPermissions") {
        this.previousPermissionMode = "default";
      }
    }

    this.signals.permissionMode.value = nextMode;
    this.recreateConnection();
    this.signals.pendingPermission.value = null;
    this.signals.pendingAnswers.value = null;
    this.signals.pendingQuestionSelections.value = null;

    const message = isBypassMode
      ? `Claude Chat will restart in ${nextMode} permission mode.`
      : "Claude Chat will restart in bypass permissions mode.";
    const options = {
      detail: isBypassMode
        ? "The current Claude process was disconnected. Permission mode buttons are enabled again."
        : "The current Claude process was disconnected. The next message will start Claude with " +
          "--permission-mode bypassPermissions. Use this only in an isolated environment.",
      dismissable: true,
    };

    if (isBypassMode) {
      atom.notifications.addInfo(message, options);
    } else {
      atom.notifications.addWarning(message, options);
    }
  }

  // ============================================================================
  // Tooltips
  // ============================================================================

  updateTooltips() {
    this.tooltipDisposables.dispose();
    this.tooltipDisposables = new CompositeDisposable();

    // Permission buttons with keyboard shortcuts
    Config.permissionModes.forEach((mode) => {
      const el = this._refs.permissionBtns?.[`permission-${mode.value}`];
      if (el) {
        this.tooltipDisposables.add(
          atom.tooltips.add(el, {
            title: `${mode.label} <span class="keystroke">Ctrl+${mode.key}</span>`,
            html: true,
          }),
        );
      }
    });

    // Effort mode indicator
    if (this._refs.effortMode) {
      const current =
        Config.effortModes.find((m) => m.value === this.signals.effortMode.value) ||
        Config.effortModes[1];
      this.tooltipDisposables.add(
        atom.tooltips.add(this._refs.effortMode, {
          title: `Effort: ${current.label} (click to cycle)`,
        }),
      );
    }

    // Model selector
    if (this._refs.modelBtn) {
      const m = this.signals.model.value;
      const known = Config.models.find((x) => x.value === m);
      const label = known ? known.label : m === "custom" ? Config.customModel() || "Custom" : m;
      this.tooltipDisposables.add(
        atom.tooltips.add(this._refs.modelBtn, {
          title: `Model: ${label} (click to cycle, restarts process)`,
        }),
      );
    }

    // Send/Stop button
    if (this._refs.sendBtn) {
      this.tooltipDisposables.add(
        atom.tooltips.add(this._refs.sendBtn, {
          title: 'Send message <span class="keystroke">Enter</span>',
          html: true,
        }),
      );
    }
    if (this._refs.stopBtn) {
      this.tooltipDisposables.add(
        atom.tooltips.add(this._refs.stopBtn, { title: "Stop generation" }),
      );
    }

    // Elements with data-tooltip attribute
    const tooltipElements = this.element.querySelectorAll("[data-tooltip]");
    tooltipElements.forEach((el) => {
      const title = el.getAttribute("data-tooltip");
      if (title) {
        this.tooltipDisposables.add(atom.tooltips.add(el, { title }));
      }
    });
  }

  // ============================================================================
  // Connection Setup
  // ============================================================================

  setupConnection() {
    log.debug("Setting up connection handlers");

    this.disposables.add(
      this.connection.on("session", (id) => {
        log.debug("Session received", id);
        this.sessionId = id;
      }),
    );

    this.disposables.add(
      this.connection.on("session-expired", async () => {
        log.debug("Session expired", this.sessionId);
        if (this.sessionId) {
          await deleteSession(this.sessionId);
        }
        this.sessionId = null;
        this.signals.isLoading.value = false;
        atom.notifications.addWarning("Session expired", {
          description: "The conversation was not found. Starting fresh.",
          dismissable: true,
        });
      }),
    );

    // Streaming text — throttled via requestAnimationFrame
    this.disposables.add(
      this.connection.on("delta", (text) => {
        if (!this.signals.isLoading.value) return;
        if (!atom.config.get("claude-chat.streamingText")) return;
        this.pendingDelta += text;
        this.scheduleUpdate();
      }),
    );

    this.disposables.add(
      this.connection.on("thinking-delta", (text) => {
        if (!this.signals.isLoading.value) return;
        this.pendingThinkingDelta += text;
        this.scheduleUpdate();
      }),
    );

    // Tool use
    this.disposables.add(
      this.connection.on("tool-use", ({ id, name, input }) => {
        // Deduplicate: assistant events replay all blocks cumulatively
        if (this.signals.messages.value.some((m) => m.role === "tool" && m.id === id)) return;

        // Flush buffered deltas and finalize pending content before adding tool
        if (this.pendingThinkingDelta) {
          this.signals.currentThinking.value += this.pendingThinkingDelta;
          this.pendingThinkingDelta = "";
        }
        this.finalizeThinking();
        if (this.pendingDelta) {
          this.signals.currentText.value += this.pendingDelta;
          this.pendingDelta = "";
        }
        const currentText = this.signals.currentText.value;
        if (currentText) {
          this.addMessage("assistant", currentText);
          this.signals.currentText.value = "";
        }

        const collapsed =
          this.signals.defaultToolCollapsed.value !== null
            ? this.signals.defaultToolCollapsed.value
            : name !== "TodoWrite" && name !== "ToolSearch";

        const wasNearBottom = this.isNearBottom();
        this.signals.messages.value = [
          ...this.signals.messages.value,
          {
            role: "tool",
            id,
            name,
            input,
            result: null,
            collapsed,
            timestamp: new Date().toISOString(),
          },
        ];
        queueMicrotask(() => {
          if (wasNearBottom) this.scrollToBottom();
        });
      }),
    );

    // Tool result
    this.disposables.add(
      this.connection.on("tool-result", ({ toolUseId, content, isError }) => {
        const msgs = this.signals.messages.value;
        const idx = msgs.findIndex((m) => m.role === "tool" && m.id === toolUseId);
        if (idx !== -1) {
          const wasNearBottom = this.isNearBottom();
          const newMsgs = [...msgs];
          newMsgs[idx] = { ...newMsgs[idx], result: content, isError };
          this.signals.messages.value = newMsgs;
          queueMicrotask(() => {
            if (wasNearBottom) this.scrollToBottom();
          });
        }
      }),
    );

    // Result (response complete)
    this.disposables.add(
      this.connection.on("result", (resultText) => {
        // Flush any buffered thinking/text before finalizing
        if (this.pendingThinkingDelta) {
          this.signals.currentThinking.value += this.pendingThinkingDelta;
          this.pendingThinkingDelta = "";
        }
        this.finalizeThinking();
        if (this.pendingDelta) {
          this.signals.currentText.value += this.pendingDelta;
          this.pendingDelta = "";
        }
        const currentText = this.signals.currentText.value;
        log.debug("Response complete", {
          textLength: currentText?.length || resultText?.length || 0,
        });
        const finalText = currentText || resultText;
        if (finalText) {
          const message = this.addMessage("assistant", finalText);
          this.signals.currentText.value = "";
          this.emitter.emit("did-receive-message", message);
        }
        const wasNearBottom = this.isNearBottom();
        this.signals.isLoading.value = false;
        this.stopRequested = false;
        queueMicrotask(() => {
          if (wasNearBottom) this.scrollToBottom();
        });
        if (this.pendingDisconnect) {
          this.pendingDisconnect = false;
          this.connection.kill();
          return;
        }
        this.sendNextQueuedMessage();
      }),
    );

    // Usage
    this.disposables.add(
      this.connection.on("usage", (usage) => {
        if (usage.source && !usage.final) {
          return;
        }
        const prev = this.signals.tokenUsage.value;
        const input = usage.input ?? usage.input_tokens;
        const output = usage.output ?? usage.output_tokens;
        this.signals.tokenUsage.value = {
          input: tokenCount(prev?.input) + tokenCount(input),
          output: tokenCount(prev?.output) + tokenCount(output),
        };
        this.signals.tokenUsageAvailable.value = true;
      }),
    );

    this.disposables.add(
      this.connection.on("system", (event) => {
        if (SILENT_SYSTEM_SUBTYPES.has(event.subtype)) {
          return;
        }

        const content = this.formatSystemEvent(event);
        if (!content) return;

        const wasNearBottom = this.isNearBottom();
        this.addMessage("system", content, { subtype: event.subtype });
        queueMicrotask(() => {
          if (wasNearBottom) this.scrollToBottom();
        });
      }),
    );

    this.disposables.add(
      this.connection.on("system-status", ({ status, compactResult }) => {
        if (status === "compacting") {
          this.upsertCompactSystemMessage("running");
          return;
        } else if (compactResult === "success") {
          this.signals.tokenUsage.value = { input: 0, output: 0 };
          this.signals.tokenUsageAvailable.value = true;
          this.upsertCompactSystemMessage("success");
          this.saveCurrentSession();
          return;
        } else if (compactResult) {
          this.upsertCompactSystemMessage("failed", compactResult);
        }
      }),
    );

    this.disposables.add(
      this.connection.on("compact-boundary", ({ preTokens, trigger }) => {
        this.updateCompactSystemMessageDetails({ preTokens, trigger });
      }),
    );

    // Error
    this.disposables.add(
      this.connection.on("error", (error) => {
        const wasNearBottom = this.isNearBottom();
        this.addMessage("error", error.message);
        this.signals.isLoading.value = false;
        this.stopRequested = false;
        this.signals.currentText.value = "";
        this.signals.currentThinking.value = "";
        queueMicrotask(() => {
          if (wasNearBottom) this.scrollToBottom();
        });
      }),
    );

    // Exit
    this.disposables.add(
      this.connection.on("exit", (code) => {
        if (code !== 0 && this.signals.isLoading.value) {
          this.signals.isLoading.value = false;
          this.signals.currentText.value = "";
          this.signals.currentThinking.value = "";
        }
        this.stopRequested = false;
        this.pendingDisconnect = false;
        this.sendNextQueuedMessage();
      }),
    );

    // Permission requests
    this.disposables.add(
      this.connection.on("permission-request", (request) => {
        log.debug("Permission request", request);
        const wasNearBottom = this.isNearBottom();
        this.signals.pendingAnswers.value = null;
        this.signals.pendingQuestionSelections.value = null;
        this.signals.pendingPermission.value = request;
        queueMicrotask(() => {
          if (wasNearBottom) this.scrollToBottom();
        });
      }),
    );

    this.disposables.add(
      this.connection.on("control-cancel-request", ({ requestId }) => {
        if (this.signals.pendingPermission.value?.requestId !== requestId) return;
        log.debug("Control request canceled", { requestId });
        this.signals.pendingPermission.value = null;
        this.signals.pendingAnswers.value = null;
        this.signals.pendingQuestionSelections.value = null;
      }),
    );
  }

  // ============================================================================
  // Editor Setup
  // ============================================================================

  setupEditor() {
    // Use `new TextEditor` directly rather than `atom.workspace.buildTextEditor`.
    // The latter applies scope-based config defaults over our params and then
    // calls `maintainConfig`, which would force the user's global
    // `editor.scrollPastEnd` (and other settings) onto this editor, overriding
    // `scrollPastEnd: false` below. git-panel's commit editor uses the same
    // direct-construction approach for the same reason.
    this.promptEditor = new TextEditor({
      mini: false,
      softWrapped: true,
      autoHeight: false,
      scrollPastEnd: false,
      lineNumberGutterVisible: false,
      placeholderText: "Prompt message",
    });

    atom.grammars.assignLanguageMode(this.promptEditor.getBuffer(), "source.gfm");
    this.promptEditor.gutterWithName("line-number")?.hide();

    this.disposables.add(atom.textEditors.add(this.promptEditor));

    // Keep hasEditorInput signal in sync so ActionButton reacts while loading
    this.disposables.add(
      this.promptEditor.onDidChange(() => {
        this.signals.hasEditorInput.value = !!this.promptEditor.getText().trim();
      }),
    );

    // Store element ref; ChatApp's useEffect appends it to the editor container
    this._promptEditorElementRef.current = this.promptEditor.element;
  }

  setupImagePaste() {
    const isPasteTargetActive = (target = null) =>
      atom.textEditors.getActiveTextEditor() === this.promptEditor ||
      this.element.contains(document.activeElement) ||
      (target && this.element.contains(target));

    const attachClipboardImage = () => {
      const image = clipboard.readImage();
      if (!image || image.isEmpty()) return false;

      this.addPastedImageDataUrl(image.toDataURL(), "Pasted image");
      return true;
    };

    const pasteHandler = (event) => {
      if (!isPasteTargetActive(event.target)) return;

      const items = event.clipboardData?.items;
      if (!items) return;

      const imageItems = Array.from(items).filter((item) => item.type?.startsWith("image/"));
      if (imageItems.length === 0) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      for (const item of imageItems) {
        const file = item.getAsFile();
        if (file) this.addPastedImageFile(file);
      }
    };

    document.addEventListener("paste", pasteHandler, true);
    this.disposables.add(
      atom.commands.onWillDispatch((event) => {
        if (event.type !== "core:paste") return;
        if (!isPasteTargetActive()) return;
        if (!attachClipboardImage()) return;

        event.stopImmediatePropagation();
      }),
      new Disposable(() => {
        document.removeEventListener("paste", pasteHandler, true);
      }),
    );
  }

  // ============================================================================
  // Commands Setup
  // ============================================================================

  setupCommands() {
    this.disposables.add(
      atom.commands.add(this.promptEditor.element, {
        "claude-chat:send": () => this.handleSend(),
        "claude-chat:stop": () => this.handleStop(),
        "claude-chat:clear-prompt": () => this.handleClear(),
        "claude-chat:scroll-up": () => this.scrollPage(-1),
        "claude-chat:scroll-down": () => this.scrollPage(1),
        "claude-chat:show-usage": () => this.showTokenUsage(),
        "claude-chat:mode-default": () => this.handlePermissionModeChange("default"),
        "claude-chat:mode-plan": () => this.handlePermissionModeChange("plan"),
        "claude-chat:mode-accept-edits": () => this.handlePermissionModeChange("acceptEdits"),
        "claude-chat:mode-auto": () => this.handlePermissionModeChange("auto"),
        "claude-chat:focus-active-editor": () => this.focusActiveEditor(),
        "claude-chat:cycle-effort": () => this.cycleEffortMode(),
        "claude-chat:disconnect": () => this.disconnect(),
        "claude-chat:disconnect-queue": () => this.queueDisconnect(),
      }),
    );

    this.disposables.add(
      atom.commands.add(this.element, {
        "claude-chat:copy": () => this.handleCopy(),
        "claude-chat:copy-message": (e) => this.handleCopyMessage(e),
        "claude-chat:unfold-all": () => this.expandAllTools(),
        "claude-chat:fold-all": () => this.collapseAllTools(),
        "claude-chat:clear-messages": () => this.clearMessages(),
        "claude-chat:toggle-bypass-mode": () => this.toggleBypassMode(),
        "core:copy": (e) => this.handleCopy(e),
        "core:close": (e) => this.handleClose(e),
      }),
    );
  }

  // ============================================================================
  // Pane Observer Setup
  // ============================================================================

  setupPaneObserver() {
    this.disposables.add(
      atom.workspace.onDidChangeActivePaneItem((item) => {
        if (item === this) {
          if (!this.element.contains(document.activeElement)) {
            requestAnimationFrame(() => this.focus());
          }
        }
      }),
    );
  }

  // ============================================================================
  // Action Handlers
  // ============================================================================

  handleCopy(event) {
    if (event) event.stopPropagation();
    const selection = window.getSelection();
    if (selection && selection.toString()) {
      atom.clipboard.write(selection.toString());
    }
  }

  handleCopyMessage(event) {
    const target = event.target;
    const messageEl = target.closest(".message-content, .tool-content, .tool-result");
    if (messageEl) {
      atom.clipboard.write(messageEl.textContent);
      atom.notifications.addSuccess("Copied to clipboard", { dismissable: true });
    }
  }

  handleClose(event) {
    if (event) event.stopPropagation();
    const pane = atom.workspace.paneForItem(this);
    if (pane) {
      pane.destroyItem(this);
    }
  }

  showTokenUsage() {
    const usage = this.signals.tokenUsage.value || {};
    if (!this.signals.tokenUsageAvailable.value && this.signals.messages.value.length > 0) {
      atom.notifications.addInfo("Token Usage", {
        detail:
          "Token usage was not recorded for this saved chat. New messages in this session will be counted.",
        dismissable: true,
      });
      return;
    }
    const input = tokenCount(usage.input);
    const output = tokenCount(usage.output);
    const total = input + output;
    atom.notifications.addInfo("Token Usage", {
      detail: `Input: ${input.toLocaleString()}\nOutput: ${output.toLocaleString()}\nTotal: ${total.toLocaleString()}`,
      dismissable: true,
    });
  }

  sendSlashCommand(command) {
    const prompt = `/${command}`;
    if (this.isTurnBusy()) {
      this.queueMessage(prompt);
      this.focus();
      return;
    }

    this.sendMessageNow({ content: prompt });
    this.focus();
  }

  scheduleUpdate() {
    if (this.updateScheduled) return;
    this.updateScheduled = true;

    requestAnimationFrame(() => {
      this.updateScheduled = false;
      if (!this.pendingDelta && !this.pendingThinkingDelta) return;
      const wasNearBottom = this.isNearBottom();
      const wasThinkingAtBottom = this.isThinkingAtBottom();
      if (this.pendingThinkingDelta) {
        this.signals.currentThinking.value += this.pendingThinkingDelta;
        this.pendingThinkingDelta = "";
      }
      // When text starts arriving, finalize thinking as a message
      if (this.pendingDelta && this.signals.currentThinking.value) {
        this.finalizeThinking();
      }
      if (this.pendingDelta) {
        this.signals.currentText.value += this.pendingDelta;
        this.pendingDelta = "";
      }
      // Signal mutations above trigger Preact; scroll after DOM settles
      queueMicrotask(() => {
        if (wasNearBottom) this.scrollToBottom();
        // Auto-scroll streaming thinking content to bottom
        if (this.signals.currentThinking.value && wasThinkingAtBottom) {
          const el = this.element.querySelector(".thinking-streaming .thinking-content");
          if (el) el.scrollTop = el.scrollHeight;
        }
      });
    });
  }

  isThinkingAtBottom() {
    const el = this.element.querySelector(".thinking-streaming .thinking-content");
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 10;
  }

  isNearBottom() {
    const container = this._refs.messagesContainer;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  }

  scrollToBottom() {
    const container = this._refs.messagesContainer;
    if (container) container.scrollTop = container.scrollHeight;
  }

  scrollPage(direction) {
    const container = this._refs.messagesContainer;
    if (!container) return;
    container.scrollTop += direction * container.clientHeight * 0.25;
  }

  upsertCompactSystemMessage(status, result = null) {
    if (status === "running" && !this.activeCompactSystemMessageId) {
      this.activeCompactSystemMessageId = `compact-${Date.now()}`;
    }
    const messageId = this.activeCompactSystemMessageId || `compact-${Date.now()}`;
    const title = "Compact";
    const detail =
      status === "running"
        ? "Processing..."
        : status === "success"
          ? "Complete"
          : `Result: ${result || status}`;
    const content = `${title}\n${detail}`;
    const wasNearBottom = this.isNearBottom();
    const messages = this.signals.messages.value;

    const nextMessage = {
      role: "system",
      content,
      title,
      detail,
      id: messageId,
      systemKind: "compact",
      systemStatus: status,
      timestamp: new Date().toISOString(),
    };

    const existingIndex = messages.findIndex((message) => message.id === messageId);

    if (existingIndex === -1) {
      this.signals.messages.value = [...messages, nextMessage];
    } else {
      const nextMessages = [...messages];
      nextMessages[existingIndex] = { ...nextMessages[existingIndex], ...nextMessage };
      this.signals.messages.value = nextMessages;
    }

    if (status !== "running") {
      this.activeCompactSystemMessageId = null;
    }

    queueMicrotask(() => {
      if (wasNearBottom) this.scrollToBottom();
    });
  }

  updateCompactSystemMessageDetails({ preTokens, trigger }) {
    const messages = this.signals.messages.value;
    const compactIndex = [...messages]
      .reverse()
      .findIndex((message) => message.role === "system" && message.systemKind === "compact");
    if (compactIndex === -1) return;

    const index = messages.length - 1 - compactIndex;
    const nextMessages = [...messages];
    nextMessages[index] = {
      ...nextMessages[index],
      compactTrigger: trigger || "unknown",
      compactPreTokens: typeof preTokens === "number" ? preTokens : null,
    };
    this.signals.messages.value = nextMessages;
  }

  formatSystemEvent(event) {
    if (!event) return "";

    const subtype = event.subtype || "system";
    const text =
      event.message ||
      event.result ||
      event.content ||
      event.description ||
      event.error ||
      event.reason ||
      "";

    if (text) return `System (${subtype}): ${text}`;

    const details = Object.entries(event)
      .filter(([key]) => !["type", "subtype", "session_id", "uuid"].includes(key))
      .map(([key, value]) => {
        const formattedValue = typeof value === "string" ? value : JSON.stringify(value);
        return `${key}: ${formattedValue}`;
      })
      .join("\n");

    return details ? `System (${subtype})\n${details}` : `System (${subtype})`;
  }

  // ============================================================================
  // Tool Interaction
  // ============================================================================

  toggleToolCollapse(id) {
    const msgs = this.signals.messages.value;
    const idx = msgs.findIndex((m) => (m.role === "tool" || m.role === "thinking") && m.id === id);
    if (idx !== -1) {
      const newMsgs = [...msgs];
      newMsgs[idx] = { ...newMsgs[idx], collapsed: !newMsgs[idx].collapsed };
      this.signals.messages.value = newMsgs;
    }
  }

  expandAllTools() {
    this.signals.defaultToolCollapsed.value = false;
    this.signals.messages.value = this.signals.messages.value.map((m) =>
      m.role === "tool" || m.role === "thinking" ? { ...m, collapsed: false } : m,
    );
  }

  collapseAllTools() {
    this.signals.defaultToolCollapsed.value = true;
    this.signals.messages.value = this.signals.messages.value.map((m) =>
      m.role === "tool" || m.role === "thinking" ? { ...m, collapsed: true } : m,
    );
  }

  handleOpenFile(filePath, line) {
    if (!filePath) return;
    const options = {};
    if (line) options.initialLine = parseInt(line, 10) - 1;
    atom.workspace.open(filePath, options).catch(() => {
      atom.notifications.addWarning(`Could not open: ${filePath}`);
    });
  }

  // ============================================================================
  // Attach Context
  // ============================================================================

  setAttachContext(context) {
    this.signals.attachContext.value = [...this.signals.attachContext.value, context];
  }

  clearAttachContext() {
    this.signals.attachContext.value = [];
  }

  removeAttachContext(index) {
    this.signals.attachContext.value = this.signals.attachContext.value.filter(
      (_, i) => i !== index,
    );
  }

  addPastedImageFile(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result;
      if (typeof dataUrl !== "string") return;
      this.addPastedImageDataUrl(dataUrl, file.name || "Pasted image", file.type);
    };
    reader.onerror = () => {
      atom.notifications.addWarning("Claude Chat: could not read pasted image", {
        dismissable: true,
      });
    };
    reader.readAsDataURL(file);
  }

  addPastedImageDataUrl(dataUrl, name = "Pasted image", mimeType = null) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return;

    const match = dataUrl.match(/^data:([^;,]+)[;,]/);
    const image = {
      id: `pasted-image-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      dataUrl,
      base64: dataUrlToBase64(dataUrl),
      mimeType: mimeType || match?.[1] || "image/png",
      name,
    };

    this.signals.pastedImages.value = [...this.signals.pastedImages.value, image];
  }

  removePastedImage(index) {
    this.signals.pastedImages.value = this.signals.pastedImages.value.filter(
      (_, i) => i !== index,
    );
  }

  clearPastedImages() {
    this.signals.pastedImages.value = [];
  }

  buildMessageContent(content = "", attach = [], images = []) {
    const text = this.formatAttachContext(attach) + content;
    if (!images || images.length === 0) return text;

    return [
      {
        type: "text",
        text: text || "Please review the attached image.",
      },
      ...images.map((image) => imageToContentBlock(image)),
    ];
  }

  createCodeFence(text) {
    const matches = text.match(/`+/g) || [];
    const maxTicks = matches.reduce((max, ticks) => Math.max(max, ticks.length), 0);
    return "`".repeat(Math.max(3, maxTicks + 1));
  }

  formatSingleAttach(attach) {
    const { type, path, paths, selection, selections } = attach;

    if (type === "selections" && selections) {
      const filePath = path || paths?.[0];
      const hasText = selections.some((s) => s.text);
      if (hasText) {
        return selections
          .filter((s) => s.text)
          .map((s, index) => {
            const fence = this.createCodeFence(s.text);
            return [
              "<attachment>",
              "type: selection",
              `index: ${index + 1}`,
              `path: ${filePath}`,
              `line_start: ${s.range.start.row + 1}`,
              `line_end: ${s.range.end.row + 1}`,
              `column_start: ${s.range.start.column + 1}`,
              `column_end: ${s.range.end.column + 1}`,
              "content:",
              fence,
              s.text,
              fence,
              "</attachment>",
            ].join("\n");
          })
          .join("\n\n");
      } else {
        const positions = selections
          .map((s) => `- line: ${s.range.start.row + 1}\n  column: ${s.range.start.column + 1}`)
          .join("\n");
        return [
          "<attachment>",
          "type: cursors",
          `path: ${filePath}`,
          `cursor_count: ${selections.length}`,
          "positions:",
          positions,
          "</attachment>",
        ].join("\n");
      }
    } else if (type === "image") {
      const file = path || paths?.[0];
      const { dimensions } = attach;
      const lines = ["<attachment>", "type: image", `path: ${file}`];
      if (dimensions) {
        lines.push(`width: ${dimensions.width}`, `height: ${dimensions.height}`);
      }
      if (selection && typeof selection === "object") {
        const { x1, y1, x2, y2 } = selection;
        lines.push(
          "selected_region:",
          `  x1: ${x1}`,
          `  y1: ${y1}`,
          `  x2: ${x2}`,
          `  y2: ${y2}`,
          "instruction: Focus on the selected region, but consider the surrounding context of " +
            "the full image.",
        );
      }
      lines.push("instruction: Use the Read tool to view this image file.");
      lines.push("</attachment>");
      return lines.join("\n");
    } else if (type === "paths") {
      const allPaths = paths || (path ? [path] : []);
      const pathList = allPaths.map((p) => `- ${p}`).join("\n");
      return [
        "<attachment>",
        "type: paths",
        "paths:",
        pathList,
        "instruction: The user is referring to these paths. Use the Read tool if file " +
          "contents are needed.",
        "</attachment>",
      ].join("\n");
    }
    return "";
  }

  formatAttachContext(attachments = this.signals.attachContext.value) {
    if (!attachments || attachments.length === 0) return "";

    const parts = attachments.map((attach) => this.formatSingleAttach(attach)).filter(Boolean);
    if (parts.length === 0) return "";

    return `<attachments>\n${parts.join("\n\n")}\n</attachments>\n\n`;
  }

  createQueuedMessage(content, attach = [], images = []) {
    return {
      id: `queued-${Date.now()}-${this.nextQueuedMessageId++}`,
      content: content || "",
      attach: attach.length > 0 ? [...attach] : [],
      images: images.length > 0 ? [...images] : [],
      timestamp: new Date().toISOString(),
    };
  }

  queueMessage(content, attach = [], images = []) {
    if (!content && attach.length === 0 && images.length === 0) return false;

    const queuedMessage = this.createQueuedMessage(content, attach, images);
    const wasNearBottom = this.isNearBottom();
    this.signals.queuedMessages.value = [...this.signals.queuedMessages.value, queuedMessage];
    queueMicrotask(() => {
      if (wasNearBottom) this.scrollToBottom();
    });
    return true;
  }

  isTurnBusy() {
    return this.signals.isLoading.value || this.stopRequested;
  }

  sendMessageNow({
    content = "",
    attach = [],
    images = [],
    timestamp = new Date().toISOString(),
  }) {
    if (!content && attach.length === 0 && images.length === 0) return false;

    const fullMessage = this.buildMessageContent(content, attach, images);
    const message = { role: "user", content, timestamp };
    if (attach.length > 0) message.attach = [...attach];
    if (images.length > 0) message.images = [...images];

    this.stopRequested = false;
    const wasNearBottom = this.isNearBottom();
    this.signals.messages.value = [...this.signals.messages.value, message];
    this.signals.isLoading.value = true;
    this.signals.currentText.value = "";
    this.signals.currentThinking.value = "";
    queueMicrotask(() => {
      if (wasNearBottom) this.scrollToBottom();
    });
    this.connection.send(fullMessage);
    return true;
  }

  sendNextQueuedMessage() {
    if (this.isTurnBusy()) return false;

    const queuedMessages = this.signals.queuedMessages.value;
    const nextMessage = queuedMessages[0];
    if (!nextMessage) return false;

    this.signals.queuedMessages.value = queuedMessages.slice(1);
    return this.sendMessageNow(nextMessage);
  }

  deleteQueuedMessage(id) {
    this.signals.queuedMessages.value = this.signals.queuedMessages.value.filter(
      (message) => message.id !== id,
    );
  }

  reorderQueuedMessage(draggedId, targetId, position = "before") {
    if (!draggedId || !targetId || draggedId === targetId) return false;

    const queuedMessages = this.signals.queuedMessages.value;
    const draggedIndex = queuedMessages.findIndex((message) => message.id === draggedId);
    const targetIndex = queuedMessages.findIndex((message) => message.id === targetId);
    if (draggedIndex === -1 || targetIndex === -1) return false;

    const nextMessages = [...queuedMessages];
    const [draggedMessage] = nextMessages.splice(draggedIndex, 1);
    let insertIndex = nextMessages.findIndex((message) => message.id === targetId);
    if (insertIndex === -1) return false;
    if (position === "after") insertIndex += 1;

    nextMessages.splice(insertIndex, 0, draggedMessage);
    this.signals.queuedMessages.value = nextMessages;
    return true;
  }

  // Send a queued message immediately. If a turn is in progress, the message is
  // injected into the running session (steering) without disturbing the live
  // streaming state; otherwise it starts a normal turn.
  steerQueuedMessage(id) {
    const queuedMessages = this.signals.queuedMessages.value;
    const message = queuedMessages.find((queued) => queued.id === id);
    if (!message) return false;

    this.signals.queuedMessages.value = queuedMessages.filter((queued) => queued.id !== id);

    if (!this.isTurnBusy()) {
      return this.sendMessageNow(message);
    }

    const attach = message.attach || [];
    const images = message.images || [];
    const content = message.content || "";
    const fullMessage = this.buildMessageContent(content, attach, images);
    const transcriptMessage = { role: "user", content, timestamp: message.timestamp };
    if (attach.length > 0) transcriptMessage.attach = [...attach];
    if (images.length > 0) transcriptMessage.images = [...images];

    const wasNearBottom = this.isNearBottom();
    this.signals.messages.value = [...this.signals.messages.value, transcriptMessage];
    queueMicrotask(() => {
      if (wasNearBottom) this.scrollToBottom();
    });
    this.connection.send(fullMessage);
    return true;
  }

  moveQueuedMessageToPrompt(id) {
    const queuedMessages = this.signals.queuedMessages.value;
    const message = queuedMessages.find((queued) => queued.id === id);
    if (!message) return;

    this.signals.queuedMessages.value = queuedMessages.filter((queued) => queued.id !== id);

    const existingText = this.promptEditor?.getText() || "";
    const nextText = existingText.trim()
      ? `${existingText.replace(/\s+$/, "")}\n\n${message.content}`
      : message.content;
    this.promptEditor?.setText(nextText);
    this.signals.attachContext.value = [
      ...this.signals.attachContext.value,
      ...(message.attach || []),
    ];
    this.signals.pastedImages.value = [
      ...this.signals.pastedImages.value,
      ...(message.images || []),
    ];
    this.focus();
  }

  // ============================================================================
  // Send/Stop Handlers
  // ============================================================================

  sendPrompt(text, attachContext = null) {
    const attachments = [
      ...this.signals.attachContext.value,
      ...(attachContext ? [attachContext] : []),
    ];
    const images = this.signals.pastedImages.value;
    if (!text && attachments.length === 0 && images.length === 0) return false;

    log.debug(this.isTurnBusy() ? "Queueing prompt" : "Sending prompt", {
      length: text?.length || 0,
      hasAttach: attachments.length > 0,
      hasImages: images.length > 0,
    });

    if (this.isTurnBusy()) {
      const queued = this.queueMessage(text, attachments, images);
      if (queued) {
        this.signals.attachContext.value = [];
        this.clearPastedImages();
      }
      return queued;
    }

    this.signals.attachContext.value = [];
    this.clearPastedImages();
    this.sendMessageNow({ content: text, attach: attachments, images });
    return true;
  }

  handleSend() {
    const text = this.promptEditor.getText().trim();
    const attachments = this.signals.attachContext.value;
    const images = this.signals.pastedImages.value;
    if (!text && attachments.length === 0 && images.length === 0) return;

    // When an AskUserQuestion prompt is pending, treat the typed text as the
    // "Other" answer to the next unanswered question instead of queueing it.
    const perm = this.signals.pendingPermission.value;
    if (text && perm && (perm.toolName === "AskUserQuestion" || perm.toolName === "Question")) {
      const questions = perm.input?.questions || [];
      const answered = this.signals.pendingAnswers.value || {};
      const next = questions.find((q) => !answered[q.question]);
      if (next) {
        this.promptEditor.setText("");
        this.handleQuestionAnswer(next.question, text);
        this.focus();
        return;
      }
    }

    this.promptEditor.setText("");
    this.signals.attachContext.value = [];
    this.clearPastedImages();
    if (this.isTurnBusy()) {
      this.queueMessage(text, attachments, images);
    } else {
      this.sendMessageNow({ content: text, attach: attachments, images });
    }
    this.focus();
  }

  handleStop() {
    if (this.connection.isRunning()) {
      this.stopRequested = true;
      this.connection.interrupt();
    }
    this.signals.isLoading.value = false;
    this.signals.currentText.value = "";
    this.signals.currentThinking.value = "";
    this.pendingDelta = "";
    this.pendingThinkingDelta = "";
  }

  handleClear() {
    this.promptEditor?.setText("");
    this.clearAttachContext();
    this.clearPastedImages();
  }

  focusActiveEditor() {
    const editor = atom.workspace.getActiveTextEditor();
    if (editor) {
      atom.views.getView(editor).focus();
    }
  }

  clearMessages() {
    this.signals.messages.value = [];
    this.signals.queuedMessages.value = [];
  }

  handlePermissionModeChange(mode) {
    if (this.signals.permissionMode.value === mode) return;
    if (this.signals.permissionMode.value === "bypassPermissions") return;

    if (mode === "bypassPermissions") {
      this.toggleBypassMode();
      return;
    }

    if (this.connection.isRunning()) {
      const changed = this.connection.setPermissionMode(mode);
      if (!changed) {
        return;
      }
    } else {
      this.connection.permissionMode = mode;
    }

    this.signals.permissionMode.value = mode;
  }

  cycleEffortMode() {
    const modes = Config.effortModes;
    const currentIndex = modes.findIndex((m) => m.value === this.signals.effortMode.value);
    const nextIndex = (currentIndex + 1) % modes.length;
    this.signals.effortMode.value = modes[nextIndex].value;
    if (this.connection.isRunning()) {
      this.connection.setEffortMode(this.signals.effortMode.value);
    }
  }

  async cycleModel() {
    const models = Config.models;
    const current = this.signals.model.value;
    const currentIndex = models.findIndex((m) => m.value === current);
    const nextIndex = (currentIndex + 1) % models.length;
    const next = models[nextIndex].value;
    this.signals.model.value = next;
    this.connection.model = next;
    this.queueDisconnect();
  }

  handlePermissionAccept(permissions) {
    if (!this.signals.pendingPermission.value) return;
    const { requestId, input } = this.signals.pendingPermission.value;
    const opts = { input };
    if (permissions?.length) {
      const blockedMode = permissions.find(
        (p) => p.type === "setMode" && p.mode === "bypassPermissions",
      );
      if (blockedMode) {
        this.toggleBypassMode();
        return;
      }
      opts.permissions = permissions;
      this.applyPermissionSuggestions(permissions);
    }
    this.connection.respondToPermission(requestId, "allow", opts);
    this.signals.pendingPermission.value = null;
    this.signals.pendingAnswers.value = null;
    this.signals.pendingQuestionSelections.value = null;
  }

  handlePermissionAcceptEdited() {
    if (!this.signals.pendingPermission.value) return;

    const text = this.promptEditor?.getText()?.trim();
    if (!text) {
      this.focus();
      return;
    }

    let input;
    try {
      input = JSON.parse(text);
    } catch (err) {
      atom.notifications.addWarning("Edited permission input must be valid JSON.", {
        detail: err.message,
        dismissable: true,
      });
      this.focus();
      return;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      atom.notifications.addWarning("Edited permission input must be a JSON object.", {
        dismissable: true,
      });
      this.focus();
      return;
    }

    const { requestId } = this.signals.pendingPermission.value;
    this.promptEditor.setText("");
    this.connection.respondToPermission(requestId, "allow", { input });
    this.signals.pendingPermission.value = null;
    this.signals.pendingAnswers.value = null;
    this.signals.pendingQuestionSelections.value = null;
  }

  handlePermissionDeny() {
    if (!this.signals.pendingPermission.value) return;
    const { requestId } = this.signals.pendingPermission.value;
    this.connection.respondToPermission(requestId, "deny", {
      message: "User denied permission",
    });
    this.signals.pendingPermission.value = null;
    this.signals.pendingAnswers.value = null;
    this.signals.pendingQuestionSelections.value = null;
  }

  handlePermissionDenyWithReason() {
    if (!this.signals.pendingPermission.value) return;

    const message = this.promptEditor?.getText()?.trim();
    if (!message) {
      this.focus();
      return;
    }

    const { requestId } = this.signals.pendingPermission.value;
    this.promptEditor.setText("");
    this.connection.respondToPermission(requestId, "deny", { message });
    this.signals.pendingPermission.value = null;
    this.signals.pendingAnswers.value = null;
    this.signals.pendingQuestionSelections.value = null;
  }

  applyPermissionSuggestions(permissions) {
    const modeChange = permissions.find((p) => p.type === "setMode" && p.mode);
    if (modeChange) {
      if (modeChange.mode === "bypassPermissions") {
        this.toggleBypassMode();
        return;
      }
      this.signals.permissionMode.value = modeChange.mode;
      this.connection.permissionMode = modeChange.mode;
    }
  }

  /**
   * Handle answering a single question in an AskUserQuestion prompt.
   */
  handleQuestionAnswer(questionText, answer) {
    if (!this.signals.pendingPermission.value) return;

    if (!this.signals.pendingAnswers.value) this.signals.pendingAnswers.value = {};
    this.signals.pendingAnswers.value = {
      ...this.signals.pendingAnswers.value,
      [questionText]: answer,
    };

    const { requestId, input } = this.signals.pendingPermission.value;
    const questions = input?.questions || [];

    const allAnswered = questions.every((q) => this.signals.pendingAnswers.value[q.question]);
    if (!allAnswered) return;

    const answers = { ...this.signals.pendingAnswers.value };
    const updatedInput = { ...input, answers };
    log.debug("Question answer", { answers, updatedInput });

    // Store answers on the tool message so the renderer can show them
    const msgs = this.signals.messages.value;
    const idx = msgs.findIndex(
      (m) =>
        m.role === "tool" && (m.name === "AskUserQuestion" || m.name === "Question") && !m.answers,
    );
    if (idx !== -1) {
      const newMsgs = [...msgs];
      newMsgs[idx] = { ...newMsgs[idx], answers };
      this.signals.messages.value = newMsgs;
    }

    this.connection.respondToPermission(requestId, "allow", { input: updatedInput });
    this.signals.pendingPermission.value = null;
    this.signals.pendingAnswers.value = null;
    this.signals.pendingQuestionSelections.value = null;
  }

  handleQuestionMultiToggle(questionText, answer) {
    if (!this.signals.pendingPermission.value) return;

    const current = this.signals.pendingQuestionSelections.value || {};
    const values = (current[questionText] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const nextValues = values.includes(answer)
      ? values.filter((value) => value !== answer)
      : [...values, answer];

    this.signals.pendingQuestionSelections.value = {
      ...current,
      [questionText]: nextValues.join(", "),
    };
  }

  handleQuestionSubmit(questionText) {
    const answer = this.signals.pendingQuestionSelections.value?.[questionText];
    if (!answer) {
      this.focus();
      return;
    }

    this.handleQuestionAnswer(questionText, answer);
  }

  /**
   * Handle "Other" option: use text from prompt editor
   */
  handleQuestionAnswerOther(questionText) {
    const text = this.promptEditor?.getText()?.trim();
    if (!text) {
      this.focus();
      return;
    }
    this.promptEditor.setText("");
    this.handleQuestionAnswer(questionText, text);
  }

  // ============================================================================
  // Workspace Item Methods
  // ============================================================================

  getTitle() {
    return "Claude";
  }

  getIconName() {
    return "comment-discussion";
  }

  getURI() {
    if (this.sessionId) {
      return `${URI_PREFIX}/session/${this.sessionId}`;
    }
    return `${URI_PREFIX}/panel`;
  }

  getDefaultLocation() {
    return Config.panelPosition();
  }

  getAllowedLocations() {
    return ["left", "right", "center"];
  }

  getElement() {
    return this.element;
  }

  onDidChangeTitle(callback) {
    if (this.emitter.disposed) {
      return new Disposable();
    }
    return this.emitter.on("did-change-title", callback);
  }

  onDidReceiveMessage(callback) {
    if (this.emitter.disposed) {
      return new Disposable();
    }
    return this.emitter.on("did-receive-message", callback);
  }

  update(props) {
    if (props) {
      Object.assign(this.props, props);
    }
    this.updateTooltips();
    return Promise.resolve();
  }

  focus() {
    this.promptEditor?.element?.focus();
  }

  canLoadSession() {
    return (
      this.signals.messages.value.length === 0 &&
      this.signals.queuedMessages.value.length === 0 &&
      !this.signals.isLoading.value &&
      !this.sessionId
    );
  }

  loadSession(sessionData) {
    this.signals.messages.value = (sessionData.messages || []).filter(
      (message) => !isSilentSystemMessage(message),
    );
    this.signals.queuedMessages.value = [];
    this.sessionId = sessionData.sessionId;
    this.projectPaths = sessionData.projectPaths || atom.project.getPaths();
    this.createdAt = sessionData.createdAt || new Date().toISOString();
    this.signals.tokenUsage.value = sessionData.tokenUsage || { input: 0, output: 0 };
    this.signals.tokenUsageAvailable.value = hasTokenUsage(sessionData.tokenUsage);
    this.connection.sessionId = this.sessionId;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        this.scrollToBottom();
        this.element.querySelectorAll(".message-thinking .thinking-content").forEach((el) => {
          el.scrollTop = el.scrollHeight;
        });
      }),
    );
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    log.debug("Destroying ChatPanel", { sessionId: this.sessionId });
    window.removeEventListener("beforeunload", this._beforeUnload);
    await this.saveCurrentSession();
    this.connection?.destroy();
    this.disposables?.dispose();
    this.tooltipDisposables?.dispose();
    this.emitter?.dispose();
    this.promptEditor?.destroy();
    render(null, this.element);
  }

  async saveCurrentSession() {
    const messages = this.signals.messages.value.filter(
      (message) => !isSilentSystemMessage(message),
    );
    if (!this.sessionId || messages.length === 0) return;

    const firstUserMsg = messages.find((m) => m.role === "user");
    try {
      await saveSession({
        sessionId: this.sessionId,
        projectPaths: this.projectPaths,
        createdAt: this.createdAt,
        firstMessage: firstUserMsg?.content || "",
        messages,
        tokenUsage: this.signals.tokenUsageAvailable.value
          ? this.signals.tokenUsage.value
          : { input: null, output: null },
      });
    } catch (err) {
      console.error("Failed to save session:", err);
    }
  }

  saveCurrentSessionSync() {
    const messages = this.signals.messages.value.filter(
      (message) => !isSilentSystemMessage(message),
    );
    if (!this.sessionId || messages.length === 0) return;

    const firstUserMsg = messages.find((m) => m.role === "user");
    try {
      saveSessionSync({
        sessionId: this.sessionId,
        projectPaths: this.projectPaths,
        createdAt: this.createdAt,
        firstMessage: firstUserMsg?.content || "",
        messages,
        tokenUsage: this.signals.tokenUsageAvailable.value
          ? this.signals.tokenUsage.value
          : { input: null, output: null },
      });
    } catch (err) {
      console.error("Failed to save session (sync):", err);
    }
  }
}

// ============================================================================
// Preact Components
// ============================================================================

/**
 * Isolates streaming re-renders: only this component re-renders on each delta.
 * Receives signal objects (not .value) so parent ChatApp is not subscribed.
 */
function StreamingArea({ currentText, currentThinking, isLoading }) {
  return renderStreamingMessage(currentText.value, currentThinking.value, isLoading.value);
}

/**
 * Isolates permission/question prompt re-renders.
 */
function PermissionArea({ signals, callbacks }) {
  const perm = signals.pendingPermission.value;
  if (!perm) return null;

  const { toolName, input, suggestions } = perm;
  const hasEditorInput = signals.hasEditorInput.value;

  if (toolName === "AskUserQuestion" || toolName === "Question") {
    return <QuestionPrompt input={input} signals={signals} callbacks={callbacks} />;
  }

  const suggestionButtons = getSuggestionButtons(suggestions);

  return (
    <div className="permission-prompt">
      <div className="permission-prompt-header">
        <span className="permission-prompt-icon icon icon-shield"></span>
        <strong className="permission-prompt-tool">{toolName}</strong>
        {input?.description ? (
          <span className="permission-prompt-desc">{input.description}</span>
        ) : null}
      </div>
      <PermissionDetails toolName={toolName} input={input} />
      <div className="permission-prompt-actions">
        <button className="btn btn-success" onClick={() => callbacks.handlePermissionAccept()}>
          Allow
        </button>
        {hasEditorInput ? (
          <button className="btn btn-info" onClick={() => callbacks.handlePermissionAcceptEdited()}>
            Allow Edited
          </button>
        ) : null}
        {suggestionButtons.map((sb, i) => (
          <div className="permission-suggestion" key={i}>
            <button
              className="btn btn-info"
              onClick={() =>
                sb.mode === "bypassPermissions"
                  ? callbacks.handleToggleBypassMode()
                  : callbacks.handlePermissionAccept(sb.permissions)
              }
            >
              {sb.label}
            </button>
            {sb.detail ? <span className="permission-suggestion-detail">{sb.detail}</span> : null}
          </div>
        ))}
        {hasEditorInput ? (
          <button
            className="btn btn-warning"
            onClick={() => callbacks.handlePermissionDenyWithReason()}
          >
            Deny with Note
          </button>
        ) : null}
        <button className="btn btn-error" onClick={() => callbacks.handlePermissionDeny()}>
          Deny
        </button>
      </div>
    </div>
  );
}

function PermissionDetails({ toolName, input }) {
  if (!input) return null;

  if (isShellCommandTool(toolName) && input.command) {
    return <pre className="permission-prompt-command">{input.command}</pre>;
  }
  if ((toolName === "Write" || toolName === "Edit" || toolName === "Read") && input.file_path) {
    return <span className="permission-prompt-path">{input.file_path}</span>;
  }
  if ((toolName === "Glob" || toolName === "Grep") && input.pattern) {
    return <span className="permission-prompt-path">{input.pattern}</span>;
  }
  const keys = Object.keys(input).filter((k) => k !== "description");
  if (keys.length > 0) {
    const summary = keys
      .slice(0, 3)
      .map((k) => `${k}: ${String(input[k]).slice(0, 60)}`)
      .join(", ");
    return <span className="permission-prompt-path">{summary}</span>;
  }
  return null;
}

function QuestionPrompt({ input, signals, callbacks }) {
  const questions = input?.questions || [];
  if (questions.length === 0) return null;
  const partial = signals.pendingAnswers.value || {};
  const draftSelections = signals.pendingQuestionSelections.value || {};

  return (
    <div className="question-prompt">
      {questions.map((q, qi) => {
        const isMultiSelect = !!q.multiSelect;
        const selected = partial[q.question];
        const draft = draftSelections[q.question];
        const selectedLabels = ((isMultiSelect ? draft : selected) || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        return (
          <div className="question-prompt-block" key={qi}>
            <div className="question-prompt-header">
              {q.header ? <span className="question-prompt-tag">{q.header}</span> : null}
              <span className="question-prompt-text">{q.question}</span>
              {selected ? <span className="question-prompt-answer">{selected}</span> : null}
            </div>
            {!selected ? (
              <div className="question-prompt-options">
                {(q.options || []).map((opt, oi) => (
                  <button
                    className={`btn question-prompt-option ${
                      selectedLabels.includes(opt.label) ? "selected" : ""
                    }`}
                    key={oi}
                    onClick={() =>
                      isMultiSelect
                        ? callbacks.handleQuestionMultiToggle(q.question, opt.label)
                        : callbacks.handleQuestionAnswer(q.question, opt.label)
                    }
                  >
                    <span className="option-label">{opt.label}</span>
                    {opt.description ? (
                      <span className="option-description">{opt.description}</span>
                    ) : null}
                  </button>
                ))}
                <button
                  className="btn question-prompt-option question-prompt-other"
                  onClick={() => callbacks.handleQuestionAnswerOther(q.question)}
                >
                  <span className="option-label">Other...</span>
                </button>
                {isMultiSelect && selectedLabels.length > 0 ? (
                  <button
                    className="btn btn-info question-prompt-submit"
                    onClick={() => callbacks.handleQuestionSubmit(q.question)}
                  >
                    Use selected
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function QueuedMessagesArea({ signals, callbacks }) {
  const queuedMessages = signals.queuedMessages.value;
  const draggedMessageIdRef = useRef(null);
  const [draggedMessageId, setDraggedMessageId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  if (queuedMessages.length === 0) return null;

  const clearDragState = () => {
    draggedMessageIdRef.current = null;
    setDraggedMessageId(null);
    setDropTarget(null);
  };

  const getDropPosition = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  const handleDragStart = (event, id) => {
    draggedMessageIdRef.current = id;
    setDraggedMessageId(id);
    setDropTarget(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  };

  const handleDragOver = (event, targetId) => {
    const activeDraggedId = draggedMessageId || draggedMessageIdRef.current;
    if (!activeDraggedId || activeDraggedId === targetId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ id: targetId, position: getDropPosition(event) });
  };

  const handleDrop = (event, targetId) => {
    event.preventDefault();
    const draggedId =
      draggedMessageId || draggedMessageIdRef.current || event.dataTransfer.getData("text/plain");
    const position = dropTarget?.id === targetId ? dropTarget.position : getDropPosition(event);
    callbacks.handleQueuedMessageReorder(draggedId, targetId, position);
    clearDragState();
  };

  return (
    <div className="queued-messages">
      <div className="queued-messages-header">Queue ({queuedMessages.length})</div>
      <div className="queued-messages-list">
        {queuedMessages.map((message) => (
          <div
            className={[
              "queued-message",
              draggedMessageId === message.id ? "queued-message-dragging" : "",
              dropTarget?.id === message.id ? `queued-message-drop-${dropTarget.position}` : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={message.id}
            onDragOver={(event) => handleDragOver(event, message.id)}
            onDragLeave={(event) => {
              const relatedTarget = event.relatedTarget;
              if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) {
                setDropTarget(null);
              }
            }}
            onDrop={(event) => handleDrop(event, message.id)}
          >
            <button
              className="btn queued-message-drag-handle icon icon-grabber"
              data-tooltip="Drag to reorder"
              draggable={true}
              onDragStart={(event) => handleDragStart(event, message.id)}
              onDragEnd={clearDragState}
              type="button"
            />
            <div className="queued-message-body">
              {message.attach?.length > 0 ? (
                <div className="queued-message-attachments">
                  {message.attach.map((attach, i) => (
                    <span className="queued-message-attach" key={i}>
                      <span
                        className={[
                          "icon",
                          ...(attach.iconClasses || [`icon-${attach.icon || "mention"}`]),
                        ].join(" ")}
                      ></span>
                      <span className="queued-message-attach-label">{attach.label}</span>
                    </span>
                  ))}
                </div>
              ) : null}
              {message.images?.length > 0 ? (
                <div className="queued-message-images">
                  {message.images.map((image, i) => (
                    <img
                      alt={getPastedImageLabel(image, i)}
                      className="queued-message-image-thumb"
                      key={image.id || i}
                      onClick={() => callbacks.openPastedImage(image)}
                      src={image.dataUrl}
                      title={getPastedImageLabel(image, i)}
                    />
                  ))}
                </div>
              ) : null}
              {message.content ? (
                <div className="queued-message-content">{message.content}</div>
              ) : (
                <div className="queued-message-content queued-message-content-empty">
                  {message.images?.length > 0 ? "Image only" : "Attached context only"}
                </div>
              )}
            </div>
            <div className="queued-message-actions">
              <button
                className="btn queued-message-action icon icon-arrow-up"
                data-tooltip="Send now (steer)"
                onClick={() => callbacks.handleQueuedMessageSteer(message.id)}
              />
              <button
                className="btn queued-message-action icon icon-arrow-down"
                data-tooltip="Move back to prompt"
                onClick={() => callbacks.handleQueuedMessageEdit(message.id)}
              />
              <button
                className="btn queued-message-action icon icon-x"
                data-tooltip="Delete queued message"
                onClick={() => callbacks.handleQueuedMessageDelete(message.id)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PastedImagesTray({ images, onOpen, onRemove }) {
  if (!images || images.length === 0) return null;

  return (
    <div className="pasted-image-tray">
      {images.map((image, i) => (
        <span className="pasted-image-item" key={image.id || i}>
          <img
            alt={getPastedImageLabel(image, i)}
            className="pasted-image-thumb"
            onClick={() => onOpen(image)}
            src={image.dataUrl}
            title={getPastedImageLabel(image, i)}
          />
          <button
            className="btn btn-xs pasted-image-remove icon icon-x"
            data-tooltip="Remove image"
            onClick={() => onRemove(i)}
            type="button"
          />
        </span>
      ))}
    </div>
  );
}

/**
 * Root Preact component. Replaces the old render() method.
 * Signals are passed as objects (not .value) so only sub-components that
 * actually read a signal re-render when it changes.
 */
function ChatApp({ signals, callbacks, promptEditorElementRef }) {
  const messagesContainerRef = useRef(null);
  const editorContainerRef = useRef(null);
  const sendBtnRef = useRef(null);
  const stopBtnRef = useRef(null);
  const effortModeRef = useRef(null);
  const modelBtnRef = useRef(null);
  const permBtnRefs = useRef({});

  // Expose DOM refs back to the class shell after every render
  useEffect(() => {
    callbacks.onRefsReady({
      messagesContainer: messagesContainerRef.current,
      editorContainer: editorContainerRef.current,
      sendBtn: sendBtnRef.current,
      stopBtn: stopBtnRef.current,
      effortMode: effortModeRef.current,
      modelBtn: modelBtnRef.current,
      permissionBtns: permBtnRefs.current,
    });
  });

  // Append the Atom TextEditor element once on mount
  useEffect(() => {
    if (editorContainerRef.current && promptEditorElementRef.current) {
      editorContainerRef.current.appendChild(promptEditorElementRef.current);
    }
  }, []);

  const isStreaming = signals.isLoading.value || signals.currentText.value;
  const isEmpty =
    signals.messages.value.length === 0 &&
    signals.queuedMessages.value.length === 0 &&
    !isStreaming &&
    !signals.pendingPermission.value;

  const effortModes = Config.effortModes;
  const currentEffort =
    effortModes.find((m) => m.value === signals.effortMode.value) || effortModes[1];

  const modelValue = signals.model.value;
  const currentModel =
    Config.models.find((m) => m.value === modelValue) ||
    (modelValue === "custom"
      ? { value: "custom", label: Config.customModel() || "Custom" }
      : Config.models[0]);

  const showStop =
    signals.isLoading.value &&
    !signals.hasEditorInput.value &&
    signals.attachContext.value.length === 0 &&
    signals.pastedImages.value.length === 0;
  const isBypassMode = signals.permissionMode.value === "bypassPermissions";
  const usage = signals.tokenUsage.value || {};
  const hasTokenUsageValue =
    signals.tokenUsageAvailable.value && (usage.input != null || usage.output != null);
  const tokenUsageTokens = tokenCount(usage.input) + tokenCount(usage.output);
  const tokenUsageText = hasTokenUsageValue ? formatTokenCount(tokenUsageTokens) : "--";

  return (
    <div className="claude-chat" tabIndex="-1">
      <div className="claude-chat-messages" ref={messagesContainerRef}>
        {isEmpty ? renderWelcomePage() : null}
        {!isEmpty
          ? renderMessages(signals.messages.value, callbacks.toolHandlers, !!isStreaming, {
              openPastedImage: callbacks.openPastedImage,
            })
          : null}
        <StreamingArea
          currentText={signals.currentText}
          currentThinking={signals.currentThinking}
          isLoading={signals.isLoading}
        />
        <PermissionArea signals={signals} callbacks={callbacks} />
      </div>
      <div className="claude-chat-queue-zone">
        <QueuedMessagesArea signals={signals} callbacks={callbacks} />
      </div>
      <div className="claude-chat-input">
        {signals.attachContext.value.length > 0 ? (
          <div className="attach-tray">
            {signals.attachContext.value.map((ctx, i) => {
              let tooltipText = "";
              if (ctx.type === "selections" && ctx.selections) {
                const filePath = ctx.path || ctx.paths?.[0];
                const hasText = ctx.selections.some((s) => s.text);
                if (hasText) {
                  const totalChars = ctx.selections.reduce(
                    (sum, s) => sum + (s.text?.length || 0),
                    0,
                  );
                  tooltipText = `${ctx.selections.length} selection(s) from ${filePath}\n${totalChars} characters`;
                } else {
                  tooltipText = `${ctx.selections.length} cursor(s) in ${filePath}`;
                }
              } else if (ctx.type === "paths") {
                const allPaths = ctx.paths || (ctx.path ? [ctx.path] : []);
                tooltipText =
                  allPaths.length === 1 ? `Path: ${allPaths[0]}` : `Paths:\n${allPaths.join("\n")}`;
              }
              return (
                <span
                  key={i}
                  className="attach-indicator"
                  data-tooltip={tooltipText || ctx.label}
                  onClick={() => callbacks.removeAttachContext(i)}
                >
                  <span
                    className={[
                      "icon",
                      ...(ctx.iconClasses || [`icon-${ctx.icon || "mention"}`]),
                    ].join(" ")}
                  ></span>
                  <span className="attach-label">{ctx.label}</span>
                </span>
              );
            })}
          </div>
        ) : null}
        <PastedImagesTray
          images={signals.pastedImages.value}
          onOpen={callbacks.openPastedImage}
          onRemove={callbacks.removePastedImage}
        />
        <div className="editor-container" ref={editorContainerRef}>
          <div
            className={`effort-mode effort-${currentEffort.value}`}
            ref={effortModeRef}
            onMouseDown={(e) => e.preventDefault()}
            onClick={callbacks.cycleEffortMode}
          >
            {effortModes.map((_, i) => (
              <span className={`effort-dot${i < currentEffort.dots ? " active" : ""}`} />
            ))}
          </div>
        </div>
        <div className="claude-chat-toolbar">
          <div className={`token-usage-indicator ${hasTokenUsageValue ? "" : "empty"}`}>
            <span className="token-usage-value">{tokenUsageText}</span>
          </div>
          <div className="toolbar-actions">
            <span
              ref={modelBtnRef}
              className={`model-selector model-${currentModel.value}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={callbacks.cycleModel}
            >
              {currentModel.label}
            </span>
            <div className={`btn-group permission-mode ${isBypassMode ? "disabled" : ""}`}>
              {Config.permissionModes.map((mode) => (
                <button
                  ref={(el) => {
                    if (el) permBtnRefs.current[`permission-${mode.value}`] = el;
                  }}
                  className={`btn icon icon-${mode.icon} ${
                    mode.value === signals.permissionMode.value ? "selected" : ""
                  }`}
                  onClick={() => callbacks.handlePermissionModeChange(mode.value)}
                />
              ))}
            </div>
            <div className="btn-group send-group">
              {showStop ? (
                <button
                  ref={stopBtnRef}
                  className="btn btn-error icon icon-primitive-square"
                  onClick={callbacks.handleStop}
                />
              ) : (
                <button
                  ref={sendBtnRef}
                  className="btn btn-primary icon icon-triangle-right"
                  onClick={callbacks.handleSend}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

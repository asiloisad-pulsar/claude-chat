/** @babel */

import React, { useRef, useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
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

    // React render state. Imperative event handlers update this via setStateValue().
    this.stateValues = {
      // High-frequency streaming (surgical DOM updates via StreamingArea)
      currentText: "",
      currentThinking: "",
      isLoading: false,
      // Lower-frequency UI state
      messages: initialMessages,
      pendingPermission: null,
      pendingAnswers: null,
      pendingQuestionSelections: null,
      attachContext: [],
      pastedImages: [],
      permissionMode: props.permissionMode || Config.permissionMode(),
      effortMode: props.effortMode || Config.effortMode(),
      model: Config.model(),
      tokenUsage: props.tokenUsage || { input: 0, output: 0 },
      tokenUsageAvailable: !props.tokenUsage || hasTokenUsage(props.tokenUsage),
      defaultToolCollapsed: null,
      hasEditorInput: false,
      queuedMessages: [],
    };
    this._setReactState = null;

    // Create connection
    this.connection = new ClaudeConnection({
      sessionId: this.sessionId,
      permissionMode: this.stateValue("permissionMode"),
      effortMode: this.stateValue("effortMode"),
      model: this.stateValue("model"),
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

    // DOM refs populated by ChatApp's layout effect after each render
    this._refs = {};
    this.shouldScrollMessagesToBottom = false;
    this.shouldScrollStreamingThinkingToBottom = false;
    this.shouldScrollLatestThinkingToBottom = false;
    // Ref to Atom TextEditor DOM element, attached once both it and the container exist.
    this._promptEditorElementRef = { current: null };
    // Auto-scroll: keep the message list pinned to the bottom unless the user
    // scrolls up. Driven by a ResizeObserver (see setupAutoScroll), so it stays
    // correct as async content (markdown, syntax highlighting, images) grows.
    this.stickToBottom = true;
    this.savedMessagesScrollTop = 0;
    this.savedMessagesScrollAnchor = null;
    this._resizeObserver = null;
    this._onMessagesScroll = null;
    this.scrollAnimationFrame = null;
    this.scrollAnimationTarget = null;
    this.paneItemSubscription = null;
    this.observedPane = null;
    this.paneMoveInProgress = false;

    // Mount React tree into the host element
    this.element = document.createElement("div");
    this.element.classList.add("claude-chat-host");
    this._reactRoot = createRoot(this.element);
    flushSync(() => {
      this._reactRoot.render(
        <ChatApp
          initialState={this.stateValues}
          callbacks={this._buildCallbacks()}
        />,
      );
    });

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
      onReactStateReady: (setReactState) => {
        this._setReactState = setReactState;
      },
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
      handleQueuedMessageFreeze: (id) => this.toggleQueuedMessageFreeze(id),
      openPastedImage: (image) => this.openPastedImage(image),
      clearAttachContext: () => this.clearAttachContext(),
      removeAttachContext: (index) => this.removeAttachContext(index),
      removePastedImage: (index) => this.removePastedImage(index),
      cycleEffortMode: () => this.cycleEffortMode(),
      openModelSelector: () => this.openModelSelector(),
      onRefsReady: (refs) => {
        const previousContainer = this._refs.messagesContainer;
        if (previousContainer && previousContainer !== refs.messagesContainer) {
          this.rememberMessagesScrollPosition(previousContainer);
          this.teardownAutoScroll();
        }
        this._refs = refs;
        this.attachPromptEditorElement();
        this.updateTooltips();
        this.setupAutoScroll();
        this.flushPendingMessagesScroll();
        this.flushPendingThinkingScroll();
      },
    };
  }

  stateValue(key) {
    return this.stateValues[key];
  }

  getSelectedModel() {
    return this.stateValue("model");
  }

  setStateValue(key, value) {
    if (Object.is(this.stateValues[key], value)) return;
    this.stateValues = { ...this.stateValues, [key]: value };
    this._setReactState?.(this.stateValues);
  }

  attachPromptEditorElement() {
    const container = this._refs.editorContainer;
    const editorElement = this._promptEditorElementRef.current;
    if (!container || !editorElement || editorElement.parentNode === container) return;
    container.appendChild(editorElement);
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Add a message to the React message state (immutable update)
   */
  addMessage(role, content, extras = {}) {
    const message = { role, content, timestamp: new Date().toISOString(), ...extras };
    this.setStateValue("messages", [...this.stateValue("messages"), message]);
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
    const thinking = this.stateValue("currentThinking");
    if (!thinking) return;
    const msgs = this.stateValue("messages");
    const last = msgs[msgs.length - 1];
    if (last?.role === "thinking") {
      const newMsgs = [...msgs];
      newMsgs[newMsgs.length - 1] = { ...last, content: last.content + thinking };
      this.setStateValue("messages", newMsgs);
    } else {
      this.setStateValue("messages", [
        ...msgs,
        {
          role: "thinking",
          content: thinking,
          id: `thinking-${Date.now()}`,
          collapsed: false,
          timestamp: new Date().toISOString(),
        },
      ]);
    }
    const streamingEl = this.element.querySelector(".thinking-streaming .thinking-content");
    const wasAtBottom = streamingEl
      ? streamingEl.scrollHeight - streamingEl.scrollTop - streamingEl.clientHeight < 10
      : true;
    this.setStateValue("currentThinking", "");
    if (wasAtBottom) {
      this.shouldScrollLatestThinkingToBottom = true;
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
    if (this.stateValue("isLoading")) {
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
      permissionMode: this.stateValue("permissionMode"),
      effortMode: this.stateValue("effortMode"),
      model: this.stateValue("model"),
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
      permissionMode: this.stateValue("permissionMode"),
      effortMode: this.stateValue("effortMode"),
      model: this.stateValue("model"),
    });
    this.setupConnection();
  }

  async toggleBypassMode() {
    const isBypassMode = this.stateValue("permissionMode") === "bypassPermissions";
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
        this.stateValue("permissionMode") === "bypassPermissions"
          ? configuredMode
          : this.stateValue("permissionMode");
      if (this.previousPermissionMode === "bypassPermissions") {
        this.previousPermissionMode = "default";
      }
    }

    this.setStateValue("permissionMode", nextMode);
    this.recreateConnection();
    this.setStateValue("pendingPermission", null);
    this.setStateValue("pendingAnswers", null);
    this.setStateValue("pendingQuestionSelections", null);

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
        Config.effortModes.find((m) => m.value === this.stateValue("effortMode")) ||
        Config.effortModes[1];
      this.tooltipDisposables.add(
        atom.tooltips.add(this._refs.effortMode, {
          title: `Effort: ${current.label} (click to cycle)`,
        }),
      );
    }

    // Model selector
    if (this._refs.modelBtn) {
      const model = Config.findModel(this.stateValue("model"));
      this.tooltipDisposables.add(
        atom.tooltips.add(this._refs.modelBtn, {
          title: `Model: ${model.label} (click to choose, restarts process)`,
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
      if (!title) return;

      // Render multi-line tooltips (e.g. multi-selection details) with one entry per line.
      if (title.includes("\n")) {
        const html = title
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/\n/g, "<br>");
        this.tooltipDisposables.add(atom.tooltips.add(el, { title: html, html: true }));
      } else {
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
        this.setStateValue("isLoading", false);
        atom.notifications.addWarning("Session expired", {
          description: "The conversation was not found. Starting fresh.",
          dismissable: true,
        });
      }),
    );

    // Streaming text — throttled via requestAnimationFrame
    this.disposables.add(
      this.connection.on("delta", (text) => {
        if (!this.stateValue("isLoading")) return;
        if (!atom.config.get("claude-chat.streamingText")) return;
        this.pendingDelta += text;
        this.scheduleUpdate();
      }),
    );

    this.disposables.add(
      this.connection.on("thinking-delta", (text) => {
        if (!this.stateValue("isLoading")) return;
        this.pendingThinkingDelta += text;
        this.scheduleUpdate();
      }),
    );

    // Tool use
    this.disposables.add(
      this.connection.on("tool-use", ({ id, name, input }) => {
        // Deduplicate: assistant events replay all blocks cumulatively
        if (this.stateValue("messages").some((m) => m.role === "tool" && m.id === id)) return;

        // Flush buffered deltas and finalize pending content before adding tool
        if (this.pendingThinkingDelta) {
          this.setStateValue("currentThinking", this.stateValue("currentThinking") + this.pendingThinkingDelta);
          this.pendingThinkingDelta = "";
        }
        this.finalizeThinking();
        if (this.pendingDelta) {
          this.setStateValue("currentText", this.stateValue("currentText") + this.pendingDelta);
          this.pendingDelta = "";
        }
        const currentText = this.stateValue("currentText");
        if (currentText) {
          this.addMessage("assistant", currentText);
          this.setStateValue("currentText", "");
        }

        const collapsed =
          this.stateValue("defaultToolCollapsed") !== null
            ? this.stateValue("defaultToolCollapsed")
            : name !== "TodoWrite" && name !== "ToolSearch";

        this.setStateValue("messages", [
          ...this.stateValue("messages"),
          {
            role: "tool",
            id,
            name,
            input,
            result: null,
            collapsed,
            timestamp: new Date().toISOString(),
          },
        ]);
      }),
    );

    // Tool result
    this.disposables.add(
      this.connection.on("tool-result", ({ toolUseId, content, isError }) => {
        const msgs = this.stateValue("messages");
        const idx = msgs.findIndex((m) => m.role === "tool" && m.id === toolUseId);
        if (idx !== -1) {
          const newMsgs = [...msgs];
          newMsgs[idx] = { ...newMsgs[idx], result: content, isError };
          this.setStateValue("messages", newMsgs);
        }
      }),
    );

    // Result (response complete)
    this.disposables.add(
      this.connection.on("result", (resultText) => {
        // Flush any buffered thinking/text before finalizing
        if (this.pendingThinkingDelta) {
          this.setStateValue("currentThinking", this.stateValue("currentThinking") + this.pendingThinkingDelta);
          this.pendingThinkingDelta = "";
        }
        this.finalizeThinking();
        if (this.pendingDelta) {
          this.setStateValue("currentText", this.stateValue("currentText") + this.pendingDelta);
          this.pendingDelta = "";
        }
        const currentText = this.stateValue("currentText");
        log.debug("Response complete", {
          textLength: currentText?.length || resultText?.length || 0,
        });
        const finalText = currentText || resultText;
        if (finalText) {
          const message = this.addMessage("assistant", finalText);
          this.setStateValue("currentText", "");
          this.emitter.emit("did-receive-message", message);
        }
        this.setStateValue("isLoading", false);
        this.stopRequested = false;
        // The auto-scroll ResizeObserver re-pins to the bottom if the user hasn't
        // scrolled away, including after this finalize swaps in the rendered message.
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
        const prev = this.stateValue("tokenUsage");
        const input = usage.input ?? usage.input_tokens;
        const output = usage.output ?? usage.output_tokens;
        this.setStateValue("tokenUsage", {
          input: tokenCount(prev?.input) + tokenCount(input),
          output: tokenCount(prev?.output) + tokenCount(output),
        });
        this.setStateValue("tokenUsageAvailable", true);
      }),
    );

    this.disposables.add(
      this.connection.on("system", (event) => {
        if (SILENT_SYSTEM_SUBTYPES.has(event.subtype)) {
          return;
        }

        const content = this.formatSystemEvent(event);
        if (!content) return;

        this.addMessage("system", content, { subtype: event.subtype });
      }),
    );

    this.disposables.add(
      this.connection.on("system-status", ({ status, compactResult }) => {
        if (status === "compacting") {
          this.upsertCompactSystemMessage("running");
          return;
        } else if (compactResult === "success") {
          this.setStateValue("tokenUsage", { input: 0, output: 0 });
          this.setStateValue("tokenUsageAvailable", true);
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
        this.addMessage("error", error.message);
        this.setStateValue("isLoading", false);
        this.stopRequested = false;
        this.setStateValue("currentText", "");
        this.setStateValue("currentThinking", "");
      }),
    );

    // Exit
    this.disposables.add(
      this.connection.on("exit", (code) => {
        if (code !== 0 && this.stateValue("isLoading")) {
          this.setStateValue("isLoading", false);
          this.setStateValue("currentText", "");
          this.setStateValue("currentThinking", "");
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
        if (this.stickToBottom || this.isNearBottom()) {
          this.requestMessagesScrollToBottom();
        }
        this.setStateValue("pendingAnswers", null);
        this.setStateValue("pendingQuestionSelections", null);
        this.setStateValue("pendingPermission", request);
      }),
    );

    this.disposables.add(
      this.connection.on("control-cancel-request", ({ requestId }) => {
        if (this.stateValue("pendingPermission")?.requestId !== requestId) return;
        log.debug("Control request canceled", { requestId });
        this.setStateValue("pendingPermission", null);
        this.setStateValue("pendingAnswers", null);
        this.setStateValue("pendingQuestionSelections", null);
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
        this.setStateValue("hasEditorInput", !!this.promptEditor.getText().trim());
      }),
    );

    // Store element ref and attach it if React has already exposed the container.
    this._promptEditorElementRef.current = this.promptEditor.element;
    this.attachPromptEditorElement();
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
      atom.workspace.onDidAddPaneItem(({ item }) => {
        if (item === this) {
          this.subscribeToCurrentPane();
          this.restoreMessagesScrollPositionSoon();
        }
      }),
      atom.workspace.onDidChangeActivePaneItem((item) => {
        if (item === this) {
          this.subscribeToCurrentPane();
          this.restoreMessagesScrollPositionSoon();
          if (!this.element.contains(document.activeElement)) {
            requestAnimationFrame(() => this.focus());
          }
        }
      }),
    );
    this.subscribeToCurrentPane();
  }

  subscribeToCurrentPane() {
    const pane = atom.workspace.paneForItem(this);
    if (!pane || pane === this.observedPane) return;

    this.paneItemSubscription?.dispose();
    this.observedPane = pane;
    this.paneItemSubscription = pane.onWillRemoveItem(({ item, moved }) => {
      if (item !== this || !moved) return;
      this.rememberMessagesScrollPosition();
      this.paneMoveInProgress = true;
    });
  }

  restoreMessagesScrollPositionSoon() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.restoreMessagesScrollPosition();
        this.paneMoveInProgress = false;
      });
    });
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
    const usage = this.stateValue("tokenUsage") || {};
    if (!this.stateValue("tokenUsageAvailable") && this.stateValue("messages").length > 0) {
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
      const wasThinkingAtBottom = this.isThinkingAtBottom();
      if (this.pendingThinkingDelta) {
        this.setStateValue("currentThinking", this.stateValue("currentThinking") + this.pendingThinkingDelta);
        this.pendingThinkingDelta = "";
      }
      // When text starts arriving, finalize thinking as a message
      if (this.pendingDelta && this.stateValue("currentThinking")) {
        this.finalizeThinking();
      }
      if (this.pendingDelta) {
        this.setStateValue("currentText", this.stateValue("currentText") + this.pendingDelta);
        this.pendingDelta = "";
      }
      // The outer message list is pinned by the auto-scroll ResizeObserver. Here we
      // only keep the streaming thinking block's own scroll box at the bottom.
      if (this.stateValue("currentThinking") && wasThinkingAtBottom) {
        this.shouldScrollStreamingThinkingToBottom = true;
      }
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

  requestMessagesScrollToBottom() {
    this.stickToBottom = true;
    this.savedMessagesScrollTop = 0;
    this.savedMessagesScrollAnchor = null;
    this.shouldScrollMessagesToBottom = true;
  }

  flushPendingMessagesScroll() {
    if (!this.shouldScrollMessagesToBottom) return;
    this.shouldScrollMessagesToBottom = false;
    this.scrollToBottom();
  }

  flushPendingThinkingScroll() {
    if (this.shouldScrollLatestThinkingToBottom) {
      this.shouldScrollLatestThinkingToBottom = false;
      this.scrollLatestThinkingToBottom();
    }
    if (this.shouldScrollStreamingThinkingToBottom) {
      this.shouldScrollStreamingThinkingToBottom = false;
      this.scrollStreamingThinkingToBottom();
    }
  }

  scrollStreamingThinkingToBottom() {
    const el = this.element.querySelector(".thinking-streaming .thinking-content");
    if (el) el.scrollTop = el.scrollHeight;
  }

  scrollLatestThinkingToBottom() {
    const els = this.element.querySelectorAll(".message-thinking .thinking-content");
    const el = els[els.length - 1];
    if (el) el.scrollTop = el.scrollHeight;
  }

  rememberMessagesScrollPosition(container = this._refs.messagesContainer) {
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    this.stickToBottom = nearBottom;
    this.savedMessagesScrollTop = nearBottom ? 0 : container.scrollTop;
    this.savedMessagesScrollAnchor = nearBottom ? null : this.captureMessagesScrollAnchor(container);
  }

  restoreMessagesScrollPosition() {
    const container = this._refs.messagesContainer;
    if (!container) return;
    if (this.stickToBottom) {
      this.scrollToBottom();
    } else if (this.restoreMessagesScrollAnchor(container)) {
      return;
    } else if (this.savedMessagesScrollTop > 0) {
      container.scrollTop = Math.min(
        this.savedMessagesScrollTop,
        Math.max(0, container.scrollHeight - container.clientHeight),
      );
    }
  }

  captureMessagesScrollAnchor(container = this._refs.messagesContainer) {
    if (!container) return null;
    const containerTop = container.getBoundingClientRect().top;
    const anchors = Array.from(container.querySelectorAll("[data-message-anchor]"));
    if (anchors.length === 0) return null;

    let best = anchors[0];
    let bestDistance = Infinity;
    for (const anchor of anchors) {
      const rect = anchor.getBoundingClientRect();
      const distance = Math.abs(rect.top - containerTop);
      if (rect.bottom >= containerTop && distance < bestDistance) {
        best = anchor;
        bestDistance = distance;
      }
    }

    return {
      id: best.getAttribute("data-message-anchor"),
      offsetTop: best.getBoundingClientRect().top - containerTop,
    };
  }

  restoreMessagesScrollAnchor(container = this._refs.messagesContainer) {
    const anchor = this.savedMessagesScrollAnchor;
    if (!container || !anchor?.id) return false;
    const target = container.querySelector(`[data-message-anchor="${anchor.id}"]`);
    if (!target) return false;

    const containerTop = container.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    container.scrollTop += targetTop - containerTop - anchor.offsetTop;
    return true;
  }

  scrollToBottom() {
    const container = this._refs.messagesContainer;
    if (container) container.scrollTop = container.scrollHeight;
  }

  // Re-pin to the bottom and resume sticking there. Use for actions where the
  // user expects to jump to the latest content (sending, loading a session).
  pinToBottom() {
    this.stickToBottom = true;
    this.savedMessagesScrollTop = 0;
    this.savedMessagesScrollAnchor = null;
    this.scrollToBottom();
  }

  // Keep the message list glued to the bottom as its content height changes.
  // A ResizeObserver on the content wrapper re-pins on every layout change
  // (streaming text, rendered markdown, syntax highlighting, image loads) while
  // stickToBottom is set; a scroll listener clears the flag when the user
  // scrolls away from the bottom and restores it when they return. This replaces
  // the old per-event "measure isNearBottom then scroll in a microtask" pattern.
  setupAutoScroll() {
    const container = this._refs.messagesContainer;
    const content = this._refs.messagesContent;
    if (!container || !content || this._resizeObserver) return;
    this.restoreMessagesScrollPosition();

    this._resizeObserver = new ResizeObserver(() => {
      if (this.stickToBottom) this.scrollToBottom();
    });
    // Observe the content (grows as messages/streaming/highlighting render) and the
    // container (shrinks when the queue zone or input area grows, or on resize).
    this._resizeObserver.observe(content);
    this._resizeObserver.observe(container);

    this._onMessagesScroll = () => {
      if (this.paneMoveInProgress) return;
      this.stickToBottom = this.isNearBottom();
      this.savedMessagesScrollTop = this.stickToBottom ? 0 : container.scrollTop;
      this.savedMessagesScrollAnchor = this.stickToBottom
        ? null
        : this.captureMessagesScrollAnchor(container);
    };
    container.addEventListener("scroll", this._onMessagesScroll, { passive: true });
  }

  teardownAutoScroll() {
    const container = this._refs.messagesContainer;
    this.rememberMessagesScrollPosition(container);
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._onMessagesScroll && container) {
      container.removeEventListener("scroll", this._onMessagesScroll);
    }
    this._onMessagesScroll = null;
    if (this.scrollAnimationFrame) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = null;
      this.scrollAnimationTarget = null;
    }
  }

  scrollPage(direction) {
    const container = this._refs.messagesContainer;
    if (!container) return;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const start = this.scrollAnimationTarget ?? container.scrollTop;
    this.scrollAnimationTarget = Math.max(
      0,
      Math.min(maxScrollTop, start + direction * container.clientHeight * 0.25),
    );
    if (this.scrollAnimationFrame) return;

    const animate = () => {
      const target = this.scrollAnimationTarget;
      const delta = target - container.scrollTop;
      if (Math.abs(delta) < 1) {
        container.scrollTop = target;
        this.scrollAnimationFrame = null;
        this.scrollAnimationTarget = null;
        return;
      }

      container.scrollTop += delta * 0.2;
      this.scrollAnimationFrame = requestAnimationFrame(animate);
    };

    this.scrollAnimationFrame = requestAnimationFrame(animate);
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
    const messages = this.stateValue("messages");

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
      this.setStateValue("messages", [...messages, nextMessage]);
    } else {
      const nextMessages = [...messages];
      nextMessages[existingIndex] = { ...nextMessages[existingIndex], ...nextMessage };
      this.setStateValue("messages", nextMessages);
    }

    if (status !== "running") {
      this.activeCompactSystemMessageId = null;
    }
  }

  updateCompactSystemMessageDetails({ preTokens, trigger }) {
    const messages = this.stateValue("messages");
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
    this.setStateValue("messages", nextMessages);
  }

  formatSystemEvent(event) {
    if (!event) return "";

    const subtype = event.subtype || "system";
    if (subtype === "api_retry") {
      return this.formatApiRetrySystemEvent(event);
    }

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

  formatApiRetrySystemEvent(event) {
    const attempt = Number.isFinite(event.attempt) ? event.attempt : null;
    const maxRetries = Number.isFinite(event.max_retries) ? event.max_retries : null;
    const status = event.error_status ? ` (${event.error_status})` : "";
    const error = `${this.formatApiRetryError(event.error)}${status}`;
    const delay = this.formatApiRetryDelay(event.retry_delay_ms);
    const progress =
      attempt !== null && maxRetries !== null
        ? ` ${attempt}/${maxRetries}`
        : attempt !== null
          ? ` ${attempt}`
          : "";

    return `API retry${progress}: ${error}.${delay ? ` Retrying in ${delay}.` : ""}`;
  }

  formatApiRetryError(error) {
    switch (error) {
      case "authentication_failed":
        return "authentication failed";
      case "server_error":
        return "server error";
      case undefined:
      case null:
      case "":
        return "API request failed";
      default:
        return String(error).replace(/_/g, " ");
    }
  }

  formatApiRetryDelay(delayMs) {
    if (typeof delayMs !== "number" || !Number.isFinite(delayMs)) return "";
    if (delayMs < 1000) return `${Math.round(delayMs)} ms`;

    const seconds = delayMs / 1000;
    return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, "") : Math.round(seconds)} s`;
  }

  // ============================================================================
  // Tool Interaction
  // ============================================================================

  toggleToolCollapse(id) {
    const msgs = this.stateValue("messages");
    const idx = msgs.findIndex((m) => (m.role === "tool" || m.role === "thinking") && m.id === id);
    if (idx !== -1) {
      const newMsgs = [...msgs];
      newMsgs[idx] = { ...newMsgs[idx], collapsed: !newMsgs[idx].collapsed };
      this.setStateValue("messages", newMsgs);
    }
  }

  expandAllTools() {
    this.setStateValue("defaultToolCollapsed", false);
    this.setStateValue(
      "messages",
      this.stateValue("messages").map((m) =>
        m.role === "tool" || m.role === "thinking" ? { ...m, collapsed: false } : m,
      ),
    );
  }

  collapseAllTools() {
    this.setStateValue("defaultToolCollapsed", true);
    this.setStateValue(
      "messages",
      this.stateValue("messages").map((m) =>
        m.role === "tool" || m.role === "thinking" ? { ...m, collapsed: true } : m,
      ),
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
    const existing = this.stateValue("attachContext");
    // Skip paths that are already attached so re-selecting in the tree view is a no-op.
    if (
      context.type === "paths" &&
      context.path &&
      existing.some((c) => c.type === "paths" && c.path === context.path)
    ) {
      return;
    }
    this.setStateValue("attachContext", [...existing, context]);
  }

  clearAttachContext() {
    this.setStateValue("attachContext", []);
  }

  removeAttachContext(index) {
    this.setStateValue(
      "attachContext",
      this.stateValue("attachContext").filter((_, i) => i !== index),
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

    this.setStateValue("pastedImages", [...this.stateValue("pastedImages"), image]);
  }

  removePastedImage(index) {
    this.setStateValue(
      "pastedImages",
      this.stateValue("pastedImages").filter((_, i) => i !== index),
    );
  }

  clearPastedImages() {
    this.setStateValue("pastedImages", []);
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
      const filePath = path || paths?.[0];
      return [
        "<attachment>",
        "type: path",
        `path: ${filePath}`,
        "instruction: The user is referring to this path. Use the Read tool if file " +
          "contents are needed.",
        "</attachment>",
      ].join("\n");
    }
    return "";
  }

  formatAttachContext(attachments = this.stateValue("attachContext")) {
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
      frozen: false,
      timestamp: new Date().toISOString(),
    };
  }

  queueMessage(content, attach = [], images = []) {
    if (!content && attach.length === 0 && images.length === 0) return false;

    const queuedMessage = this.createQueuedMessage(content, attach, images);
    this.setStateValue("queuedMessages", [...this.stateValue("queuedMessages"), queuedMessage]);
    // Adding to the queue shrinks the message viewport; the auto-scroll observer
    // re-pins to the bottom if the user hasn't scrolled away.
    return true;
  }

  isTurnBusy() {
    return this.stateValue("isLoading") || this.stopRequested;
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
    // The user just sent a message: jump to the bottom and stay there as the
    // response streams in (the auto-scroll observer handles the rest).
    this.stickToBottom = true;
    this.savedMessagesScrollTop = 0;
    this.savedMessagesScrollAnchor = null;
    this.setStateValue("messages", [...this.stateValue("messages"), message]);
    this.setStateValue("isLoading", true);
    this.setStateValue("currentText", "");
    this.setStateValue("currentThinking", "");
    this.connection.send(fullMessage);
    return true;
  }

  sendNextQueuedMessage() {
    if (this.isTurnBusy()) return false;

    const queuedMessages = this.stateValue("queuedMessages");
    // Frozen messages are held in the queue and never sent automatically; the user
    // must unfreeze them or send them explicitly via the steer button.
    const nextIndex = queuedMessages.findIndex((message) => !message.frozen);
    if (nextIndex === -1) return false;

    const nextMessage = queuedMessages[nextIndex];
    this.setStateValue("queuedMessages", queuedMessages.filter((_, i) => i !== nextIndex));
    return this.sendMessageNow(nextMessage);
  }

  toggleQueuedMessageFreeze(id) {
    this.setStateValue(
      "queuedMessages",
      this.stateValue("queuedMessages").map((message) =>
        message.id === id ? { ...message, frozen: !message.frozen } : message,
      ),
    );
  }

  deleteQueuedMessage(id) {
    this.setStateValue(
      "queuedMessages",
      this.stateValue("queuedMessages").filter((message) => message.id !== id),
    );
  }

  reorderQueuedMessage(draggedId, targetId, position = "before") {
    if (!draggedId || !targetId || draggedId === targetId) return false;

    const queuedMessages = this.stateValue("queuedMessages");
    const draggedIndex = queuedMessages.findIndex((message) => message.id === draggedId);
    const targetIndex = queuedMessages.findIndex((message) => message.id === targetId);
    if (draggedIndex === -1 || targetIndex === -1) return false;

    const nextMessages = [...queuedMessages];
    const [draggedMessage] = nextMessages.splice(draggedIndex, 1);
    let insertIndex = nextMessages.findIndex((message) => message.id === targetId);
    if (insertIndex === -1) return false;
    if (position === "after") insertIndex += 1;

    nextMessages.splice(insertIndex, 0, draggedMessage);
    this.setStateValue("queuedMessages", nextMessages);
    return true;
  }

  // Send a queued message immediately. If a turn is in progress, the message is
  // injected into the running session (steering) without disturbing the live
  // streaming state; otherwise it starts a normal turn.
  steerQueuedMessage(id) {
    const queuedMessages = this.stateValue("queuedMessages");
    const message = queuedMessages.find((queued) => queued.id === id);
    if (!message) return false;

    this.setStateValue("queuedMessages", queuedMessages.filter((queued) => queued.id !== id));

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

    this.stickToBottom = true;
    this.savedMessagesScrollTop = 0;
    this.savedMessagesScrollAnchor = null;
    this.setStateValue("messages", [...this.stateValue("messages"), transcriptMessage]);
    this.connection.send(fullMessage);
    return true;
  }

  moveQueuedMessageToPrompt(id) {
    const queuedMessages = this.stateValue("queuedMessages");
    const message = queuedMessages.find((queued) => queued.id === id);
    if (!message) return;

    this.setStateValue("queuedMessages", queuedMessages.filter((queued) => queued.id !== id));

    const existingText = this.promptEditor?.getText() || "";
    const nextText = existingText.trim()
      ? `${existingText.replace(/\s+$/, "")}\n\n${message.content}`
      : message.content;
    this.promptEditor?.setText(nextText);
    this.setStateValue("attachContext", [
      ...this.stateValue("attachContext"),
      ...(message.attach || []),
    ]);
    this.setStateValue("pastedImages", [
      ...this.stateValue("pastedImages"),
      ...(message.images || []),
    ]);
    this.focus();
  }

  // ============================================================================
  // Send/Stop Handlers
  // ============================================================================

  sendPrompt(text, attachContext = null) {
    const attachments = [
      ...this.stateValue("attachContext"),
      ...(attachContext ? [attachContext] : []),
    ];
    const images = this.stateValue("pastedImages");
    if (!text && attachments.length === 0 && images.length === 0) return false;

    log.debug(this.isTurnBusy() ? "Queueing prompt" : "Sending prompt", {
      length: text?.length || 0,
      hasAttach: attachments.length > 0,
      hasImages: images.length > 0,
    });

    if (this.isTurnBusy()) {
      const queued = this.queueMessage(text, attachments, images);
      if (queued) {
        this.setStateValue("attachContext", []);
        this.clearPastedImages();
      }
      return queued;
    }

    this.setStateValue("attachContext", []);
    this.clearPastedImages();
    this.sendMessageNow({ content: text, attach: attachments, images });
    return true;
  }

  handleSend() {
    const text = this.promptEditor.getText().trim();
    const attachments = this.stateValue("attachContext");
    const images = this.stateValue("pastedImages");
    if (!text && attachments.length === 0 && images.length === 0) return;

    // When an AskUserQuestion prompt is pending, treat the typed text as the
    // "Other" answer to the next unanswered question instead of queueing it.
    const perm = this.stateValue("pendingPermission");
    if (text && perm && (perm.toolName === "AskUserQuestion" || perm.toolName === "Question")) {
      const questions = perm.input?.questions || [];
      const answered = this.stateValue("pendingAnswers") || {};
      const next = questions.find((q) => !answered[q.question]);
      if (next) {
        this.promptEditor.setText("");
        this.handleQuestionAnswer(next.question, text);
        this.focus();
        return;
      }
    }

    this.promptEditor.setText("");
    this.setStateValue("attachContext", []);
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
    this.setStateValue("isLoading", false);
    this.setStateValue("currentText", "");
    this.setStateValue("currentThinking", "");
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
    this.setStateValue("messages", []);
    this.setStateValue("queuedMessages", []);
  }

  handlePermissionModeChange(mode) {
    if (this.stateValue("permissionMode") === mode) return;
    if (this.stateValue("permissionMode") === "bypassPermissions") return;

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

    this.setStateValue("permissionMode", mode);
  }

  cycleEffortMode() {
    const modes = Config.effortModes;
    const currentIndex = modes.findIndex((m) => m.value === this.stateValue("effortMode"));
    const nextIndex = (currentIndex + 1) % modes.length;
    this.setStateValue("effortMode", modes[nextIndex].value);
    if (this.connection.isRunning()) {
      this.connection.setEffortMode(this.stateValue("effortMode"));
    }
  }

  openModelSelector() {
    atom.commands.dispatch(this.element, "claude-chat:model-selector");
  }

  selectModel(model) {
    if (!model || this.stateValue("model") === model) return;
    this.setStateValue("model", model);
    this.connection.model = model;
    this.queueDisconnect();
  }

  handlePermissionAccept(permissions) {
    if (!this.stateValue("pendingPermission")) return;
    const { requestId, input } = this.stateValue("pendingPermission");
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
    this.setStateValue("pendingPermission", null);
    this.setStateValue("pendingAnswers", null);
    this.setStateValue("pendingQuestionSelections", null);
  }

  handlePermissionAcceptEdited() {
    if (!this.stateValue("pendingPermission")) return;

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

    const { requestId } = this.stateValue("pendingPermission");
    this.promptEditor.setText("");
    this.connection.respondToPermission(requestId, "allow", { input });
    this.setStateValue("pendingPermission", null);
    this.setStateValue("pendingAnswers", null);
    this.setStateValue("pendingQuestionSelections", null);
  }

  handlePermissionDeny() {
    if (!this.stateValue("pendingPermission")) return;
    const { requestId } = this.stateValue("pendingPermission");
    this.connection.respondToPermission(requestId, "deny", {
      message: "User denied permission",
    });
    this.setStateValue("pendingPermission", null);
    this.setStateValue("pendingAnswers", null);
    this.setStateValue("pendingQuestionSelections", null);
  }

  handlePermissionDenyWithReason() {
    if (!this.stateValue("pendingPermission")) return;

    const message = this.promptEditor?.getText()?.trim();
    if (!message) {
      this.focus();
      return;
    }

    const { requestId } = this.stateValue("pendingPermission");
    this.promptEditor.setText("");
    this.connection.respondToPermission(requestId, "deny", { message });
    this.setStateValue("pendingPermission", null);
    this.setStateValue("pendingAnswers", null);
    this.setStateValue("pendingQuestionSelections", null);
  }

  applyPermissionSuggestions(permissions) {
    const modeChange = permissions.find((p) => p.type === "setMode" && p.mode);
    if (modeChange) {
      if (modeChange.mode === "bypassPermissions") {
        this.toggleBypassMode();
        return;
      }
      this.setStateValue("permissionMode", modeChange.mode);
      this.connection.permissionMode = modeChange.mode;
    }
  }

  /**
   * Handle answering a single question in an AskUserQuestion prompt.
   */
  handleQuestionAnswer(questionText, answer) {
    if (!this.stateValue("pendingPermission")) return;

    if (!this.stateValue("pendingAnswers")) this.setStateValue("pendingAnswers", {});
    this.setStateValue("pendingAnswers", {
      ...this.stateValue("pendingAnswers"),
      [questionText]: answer,
    });

    const { requestId, input } = this.stateValue("pendingPermission");
    const questions = input?.questions || [];

    const allAnswered = questions.every((q) => this.stateValue("pendingAnswers")[q.question]);
    if (!allAnswered) return;

    const answers = { ...this.stateValue("pendingAnswers") };
    const updatedInput = { ...input, answers };
    log.debug("Question answer", { answers, updatedInput });

    // Store answers on the tool message so the renderer can show them
    const msgs = this.stateValue("messages");
    const idx = msgs.findIndex(
      (m) =>
        m.role === "tool" && (m.name === "AskUserQuestion" || m.name === "Question") && !m.answers,
    );
    if (idx !== -1) {
      const newMsgs = [...msgs];
      newMsgs[idx] = { ...newMsgs[idx], answers };
      this.setStateValue("messages", newMsgs);
    }

    this.connection.respondToPermission(requestId, "allow", { input: updatedInput });
    this.setStateValue("pendingPermission", null);
    this.setStateValue("pendingAnswers", null);
    this.setStateValue("pendingQuestionSelections", null);
  }

  handleQuestionMultiToggle(questionText, answer) {
    if (!this.stateValue("pendingPermission")) return;

    const current = this.stateValue("pendingQuestionSelections") || {};
    const values = (current[questionText] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const nextValues = values.includes(answer)
      ? values.filter((value) => value !== answer)
      : [...values, answer];

    this.setStateValue("pendingQuestionSelections", {
      ...current,
      [questionText]: nextValues.join(", "),
    });
  }

  handleQuestionSubmit(questionText) {
    const answer = this.stateValue("pendingQuestionSelections")?.[questionText];
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
      this.stateValue("messages").length === 0 &&
      this.stateValue("queuedMessages").length === 0 &&
      !this.stateValue("isLoading") &&
      !this.sessionId
    );
  }

  loadSession(sessionData) {
    this.setStateValue(
      "messages",
      (sessionData.messages || []).filter((message) => !isSilentSystemMessage(message)),
    );
    this.setStateValue("queuedMessages", []);
    this.sessionId = sessionData.sessionId;
    this.projectPaths = sessionData.projectPaths || atom.project.getPaths();
    this.createdAt = sessionData.createdAt || new Date().toISOString();
    this.setStateValue("tokenUsage", sessionData.tokenUsage || { input: 0, output: 0 });
    this.setStateValue("tokenUsageAvailable", hasTokenUsage(sessionData.tokenUsage));
    this.connection.sessionId = this.sessionId;
    // Jump to the latest message; the auto-scroll observer keeps us pinned as the
    // loaded content (markdown, highlighting) lays out.
    this.stickToBottom = true;
    this.savedMessagesScrollTop = 0;
    this.savedMessagesScrollAnchor = null;
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
    this.teardownAutoScroll();
    await this.saveCurrentSession();
    this.connection?.destroy();
    this.paneItemSubscription?.dispose();
    this.paneItemSubscription = null;
    this.observedPane = null;
    this.paneMoveInProgress = false;
    this.disposables?.dispose();
    this.tooltipDisposables?.dispose();
    this.emitter?.dispose();
    this.promptEditor?.destroy();
    this._reactRoot?.unmount();
    this._reactRoot = null;
    this._setReactState = null;
  }

  async saveCurrentSession() {
    const messages = this.stateValue("messages").filter(
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
        tokenUsage: this.stateValue("tokenUsageAvailable")
          ? this.stateValue("tokenUsage")
          : { input: null, output: null },
      });
    } catch (err) {
      console.error("Failed to save session:", err);
    }
  }

  saveCurrentSessionSync() {
    const messages = this.stateValue("messages").filter(
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
        tokenUsage: this.stateValue("tokenUsageAvailable")
          ? this.stateValue("tokenUsage")
          : { input: null, output: null },
      });
    } catch (err) {
      console.error("Failed to save session (sync):", err);
    }
  }
}

// ============================================================================
// React Components
// ============================================================================

/**
 * Render the current streaming response.
 */
function StreamingArea({ currentText, currentThinking, isLoading }) {
  return renderStreamingMessage(currentText, currentThinking, isLoading);
}

/**
 * Isolates permission/question prompt re-renders.
 */
function PermissionArea({
  pendingPermission,
  pendingAnswers,
  pendingQuestionSelections,
  hasEditorInput,
  callbacks,
}) {
  if (!pendingPermission) return null;

  const { toolName, input, suggestions } = pendingPermission;

  if (toolName === "AskUserQuestion" || toolName === "Question") {
    return (
      <QuestionPrompt
        input={input}
        pendingAnswers={pendingAnswers}
        pendingQuestionSelections={pendingQuestionSelections}
        callbacks={callbacks}
      />
    );
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

function QuestionPrompt({ input, pendingAnswers, pendingQuestionSelections, callbacks }) {
  const questions = input?.questions || [];
  const partial = pendingAnswers || {};
  const draftSelections = pendingQuestionSelections || {};
  if (questions.length === 0) return null;

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

function QueuedMessagesArea({ queuedMessages, callbacks }) {
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
              message.frozen ? "queued-message-frozen" : "",
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
                className={[
                  "btn queued-message-action icon icon-lock",
                  message.frozen ? "queued-message-action-frozen" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-tooltip={
                  message.frozen ? "Unfreeze (resume auto-send)" : "Freeze (hold in queue)"
                }
                onClick={() => callbacks.handleQueuedMessageFreeze(message.id)}
              />
              <button
                className="btn queued-message-action icon icon-arrow-up"
                data-tooltip="Send now (steer)"
                onClick={() => callbacks.handleQueuedMessageSteer(message.id)}
              />
              <button
                className="btn queued-message-action icon icon-pencil"
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
 * Root React component. Replaces the old render() method.
 */
function ChatApp({ initialState, callbacks }) {
  const [state, setState] = useState(initialState);
  const messagesContainerRef = useRef(null);
  const messagesContentRef = useRef(null);
  const editorContainerRef = useRef(null);
  const sendBtnRef = useRef(null);
  const stopBtnRef = useRef(null);
  const effortModeRef = useRef(null);
  const modelBtnRef = useRef(null);
  const permBtnRefs = useRef({});

  useLayoutEffect(() => {
    callbacks.onReactStateReady(setState);
  }, [callbacks]);

  // Expose DOM refs back to the class shell after every render
  useLayoutEffect(() => {
    callbacks.onRefsReady({
      messagesContainer: messagesContainerRef.current,
      messagesContent: messagesContentRef.current,
      editorContainer: editorContainerRef.current,
      sendBtn: sendBtnRef.current,
      stopBtn: stopBtnRef.current,
      effortMode: effortModeRef.current,
      modelBtn: modelBtnRef.current,
      permissionBtns: permBtnRefs.current,
    });
  });

  const {
    currentText,
    currentThinking,
    isLoading,
    messages,
    pendingPermission,
    pendingAnswers,
    pendingQuestionSelections,
    attachContext,
    pastedImages,
    permissionMode,
    effortMode,
    model,
    tokenUsage,
    tokenUsageAvailable,
    hasEditorInput,
    queuedMessages,
  } = state;

  const hasStreamingTimeline = !!(currentText || currentThinking);
  const isBusy = isLoading || hasStreamingTimeline;
  const isEmpty =
    messages.length === 0 &&
    queuedMessages.length === 0 &&
    !isBusy &&
    !pendingPermission;

  const effortModes = Config.effortModes;
  const currentEffort = effortModes.find((m) => m.value === effortMode) || effortModes[1];

  const currentModel = Config.findModel(model);

  const showStop =
    isLoading && !hasEditorInput && attachContext.length === 0 && pastedImages.length === 0;
  const isBypassMode = permissionMode === "bypassPermissions";
  const usage = tokenUsage || {};
  const hasTokenUsageValue = tokenUsageAvailable && (usage.input != null || usage.output != null);
  const tokenUsageTokens = tokenCount(usage.input) + tokenCount(usage.output);
  const tokenUsageText = hasTokenUsageValue ? formatTokenCount(tokenUsageTokens) : "--";

  return (
    <div className="claude-chat" tabIndex="-1">
      <div className="claude-chat-messages" ref={messagesContainerRef}>
        <div className="claude-chat-messages-content" ref={messagesContentRef}>
          {isEmpty ? renderWelcomePage() : null}
          {!isEmpty
            ? renderMessages(messages, callbacks.toolHandlers, hasStreamingTimeline, {
                openPastedImage: callbacks.openPastedImage,
              })
            : null}
          <StreamingArea
            currentText={currentText}
            currentThinking={currentThinking}
            isLoading={isLoading}
          />
          <PermissionArea
            pendingPermission={pendingPermission}
            pendingAnswers={pendingAnswers}
            pendingQuestionSelections={pendingQuestionSelections}
            hasEditorInput={hasEditorInput}
            callbacks={callbacks}
          />
        </div>
      </div>
      <div className="claude-chat-queue-zone">
        <QueuedMessagesArea queuedMessages={queuedMessages} callbacks={callbacks} />
      </div>
      <div className="claude-chat-input">
        {attachContext.length > 0 ? (
          <div className="attach-tray">
            {attachContext.map((ctx, i) => {
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
                tooltipText = `Path: ${ctx.path || ctx.paths?.[0]}`;
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
          images={pastedImages}
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
              <span
                className={`effort-dot${i < currentEffort.dots ? " active" : ""}`}
                key={i}
              />
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
              className="model-selector"
              onMouseDown={(e) => e.preventDefault()}
              onClick={callbacks.openModelSelector}
            >
              {currentModel.label}
            </span>
            <div className={`btn-group permission-mode ${isBypassMode ? "disabled" : ""}`}>
              {Config.permissionModes.map((mode) => (
                <button
                  key={mode.value}
                  ref={(el) => {
                    if (el) permBtnRefs.current[`permission-${mode.value}`] = el;
                  }}
                  className={`btn icon icon-${mode.icon} ${
                    mode.value === permissionMode ? "selected" : ""
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

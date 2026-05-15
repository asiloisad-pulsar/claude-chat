/** @babel */
/** @jsx h */

import { h, render } from "preact";
import { useRef, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { CompositeDisposable, Emitter, Disposable } from "atom";
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
    const summary = values
      .filter(Boolean)
      .map((rule) => (typeof rule === "string" ? rule : JSON.stringify(rule)))
      .join(", ");
    return summary ? `Add ${behavior} rule: ${summary}` : `Add ${behavior} rule.`;
  }

  return JSON.stringify(update);
}

export default class ChatPanel {
  static URI_PREFIX = URI_PREFIX;

  constructor(props = {}) {
    log.debug("Creating ChatPanel", {
      sessionId: props.sessionId,
      messagesCount: props.messages?.length || 0,
    });
    this.props = props;
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
      permissionMode: signal(props.permissionMode || Config.permissionMode()),
      effortMode: signal(props.effortMode || Config.effortMode()),
      tokenUsage: signal(props.tokenUsage || { input: 0, output: 0 }),
      defaultToolCollapsed: signal(null),
      hasEditorInput: signal(false),
    };

    // Create connection
    this.connection = new ClaudeConnection({
      sessionId: this.sessionId,
      permissionMode: this.signals.permissionMode.value,
      effortMode: this.signals.effortMode.value,
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
      clearAttachContext: () => this.clearAttachContext(),
      removeAttachContext: (index) => this.removeAttachContext(index),
      cycleEffortMode: () => this.cycleEffortMode(),
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
        queueMicrotask(() => {
          if (wasNearBottom) this.scrollToBottom();
        });
      }),
    );

    // Usage
    this.disposables.add(
      this.connection.on("usage", (usage) => {
        const prev = this.signals.tokenUsage.value;
        this.signals.tokenUsage.value = {
          input: prev.input + usage.input,
          output: prev.output + usage.output,
        };
      }),
    );

    // Error
    this.disposables.add(
      this.connection.on("error", (error) => {
        const wasNearBottom = this.isNearBottom();
        this.addMessage("error", error.message);
        this.signals.isLoading.value = false;
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
  }

  // ============================================================================
  // Editor Setup
  // ============================================================================

  setupEditor() {
    this.promptEditor = atom.workspace.buildTextEditor({
      mini: false,
      softWrapped: true,
      autoHeight: false,
      lineNumberGutterVisible: false,
      placeholderText: "Ask Claude something...",
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
    const { input, output } = this.signals.tokenUsage.value;
    const total = input + output;
    atom.notifications.addInfo("Token Usage", {
      detail: `Input: ${input.toLocaleString()}\nOutput: ${output.toLocaleString()}\nTotal: ${total.toLocaleString()}`,
      dismissable: true,
    });
  }

  sendSlashCommand(command) {
    const prompt = `/${command}`;
    const wasNearBottom = this.isNearBottom();
    this.signals.messages.value = [
      ...this.signals.messages.value,
      { role: "user", content: prompt, timestamp: new Date().toISOString() },
    ];
    this.signals.isLoading.value = true;
    this.signals.currentText.value = "";
    this.signals.currentThinking.value = "";
    queueMicrotask(() => {
      if (wasNearBottom) this.scrollToBottom();
    });
    this.connection.send(prompt);
    this.focus();
  }

  scheduleUpdate() {
    if (this.updateScheduled) return;
    this.updateScheduled = true;

    requestAnimationFrame(() => {
      this.updateScheduled = false;
      if (!this.pendingDelta && !this.pendingThinkingDelta) return;
      const wasNearBottom = this.isNearBottom();
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
        if (this.signals.currentThinking.value) {
          const el = this.element.querySelector(".thinking-streaming .thinking-content");
          if (el) el.scrollTop = el.scrollHeight;
        }
      });
    });
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

  formatAttachContext() {
    const attachments = this.signals.attachContext.value;
    if (!attachments || attachments.length === 0) return "";

    const parts = attachments.map((attach) => this.formatSingleAttach(attach)).filter(Boolean);
    if (parts.length === 0) return "";

    return `<attachments>\n${parts.join("\n\n")}\n</attachments>\n\n`;
  }

  // ============================================================================
  // Send/Stop Handlers
  // ============================================================================

  sendPrompt(text, attachContext = null) {
    const attachments = this.signals.attachContext.value;
    if (!text && !attachContext && attachments.length === 0) return false;

    log.debug("Sending prompt", {
      length: text?.length || 0,
      hasAttach: !!attachContext || attachments.length > 0,
    });

    if (attachContext) {
      this.signals.attachContext.value = [...attachments, attachContext];
    }

    const attachPrefix = this.formatAttachContext();
    const fullMessage = attachPrefix + text;

    const currentAttachments = this.signals.attachContext.value;
    const message = { role: "user", content: text, timestamp: new Date().toISOString() };
    if (currentAttachments.length > 0) message.attach = [...currentAttachments];

    const wasNearBottom = this.isNearBottom();
    this.signals.messages.value = [...this.signals.messages.value, message];
    this.signals.isLoading.value = true;
    this.signals.currentText.value = "";
    this.signals.currentThinking.value = "";
    this.signals.attachContext.value = [];
    queueMicrotask(() => {
      if (wasNearBottom) this.scrollToBottom();
    });
    this.connection.send(fullMessage);

    return true;
  }

  handleSend() {
    const text = this.promptEditor.getText().trim();
    const attachments = this.signals.attachContext.value;
    if (!text && attachments.length === 0) return;

    const attachPrefix = this.formatAttachContext();
    const fullMessage = attachPrefix + text;

    const message = { role: "user", content: text, timestamp: new Date().toISOString() };
    if (attachments.length > 0) message.attach = [...attachments];

    this.promptEditor.setText("");
    const wasNearBottom = this.isNearBottom();
    this.signals.messages.value = [...this.signals.messages.value, message];
    this.signals.isLoading.value = true;
    this.signals.currentText.value = "";
    this.signals.currentThinking.value = "";
    this.signals.attachContext.value = [];
    queueMicrotask(() => {
      if (wasNearBottom) this.scrollToBottom();
    });
    this.connection.send(fullMessage);
    this.focus();
  }

  handleStop() {
    if (this.connection.isRunning()) {
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
  }

  focusActiveEditor() {
    const editor = atom.workspace.getActiveTextEditor();
    if (editor) {
      atom.views.getView(editor).focus();
    }
  }

  clearMessages() {
    this.signals.messages.value = [];
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
      this.signals.messages.value.length === 0 && !this.signals.isLoading.value && !this.sessionId
    );
  }

  loadSession(sessionData) {
    this.signals.messages.value = sessionData.messages || [];
    this.sessionId = sessionData.sessionId;
    this.projectPaths = sessionData.projectPaths || atom.project.getPaths();
    this.createdAt = sessionData.createdAt || new Date().toISOString();
    this.signals.tokenUsage.value = sessionData.tokenUsage || { input: 0, output: 0 };
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
    const messages = this.signals.messages.value;
    if (!this.sessionId || messages.length === 0) return;

    const firstUserMsg = messages.find((m) => m.role === "user");
    try {
      await saveSession({
        sessionId: this.sessionId,
        projectPaths: this.projectPaths,
        createdAt: this.createdAt,
        firstMessage: firstUserMsg?.content || "",
        messages,
        tokenUsage: this.signals.tokenUsage.value,
      });
    } catch (err) {
      console.error("Failed to save session:", err);
    }
  }

  saveCurrentSessionSync() {
    const messages = this.signals.messages.value;
    if (!this.sessionId || messages.length === 0) return;

    const firstUserMsg = messages.find((m) => m.role === "user");
    try {
      saveSessionSync({
        sessionId: this.sessionId,
        projectPaths: this.projectPaths,
        createdAt: this.createdAt,
        firstMessage: firstUserMsg?.content || "",
        messages,
        tokenUsage: this.signals.tokenUsage.value,
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

  if (toolName === "Bash" && input.command) {
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
  const permBtnRefs = useRef({});

  // Expose DOM refs back to the class shell after every render
  useEffect(() => {
    callbacks.onRefsReady({
      messagesContainer: messagesContainerRef.current,
      editorContainer: editorContainerRef.current,
      sendBtn: sendBtnRef.current,
      stopBtn: stopBtnRef.current,
      effortMode: effortModeRef.current,
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
    signals.messages.value.length === 0 && !isStreaming && !signals.pendingPermission.value;

  const effortModes = Config.effortModes;
  const currentEffort =
    effortModes.find((m) => m.value === signals.effortMode.value) || effortModes[1];

  const showStop =
    signals.isLoading.value &&
    !signals.hasEditorInput.value &&
    signals.attachContext.value.length === 0;
  const isBypassMode = signals.permissionMode.value === "bypassPermissions";

  return (
    <div className="claude-chat" tabIndex="-1">
      <div className="claude-chat-messages" ref={messagesContainerRef}>
        {isEmpty ? renderWelcomePage() : null}
        {!isEmpty
          ? renderMessages(signals.messages.value, callbacks.toolHandlers, !!isStreaming)
          : null}
        <StreamingArea
          currentText={signals.currentText}
          currentThinking={signals.currentThinking}
          isLoading={signals.isLoading}
        />
        <PermissionArea signals={signals} callbacks={callbacks} />
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
        <div className="editor-container" ref={editorContainerRef}>
          <div
            className={`effort-mode effort-${currentEffort.value}`}
            ref={effortModeRef}
            onClick={callbacks.cycleEffortMode}
          >
            {effortModes.map((_, i) => (
              <span className={`effort-dot${i < currentEffort.dots ? " active" : ""}`} />
            ))}
          </div>
        </div>
        <div className="claude-chat-toolbar">
          <div className="toolbar-actions">
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

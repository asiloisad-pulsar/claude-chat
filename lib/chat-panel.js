/** @babel */
/** @jsx etch.dom */

import etch from "etch";
import { CompositeDisposable, Emitter, Disposable } from "atom";
import ClaudeConnection from "./claude-connection";
import Config from "./utils/config";
import { renderMessages, renderStreamingMessage, renderWelcomePage } from "./message-renderer";
import { saveSession, deleteSession } from "./session-store";
import { createLogger } from "./utils/log";

const log = createLogger("ChatPanel");

const URI_PREFIX = "atom://claude-chat";

const MODE_LABELS = {
  acceptEdits: "Accept Edits",
  bypassPermissions: "Bypass",
  plan: "Plan",
};

/**
 * Extract displayable suggestion buttons from permission_suggestions.
 * Returns array of { label, suggestions } — each is a subset to send as updatedPermissions.
 */
function getSuggestionButtons(suggestions) {
  if (!suggestions?.length) return [];
  const buttons = [];
  const allowRule = suggestions.filter((s) => s.type === "addRules" && s.behavior === "allow");
  if (allowRule.length) {
    buttons.push({ label: "Always Allow", permissions: allowRule });
  }
  const modeChange = suggestions.find((s) => s.type === "setMode" && MODE_LABELS[s.mode]);
  if (modeChange) {
    buttons.push({
      label: MODE_LABELS[modeChange.mode] + " Mode",
      permissions: [modeChange],
    });
  }
  return buttons;
}

export default class ChatPanel {
  static URI_PREFIX = URI_PREFIX;

  constructor(props = {}) {
    log.debug("Creating ChatPanel", {
      sessionId: props.sessionId,
      messagesCount: props.messages?.length || 0,
    });
    this.props = props;
    this.messages = props.messages || [];
    this.sessionId = props.sessionId || null;

    // Ensure all tool messages have an id (for sessions saved before id was added)
    let idCounter = 0;
    for (const msg of this.messages) {
      if (msg.role === "tool" && !msg.id) {
        msg.id = `legacy-${idCounter++}`;
      }
    }
    this.isLoading = false;

    // Permission mode for this chat - use config helper
    this.permissionMode = props.permissionMode || Config.permissionMode();

    // Session metadata
    this.projectPaths = props.projectPaths || atom.project.getPaths();
    this.createdAt = props.createdAt || new Date().toISOString();
    this.tokenUsage = props.tokenUsage || { input: 0, output: 0 };

    // Streaming state
    this.currentText = "";
    this.pendingDelta = "";
    this.updateScheduled = false;

    // Attach context (selection, file, or paths from tree-view)
    this.attachContext = null;

    // Default collapsed state for tools (null = per-type default, true/false = override all)
    this.defaultToolCollapsed = null;

    // Pending permission request (for accept/deny UI)
    this.pendingPermission = null;

    // Create connection
    this.connection = new ClaudeConnection({
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
    });

    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();

    // Tool handlers for renderers
    this.toolHandlers = {
      toggle: (id) => this.toggleToolCollapse(id),
      openFile: (filePath, line) => this.handleOpenFile(filePath, line),
    };

    this.tooltipDisposables = new CompositeDisposable();

    etch.initialize(this);
    this.setupConnection();
    this.setupEditor();
    this.setupCommands();
    this.setupPaneObserver();

    // Initialize tooltips
    this.updateTooltips();

    // Scroll to bottom for restored sessions
    requestAnimationFrame(() => this.scrollToBottom());
  }

  // ============================================================================
  // Helper Methods - Reduce Boilerplate
  // ============================================================================

  /**
   * Update etch and scroll to bottom if user was near bottom
   */
  async updateAndMaybeScroll() {
    const wasNearBottom = this.isNearBottom();
    await etch.update(this);
    if (wasNearBottom) this.scrollToBottom();
  }

  /**
   * Disconnect the CLI process. The next message will start a fresh connection,
   * picking up any changes to MCP tools or other config.
   */
  disconnect() {
    if (this.connection.isRunning()) {
      this.connection.kill();
    }
  }

  /**
   * Recreate the connection with current settings
   * Used when changing permission mode
   */
  recreateConnection() {
    if (this.connection.isRunning()) {
      this.connection.kill();
    }

    this.connection.destroy();
    this.connection = new ClaudeConnection({
      sessionId: this.sessionId,
      permissionMode: this.permissionMode,
    });
    this.setupConnection();
    etch.update(this);
  }

  /**
   * Add a message to the messages array
   */
  addMessage(role, content, extras = {}) {
    const message = { role, content, ...extras };
    this.messages.push(message);
    return message;
  }

  // ============================================================================
  // Tooltips
  // ============================================================================

  updateTooltips() {
    this.tooltipDisposables.dispose();
    this.tooltipDisposables = new CompositeDisposable();

    // Permission buttons with keyboard shortcuts - use config helper
    Config.permissionModes.forEach((mode) => {
      const el = this.refs[`permission-${mode.value}`];
      if (el) {
        this.tooltipDisposables.add(
          atom.tooltips.add(el, {
            title: `${mode.label} <span class="keystroke">Ctrl+${mode.key}</span>`,
            html: true,
          }),
        );
      }
    });

    // Send/Stop button
    if (this.refs.sendBtn) {
      this.tooltipDisposables.add(
        atom.tooltips.add(this.refs.sendBtn, {
          title: 'Send message <span class="keystroke">Enter</span>',
          html: true,
        }),
      );
    }
    if (this.refs.stopBtn) {
      this.tooltipDisposables.add(
        atom.tooltips.add(this.refs.stopBtn, { title: "Stop generation" }),
      );
    }

    // Attach indicator - show context details in tooltip
    if (this.refs.attachIndicator && this.attachContext) {
      const ctx = this.attachContext;
      const filePath = ctx.path || ctx.paths?.[0];
      let tooltipText = "";

      if (ctx.type === "selections" && ctx.selections) {
        const hasText = ctx.selections.some((s) => s.text);
        if (hasText) {
          const totalChars = ctx.selections.reduce((sum, s) => sum + (s.text?.length || 0), 0);
          tooltipText = `${ctx.selections.length} selection(s) from ${filePath}\n${totalChars} characters`;
        } else {
          tooltipText = `${ctx.selections.length} cursor(s) in ${filePath}`;
        }
      } else if (ctx.type === "paths") {
        const allPaths = ctx.paths || (ctx.path ? [ctx.path] : []);
        tooltipText =
          allPaths.length === 1 ? `Path: ${allPaths[0]}` : `Paths:\n${allPaths.join("\n")}`;
      }

      this.tooltipDisposables.add(
        atom.tooltips.add(this.refs.attachIndicator, { title: tooltipText }),
      );
    }

    // Add tooltips for elements with data-tooltip attribute
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

    // Session ID
    this.disposables.add(
      this.connection.on("session", (id) => {
        log.debug("Session received", id);
        this.sessionId = id;
      }),
    );

    // Session expired (conversation no longer exists in Claude CLI)
    this.disposables.add(
      this.connection.on("session-expired", async () => {
        log.debug("Session expired", this.sessionId);
        if (this.sessionId) {
          await deleteSession(this.sessionId);
        }
        this.sessionId = null;
        this.isLoading = false;
        atom.notifications.addWarning("Session expired", {
          description: "The conversation was not found. Starting fresh.",
          dismissable: true,
        });
        etch.update(this);
      }),
    );

    // Streaming text - throttled via requestAnimationFrame
    this.disposables.add(
      this.connection.on("delta", (text) => {
        if (!this.isLoading) return;
        if (!atom.config.get("claude-chat.streamingText")) return;
        this.pendingDelta += text;
        this.scheduleUpdate();
      }),
    );

    // Tool use
    this.disposables.add(
      this.connection.on("tool-use", ({ id, name, input }) => {
        // Deduplicate — assistant events replay all blocks cumulatively
        if (this.messages.some((m) => m.role === "tool" && m.id === id)) return;

        // Flush buffered delta and finalize any pending text before adding tool
        if (this.pendingDelta) {
          this.currentText += this.pendingDelta;
          this.pendingDelta = "";
        }
        if (this.currentText) {
          this.addMessage("assistant", this.currentText);
          this.currentText = "";
        }
        // Determine collapsed state: use override if set, else per-type default
        const collapsed =
          this.defaultToolCollapsed !== null ? this.defaultToolCollapsed : name !== "TodoWrite";
        this.messages.push({
          role: "tool",
          id,
          name,
          input,
          result: null,
          collapsed,
        });
        this.updateAndMaybeScroll();
      }),
    );

    // Tool result
    this.disposables.add(
      this.connection.on("tool-result", ({ toolUseId, content, isError }) => {
        const toolMsg = this.messages.find((m) => m.role === "tool" && m.id === toolUseId);
        if (toolMsg) {
          toolMsg.result = content;
          toolMsg.isError = isError;
          this.updateAndMaybeScroll();
        }
      }),
    );

    // Result (response complete)
    this.disposables.add(
      this.connection.on("result", (resultText) => {
        // Flush any buffered delta text before finalizing
        if (this.pendingDelta) {
          this.currentText += this.pendingDelta;
          this.pendingDelta = "";
        }
        log.debug("Response complete", {
          textLength: this.currentText?.length || resultText?.length || 0,
        });
        const finalText = this.currentText || resultText;
        if (finalText) {
          const message = this.addMessage("assistant", finalText);
          this.currentText = "";
          this.emitter.emit("did-receive-message", message);
        }
        this.isLoading = false;
        this.updateAndMaybeScroll();
      }),
    );

    // Usage
    this.disposables.add(
      this.connection.on("usage", (usage) => {
        this.tokenUsage.input += usage.input;
        this.tokenUsage.output += usage.output;
        etch.update(this);
      }),
    );

    // Error
    this.disposables.add(
      this.connection.on("error", (error) => {
        this.addMessage("error", error.message);
        this.isLoading = false;
        this.currentText = "";
        this.updateAndMaybeScroll();
      }),
    );

    // Exit
    this.disposables.add(
      this.connection.on("exit", (code) => {
        if (code !== 0 && this.isLoading) {
          this.isLoading = false;
          this.currentText = "";
          etch.update(this);
        }
      }),
    );

    // Permission requests
    this.disposables.add(
      this.connection.on("permission-request", (request) => {
        log.debug("Permission request", request);
        this.pendingPermission = request;
        this.updateAndMaybeScroll();
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
      lineNumberGutterVisible: false,
      placeholderText: "Ask Claude something...",
    });

    this.promptEditor.gutterWithName("line-number")?.hide();

    // Update action button when editor content changes during loading
    this.disposables.add(
      this.promptEditor.onDidStopChanging(() => {
        if (this.isLoading) {
          etch.update(this);
        }
      }),
    );

    if (this.refs.editorContainer) {
      this.refs.editorContainer.appendChild(this.promptEditor.element);
    }
  }

  // ============================================================================
  // Commands Setup
  // ============================================================================

  setupCommands() {
    // Commands for the prompt editor
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
        "claude-chat:mode-bypass": () => this.handlePermissionModeChange("bypassPermissions"),
        "claude-chat:focus-active-editor": () => this.focusActiveEditor(),
      }),
    );

    // Commands for the panel container
    this.disposables.add(
      atom.commands.add(this.element, {
        "claude-chat:copy": () => this.handleCopy(),
        "claude-chat:copy-message": (e) => this.handleCopyMessage(e),
        "claude-chat:unfold-all": () => this.expandAllTools(),
        "claude-chat:fold-all": () => this.collapseAllTools(),
        "claude-chat:clear-messages": () => this.clearMessages(),
        "core:copy": (e) => this.handleCopy(e),
        "core:close": (e) => this.handleClose(e),
      }),
    );
  }

  // ============================================================================
  // Pane Observer Setup
  // ============================================================================

  setupPaneObserver() {
    // Focus prompt editor when pane becomes active via keyboard navigation
    // (e.g., window:focus-pane-on-right) but not when clicking inside the panel
    this.disposables.add(
      atom.workspace.onDidChangeActivePaneItem((item) => {
        if (item === this) {
          // Only focus if nothing inside the panel already has focus
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
    const total = this.tokenUsage.input + this.tokenUsage.output;
    atom.notifications.addInfo("Token Usage", {
      detail: `Input: ${this.tokenUsage.input.toLocaleString()}\nOutput: ${this.tokenUsage.output.toLocaleString()}\nTotal: ${total.toLocaleString()}`,
      dismissable: true,
    });
  }

  sendSlashCommand(command) {
    const prompt = `/${command}`;
    this.addMessage("user", prompt);
    this.isLoading = true;
    this.currentText = "";

    etch.update(this).then(() => this.scrollToBottom());
    this.connection.send(prompt);
    this.focus();
  }

  scheduleUpdate() {
    if (this.updateScheduled) return;
    this.updateScheduled = true;

    requestAnimationFrame(() => {
      this.updateScheduled = false;
      // Skip if response already finalized (result flushed pendingDelta)
      if (!this.pendingDelta) return;
      const wasNearBottom = this.isNearBottom();
      this.currentText += this.pendingDelta;
      this.pendingDelta = "";
      etch.update(this).then(() => {
        if (wasNearBottom) this.scrollToBottom();
      });
    });
  }

  isNearBottom() {
    const container = this.refs.messagesContainer;
    if (!container) return true;
    const threshold = 100;
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }

  scrollToBottom() {
    if (this.refs.messagesContainer) {
      this.refs.messagesContainer.scrollTop = this.refs.messagesContainer.scrollHeight;
    }
  }

  scrollToBottomIfNeeded() {
    if (this.isNearBottom()) {
      this.scrollToBottom();
    }
  }

  scrollPage(direction) {
    const container = this.refs.messagesContainer;
    if (!container) return;
    const pageHeight = container.clientHeight * 0.25;
    container.scrollTop += direction * pageHeight;
  }

  // ============================================================================
  // Tool Interaction
  // ============================================================================

  toggleToolCollapse(id) {
    const msg = this.messages.find((m) => m.role === "tool" && m.id === id);
    if (msg) {
      msg.collapsed = !msg.collapsed;
      etch.update(this);
    }
  }

  expandAllTools() {
    this.defaultToolCollapsed = false;
    for (const msg of this.messages) {
      if (msg.role === "tool") {
        msg.collapsed = false;
      }
    }
    etch.update(this);
  }

  collapseAllTools() {
    this.defaultToolCollapsed = true;
    for (const msg of this.messages) {
      if (msg.role === "tool") {
        msg.collapsed = true;
      }
    }
    etch.update(this);
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
    this.attachContext = context;
    this.update();
  }

  clearAttachContext() {
    this.attachContext = null;
    this.update();
  }

  formatAttachContext() {
    if (!this.attachContext) return "";

    const { type, path, paths, selection, selections } = this.attachContext;

    if (type === "selections" && selections) {
      // Multi-cursor selections from editor
      const filePath = path || paths?.[0];
      const hasText = selections.some((s) => s.text);
      if (hasText) {
        const parts = selections
          .filter((s) => s.text)
          .map(
            (s) =>
              `Lines ${s.range.start.row + 1}-${s.range.end.row + 1}:\n\`\`\`\n${s.text}\n\`\`\``,
          );
        return `User is referring to code from ${filePath}:\n${parts.join("\n\n")}\n\n`;
      } else {
        // Just cursor positions, no selected text
        const positions = selections.map(
          (s) => `${s.range.start.row + 1}:${s.range.start.column + 1}`,
        );
        return `User's cursors are at ${filePath}: ${positions.join(", ")}\n\n`;
      }
    } else if (type === "image") {
      // Image attachment - provide context for Claude to read and analyze
      const file = path || paths?.[0];
      const { dimensions } = this.attachContext;
      let result = `User attached an image for analysis.\nPath: ${file}`;
      if (dimensions) {
        result += `\nDimensions: ${dimensions.width}×${dimensions.height} pixels`;
      }
      if (selection && typeof selection === "object") {
        const { x1, y1, x2, y2 } = selection;
        result += `\nSelected region: (${x1}, ${y1}) to (${x2}, ${y2}) pixels`;
        result += `\n\nFocus on the selected region, but consider the surrounding context of the full image.`;
      }
      result += `\nUse the Read tool to view this image file.\n\n`;
      return result;
    } else if (type === "paths") {
      // File/directory paths
      const allPaths = paths || (path ? [path] : []);
      if (allPaths.length === 1) {
        return `User is referring to: ${allPaths[0]}\n\n`;
      }
      const pathList = allPaths.map((p) => `- ${p}`).join("\n");
      return `User is referring to these paths:\n${pathList}\n\n`;
    }
    return "";
  }

  // ============================================================================
  // Send/Stop Handlers
  // ============================================================================

  sendPrompt(text, attachContext = null) {
    if (!text && !attachContext && !this.attachContext) return false;

    log.debug("Sending prompt", {
      length: text?.length || 0,
      hasAttach: !!attachContext || !!this.attachContext,
    });

    if (attachContext) {
      this.attachContext = attachContext;
    }

    const attachPrefix = this.formatAttachContext();
    const fullMessage = attachPrefix + text;

    const message = this.addMessage("user", text);
    if (this.attachContext) {
      message.attach = { ...this.attachContext };
    }

    this.isLoading = true;
    this.currentText = "";
    this.attachContext = null;

    etch.update(this).then(() => this.scrollToBottom());
    this.connection.send(fullMessage);

    return true;
  }

  handleSend() {
    const text = this.promptEditor.getText().trim();
    if (!text && !this.attachContext) return;

    const attachPrefix = this.formatAttachContext();
    const fullMessage = attachPrefix + text;

    const message = this.addMessage("user", text);
    if (this.attachContext) {
      message.attach = { ...this.attachContext };
    }

    this.promptEditor.setText("");
    this.isLoading = true;
    this.currentText = "";
    this.attachContext = null;

    etch.update(this).then(() => this.scrollToBottom());
    this.connection.send(fullMessage);
    this.focus();
  }

  handleStop() {
    if (this.connection.isRunning()) {
      // Send interrupt for clean abort; CLI will emit result event
      this.connection.interrupt();
    }
    this.isLoading = false;
    this.currentText = "";
    this.pendingDelta = "";
    etch.update(this);
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
    this.messages = [];
    etch.update(this);
  }

  handlePermissionModeChange(mode) {
    if (this.permissionMode === mode) return;
    this.permissionMode = mode;
    this.recreateConnection();
  }

  handlePermissionAccept(permissions) {
    if (!this.pendingPermission) return;
    const { requestId, input } = this.pendingPermission;
    const opts = { input };
    if (permissions?.length) {
      opts.permissions = permissions;
    }
    this.connection.respondToPermission(requestId, "allow", opts);
    this.pendingPermission = null;
    etch.update(this);
  }

  handlePermissionDeny() {
    if (!this.pendingPermission) return;
    const { requestId } = this.pendingPermission;
    this.connection.respondToPermission(requestId, "deny", {
      message: "User denied permission",
    });
    this.pendingPermission = null;
    etch.update(this);
  }

  /**
   * Handle answering a single question in an AskUserQuestion prompt.
   * Accumulates answers; only submits when all questions are answered.
   */
  handleQuestionAnswer(questionText, answer) {
    if (!this.pendingPermission) return;

    // Accumulate partial answers
    if (!this.pendingAnswers) this.pendingAnswers = {};
    this.pendingAnswers[questionText] = answer;

    const { requestId, input } = this.pendingPermission;
    const questions = input?.questions || [];

    // Check if all questions are answered
    const allAnswered = questions.every((q) => this.pendingAnswers[q.question]);
    if (!allAnswered) {
      // Re-render to show selected state
      this.updateAndMaybeScroll();
      return;
    }

    // All answered — submit
    const answers = { ...this.pendingAnswers };
    const updatedInput = { ...input, answers };
    log.debug("Question answer", { answers, updatedInput });

    // Store answers on the tool message so the renderer can show them
    const toolMsg = this.messages.find(
      (m) => m.role === "tool" && (m.name === "AskUserQuestion" || m.name === "Question") && !m.answers,
    );
    if (toolMsg) {
      toolMsg.answers = answers;
    }

    this.connection.respondToPermission(requestId, "allow", {
      input: updatedInput,
    });
    this.pendingPermission = null;
    this.pendingAnswers = null;
    this.updateAndMaybeScroll();
  }

  /**
   * Handle "Other" option for AskUserQuestion — use text from prompt editor
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
  // Render
  // ============================================================================

  /**
   * Render action button based on state:
   * - Not loading → Send button
   * - Loading + empty input → Stop button
   * - Loading + has input → Send button
   */
  renderActionButton() {
    const hasInput = this.promptEditor?.getText()?.trim() || this.attachContext;
    const showStop = this.isLoading && !hasInput;

    if (showStop) {
      return (
        <button
          ref="stopBtn"
          className="btn btn-error icon icon-primitive-square"
          on={{ click: () => this.handleStop() }}
        />
      );
    }
    return (
      <button
        ref="sendBtn"
        className="btn btn-primary icon icon-triangle-right"
        on={{ click: () => this.handleSend() }}
      />
    );
  }

  renderPermissionPrompt() {
    if (!this.pendingPermission) return null;

    const { toolName, input, suggestions } = this.pendingPermission;

    // AskUserQuestion — show interactive question UI instead of Allow/Deny
    if (toolName === "AskUserQuestion" || toolName === "Question") {
      return this.renderQuestionPrompt(input);
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
        {this.renderPermissionDetails(toolName, input)}
        <div className="permission-prompt-actions">
          <button className="btn btn-success" on={{ click: () => this.handlePermissionAccept() }}>
            Allow
          </button>
          {suggestionButtons.map((sb, i) => (
            <button
              className="btn btn-info"
              key={i}
              on={{ click: () => this.handlePermissionAccept(sb.permissions) }}
            >
              {sb.label}
            </button>
          ))}
          <button className="btn btn-error" on={{ click: () => this.handlePermissionDeny() }}>
            Deny
          </button>
        </div>
      </div>
    );
  }

  renderPermissionDetails(toolName, input) {
    if (!input) return null;

    if (toolName === "Bash" && input.command) {
      return (
        <pre className="permission-prompt-command">{input.command}</pre>
      );
    }

    if ((toolName === "Write" || toolName === "Edit" || toolName === "Read") && input.file_path) {
      return (
        <span className="permission-prompt-path">{input.file_path}</span>
      );
    }

    if ((toolName === "Glob" || toolName === "Grep") && input.pattern) {
      return (
        <span className="permission-prompt-path">{input.pattern}</span>
      );
    }

    // Generic: show first meaningful key-value pairs
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

  renderQuestionPrompt(input) {
    const questions = input?.questions || [];
    if (questions.length === 0) return null;
    const partial = this.pendingAnswers || {};

    return (
      <div className="question-prompt">
        {questions.map((q, qi) => {
          const selected = partial[q.question];
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
                      className="btn question-prompt-option"
                      key={oi}
                      on={{ click: () => this.handleQuestionAnswer(q.question, opt.label) }}
                    >
                      <span className="option-label">{opt.label}</span>
                      {opt.description ? (
                        <span className="option-description">{opt.description}</span>
                      ) : null}
                    </button>
                  ))}
                  <button
                    className="btn question-prompt-option question-prompt-other"
                    on={{ click: () => this.handleQuestionAnswerOther(q.question) }}
                  >
                    <span className="option-label">Other...</span>
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  render() {
    const isStreaming = this.isLoading || this.currentText;
    const isEmpty = this.messages.length === 0 && !isStreaming && !this.pendingPermission;

    return (
      <div className="claude-chat" tabIndex="-1">
        <div className="claude-chat-messages" ref="messagesContainer">
          {isEmpty ? renderWelcomePage() : null}
          {!isEmpty ? renderMessages(this.messages, this.toolHandlers, isStreaming) : null}
          {renderStreamingMessage(this.currentText, this.isLoading)}
          {this.renderPermissionPrompt()}
        </div>
        <div className="claude-chat-input">
          <div className="editor-container" ref="editorContainer" />
          <div className="claude-chat-toolbar">
            {this.attachContext ? (
              <span
                ref="attachIndicator"
                className="attach-indicator"
                on={{ click: () => this.clearAttachContext() }}
              >
                <span className={`icon icon-${this.attachContext.icon || "mention"}`}></span>
                <span className="attach-label">{this.attachContext.label}</span>
              </span>
            ) : null}
            <div className="toolbar-actions">
              <div className="btn-group permission-mode">
                {Config.permissionModes.map((mode) => (
                  <button
                    ref={`permission-${mode.value}`}
                    className={`btn icon icon-${mode.icon} ${
                      mode.value === this.permissionMode ? "selected" : ""
                    }`}
                    on={{ click: () => this.handlePermissionModeChange(mode.value) }}
                  />
                ))}
              </div>
              <div className="btn-group send-group">{this.renderActionButton()}</div>
            </div>
          </div>
        </div>
      </div>
    );
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
    return ["left", "right"];
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
    return etch.update(this).then(() => {
      this.updateTooltips();
    });
  }

  focus() {
    this.promptEditor?.element?.focus();
  }

  /**
   * Check if this panel can load a session (empty and no active connection)
   */
  canLoadSession() {
    return this.messages.length === 0 && !this.isLoading && !this.sessionId;
  }

  /**
   * Load session data into this panel (reuse empty panel)
   */
  loadSession(sessionData) {
    this.messages = sessionData.messages || [];
    this.sessionId = sessionData.sessionId;
    this.projectPaths = sessionData.projectPaths || atom.project.getPaths();
    this.createdAt = sessionData.createdAt || new Date().toISOString();
    this.tokenUsage = sessionData.tokenUsage || { input: 0, output: 0 };

    // Update connection with session ID for resume
    this.connection.sessionId = this.sessionId;

    etch.update(this);
    requestAnimationFrame(() => this.scrollToBottom());
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    log.debug("Destroying ChatPanel", { sessionId: this.sessionId });
    await this.saveCurrentSession();
    this.connection?.destroy();
    this.disposables?.dispose();
    this.tooltipDisposables?.dispose();
    this.emitter?.dispose();
    this.promptEditor?.destroy();
    await etch.destroy(this);
  }

  async saveCurrentSession() {
    if (!this.sessionId || this.messages.length === 0) return;

    const firstUserMsg = this.messages.find((m) => m.role === "user");
    const firstMessage = firstUserMsg?.content || "";

    try {
      await saveSession({
        sessionId: this.sessionId,
        projectPaths: this.projectPaths,
        createdAt: this.createdAt,
        firstMessage,
        messages: this.messages,
        tokenUsage: this.tokenUsage,
      });
    } catch (err) {
      console.error("Failed to save session:", err);
    }
  }
}

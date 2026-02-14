/** @babel */

import { CompositeDisposable, Disposable } from "atom";
import ChatPanel from "./chat-panel";
import HistoryList from "./history-list";
import SlashList from "./slash-list";
import Config from "./utils/config";
import { getRelativePath } from "./utils/paths";
import { listSessions, loadSession } from "./session-store";
import { createLogger } from "./utils/log";

const log = createLogger("Main");

// Reference to pulsar-mcp service (set via consumePulsarMcp)
let pulsarMcpService = null;

// Reference to tree-view service (set via consumeTreeView)
let treeViewService = null;

export default {
  subscriptions: null,
  panel: null,
  historyList: null,
  slashList: null,

  activate() {
    log.debug("Activating claude-chat package");
    this.subscriptions = new CompositeDisposable();

    // Register opener for atom://claude-chat URIs
    this.subscriptions.add(
      atom.workspace.addOpener((uri) => {
        if (uri.startsWith(ChatPanel.URI_PREFIX)) {
          return this.getOrCreatePanel();
        }
      }),
    );

    // Create history list (registers its own commands)
    this.historyList = new HistoryList(this);

    // Create slash command list (registers its own commands)
    this.slashList = new SlashList(this);

    // Clear panel reference when destroyed (e.g., user closes tab)
    this.subscriptions.add(
      atom.workspace.onDidDestroyPaneItem(({ item }) => {
        if (item === this.panel) {
          this.panel = null;
        }
      }),
    );

    // Track active panel when user focuses a chat panel
    this.subscriptions.add(
      atom.workspace.onDidChangeActivePaneItem((item) => {
        if (item instanceof ChatPanel) {
          this.panel = item;
        }
      }),
    );

    // Register commands
    this.subscriptions.add(
      atom.commands.add("atom-workspace", {
        "claude-chat:open": () => this.open(),
        "claude-chat:toggle": () => this.toggle(),
        "claude-chat:new-chat": () => this.newChat(),
        "claude-chat:open-latest": () => this.openLatest(),
        "claude-chat:settings": () => this.openSettings(),
      }),
      atom.commands.add("atom-text-editor:not([mini])", {
        "editor:attach-to-claude": (e) => this.attachEditor(e),
      }),
      atom.commands.add(".tree-view", {
        "tree-view:attach-to-claude": () => this.attachTreeView(),
      }),
    );
  },

  async deactivate() {
    log.debug("Deactivating claude-chat package");
    this.subscriptions?.dispose();
    this.historyList?.destroy();
    this.slashList?.destroy();
    await this.panel?.destroy();
    this.panel = null;
    pulsarMcpService = null;
    treeViewService = null;
  },

  serialize() {
    return {};
  },

  getOrCreatePanel() {
    if (!this.panel) {
      this.panel = new ChatPanel();
    }
    return this.panel;
  },

  async open() {
    const location = Config.panelPosition();
    const uri = this.panel?.getURI() || `${ChatPanel.URI_PREFIX}/panel`;
    const item = await atom.workspace.open(uri, { location });
    if (item) {
      requestAnimationFrame(() => this.panel?.focus());
    }
  },

  async toggle() {
    const location = Config.panelPosition();
    const uri = this.panel?.getURI() || `${ChatPanel.URI_PREFIX}/panel`;
    const item = await atom.workspace.toggle(uri, { location });
    if (item) {
      requestAnimationFrame(() => this.panel?.focus());
    }
  },

  async newChat() {
    const location = Config.panelPosition();
    this.panel = new ChatPanel();
    await atom.workspace.open(this.panel, { location });
    requestAnimationFrame(() => this.panel?.focus());
  },

  async openLatest() {
    const projectPaths = atom.project.getPaths();
    const sessions = await listSessions(projectPaths);

    if (sessions.length === 0) {
      atom.notifications.addInfo("No chat history found for this project.");
      return;
    }

    const latest = sessions[0]; // Already sorted by updatedAt, most recent first
    const sessionId = latest.sessionId;

    // Check if session is already open
    const sessionURI = `${ChatPanel.URI_PREFIX}/session/${sessionId}`;
    const existingPane = atom.workspace.paneForURI(sessionURI);
    if (existingPane) {
      const item = existingPane.itemForURI(sessionURI);
      if (item) {
        existingPane.activateItem(item);
        item.focus?.();
        return;
      }
    }

    // Load and open the session
    const sessionData = await loadSession(sessionId);
    if (!sessionData) {
      atom.notifications.addError("Failed to load session.");
      return;
    }

    const location = Config.panelPosition();
    this.panel = new ChatPanel(sessionData);
    await atom.workspace.open(this.panel, { location });
    requestAnimationFrame(() => this.panel?.focus());
  },

  openSettings() {
    atom.workspace.open("atom://config/packages/claude-chat");
  },

  getActiveChat() {
    return this.panel;
  },

  focusActiveChat() {
    this.panel?.focus();
  },

  async openAndAttach(context) {
    const location = Config.panelPosition();
    const uri = this.panel?.getURI() || `${ChatPanel.URI_PREFIX}/panel`;
    await atom.workspace.open(uri, { location });
    this.panel?.setAttachContext(context);
    this.panel?.focus();
  },

  attachEditor(event) {
    const editor = event.currentTarget.getModel();
    if (!editor) return;

    const filePath = editor.getPath();
    if (!filePath) return;

    const relativePath = getRelativePath(filePath);
    const editorSelections = editor.getSelections();
    const selections = editorSelections.map((s) => {
      const range = s.getBufferRange();
      return {
        text: s.getText(),
        range: {
          start: { row: range.start.row, column: range.start.column },
          end: { row: range.end.row, column: range.end.column },
        },
      };
    });

    const firstLine = selections[0].range.start.row + 1;
    const hasText = selections.some((s) => s.text);
    const label =
      selections.length === 1
        ? `${relativePath}:${firstLine}`
        : `${relativePath} (${selections.length} ${hasText ? "selections" : "cursors"})`;

    this.openAndAttach({
      type: "selections",
      path: relativePath,
      line: firstLine,
      selections,
      label,
      icon: "code",
    });
  },

  attachTreeView() {
    if (!treeViewService) return;

    const selectedPaths = treeViewService.selectedPaths();
    if (!selectedPaths || selectedPaths.length === 0) return;

    const relativePaths = selectedPaths.map((p) => getRelativePath(p));
    const isMultiple = relativePaths.length > 1;

    this.openAndAttach({
      type: "paths",
      paths: relativePaths,
      label: isMultiple ? `${relativePaths.length} paths` : relativePaths[0],
      icon: isMultiple ? "list-unordered" : "file-directory",
    });
  },

  /**
   * Get the current MCP bridge port (from pulsar-mcp service)
   */
  getMcpBridgePort() {
    return pulsarMcpService?.getBridgePort() || null;
  },

  /**
   * Get the path to the MCP server script (from pulsar-mcp service)
   */
  getMcpServerPath() {
    return pulsarMcpService?.getServerPath() || null;
  },

  // Service API for other packages
  provideService() {
    return {
      setAttachContext: async (context) => {
        await this.openAndAttach(context);
        return !!this.panel;
      },
      clearAttachContext: () => {
        this.panel?.clearAttachContext();
      },
      hasPanel: () => !!this.panel,
      sendPrompt: async (text, options = {}) => {
        if (!text) return false;

        if (!this.panel) {
          await this.toggle();
        }

        const sent = this.panel.sendPrompt(text, options.attachContext);

        if (sent && options.focus !== false) {
          this.panel.focus();
        }

        return sent;
      },
      onDidReceiveMessage: (callback) => {
        return this.panel?.onDidReceiveMessage(callback);
      },
    };
  },

  /**
   * Consume pulsar-mcp service
   * Provides access to MCP bridge port and server path
   *
   * @param {Object} service - pulsar-mcp service object
   * @returns {Disposable} - Disposable for cleanup
   */
  consumeTreeView(service) {
    treeViewService = service;
    return new Disposable(() => {
      treeViewService = null;
    });
  },

  consumePulsarMcp(service) {
    if (!service) {
      log.error("Invalid pulsar-mcp service");
      return new Disposable();
    }

    pulsarMcpService = service;
    log.debug("Consumed pulsar-mcp service", {
      bridgePort: service.getBridgePort(),
      isRunning: service.isRunning(),
    });

    return new Disposable(() => {
      pulsarMcpService = null;
      log.debug("Disposed pulsar-mcp service");
    });
  },
};

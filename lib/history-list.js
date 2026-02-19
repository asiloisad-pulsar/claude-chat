/** @babel */

import BaseList, { highlightMatches } from "./components/base-list";
import {
  listSessions,
  deleteSession,
  clearAllSessions,
  formatSessionForList,
  loadSession,
} from "./session-store";
import ChatPanel from "./chat-panel";
import Config from "./utils/config";

/**
 * HistoryList manages the chat session history select list.
 * Extends BaseList for common functionality.
 */
export default class HistoryList extends BaseList {
  constructor(main) {
    const self = { showAll: false, reload: true, items: [], main };

    super({
      className: "claude-chat-history",
      emptyMessage: "No sessions found",
      maxResults: 50,
      algorithm: "fuzzaldrin", // General text matching
      filterKeyForItem: (item) => item.text,
      filterScoreModifier: (score, item) => {
        // Recency bonus: _recency is set in loadItems (1.2 for most recent → 1.0 for oldest)
        return score * (item._recency || 1);
      },
      willShow: () => self.instance.loadItems(),
      elementForItem: (item, { matchIndices }) => {
        // Text format: "description project dateStr"
        const li = document.createElement("li");
        li.classList.add("two-lines");
        const matches = matchIndices || [];

        // Primary line: label (dateStr - project) - offset after description
        const priBlock = document.createElement("div");
        priBlock.classList.add("primary-line");
        const labelOffset = item.description.length + 1;
        priBlock.appendChild(
          highlightMatches(
            item.label,
            matches.map((x) => x - labelOffset),
          ),
        );
        li.appendChild(priBlock);

        // Secondary line: description (first message) - offset: 0
        const secBlock = document.createElement("div");
        secBlock.classList.add("secondary-line");
        secBlock.appendChild(highlightMatches(item.description, matches));
        li.appendChild(secBlock);

        return li;
      },
      didConfirmSelection: async (item) => {
        self.instance.hide();
        await self.instance.openSession(item.sessionId);
      },
      didCancelSelection: () => {
        self.instance.hide();
      },
      listCommands: {
        "claude-chat:open-keep-list": async () => {
          const item = self.instance.getSelectedItem();
          if (item) await self.instance.openSession(item.sessionId);
        },
        "claude-chat:delete-session": async () => {
          const item = self.instance.getSelectedItem();
          if (item) {
            await deleteSession(item.sessionId);
            self.items = self.items.filter((i) => i.sessionId !== item.sessionId);
            self.instance.updateItems(self.items);
          }
        },
        "claude-chat:toggle-all-sessions": () => {
          self.showAll = !self.showAll;
          self.reload = true;
          self.instance.loadItems();
        },
        "claude-chat:refresh-list": () => {
          self.reload = true;
          self.instance.loadItems();
        },
      },
      workspaceCommands: {
        "claude-chat:history": () => self.instance.toggle(),
        "claude-chat:clear-history": () => self.instance.clearHistory(),
      },
    });

    // Store reference for closures
    self.instance = this;
    this._state = self;
  }

  async loadItems() {
    const state = this._state;

    if (state.reload) {
      this.update({
        items: [],
        loadingMessage: "Loading sessions...",
        helpMarkdown:
          (state.showAll
            ? "Showing: **All sessions**"
            : "Showing: **Project sessions**") +
          "\n\n" +
          "Available commands:\n" +
          "- **Enter** — Open selected chat\n" +
          "- **Ctrl+Enter** — Open chat (keep list open)\n" +
          "- **Ctrl+D** — Delete selected chat\n" +
          "- **Ctrl+0** — Toggle project/all\n" +
          "- **F5** — Refresh list",
      });

      const projectPaths = state.showAll ? [] : atom.project.getPaths();
      const sessions = await listSessions(projectPaths);

      state.items = sessions.map(formatSessionForList).map((item, index, arr) => {
        // Format: "description label" - message first for better scoring
        item.text = item.description + " " + item.label;
        // Recency bonus: earlier items (more recent) get higher bonus (1.2 → 1.0)
        item._recency = 1 + (arr.length - index) / (arr.length * 5);
        return item;
      });

      this.update({
        items: state.items,
        loadingMessage: null,
      });

      state.reload = false;
    }
  }

  async clearHistory() {
    const projectPaths = atom.project.getPaths();
    const sessions = await listSessions(projectPaths);

    if (sessions.length === 0) {
      atom.notifications.addInfo("No chat history to clear.");
      return;
    }

    const confirmed = atom.confirm({
      message: "Clear Chat History",
      detailedMessage: `Delete ${sessions.length} chat session(s) for this project?`,
      buttons: ["Delete", "Cancel"],
    });

    if (confirmed === 0) {
      const deleted = await clearAllSessions(projectPaths);
      atom.notifications.addSuccess(`Deleted ${deleted} chat session(s).`);
    }
  }

  async openSession(sessionId) {
    const main = this._state.main;
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

    const sessionData = await loadSession(sessionId);
    if (!sessionData) {
      atom.notifications.addError("Failed to load session.");
      return;
    }

    // Reuse empty existing panel if available
    if (main.panel?.canLoadSession()) {
      main.panel.loadSession(sessionData);
      const pane = atom.workspace.paneForItem(main.panel);
      pane?.activateItem(main.panel);
      requestAnimationFrame(() => main.panel?.focus());
      return;
    }

    const location = Config.panelPosition();
    main.panel = new ChatPanel(sessionData);

    await atom.workspace.open(main.panel, { location });
    requestAnimationFrame(() => main.panel?.focus());
  }
}

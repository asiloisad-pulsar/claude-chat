/** @babel */

import BaseList, { highlightMatches } from "./components/base-list";

/**
 * Available slash commands for Claude CLI
 */
const SLASH_COMMANDS = [
  { name: "compact", description: "Compact conversation context" },
  { name: "cost", description: "Show token cost breakdown" },
  { name: "init", description: "Initialize project configuration" },
  { name: "pr-comments", description: "Review PR comments" },
  { name: "release-notes", description: "Generate release notes" },
  { name: "review", description: "Code review current changes" },
  { name: "security-review", description: "Security audit of code" },
];

/**
 * SlashList manages the slash command select list.
 * Extends BaseList for common functionality.
 */
export default class SlashList extends BaseList {
  constructor(main) {
    super({
      items: SLASH_COMMANDS,
      className: "claude-chat-slash",
      emptyMessage: "No matching commands",
      maxResults: 20,

      filterKeyForItem: (item) => "/" + item.name + " " + item.description,

      elementForItem: (item, { matchIndices }) => {
        const li = document.createElement("li");
        li.classList.add("two-lines");
        const matches = matchIndices || [];

        const priBlock = document.createElement("div");
        priBlock.classList.add("primary-line");
        priBlock.appendChild(highlightMatches(`/${item.name}`, matches));
        li.appendChild(priBlock);

        const secBlock = document.createElement("div");
        secBlock.classList.add("secondary-line");
        const nameLen = item.name.length + 2;
        secBlock.appendChild(
          highlightMatches(
            item.description,
            matches.map((x) => x - nameLen),
          ),
        );
        li.appendChild(secBlock);

        return li;
      },

      didConfirmSelection: (item) => {
        this.hide();
        this.sendCommand(item.name);
      },

      didCancelSelection: () => {
        this.hide();
        main.focusActiveChat();
      },

      scopedCommands: {
        ".claude-chat": {
          "claude-chat:slash-commands": () => this.toggle(),
        },
      },
    });

    this.main = main;
  }

  sendCommand(name) {
    const panel = this.main.getActiveChat();
    if (panel) {
      panel.sendSlashCommand(name);
    }
  }
}

/** @babel */

import BaseList, { highlightMatches } from "./components/base-list";
import Config from "./utils/config";

function shiftedMatches(matches, start, length) {
  return matches
    .map((index) => index - start)
    .filter((index) => index >= 0 && index < length);
}

function modelTextParts(item) {
  const label = item.label || item.value;
  const description = item.description || "";
  const parts = [];

  if (!item.custom) {
    if (item.value && item.value !== label) {
      parts.push({ text: item.value, kind: "value" });
    }
    parts.push({ text: label, kind: "label" });
  } else {
    parts.push({ text: item.value, kind: "value" });
    const hasDisplayName = label && label !== item.value;
    if (hasDisplayName) {
      parts.push({ text: label, kind: "label" });
    }
  }

  if (description) {
    parts.push({ text: description, kind: "description" });
  }

  let offset = 0;
  return parts.map((part) => {
    const next = { ...part, offset };
    offset += part.text.length + 1;
    return next;
  });
}

/**
 * ModelList manages the model select list.
 */
export default class ModelList extends BaseList {
  constructor(main) {
    super({
      className: "claude-chat-model-list",
      emptyMessage: "No matching models",
      maxResults: 30,
      willShow: () => this.loadItems(),
      filterKeyForItem: (item) => modelTextParts(item).map((part) => part.text).join(" "),

      elementForItem: (item, { matchIndices }) => {
        const li = document.createElement("li");
        li.classList.add("two-lines");
        if (item.value === this.currentModel) li.classList.add("selected-model");

        const matches = matchIndices || [];
        const parts = modelTextParts(item);
        const priBlock = document.createElement("div");
        priBlock.classList.add("primary-line");

        for (const part of parts.filter((p) => p.kind === "label" || p.kind === "value")) {
          const el =
            part.kind === "value" ? document.createElement("code") : document.createElement("span");
          el.classList.add(part.kind === "value" ? "model-list-value" : "model-list-label");
          el.appendChild(
            highlightMatches(part.text, shiftedMatches(matches, part.offset, part.text.length)),
          );
          priBlock.appendChild(el);
        }

        li.appendChild(priBlock);

        const descriptionPart = parts.find((part) => part.kind === "description");
        if (descriptionPart) {
          const secBlock = document.createElement("div");
          secBlock.classList.add("secondary-line");
          secBlock.appendChild(
            highlightMatches(
              descriptionPart.text,
              shiftedMatches(matches, descriptionPart.offset, descriptionPart.text.length),
            ),
          );
          li.appendChild(secBlock);
        }

        return li;
      },

      didConfirmSelection: (item) => {
        this.hide();
        this.selectModel(item.value);
      },

      didCancelSelection: () => {
        this.hide();
        main.focusActiveChat();
      },

      workspaceCommands: {
        "claude-chat:model-selector": () => this.toggle(),
      },
    });

    this.main = main;
    this.currentModel = this.getCurrentModel();
  }

  getCurrentModel() {
    return this.main.getActiveChat()?.getSelectedModel() || Config.model();
  }

  loadItems() {
    this.currentModel = this.getCurrentModel();
    this.updateItems(Config.modelOptions());
  }

  selectModel(model) {
    const panel = this.main.getActiveChat();
    if (panel) {
      panel.selectModel(model);
    }
  }
}

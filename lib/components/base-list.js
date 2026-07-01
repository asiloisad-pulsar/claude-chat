/** @babel */

import { CompositeDisposable } from "atom";

const { SelectListView, highlightMatches } = require("@asiloisad/select-list");

/**
 * Base class for SelectList-based components.
 * Reduces boilerplate in HistoryList and SlashList.
 */
export default class BaseList {
  /**
   * @param {Object} config - Configuration for the list
   * @param {string} config.className - CSS class name
   * @param {string} config.emptyMessage - Message when no items
   * @param {number} config.maxResults - Max results to show
   * @param {Function} config.filterKeyForItem - Get filter key from item
   * @param {Function} config.elementForItem - Render item element
   * @param {Function} config.didConfirmSelection - Handle selection confirm
   * @param {Function} config.didCancelSelection - Handle selection cancel
   * @param {Object} config.listCommands - Commands for the select list element
   * @param {Object} config.workspaceCommands - Commands for atom-workspace
   * @param {Function} config.willShow - Called before showing list
   */
  constructor(config) {
    this.config = config;
    this.items = [];
    this.disposables = new CompositeDisposable();

    this.selectList = new SelectListView({
      items: config.items || [],
      maxResults: config.maxResults || 50,
      className: config.className,
      emptyMessage: config.emptyMessage,
      filterKeyForItem: config.filterKeyForItem,
      removeDiacritics: config.removeDiacritics ?? true,
      willShow: config.willShow,
      helpMarkdown: config.helpMarkdown,

      elementForItem: (item, opts) => this.renderItem(item, opts),
      didConfirmSelection: (item) => this.onConfirm(item),
      didCancelSelection: () => this.onCancel(),
    });

    this.setupCommands(config);
  }

  /**
   * Setup commands for the list
   */
  setupCommands(config) {
    // Commands for the select list element
    if (config.listCommands) {
      this.disposables.add(atom.commands.add(this.selectList.element, config.listCommands));
    }

    // Commands for atom-workspace
    if (config.workspaceCommands) {
      this.disposables.add(atom.commands.add("atom-workspace", config.workspaceCommands));
    }

    // Commands for custom scope
    if (config.scopedCommands) {
      for (const [scope, commands] of Object.entries(config.scopedCommands)) {
        this.disposables.add(atom.commands.add(scope, commands));
      }
    }
  }

  /**
   * Render a list item - override in subclass or provide in config
   */
  renderItem(item, opts) {
    if (this.config.elementForItem) {
      return this.config.elementForItem(item, opts);
    }
    return this.renderTwoLineItem(item, opts);
  }

  /**
   * Default two-line item renderer
   */
  renderTwoLineItem(item, { filterKey, matchIndices } = {}) {
    const li = document.createElement("li");
    li.classList.add("two-lines");

    const matches = matchIndices || [];

    // Primary line
    const priBlock = document.createElement("div");
    priBlock.classList.add("primary-line");
    priBlock.appendChild(highlightMatches(filterKey || item.label || item.name || "", matches));
    li.appendChild(priBlock);

    // Secondary line
    if (item.description) {
      const secBlock = document.createElement("div");
      secBlock.classList.add("secondary-line");
      const labelLen = (filterKey || item.label || item.name || "").length + 1;
      secBlock.appendChild(
        highlightMatches(
          item.description,
          matches.map((x) => x - labelLen),
        ),
      );
      li.appendChild(secBlock);
    }

    return li;
  }

  /**
   * Handle selection confirm
   */
  onConfirm(item) {
    if (this.config.didConfirmSelection) {
      this.config.didConfirmSelection(item);
    }
  }

  /**
   * Handle selection cancel
   */
  onCancel() {
    if (this.config.didCancelSelection) {
      this.config.didCancelSelection();
    }
    this.hide();
  }

  /**
   * Update the list items
   */
  updateItems(items) {
    this.items = items;
    return this.selectList.update({ items });
  }

  /**
   * Update list with additional options
   */
  update(options) {
    this.selectList.update(options);
  }

  /**
   * Get currently selected item
   */
  getSelectedItem() {
    return this.selectList.getSelectedItem();
  }

  /**
   * Get currently selected visible item index
   */
  getSelectedIndex() {
    return this.selectList.selectionIndex;
  }

  /**
   * Get number of currently visible filtered items
   */
  getVisibleItemCount() {
    return this.selectList.items?.length || 0;
  }

  /**
   * Select visible item by index
   */
  selectIndex(index) {
    return this.selectList.selectIndex(index);
  }

  /**
   * Toggle list visibility
   */
  toggle() {
    this.selectList.toggle();
  }

  /**
   * Show the list
   */
  show() {
    this.selectList.show();
  }

  /**
   * Hide the list
   */
  hide() {
    this.selectList.hide();
  }

  /**
   * Destroy the list
   */
  destroy() {
    this.disposables.dispose();
    this.selectList.destroy();
  }
}

export { highlightMatches };

/** @babel */

import { LANG_SCOPE_MAP } from "../message-renderer";
import { TextBuffer } from "atom";

/**
 * Etch component that renders markdown HTML with syntax highlighting.
 *
 * Prefers tree-sitter grammars (async): creates a temporary TextBuffer, assigns grammar,
 * waits for parsing, extracts tokens via the highlight iterator, and replaces code block HTML.
 * Falls back to TextMate tokenization (synchronous, already in the HTML from renderMarkdown).
 *
 * No atom-text-editor elements — output is lightweight <span class="syntax--..."> HTML.
 */
export default class HighlightedContent {
  constructor({ html, className }) {
    this.html = html;
    this.element = document.createElement("div");
    this.element.className = className || "message-content message-markdown";
    this.element.innerHTML = html || "";
    this.pendingEnhance = null;
    this.enhanceTreeSitterBlocks();
  }

  update({ html, className }) {
    if (html === this.html) return;
    this.cancelPending();
    this.html = html;
    this.element.innerHTML = html || "";
    this.enhanceTreeSitterBlocks();
    return Promise.resolve();
  }

  /**
   * Find code blocks with a language class and async-enhance them
   * with tree-sitter tokenization. Falls back to TextMate (already in HTML) if unavailable.
   */
  enhanceTreeSitterBlocks() {
    const codeElements = this.element.querySelectorAll('pre > code[class*="language-"]');
    const toEnhance = [];

    for (const codeEl of codeElements) {
      const langMatch = codeEl.className.match(/language-(\S+)/);
      if (!langMatch) continue;

      const lang = langMatch[1].toLowerCase();
      const scope = LANG_SCOPE_MAP[lang] || `source.${lang}`;
      toEnhance.push({ codeEl, scope });
    }

    if (toEnhance.length === 0) return;

    this.pendingEnhance = this.doEnhance(toEnhance);
  }

  async doEnhance(blocks) {
    for (const { codeEl, scope } of blocks) {
      try {
        const code = codeEl.textContent;
        const highlighted = await highlightWithTreeSitter(code, scope);
        if (highlighted && this.element.isConnected !== false) {
          codeEl.innerHTML = highlighted;
        }
      } catch (e) {
        // Silently skip — block stays unhighlighted
      }
    }
    this.pendingEnhance = null;
  }

  cancelPending() {
    // Setting pendingEnhance to null signals we don't care about old results.
    // The async function checks isConnected as a guard.
    this.pendingEnhance = null;
  }

  destroy() {
    this.cancelPending();
  }
}

/**
 * Tokenize code using tree-sitter via a temporary TextBuffer + language mode.
 * Returns HTML string with <span class="syntax--..."> tokens, or null if unavailable.
 */
async function highlightWithTreeSitter(code, scope) {
  const grammar = atom.grammars.grammarForScopeName(scope);
  if (!grammar) return null;

  // Only use tree-sitter grammars (TextMate is handled synchronously elsewhere)
  if (!grammar.getLanguage) return null;

  const buffer = new TextBuffer({ text: code });
  try {
    // Assign language mode — creates WASMTreeSitterLanguageMode for tree-sitter grammars
    atom.grammars.assignLanguageMode(buffer, scope);

    const languageMode = buffer.getLanguageMode();

    // Wait for tree-sitter to parse
    if (languageMode.ready) await languageMode.ready;

    // Tokenize each line using the highlight iterator
    const lineCount = buffer.getLineCount();
    const htmlLines = [];

    for (let row = 0; row < lineCount; row++) {
      htmlLines.push(tokenizeLineToHtml(languageMode, row));
    }

    return htmlLines.join("\n");
  } finally {
    buffer.destroy();
  }
}

/**
 * Tokenize a single line using the highlight iterator.
 * Based on WASMTreeSitterLanguageMode.tokenizedLineForRow() pattern.
 */
function tokenizeLineToHtml(languageMode, row) {
  const lineText = languageMode.buffer.lineForRow(row);
  if (lineText == null) return "";

  const iterator = languageMode.buildHighlightIterator();
  let start = { row, column: 0 };
  const scopes = iterator.seek(start, row) || [];
  const parts = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const end = { ...iterator.getPosition() };
    if (end.row > row) {
      end.row = row;
      end.column = lineText.length;
    }

    if (end.column > start.column) {
      const text = lineText.substring(start.column, end.column);
      const classNames = scopes
        .map((id) => languageMode.classNameForScopeId(id))
        .filter(Boolean)
        .join(" ");

      if (classNames) {
        parts.push(`<span class="${classNames}">${escapeHtml(text)}</span>`);
      } else {
        parts.push(escapeHtml(text));
      }
    }

    if (end.column < lineText.length) {
      const closeScopeCount = iterator.getCloseScopeIds().length;
      for (let i = 0; i < closeScopeCount; i++) scopes.pop();
      scopes.push(...iterator.getOpenScopeIds());
      start = end;
      iterator.moveToSuccessor();
    } else {
      break;
    }
  }

  return parts.join("");
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @babel */
/** @jsx etch.dom */

import etch from "etch";
import { renderTool } from "./tool-renderers";
import HighlightedContent from "./components/highlighted-content";

// Language identifier → TextMate grammar scope mapping
export const LANG_SCOPE_MAP = {
  js: "source.js", javascript: "source.js", jsx: "source.js",
  ts: "source.ts", typescript: "source.ts", tsx: "source.ts",
  py: "source.python", python: "source.python",
  rb: "source.ruby", ruby: "source.ruby",
  java: "source.java",
  c: "source.c", cpp: "source.cpp", "c++": "source.cpp",
  cs: "source.cs", csharp: "source.cs",
  go: "source.go", golang: "source.go",
  rust: "source.rust", rs: "source.rust",
  sh: "source.shell", bash: "source.shell", zsh: "source.shell", shell: "source.shell",
  html: "text.html.basic", xml: "text.xml",
  css: "source.css", less: "source.css.less", scss: "source.css.scss", sass: "source.sass",
  json: "source.json", yaml: "source.yaml", yml: "source.yaml",
  md: "source.gfm", markdown: "source.gfm",
  sql: "source.sql",
  php: "text.html.php",
  coffee: "source.coffee", coffeescript: "source.coffee",
  toml: "source.toml",
  diff: "source.diff", patch: "source.diff",
  lua: "source.lua",
  r: "source.r",
  perl: "source.perl", pl: "source.perl",
  swift: "source.swift",
  kotlin: "source.kotlin", kt: "source.kotlin",
  scala: "source.scala",
  clj: "source.clojure", clojure: "source.clojure",
  haskell: "source.haskell", hs: "source.haskell",
  elixir: "source.elixir", ex: "source.elixir",
  erlang: "source.erlang", erl: "source.erlang",
  makefile: "source.makefile", make: "source.makefile",
  dockerfile: "source.dockerfile", docker: "source.dockerfile",
  ini: "source.ini",
  properties: "source.java-properties",
  sofistik: "source.sofistik", sof: "source.sofistik",
};

const grammarCache = new Map();

function getGrammar(lang) {
  lang = lang.toLowerCase();
  if (grammarCache.has(lang)) return grammarCache.get(lang);

  const scope = LANG_SCOPE_MAP[lang] || `source.${lang}`;
  const grammar = atom.grammars.textmateRegistry.grammarForScopeName(scope);

  grammarCache.set(lang, grammar || null);
  return grammar || null;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeHtml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tokenToHtml(token) {
  if (!token.value) return "";
  const classes = token.scopes
    .map((s) => s.split(".").map((p) => "syntax--" + p).join(" "))
    .join(" ");
  return `<span class="${classes}">${escapeHtml(token.value)}</span>`;
}

function highlightCode(code, lang) {
  // Skip TextMate if a tree-sitter grammar exists (handled async by HighlightedContent)
  const scope = LANG_SCOPE_MAP[lang.toLowerCase()] || `source.${lang.toLowerCase()}`;
  const tsGrammar = atom.grammars.grammarForScopeName(scope);
  if (tsGrammar && tsGrammar.getLanguage) return null;

  const grammar = getGrammar(lang);
  if (!grammar) return null;

  try {
    const lines = grammar.tokenizeLines(code);
    return lines
      .map((tokens) => tokens.map(tokenToHtml).join(""))
      .join("\n");
  } catch (e) {
    return null;
  }
}

function highlightCodeBlocks(html) {
  return html.replace(
    /<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g,
    (match, lang, content) => {
      const code = unescapeHtml(content.replace(/\n$/, ""));
      const highlighted = highlightCode(code, lang);
      if (!highlighted) return match;
      return `<pre><code class="language-${lang}">${highlighted}</code></pre>`;
    },
  );
}

// Lazy initialize MathJax (same pattern as hydrogen-next)
let mjInitialized = false;
let adaptor = null;
let htmlDoc = null;

function initMathJax() {
  if (mjInitialized) return true;

  try {
    const { mathjax } = require("@mathjax/src/cjs/mathjax.js");
    const { TeX } = require("@mathjax/src/cjs/input/tex.js");
    const { SVG } = require("@mathjax/src/cjs/output/svg.js");
    const { liteAdaptor } = require("@mathjax/src/cjs/adaptors/liteAdaptor.js");
    const { RegisterHTMLHandler } = require("@mathjax/src/cjs/handlers/html.js");

    // Load TeX packages
    require("@mathjax/src/cjs/input/tex/base/BaseConfiguration.js");
    require("@mathjax/src/cjs/input/tex/ams/AmsConfiguration.js");
    require("@mathjax/src/cjs/input/tex/newcommand/NewcommandConfiguration.js");

    adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);

    const tex = new TeX({ packages: ["base", "ams", "newcommand"] });
    const svg = new SVG({ fontCache: "local" });
    htmlDoc = mathjax.document("", { InputJax: tex, OutputJax: svg });

    mjInitialized = true;
    return true;
  } catch (err) {
    console.error("MathJax initialization error:", err);
    return false;
  }
}

function renderMathToSvg(latex, displayMode) {
  if (!htmlDoc || !adaptor) return null;
  try {
    const node = htmlDoc.convert(latex, { display: displayMode });
    return adaptor.innerHTML(node);
  } catch (e) {
    return null;
  }
}

/**
 * Render markdown with LaTeX support.
 * Extracts LaTeX before markdown processing to preserve backslashes,
 * then renders LaTeX SVGs and restores them after markdown.
 */
function renderMarkdown(content) {
  if (!content) return "";

  // Extract LaTeX blocks before markdown to preserve \\ and other sequences
  const placeholders = [];

  // Extract block math $$...$$
  let processed = content.replace(/\$\$([\s\S]*?)\$\$/g, (match, tex) => {
    const id = `%%MATH_BLOCK_${placeholders.length}%%`;
    placeholders.push({ id, tex: tex.trim(), display: true });
    return id;
  });

  // Extract inline math $...$
  processed = processed.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (match, tex) => {
    const id = `%%MATH_INLINE_${placeholders.length}%%`;
    placeholders.push({ id, tex: tex.trim(), display: false });
    return id;
  });

  // Render markdown on text without LaTeX
  let html = atom.ui.markdown.render(processed, {
    breaks: true,
    handleFrontMatter: false,
    useDefaultEmoji: true,
    transformImageLinks: false,
    transformAtomLinks: false,
    transformNonFqdnLinks: false,
  });

  // Apply syntax highlighting to fenced code blocks
  html = highlightCodeBlocks(html);

  // Replace placeholders with rendered LaTeX SVGs
  for (const { id, tex, display } of placeholders) {
    const svg = initMathJax() ? renderMathToSvg(tex, display) : null;
    if (svg) {
      const wrapped = display
        ? `<div class="math-block">${svg}</div>`
        : `<span class="math-inline">${svg}</span>`;
      html = html.replace(id, wrapped);
    } else {
      // Fallback: show raw LaTeX
      const delimiter = display ? "$$" : "$";
      html = html.replace(id, `${delimiter}${tex}${delimiter}`);
    }
  }

  return html;
}

/**
 * Generate tooltip text for attach context
 */
function getAttachTooltip(attach) {
  if (!attach) return "";

  const { type, path, paths, selections } = attach;
  const filePath = path || paths?.[0];

  if (type === "selections" && selections) {
    const hasText = selections.some((s) => s.text);
    if (hasText) {
      const totalChars = selections.reduce((sum, s) => sum + (s.text?.length || 0), 0);
      return `${selections.length} selection(s) from ${filePath}\n${totalChars} characters`;
    }
    return `${selections.length} cursor(s) in ${filePath}`;
  } else if (type === "paths") {
    const allPaths = paths || (path ? [path] : []);
    if (allPaths.length === 1) {
      return `Path: ${allPaths[0]}`;
    }
    return `Paths:\n${allPaths.join("\n")}`;
  }
  return attach.label || "";
}

/**
 * Render attach context badge
 */
function renderAttachBadge(attach) {
  if (!attach) return null;

  let label = attach.label;
  let icon = attach.icon || "mention";
  let tooltip = getAttachTooltip(attach);

  return (
    <span className="attach-badge" attributes={{ "data-tooltip": tooltip }}>
      <span className={`icon-${icon}`}></span>
      <span className="attach-badge-label">{label}</span>
    </span>
  );
}

/**
 * Render a user message
 */
export function renderUserMessage(msg, index) {
  const html = renderMarkdown(msg.content);
  return (
    <div className="message message-user" key={index}>
      <div className="message-role">
        You
        {renderAttachBadge(msg.attach)}
      </div>
      <div className="message-content message-markdown" innerHTML={html} />
    </div>
  );
}

/**
 * Render an assistant message with markdown
 */
export function renderAssistantMessage(msg, index) {
  const html = renderMarkdown(msg.content);
  return (
    <div className="message message-assistant" key={index}>
      <HighlightedContent html={html} />
    </div>
  );
}

/**
 * Render an error message
 */
export function renderErrorMessage(msg, index) {
  const html = renderMarkdown(msg.content);
  return (
    <div className="message message-error" key={index}>
      <span className="error-icon">!</span>
      <span className="error-text message-markdown" innerHTML={html} />
    </div>
  );
}

/**
 * Render the current streaming response wrapped in timeline
 */
export function renderStreamingMessage(currentText, isLoading) {
  if (!currentText && !isLoading) return null;

  const html = currentText ? renderMarkdown(currentText) : "";
  const showCursor = isLoading && currentText;

  return (
    <div className="response-sequence streaming-sequence">
      <div className="timeline-item timeline-last">
        <div className="timeline-dot dot-assistant"></div>
        <div className="timeline-content">
          <div className="message message-assistant">
            <div className="message-content message-markdown" innerHTML={html} />
            {showCursor ? (
              <span className="streaming-dots">
                <span className="dot"></span>
                <span className="dot"></span>
                <span className="dot"></span>
              </span>
            ) : null}
            {isLoading && !currentText ? (
              <div className="loading-indicator">
                <span>Thinking</span>
                <span className="dot"></span>
                <span className="dot"></span>
                <span className="dot"></span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Group messages by user messages (user messages split the timeline)
 */
function groupMessagesByUser(messages) {
  const groups = [];
  let currentItems = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (currentItems.length > 0) {
        groups.push({ type: "response", items: currentItems });
        currentItems = [];
      }
      groups.push({ type: "user", message: msg });
    } else {
      currentItems.push(msg);
    }
  }

  if (currentItems.length > 0) {
    groups.push({ type: "response", items: currentItems });
  }

  return groups;
}

/**
 * Get the dot CSS class for a message type
 */
function getDotClass(msg) {
  if (msg.role === "assistant") return "dot-assistant";
  if (msg.role === "tool") return `dot-tool dot-${msg.name.toLowerCase()}`;
  if (msg.role === "error") return "dot-error";
  return "dot-default";
}

/**
 * Render a single timeline item
 */
function renderTimelineItem(msg, index, toolHandlers) {
  switch (msg.role) {
    case "assistant":
      return renderAssistantMessage(msg, index);
    case "tool":
      return renderTool(msg, index, toolHandlers);
    case "error":
      return renderErrorMessage(msg, index);
    default:
      return null;
  }
}

/**
 * Render a user message block (standalone, outside timeline)
 */
function renderUserMessageBlock(msg, index) {
  return (
    <div className="user-message-block" key={`user-${index}`}>
      {renderUserMessage(msg, index)}
    </div>
  );
}

/**
 * Render a response sequence with timeline
 * @param {boolean} hasMoreContent - true if streaming/more content follows this sequence
 */
function renderResponseSequence(items, groupIndex, toolHandlers, hasMoreContent = false) {
  return (
    <div className="response-sequence" key={`response-${groupIndex}`}>
      {items.map((item, i) => {
        const isLastItem = i === items.length - 1;
        // Only mark as timeline-last if it's the last item AND no more content follows
        const isTimelineLast = isLastItem && !hasMoreContent;
        const dotClass = getDotClass(item);

        return (
          <div className={`timeline-item ${isTimelineLast ? "timeline-last" : ""}`} key={i}>
            <div className={`timeline-dot ${dotClass}`}></div>
            <div className="timeline-line"></div>
            <div className="timeline-content">{renderTimelineItem(item, i, toolHandlers)}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Render all messages in the conversation with timeline grouping
 * @param {boolean} isStreaming - true if streaming response is active
 */
export function renderMessages(messages, toolHandlers, isStreaming = false) {
  const groups = groupMessagesByUser(messages);

  return groups.map((group, groupIndex) => {
    const isLastGroup = groupIndex === groups.length - 1;

    if (group.type === "user") {
      return renderUserMessageBlock(group.message, groupIndex);
    } else {
      // If this is the last response group and streaming is active, show connecting line
      const hasMoreContent = isLastGroup && isStreaming;
      return renderResponseSequence(group.items, groupIndex, toolHandlers, hasMoreContent);
    }
  });
}

/**
 * Render welcome page when no messages
 */
export function renderWelcomePage() {
  return (
    <div className="welcome-page">
      <div className="welcome-content">
        <h2 className="welcome-title">Claude Chat</h2>
        <p className="welcome-subtitle">AI assistant for Pulsar</p>

        <div className="welcome-tips">
          <div className="tip-section">
            <h3>Getting Started</h3>
            <ul>
              <li>
                <kbd>Enter</kbd> Send message
              </li>
              <li>
                <kbd>Shift+Enter</kbd> New line
              </li>
              <li>
                <kbd>Escape</kbd> Clear input
              </li>
            </ul>
          </div>

          <div className="tip-section">
            <h3>Permission Modes</h3>
            <ul>
              <li>
                <kbd>Ctrl+1</kbd> Default — Ask before actions
              </li>
              <li>
                <kbd>Ctrl+2</kbd> Plan — Read-only mode
              </li>
              <li>
                <kbd>Ctrl+3</kbd> Accept Edits — Auto-apply changes
              </li>
              <li>
                <kbd>Ctrl+4</kbd> Bypass — Auto-approve all
              </li>
            </ul>
          </div>

          <div className="tip-section tip-section-list">
            <h3>Attach Context</h3>
            <ul>
              <li>Selected code and file localization</li>
              <li>Current file position for precise references</li>
              <li>Filepaths via tree-view command</li>
              <li>Images with optional selection coords</li>
              <li>Hydrogen kernel input/output</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

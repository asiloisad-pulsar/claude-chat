/** @babel */
/** @jsx h */

import { h } from "preact";
import { renderTool } from "./tool-renderers";
import { HighlightedContentWrapper } from "./components/highlighted-content-wrapper";

function formatMessageTime(timestamp) {
  if (!timestamp) return null;

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  const day = date.toLocaleDateString();
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return `${day} ${time}`;
}

function messageTimeTooltip(msg) {
  return formatMessageTime(msg?.timestamp) || undefined;
}

// Language identifier → TextMate grammar scope mapping
export const LANG_SCOPE_MAP = {
  js: "source.js",
  javascript: "source.js",
  jsx: "source.js",
  ts: "source.ts",
  typescript: "source.ts",
  tsx: "source.ts",
  py: "source.python",
  python: "source.python",
  rb: "source.ruby",
  ruby: "source.ruby",
  java: "source.java",
  c: "source.c",
  cpp: "source.cpp",
  "c++": "source.cpp",
  cs: "source.cs",
  csharp: "source.cs",
  go: "source.go",
  golang: "source.go",
  rust: "source.rust",
  rs: "source.rust",
  sh: "source.shell",
  bash: "source.shell",
  zsh: "source.shell",
  shell: "source.shell",
  html: "text.html.basic",
  xml: "text.xml",
  css: "source.css",
  less: "source.css.less",
  scss: "source.css.scss",
  sass: "source.sass",
  json: "source.json",
  yaml: "source.yaml",
  yml: "source.yaml",
  md: "source.gfm",
  markdown: "source.gfm",
  sql: "source.sql",
  php: "text.html.php",
  coffee: "source.coffee",
  coffeescript: "source.coffee",
  toml: "source.toml",
  diff: "source.diff",
  patch: "source.diff",
  lua: "source.lua",
  r: "source.r",
  perl: "source.perl",
  pl: "source.perl",
  swift: "source.swift",
  kotlin: "source.kotlin",
  kt: "source.kotlin",
  scala: "source.scala",
  clj: "source.clojure",
  clojure: "source.clojure",
  haskell: "source.haskell",
  hs: "source.haskell",
  elixir: "source.elixir",
  ex: "source.elixir",
  erlang: "source.erlang",
  erl: "source.erlang",
  makefile: "source.makefile",
  make: "source.makefile",
  dockerfile: "source.dockerfile",
  docker: "source.dockerfile",
  ini: "source.ini",
  properties: "source.java-properties",
  sofistik: "source.sofistik",
  sof: "source.sofistik",
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
    .map((s) =>
      s
        .split(".")
        .map((p) => "syntax--" + p)
        .join(" "),
    )
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
    return lines.map((tokens) => tokens.map(tokenToHtml).join("")).join("\n");
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
 * Render attach context badge(s)
 */
function renderAttachBadge(attach) {
  if (!attach) return null;

  const attachments = Array.isArray(attach) ? attach : [attach];
  if (attachments.length === 0) return null;

  return (
    <div className="message-attach-tray">
      {attachments.map((a, i) => (
        <span key={i} className="attach-badge" data-tooltip={getAttachTooltip(a)}>
          <span
            className={["icon", ...(a.iconClasses || [`icon-${a.icon || "mention"}`])].join(" ")}
          ></span>
          <span className="attach-badge-label">{a.label}</span>
        </span>
      ))}
    </div>
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
        <span className="message-role-label" data-tooltip={messageTimeTooltip(msg)}>
          You
        </span>
        {renderAttachBadge(msg.attach)}
      </div>
      <div
        className="message-content message-markdown"
        dangerouslySetInnerHTML={{ __html: html }}
      />
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
      <HighlightedContentWrapper html={html} />
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
      <span className="error-text message-markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/**
 * Render a system message from the Claude CLI stream.
 */
export function renderSystemMessage(msg, index) {
  if (msg.systemKind === "compact") {
    const preTokens =
      typeof msg.compactPreTokens === "number" ? msg.compactPreTokens.toLocaleString() : null;
    return (
      <div
        className={`message message-tool message-system message-compact message-system-${msg.systemStatus}`}
        key={index}
      >
        <div className="tool-header">
          <span className="tool-name">{msg.title || "System"}</span>
        </div>
        {msg.compactTrigger || preTokens ? (
          <div className="compact-content">
            <div className="message-content">
              {msg.compactTrigger ? <div>Trigger: {msg.compactTrigger}</div> : null}
              {preTokens ? <div>Pre-compaction tokens: {preTokens}</div> : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const html = renderMarkdown(msg.content);
  return (
    <div className="message message-system" key={index}>
      <span className="system-icon icon icon-info"></span>
      <span className="system-text message-markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/**
 * Render a finalized thinking block (tool-like, uncollapsed by default)
 */
export function renderThinkingMessage(msg, index, handlers) {
  const preview = msg.content.slice(0, 80) + (msg.content.length > 80 ? "..." : "");
  const collapsed = msg.collapsed ? "collapsed" : "";
  const html = renderMarkdown(msg.content);
  return (
    <div className={`message message-tool message-thinking ${collapsed}`} key={index}>
      <div className="tool-header">
        <span className="tool-name tool-toggle" onClick={() => handlers?.toggle(msg.id)}>
          Thinking
        </span>
        <span className="thinking-preview">{preview}</span>
      </div>
      <div className="thinking-content">
        <div
          className="message-content message-markdown"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}

/**
 * Render the current streaming response wrapped in timeline
 */
export function renderStreamingMessage(currentText, currentThinking, isLoading) {
  if (!currentText && !currentThinking && !isLoading) return null;

  const html = currentText ? renderMarkdown(currentText) : "";
  const thinkingHtml = currentThinking ? renderMarkdown(currentThinking) : "";
  const showCursor = isLoading && currentText;
  const isWaiting = isLoading && !currentText;

  return (
    <div className="response-sequence streaming-sequence">
      {currentThinking ? (
        <div className="timeline-item timeline-last">
          <div className="timeline-dot dot-thinking"></div>
          <div className="timeline-line"></div>
          <div className="timeline-content">
            <div className="message message-tool message-thinking thinking-streaming">
              <div className="tool-header">
                <span className="tool-name">Thinking</span>
                {isLoading && !currentText ? (
                  <span className="streaming-indicator">
                    <span className="dot"></span>
                    <span className="dot"></span>
                    <span className="dot"></span>
                  </span>
                ) : null}
              </div>
              <div className="thinking-content">
                <div
                  className="message-content message-markdown"
                  dangerouslySetInnerHTML={{ __html: thinkingHtml }}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {!currentThinking ? (
        <div className="timeline-item timeline-last">
          <div className="timeline-dot dot-assistant"></div>
          <div className="timeline-content">
            <div className="message message-assistant">
              <div
                className="message-content message-markdown"
                dangerouslySetInnerHTML={{ __html: html }}
              />
              {showCursor ? (
                <span className="streaming-dots">
                  <span className="dot"></span>
                  <span className="dot"></span>
                  <span className="dot"></span>
                </span>
              ) : null}
              {isWaiting ? (
                <div className="loading-indicator">
                  <span className="loading-label">Processing</span>
                  <span className="dot"></span>
                  <span className="dot"></span>
                  <span className="dot"></span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
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
  if (msg.role === "thinking") return "dot-thinking";
  if (msg.role === "tool") return `dot-tool dot-${msg.name.toLowerCase()}`;
  if (msg.role === "error") return "dot-error";
  if (msg.role === "system") return "dot-system";
  return "dot-default";
}

/**
 * Render a single timeline item
 */
function renderTimelineItem(msg, index, toolHandlers) {
  switch (msg.role) {
    case "assistant":
      return renderAssistantMessage(msg, index);
    case "thinking":
      return renderThinkingMessage(msg, index, toolHandlers);
    case "tool":
      return renderTool(msg, index, toolHandlers);
    case "error":
      return renderErrorMessage(msg, index);
    case "system":
      return renderSystemMessage(msg, index);
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
            <h3>Quick actions</h3>
            <ul>
              <li>
                <kbd>Alt+C</kbd> Switch between prompt and editor
              </li>
              <li
                className="tip-clickable"
                onClick={() =>
                  atom.commands.dispatch(atom.views.getView(atom.workspace), "claude-chat:history")
                }
              >
                <kbd>Alt+Shift+C</kbd> Browse History
              </li>
              {atom.packages.isPackageActive("pulsar-mcp") ? (
                <li
                  className="tip-clickable"
                  onClick={() =>
                    atom.commands.dispatch(
                      atom.views.getView(atom.workspace),
                      "pulsar-mcp:toggle-tools",
                    )
                  }
                >
                  <kbd>Alt+Shift+M</kbd> Toggle MCP tools
                </li>
              ) : null}
            </ul>
          </div>

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
                <kbd>Escape</kbd> Clear Prompt
              </li>
            </ul>
          </div>

          <div className="tip-section">
            <h3>Effort and Permission Modes</h3>
            <ul>
              <li>
                <kbd>Ctrl+0</kbd> Cycle effort: Low, Medium, High, XHigh, Max
              </li>
              <li>
                <kbd>Ctrl+1</kbd> Default: Ask before actions
              </li>
              <li>
                <kbd>Ctrl+2</kbd> Plan: Read-only mode
              </li>
              <li>
                <kbd>Ctrl+3</kbd> Accept Edits: Auto-apply changes
              </li>
              <li>
                <kbd>Ctrl+4</kbd> Auto: Background safety checks
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

/** @babel */
/** @jsx etch.dom */

import etch from "etch";
import { renderTool } from "./tool-renderers";

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
 * Render LaTeX expressions in HTML content using MathJax 4
 */
function renderLatex(html) {
  if (!html || !initMathJax()) return html;

  // Handle block math in <code class="language-latex"> blocks
  html = html.replace(
    /<pre><code class="language-latex">\s*\$\$([\s\S]*?)\$\$\s*<\/code><\/pre>/g,
    (match, tex) => {
      const svg = renderMathToSvg(tex.trim(), true);
      return svg ? `<div class="math-block">${svg}</div>` : match;
    },
  );

  // Handle block math $$...$$
  html = html.replace(/\$\$([\s\S]*?)\$\$/g, (match, tex) => {
    const svg = renderMathToSvg(tex.trim(), true);
    return svg ? `<div class="math-block">${svg}</div>` : match;
  });

  // Handle inline math $...$
  html = html.replace(/(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g, (match, tex) => {
    const svg = renderMathToSvg(tex.trim(), false);
    return svg ? `<span class="math-inline">${svg}</span>` : match;
  });

  return html;
}

/**
 * Render markdown with LaTeX support
 */
function renderMarkdown(content) {
  const html = atom.ui.markdown.render(content);
  return renderLatex(html);
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
 * Render a user message - preserve newlines as user typed them
 */
export function renderUserMessage(msg, index) {
  // Convert newlines to <br> before markdown processing to preserve user's formatting
  const withBreaks = msg.content.replace(/\n/g, "  \n");
  const html = renderMarkdown(withBreaks);
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
      <div className="message-content message-markdown" innerHTML={html} />
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

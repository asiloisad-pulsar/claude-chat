/** @babel */
/** @jsx h */

import { h } from "preact";

/**
 * Tool renderer factory for claude-chat.
 * Reduces boilerplate by providing a common structure for tool renderers.
 */

/**
 * Create a tool renderer function with common structure
 * @param {Object} config - Renderer configuration
 * @param {string} config.name - Tool display name
 * @param {string} config.className - CSS class suffix (e.g., "read" for "tool-read")
 * @param {string[]} config.extraClasses - Additional CSS classes to add
 * @param {Function} config.getInfo - (input, result) => { path?, info?, count? } - Extract header info
 * @param {Function} config.hasExpandable - (input, result) => boolean - Whether content is expandable
 * @param {Function} config.renderContent - (msg, handlers) => JSX - Render expanded content
 * @param {Function} config.renderHeader - (info, handlers) => JSX - Optional custom header parts
 * @returns {Function} Tool renderer function (msg, index, handlers) => JSX
 */
export function createToolRenderer(config) {
  const {
    name,
    className,
    extraClasses = [],
    getInfo = () => ({}),
    hasExpandable = () => false,
    renderContent = null,
    renderHeader = null,
  } = config;

  return (msg, index, handlers) => {
    const { id, input, result, collapsed, isError } = msg;
    const info = getInfo(input, result, msg);
    const expandable = hasExpandable(input, result);

    const classNames = [
      "message",
      "message-tool",
      `tool-${className || name.toLowerCase()}`,
      ...extraClasses,
      collapsed ? "collapsed" : "",
      isError ? "tool-error" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div className={classNames} key={index}>
        <div className="tool-header">
          <span
            className={`tool-name ${expandable ? "tool-toggle" : ""}`}
            onClick={() => expandable && handlers.toggle(id)}
          >
            {name}
          </span>
          {renderHeader
            ? renderHeader(info, input, result, handlers)
            : renderDefaultHeader(info, handlers)}
        </div>
        {expandable && !collapsed && renderContent ? renderContent(msg, handlers) : null}
      </div>
    );
  };
}

/**
 * Default header renderer with path and info
 */
function renderDefaultHeader(info, handlers) {
  return (
    <span className="tool-header-info">
      {info.path ? (
        <a
          className="tool-path"
          href="#"
          title={info.path}
          onClick={(e) => {
              e.preventDefault();
              handlers.openFile(info.path, info.line);
            }}
        >
          {info.path}
        </a>
      ) : null}
      {info.pathInfo ? <span className="tool-path-info">{info.pathInfo}</span> : null}
      {info.count !== undefined ? (
        <span className="tool-count">
          {info.count} {info.countLabel || "items"}
        </span>
      ) : null}
      {info.resultInfo ? <span className="tool-result-info">{info.resultInfo}</span> : null}
      {info.description ? <span className="tool-description">{info.description}</span> : null}
    </span>
  );
}

/**
 * Render a file path link
 */
export function renderPathLink(path, line, handlers) {
  if (!path) return null;

  return (
    <a
      className="tool-path"
      href="#"
      title={path}
      onClick={(e) => {
          e.preventDefault();
          handlers.openFile(path, line);
        }}
    >
      {path}
    </a>
  );
}

/**
 * Render truncated pre content
 */
export function renderPreContent(content, maxLength = 500, className = "tool-content") {
  if (!content) return null;

  return (
    <pre className={className}>
      {content.slice(0, maxLength)}
      {content.length > maxLength ? "..." : ""}
    </pre>
  );
}

/**
 * Render diff sections (for Edit tool)
 */
export function renderDiff(oldStr, newStr, maxLength = 300) {
  return (
    <div className="tool-diff">
      {oldStr ? (
        <div className="diff-section diff-remove">
          <span className="diff-marker">-</span>
          <pre className="diff-content">
            {oldStr.slice(0, maxLength)}
            {oldStr.length > maxLength ? "..." : ""}
          </pre>
        </div>
      ) : null}
      {newStr ? (
        <div className="diff-section diff-add">
          <span className="diff-marker">+</span>
          <pre className="diff-content">
            {newStr.slice(0, maxLength)}
            {newStr.length > maxLength ? "..." : ""}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Simple tool renderer for tools without expandable content
 * @param {string} name - Tool display name
 * @param {Function} getHeaderInfo - (input) => { text?, code?, path?, badge? }
 * @param {string} className - Optional CSS class suffix (e.g., "mcp-pulsar")
 */
export function createSimpleToolRenderer(name, getHeaderInfo = () => ({}), className = null) {
  return (msg, index, handlers) => {
    const { input, isError } = msg;
    const info = getHeaderInfo(input);

    const classNames = [
      "message",
      "message-tool",
      `tool-${className || name.toLowerCase()}`,
      isError ? "tool-error" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div className={classNames} key={index}>
        <span className="tool-name">{name}</span>
        {info.text ? <span className="tool-info">{info.text}</span> : null}
        {info.path ? (
          <a
            className="tool-path"
            href="#"
            title={info.path}
            onClick={(e) => {
                e.preventDefault();
                handlers?.openFile(info.path);
              }}
          >
            {info.path}
          </a>
        ) : null}
        {info.code ? <code className="tool-pattern">{info.code}</code> : null}
        {info.badge ? <span className="tool-block-mode">{info.badge}</span> : null}
      </div>
    );
  };
}

export default {
  createToolRenderer,
  createSimpleToolRenderer,
  renderPathLink,
  renderPreContent,
  renderDiff,
};

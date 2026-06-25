/** @babel */

import React from "react";
import { createToolRenderer, createSimpleToolRenderer, renderPreContent } from "./tool-base";
import { parseJsonResult, truncateWithCount } from "../utils/result-parsers";

/**
 * MCP Tool renderers for Pulsar integration
 * Handles tools prefixed with mcp__pulsar__
 */

// Alias for cleaner usage
const parseMcpResult = parseJsonResult;

// ============================================================================
// Tool Renderers
// ============================================================================

export const renderMcpGetActiveEditor = createToolRenderer({
  name: "GetActiveEditor",
  className: "mcp-pulsar",
  getInfo: (input, result) => {
    const data = parseMcpResult(result);
    if (!data) return { resultInfo: "No active editor" };
    const parts = [data.grammar, `${data.lineCount} lines`];
    return {
      path: data.path,
      resultInfo: parts.join(", "),
      badge: data.modified ? "modified" : null,
    };
  },
  hasExpandable: () => false,
});

export const renderMcpGetOpenEditors = createToolRenderer({
  name: "GetOpenEditors",
  className: "mcp-pulsar",
  getInfo: (input, result) => {
    const data = parseMcpResult(result);
    const editors = Array.isArray(data) ? data : [];
    const modified = editors.filter((editor) => editor.modified).length;
    return {
      count: editors.length,
      countLabel: editors.length === 1 ? "editor" : "editors",
      badge: modified > 0 ? `${modified} modified` : null,
    };
  },
  hasExpandable: (input, result) => {
    const data = parseMcpResult(result);
    return Array.isArray(data) && data.length > 0;
  },
  renderContent: (msg, handlers) => {
    const editors = parseMcpResult(msg.result);
    if (!Array.isArray(editors)) return null;

    return (
      <div className="tool-mcp-list search-results">
        {editors.map((editor, i) => (
          <div
            className={`mcp-list-item search-entry ${editor.active ? "mcp-active" : ""}`}
            key={i}
          >
            {editor.path ? (
              <a
                className="mcp-path search-path"
                href="#"
                title={editor.path}
                onClick={(e) => {
                  e.preventDefault();
                  handlers.openFile(editor.path);
                }}
              >
                {editor.path}
              </a>
            ) : (
              <span className="mcp-path search-path">Untitled</span>
            )}
            <span className="mcp-value">{editor.grammar || "Plain Text"}</span>
            <span className="mcp-value">{editor.lineCount || 0} lines</span>
            {editor.modified ? <span className="mcp-badge mcp-modified">modified</span> : null}
          </div>
        ))}
      </div>
    );
  },
});

export const renderMcpReadText = createToolRenderer({
  name: "ReadText",
  className: "mcp-pulsar",
  getInfo: (input, result) => {
    const data = parseMcpResult(result);
    if (!data) return { resultInfo: "No active editor" };
    if (typeof data === "string") return { resultInfo: "truncated", isError: true };
    const parts = [];
    // Line pagination mode (offset/limit)
    if (input?.offset !== undefined || input?.limit !== undefined) {
      const range = data.range;
      if (range) {
        parts.push(`lines ${range.start + 1}-${range.end + 1}`);
        if (data.totalLines) parts.push(`of ${data.totalLines}`);
      }
      // Position range mode (start/end points)
    } else if (input?.start || input?.end) {
      const start = input.start;
      const end = input.end;
      if (start && end) {
        parts.push(`[${start.row + 1}:${start.column + 1}]-[${end.row + 1}:${end.column + 1}]`);
      }
      // Full content mode
    } else if (data.content) {
      parts.push(`${data.totalLines || data.content.split("\n").length} lines`);
    }
    return {
      path: data.path,
      resultInfo: parts.join(" ") || null,
    };
  },
  hasExpandable: (input, result) => {
    const data = parseMcpResult(result);
    return typeof data === "string" || data?.content?.length > 0 || data?.contentOmitted;
  },
  renderContent: (msg) => {
    const data = parseMcpResult(msg.result);
    if (typeof data === "string") {
      return <pre className="tool-content tool-error-content">{data}</pre>;
    }
    if (data?.contentOmitted) {
      return (
        <div className="mcp-info-row mcp-warning">
          <span className="mcp-value">{data.contentOmitted}</span>
        </div>
      );
    }
    if (!data?.content) return null;
    return <pre className="tool-content">{truncateWithCount(data.content, 2000)}</pre>;
  },
});

export const renderMcpWriteText = createToolRenderer({
  name: "WriteText",
  className: "mcp-pulsar",
  getInfo: (input, result) => {
    const data = parseMcpResult(result);
    const start = input?.start;
    const end = input?.end;
    const parts = [];
    if (start && end) {
      parts.push(`[${start.row + 1}:${start.column + 1}]-[${end.row + 1}:${end.column + 1}]`);
    }
    if (input?.text) parts.push(`${input.text.length} chars`);
    return {
      path: data?.path || null,
      resultInfo: parts.join(", ") || null,
      badge: data?.written === false ? "failed" : null,
    };
  },
  hasExpandable: (input) => input?.text?.length > 40,
  renderContent: (msg) => renderPreContent(msg.input?.text, 500),
});

export const renderMcpOpenFile = createToolRenderer({
  name: "OpenFile",
  className: "mcp-pulsar",
  getInfo: (input) => ({
    path: input?.path,
    pathInfo:
      input?.row != null
        ? `line ${input.row + 1}${input.column != null ? `:${input.column + 1}` : ""}`
        : null,
  }),
  hasExpandable: () => false,
});

export const renderMcpGetProjectPaths = createToolRenderer({
  name: "GetProjectPaths",
  className: "mcp-pulsar",
  getInfo: (input, result) => {
    const data = parseMcpResult(result);
    const count = Array.isArray(data) ? data.length : 0;
    return { count, countLabel: "projects" };
  },
  hasExpandable: (input, result) => {
    const data = parseMcpResult(result);
    return Array.isArray(data) && data.length > 0;
  },
  renderContent: (msg, handlers) => {
    const data = parseMcpResult(msg.result);
    if (!Array.isArray(data)) return null;
    return (
      <div className="search-results">
        {data.map((path, i) => (
          <div className="search-entry" key={i}>
            <a
              className="search-path"
              href="#"
              title={path}
              onClick={(e) => {
                e.preventDefault();
                handlers.openFile(path);
              }}
            >
              {path}
            </a>
          </div>
        ))}
      </div>
    );
  },
});

export const renderMcpSaveFile = createToolRenderer({
  name: "SaveFile",
  className: "mcp-pulsar",
  getInfo: (input, result) => {
    const data = parseMcpResult(result);
    return {
      path: input?.path,
      resultInfo: data?.saved ? "saved" : "failed",
    };
  },
  hasExpandable: () => false,
});

export const renderMcpGetSelections = createToolRenderer({
  name: "GetSelections",
  className: "mcp-pulsar",
  getInfo: (input, result) => {
    const data = parseMcpResult(result);
    const count = Array.isArray(data) ? data.length : 0;
    return { count, countLabel: count === 1 ? "selection" : "selections" };
  },
  hasExpandable: (input, result) => {
    const data = parseMcpResult(result);
    return Array.isArray(data) && data.length > 0;
  },
  renderContent: (msg) => {
    const data = parseMcpResult(msg.result);
    if (!Array.isArray(data)) return null;
    return (
      <div className="tool-mcp-list search-results">
        {data.map((sel, i) => (
          <div className={`mcp-list-item search-entry ${sel.isEmpty ? "mcp-empty" : ""}`} key={i}>
            <span className="mcp-value">
              [{sel.range?.start?.row + 1}:{sel.range?.start?.column + 1}] → [
              {sel.range?.end?.row + 1}:{sel.range?.end?.column + 1}]
            </span>
            {sel.isEmpty ? (
              <span className="mcp-badge">cursor</span>
            ) : (
              <span className="mcp-selection-text">
                {sel.text?.slice(0, 30)}
                {sel.text?.length > 30 ? "..." : ""}
              </span>
            )}
          </div>
        ))}
      </div>
    );
  },
});

export const renderMcpSetSelections = createToolRenderer({
  name: "SetSelections",
  className: "mcp-pulsar",
  getInfo: (input, result) => {
    const data = parseMcpResult(result);
    const selections = input?.selections || [];
    const count = data?.count || selections.length;
    const allCursors = selections.every(
      (s) => !s.end || (s.start.row === s.end.row && s.start.column === s.end.column),
    );
    return {
      count,
      countLabel: allCursors
        ? count === 1
          ? "cursor"
          : "cursors"
        : count === 1
          ? "selection"
          : "selections",
      resultInfo: data?.set === false ? "failed" : null,
    };
  },
  hasExpandable: (input) => {
    const selections = input?.selections || [];
    return selections.length > 0;
  },
  renderContent: (msg) => {
    const selections = msg.input?.selections || [];
    if (selections.length === 0) return null;
    return (
      <div className="tool-mcp-list search-results">
        {selections.map((sel, i) => {
          const start = sel.start;
          const end = sel.end || sel.start;
          const isCursor = start.row === end.row && start.column === end.column;
          return (
            <div className={`mcp-list-item search-entry ${isCursor ? "mcp-empty" : ""}`} key={i}>
              <span className="mcp-value">
                [{start.row + 1}:{start.column + 1}]
                {isCursor ? "" : ` → [${end.row + 1}:${end.column + 1}]`}
              </span>
              <span className="mcp-badge">{isCursor ? "cursor" : "select"}</span>
            </div>
          );
        })}
      </div>
    );
  },
});

export const renderMcpCloseFile = createToolRenderer({
  name: "CloseFile",
  className: "mcp-pulsar",
  getInfo: (input, result) => {
    const data = parseMcpResult(result);
    return {
      path: input?.path,
      resultInfo: data?.closed ? "closed" : "failed",
    };
  },
  hasExpandable: () => false,
});

export const renderMcpAddProjectPath = createSimpleToolRenderer(
  "AddProjectPath",
  (input) => ({
    path: input?.path,
  }),
  "mcp-pulsar",
);

export const renderMcpGetLinterMessages = createToolRenderer({
  name: "GetLinterMessages",
  className: "mcp-pulsar",
  getInfo: (input, result) => {
    const data = parseMcpResult(result);
    if (!data) return { resultInfo: "No data" };
    const isProject = data.mode === "project";
    // File mode with no active editor
    if (!isProject && !data.path) {
      return { resultInfo: "No active editor" };
    }
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const errors = messages.filter((m) => m.severity === "error").length;
    const warnings = messages.filter((m) => m.severity === "warning").length;
    const infos = messages.filter((m) => m.severity === "info").length;
    const parts = [];
    if (errors) parts.push(errors === 1 ? "1 error" : `${errors} errors`);
    if (warnings) parts.push(warnings === 1 ? "1 warning" : `${warnings} warnings`);
    if (infos) parts.push(infos === 1 ? "1 info" : `${infos} infos`);
    return {
      path: isProject ? null : data.path,
      pathInfo: isProject ? "project" : null,
      resultInfo: parts.length > 0 ? parts.join(", ") : "No issues",
    };
  },
  hasExpandable: (input, result) => {
    const data = parseMcpResult(result);
    return Array.isArray(data?.messages) && data.messages.length > 0;
  },
  renderContent: (msg, handlers) => {
    const data = parseMcpResult(msg.result);
    const messages = data?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return null;

    const isProject = data.mode === "project";
    const maxDisplay = 20;
    const displayItems = messages.slice(0, maxDisplay);
    const remaining = messages.length - maxDisplay;

    return (
      <div className="tool-linter-list">
        {displayItems.map((item, i) => {
          const file = isProject ? item.file : data.path;
          const basename = isProject && item.file ? item.file.replace(/.*[\\/]/, "") : null;
          return (
            <div className={`linter-item linter-${item.severity}`} key={i}>
              <span className="linter-icon">
                {item.severity === "error"
                  ? "\u2716"
                  : item.severity === "warning"
                    ? "\u26A0"
                    : "\u2139"}
              </span>
              <span className="linter-excerpt">{item.excerpt}</span>
              {file && item.range?.start?.row != null ? (
                <a
                  className="linter-line"
                  href="#"
                  title={isProject ? item.file : null}
                  onClick={(e) => {
                    e.preventDefault();
                    handlers.openFile(file, item.range.start.row + 1);
                  }}
                >
                  {basename
                    ? `${basename}:${item.range.start.row + 1}`
                    : `:${item.range.start.row + 1}`}
                </a>
              ) : null}
              <span className="linter-name">{item.linterName}</span>
            </div>
          );
        })}
        {remaining > 0 ? <div className="linter-more">+{remaining} more issues</div> : null}
      </div>
    );
  },
});

// ============================================================================
// Registry
// ============================================================================

export const MCP_TOOL_RENDERERS = {
  mcp__pulsar__GetActiveEditor: renderMcpGetActiveEditor,
  mcp__pulsar__GetOpenEditors: renderMcpGetOpenEditors,
  mcp__pulsar__ReadText: renderMcpReadText,
  mcp__pulsar__WriteText: renderMcpWriteText,
  mcp__pulsar__OpenFile: renderMcpOpenFile,
  mcp__pulsar__GetProjectPaths: renderMcpGetProjectPaths,
  mcp__pulsar__SaveFile: renderMcpSaveFile,
  mcp__pulsar__GetSelections: renderMcpGetSelections,
  mcp__pulsar__SetSelections: renderMcpSetSelections,
  mcp__pulsar__CloseFile: renderMcpCloseFile,
  mcp__pulsar__AddProjectPath: renderMcpAddProjectPath,
  mcp__pulsar__GetLinterMessages: renderMcpGetLinterMessages,
};

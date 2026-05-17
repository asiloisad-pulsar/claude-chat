/** @babel */
/** @jsx h */

import { h } from "preact";
import {
  createToolRenderer,
  createSimpleToolRenderer,
  renderPathLink,
  renderPreContent,
  renderDiff,
} from "./renderers/tool-base";
import { MCP_TOOL_RENDERERS } from "./renderers/pulsar-mcp";
import {
  countNonEmptyLines,
  formatLineCount,
  formatLineRange,
  extractImagePreview,
  parseSearchResults,
  parseToolSearchResults,
  truncateWithCount,
} from "./utils/result-parsers";

/**
 * Tool renderer functions for ChatPanel.
 * Uses factory pattern to reduce boilerplate.
 */

// ============================================================================
// Tool Renderers - Using Factory Pattern
// ============================================================================

export const renderToolRead = createToolRenderer({
  name: "Read",
  className: "read",
  getInfo: (input, result) => ({
    path: input?.file_path || input?.path,
    pathInfo: formatLineRange(input),
    resultInfo: formatLineCount(result),
  }),
  hasExpandable: (input, result) => {
    const preview = extractImagePreview(result);
    const hasText = typeof result === "string" && result.length > 0;
    return !!preview || hasText;
  },
  renderContent: (msg) => {
    const preview = extractImagePreview(msg.result);
    const hasText = typeof msg.result === "string" && msg.result.length > 0;

    return (
      <div className="tool-read-content">
        {preview?.type === "image" ? (
          <div className="tool-preview">
            <img
              src={`data:${preview.mediaType};base64,${preview.data}`}
              alt="Preview"
              draggable={false}
            />
          </div>
        ) : null}
        {hasText ? <pre className="tool-content">{truncateWithCount(msg.result, 5000)}</pre> : null}
      </div>
    );
  },
});

export const renderToolWrite = createToolRenderer({
  name: "Write",
  className: "write",
  getInfo: (input) => ({ path: input?.file_path }),
  hasExpandable: (input) => (input?.content || "").length > 0,
  renderContent: (msg) => renderPreContent(msg.input?.content, 500),
});

export const renderToolEdit = createToolRenderer({
  name: "Edit",
  className: "edit",
  getInfo: (input) => ({ path: input?.file_path }),
  hasExpandable: (input) => !!(input?.old_string || input?.new_string),
  renderContent: (msg) => renderDiff(msg.input?.old_string, msg.input?.new_string),
});

export const renderToolBash = createToolRenderer({
  name: "Bash",
  className: "bash",
  getInfo: (input, result) => ({
    description: input?.description,
    command: input?.command,
    outputLines: result ? result.split("\n").length : 0,
  }),
  hasExpandable: (input, result) =>
    (input?.command || "").length > 60 || (result && result.length > 0),
  renderHeader: (info) => (
    <span className="tool-header-info">
      {info.description ? (
        <span className="tool-description">{info.description}</span>
      ) : (
        <code className="tool-command">
          {(info.command || "").slice(0, 60)}
          {(info.command || "").length > 60 ? "..." : ""}
        </code>
      )}
      {info.outputLines > 0 ? (
        <span className="tool-output-info">
          {info.outputLines} {info.outputLines === 1 ? "line" : "lines"}
        </span>
      ) : null}
    </span>
  ),
  renderContent: (msg) => {
    const { input, result, isError } = msg;
    const command = input?.command || "";
    const hasOutput = result && result.length > 0;

    return (
      <div className="tool-bash-content">
        <div className="bash-command-section">
          <pre className="bash-command-text">{command}</pre>
        </div>
        {hasOutput ? (
          <div className={`bash-output-section ${isError ? "bash-output-error" : ""}`}>
            <pre className="bash-output-text">
              {result.slice(0, 2000)}
              {result.length > 2000 ? `\n... (${result.length - 2000} more chars)` : ""}
            </pre>
          </div>
        ) : null}
      </div>
    );
  },
});

export const renderToolTodo = createToolRenderer({
  name: "Todo",
  className: "todo",
  getInfo: (input) => ({ count: input?.todos?.length || 0, countLabel: "items" }),
  hasExpandable: (input) => (input?.todos?.length || 0) > 0,
  renderContent: (msg) => {
    const todos = msg.input?.todos || [];
    const statusIcon = (status) => {
      switch (status) {
        case "completed":
          return "check";
        case "in_progress":
          return "clock";
        default:
          return "circle";
      }
    };

    return (
      <div className="tool-todo-list">
        {todos.map((todo, i) => (
          <div className={`todo-item todo-${todo.status || "pending"}`} key={i}>
            <span className={`todo-icon icon icon-${statusIcon(todo.status)}`} />
            <span className="todo-content">{todo.content}</span>
          </div>
        ))}
      </div>
    );
  },
});

export function renderToolSearch(msg, index, handlers) {
  const { id, name, input, result, collapsed, isError } = msg;
  const pattern = input?.pattern || "";
  const globPattern = input?.glob || "";
  const searchPath = input?.path || "";
  const entries = parseSearchResults(result);
  const count = entries.length;
  const countLabel = name === "Glob" ? "files" : "matches";
  const hasResult = entries.length > 0;
  const totalLines = countNonEmptyLines(result);
  const hasMore = totalLines > entries.length;

  return (
    <div
      className={`message message-tool tool-search tool-${name.toLowerCase()} ${collapsed ? "collapsed" : ""} ${isError ? "tool-error" : ""}`}
      key={index}
    >
      <div className="tool-header">
        <span
          className={`tool-name ${hasResult ? "tool-toggle" : ""}`}
          onClick={() => hasResult && handlers.toggle(id)}
        >
          {name}
        </span>
        {pattern ? <code className="tool-pattern">{pattern}</code> : null}
        {globPattern && !pattern ? <code className="tool-pattern">{globPattern}</code> : null}
        {searchPath ? (
          <a
            className="tool-path"
            href="#"
            title={searchPath}
            onClick={(e) => {
              e.preventDefault();
              handlers.openFile(searchPath);
            }}
          >
            {searchPath}
          </a>
        ) : null}
        {count !== null ? (
          <span className="tool-count">
            {count} {countLabel}
          </span>
        ) : null}
      </div>
      {hasResult && !collapsed ? (
        <div className="search-results">
          {pattern || globPattern || searchPath ? (
            <div className="search-command">
              {pattern ? <code className="search-param">{pattern}</code> : null}
              {globPattern ? <code className="search-param">{globPattern}</code> : null}
              {searchPath ? <code className="search-param">{searchPath}</code> : null}
            </div>
          ) : null}
          {entries.map((entry, i) => (
            <div className="search-entry" key={i}>
              <a
                className="search-path"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  handlers.openFile(entry.path, entry.line);
                }}
              >
                {entry.path}
                {entry.line ? <span className="search-line">:{entry.line}</span> : null}
              </a>
              {entry.content ? <span className="search-content">{entry.content}</span> : null}
            </div>
          ))}
          {hasMore ? (
            <div className="search-more">... {totalLines - entries.length} more</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const renderToolWebFetch = createToolRenderer({
  name: "WebFetch",
  className: "webfetch",
  getInfo: (input) => ({ url: input?.url }),
  hasExpandable: (input) => !!input?.prompt,
  renderHeader: (info) => (
    <span className="tool-header-info">
      {info.url ? (
        <a className="tool-url" href={info.url} target="_blank">
          {info.url.slice(0, 60)}
          {info.url.length > 60 ? "..." : ""}
        </a>
      ) : null}
    </span>
  ),
  renderContent: (msg) => renderPreContent(msg.input?.prompt),
});

export const renderToolWebSearch = createSimpleToolRenderer("WebSearch", (input) => ({
  code: input?.query,
}));

export const renderToolAgent = createToolRenderer({
  name: "Agent",
  className: "task",
  getInfo: (input) => ({
    subagentType: input?.subagent_type,
    description: input?.description,
  }),
  hasExpandable: (input, result) => !!(input?.prompt || result),
  renderHeader: (info) => (
    <span className="tool-header-info">
      {info.subagentType ? <span className="tool-agent-type">{info.subagentType}</span> : null}
      {info.description ? <span className="tool-description">{info.description}</span> : null}
    </span>
  ),
  renderContent: (msg) => (
    <div className="tool-task-content">
      {msg.input?.prompt ? renderPreContent(msg.input.prompt, 500) : null}
      {msg.result ? (
        <pre className="tool-result">
          {msg.result.slice(0, 1000)}
          {msg.result.length > 1000 ? "..." : ""}
        </pre>
      ) : null}
    </div>
  ),
});

export const renderToolNotebook = createToolRenderer({
  name: "NotebookEdit",
  className: "notebook",
  getInfo: (input) => ({
    path: input?.notebook_path,
    editMode: input?.edit_mode || "replace",
  }),
  hasExpandable: (input) => !!input?.new_source,
  renderHeader: (info, input, result, handlers) => (
    <span className="tool-header-info">
      <span className="tool-edit-mode">{info.editMode}</span>
      {renderPathLink(info.path, null, handlers)}
    </span>
  ),
  renderContent: (msg) => renderPreContent(msg.input?.new_source, 500),
});

function questionPreview(text, maxLength = 60) {
  if (!text) return "";
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

export const renderToolAskUser = createToolRenderer({
  name: "Question",
  className: "question",
  getInfo: (input, result, msg) => {
    const questions = input?.questions || [];
    const first = questions[0];
    if (questions.length > 1) {
      return {
        count: questions.length,
        countLabel: "questions",
      };
    }
    return {
      description: questionPreview(first?.question || input?.question),
    };
  },
  hasExpandable: (input) => {
    const questions = input?.questions || [];
    return questions.some((q) => q.options?.length > 0);
  },
  renderContent: (msg) => {
    const questions = msg.input?.questions || [];
    const answers = msg.answers || {};

    return (
      <div className="tool-question-content">
        {questions.map((q, qi) => {
          const selected = answers[q.question];
          return (
            <div className="question-block" key={qi}>
              {questions.length > 1 ? <div className="question-text">{q.question}</div> : null}
              {q.options ? (
                <div className="question-options">
                  {q.options.map((opt, oi) => (
                    <div
                      className={
                        "question-option" +
                        (selected === opt.label ? " question-option-selected" : "") +
                        (selected && selected !== opt.label ? " question-option-dimmed" : "")
                      }
                      key={oi}
                    >
                      <span className="option-label">{opt.label}</span>
                      {opt.description ? (
                        <span className="option-description">{opt.description}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {selected && !q.options?.some((o) => o.label === selected) ? (
                <div className="question-option question-option-selected">
                  <span className="option-label">{selected}</span>
                  <span className="option-description">Custom answer</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  },
});

export const renderToolTaskOutput = createSimpleToolRenderer("TaskOutput", (input) => ({
  code: input?.task_id,
  badge: input?.block ? "blocking" : "non-blocking",
}));

export const renderToolSkill = createSimpleToolRenderer("Skill", (input) => ({
  code: input?.skill,
  text: input?.args,
}));

export const renderToolBashOutput = createSimpleToolRenderer("BashOutput", (input) => ({
  code: input?.bash_id,
}));

export const renderToolKillShell = createSimpleToolRenderer("KillShell", (input) => ({
  code: input?.shell_id,
}));

export const renderToolToolSearch = createToolRenderer({
  name: "ToolSearch",
  className: "toolsearch",
  getInfo: (input, result) => {
    const tools = parseToolSearchResults(result);
    return {
      count: tools.length > 0 ? tools.length : undefined,
      countLabel: "tools",
    };
  },
  hasExpandable: (input, result) => parseToolSearchResults(result).length > 0,
  renderHeader: (info) => (
    <span className="tool-header-info">
      {info.count !== undefined ? (
        <span className="tool-count">
          {info.count} {info.countLabel}
        </span>
      ) : null}
    </span>
  ),
  renderContent: (msg) => {
    const tools = parseToolSearchResults(msg.result);
    return (
      <div className="toolsearch-results">
        {tools.map((tool, i) => (
          <div className="toolsearch-entry" key={i}>
            <span className="toolsearch-name">{tool.name}</span>
          </div>
        ))}
      </div>
    );
  },
});

export const renderToolCronCreate = createToolRenderer({
  name: "CronCreate",
  className: "cron",
  getInfo: (input) => ({
    description: input?.cron,
    badge: input?.recurring === false ? "one-shot" : "recurring",
  }),
  hasExpandable: (input) => !!input?.prompt,
  renderContent: (msg) => renderPreContent(msg.input?.prompt, 500),
});

export const renderToolCronDelete = createSimpleToolRenderer("CronDelete", (input) => ({
  code: input?.id,
}));

export const renderToolCronList = createSimpleToolRenderer("CronList", () => ({}));

export const renderToolTaskStop = createSimpleToolRenderer("TaskStop", (input) => ({
  code: input?.task_id || input?.shell_id,
}));

export const renderToolRemoteTrigger = createSimpleToolRenderer("RemoteTrigger", (input) => ({
  code: input?.trigger_id,
  badge: input?.action,
}));

export function renderToolWorktreeMode(msg, index) {
  const isExit = msg.name === "ExitWorktree";
  const input = msg.input || {};
  return (
    <div
      className={`message message-tool tool-worktree ${isExit ? "tool-exit" : "tool-enter"}`}
      key={index}
    >
      <span className="tool-name">{isExit ? "Exit Worktree" : "Enter Worktree"}</span>
      {!isExit && input.name ? <code className="tool-info">{input.name}</code> : null}
      {isExit && input.action ? (
        <span className={`tool-badge ${input.action === "remove" ? "badge-warning" : ""}`}>
          {input.action}
        </span>
      ) : null}
    </div>
  );
}

export function renderToolPlanMode(msg, index) {
  const isExit = msg.name === "ExitPlanMode";
  return (
    <div
      className={`message message-tool tool-planmode ${isExit ? "tool-exit" : "tool-enter"}`}
      key={index}
    >
      <span className="tool-name">{isExit ? "Exit Plan Mode" : "Enter Plan Mode"}</span>
    </div>
  );
}

export function renderToolDefault(msg, index) {
  const { name, input, isError } = msg;
  const info = getToolInfo(name, input);

  return (
    <div className={`message message-tool ${isError ? "tool-error" : ""}`} key={index}>
      <span className="tool-name">{name}</span>
      {info ? <span className="tool-info">{info}</span> : null}
    </div>
  );
}

// ============================================================================
// Utility Exports
// ============================================================================

export function getToolInfo(name, input) {
  if (!input) return "";
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  if (input.command) return input.command.slice(0, 80);
  if (input.pattern) return input.pattern;
  if (input.query) return input.query.slice(0, 60);
  if (input.url) return input.url.slice(0, 60);
  if (input.notebook_path) return input.notebook_path;
  for (const [, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) {
      return value.slice(0, 80);
    }
  }
  return "";
}

export function toolHasDetails(name, input, result) {
  const checks = {
    Edit: () => input?.old_string || input?.new_string,
    Write: () => input?.content,
    Bash: () => input?.command?.length > 60 || result,
    TodoWrite: () => input?.todos?.length > 0,
    WebFetch: () => input?.prompt,
    Agent: () => input?.prompt || result,
    Task: () => input?.prompt || result,
    CronCreate: () => !!input?.prompt,
    NotebookEdit: () => input?.new_source,
    Glob: () => result && typeof result === "string" && result.trim().length > 0,
    Grep: () => result && typeof result === "string" && result.trim().length > 0,
  };
  return checks[name]?.() ?? false;
}

// ============================================================================
// Main Dispatcher
// ============================================================================

const TOOL_RENDERERS = {
  Read: renderToolRead,
  Write: renderToolWrite,
  Edit: renderToolEdit,
  Bash: renderToolBash,
  TodoWrite: renderToolTodo,
  Glob: renderToolSearch,
  Grep: renderToolSearch,
  WebFetch: renderToolWebFetch,
  WebSearch: renderToolWebSearch,
  Agent: renderToolAgent,
  Task: renderToolAgent,
  NotebookEdit: renderToolNotebook,
  AskUserQuestion: renderToolAskUser,
  Question: renderToolAskUser,
  TaskOutput: renderToolTaskOutput,
  Skill: renderToolSkill,
  BashOutput: renderToolBashOutput,
  KillShell: renderToolKillShell,
  ToolSearch: renderToolToolSearch,
  CronCreate: renderToolCronCreate,
  CronDelete: renderToolCronDelete,
  CronList: renderToolCronList,
  TaskStop: renderToolTaskStop,
  RemoteTrigger: renderToolRemoteTrigger,
  EnterWorktree: renderToolWorktreeMode,
  ExitWorktree: renderToolWorktreeMode,
  EnterPlanMode: renderToolPlanMode,
  ExitPlanMode: renderToolPlanMode,
  // Pulsar MCP tools
  ...MCP_TOOL_RENDERERS,
};

export function renderTool(msg, index, handlers) {
  const renderer = TOOL_RENDERERS[msg.name];
  if (renderer) {
    return renderer(msg, index, handlers);
  }
  return renderToolDefault(msg, index);
}

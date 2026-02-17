/** @babel */

import { Emitter } from "atom";
import { spawn } from "child_process";
import Config from "./utils/config";
import { createLogger } from "./utils/log";

const log = createLogger("Connection");

/**
 * Connection states for explicit state machine
 */
const ConnectionState = {
  IDLE: "idle",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  ERROR: "error",
};

/**
 * User-friendly error messages for common error codes
 */
const ERROR_MESSAGES = {
  ENOENT: {
    title: "Claude CLI not found",
    getDetail: (path) =>
      `Please check that Claude CLI is installed and the path is correct.\nCurrent path: ${path}`,
  },
  EACCES: {
    title: "Permission denied",
    detail: "Claude CLI exists but is not executable. Check file permissions.",
  },
  EPERM: {
    title: "Operation not permitted",
    detail: "Unable to execute Claude CLI. Check system permissions.",
  },
};

/**
 * ClaudeConnection manages interactive streaming communication with Claude CLI.
 *
 * Events emitted:
 * - 'session' (sessionId) - Session ID received
 * - 'delta' (text) - Text content delta (for streaming display)
 * - 'tool-use' ({id, name, input}) - Tool use started
 * - 'tool-result' ({toolUseId, content, isError}) - Tool result received
 * - 'usage' (usage) - Token usage update
 * - 'result' (text) - Final result
 * - 'error' (error) - Error occurred
 * - 'exit' (code) - Process exited
 * - 'state-change' (state) - Connection state changed
 */
export default class ClaudeConnection {
  constructor(options = {}) {
    this.emitter = new Emitter();
    this.process = null;
    this.buffer = "";
    this.sessionId = options.sessionId || null;
    this.permissionMode = options.permissionMode || Config.permissionMode();
    this.state = ConnectionState.IDLE;
  }

  /**
   * Subscribe to connection events
   */
  on(event, callback) {
    return this.emitter.on(event, callback);
  }

  /**
   * Get current connection state
   */
  getState() {
    return this.state;
  }

  /**
   * Set connection state and emit event
   */
  setState(newState) {
    if (this.state !== newState) {
      this.state = newState;
      this.emitter.emit("state-change", newState);
    }
  }

  /**
   * Check if the connection is running
   */
  isRunning() {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Start the Claude CLI process
   */
  start(options = {}) {
    if (this.isRunning()) {
      log.debug("Already running, reusing process");
      return this.process;
    }

    this.setState(ConnectionState.STARTING);

    const projectPaths = options.projectPaths || atom.project.getPaths();
    const cwd = projectPaths[0] || process.cwd();
    log.debug("Starting CLI", { cwd, sessionId: this.sessionId });

    const model = Config.model();
    const permissionMode = this.permissionMode || Config.permissionMode();

    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];

    // Add MCP config for Pulsar integration (if pulsar-mcp service available)
    const mainModule = atom.packages.getActivePackage("claude-chat")?.mainModule;
    const mcpPort = mainModule?.getMcpBridgePort();
    const serverPath = mainModule?.getMcpServerPath();

    if (mcpPort && serverPath) {
      const mcpConfig = {
        mcpServers: {
          pulsar: {
            command: "node",
            args: [serverPath],
            env: {
              PULSAR_BRIDGE_PORT: String(mcpPort),
              PULSAR_BRIDGE_HOST: "127.0.0.1",
            },
          },
        },
      };
      args.push("--mcp-config", JSON.stringify(mcpConfig));
    }

    if (model && model !== "default") {
      args.push("--model", model);
    }

    if (permissionMode && permissionMode !== "default") {
      args.push("--permission-mode", permissionMode);
    }

    // Enable stdio permission prompts for interactive approval.
    // Required for all modes — AskUserQuestion needs this to send control_requests.
    args.push("--permission-prompt-tool", "stdio");

    for (const dir of projectPaths) {
      args.push("--add-dir", dir);
    }

    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    const claudePath = Config.claudePath();

    log.debug("Spawn args", args);

    try {
      this.process = spawn(claudePath, args, {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.setupHandlers();
      this.setState(ConnectionState.RUNNING);
      log.debug("Process started", { pid: this.process.pid });
      return this.process;
    } catch (err) {
      this.handleStartError(err, claudePath);
      return null;
    }
  }

  /**
   * Handle errors during process start
   */
  handleStartError(err, claudePath) {
    log.error("Start error", { code: err.code, message: err.message, claudePath });
    this.setState(ConnectionState.ERROR);
    this.process = null;

    const errorInfo = ERROR_MESSAGES[err.code] || {
      title: "Failed to start Claude CLI",
      detail: err.message,
    };

    const detail = errorInfo.getDetail ? errorInfo.getDetail(claudePath) : errorInfo.detail;

    // Emit error for chat panel to display
    this.emitter.emit("error", new Error(`${errorInfo.title}: ${detail}`));

    // Show notification with action button
    atom.notifications.addError(errorInfo.title, {
      detail,
      dismissable: true,
      buttons: [
        {
          text: "Open Settings",
          onDidClick: () => atom.workspace.open("atom://config/packages/claude-chat"),
        },
      ],
    });
  }

  /**
   * Setup event handlers for the process
   */
  setupHandlers() {
    this.buffer = "";

    // Handle stdout - process lines immediately for streaming
    this.process.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();

      let newlineIndex;
      while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newlineIndex);
        this.buffer = this.buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          try {
            const event = JSON.parse(line);
            this.handleEvent(event);
          } catch (err) {
            console.log("Claude non-JSON:", line.slice(0, 100));
          }
        }
      }
    });

    // Handle stderr
    this.process.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.error("Claude CLI stderr:", msg);
        if (msg.includes("No conversation found with session ID")) {
          this.sessionId = null;
          this.kill();
          this.emitter.emit("session-expired");
        }
      }
    });

    // Handle close
    this.process.on("close", (code) => {
      this.process = null;
      this.setState(ConnectionState.IDLE);
      this.emitter.emit("exit", code);
    });

    // Handle error
    this.process.on("error", (err) => {
      this.handleStartError(err, Config.claudePath());
    });
  }

  /**
   * Handle a parsed JSON event from Claude CLI
   */
  handleEvent(event) {
    log.debug("Event received", { type: event.type });

    // Store session ID
    if (event.session_id && event.session_id !== this.sessionId) {
      this.sessionId = event.session_id;
      log.debug("Session ID set", event.session_id);
      this.emitter.emit("session", event.session_id);
    }

    switch (event.type) {
      case "content_block_delta":
        if (event.delta?.text) {
          this.emitter.emit("delta", event.delta.text);
        }
        break;

      case "content_block_start":
        if (event.content_block?.type === "tool_use") {
          this.emitter.emit("tool-start", event.content_block.name);
        }
        break;

      case "assistant":
        // Partial message snapshots from --include-partial-messages.
        // These are cumulative (contain ALL blocks from the beginning),
        // so we only extract tool_use blocks (deduplicated by id in chat-panel).
        // Text content comes via content_block_delta (streaming) and result (final).
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "tool_use") {
              this.emitter.emit("tool-use", {
                id: block.id,
                name: block.name,
                input: block.input || {},
              });
            }
          }
        }
        break;

      case "result":
        if (event.usage) {
          this.emitter.emit("usage", {
            input: event.usage.input_tokens || 0,
            output: event.usage.output_tokens || 0,
            cacheRead: event.usage.cache_read_input_tokens || 0,
            cacheCreation: event.usage.cache_creation_input_tokens || 0,
          });
        }
        this.emitter.emit("result", event.result || "");
        break;

      case "usage":
        if (event.usage) {
          this.emitter.emit("usage", {
            input: event.usage.input_tokens || 0,
            output: event.usage.output_tokens || 0,
            cacheRead: event.usage.cache_read_input_tokens || 0,
            cacheCreation: event.usage.cache_creation_input_tokens || 0,
          });
        }
        break;

      case "user":
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "tool_result") {
              this.emitter.emit("tool-result", {
                toolUseId: block.tool_use_id,
                content: block.content,
                isError: block.is_error || false,
              });
            }
          }
        }
        break;

      case "system":
        // System init events - ignore
        break;

      case "control_request":
        // Permission prompt from Claude
        if (event.request?.subtype === "can_use_tool") {
          this.emitter.emit("permission-request", {
            requestId: event.request_id,
            toolName: event.request.tool_name,
            input: event.request.input,
            toolUseId: event.request.tool_use_id,
            suggestions: event.request.permission_suggestions || [],
          });
        }
        break;

      case "stream_event":
        // Wrapper event containing nested event (content_block_delta, etc.)
        if (event.event?.usage) {
          this.emitter.emit("usage", event.event.usage);
        }
        // Unwrap and process the nested event
        if (event.event?.type) {
          this.handleEvent(event.event);
        }
        break;

      case "message_delta":
        // End-of-message metadata (stop_reason, usage)
        if (event.usage) {
          this.emitter.emit("usage", {
            input: event.usage.input_tokens || 0,
            output: event.usage.output_tokens || 0,
            cacheRead: event.usage.cache_read_input_tokens || 0,
            cacheCreation: event.usage.cache_creation_input_tokens || 0,
          });
        }
        break;

      case "content_block_stop":
      case "message_start":
      case "message_stop":
      case "control_response":
        // Stream lifecycle / acknowledgment events — no action needed
        break;

      default:
        // Log unknown events for debugging
        console.log("Claude unknown event:", JSON.stringify(event, null, 2));
        this.emitter.emit("unknown-event", event);
        break;
    }
  }

  /**
   * Respond to a permission prompt.
   *
   * Wire format (from Claude Code SDK source):
   * {
   *   type: "control_response",
   *   response: {
   *     subtype: "success",
   *     request_id: "...",
   *     response: { behavior: "allow", updatedInput: {...} }
   *              | { behavior: "deny", message: "..." }
   *   }
   * }
   *
   * @param {string} requestId - The request ID to respond to
   * @param {string} behavior - "allow" or "deny"
   * @param {object} options - Additional options
   * @param {object} options.input - Updated tool input (for allow)
   * @param {Array} options.permissions - Permission updates (for allow, e.g. "always allow")
   * @param {string} options.message - Denial reason (for deny)
   */
  respondToPermission(requestId, behavior, { input, permissions, message } = {}) {
    if (!this.isRunning()) return;

    const innerResponse =
      behavior === "allow"
        ? {
            behavior,
            ...(input ? { updatedInput: input } : {}),
            ...(permissions?.length ? { updatedPermissions: permissions } : {}),
          }
        : { behavior, message: message || "User denied permission" };

    const msg = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: innerResponse,
      },
    };

    log.debug("Permission response", msg);

    const data = JSON.stringify(msg) + "\n";
    this.process.stdin.write(data, "utf8", (err) => {
      if (err) {
        log.error("Error writing permission response", err);
      }
    });
  }

  /**
   * Send a prompt to Claude
   */
  send(prompt) {
    if (!this.isRunning()) {
      log.debug("Process not running, starting");
      this.start();
    }

    const message = JSON.stringify({
      type: "user",
      message: { role: "user", content: prompt },
    });

    log.debug("Sending prompt", { length: prompt.length });
    this.process.stdin.write(message + "\n");
  }

  /**
   * Send an interrupt control request to cleanly abort current processing.
   * The CLI will stop the current turn and emit a result event.
   * Falls back to kill() if the process doesn't respond.
   */
  interrupt() {
    if (!this.isRunning()) return;

    const requestId = `interrupt-${Date.now()}`;
    const msg = {
      type: "control_request",
      request_id: requestId,
      request: { subtype: "interrupt" },
    };

    log.debug("Sending interrupt", { requestId });
    this.process.stdin.write(JSON.stringify(msg) + "\n");
  }

  /**
   * Kill the process (graceful by default, force if needed)
   * @param {boolean} graceful - If true, try SIGTERM first, then SIGKILL
   * @param {number} timeout - Timeout in ms before force kill (default: 3000)
   */
  async kill(graceful = true, timeout = 3000) {
    if (!this.process) return;

    log.debug("Killing process", { graceful, pid: this.process.pid });
    this.setState(ConnectionState.STOPPING);

    if (graceful) {
      try {
        // Try graceful termination first
        this.process.kill("SIGTERM");

        // Wait for process to exit gracefully
        await Promise.race([
          new Promise((resolve) => {
            this.process?.once("close", resolve);
          }),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Timeout")), timeout);
          }),
        ]);
      } catch (err) {
        // Force kill if graceful shutdown failed or timed out
        try {
          this.process?.kill("SIGKILL");
        } catch (e) {
          // Process may already be terminated
        }
      }
    } else {
      try {
        this.process.kill("SIGKILL");
      } catch (e) {
        // Process may already be terminated
      }
    }

    this.process = null;
    this.setState(ConnectionState.IDLE);
  }

  /**
   * Destroy the connection and cleanup
   */
  destroy() {
    this.kill(false); // Force kill on destroy
    this.emitter.dispose();
  }
}

export { ConnectionState };

# claude-chat

Interactive chat panel for [Claude Code](https://github.com/anthropics/claude-code). Provides a conversational interface with streaming responses, markdown rendering, and session management.

![panel-1](https://github.com/asiloisad/pulsar-claude-chat/blob/master/assets/panel-1.png?raw=true)

![panel-2](https://github.com/asiloisad/pulsar-claude-chat/blob/master/assets/panel-2.gif?raw=true)

## Features

- **Streaming responses**: Real-time text display as Claude responds.
- **Markdown rendering**: Full markdown support with syntax-highlighted code blocks using tree-sitter grammars matching your editor theme.
- **Tool visualization**: Rich display of tool calls (Read, Write, Edit, Bash, Glob, Grep, Task, etc.) with collapsible details, diffs, search results, and inline previews.
- **Interactive permissions**: Allow/Deny prompts with "Always Allow" and permission mode suggestions. AskUserQuestion prompts render as interactive option cards with multi-question support.
- **Clean interrupts**: Stop button sends interrupt signal for graceful abort instead of killing the process.
- **Session persistence**: Conversations are saved and can be resumed across restarts.
- **Chat history**: Browse and revisit previous sessions.
- **Context attachments**: Attach selections, files, images, or tree-view paths to prompts.
- **Permission modes**: Switch between Default, Plan, Accept Edits, and Auto via keyboard shortcuts; restart explicitly for Bypass mode.
- **LaTeX rendering**: Math expressions rendered via MathJax.
- **MCP integration**: Auto-connects MCP server for editor tool integration, via [pulsar-mcp](https://web.pulsar-edit.dev/packages/pulsar-mcp).

## Installation

To install `claude-chat` search for [claude-chat](https://web.pulsar-edit.dev/packages/claude-chat) in the Install pane of the Pulsar settings or run `ppm install claude-chat`. Alternatively, you can run `ppm install asiloisad/pulsar-claude-chat` to install a package directly from the GitHub repository.

The Claude code terminal version is required. Please refer to the [Quickstart](https://code.claude.com/docs/en/quickstart) guide for more details.

## Commands

Commands available in `atom-workspace`:

- `claude-chat:open`: open chat panel,
- `claude-chat:toggle-focus`: <kbd>Alt+C</kbd> open and focus chat panel, or return focus to editor if already focused,
- `claude-chat:toggle`: toggle chat panel,
- `claude-chat:new-chat`: start a new chat session,
- `claude-chat:open-latest`: open the most recent session,
- `claude-chat:check-cli`: check if Claude CLI is available,
- `claude-chat:update-cli`: update Claude CLI (disconnects all sessions first),
- `claude-chat:settings`: open package settings.

Commands available in `atom-text-editor:not([mini])`:

- `editor:attach-to-claude`: attach current selection to chat context.

Commands available in `.tree-view`:

- `tree-view:attach-to-claude`: attach selected files to chat context.

Commands available in the prompt editor:

- `claude-chat:send`: send the current prompt,
- `claude-chat:stop`: stop the current response,
- `claude-chat:clear-prompt`: clear the prompt editor,
- `claude-chat:scroll-up`: scroll chat output up,
- `claude-chat:scroll-down`: scroll chat output down,
- `claude-chat:show-usage`: show token usage,
- `claude-chat:focus-active-editor`: focus the active text editor.

Commands available in `.claude-chat`:

- `claude-chat:copy`: copy selected text,
- `claude-chat:copy-message`: copy full message,
- `claude-chat:unfold-all`: expand all tool call details,
- `claude-chat:fold-all`: collapse all tool call details,
- `claude-chat:clear-messages`: clear all messages,
- `claude-chat:toggle-bypass-mode`: toggle bypass permissions mode for this chat.

## Customization

The style can be adjusted according to user preferences in the `styles.less` file:

- e.g. unlimited thinking block height:

```less
.claude-chat .message-thinking .thinking-content {
  max-height: none;
}
```

- e.g. taller diff sections:

```less
.claude-chat .message-tool .diff-section .diff-content {
  max-height: 300px;
}
```

- e.g. larger prompt editor:

```less
.claude-chat .editor-container atom-text-editor {
  min-height: 100px;
  max-height: 300px;
}
```

- e.g. custom chat font size:

```less
.claude-chat .claude-chat-messages {
  font-size: 14px;
}
```

- e.g. custom timeline dot colors:

```less
.claude-chat {
  .dot-bash {
    background: #c678dd;
  }
  .dot-edit {
    background: #e5c07b;
  }
  .dot-assistant {
    background: #61afef;
  }
}
```

## Custom Provider

You can use any OpenAI-compatible API provider (Ollama, LM Studio, OpenRouter, etc.) by configuring the following settings:

1. Set **Model** to `custom` and enter the model name in **Custom Model** (e.g. `qwen3-coder`).
2. Set **Custom API Base URL** to the provider endpoint (e.g. `http://localhost:11434` for Ollama).

For providers that require an API key, set the `ANTHROPIC_API_KEY` environment variable in your shell before launching Pulsar. For Ollama and other local providers, no API key is needed.

## Chat history

Chat sessions are stored in `~/.pulsar/claude-chat-sessions/` directory. Each session is saved as a JSON file containing messages, timestamps, project paths, and token usage.

## Provided Service `claude-chat`

Allows other packages to send prompts, attach context, and receive messages programmatically.

In your `package.json`:

```json
{
  "consumedServices": {
    "claude-chat": {
      "versions": { "^1.0.0": "consumeClaudeChat" }
    }
  }
}
```

In your main module:

```javascript
module.exports = {
  consumeClaudeChat(service) {
    this.claudeChat = service;
  },
};
```

### `sendPrompt(text, options)`

Send a prompt to Claude programmatically.

```javascript
// Simple prompt
await service.sendPrompt("Explain this code");

// With attach context (supports multi-cursor selections)
await service.sendPrompt("Review this selection", {
  attachContext: {
    type: "selections",
    path: "src/app.js",
    line: 42,
    selections: [
      {
        text: "const foo = bar()",
        range: { start: { row: 41, column: 0 }, end: { row: 41, column: 18 } },
      },
    ],
    label: "src/app.js:42",
    icon: "code",
  },
});

// Without focusing the panel
await service.sendPrompt("Run tests", { focus: false });
```

**Options:**

- `attachContext` - Context to attach (selection, paths, position, image)
- `focus` - Whether to focus the panel after sending (default: `true`)

**Returns:** `Promise<boolean>` - Whether the message was sent successfully.

### `setAttachContext(context)`

Set the attach context without sending a message.

```javascript
service.setAttachContext({
  type: "paths",
  paths: ["relative/path/to/file.js"],
  label: "file.js",
  icon: "file",
});
```

**Context types:**

- `paths` - File or directory paths
- `selections` - Selections/cursors with `path`, `line`, `selections` array (empty text = cursor position)
- `image` - Image file with optional region selection

### `clearAttachContext()`

Clear the current attach context.

### `hasPanel()`

Check if the chat panel exists. Returns `boolean`.

### `onDidReceiveMessage(callback)`

Subscribe to receive messages from Claude.

```javascript
const disposable = service.onDidReceiveMessage((message) => {
  console.log("Claude responded:", message.content);
  if (message.thinking) {
    console.log("Thinking:", message.thinking);
  }
});

// Later, to unsubscribe:
disposable.dispose();
```

**Message object:**

- `role` - Always `"assistant"`
- `content` - The response text
- `thinking` - Extended thinking content (if enabled)

## Consumed Service `pulsar-mcp`

Auto-connects the [pulsar-mcp](https://web.pulsar-edit.dev/packages/pulsar-mcp) MCP server when starting a Claude session. When the service is available, the bridge port and server path are passed to the Claude CLI via `--mcp-config`, giving Claude direct access to editor tools (read/write text, open files, manage selections, etc.).

## Consumed Service `tree-view`

Reads selected file and folder paths from [tree-view-plus](https://web.pulsar-edit.dev/packages/tree-view-plus). Used by the `tree-view:attach-to-claude` command to attach selected entries as context for the chat prompt.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!

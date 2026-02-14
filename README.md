# claude-chat

Interactive chat panel for [Claude Code](https://github.com/anthropics/claude-code). Provides a conversational interface with streaming responses, markdown rendering, and session management.

![panel](https://github.com/asiloisad/pulsar-claude-chat/blob/master/assets/panel.png?raw=true)

## Features

- **Streaming responses**: Real-time text display as Claude responds.
- **Markdown rendering**: Syntax highlighting for code blocks.
- **Session persistence**: Conversations are saved and can be resumed.
- **Chat history**: Browse and revisit previous sessions.
- **Context extender**: Attach selections, files, or images to prompts.
- **Permission modes**: Switch between permission levels.
- **[pulsar-mcp](https://web.pulsar-edit.dev/packages/pulsar-mcp)**: Auto-connects MCP server for tool integration.

## Installation

To install `claude-chat` search for [claude-chat](https://web.pulsar-edit.dev/packages/claude-chat) in the Install pane of the Pulsar settings or run `ppm install claude-chat`. Alternatively, you can run `ppm install asiloisad/pulsar-claude-chat` to install a package directly from the GitHub repository.

## Commands

Commands available in `atom-workspace`:

- `claude-chat:open`: open chat panel,
- `claude-chat:toggle`: toggle chat panel,
- `claude-chat:new-chat`: start a new chat session,
- `claude-chat:open-latest`: open the most recent session,
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
- `claude-chat:clear-messages`: clear all messages.

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
  }
}
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
      { text: "const foo = bar()", range: { start: { row: 41, column: 0 }, end: { row: 41, column: 18 } } }
    ],
    label: "src/app.js:42",
    icon: "code"
  }
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
  icon: "file"
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

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub — any feedback's welcome!

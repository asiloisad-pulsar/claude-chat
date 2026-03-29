/** @babel */

/**
 * Shared result parsing utilities for tool renderers
 */

// ============================================================================
// Text Parsing
// ============================================================================

/**
 * Count non-empty lines in a string
 */
export function countNonEmptyLines(text) {
  if (!text || typeof text !== "string") return 0;
  return text
    .trim()
    .split("\n")
    .filter((l) => l.trim()).length;
}

/**
 * Check if result is an error/status message (not actual file content)
 */
export function isErrorResult(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed.startsWith("file content") || // "File content (X tokens) exceeds..."
    trimmed.startsWith("error:") ||
    trimmed.startsWith("error reading") ||
    trimmed.startsWith("permission denied") ||
    trimmed.startsWith("file not found") ||
    trimmed.startsWith("cannot read") ||
    trimmed.startsWith("failed to")
  );
}

/**
 * Format line count as human-readable string
 */
export function formatLineCount(text) {
  if (!text || typeof text !== "string") return null;
  if (isErrorResult(text)) return null;
  const count = text.split("\n").length;
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

/**
 * Truncate string with suffix
 */
export function truncate(text, maxLength = 500, suffix = "...") {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + suffix;
}

/**
 * Truncate with character count suffix
 */
export function truncateWithCount(text, maxLength = 500) {
  if (!text || text.length <= maxLength) return text;
  const remaining = text.length - maxLength;
  return `${text.slice(0, maxLength)}\n... (${remaining} more chars)`;
}

/**
 * Truncate path from beginning, keeping end visible
 * Shows "...rest/of/path" format for long paths
 */
export function truncatePath(path, maxLength = 70) {
  if (!path || path.length <= maxLength) return path;
  return "..." + path.slice(-(maxLength - 3));
}

// ============================================================================
// JSON Parsing
// ============================================================================

/**
 * Safely parse JSON result (for MCP tools)
 * Handles both direct JSON strings and MCP content arrays [{type: "text", text: "..."}]
 */
export function parseJsonResult(result) {
  if (!result) return null;
  try {
    // Handle MCP content array format: [{type: "text", text: "..."}]
    if (Array.isArray(result)) {
      const textBlock = result.find((b) => b.type === "text" && b.text);
      if (textBlock) {
        // text might already be parsed object or still be a string
        const content =
          typeof textBlock.text === "string" ? JSON.parse(textBlock.text) : textBlock.text;
        return content?.data ?? content;
      }
      return result;
    }
    // Handle direct JSON string
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    return parsed?.data ?? parsed;
  } catch {
    return result;
  }
}

/**
 * Parse result with error handling
 */
export function safeParseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ============================================================================
// Search Results
// ============================================================================

/**
 * Check if a line is a summary/status message (not an actual result)
 */
function isSummaryLine(line) {
  const trimmed = line.trim().toLowerCase();
  return (
    trimmed === "" ||
    trimmed === "no files found" ||
    trimmed === "no matches found" ||
    trimmed === "no results" ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("found ") || // "Found X total occurrences..."
    trimmed.startsWith("[") || // "[Showing results with pagination...]"
    /^\d+$/.test(trimmed) // Just a number (orphan line number)
  );
}

/**
 * Check if result is an empty/no-match message (not actual search results)
 */
export function isEmptySearchResult(result) {
  if (!result || typeof result !== "string") return true;
  const lines = result
    .trim()
    .split("\n")
    .filter((l) => l.trim());
  // Empty if all lines are summary/status messages
  return lines.every(isSummaryLine);
}

/**
 * Parse search result lines into structured entries
 */
export function parseSearchResults(result, maxEntries = 50) {
  if (!result || typeof result !== "string") return [];
  if (isEmptySearchResult(result)) return [];

  return result
    .trim()
    .split("\n")
    .filter((l) => l && !isSummaryLine(l))
    .slice(0, maxEntries)
    .map((line) => {
      // Match pattern: file:line:content
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (match) {
        return {
          path: match[1],
          line: parseInt(match[2], 10),
          content: match[3],
        };
      }
      return { path: line };
    });
}

// ============================================================================
// Image/Preview Parsing
// ============================================================================

/**
 * Extract image preview from result array
 */
export function extractImagePreview(result) {
  if (typeof result === "string") return null;
  if (!Array.isArray(result)) return null;

  for (const block of result) {
    if (block.type === "image") {
      const source = block.source || block;
      const data = source.data || block.data;
      const mediaType = source.media_type || block.media_type || "image/jpeg";
      if (data) {
        return { type: "image", mediaType, data };
      }
    }
  }
  return null;
}

// ============================================================================
// Line Range Formatting
// ============================================================================

/**
 * Format line range from offset/limit parameters
 */
export function formatLineRange(input) {
  const { offset, limit } = input || {};
  if (offset && limit) return `lines ${offset}-${offset + limit - 1}`;
  if (offset) return `from line ${offset}`;
  if (limit) return `lines 1-${limit}`;
  return null;
}

// ============================================================================
// ToolSearch Results
// ============================================================================

/**
 * Parse ToolSearch result into a list of { name } objects.
 * Result is stored as [{type: "tool_reference", tool_name: "..."}].
 */
export function parseToolSearchResults(result) {
  if (!Array.isArray(result)) return [];
  return result
    .filter((b) => b.type === "tool_reference" && b.tool_name)
    .map((b) => ({ name: b.tool_name }));
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  countNonEmptyLines,
  isErrorResult,
  formatLineCount,
  truncate,
  truncateWithCount,
  truncatePath,
  parseJsonResult,
  safeParseJson,
  isEmptySearchResult,
  parseSearchResults,
  extractImagePreview,
  formatLineRange,
  parseToolSearchResults,
};

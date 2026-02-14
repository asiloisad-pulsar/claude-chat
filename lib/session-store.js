/** @babel */

import { promises as fs } from "fs";
import { joinPath, getBaseName, pathsEqual } from "./utils/paths";

const SESSIONS_DIR_NAME = "claude-chat-sessions";

/**
 * Get the sessions directory path in Pulsar config
 */
function getSessionsDir() {
  const configDir = atom.getConfigDirPath();
  return joinPath(configDir, SESSIONS_DIR_NAME);
}

/**
 * Ensure sessions directory exists
 */
async function ensureSessionsDir() {
  const dir = getSessionsDir();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  return dir;
}

/**
 * Save a session to disk
 * @param {Object} sessionData - Session data to save
 */
export async function saveSession(sessionData) {
  if (!sessionData.sessionId) return;

  const dir = await ensureSessionsDir();
  const filePath = joinPath(dir, `${sessionData.sessionId}.json`);

  const data = {
    sessionId: sessionData.sessionId,
    projectPaths: sessionData.projectPaths || [],
    createdAt: sessionData.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    firstMessage: sessionData.firstMessage || "",
    messages: sessionData.messages || [],
    tokenUsage: sessionData.tokenUsage || { input: 0, output: 0 },
  };

  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  return data;
}

/**
 * Load a session from disk
 * @param {string} sessionId - Session ID to load
 * @returns {Object|null} Session data or null if not found
 */
export async function loadSession(sessionId) {
  const dir = getSessionsDir();
  const filePath = joinPath(dir, `${sessionId}.json`);

  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * List all sessions, optionally filtered by project paths
 * @param {string[]} projectPaths - Filter to sessions containing any of these paths
 * @returns {Object[]} Array of session metadata
 */
export async function listSessions(projectPaths = []) {
  const dir = getSessionsDir();

  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const sessions = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const filePath = joinPath(dir, file);
      const content = await fs.readFile(filePath, "utf8");
      const session = JSON.parse(content);

      // Filter by project paths if specified
      if (projectPaths.length > 0) {
        const hasMatchingPath = session.projectPaths?.some((sessionPath) =>
          projectPaths.some((projectPath) => pathsEqual(sessionPath, projectPath)),
        );
        if (!hasMatchingPath) continue;
      }

      sessions.push({
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        firstMessage: session.firstMessage,
        projectPaths: session.projectPaths,
        messageCount: session.messages?.length || 0,
      });
    } catch (err) {
      console.warn(`Failed to read session file ${file}:`, err);
    }
  }

  // Sort by updatedAt, most recent first
  sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  return sessions;
}

/**
 * Delete a session from disk
 * @param {string} sessionId - Session ID to delete
 */
export async function deleteSession(sessionId) {
  const dir = getSessionsDir();
  const filePath = joinPath(dir, `${sessionId}.json`);

  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Clear all sessions for given project paths
 * @param {string[]} projectPaths - Filter to sessions containing any of these paths
 * @returns {number} Number of deleted sessions
 */
export async function clearAllSessions(projectPaths = []) {
  const sessions = await listSessions(projectPaths);
  let deleted = 0;

  for (const session of sessions) {
    if (await deleteSession(session.sessionId)) {
      deleted++;
    }
  }

  return deleted;
}

/**
 * Format session for display in select list
 * @param {Object} session - Session metadata
 * @returns {Object} Formatted for pulsar-select-list
 */
export function formatSessionForList(session) {
  const date = new Date(session.updatedAt || session.createdAt);
  const dateStr =
    date.toLocaleDateString() +
    " " +
    date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const preview = session.firstMessage
    ? String(session.firstMessage).slice(0, 60) + (session.firstMessage.length > 60 ? "..." : "")
    : "(no messages)";

  // Extract folder names from project paths
  let projectInfo = "";
  if (session.projectPaths && session.projectPaths.length > 0) {
    const folderNames = session.projectPaths
      .filter((p) => typeof p === "string")
      .map((p) => getBaseName(p));
    if (folderNames.length === 1) {
      projectInfo = folderNames[0];
    } else if (folderNames.length > 1) {
      projectInfo = `${folderNames[0]} +${folderNames.length - 1}`;
    }
  }

  const label = projectInfo ? `${dateStr} - ${projectInfo}` : dateStr;

  return {
    label: String(label),
    description: String(preview),
    sessionId: session.sessionId,
  };
}

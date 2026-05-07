/** @babel */

import path from "path";

/**
 * Path utilities for claude-chat package.
 * Consolidates path manipulation logic from main.js and session-store.js
 */

/**
 * Get relative path from project root
 * @param {string} filePath - Absolute file path
 * @param {string[]} projectPaths - Optional project paths (defaults to atom.project.getPaths())
 * @returns {string} Relative path or original if not in project
 */
export function getRelativePath(filePath, projectPaths = null) {
  const paths = projectPaths || atom.project.getPaths();

  for (const projectPath of paths) {
    const relativePath = path.relative(projectPath, filePath);
    const isInsideProject =
      relativePath === "" ||
      (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));

    if (isInsideProject) {
      return relativePath.replace(/\\/g, "/");
    }
  }

  return filePath;
}

/**
 * Normalize path for comparison (handle Windows/Unix differences)
 * @param {string} p - Path to normalize
 * @returns {string} Normalized lowercase path
 */
export function normalizePath(p) {
  return path.normalize(p).toLowerCase();
}

/**
 * Compare two paths for equality (cross-platform)
 * @param {string} path1
 * @param {string} path2
 * @returns {boolean}
 */
export function pathsEqual(path1, path2) {
  return normalizePath(path1) === normalizePath(path2);
}

/**
 * Check if any path in array matches target
 * @param {string[]} paths - Array of paths to check
 * @param {string[]} targetPaths - Target paths to match against
 * @returns {boolean}
 */
export function hasMatchingPath(paths, targetPaths) {
  return paths?.some((p) => targetPaths.some((target) => pathsEqual(p, target))) ?? false;
}

/**
 * Get folder name from path
 * @param {string} p - Path
 * @returns {string} Folder/file name
 */
export function getBaseName(p) {
  return path.basename(p);
}

/**
 * Join path segments
 * @param {...string} segments - Path segments
 * @returns {string} Joined path
 */
export function joinPath(...segments) {
  return path.join(...segments);
}

export default {
  getRelativePath,
  normalizePath,
  pathsEqual,
  hasMatchingPath,
  getBaseName,
  joinPath,
};

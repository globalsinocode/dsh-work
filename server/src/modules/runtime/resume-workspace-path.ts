const MAX_RESUME_WORKSPACE_PATH_LENGTH = 1024

/**
 * Checkpoint output paths use POSIX separators because the Runtime Manifest is
 * portable across hosts. Unicode file names are valid; traversal, control
 * characters and platform-specific separators are not.
 */
export function isSafeResumeWorkspacePath(path: string): boolean {
  if (!path.startsWith('output/') || path.length > MAX_RESUME_WORKSPACE_PATH_LENGTH) return false
  if (path.includes('\\') || [...path].some(character => character.charCodeAt(0) < 32)) return false
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

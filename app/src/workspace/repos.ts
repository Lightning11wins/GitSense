/** The repo's path relative to home, or its absolute path when outside home. */
export function repoName(repo: { path: string }, home: string): string {
  if (repo.path === home) return "~";
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return repo.path.startsWith(prefix) ? repo.path.slice(prefix.length) : repo.path;
}

/** The last component of a path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The dir part of a path, or "" for top-level files. */
export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

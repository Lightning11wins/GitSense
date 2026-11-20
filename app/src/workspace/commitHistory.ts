// Recent commit messages, newest first, kept in this app's local storage.
const KEY = "gitsense.commitMessages";
const LIMIT = 30;

export function recentMessages(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

export function rememberMessage(message: string) {
  const messages = [message, ...recentMessages().filter((m) => m !== message)].slice(0, LIMIT);
  localStorage.setItem(KEY, JSON.stringify(messages));
}

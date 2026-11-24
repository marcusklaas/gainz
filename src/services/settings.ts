// Device-local state. Never leaves this machine except as auth headers.
// The deployed app is generic: it has no idea which repo holds the data until
// this is filled in. See PLAN.md "Client-side state".

export interface Settings {
  /** "owner/repo" — what the API wants. Parsed from the link that was pasted. */
  repo: string;
  branch: string;
  pat: string;
  /** One key per provider, so switching between them costs nothing. */
  anthropicKey: string;
  openaiKey: string;
}

const KEY = "gainz.settings";

/**
 * Takes the link straight off the repo's address bar. The scheme, a .git
 * suffix and a trailing slash are all optional, so pasting from anywhere works
 * and so does typing the bare owner/repo.
 */
export function parseRepo(input: string): string {
  const m = input.trim().match(/^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error("Expected a link like https://github.com/owner/repo");
  return `${m[1]}/${m[2]}`;
}

export const repoUrl = (s: Settings): string => `https://github.com/${s.repo}`;

export function loadSettings(): Settings | null {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Settings) : null;
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function isConfigured(): boolean {
  const s = loadSettings();
  return !!s && !!s.repo && !!s.pat;
}

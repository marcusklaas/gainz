// Device-local state. Never leaves this machine except as auth headers.
// The deployed app is generic: it has no idea which repo holds the data until
// this is filled in. See PLAN.md "Client-side state".

export interface Settings {
  owner: string;
  repo: string;
  branch: string;
  pat: string;
  /** One key per provider, so switching between them costs nothing. */
  anthropicKey: string;
  openaiKey: string;
}

const KEY = "gainz.settings";

export function loadSettings(): Settings | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  const s = JSON.parse(raw) as Settings & { llmKey?: string };
  // Before providers were split there was a single llmKey, always Anthropic.
  if (s.llmKey && !s.anthropicKey) s.anthropicKey = s.llmKey;
  return s;
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function isConfigured(): boolean {
  const s = loadSettings();
  return !!s && !!s.owner && !!s.repo && !!s.pat;
}

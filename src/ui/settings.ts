// Settings screen (config + device credentials + inline tooltips) and the
// Export for AI disclosure nested inside it.
import { at, defaultConfig, FIELDS, put, withDefaults } from "../core/config.js";
import { todayKey } from "../core/dates.js";
import { $, checked, flash, msg, num, val, type Screen } from "./dom.js";
import { buildContext, contextFrom } from "../core/export.js";
import { checkAccess } from "../services/github.js";
import { requestReminders, updatePlan } from "../services/notify.js";
import { loadSettings, parseRepo, repoUrl, saveSettings, type Settings } from "../services/settings.js";
import { cachedConfig, cachedDay, readRange, saveConfig } from "../services/store.js";
import type { Config } from "../core/types.js";

/** The folded settings, which is not every folded section on the screen. The
 *  export sits among them but holds no values to review, and unfolding it would
 *  fire a build against a repo that has not been configured yet. */
const sections = () =>
  document.querySelectorAll<HTMLDetailsElement>("#settings details:not(#export)");

export function needsConfig(show: (name: Screen) => void): void {
  const banner = $("config-banner");
  banner.hidden = false;
  banner.textContent = "No config.json in the repo yet. Review these values and save.";
  banner.className = "msg err";
  // Asking someone to review values behind five folded headings is asking them
  // not to. This is the one visit where all of it is the point.
  for (const d of sections()) d.open = true;
  show("settings");
}

/**
 * The ⓘ next to each setting, built from the label's data-tip so the markup
 * carries the words and nothing else. Hover shows it where there is a mouse;
 * a tap opens it and the next tap anywhere closes it, which is the nearest
 * thing to hovering that a finger has.
 */
function buildTips(): void {
  for (const label of document.querySelectorAll<HTMLElement>("#settings label[data-tip]")) {
    const text = label.dataset["tip"]!;
    const tip = document.createElement("button");
    tip.type = "button";
    tip.className = "tip";
    tip.textContent = "ⓘ";
    tip.setAttribute("aria-label", text);

    const bubble = document.createElement("span");
    bubble.className = "bubble";
    bubble.textContent = text;
    tip.append(bubble);

    // Inside a label, a click on anything reaches the control — on a checkbox
    // row it would toggle the box. Cancelling the default is what stops that.
    tip.addEventListener("click", (e) => {
      e.preventDefault();
      const wasOpen = tip.classList.contains("open");
      closeTips();
      tip.classList.toggle("open", !wasOpen);
    });

    // The control comes first on a checkbox row and last everywhere else, and
    // the ⓘ belongs after the words either way.
    const control = label.querySelector("input, select");
    if (control && !label.classList.contains("check")) label.insertBefore(tip, control);
    else label.append(tip);
  }
}

function closeTips(): void {
  for (const t of document.querySelectorAll(".tip.open")) t.classList.remove("open");
}

export function fillSettingsForms(): void {
  const s = loadSettings();
  if (s) {
    $<HTMLInputElement>("c-repo").value = repoUrl(s);
    $<HTMLInputElement>("c-branch").value = s.branch;
    $<HTMLInputElement>("c-pat").value = s.pat;
    $<HTMLInputElement>("c-anthropic").value = s.anthropicKey ?? "";
    $<HTMLInputElement>("c-openai").value = s.openaiKey ?? "";
  }

  // Already merged over the defaults by the store, so every field has a value
  // whether or not the stored config mentions it.
  const c = cachedConfig() ?? defaultConfig();
  for (const [id, path] of FIELDS) {
    const value = at(c, path);
    if (typeof value === "boolean") $<HTMLInputElement>(id).checked = value;
    else $<HTMLInputElement>(id).value = String(value);
  }

  $("notify-note").textContent =
    "Best effort: the device has to allow notifications, and one can arrive late" +
    " or, if gainz is closed and the browser will not wake it, not at all.";
}

/**
 * The inverse. A select answers to .value just like an input, so one loop reads
 * both. Anything unreadable falls back to its default rather than being saved
 * as NaN, which is the same guarantee the store gives on the way in.
 */
function readConfigForm(): Config {
  const raw: Record<string, unknown> = {};
  for (const [id, path, fallback] of FIELDS) {
    const value =
      typeof fallback === "boolean" ? checked(id) : typeof fallback === "number" ? num(id) : val(id);
    put(raw, path, value);
  }
  return withDefaults(raw);
}

function readConnForm(): Settings {
  return {
    repo: parseRepo(val("c-repo")),
    branch: val("c-branch"),
    pat: val("c-pat"),
    anthropicKey: val("c-anthropic"),
    openaiKey: val("c-openai"),
  };
}

const sameSettings = (a: Settings | null, b: Settings): boolean =>
  !!a && (Object.keys(b) as (keyof Settings)[]).every((k) => a[k] === b[k]);

// -------------------------------------------------------------------- export
//
// The document is built here and handed straight to the platform: clipboard,
// share sheet, or a file. There is no upload and no third party — where it goes
// is whatever the user pastes it into, which is the only reason this is a
// button and not a feature with an API key behind it.

/** The last document built, and what all three buttons act on. */
let exported: string | null = null;

const exportFile = () => `gainz-context-${todayKey()}.md`;

/**
 * When the export was taken, and where in the world "today" means. Built by
 * hand rather than with toLocaleString, which renders 8/14/2026 in one locale
 * and 14-8-2026 in the next — an ambiguity the document spends a section
 * avoiding everywhere else. The zone is named because every day key below it is
 * a local calendar date and nothing else says which local.
 */
function stamp(): string {
  const t = new Date();
  const hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  return `${todayKey()} ${hhmm} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}

const exportButtons = () => ["x-copy", "x-share", "x-download"].map((id) => $<HTMLButtonElement>(id));

/**
 * Rebuilt every time the section is opened rather than cached, so what gets
 * pasted is never a stale copy of this morning. It costs nothing after the
 * first: the months it reads are fetched once per session by the store, and
 * everything downstream is arithmetic.
 */
async function buildExport(): Promise<void> {
  const today = todayKey();
  for (const b of exportButtons()) b.disabled = true;
  msg("export-msg", "Building…");

  try {
    const days = await readRange(contextFrom(today), today);
    exported = buildContext(cachedConfig() ?? defaultConfig(), days, {
      today,
      generatedAt: stamp(),
    });
  } catch (e) {
    msg("export-msg", `Could not build the export: ${(e as Error).message}`, "err");
    return;
  }

  const text = $<HTMLTextAreaElement>("x-text");
  text.value = exported;
  text.hidden = false;
  // Both figures, because they answer different questions: kilobytes for
  // whether a paste box will take it, tokens for whether a chat will.
  $("export-size").textContent =
    `${Math.round(exported.length / 1024)} KB · roughly ${Math.round(exported.length / 4000)}k tokens`;
  msg("export-msg", "");
  for (const b of exportButtons()) b.disabled = false;
}

export function initSettings(deps: { sync: () => Promise<void> }): void {
  buildTips();

  // Runs after the tip's own handler, which is why an open one survives its own
  // click.
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest(".tip")) closeTips();
  });

  // A required field in a folded section still blocks the save, and the browser
  // cannot focus what it cannot show — so the section holding it is unfolded.
  // invalid does not bubble; capture is how one listener covers every field.
  $("settings-form").addEventListener(
    "invalid",
    (e) => {
      (e.target as HTMLElement).closest("details")?.setAttribute("open", "");
    },
    true,
  );

  /**
   * One save for both halves of the screen. They still land in two different
   * places — the config in the repo, the credentials in localStorage — but that
   * is a storage detail, and making the user press two buttons to act on it was
   * letting it leak into the UI.
   *
   * The config is written first and unconditionally: it is a local write behind
   * an outbox, so it cannot fail, and holding it hostage to a network check on
   * credentials that may not even have changed would be the wrong trade.
   */
  $("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();

    let s: Settings;
    try {
      s = readConnForm();
    } catch (err) {
      msg("settings-msg", (err as Error).message, "err");
      return;
    }

    const c = readConfigForm();
    saveConfig(c);

    // Permission is asked for here rather than on the toggle: this is the point
    // where the times are settled, and a prompt that appears mid-edit gets
    // dismissed. Re-plan reminders right away against whatever the answer was.
    const wanted = c.notifications.weight.enabled || c.notifications.nutrition.enabled;
    if (wanted) $("notify-note").textContent = await requestReminders();
    void updatePlan(c, cachedDay(todayKey())).catch(() => {});

    // Only worth a round trip when they actually changed — otherwise every edit
    // to a number would need the network to succeed, and saving offline is a
    // thing this app is supposed to be good at.
    if (!sameSettings(loadSettings(), s)) {
      msg("settings-msg", "Checking the connection…");
      try {
        await checkAccess(s);
      } catch (err) {
        // The config above is already saved and queued; only the credentials are
        // refused, so say which half did not land.
        msg("settings-msg", `Config saved. Connection not: ${(err as Error).message}`, "err");
        return;
      }
      saveSettings(s);
    }

    // saveConfig() already bumped store.revision(), so Today, Lifts, and Trend
    // automatically pick up the new config the next time each is shown.
    await deps.sync();
    $("config-banner").hidden = true;
    flash("settings-msg", "Saved.");
  });

  const exportSection = $<HTMLDetailsElement>("export");
  exportSection.addEventListener("toggle", () => {
    if (exportSection.open) void buildExport();
  });

  $("x-copy").addEventListener("click", async () => {
    if (!exported) return;
    try {
      await navigator.clipboard.writeText(exported);
      flash("export-msg", "Copied. Paste it into a chat and ask your question.");
    } catch {
      // Denied, or an insecure context. The textarea below is already the answer.
      $<HTMLTextAreaElement>("x-text").select();
      msg("export-msg", "Clipboard refused — the text below is selected, copy it by hand.", "err");
    }
  });

  // The one that matters on a phone: the share sheet puts the document into the
  // Claude or ChatGPT app directly. As a file where the platform will take one,
  // since a composer handles an attachment better than a 30 KB paste, and as text
  // where it will not. Hidden entirely where there is no sheet to open.
  const shareButton = $<HTMLButtonElement>("x-share");
  if (typeof navigator.share === "function") shareButton.hidden = false;

  shareButton.addEventListener("click", async () => {
    if (!exported) return;
    const file = new File([exported], exportFile(), { type: "text/markdown" });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
      else await navigator.share({ text: exported });
    } catch (e) {
      // Dismissing the sheet rejects, and is not a failure worth reporting.
      if ((e as Error).name !== "AbortError") {
        msg("export-msg", `Share failed: ${(e as Error).message}`, "err");
      }
    }
  });

  $("x-download").addEventListener("click", () => {
    if (!exported) return;
    const url = URL.createObjectURL(new Blob([exported], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFile();
    a.click();
    // Revoked on the next turn rather than immediately: the click starts the save
    // asynchronously, and pulling the URL out from under it can cancel it.
    setTimeout(() => URL.revokeObjectURL(url));
    flash("export-msg", "Saved. Attach it to a chat and ask your question.");
  });
}

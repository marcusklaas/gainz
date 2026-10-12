const MAX_SHOWN = 50;

export function needsDatalistFallback(ua: string): boolean {
  return (/Android/.test(ua) && /Firefox\/\d/.test(ua)) ||
    (/AppleWebKit\//.test(ua) && !/(?:Chrome|Chromium|Edg|OPR|SamsungBrowser)\//.test(ua));
}

/**
 * What to offer for what has been typed so far. Substring matching, like the
 * engines that implement this natively, except that entries starting with the
 * query are floated to the top — with a list this long the difference between
 * "bench" first and "bench" ninth is a scroll. Source order breaks ties, so the
 * caller's ordering (for exercises, most recent first) survives.
 */
export function suggestions(options: string[], query: string, limit = MAX_SHOWN): string[] {
  const q = query.trim().toLowerCase();
  const head: string[] = [];
  const rest: string[] = [];
  const seen = new Set<string>();

  for (const option of options) {
    const value = option.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    if (!q) rest.push(value);
    else if (key.startsWith(q)) head.push(value);
    else if (key.includes(q)) rest.push(value);
  }
  return head.concat(rest).slice(0, limit);
}

// ------------------------------------------------------------------ the popup

interface Popup {
  input: HTMLInputElement;
  list: HTMLUListElement;
  active: number;
}

let popup: Popup | null = null;
// Set while a pick is being written back, so the input event that announces it
// does not immediately reopen the list on the value just chosen.
let picking = false;

function listFor(input: HTMLInputElement): string[] {
  const id = input.getAttribute("data-datalist") ?? input.getAttribute("list");
  const el = id === null ? null : document.getElementById(id);
  if (!(el instanceof HTMLDataListElement)) return [];
  // An <option> may carry its value as the attribute or as its text.
  return [...el.options].map((o) => o.value || o.textContent || "");
}

function polyfilled(target: EventTarget | null): HTMLInputElement | null {
  if (!(target instanceof HTMLInputElement)) return null;
  const id = target.getAttribute("list");
  if (id !== null) {
    target.setAttribute("data-datalist", id);
    target.removeAttribute("list");
    target.setAttribute("role", "combobox");
    target.setAttribute("aria-autocomplete", "list");
    target.setAttribute("aria-expanded", "false");
  }
  return target.hasAttribute("data-datalist") ? target : null;
}

function close() {
  if (!popup) return;
  popup.list.remove();
  popup.input.setAttribute("aria-expanded", "false");
  popup.input.removeAttribute("aria-controls");
  popup.input.removeAttribute("aria-activedescendant");
  popup = null;
}

/**
 * Under the input, in the input's own parent — not in the body — so that the
 * page scrolling, or the on-screen keyboard shoving the layout around, moves
 * the list with the field it belongs to and needs no repositioning at all. The
 * parent is only made a containing block if it is not one already, and the list
 * is out of flow, so a flex or grid row keeps the shape it had.
 */
function place(input: HTMLInputElement, list: HTMLUListElement) {
  const parent = input.parentElement;
  if (!parent) return;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  list.style.left = `${input.offsetLeft}px`;
  list.style.top = `${input.offsetTop + input.offsetHeight}px`;
  list.style.width = `${input.offsetWidth}px`;
  parent.append(list);
}

function pick(value: string) {
  if (!popup) return;
  const input = popup.input;
  close();
  input.value = value;
  picking = true;
  input.focus();
  // Both events, in the order a real edit fires them: listeners downstream are
  // written against a user typing, and a value that arrived silently would be
  // the one case they missed.
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  picking = false;
}

function draw(input: HTMLInputElement) {
  close();
  const items = suggestions(listFor(input), input.value);
  if (items.length === 0) return;

  const list = document.createElement("ul");
  list.className = "datalist-fallback";
  list.id = "datalist-fallback";
  list.setAttribute("role", "listbox");
  for (const value of items) {
    const option = document.createElement("li");
    option.id = `${list.id}-${list.children.length}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.textContent = value;
    list.append(option);
  }

  place(input, list);
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", list.id);
  popup = { input, list, active: -1 };
}

// -------------------------------------------------------------- installation

/**
 * Delegated from the document rather than bound per field, so an input that
 * appears later — or a datalist that fills up long after the page loaded — is
 * covered without anything having to announce itself.
 */
export function installDatalistFallback(ua = navigator.userAgent) {
  if (!needsDatalistFallback(ua)) return;
  document.querySelectorAll("input[list]").forEach((input) => polyfilled(input));

  document.addEventListener("focusin", (e) => {
    if (picking) return;
    const input = polyfilled(e.target);
    if (input) draw(input);
    else close();
  });

  document.addEventListener("input", (e) => {
    if (picking) return;
    const input = polyfilled(e.target);
    if (input) draw(input);
  });

  document.addEventListener("focusout", (e) => {
    if (polyfilled(e.target)) close();
  });

  document.addEventListener("keydown", (event) => {
    const input = polyfilled(event.target);
    if (!input || event.isComposing) return;
    if (event.key === "Escape" && popup) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter" && popup?.input === input && popup.active >= 0) {
      event.preventDefault();
      const option = popup.list.children[popup.active];
      if (option?.textContent) pick(option.textContent);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (popup?.input !== input) draw(input);
    if (!popup) return;
    event.preventDefault();
    const count = popup.list.children.length;
    popup.active = event.key === "ArrowDown"
      ? (popup.active + 1) % count
      : (popup.active < 0 ? count - 1 : (popup.active - 1 + count) % count);
    Array.from(popup.list.children).forEach((option, index) => {
      option.setAttribute("aria-selected", String(index === popup!.active));
    });
    const option = popup.list.children[popup.active]!;
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  });

  // The form resetting after a submit leaves the field empty and focused, which
  // would otherwise sit there under the whole list.
  document.addEventListener("submit", close, true);
  document.addEventListener("reset", close, true);

  // pointerdown, not click: click arrives after the field has already lost
  // focus and closed the list out from under it. Suppressing the default keeps
  // the focus where it is, so the pick reads as an edit to a field still being
  // edited rather than one left behind.
  document.addEventListener("pointerdown", (e) => {
    const input = polyfilled(e.target);
    if (input) {
      // A tap on a field that already has focus fires no focusin — and after a
      // submit has emptied it, that tap is the whole "show me what I have
      // logged before" gesture.
      draw(input);
      return;
    }
    if (!popup) return;

    const target = e.target;
    if (!(target instanceof Node) || !popup.list.contains(target)) {
      close();
      return;
    }
    const option = target instanceof HTMLElement ? target.closest("li") : null;
    if (!option?.textContent) return;
    e.preventDefault();
    pick(option.textContent);
  });
}

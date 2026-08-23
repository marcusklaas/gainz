// A dropdown for <input list=…> on the browsers that draw none.
//
// Firefox for Android exposes the whole datalist DOM interface — the element
// upgrades, input.list resolves, the options are all there — and has never
// rendered the popup. Nothing appears as you type, so the exercise field looks
// like a plain text box that forgot every movement ever logged. That gap is
// invisible to feature detection precisely because the DOM half is present,
// which is why the test below is the user agent: there is nothing else to ask.
//
// The native element stays in the markup and stays the source of truth. This
// reads its options at the moment the list is drawn rather than copying them,
// so whatever repopulates the <datalist> — see the lift screen's render — needs
// to know nothing about any of this, and every browser that does draw its own
// popup keeps using it.
//
// Touch only: this runs on phones and tablets, so a suggestion is taken by
// tapping it and there is no arrow-key walk of the list to go with it. The soft
// keyboard's Enter still belongs to the form, which is where it went before any
// of this existed — a typed name that matches nothing is a valid answer here.

const MAX_SHOWN = 50;

/**
 * Firefox on Android, and nothing else: Firefox elsewhere renders datalists,
 * and the Android browsers that are not Firefox are Chromium, which does too.
 * `FxiOS` — Firefox on iOS — is WebKit underneath and is not matched here.
 */
export function needsDatalistFallback(ua: string): boolean {
  return /Android/.test(ua) && /Firefox\/\d/.test(ua);
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
}

let popup: Popup | null = null;
// Set while a pick is being written back, so the input event that announces it
// does not immediately reopen the list on the value just chosen.
let picking = false;

function listFor(input: HTMLInputElement): string[] {
  const id = input.getAttribute("list");
  const el = id === null ? null : document.getElementById(id);
  if (!(el instanceof HTMLDataListElement)) return [];
  // An <option> may carry its value as the attribute or as its text.
  return [...el.options].map((o) => o.value || o.textContent || "");
}

function polyfilled(target: EventTarget | null): HTMLInputElement | null {
  return target instanceof HTMLInputElement && target.hasAttribute("list") ? target : null;
}

function close() {
  if (!popup) return;
  popup.list.remove();
  popup.input.removeAttribute("aria-expanded");
  popup.input.removeAttribute("aria-controls");
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
  input.focus();
  picking = true;
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
    option.setAttribute("role", "option");
    option.textContent = value;
    list.append(option);
  }

  place(input, list);
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-controls", list.id);
  popup = { input, list };
}

// -------------------------------------------------------------- installation

/**
 * Delegated from the document rather than bound per field, so an input that
 * appears later — or a datalist that fills up long after the page loaded — is
 * covered without anything having to announce itself.
 */
export function installDatalistFallback(ua = navigator.userAgent) {
  if (!needsDatalistFallback(ua)) return;

  document.addEventListener("focusin", (e) => {
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

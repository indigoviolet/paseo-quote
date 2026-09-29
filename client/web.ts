import type { PluginClientContext } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { Platform } from "react-native";
import { sendReply, startSideChat, type SendBehavior } from "./actions";
import { formatQuote, formatReply, joinParagraph, type QuoteSource } from "./format";

/*
 * The selection bar: Quote, Reply, Side chat, and Copy for text selected in a chat.
 *
 * Web and desktop only. iOS and Android route selection through the platform
 * menu, which a plugin cannot extend.
 *
 * Plugins have no composer API and no portal, so this module drives the host
 * DOM directly. Every host selector it relies on is listed below; when a Paseo
 * release renames one, this list is the place to fix.
 *
 * The bar lives in a shadow root on `document.body`: the chat clips and
 * translates its content, and the host's global CSS would otherwise restyle the
 * bar. The reply field is the one exception. It is a light-DOM textarea slotted
 * into the shadow tree, because the host's keyboard shortcuts classify the
 * event target: a textarea reads as "editable", while anything inside a shadow
 * root reads as the shadow host, where Escape interrupts the agent and Space
 * toggles voice.
 */

// ---------------------------------------------------------------------------
// Host DOM contract (Paseo 0.10)

/** One chat transcript. Inactive tabs keep theirs mounted with `display: none`. */
const CHAT_SCROLL = '[data-testid="agent-chat-scroll"]';
/** The composer textarea. Every retained chat has one, visible or not. */
const COMPOSER = "textarea[data-composer-input]";
/** A split-view pane; its tab row names the agent whose chat it shows. */
const PANE = '[data-testid^="workspace-pane-"]';
const ACTIVE_AGENT_TAB = '[data-testid^="workspace-tab-agent_"][aria-selected="true"]';
const AGENT_TAB_PREFIX = "workspace-tab-agent_";
/** Markdown serialization hints the host puts on rendered assistant messages. */
const CODE_BLOCK = '[data-paseo-markdown-tag="pre"]';
const CODE_SPAN = '[data-paseo-markdown-tag="code"]';
const CODE_LANGUAGE_ATTRIBUTE = "data-paseo-markdown-language";
/** Monospace surfaces such as tool output. */
const CODE_SURFACE = "[data-pmono]";

// ---------------------------------------------------------------------------
// The DOM this module uses. The plugin typechecks without the DOM library.

interface DomRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface DomEvent {
  readonly type: string;
  readonly target: DomNode | null;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

interface DomKeyboardEvent extends DomEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
}

type DomListener = (event: DomEvent) => void;

interface DomEventTarget {
  addEventListener(type: string, listener: DomListener, capture?: boolean): void;
  removeEventListener(type: string, listener: DomListener, capture?: boolean): void;
  dispatchEvent(event: DomEvent): boolean;
}

interface DomNode extends DomEventTarget {
  readonly nodeType: number;
  readonly parentElement: DomElement | null;
  readonly isConnected: boolean;
}

interface DomStyle {
  setProperty(name: string, value: string, priority?: string): void;
  readonly color: string;
  readonly backgroundColor: string;
  readonly fontFamily: string;
}

interface DomElement extends DomNode {
  readonly style: DomStyle;
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  textContent: string | null;
  innerHTML: string;
  hidden: boolean;
  closest(selector: string): DomElement | null;
  matches(selector: string): boolean;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  appendChild<Child extends DomNode>(child: Child): Child;
  contains(node: DomNode | null): boolean;
  remove(): void;
  getClientRects(): ArrayLike<DomRect>;
  attachShadow(init: { mode: "open" }): DomShadowRoot;
  focus(options?: { preventScroll?: boolean }): void;
}

interface DomButton extends DomElement {
  disabled: boolean;
}

interface DomShadowRoot {
  innerHTML: string;
  querySelector(selector: string): DomElement | null;
}

interface DomTextArea extends DomElement {
  value: string;
  placeholder: string;
  rows: number;
  readOnly: boolean;
  disabled: boolean;
  scrollTop: number;
  readonly scrollHeight: number;
  setSelectionRange(start: number, end: number): void;
}

interface DomRange {
  readonly startContainer: DomNode;
  readonly endContainer: DomNode;
  readonly commonAncestorContainer: DomNode;
  getClientRects(): ArrayLike<DomRect>;
  getBoundingClientRect(): DomRect;
}

interface DomSelection {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  getRangeAt(index: number): DomRange;
  toString(): string;
}

interface DomDataTransfer {
  getData(format: string): string;
}

declare const window: DomEventTarget & {
  readonly innerWidth: number;
  readonly innerHeight: number;
  getSelection(): DomSelection | null;
  getComputedStyle(element: DomElement): DomStyle;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
};
declare const document: DomEventTarget & {
  readonly body: DomElement;
  createElement(tag: "div"): DomElement;
  createElement(tag: "textarea"): DomTextArea;
  execCommand(command: "insertText", showUi: boolean, value: string): boolean;
};
declare const Event: new (type: string, init?: { bubbles?: boolean }) => DomEvent;
declare const DataTransfer: new () => DomDataTransfer;
declare const ClipboardEvent: new (
  type: string,
  init: { bubbles: boolean; cancelable: boolean; clipboardData: DomDataTransfer },
) => DomEvent;

declare const localStorage: { getItem(key: string): string | null };
declare const navigator: { readonly userAgent: string };

const ELEMENT_NODE = 1;

/** Where the app keeps Settings; the legacy key predates the current one. */
const APP_SETTINGS_KEYS = ["@paseo:app-settings", "@paseo:settings"];

/** Settings → Sending → Default send, as the composer reads it. */
function readSendBehavior(): SendBehavior {
  for (const key of APP_SETTINGS_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const value = (JSON.parse(raw) as { sendBehavior?: unknown }).sendBehavior;
      return value === "interrupt" || value === "queue" ? value : "steer";
    } catch {
      // Unreadable settings fall through to the app's own default.
    }
  }
  return "steer";
}

/** Only called on the web, where `navigator` exists. */
function modKey(): string {
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";
}

// ---------------------------------------------------------------------------
// Reading a selection

interface Snapshot {
  source: QuoteSource;
  /** Rendered text, for the preview. */
  preview: string;
  first: DomRect;
  last: DomRect;
  /** Where the selection's text is taken from; supplies the popup colors. */
  anchor: DomElement;
  composer: DomTextArea | null;
  agentId: string | null;
}

function elementOf(node: DomNode | null): DomElement | null {
  if (!node) return null;
  return node.nodeType === ELEMENT_NODE ? (node as DomElement) : node.parentElement;
}

/**
 * The live selection, or null unless it is non-empty and both of its ends sit
 * in the same chat transcript.
 */
function readSnapshot(ignore: DomElement): Snapshot | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const preview = selection.toString().trim();
  if (!preview) return null;

  const range = selection.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  if (!start || !end || ignore.contains(start)) return null;
  const transcript = start.closest(CHAT_SCROLL);
  if (!transcript || end.closest(CHAT_SCROLL) !== transcript) return null;

  const rects = range.getClientRects();
  const bounds = range.getBoundingClientRect();
  const first = rects.length > 0 ? rects[0]! : bounds;
  const last = rects.length > 0 ? rects[rects.length - 1]! : bounds;
  if (first.width === 0 && first.height === 0) return null;

  return {
    source: readSource(selection, range, start),
    preview,
    first,
    last,
    anchor: start,
    composer: usableComposer(nearestUnique(transcript, COMPOSER) as DomTextArea | null),
    agentId: agentIdOf(nearestUnique(transcript, ACTIVE_AGENT_TAB)),
  };
}

/**
 * The first visible match walking up from `from`, stopping at its pane. Two
 * visible matches at the same level mean two chats share it: no answer beats a
 * wrong one.
 */
function nearestUnique(from: DomElement, selector: string): DomElement | null {
  for (let node = from.parentElement; node; node = node.parentElement) {
    const visible = Array.from(node.querySelectorAll(selector)).filter(isVisible);
    if (visible.length === 1) return visible[0]!;
    if (visible.length > 1 || node.matches(PANE)) return null;
  }
  return null;
}

function isVisible(element: DomElement): boolean {
  return element.getClientRects().length > 0;
}

function usableComposer(input: DomTextArea | null): DomTextArea | null {
  return input && !input.readOnly && !input.disabled ? input : null;
}

function agentIdOf(tab: DomElement | null): string | null {
  const testId = tab?.getAttribute("data-testid");
  return testId?.startsWith(AGENT_TAB_PREFIX) ? testId.slice(AGENT_TAB_PREFIX.length) || null : null;
}

function readSource(selection: DomSelection, range: DomRange, start: DomElement): QuoteSource {
  const common = elementOf(range.commonAncestorContainer);
  const block = common?.closest(CODE_BLOCK) ?? null;
  const inCode = Boolean(block || common?.closest(CODE_SPAN) || common?.closest(CODE_SURFACE));
  const code = inCode ? { language: block?.getAttribute(CODE_LANGUAGE_ATTRIBUTE) ?? null } : null;
  return { text: hostMarkdown(start) ?? selection.toString(), code };
}

/**
 * The selection as Markdown, from the host's own copy handler.
 *
 * Assistant messages carry a copy handler that turns the selection back into
 * Markdown: lists, tables, emphasis, and fences survive. A synthetic copy event
 * with a private DataTransfer runs that handler without touching the system
 * clipboard. Selections the handler does not own come back null.
 */
function hostMarkdown(target: DomElement): string | null {
  if (typeof ClipboardEvent === "undefined" || typeof DataTransfer === "undefined") return null;
  try {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
    target.dispatchEvent(event);
    if (!event.defaultPrevented) return null;
    const text = clipboardData.getData("text/plain");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writing into the composer

/**
 * Appends `snippet` as a new paragraph, leaves the caret after it, and reports
 * whether the composer took it.
 *
 * `insertText` goes through the browser's editing path, so the host's change
 * handler sees a real edit and the step is one undo. The native value setter
 * plus a bubbling `input` event is the fallback; a value check guards both.
 */
function appendToComposer(input: DomTextArea, snippet: string): boolean {
  if (!input.isConnected) return false;
  const before = input.value;
  const insert = joinParagraph(before, snippet);
  const next = before + insert;

  input.focus({ preventScroll: true });
  input.setSelectionRange(before.length, before.length);
  let landed = document.execCommand("insertText", false, insert) && input.value === next;
  if (!landed && input.value === before) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    landed = input.value === next;
  }
  if (!landed) return false;
  input.setSelectionRange(next.length, next.length);
  input.scrollTop = input.scrollHeight;
  return true;
}

// ---------------------------------------------------------------------------
// Colors, read from the chat itself so the bar follows every theme

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba | null {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

function css([r, g, b]: Rgba, alpha = 1): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

function mix(a: Rgba, b: Rgba, amount: number): Rgba {
  return [
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
    1,
  ];
}

function luminance([r, g, b]: Rgba): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function applyPalette(host: DomElement, anchor: DomElement): void {
  const style = window.getComputedStyle(anchor);
  const foreground = parseColor(style.color) ?? [220, 220, 220, 1];
  let background: Rgba | null = null;
  for (let node: DomElement | null = anchor; node && !background; node = node.parentElement) {
    const color = parseColor(window.getComputedStyle(node).backgroundColor);
    if (color && color[3] > 0.95) background = color;
  }
  background ??= luminance(foreground) > 0.5 ? [24, 24, 27, 1] : [250, 250, 250, 1];
  const dark = luminance(background) < 0.5;
  const surface = mix(background, foreground, dark ? 0.07 : 0.025);

  const tokens: Array<[string, string]> = [
    ["--pq-fg", css(foreground)],
    ["--pq-muted", css(foreground, 0.62)],
    ["--pq-faint", css(foreground, 0.42)],
    ["--pq-border", css(foreground, dark ? 0.16 : 0.14)],
    ["--pq-hover", css(foreground, 0.09)],
    ["--pq-bg", css(surface)],
    ["--pq-field", css(background)],
    ["--pq-primary-fg", css(background)],
    ["--pq-danger", dark ? "#f87171" : "#dc2626"],
    ["--pq-shadow", dark ? "0 12px 32px rgba(0, 0, 0, 0.5)" : "0 12px 32px rgba(0, 0, 0, 0.16)"],
    ["--pq-font", style.fontFamily || "system-ui, sans-serif"],
  ];
  for (const [name, value] of tokens) host.style.setProperty(name, value);
}

// ---------------------------------------------------------------------------
// The bar and the reply card

const ICON = {
  quote:
    '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  reply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  side: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
} as const;

function svg(paths: string): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  font-family: var(--pq-font);
  font-size: 13px;
  line-height: 18px;
  color: var(--pq-fg);
  background: var(--pq-bg);
  border: 1px solid var(--pq-border);
  border-radius: 10px;
  box-shadow: var(--pq-shadow);
  user-select: none;
  -webkit-user-select: none;
}
.bar { display: flex; align-items: center; gap: 2px; padding: 3px; }
.card { display: none; flex-direction: column; gap: 8px; padding: 10px; width: min(440px, calc(100vw - 16px)); }
.panel[data-mode="card"] .bar { display: none; }
.panel[data-mode="card"] .card { display: flex; }
button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin: 0;
  padding: 5px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
button:hover:not(:disabled) { background: var(--pq-hover); }
button:disabled { opacity: 0.4; cursor: default; }
button[hidden] { display: none; }
.icon-only { padding: 5px 7px; }
.divider { width: 1px; align-self: stretch; margin: 4px 2px; background: var(--pq-border); }
.quote {
  max-height: 54px;
  overflow: hidden;
  padding-left: 9px;
  border-left: 2px solid var(--pq-border);
  color: var(--pq-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.footer { display: flex; align-items: center; gap: 6px; }
.hint { flex: 1 1 auto; min-width: 0; color: var(--pq-faint); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.error { flex: 1 1 auto; min-width: 0; color: var(--pq-danger); font-size: 12px; overflow-wrap: anywhere; }
.error:empty { display: none; }
.error:not(:empty) + .hint { display: none; }
.primary { background: var(--pq-fg); color: var(--pq-primary-fg); }
.primary:hover:not(:disabled) { background: var(--pq-fg); opacity: 0.88; }
`;

const MARKUP = `
<style>${STYLE}</style>
<div class="panel" data-mode="bar">
  <div class="bar" role="toolbar" aria-label="Selection">
    <button data-action="quote" title="Quote into the message box">${svg(ICON.quote)}Quote</button>
    <button data-action="reply" title="Reply to this passage">${svg(ICON.reply)}Reply</button>
    <button data-action="side" title="Ask about this in a side chat">${svg(ICON.side)}Side chat</button>
    <span class="divider"></span>
    <button data-action="copy" class="icon-only" title="Copy as Markdown">${svg(ICON.copy)}</button>
  </div>
  <div class="card">
    <div class="quote"></div>
    <slot name="input"></slot>
    <div class="footer">
      <span class="error" role="alert"></span>
      <span class="hint"></span>
      <button data-action="cancel">Cancel</button>
      <button data-action="add">Add to chat</button>
      <button data-action="send" class="primary">Send</button>
      <button data-action="ask" class="primary">Ask</button>
    </div>
  </div>
</div>
`;

type Mode = "hidden" | "bar" | "reply" | "side";

const GAP = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Installs the selection bar. Returns cleanup; a no-op off the web. */
export function installSelectionBar(client: PluginClientContext): () => void {
  if (Platform.OS !== "web" || typeof document === "undefined") return () => {};

  const host = document.createElement("div");
  host.setAttribute("data-paseo-quote", "");
  for (const [property, value] of [
    ["position", "fixed"],
    ["top", "0"],
    ["left", "0"],
    ["z-index", "2147483000"],
    ["display", "none"],
    ["margin", "0"],
    ["padding", "0"],
  ] as const) {
    host.style.setProperty(property, value, "important");
  }
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = MARKUP;
  const panel = shadow.querySelector(".panel")!;
  const quotePreview = shadow.querySelector(".quote")!;
  const hint = shadow.querySelector(".hint")!;
  const error = shadow.querySelector(".error")!;
  const button = (action: string) =>
    shadow.querySelector(`[data-action="${action}"]`) as DomButton;

  const field = document.createElement("textarea");
  field.setAttribute("slot", "input");
  field.setAttribute("spellcheck", "true");
  field.rows = 3;
  for (const [property, value] of [
    ["all", "unset"],
    ["display", "block"],
    ["box-sizing", "border-box"],
    ["width", "100%"],
    ["min-height", "62px"],
    ["max-height", "220px"],
    ["padding", "8px 10px"],
    ["border", "1px solid var(--pq-border)"],
    ["border-radius", "8px"],
    ["background", "var(--pq-field)"],
    ["color", "var(--pq-fg)"],
    ["font-family", "var(--pq-font)"],
    ["font-size", "13px"],
    ["line-height", "19px"],
    ["white-space", "pre-wrap"],
    ["overflow-wrap", "anywhere"],
    ["overflow-y", "auto"],
    ["resize", "vertical"],
    ["user-select", "text"],
    ["-webkit-user-select", "text"],
    ["cursor", "text"],
  ] as const) {
    field.style.setProperty(property, value, "important");
  }
  host.appendChild(field);
  document.body.appendChild(host);

  let mode: Mode = "hidden";
  let snapshot: Snapshot | null = null;
  let busy = false;
  let pending = 0;
  let flashTimer = 0;

  const setError = (message: string) => {
    error.textContent = message;
  };

  const place = (anchor: DomRect, prefer: "above" | "below") => {
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = clamp(anchor.left + anchor.width / 2 - width / 2, GAP, window.innerWidth - width - GAP);
    const above = anchor.top - height - GAP;
    const below = anchor.bottom + GAP;
    const fitsAbove = above >= GAP;
    const fitsBelow = below + height <= window.innerHeight - GAP;
    const top =
      prefer === "above"
        ? fitsAbove || !fitsBelow
          ? above
          : below
        : fitsBelow || !fitsAbove
          ? below
          : above;
    host.style.setProperty("left", `${Math.round(left)}px`, "important");
    host.style.setProperty(
      "top",
      `${Math.round(clamp(top, GAP, window.innerHeight - height - GAP))}px`,
      "important",
    );
  };

  const setBusy = (value: boolean) => {
    busy = value;
    field.readOnly = value;
    for (const action of ["add", "send", "ask", "cancel"]) {
      button(action).disabled = value;
    }
  };

  const hide = () => {
    window.clearTimeout(flashTimer);
    mode = "hidden";
    snapshot = null;
    setBusy(false);
    field.value = "";
    setError("");
    panel.setAttribute("data-mode", "bar");
    host.style.setProperty("display", "none", "important");
  };

  const showBar = (next: Snapshot) => {
    snapshot = next;
    mode = "bar";
    panel.setAttribute("data-mode", "bar");
    button("quote").disabled = !next.composer;
    button("reply").disabled = !next.composer && !next.agentId;
    button("side").disabled = !next.agentId;
    button("copy").innerHTML = svg(ICON.copy);
    applyPalette(host, next.anchor);
    host.style.setProperty("display", "block", "important");
    place(next.first, "above");
  };

  const openCard = (kind: "reply" | "side") => {
    if (!snapshot) return;
    mode = kind;
    panel.setAttribute("data-mode", "card");
    quotePreview.textContent = snapshot.preview;
    setError("");
    field.value = "";
    const canSend = Boolean(snapshot.agentId);
    const canAdd = Boolean(snapshot.composer);
    button("add").hidden = kind !== "reply" || !canAdd;
    button("send").hidden = kind !== "reply" || !canSend;
    button("ask").hidden = kind !== "side";
    if (kind === "reply") {
      field.placeholder = "Reply to this passage…";
      hint.textContent =
        canSend && canAdd
          ? `Enter — send · ${modKey()}+Enter — add to chat`
          : canSend
            ? "Enter — send"
            : "Enter — add to chat";
    } else {
      field.placeholder = "Ask about this in a side chat…";
      hint.textContent = "Enter — ask · Shift+Enter — new line";
    }
    place(snapshot.last, "below");
    field.focus({ preventScroll: true });
  };

  const quote = () => {
    if (!snapshot?.composer) return;
    if (appendToComposer(snapshot.composer, `${formatQuote(snapshot.source)}\n\n`)) hide();
  };

  const copy = () => {
    if (!snapshot) return;
    const target = button("copy");
    void copyText(snapshot.source.text.trim()).then(() => {
      target.innerHTML = svg(ICON.check);
      window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(hide, 700);
    });
  };

  const addReply = () => {
    if (!snapshot?.composer || busy) return;
    if (appendToComposer(snapshot.composer, formatReply(snapshot.source, field.value))) {
      hide();
    } else {
      setError("The message box is not available.");
    }
  };

  /** Runs `work`, then closes; a returned note stays on screen for a moment first. */
  const run = async (work: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const note = await work();
      if (!note) {
        hide();
        return;
      }
      hint.textContent = note;
      window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(hide, 1400);
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
      field.focus({ preventScroll: true });
    }
  };

  const send = () => {
    const current = snapshot;
    if (!current?.agentId || !field.value.trim()) return;
    const agentId = current.agentId;
    const text = formatReply(current.source, field.value);
    void run(async () => {
      const outcome = await sendReply(client.paseo, agentId, text, readSendBehavior());
      return outcome === "queued" ? "Queued — sends when the current turn ends" : undefined;
    });
  };

  const askSide = () => {
    const current = snapshot;
    if (!current?.agentId || !field.value.trim()) return;
    const agentId = current.agentId;
    const question = field.value;
    void run(async () => {
      const side = await startSideChat(client.paseo, {
        agentId,
        quote: formatQuote(current.source),
        question,
      });
      client.openPanel("side-chat", {
        workspaceId: side.workspaceId,
        agentId: side.agentId,
        location: "explorer",
      });
    });
  };

  const actions: Record<string, () => void> = {
    quote,
    reply: () => openCard("reply"),
    side: () => openCard("side"),
    copy,
    cancel: hide,
    add: addReply,
    send,
    ask: askSide,
  };

  // A press inside the panel must not move the caret, or the page selection is
  // gone by the time the click lands. The slotted field is exempt: it needs focus.
  const onPanelPointerDown: DomListener = (event) => {
    if (event.target !== field) event.preventDefault();
  };
  const onPanelClick: DomListener = (event) => {
    const target = elementOf(event.target)?.closest("button[data-action]") as DomButton | null;
    const action = target?.getAttribute("data-action");
    if (action && !target!.disabled) actions[action]?.();
  };
  // On the panel, inside the shadow tree: a listener on the host would only ever
  // see the host as the target.
  panel.addEventListener("mousedown", onPanelPointerDown);
  panel.addEventListener("click", onPanelClick);

  const onFieldKeyDown: DomListener = (raw) => {
    const event = raw as DomKeyboardEvent;
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // Enter is the highlighted action, Send; the modifier defers into the composer.
    const defer = event.ctrlKey || event.metaKey;
    if (mode === "side") {
      askSide();
    } else if (snapshot?.agentId && (!defer || !snapshot.composer)) {
      send();
    } else {
      addReply();
    }
  };
  field.addEventListener("keydown", onFieldKeyDown);

  const sync = () => {
    pending = 0;
    if (mode === "reply" || mode === "side") return;
    const next = readSnapshot(host);
    if (next) showBar(next);
    else if (mode === "bar") hide();
  };
  const schedule = () => {
    if (pending === 0) pending = window.setTimeout(sync, 0);
  };

  const inside = (event: DomEvent) => event.target !== null && host.contains(event.target);

  const onPointerDown: DomListener = (event) => {
    if (inside(event) || mode === "hidden") return;
    // An unsent reply survives a stray click; Escape or Cancel discards it.
    if ((mode === "reply" || mode === "side") && field.value.trim()) return;
    hide();
  };
  const onPointerUp: DomListener = (event) => {
    if (!inside(event)) schedule();
  };
  const onKeyUp: DomListener = (raw) => {
    const event = raw as DomKeyboardEvent;
    if (event.shiftKey && !inside(event)) schedule();
  };
  const onSelectionChange: DomListener = () => {
    // Show on release, not while dragging; hide as soon as the selection goes.
    if (mode !== "bar") return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) hide();
  };
  const onViewportChange: DomListener = () => {
    if (mode === "bar") schedule();
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);

  return () => {
    window.clearTimeout(pending);
    window.clearTimeout(flashTimer);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("keyup", onKeyUp, true);
    document.removeEventListener("selectionchange", onSelectionChange);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
    panel.removeEventListener("mousedown", onPanelPointerDown);
    panel.removeEventListener("click", onPanelClick);
    field.removeEventListener("keydown", onFieldKeyDown);
    host.remove();
  };
}

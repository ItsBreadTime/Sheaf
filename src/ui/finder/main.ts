import "../shared/tokens.css";
import "./finder.css";
import { element, send } from "../shared/helpers";
import {
  buildStashedSearchSnapshot,
  directResultsAreStrong,
  directStashedTabSearch,
  directTabSearch,
  type SearchableStashedTab,
  type SearchableTab,
} from "../../search/direct-search";
import { semanticSearchAvailability } from "../../search/semantic-availability";
import { SEMANTIC_SEARCH_DEBOUNCE_MS } from "../../shared/constants";
import type { SemanticQueryResult } from "../../search/semantic-query";
import type { SearchStoredState } from "../../shared/search-types";
import type { SemanticIndexMeta } from "../../shared/semantic-index-types";
import { captureOpenTabSnapshot } from "../../search/open-tab-snapshot";
import { openSearchPickKey, searchPickBoosts, stashSearchPickKey, type SearchPick } from "../../search/search-picks";
import { readSearchPicks, readSearchState, recordSearchPickInSession } from "../../storage/search";
import { readTabStashes } from "../../storage/stashes";
import { installUsageRecorder } from "../../storage/usage-stats";

installUsageRecorder();

// The search shortcut's finder: one field and the tabs that match it, in a small
// window of its own over the browser window named in the URL. Direct matches are
// local and instant; when search by meaning is set up, related tabs follow them
// under the same rules as the popup's search.

const MAX_RESULTS = 8;

type Row =
  | { kind: "open"; key: string; tab: SearchableTab; related: boolean }
  | { kind: "stash"; key: string; tab: SearchableStashedTab; related: boolean };

const input = document.querySelector<HTMLInputElement>("#finder-input")!;
const list = document.querySelector<HTMLUListElement>("#finder-results")!;
const empty = document.querySelector<HTMLParagraphElement>(".finder__empty")!;
const status = document.querySelector<HTMLSpanElement>(".finder__status")!;
const finder = document.querySelector<HTMLElement>(".finder")!;

const requestedWindowId = Number(new URLSearchParams(location.search).get("window"));
const targetWindowId = Number.isSafeInteger(requestedWindowId) ? requestedWindowId : null;

let openTabs: SearchableTab[] = [];
let savedTabs: SearchableStashedTab[] = [];
let picks: SearchPick[] = [];
let includeGroupNames = true;
let searchState: SearchStoredState | null = null;
let semanticMeta: SemanticIndexMeta | null = null;
let semantic: { query: string; status: "loading" | "ready" | "failed"; results: SemanticQueryResult[] } | null = null;
let semanticTimer: ReturnType<typeof setTimeout> | null = null;
let semanticController: AbortController | null = null;
// Loaded on the first query that needs it; see semantic-search.ts.
let semanticModule: Promise<typeof import("./semantic-search")> | null = null;
const loadSemantic = () => (semanticModule ??= import("./semantic-search"));
let semanticModuleLoaded: typeof import("./semantic-search") | null = null;
let rows: Row[] = [];
let selected = 0;
let ownWindowId: number | null = null;
let busy = false;

function focusInput(): void {
  input.focus({ preventScroll: true });
}

focusInput();
window.addEventListener("focus", focusInput);

async function close(): Promise<void> {
  if (ownWindowId !== null) await chrome.windows.remove(ownWindowId).catch(() => window.close());
  else window.close();
}

function faviconUrl(pageUrl: string): string {
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", pageUrl);
  url.searchParams.set("size", "32");
  return url.toString();
}

function detail(row: Row): string {
  const parts = [row.tab.hostname || row.tab.url];
  if (row.kind === "open") {
    if (row.tab.groupName) parts.push(row.tab.groupName);
    if (row.tab.windowLabel !== "Current window") parts.push(row.tab.windowLabel);
  } else {
    parts.push(`in ${row.tab.stashName}`);
  }
  return parts.join(" · ");
}

function normalizedQuery(query: string): string {
  return query.normalize("NFKC").trim();
}

// Index scope decides semantic scope: a current-window index answers for that window only.
function semanticScope(): "current_window" | "all_windows" {
  return semanticMeta?.indexScope === "current_window" ? "current_window" : "all_windows";
}

function semanticUnavailable(): string | null {
  if (!searchState || !semanticMeta) return "Related search is off";
  return semanticSearchAvailability(searchState, semanticScope(), semanticMeta, targetWindowId);
}

function search(query: string): Row[] {
  if (!query.trim()) return [];
  const boosts = searchPickBoosts(picks, query);
  const openResults = directTabSearch(openTabs, query, { includeGroupNames, limit: MAX_RESULTS });
  const savedResults = directStashedTabSearch(savedTabs, query, { includeGroupNames, limit: MAX_RESULTS });
  const open = openResults
    .map((result): Row => ({ kind: "open", key: openSearchPickKey(result.tab.id), tab: result.tab, related: false }));
  const saved = savedResults
    .map((result): Row => ({
      kind: "stash",
      key: stashSearchPickKey(result.tab.stashId, result.tab.stashTabId),
      tab: result.tab,
      related: false,
    }));
  // A tab already chosen for this query leads; open tabs come before saved ones.
  const boost = (row: Row): number => boosts.get(row.key) ?? 0;
  const direct = [
    ...open.sort((left, right) => boost(right) - boost(left)),
    ...saved.sort((left, right) => boost(right) - boost(left)),
  ];
  maybeScheduleSemantic(query, directResultsAreStrong([...openResults, ...savedResults]));
  // Related tabs fill the space direct matches leave, in score order.
  const seen = new Set(direct.map((row) => row.key));
  const related: Row[] = [];
  if (semantic?.query === normalizedQuery(query) && semantic.status === "ready") {
    for (const result of semantic.results) {
      const target = result.target;
      if (target.kind === "open") {
        const tab = openTabs.find((candidate) => candidate.id === target.tabId && candidate.windowId === target.windowId);
        if (tab && !seen.has(openSearchPickKey(tab.id))) {
          related.push({ kind: "open", key: openSearchPickKey(tab.id), tab, related: true });
        }
      } else {
        const tab = savedTabs.find((candidate) => candidate.stashId === target.stashId && candidate.sourceIndex === target.sourceIndex);
        const key = tab ? stashSearchPickKey(tab.stashId, tab.stashTabId) : null;
        if (tab && key && !seen.has(key)) related.push({ kind: "stash", key, tab, related: true });
      }
    }
  }
  return [...direct, ...related].slice(0, MAX_RESULTS);
}

// The same rule as the popup: always, or only when direct matches are weak.
function maybeScheduleSemantic(query: string, directStrong: boolean, explicit = false): void {
  const normalized = normalizedQuery(query);
  if (!normalized || semanticUnavailable()) return;
  if (semantic?.query === normalized) return;
  const settings = searchState!.local.settings;
  if (!explicit && !settings.semanticAlways && !(settings.semanticWhenDirectWeak && !directStrong)) return;
  if (semanticTimer) clearTimeout(semanticTimer);
  semanticController?.abort();
  semantic = { query: normalized, status: "loading", results: [] };
  semanticTimer = setTimeout(() => {
    semanticTimer = null;
    void runSemantic(normalized);
  }, explicit || semanticModuleLoaded?.queryVectorCached(normalized) ? 0 : SEMANTIC_SEARCH_DEBOUNCE_MS);
  // Start loading during the debounce, so the first query does not wait for it.
  void loadSemantic().then((module) => { semanticModuleLoaded = module; }).catch(() => undefined);
}

// The finder's sources follow the index scope: a current-window index answers for that window only.
function semanticOpenTabs(): SearchableTab[] {
  return semanticScope() === "all_windows" ? openTabs : openTabs.filter((tab) => tab.windowId === targetWindowId);
}

async function runSemantic(query: string): Promise<void> {
  const meta = semanticMeta!;
  const controller = new AbortController();
  semanticController = controller;
  renderStatus();
  try {
    const module = await loadSemantic();
    semanticModuleLoaded = module;
    const results = await module.searchByMeaning({
      query,
      meta,
      openTabs: semanticOpenTabs(),
      savedTabs,
      signal: controller.signal,
    });
    if (results === null || controller.signal.aborted || semantic?.query !== query) return;
    semantic = { query, status: "ready", results };
  } catch {
    if (controller.signal.aborted || semantic?.query !== query) return;
    semantic = { query, status: "failed", results: [] };
  } finally {
    if (semanticController === controller) semanticController = null;
  }
  render();
}

function renderStatus(): void {
  const current = semantic?.query === normalizedQuery(input.value) ? semantic : null;
  status.textContent = current?.status === "loading" ? "Searching by meaning…" : "";
  status.hidden = !status.textContent;
}

function render(): void {
  const query = input.value;
  rows = search(query);
  selected = Math.min(selected, Math.max(0, rows.length - 1));
  list.replaceChildren(...rows.map((row, index) => {
    const item = element("li", "finder__row");
    item.id = `finder-row-${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === selected));
    const icon = element("img", "finder__favicon");
    icon.src = faviconUrl(row.tab.url);
    icon.alt = "";
    const text = element("span", "finder__text");
    // Saved and related rows are not plain open-tab matches, so they carry a
    // tinted tag on the title line that reads before the detail does.
    const heading = element("span", "finder__heading");
    heading.append(element("span", "finder__title", row.tab.title));
    if (row.kind === "stash") heading.append(element("span", "finder__tag finder__tag--saved", "Saved"));
    if (row.related) heading.append(element("span", "finder__tag finder__tag--related", "Related"));
    text.append(heading, element("span", "finder__detail", detail(row)));
    item.append(icon, text);
    if (index === selected) item.append(element("span", "finder__hint", row.kind === "open" ? "Switch" : "Open"));
    item.addEventListener("mousemove", () => {
      if (selected === index) return;
      selected = index;
      render();
    });
    item.addEventListener("click", () => void choose(row));
    return item;
  }));
  list.hidden = rows.length === 0;
  const current = semantic?.query === normalizedQuery(query) ? semantic : null;
  empty.hidden = !(query.trim() && rows.length === 0) || current?.status === "loading";
  empty.textContent = empty.hidden
    ? ""
    : current?.status === "failed"
      ? "No tabs match. Search by meaning could not reach the provider."
      : !semanticUnavailable() && !current
        ? "No tabs match. Press Enter to search by meaning."
        : "No tabs match";
  renderStatus();
  input.setAttribute("aria-expanded", String(rows.length > 0));
  if (rows.length > 0) input.setAttribute("aria-activedescendant", `finder-row-${selected}`);
  else input.removeAttribute("aria-activedescendant");
  list.querySelector(".finder__row[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  fitWindow();
}

// The window grows with the results, like Spotlight, instead of keeping an empty panel.
let fittedHeight = 0;
function fitWindow(): void {
  if (ownWindowId === null) return;
  // Emulated or zoomed viewports can report an inner height above the outer one.
  const frame = Math.max(0, window.outerHeight - window.innerHeight);
  const height = Math.ceil(finder.getBoundingClientRect().height + frame);
  if (height === fittedHeight) return;
  fittedHeight = height;
  void chrome.windows.update(ownWindowId, { height }).catch(() => undefined);
}

async function choose(row: Row): Promise<void> {
  if (busy) return;
  busy = true;
  // Awaited first: bringing another window forward closes this one.
  await recordSearchPickInSession(input.value, row.key).catch(() => undefined);
  try {
    if (row.kind === "open") {
      const tab = await chrome.tabs.update(row.tab.id, { active: true });
      if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      const tab = await chrome.tabs.create({
        ...(targetWindowId === null ? {} : { windowId: targetWindowId }),
        url: row.tab.url,
        active: true,
      });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await close();
  } catch {
    busy = false;
    // The tab closed after the finder opened; drop it and keep searching.
    if (row.kind === "open") openTabs = openTabs.filter((tab) => tab.id !== row.tab.id);
    render();
  }
}

input.addEventListener("input", () => {
  selected = 0;
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    void close();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (rows.length === 0) return;
    event.preventDefault();
    selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    render();
    return;
  }
  if (event.key === "Enter" && !event.isComposing) {
    const row = rows[selected];
    event.preventDefault();
    if (row) {
      void choose(row);
      return;
    }
    // Nothing matched directly: Enter asks by meaning, as it does in the popup.
    maybeScheduleSemantic(input.value, false, true);
    render();
  }
});

void (async () => {
  const [current, tabs, stashes, state, storedPicks] = await Promise.all([
    chrome.windows.getCurrent(),
    captureOpenTabSnapshot(targetWindowId),
    readTabStashes().catch(() => []),
    readSearchState().catch(() => null),
    readSearchPicks().catch(() => []),
  ]);
  ownWindowId = current.id ?? null;
  openTabs = tabs;
  savedTabs = buildStashedSearchSnapshot(stashes);
  picks = storedPicks;
  includeGroupNames = state?.local.settings.includeGroupNames !== false;
  searchState = state;
  if (state?.local.settings.semanticEnabled) {
    const response = await send({ type: "semantic-index:get-state" }).catch(() => null);
    semanticMeta = response?.semanticIndexMeta ?? null;
  }
  focusInput();
  render();
})();

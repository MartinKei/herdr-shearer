import { invoke } from "@tauri-apps/api/core";
import trashIcon from "./assets/icons/trash.svg?raw";
import restoreIcon from "./assets/icons/restore.svg?raw";
import openIcon from "./assets/icons/open.svg?raw";

interface PaneNode {
  id: string;
  label: string;
}

interface TabNode {
  id: string;
  label: string;
  panes: PaneNode[];
}

interface WorkspaceNode {
  id: string;
  label: string;
  tabs: TabNode[];
}

interface CloseResult {
  kind: string;
  id: string;
  error: string | null;
}

// Explicit marks per level. A parent mark also marks all its children.
const marks = {
  workspaces: new Set<string>(),
  tabs: new Set<string>(),
  panes: new Set<string>(),
};

let tree: WorkspaceNode[] = [];
let tabFilter = "";
let selectedWorkspace: string | null = null;
const expandedTabs = new Set<string>();
interface TabDrag {
  tabId: string;
  from: number;
  startX: number;
  startY: number;
  active: boolean;
}

interface DropTarget {
  row: HTMLElement;
  gap: number;
  above: boolean;
}

let tabDrag: TabDrag | null = null;
interface RenameTarget {
  kind: "tab" | "workspace";
  id: string;
  label: string;
}

// The item that the context menu and the rename dialog act on.
let menuTarget: RenameTarget | null = null;
let renameTarget: RenameTarget | null = null;
// Set after a drag, so the click that follows does not expand the tab.
let justDragged = false;

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function findWorkspace(id: string) {
  return tree.find((workspace) => workspace.id === id);
}

function findTab(id: string) {
  for (const workspace of tree) {
    const tab = workspace.tabs.find((tab) => tab.id === id);
    if (tab) return { workspace, tab };
  }
  return undefined;
}

function findPaneTab(id: string) {
  for (const workspace of tree) {
    for (const tab of workspace.tabs) {
      if (tab.panes.some((pane) => pane.id === id)) return { workspace, tab };
    }
  }
  return undefined;
}

function setMark(set: Set<string>, id: string, marked: boolean) {
  if (marked) set.add(id);
  else set.delete(id);
}

function toggleWorkspace(workspace: WorkspaceNode) {
  const marked = !marks.workspaces.has(workspace.id);
  setMark(marks.workspaces, workspace.id, marked);
  for (const tab of workspace.tabs) {
    setMark(marks.tabs, tab.id, marked);
    for (const pane of tab.panes) setMark(marks.panes, pane.id, marked);
  }
}

function toggleTab(workspace: WorkspaceNode, tab: TabNode) {
  const marked = !marks.tabs.has(tab.id);
  setMark(marks.tabs, tab.id, marked);
  for (const pane of tab.panes) setMark(marks.panes, pane.id, marked);
  // Unmarking a tab also unmarks its workspace.
  if (!marked) setMark(marks.workspaces, workspace.id, false);
}

function togglePane(workspace: WorkspaceNode, tab: TabNode, pane: PaneNode) {
  const marked = !marks.panes.has(pane.id);
  setMark(marks.panes, pane.id, marked);
  // Unmarking a pane also unmarks its tab and workspace.
  if (!marked) {
    setMark(marks.tabs, tab.id, false);
    setMark(marks.workspaces, workspace.id, false);
  }
}

function element(tag: string, className: string, text = "") {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

// The icon strings are static files from src/assets/icons.
function iconButton(icon: string, title: string, onClick: () => void) {
  const button = element("button", "icon-button");
  button.innerHTML = icon;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function trashButton(marked: boolean, onClick: () => void) {
  return iconButton(
    marked ? restoreIcon : trashIcon,
    marked ? "Unmark" : "Mark for closing",
    onClick,
  );
}

function openButton(kind: "workspace" | "tab" | "pane", id: string) {
  return iconButton(openIcon, "Open in herdr", () => focusItem(kind, id));
}

async function focusItem(kind: string, id: string) {
  try {
    await invoke("focus_item", { kind, id });
  } catch (error) {
    $("status").textContent = `Cannot open ${kind}: ${error}`;
  }
}

function renderWorkspaces() {
  const list = $<HTMLUListElement>("workspaces");
  list.replaceChildren();
  for (const workspace of tree) {
    const marked = marks.workspaces.has(workspace.id);
    const row = element(
      "li",
      `row${workspace.id === selectedWorkspace ? " selected" : ""}${marked ? " marked" : ""}`,
    );
    row.append(
      element("span", "name", workspace.label || workspace.id),
      element("span", "count", `${workspace.tabs.length}`),
      openButton("workspace", workspace.id),
      trashButton(marked, () => {
        toggleWorkspace(workspace);
        render();
      }),
    );
    row.addEventListener("click", () => {
      selectedWorkspace = workspace.id;
      render();
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, {
        kind: "workspace",
        id: workspace.id,
        label: workspace.label,
      });
    });
    list.append(row);
  }
}

function renderTabs() {
  const list = $<HTMLUListElement>("tabs");
  list.replaceChildren();
  const workspace = selectedWorkspace ? findWorkspace(selectedWorkspace) : undefined;
  if (!workspace) return;

  const query = tabFilter.trim().toLowerCase();
  for (const [index, tab] of workspace.tabs.entries()) {
    if (query && !tab.label.toLowerCase().includes(query)) continue;
    const tabMarked = marks.tabs.has(tab.id);
    const expanded = expandedTabs.has(tab.id);
    const row = element("li", `row${tabMarked ? " marked" : ""}`);
    row.dataset.tabId = tab.id;
    row.dataset.tabIndex = String(index);
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContextMenu(event.clientX, event.clientY, { kind: "tab", id: tab.id, label: tab.label });
    });
    row.append(
      element("span", "name", `${expanded ? "▾" : "▸"} ${tab.label || tab.id}`),
      element("span", "count", `${tab.panes.length} panes`),
      openButton("tab", tab.id),
      trashButton(tabMarked, () => {
        toggleTab(workspace, tab);
        render();
      }),
    );
    row.addEventListener("click", () => {
      if (justDragged) return;
      if (expandedTabs.has(tab.id)) expandedTabs.delete(tab.id);
      else expandedTabs.add(tab.id);
      render();
    });
    list.append(row);

    if (!expanded) continue;
    for (const pane of tab.panes) {
      const paneMarked = marks.panes.has(pane.id);
      const paneRow = element(
        "li",
        `row pane-row${paneMarked ? " marked" : ""}`,
      );
      paneRow.append(
        element("span", "name", pane.label || pane.id),
        openButton("pane", pane.id),
        trashButton(paneMarked, () => {
          togglePane(workspace, tab, pane);
          render();
        }),
      );
      list.append(paneRow);
    }
  }
}

function render() {
  renderWorkspaces();
  renderTabs();
  const total = marks.workspaces.size + marks.tabs.size + marks.panes.size;
  $<HTMLButtonElement>("close-selected").disabled = total === 0;
  $("status").textContent = `${marks.panes.size} panes, ${marks.tabs.size} tabs, ${marks.workspaces.size} spaces marked`;
}

// Drop marks for items that herdr no longer lists, and keep the rest.
function pruneMarks() {
  const workspaceIds = new Set(tree.map((workspace) => workspace.id));
  const tabIds = new Set(tree.flatMap((workspace) => workspace.tabs.map((tab) => tab.id)));
  const paneIds = new Set(
    tree.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes.map((pane) => pane.id))),
  );
  for (const id of marks.workspaces) if (!workspaceIds.has(id)) marks.workspaces.delete(id);
  for (const id of marks.tabs) if (!tabIds.has(id)) marks.tabs.delete(id);
  for (const id of marks.panes) if (!paneIds.has(id)) marks.panes.delete(id);
}

async function loadTree() {
  try {
    tree = await invoke<WorkspaceNode[]>("load_tree");
    pruneMarks();
    if (!findWorkspace(selectedWorkspace ?? "")) {
      selectedWorkspace = tree[0]?.id ?? null;
    }
    render();
  } catch (error) {
    $("status").textContent = `Cannot read herdr: ${error}`;
  }
}

function describeSelection() {
  const names = (ids: Set<string>, get: (id: string) => string) =>
    [...ids].map(get).join("\n  ");
  return [
    `Spaces (${marks.workspaces.size}):\n  ${names(marks.workspaces, (id) => findWorkspace(id)?.label ?? id)}`,
    `Tabs (${marks.tabs.size}):\n  ${names(marks.tabs, (id) => findTab(id)?.tab.label ?? id)}`,
    `Panes (${marks.panes.size}):\n  ${names(marks.panes, (id) => findPaneTab(id)?.tab.panes.find((p) => p.id === id)?.label ?? id)}`,
  ].join("\n\n");
}

async function closeSelected() {
  const result = await invoke<CloseResult[]>("close_items", {
    request: {
      panes: [...marks.panes],
      tabs: [...marks.tabs],
      workspaces: [...marks.workspaces],
    },
  });

  const failed = result.filter((item) => item.error);
  marks.workspaces.clear();
  marks.tabs.clear();
  marks.panes.clear();
  await loadTree();
  $("status").textContent = failed.length
    ? `${failed.length} of ${result.length} closes failed: ${failed.map((f) => `${f.kind} ${f.id}: ${f.error}`).join("; ")}`
    : `Closed ${result.length} items`;
}

const THEME_KEY = "herdr-shearer.theme";

// Settings are per viewer. Storage can fail, so every access uses try/catch.
function loadTheme() {
  try {
    return localStorage.getItem(THEME_KEY) ?? "system";
  } catch {
    return "system";
  }
}

function saveTheme(theme: string) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Keep the choice for this session only.
  }
}

function applyTheme(theme: string) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

// Drag with mouse events. The native HTML drag does not work in the Tauri window.
function tabDropTarget(x: number, y: number): DropTarget | null {
  const element = document.elementFromPoint(x, y) as HTMLElement | null;
  const row = element?.closest<HTMLElement>("#tabs [data-tab-index]");
  if (!row) return null;
  const index = Number(row.dataset.tabIndex);
  const box = row.getBoundingClientRect();
  const above = y < box.top + box.height / 2;
  return { row, above, gap: above ? index : index + 1 };
}

function showDropMarker(target: DropTarget | null) {
  document
    .querySelectorAll(".drop-before, .drop-after")
    .forEach((el) => el.classList.remove("drop-before", "drop-after"));
  if (target) target.row.classList.add(target.above ? "drop-before" : "drop-after");
}

function openContextMenu(x: number, y: number, target: RenameTarget) {
  const menu = $<HTMLElement>("context-menu");
  menuTarget = target;
  $("menu-rename").textContent = target.kind === "tab" ? "Rename tab" : "Rename space";
  menu.hidden = false;
  // Keep the menu inside the window.
  menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
}

function hideContextMenu() {
  $("context-menu").hidden = true;
  menuTarget = null;
}

function openRenameDialog(target: RenameTarget) {
  renameTarget = target;
  $("rename-title").textContent = target.kind === "tab" ? "Rename tab" : "Rename space";
  const input = $<HTMLInputElement>("rename-input");
  input.value = target.label;
  $<HTMLDialogElement>("rename").showModal();
  input.select();
}

async function submitRename() {
  const target = renameTarget;
  const label = $<HTMLInputElement>("rename-input").value.trim();
  $<HTMLDialogElement>("rename").close();
  renameTarget = null;
  if (!target || !label || label === target.label) return;

  try {
    if (target.kind === "tab") {
      await invoke("rename_tab", { tabId: target.id, label });
    } else {
      await invoke("rename_workspace", { workspaceId: target.id, label });
    }
    await loadTree();
  } catch (error) {
    $("status").textContent = `Cannot rename ${target.kind}: ${error}`;
  }
}

function endTabDrag() {
  tabDrag = null;
  showDropMarker(null);
  document.querySelectorAll(".dragged").forEach((el) => el.classList.remove("dragged"));
  document.body.classList.remove("dragging-tab");
}

function setupTabDrag() {
  const list = $<HTMLUListElement>("tabs");

  list.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-tab-index]");
    if (!row?.dataset.tabId) return;
    tabDrag = {
      tabId: row.dataset.tabId,
      from: Number(row.dataset.tabIndex),
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  });

  window.addEventListener("pointermove", (event) => {
    if (!tabDrag) return;
    if (!tabDrag.active) {
      const distance = Math.hypot(event.clientX - tabDrag.startX, event.clientY - tabDrag.startY);
      if (distance < 5) return;
      tabDrag.active = true;
      document.body.classList.add("dragging-tab");
      list.querySelector(`[data-tab-id="${tabDrag.tabId}"]`)?.classList.add("dragged");
    }
    showDropMarker(tabDropTarget(event.clientX, event.clientY));
  });

  window.addEventListener("pointerup", async (event) => {
    const drag = tabDrag;
    if (!drag) return;
    const target = tabDrag?.active ? tabDropTarget(event.clientX, event.clientY) : null;
    endTabDrag();
    if (!drag.active) return;

    justDragged = true;
    setTimeout(() => (justDragged = false), 0);

    const workspace = findWorkspace(selectedWorkspace ?? "");
    if (!target || !workspace) return;

    // Dropping a tab next to its own place changes nothing.
    if (target.gap === drag.from || target.gap === drag.from + 1) return;

    try {
      await invoke("move_tab", { tabId: drag.tabId, insertIndex: target.gap });
      await loadTree();
    } catch (error) {
      $("status").textContent = `Cannot move tab: ${error}`;
    }
  });

  window.addEventListener("pointercancel", endTabDrag);
}

window.addEventListener("DOMContentLoaded", () => {
  const dialog = $<HTMLDialogElement>("confirm");
  setupTabDrag();
  const settings = $<HTMLDialogElement>("settings");
  const theme = $<HTMLSelectElement>("theme");

  theme.value = loadTheme();
  applyTheme(theme.value);

  $("settings-open").addEventListener("click", () => settings.showModal());
  $("settings-close").addEventListener("click", () => settings.close());
  theme.addEventListener("change", () => {
    applyTheme(theme.value);
    saveTheme(theme.value);
  });

  $("refresh").addEventListener("click", loadTree);
  $<HTMLInputElement>("tab-search").addEventListener("input", (event) => {
    tabFilter = (event.target as HTMLInputElement).value;
    renderTabs();
  });

  $("menu-rename").addEventListener("click", () => {
    const target = menuTarget;
    hideContextMenu();
    if (target) openRenameDialog(target);
  });
  $("rename-cancel").addEventListener("click", () => {
    renameTarget = null;
    $<HTMLDialogElement>("rename").close();
  });
  $("rename-ok").addEventListener("click", submitRename);
  $<HTMLInputElement>("rename-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitRename();
  });

  // Close the context menu on a click elsewhere or on Escape.
  window.addEventListener("pointerdown", (event) => {
    if (!$("context-menu").contains(event.target as Node)) hideContextMenu();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideContextMenu();
  });

  $("close-selected").addEventListener("click", () => {
    $("confirm-text").textContent = describeSelection();
    dialog.showModal();
  });

  $("confirm-cancel").addEventListener("click", () => dialog.close());

  $("confirm-ok").addEventListener("click", async () => {
    dialog.close();
    await closeSelected();
  });

  loadTree();
});

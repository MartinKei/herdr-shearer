import { invoke } from "@tauri-apps/api/core";
import trashIcon from "./assets/icons/trash.svg?raw";
import restoreIcon from "./assets/icons/restore.svg?raw";

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
let selectedWorkspace: string | null = null;
const expandedTabs = new Set<string>();

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

function trashButton(marked: boolean, onClick: () => void) {
  const button = element("button", "trash");
  // The icon strings are static files from src/assets/icons.
  button.innerHTML = marked ? restoreIcon : trashIcon;
  button.title = marked ? "Unmark" : "Mark for closing";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
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
      trashButton(marked, () => {
        toggleWorkspace(workspace);
        render();
      }),
    );
    row.addEventListener("click", () => {
      selectedWorkspace = workspace.id;
      render();
    });
    list.append(row);
  }
}

function renderTabs() {
  const list = $<HTMLUListElement>("tabs");
  list.replaceChildren();
  const workspace = selectedWorkspace ? findWorkspace(selectedWorkspace) : undefined;
  if (!workspace) return;

  for (const tab of workspace.tabs) {
    const tabMarked = marks.tabs.has(tab.id);
    const expanded = expandedTabs.has(tab.id);
    const row = element("li", `row${tabMarked ? " marked" : ""}`);
    row.append(
      element("span", "name", `${expanded ? "▾" : "▸"} ${tab.label || tab.id}`),
      element("span", "count", `${tab.panes.length} panes`),
      trashButton(tabMarked, () => {
        toggleTab(workspace, tab);
        render();
      }),
    );
    row.addEventListener("click", () => {
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

window.addEventListener("DOMContentLoaded", () => {
  const dialog = $<HTMLDialogElement>("confirm");
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

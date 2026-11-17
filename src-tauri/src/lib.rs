use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

#[derive(Serialize)]
pub struct PaneNode {
    id: String,
    label: String,
}

#[derive(Serialize)]
pub struct TabNode {
    id: String,
    label: String,
    panes: Vec<PaneNode>,
}

#[derive(Serialize)]
pub struct WorkspaceNode {
    id: String,
    label: String,
    tabs: Vec<TabNode>,
}

#[derive(Deserialize)]
pub struct CloseRequest {
    panes: Vec<String>,
    tabs: Vec<String>,
    workspaces: Vec<String>,
}

#[derive(Serialize)]
pub struct CloseResult {
    kind: String,
    id: String,
    error: Option<String>,
}

/// Run a herdr CLI command and return its parsed JSON result object.
fn herdr(args: &[&str]) -> Result<Value, String> {
    let mut command = Command::new("herdr");
    // A macOS app started from Finder does not inherit the shell PATH.
    let path = std::env::var("PATH").unwrap_or_default();
    command.env("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    let output = command
        .args(args)
        .output()
        .map_err(|e| format!("cannot start herdr: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("invalid herdr output: {e}"))?;
    Ok(json["result"].clone())
}

/// Read a string field, or an empty string when the field is missing.
fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}

/// Use the terminal title, or the last part of the working directory, as pane label.
fn pane_label(pane: &Value) -> String {
    let title = text(pane, "terminal_title_stripped");
    if !title.is_empty() {
        return title;
    }
    Path::new(&text(pane, "cwd"))
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn load_tree() -> Result<Vec<WorkspaceNode>, String> {
    let list = herdr(&["workspace", "list"])?;
    let mut workspaces = Vec::new();

    for workspace in list["workspaces"].as_array().into_iter().flatten() {
        let workspace_id = text(workspace, "workspace_id");
        let tabs_result = herdr(&["tab", "list", "--workspace", &workspace_id])?;
        let panes_result = herdr(&["pane", "list", "--workspace", &workspace_id])?;

        let mut tabs = Vec::new();
        for tab in tabs_result["tabs"].as_array().into_iter().flatten() {
            let tab_id = text(tab, "tab_id");
            let panes = panes_result["panes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|pane| text(pane, "tab_id") == tab_id)
                .map(|pane| PaneNode {
                    id: text(pane, "pane_id"),
                    label: pane_label(pane),
                })
                .collect();
            tabs.push(TabNode {
                id: tab_id,
                label: text(tab, "label"),
                panes,
            });
        }

        workspaces.push(WorkspaceNode {
            id: workspace_id,
            label: text(workspace, "label"),
            tabs,
        });
    }

    Ok(workspaces)
}

/// Close panes first, then tabs, then workspaces. Keep going after an error.
/// Closing the last pane closes its tab, and closing the last tab closes its
/// workspace. A `*_not_found` error means herdr already closed the item.
#[tauri::command]
fn close_items(request: CloseRequest) -> Vec<CloseResult> {
    let mut results = Vec::new();
    let steps = [
        ("pane", request.panes),
        ("tab", request.tabs),
        ("workspace", request.workspaces),
    ];

    for (kind, ids) in steps {
        for id in ids {
            let error = herdr(&[kind, "close", &id])
                .err()
                .filter(|message| !message.contains("_not_found"));
            results.push(CloseResult {
                kind: kind.to_string(),
                id,
                error,
            });
        }
    }

    results
}

#[tauri::command]
fn rename_tab(tab_id: String, label: String) -> Result<(), String> {
    herdr(&["tab", "rename", &tab_id, &label]).map(|_| ())
}

#[tauri::command]
fn rename_workspace(workspace_id: String, label: String) -> Result<(), String> {
    herdr(&["workspace", "rename", &workspace_id, &label]).map(|_| ())
}

/// Send one request to the socket API and return its result.
fn socket_request(method: &str, params: Value) -> Result<Value, String> {
    let home = std::env::var("HOME").map_err(|e| format!("cannot read HOME: {e}"))?;
    let socket = format!("{home}/.config/herdr/herdr.sock");
    let mut stream =
        UnixStream::connect(&socket).map_err(|e| format!("cannot connect to herdr: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;

    let request = json!({ "id": method, "method": method, "params": params });
    writeln!(stream, "{request}").map_err(|e| format!("cannot send to herdr: {e}"))?;

    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|e| format!("cannot read from herdr: {e}"))?;
    let reply: Value =
        serde_json::from_str(&line).map_err(|e| format!("invalid herdr reply: {e}"))?;
    match reply.get("error") {
        Some(error) => Err(error.to_string()),
        None => Ok(reply["result"].clone()),
    }
}

/// Move a tab to a new position. `insert_index` is the gap in the current tab
/// list, before the tab at that index. The CLI has no move command.
#[tauri::command]
fn move_tab(tab_id: String, insert_index: u32) -> Result<(), String> {
    socket_request(
        "tab.move",
        json!({ "tab_id": tab_id, "insert_index": insert_index }),
    )
    .map(|_| ())
}

/// Focus a space, tab or pane in herdr.
#[tauri::command]
fn focus_item(kind: String, id: String) -> Result<(), String> {
    let (method, params) = match kind.as_str() {
        "workspace" => ("workspace.focus", json!({ "workspace_id": id })),
        "tab" => ("tab.focus", json!({ "tab_id": id })),
        "pane" => ("pane.focus", json!({ "pane_id": id })),
        _ => return Err(format!("unknown kind {kind}")),
    };
    socket_request(method, params).map(|_| ())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_tree,
            close_items,
            move_tab,
            rename_tab,
            rename_workspace,
            focus_item
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

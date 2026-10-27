// PlanLab desktop shell. Patient data lives as files under the app-data folder ("store/…"), written and read through
// these commands with raw binary bodies so large CT volumes don't go through JSON.
use std::fs;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

fn store_root(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("store");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

/// Keys are relative paths like "p/<id>/ct/<id>.bin": only safe characters, no "..", no absolute paths.
fn key_path(root: &Path, key: &str) -> Result<PathBuf, String> {
  let ok = !key.is_empty()
    && !key.starts_with('/')
    && key.chars().all(|c| c.is_ascii_alphanumeric() || "_-./".contains(c))
    && !key.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..");
  if !ok {
    return Err(format!("invalid key: {key}"));
  }
  Ok(root.join(key))
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
  request
    .headers()
    .get(name)
    .and_then(|v| v.to_str().ok())
    .ok_or_else(|| format!("missing {name} header"))
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let tmp = path.with_extension("tmp-write");
  fs::write(&tmp, data).map_err(|e| e.to_string())?;
  fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
fn kv_put(app: AppHandle, request: Request<'_>) -> Result<(), String> {
  let key = header(&request, "x-key")?;
  let InvokeBody::Raw(data) = request.body() else {
    return Err("expected binary data".into());
  };
  write_atomic(&key_path(&store_root(&app)?, key)?, data)
}

#[tauri::command]
fn kv_get(app: AppHandle, key: String) -> Result<Response, String> {
  let path = key_path(&store_root(&app)?, &key)?;
  match fs::read(&path) {
    Ok(bytes) => Ok(Response::new(bytes)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Response::new(Vec::<u8>::new())),
    Err(e) => Err(e.to_string()),
  }
}

/// All stored keys (relative paths with '/' separators).
fn all_keys(root: &Path) -> Vec<String> {
  let mut out = Vec::new();
  let mut stack = vec![root.to_path_buf()];
  while let Some(dir) = stack.pop() {
    let Ok(entries) = fs::read_dir(&dir) else { continue };
    for entry in entries.flatten() {
      let path = entry.path();
      if path.is_dir() {
        stack.push(path);
      } else if let Ok(rel) = path.strip_prefix(root) {
        let key = rel
          .components()
          .map(|c| c.as_os_str().to_string_lossy().into_owned())
          .collect::<Vec<_>>()
          .join("/");
        if !key.ends_with(".tmp-write") {
          out.push(key);
        }
      }
    }
  }
  out
}

#[tauri::command]
fn kv_list(app: AppHandle, prefix: String) -> Result<Vec<String>, String> {
  let root = store_root(&app)?;
  Ok(all_keys(&root).into_iter().filter(|k| k.starts_with(&prefix)).collect())
}

#[tauri::command]
fn kv_remove(app: AppHandle, prefix: String) -> Result<(), String> {
  if prefix.is_empty() {
    return Err("refusing to remove everything".into());
  }
  let root = store_root(&app)?;
  for key in all_keys(&root).into_iter().filter(|k| k.starts_with(&prefix)) {
    let _ = fs::remove_file(root.join(&key));
  }
  // Tidy up the empty folder left behind by a deleted patient
  if let Some(dir) = prefix.strip_suffix('/') {
    if let Ok(path) = key_path(&root, dir) {
      let _ = fs::remove_dir_all(path);
    }
  }
  Ok(())
}

fn percent_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
        out.push(v);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

/// Writes an exported file (DICOM, patient package) to the path the user chose in the Save dialog.
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
  let path = percent_decode(header(&request, "x-path")?);
  let InvokeBody::Raw(data) = request.body() else {
    return Err("expected binary data".into());
  };
  fs::write(&path, data).map_err(|e| format!("Could not save {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
      }
    }))
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![kv_put, kv_get, kv_list, kv_remove, write_file])
    .run(tauri::generate_context!())
    .expect("error while running PlanLab");
}

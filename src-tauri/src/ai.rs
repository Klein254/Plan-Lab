// AI auto-contouring through TotalSegmentator (a published deep-learning model for 117 CT structures, Apache-2.0).
// It runs locally in a private Python environment under the app-data folder ("ai/"): installed once from PlanLab,
// then used offline. The CT goes in as NIfTI, the labels come back as one byte per voxel in the same voxel order.
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};

const SEG_SCRIPT: &str = include_str!("planlab_seg.py");
const PACKAGE: &str = "TotalSegmentator";

#[derive(Default)]
pub struct AiState {
  child: Mutex<Option<Arc<Mutex<Child>>>>,
  cancelled: Mutex<bool>,
}

fn ai_root(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("ai");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn venv_python(root: &Path) -> PathBuf {
  if cfg!(windows) { root.join("venv").join("Scripts").join("python.exe") } else { root.join("venv").join("bin").join("python") }
}

fn hide_window(cmd: &mut Command) -> &mut Command {
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
  }
  cmd
}

/// A Python 3.10–3.13 interpreter (newest first), as (program, leading args, version text).
fn find_python() -> Option<(String, Vec<String>, String)> {
  let mut candidates: Vec<(String, Vec<String>)> = Vec::new();
  if cfg!(windows) {
    for v in ["3.12", "3.11", "3.13", "3.10"] {
      candidates.push(("py".into(), vec![format!("-{v}")]));
    }
    candidates.push(("python".into(), vec![]));
    candidates.push(("python3".into(), vec![]));
  } else {
    // Apps started from Finder get a minimal PATH, so look in the usual install places too
    let dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/Library/Frameworks/Python.framework/Versions/3.12/bin", "/Library/Frameworks/Python.framework/Versions/3.11/bin", "/Library/Frameworks/Python.framework/Versions/3.13/bin", "/Library/Frameworks/Python.framework/Versions/3.10/bin"];
    for name in ["python3.12", "python3.11", "python3.13", "python3.10", "python3"] {
      candidates.push((name.into(), vec![]));
      for d in dirs {
        candidates.push((format!("{d}/{name}"), vec![]));
      }
    }
  }
  for (prog, args) in candidates {
    let mut cmd = Command::new(&prog);
    cmd.args(&args).args(["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"]);
    let Ok(out) = hide_window(&mut cmd).output() else { continue };
    if !out.status.success() {
      continue;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let parts: Vec<u32> = text.split_whitespace().filter_map(|x| x.parse().ok()).collect();
    if parts.len() == 2 && parts[0] == 3 && (10..=13).contains(&parts[1]) {
      return Some((prog, args, format!("{}.{}", parts[0], parts[1])));
    }
  }
  None
}

/// A finished model folder ("Dataset297_…"); a half-done download only leaves a temporary zip behind.
fn weights_present(root: &Path) -> bool {
  let dir = root.join("weights").join("nnunet").join("results");
  fs::read_dir(&dir)
    .map(|d| d.flatten().any(|e| e.path().is_dir() && e.file_name().to_string_lossy().starts_with("Dataset297")))
    .unwrap_or(false)
}

#[derive(serde::Serialize)]
pub struct AiStatus {
  installed: bool,
  weights: bool,
  python: Option<String>,
  folder: String,
}

#[tauri::command]
pub fn ai_status(app: AppHandle) -> Result<AiStatus, String> {
  let root = ai_root(&app)?;
  let installed = venv_python(&root).exists() && root.join("installed.json").exists();
  Ok(AiStatus {
    installed,
    weights: weights_present(&root),
    python: if installed { None } else { find_python().map(|(_, _, v)| v) },
    folder: root.to_string_lossy().into_owned(),
  })
}

/// Runs a command, streaming its output lines to the UI ("ai-log"), and fails on a non-zero exit.
fn run_logged(app: &AppHandle, state: &AiState, root: &Path, mut cmd: Command) -> Result<(), String> {
  cmd.env("TOTALSEG_HOME_DIR", root.join("weights"))
    .env("PYTHONUNBUFFERED", "1")
    .env("PYTHONIOENCODING", "utf-8")
    .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .stdin(Stdio::null());
  let mut child = hide_window(&mut cmd).spawn().map_err(|e| format!("Could not start {:?}: {e}", cmd.get_program()))?;
  let out = child.stdout.take().unwrap();
  let err = child.stderr.take().unwrap();
  let child = Arc::new(Mutex::new(child));
  *state.child.lock().unwrap() = Some(child.clone());
  let pump = |r: Box<dyn std::io::Read + Send>, app: AppHandle| {
    std::thread::spawn(move || {
      // Progress bars rewrite the same line with \r, so split on both
      let mut buf = Vec::new();
      let mut reader = BufReader::new(r);
      loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
          Ok(0) | Err(_) => break,
          Ok(_) => {
            let text = String::from_utf8_lossy(&buf);
            for part in text.split('\r') {
              let line = part.trim();
              if !line.is_empty() {
                let _ = app.emit("ai-log", line.to_string());
              }
            }
          }
        }
      }
    })
  };
  let t1 = pump(Box::new(out), app.clone());
  let t2 = pump(Box::new(err), app.clone());
  let status = loop {
    if let Some(st) = child.lock().unwrap().try_wait().map_err(|e| e.to_string())? {
      break st;
    }
    std::thread::sleep(std::time::Duration::from_millis(200));
  };
  let _ = t1.join();
  let _ = t2.join();
  *state.child.lock().unwrap() = None;
  if *state.cancelled.lock().unwrap() {
    return Err("Cancelled.".into());
  }
  if !status.success() {
    return Err(format!("{:?} failed ({status})", cmd.get_program()));
  }
  Ok(())
}

#[tauri::command]
pub async fn ai_install(app: AppHandle, state: State<'_, AiState>) -> Result<(), String> {
  let root = ai_root(&app)?;
  *state.cancelled.lock().unwrap() = false;
  let state: &AiState = &state;
  let log = |s: &str| { let _ = app.emit("ai-log", s.to_string()); };
  let py = venv_python(&root);
  if !py.exists() {
    let Some((prog, args, ver)) = find_python() else {
      return Err("Python 3.10–3.13 was not found. Install Python 3.12 from python.org (tick \"Add python.exe to PATH\" on Windows), then try again.".into());
    };
    log(&format!("Using Python {ver} to create PlanLab's AI environment…"));
    let mut cmd = Command::new(prog);
    cmd.args(args).args(["-m", "venv"]).arg(root.join("venv"));
    run_logged(&app, state, &root, cmd)?;
  }
  log("Updating pip…");
  let mut cmd = Command::new(&py);
  cmd.args(["-m", "pip", "install", "--upgrade", "pip"]);
  run_logged(&app, state, &root, cmd)?;
  log("Installing TotalSegmentator and PyTorch (about 1 GB; this can take a while)…");
  let mut cmd = Command::new(&py);
  cmd.args(["-m", "pip", "install", "--upgrade", PACKAGE]);
  run_logged(&app, state, &root, cmd)?;
  log("Downloading the model weights…");
  fs::write(root.join("planlab_seg.py"), SEG_SCRIPT).map_err(|e| e.to_string())?;
  let mut cmd = Command::new(&py);
  cmd.arg(root.join("planlab_seg.py")).arg("--download");
  run_logged(&app, state, &root, cmd)?;
  fs::write(root.join("installed.json"), format!("{{\"package\":\"{PACKAGE}\"}}")).map_err(|e| e.to_string())?;
  log("AI contouring is ready.");
  Ok(())
}

/// Body: the CT as NIfTI. Header x-options: JSON {"fast": bool, "roi": [names]}. Returns [u32 json length][labels.json][labels].
#[tauri::command]
pub async fn ai_segment(app: AppHandle, state: State<'_, AiState>, request: Request<'_>) -> Result<Response, String> {
  let root = ai_root(&app)?;
  let py = venv_python(&root);
  if !py.exists() || !root.join("installed.json").exists() {
    return Err("AI contouring isn't installed yet.".into());
  }
  *state.cancelled.lock().unwrap() = false;
  let options = request.headers().get("x-options").and_then(|v| v.to_str().ok()).unwrap_or("{}").to_string();
  let InvokeBody::Raw(nifti) = request.body() else { return Err("expected the CT as binary data".into()) };
  let work = root.join("work");
  let _ = fs::remove_dir_all(&work);
  fs::create_dir_all(&work).map_err(|e| e.to_string())?;
  fs::write(work.join("ct.nii"), nifti).map_err(|e| e.to_string())?;
  fs::write(root.join("planlab_seg.py"), SEG_SCRIPT).map_err(|e| e.to_string())?;
  let mut cmd = Command::new(&py);
  cmd.arg(root.join("planlab_seg.py")).arg(work.join("ct.nii")).arg(&work).arg(&options);
  run_logged(&app, &state, &root, cmd)?;
  let json = fs::read(work.join("labels.json")).map_err(|e| format!("No result: {e}"))?;
  let labels = fs::read(work.join("labels.bin")).map_err(|e| format!("No result: {e}"))?;
  let _ = fs::remove_dir_all(&work);
  let mut out = Vec::with_capacity(4 + json.len() + labels.len());
  out.extend_from_slice(&(json.len() as u32).to_le_bytes());
  out.extend_from_slice(&json);
  out.extend_from_slice(&labels);
  Ok(Response::new(out))
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>) {
  *state.cancelled.lock().unwrap() = true;
  if let Some(child) = state.child.lock().unwrap().as_ref() {
    let mut c = child.lock().unwrap();
    #[cfg(windows)]
    {
      // Kill the whole process tree (pip / nnU-Net start helpers)
      let mut k = Command::new("taskkill");
      k.args(["/T", "/F", "/PID", &c.id().to_string()]);
      let _ = hide_window(&mut k).output();
    }
    let _ = c.kill();
  }
}

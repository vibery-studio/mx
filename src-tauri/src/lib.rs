use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

static INITIAL_FILE: Mutex<Option<String>> = Mutex::new(None);

#[derive(Serialize, Deserialize)]
struct FileInfo {
    path: String,
    content: String,
    size: u64,
}

#[derive(Serialize, Deserialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    extension: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct WordCount {
    chars: usize,
    words: usize,
    lines: usize,
}

#[tauri::command]
fn read_file(path: String) -> Result<FileInfo, String> {
    let p = PathBuf::from(&path);
    let content = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let metadata = fs::metadata(&p).map_err(|e| e.to_string())?;
    Ok(FileInfo {
        path,
        content,
        size: metadata.len(),
    })
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
fn word_count(text: String) -> WordCount {
    WordCount {
        chars: text.len(),
        words: text.split_whitespace().count(),
        lines: text.lines().count(),
    }
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let p = PathBuf::from(&path);
    let entries = fs::read_dir(&p).map_err(|e| e.to_string())?;
    let mut result: Vec<DirEntry> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let is_dir = metadata.is_dir();
            let extension = if is_dir {
                None
            } else {
                entry.path().extension().map(|e| e.to_string_lossy().to_string())
            };
            Some(DirEntry {
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
                extension,
            })
        })
        .collect();
    result.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(result)
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|e| e.to_string())
}

#[tauri::command]
fn get_initial_file() -> Option<String> {
    INITIAL_FILE.lock().unwrap().take()
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err("File already exists".to_string());
    }
    fs::write(&p, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err("Directory already exists".to_string());
    }
    fs::create_dir(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_entry(old_path: String, new_path: String) -> Result<(), String> {
    let np = PathBuf::from(&new_path);
    if np.exists() {
        return Err("Target already exists".to_string());
    }
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_files_recursive(path: String, max_depth: u32) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&path);
    let mut results = Vec::new();
    let ignore = ["node_modules", ".git", "target", ".DS_Store", "__pycache__"];
    fn walk(dir: &Path, depth: u32, max_depth: u32, results: &mut Vec<String>, ignore: &[&str]) {
        if depth > max_depth { return; }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || ignore.contains(&name.as_str()) { continue; }
            let path = entry.path();
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    walk(&path, depth + 1, max_depth, results, ignore);
                } else {
                    results.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    walk(&root, 0, max_depth, &mut results, &ignore);
    results.sort();
    Ok(results)
}

#[derive(Serialize, Deserialize)]
struct RecoveryInfo {
    original_path: String,
    recovery_path: String,
    timestamp: u64,
}

fn get_recovery_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(home).join(".mx").join("recovery");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn path_to_recovery_name(path: &str) -> String {
    path.replace('/', "_").replace('\\', "_").replace(' ', "-")
}

#[tauri::command]
fn save_recovery(original_path: String, content: String) -> Result<(), String> {
    let dir = get_recovery_dir()?;
    let name = path_to_recovery_name(&original_path);
    let meta = format!("---mx-recovery---\n{}\n---\n", original_path);
    fs::write(dir.join(&name), format!("{}{}", meta, content)).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_recovery_files() -> Result<Vec<RecoveryInfo>, String> {
    let dir = get_recovery_dir()?;
    let mut results = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if let Ok(content) = fs::read_to_string(&path) {
            if let Some(rest) = content.strip_prefix("---mx-recovery---\n") {
                if let Some(idx) = rest.find("\n---\n") {
                    let original = rest[..idx].to_string();
                    let ts = entry.metadata().ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    results.push(RecoveryInfo {
                        original_path: original,
                        recovery_path: path.to_string_lossy().to_string(),
                        timestamp: ts,
                    });
                }
            }
        }
    }
    Ok(results)
}

#[tauri::command]
fn read_recovery_content(recovery_path: String) -> Result<String, String> {
    let content = fs::read_to_string(&recovery_path).map_err(|e| e.to_string())?;
    if let Some(rest) = content.strip_prefix("---mx-recovery---\n") {
        if let Some(idx) = rest.find("\n---\n") {
            return Ok(rest[idx + 5..].to_string());
        }
    }
    Err("Invalid recovery file".to_string())
}

#[tauri::command]
fn delete_recovery(recovery_path: String) -> Result<(), String> {
    let _ = fs::remove_file(&recovery_path);
    Ok(())
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

#[tauri::command]
fn export_pdf(markdown_content: String, output_path: String) -> Result<String, String> {
    use std::process::Command;
    use std::io::Write;

    let tmp_dir = std::env::temp_dir().join("mx_export");
    let _ = fs::create_dir_all(&tmp_dir);
    let tmp_md = tmp_dir.join("export.md");
    let path_env = "/Library/TeX/texbin:/opt/anaconda3/bin:/usr/local/bin:/usr/bin:/bin";

    // Step 1: Extract mermaid blocks, render to PNG via mermaid.ink API, replace in markdown
    let mut processed = String::new();
    let mut mermaid_idx = 0u32;
    let mut in_mermaid = false;
    let mut mermaid_buf = String::new();
    let mut in_code = false;
    let mut code_lang = String::new();

    for line in markdown_content.lines() {
        if line.starts_with("```") && !in_code {
            in_code = true;
            code_lang = line.trim_start_matches('`').trim().to_string();
            if code_lang == "mermaid" {
                in_mermaid = true;
                mermaid_buf.clear();
                continue;
            }
            processed.push_str(line);
            processed.push('\n');
        } else if line.starts_with("```") && in_code {
            in_code = false;
            if in_mermaid {
                // Download PNG from mermaid.ink
                let png_file = tmp_dir.join(format!("diagram_{}.png", mermaid_idx));
                let encoded = base64_encode(mermaid_buf.trim().as_bytes());
                let url = format!("https://mermaid.ink/img/{}?type=png&bgColor=white", encoded);

                let download = Command::new("curl")
                    .args(["-sL", "-o", png_file.to_str().unwrap(), &url])
                    .env("PATH", path_env)
                    .output();

                if let Ok(r) = download {
                    if r.status.success() && png_file.exists() && fs::metadata(&png_file).map(|m| m.len() > 100).unwrap_or(false) {
                        processed.push_str(&format!(
                            "![diagram]({})\n",
                            png_file.to_string_lossy()
                        ));
                    } else {
                        processed.push_str("```\n");
                        processed.push_str(&mermaid_buf);
                        processed.push_str("```\n");
                    }
                } else {
                    processed.push_str("```\n");
                    processed.push_str(&mermaid_buf);
                    processed.push_str("```\n");
                }

                in_mermaid = false;
                mermaid_idx += 1;
            } else {
                processed.push_str(line);
                processed.push('\n');
            }
            code_lang.clear();
        } else if in_mermaid {
            mermaid_buf.push_str(line);
            mermaid_buf.push('\n');
        } else {
            processed.push_str(line);
            processed.push('\n');
        }
    }

    // Step 2: Write processed markdown
    let mut f = fs::File::create(&tmp_md).map_err(|e| e.to_string())?;
    f.write_all(processed.as_bytes()).map_err(|e| e.to_string())?;

    // Step 3: Run pandoc
    let engines = ["xelatex", "pdflatex"];
    let mut last_err = String::new();

    for engine in engines {
        let mut args = vec![
            tmp_md.to_str().unwrap(),
            "-o", &output_path,
            "--pdf-engine", engine,
            "-V", "geometry:margin=1in",
            "-V", "fontsize=11pt",
            "-V", "colorlinks=true",
            "--no-highlight",
        ];
        if engine == "xelatex" {
            args.extend_from_slice(&["-V", "mainfont:Helvetica", "-V", "monofont:Menlo"]);
        }

        let result = Command::new("pandoc")
            .args(&args)
            .env("PATH", path_env)
            .output()
            .map_err(|e| format!("Failed to run pandoc: {}", e))?;

        if result.status.success() {
            // Clean up
            let _ = fs::remove_dir_all(&tmp_dir);
            return Ok(output_path);
        }
        last_err = String::from_utf8_lossy(&result.stderr).to_string();
    }

    let _ = fs::remove_dir_all(&tmp_dir);
    Err(format!("pandoc failed: {}", last_err))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![read_file, save_file, word_count, list_directory, get_home_dir, get_initial_file, export_pdf, create_file, create_directory, delete_entry, rename_entry, list_files_recursive, save_recovery, get_recovery_files, read_recovery_content, delete_recovery])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                let files: Vec<String> = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                if let Some(path) = files.first() {
                    *INITIAL_FILE.lock().unwrap() = Some(path.clone());
                    let _ = _app.emit("open-file", path.clone());
                }
            }
        });
}

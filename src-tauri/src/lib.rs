use std::fs;
use std::path::PathBuf;
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
        .invoke_handler(tauri::generate_handler![read_file, save_file, word_count, list_directory, get_home_dir, get_initial_file, export_pdf])
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

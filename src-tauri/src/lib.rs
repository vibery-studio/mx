use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use notify::{Watcher, RecommendedWatcher, RecursiveMode, Event, EventKind};
use wait_timeout::ChildExt;

static INITIAL_FILE: Mutex<Option<String>> = Mutex::new(None);
static FILE_WATCHERS: Mutex<Option<HashMap<String, RecommendedWatcher>>> = Mutex::new(None);
static FOLDER_WATCHERS: Mutex<Option<HashMap<String, RecommendedWatcher>>> = Mutex::new(None);

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
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| e.to_string())
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
struct SearchResult {
    file_path: String,
    line_number: usize,
    line_content: String,
    match_start: usize,
    match_end: usize,
}

#[tauri::command]
fn search_in_files(folder_path: String, query: String) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let root = PathBuf::from(&folder_path);
    let ignore = ["node_modules", ".git", "target", ".DS_Store", "__pycache__"];
    let extensions = ["md", "markdown", "txt"];
    let query_lower = query.to_lowercase();
    let max_results = 200usize;
    let max_file_size = 1_048_576u64;

    let mut files: Vec<PathBuf> = Vec::new();
    fn walk(dir: &Path, depth: u32, files: &mut Vec<PathBuf>, ignore: &[&str], extensions: &[&str], max_size: u64) {
        if depth > 5 { return; }
        let entries = match fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || ignore.contains(&name.as_str()) { continue; }
            let path = entry.path();
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    walk(&path, depth + 1, files, ignore, extensions, max_size);
                } else if meta.len() <= max_size {
                    if let Some(ext) = path.extension() {
                        if extensions.contains(&ext.to_string_lossy().as_ref()) {
                            files.push(path);
                        }
                    }
                }
            }
        }
    }
    walk(&root, 0, &mut files, &ignore, &extensions, max_file_size);

    let mut results: Vec<SearchResult> = Vec::new();
    for file_path in files {
        if results.len() >= max_results { break; }
        let content = match fs::read_to_string(&file_path) { Ok(c) => c, Err(_) => continue };
        let path_str = file_path.to_string_lossy().to_string();
        for (i, line) in content.lines().enumerate() {
            if results.len() >= max_results { break; }
            let line_lower = line.to_lowercase();
            if let Some(byte_pos) = line_lower.find(&query_lower) {
                // Convert byte offsets to char offsets for JavaScript compatibility
                let char_start = line_lower[..byte_pos].chars().count();
                let char_end = char_start + query_lower.chars().count();
                results.push(SearchResult {
                    file_path: path_str.clone(),
                    line_number: i + 1,
                    line_content: line.to_string(),
                    match_start: char_start,
                    match_end: char_end,
                });
            }
        }
    }
    Ok(results)
}

#[derive(Serialize, Deserialize)]
struct RecoveryInfo {
    original_path: String,
    recovery_path: String,
    timestamp: u64,
}

fn get_recovery_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| e.to_string())?;
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

fn base64url_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
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
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        }
    }
    result
}

#[tauri::command]
async fn export_pdf(markdown_content: String, output_path: String, app: tauri::AppHandle) -> Result<String, String> {
    use std::io::Write;

    // Run all blocking work on a separate thread to avoid blocking async runtime
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = export_pdf_blocking(markdown_content, output_path, app);
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| format!("Thread error: {}", e))?
}

fn export_pdf_blocking(markdown_content: String, output_path: String, app: tauri::AppHandle) -> Result<String, String> {
    use std::process::Command;
    use std::io::Write;

    let _ = app.emit("pdf-progress", "Preparing markdown…");

    // Replace emoji/symbols that fonts can't render with text equivalents
    let markdown_content = markdown_content
        .replace("❌", "[X]")
        .replace("✅", "[v]")
        .replace("✓", "[v]")
        .replace("⚠️", "[!]")
        .replace("📁", "[dir]")
        .replace('→', "->")
        .replace('←', "<-")
        .replace('↓', "v");

    let tmp_dir = std::env::temp_dir().join("mx_export");
    let _ = fs::create_dir_all(&tmp_dir);
    let tmp_md = tmp_dir.join("export.md");

    // Build PATH: inherit system PATH and append known TeX locations
    let sys_path = std::env::var("PATH").unwrap_or_default();
    let path_env = if cfg!(target_os = "windows") {
        // Windows: append common MiKTeX/TeX Live paths
        format!("{};C:\\Program Files\\MiKTeX\\miktex\\bin\\x64;C:\\texlive\\2024\\bin\\windows;C:\\texlive\\2025\\bin\\windows", sys_path)
    } else {
        format!("{}:/Library/TeX/texbin:/opt/anaconda3/bin:/usr/local/bin:/usr/bin:/bin", sys_path)
    };

    // Step 1: Extract mermaid blocks, render to PNG via mermaid.ink API
    let mut processed = String::new();
    let mut mermaid_idx = 0u32;
    let mut in_mermaid = false;
    let mut mermaid_buf = String::new();
    let mut in_code = false;
    let mut code_lang = String::new();

    // Count mermaid blocks for progress
    let mermaid_total = markdown_content.lines()
        .filter(|l| l.trim() == "```mermaid")
        .count();

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
                let _ = app.emit("pdf-progress", format!("Rendering diagram {}/{}…", mermaid_idx + 1, mermaid_total));

                let png_file = tmp_dir.join(format!("diagram_{}.jpg", mermaid_idx));
                let encoded = base64url_encode(mermaid_buf.trim().as_bytes());
                let url = format!("https://mermaid.ink/img/{}", encoded);

                let download = Command::new("curl")
                    .args(["-sL", "--max-time", "30", "-o", png_file.to_str().unwrap(), &url])
                    .env("PATH", &path_env)
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

    // Step 3: Write LaTeX header for Latin Modern fonts (science paper look)
    // Latin Modern = OpenType version of Computer Modern (default LaTeX font)
    // Falls back to Times New Roman if Latin Modern is not installed
    let lm_header = tmp_dir.join("fonts.tex");
    let lm_font_dirs: &[&str] = if cfg!(target_os = "windows") {
        &[
            "C:/texlive/2025/texmf-dist/fonts/opentype/public/lm/",
            "C:/texlive/2024/texmf-dist/fonts/opentype/public/lm/",
        ]
    } else {
        &[
            "/usr/local/texlive/2025basic/texmf-dist/fonts/opentype/public/lm/",
            "/usr/local/texlive/2025/texmf-dist/fonts/opentype/public/lm/",
            "/usr/local/texlive/2024/texmf-dist/fonts/opentype/public/lm/",
        ]
    };
    let lm_font_dir = lm_font_dirs.iter()
        .find(|d| Path::new(d).join("lmroman10-regular.otf").exists())
        .copied();
    let use_latin_modern = lm_font_dir.is_some();
    if let Some(dir) = lm_font_dir {
        let header = format!(
            "\\setmainfont[Path={dir},BoldFont=lmroman10-bold.otf,ItalicFont=lmroman10-italic.otf,BoldItalicFont=lmroman10-bolditalic.otf]{{lmroman10-regular.otf}}\n\\setmonofont[Path={dir}]{{lmmono10-regular.otf}}\n",
            dir = dir
        );
        let _ = fs::write(&lm_header, header);
    }

    // Step 4: Run pandoc — prefer xelatex for full Unicode/Vietnamese support
    let engines = ["xelatex", "pdflatex"];
    let mut last_err = String::new();

    for engine in engines {
        let _ = app.emit("pdf-progress", format!("Running pandoc ({})…", engine));

        let mut args = vec![
            tmp_md.to_str().unwrap().to_string(),
            "-o".to_string(), output_path.clone(),
            "--pdf-engine".to_string(), engine.to_string(),
            "-V".to_string(), "geometry:margin=1in".to_string(),
            "-V".to_string(), "fontsize=11pt".to_string(),
            "-V".to_string(), "colorlinks=true".to_string(),
            "--no-highlight".to_string(),
            "--pdf-engine-opt=-interaction=nonstopmode".to_string(),
        ];
        if engine == "xelatex" {
            if use_latin_modern {
                // Use Latin Modern via header include (Computer Modern look)
                args.push("-H".to_string());
                args.push(lm_header.to_str().unwrap().to_string());
            } else {
                // Fallback: Times New Roman + platform-appropriate mono font
                args.extend_from_slice(&[
                    "-V".to_string(), "mainfont:Times New Roman".to_string(),
                ]);
                if cfg!(target_os = "macos") {
                    args.extend_from_slice(&[
                        "-V".to_string(), "monofont:.SF NS Mono".to_string(),
                    ]);
                } else {
                    args.extend_from_slice(&[
                        "-V".to_string(), "monofont:Consolas".to_string(),
                    ]);
                }
            }
        }

        let stderr_file = tmp_dir.join("pandoc_stderr.log");
        let stderr_out = fs::File::create(&stderr_file).map_err(|e| e.to_string())?;

        let mut child = Command::new("pandoc")
            .args(&args)
            .env("PATH", &path_env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::from(stderr_out))
            .spawn()
            .map_err(|e| format!("Pandoc not found. Install pandoc from pandoc.org. ({})", e))?;

        let timeout = std::time::Duration::from_secs(120);
        match child.wait_timeout(timeout) {
            Ok(Some(status)) if status.success() => {
                let _ = fs::remove_dir_all(&tmp_dir);
                return Ok(output_path);
            }
            Ok(Some(_)) => {
                last_err = fs::read_to_string(&stderr_file).unwrap_or_default();
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                last_err = format!("pandoc timed out after {}s with engine {}", timeout.as_secs(), engine);
            }
            Err(e) => {
                last_err = format!("pandoc error: {}", e);
            }
        }
    }

    let _ = fs::remove_dir_all(&tmp_dir);
    Err(format!("pandoc failed: {}", last_err))
}

#[tauri::command]
async fn export_docx(markdown_content: String, output_path: String) -> Result<String, String> {
    use std::io::Write;

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            use std::process::Command;

            let tmp_dir = std::env::temp_dir().join("mx_export_docx");
            let _ = fs::create_dir_all(&tmp_dir);
            let tmp_md = tmp_dir.join("export.md");

            let mut f = fs::File::create(&tmp_md).map_err(|e| e.to_string())?;
            f.write_all(markdown_content.as_bytes()).map_err(|e| e.to_string())?;

            let sys_path = std::env::var("PATH").unwrap_or_default();
            let path_env = if cfg!(target_os = "windows") {
                format!("{};C:\\Program Files\\MiKTeX\\miktex\\bin\\x64;C:\\texlive\\2024\\bin\\windows;C:\\texlive\\2025\\bin\\windows", sys_path)
            } else {
                format!("{}:/Library/TeX/texbin:/usr/local/bin:/usr/bin:/bin", sys_path)
            };

            let stderr_file = tmp_dir.join("pandoc_stderr.log");
            let stderr_out = fs::File::create(&stderr_file).map_err(|e| e.to_string())?;

            let mut child = Command::new("pandoc")
                .args([
                    tmp_md.to_str().unwrap(),
                    "-o", &output_path,
                    "--from", "markdown",
                    "--to", "docx",
                ])
                .env("PATH", &path_env)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::from(stderr_out))
                .spawn()
                .map_err(|e| format!("Failed to run pandoc: {}. Is pandoc installed?", e))?;

            let timeout = std::time::Duration::from_secs(60);
            match child.wait_timeout(timeout) {
                Ok(Some(status)) if status.success() => {
                    let _ = fs::remove_dir_all(&tmp_dir);
                    Ok(output_path)
                }
                Ok(Some(_)) => {
                    let err = fs::read_to_string(&stderr_file).unwrap_or_default();
                    let _ = fs::remove_dir_all(&tmp_dir);
                    Err(format!("pandoc failed: {}", err))
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_dir_all(&tmp_dir);
                    Err("pandoc timed out".to_string())
                }
                Err(e) => {
                    let _ = fs::remove_dir_all(&tmp_dir);
                    Err(format!("pandoc error: {}", e))
                }
            }
        })();
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| format!("Thread error: {}", e))?
}

#[tauri::command]
fn duplicate_entry(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err("Source path does not exist".to_string());
    }
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = src.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let parent = src.parent().ok_or("Cannot determine parent directory")?;

    // Find a unique name with -copy, -copy-2, -copy-3, etc.
    let mut dest = parent.join(format!("{}-copy{}", stem, ext));
    let mut counter = 2u32;
    while dest.exists() {
        dest = parent.join(format!("{}-copy-{}{}", stem, counter, ext));
        counter += 1;
    }

    if src.is_dir() {
        fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
            fs::create_dir(dst).map_err(|e| e.to_string())?;
            for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
                let target = dst.join(entry.file_name());
                if entry.path().is_dir() {
                    copy_dir(&entry.path(), &target)?;
                } else {
                    fs::copy(&entry.path(), &target).map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        }
        copy_dir(&src, &dest)?;
    } else {
        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    }

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    use std::process::Command;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(format!("/select,{}", &path)).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = p.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| path.clone());
        Command::new("xdg-open").arg(&parent).spawn().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn export_html(markdown_content: String, theme: String) -> Result<String, String> {
    // Simple markdown-to-HTML: use a basic conversion approach
    // We process line-by-line for headings, paragraphs, code blocks, lists, etc.
    let mut html_body = String::new();
    let mut in_code_block = false;
    let mut code_lang = String::new();
    let mut code_buf = String::new();
    let mut in_list = false;
    let mut in_paragraph = false;

    for line in markdown_content.lines() {
        if line.starts_with("```") && !in_code_block {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            if in_list { html_body.push_str("</ul>\n"); in_list = false; }
            in_code_block = true;
            code_lang = line.trim_start_matches('`').trim().to_string();
            code_buf.clear();
            continue;
        } else if line.starts_with("```") && in_code_block {
            in_code_block = false;
            let lang_attr = if code_lang.is_empty() { String::new() } else { format!(" class=\"language-{}\"", escape_html(&code_lang)) };
            html_body.push_str(&format!("<pre><code{}>{}</code></pre>\n", lang_attr, escape_html(&code_buf)));
            code_lang.clear();
            continue;
        }

        if in_code_block {
            code_buf.push_str(line);
            code_buf.push('\n');
            continue;
        }

        let trimmed = line.trim();

        if trimmed.is_empty() {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            if in_list { html_body.push_str("</ul>\n"); in_list = false; }
            continue;
        }

        // Headings
        if trimmed.starts_with("######") {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            html_body.push_str(&format!("<h6>{}</h6>\n", inline_format(trimmed.trim_start_matches('#').trim())));
        } else if trimmed.starts_with("#####") {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            html_body.push_str(&format!("<h5>{}</h5>\n", inline_format(trimmed.trim_start_matches('#').trim())));
        } else if trimmed.starts_with("####") {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            html_body.push_str(&format!("<h4>{}</h4>\n", inline_format(trimmed.trim_start_matches('#').trim())));
        } else if trimmed.starts_with("###") {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            html_body.push_str(&format!("<h3>{}</h3>\n", inline_format(trimmed.trim_start_matches('#').trim())));
        } else if trimmed.starts_with("##") {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            html_body.push_str(&format!("<h2>{}</h2>\n", inline_format(trimmed.trim_start_matches('#').trim())));
        } else if trimmed.starts_with('#') {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            html_body.push_str(&format!("<h1>{}</h1>\n", inline_format(trimmed.trim_start_matches('#').trim())));
        } else if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            if !in_list { html_body.push_str("<ul>\n"); in_list = true; }
            html_body.push_str(&format!("<li>{}</li>\n", inline_format(&trimmed[2..])));
        } else if trimmed.starts_with("---") || trimmed.starts_with("***") || trimmed.starts_with("___") {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            html_body.push_str("<hr>\n");
        } else if trimmed.starts_with('>') {
            if in_paragraph { html_body.push_str("</p>\n"); in_paragraph = false; }
            html_body.push_str(&format!("<blockquote>{}</blockquote>\n", inline_format(trimmed.trim_start_matches('>').trim())));
        } else {
            if !in_paragraph { html_body.push_str("<p>"); in_paragraph = true; }
            else { html_body.push_str("<br>"); }
            html_body.push_str(&inline_format(trimmed));
            html_body.push('\n');
        }
    }

    if in_paragraph { html_body.push_str("</p>\n"); }
    if in_list { html_body.push_str("</ul>\n"); }
    if in_code_block {
        html_body.push_str(&format!("<pre><code>{}</code></pre>\n", escape_html(&code_buf)));
    }

    let (bg, fg, accent, code_bg, border, blockquote_border) = if theme == "light" {
        ("#ffffff", "#1e1e2e", "#1e66f5", "#f5f5f5", "#e0e0e0", "#1e66f5")
    } else {
        ("#1e1e2e", "#cdd6f4", "#89b4fa", "#313244", "#45475a", "#89b4fa")
    };

    let html = format!(
        r#"<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: {bg}; color: {fg}; max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.6; }}
h1, h2, h3, h4, h5, h6 {{ margin-top: 1.5em; margin-bottom: 0.5em; font-weight: 600; }}
h1 {{ font-size: 2em; border-bottom: 1px solid {border}; padding-bottom: 0.3em; }}
h2 {{ font-size: 1.5em; border-bottom: 1px solid {border}; padding-bottom: 0.3em; }}
a {{ color: {accent}; text-decoration: none; }}
a:hover {{ text-decoration: underline; }}
pre {{ background: {code_bg}; padding: 1em; border-radius: 6px; overflow-x: auto; }}
code {{ font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; }}
p code {{ background: {code_bg}; padding: 0.2em 0.4em; border-radius: 3px; }}
blockquote {{ border-left: 4px solid {blockquote_border}; margin: 1em 0; padding: 0.5em 1em; color: {fg}; opacity: 0.85; }}
hr {{ border: none; border-top: 1px solid {border}; margin: 2em 0; }}
ul {{ padding-left: 1.5em; }}
li {{ margin: 0.25em 0; }}
img {{ max-width: 100%; }}
</style>
</head>
<body>
{body}
</body>
</html>"#,
        bg = bg, fg = fg, accent = accent, code_bg = code_bg,
        border = border, blockquote_border = blockquote_border,
        body = html_body,
    );

    Ok(html)
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn inline_format(s: &str) -> String {
    let s = escape_html(s);
    // Bold: **text** or __text__
    let s = regex_replace_all(&s, r"\*\*(.+?)\*\*", "<strong>$1</strong>");
    let s = regex_replace_all(&s, r"__(.+?)__", "<strong>$1</strong>");
    // Italic: *text* or _text_
    let s = regex_replace_all(&s, r"\*(.+?)\*", "<em>$1</em>");
    let s = regex_replace_all(&s, r"_(.+?)_", "<em>$1</em>");
    // Inline code: `text`
    let s = regex_replace_all(&s, r"`(.+?)`", "<code>$1</code>");
    // Links: [text](url)
    let s = regex_replace_all(&s, r"\[(.+?)\]\((.+?)\)", "<a href=\"$2\">$1</a>");
    // Images: ![alt](url)
    let s = regex_replace_all(&s, r"!\[(.+?)\]\((.+?)\)", "<img alt=\"$1\" src=\"$2\">");
    s
}

fn regex_replace_all(text: &str, pattern: &str, replacement: &str) -> String {
    // Simple regex-like replacement without regex crate
    // Handles basic patterns used in inline_format
    let mut result = text.to_string();

    if pattern == r"\*\*(.+?)\*\*" {
        result = replace_delimited(&result, "**", "**", |inner| {
            replacement.replace("$1", inner)
        });
    } else if pattern == r"__(.+?)__" {
        result = replace_delimited(&result, "__", "__", |inner| {
            replacement.replace("$1", inner)
        });
    } else if pattern == r"\*(.+?)\*" {
        result = replace_delimited(&result, "*", "*", |inner| {
            replacement.replace("$1", inner)
        });
    } else if pattern == r"_(.+?)_" {
        result = replace_delimited(&result, "_", "_", |inner| {
            replacement.replace("$1", inner)
        });
    } else if pattern == r"`(.+?)`" {
        result = replace_delimited(&result, "`", "`", |inner| {
            replacement.replace("$1", inner)
        });
    } else if pattern == r"\[(.+?)\]\((.+?)\)" {
        // Link pattern: [text](url)
        while let Some(start) = result.find('[') {
            if let Some(mid) = result[start..].find("](") {
                let mid = start + mid;
                if let Some(end) = result[mid + 2..].find(')') {
                    let end = mid + 2 + end;
                    let text_part = &result[start + 1..mid].to_string();
                    let url_part = &result[mid + 2..end].to_string();
                    let rep = replacement.replace("$1", text_part).replace("$2", url_part);
                    result = format!("{}{}{}", &result[..start], rep, &result[end + 1..]);
                    continue;
                }
            }
            break;
        }
    } else if pattern == r"!\[(.+?)\]\((.+?)\)" {
        // Image pattern: ![alt](url)
        while let Some(start) = result.find("![") {
            if let Some(mid) = result[start + 1..].find("](") {
                let mid = start + 1 + mid;
                if let Some(end) = result[mid + 2..].find(')') {
                    let end = mid + 2 + end;
                    let alt = &result[start + 2..mid].to_string();
                    let url = &result[mid + 2..end].to_string();
                    let rep = replacement.replace("$1", alt).replace("$2", url);
                    result = format!("{}{}{}", &result[..start], rep, &result[end + 1..]);
                    continue;
                }
            }
            break;
        }
    }

    result
}

fn replace_delimited<F: Fn(&str) -> String>(text: &str, open: &str, close: &str, f: F) -> String {
    let mut result = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(open) {
        result.push_str(&rest[..start]);
        let after_open = &rest[start + open.len()..];
        if let Some(end) = after_open.find(close) {
            let inner = &after_open[..end];
            if !inner.is_empty() {
                result.push_str(&f(inner));
            } else {
                result.push_str(open);
                result.push_str(close);
            }
            rest = &after_open[end + close.len()..];
        } else {
            result.push_str(open);
            rest = after_open;
        }
    }
    result.push_str(rest);
    result
}

#[tauri::command]
fn load_custom_css() -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| e.to_string())?;
    let path = std::path::PathBuf::from(home).join(".mx").join("preview.css");
    if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
fn create_window(app: tauri::AppHandle, file_path: Option<String>) -> Result<(), String> {
    let label = format!("mx-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    let label_clone = label.clone();

    tauri::WebviewWindowBuilder::new(
        &app, &label, tauri::WebviewUrl::App("index.html".into())
    )
    .title("mx")
    .inner_size(1200.0, 800.0)
    .build()
    .map_err(|e| e.to_string())?;

    // If a file path was provided, emit open-file to the new window after it initializes
    if let Some(path) = file_path {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            if let Some(win) = handle.get_webview_window(&label_clone) {
                let _ = win.emit("open-file", path);
            }
        });
    }

    Ok(())
}

#[tauri::command]
fn watch_file(path: String, window: tauri::Window) -> Result<(), String> {
    let mut watchers_lock = FILE_WATCHERS.lock().unwrap_or_else(|e| e.into_inner());
    let watchers = watchers_lock.get_or_insert_with(HashMap::new);
    let label = window.label().to_string();

    // Create a new watcher that emits to this specific window
    let watched_path = PathBuf::from(&path);
    let watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            match res {
                Ok(event) => match event.kind {
                    EventKind::Modify(_) | EventKind::Create(_) => {
                        if event.paths.iter().any(|p| p == &watched_path) {
                            let _ = window.emit("file-changed", watched_path.to_string_lossy().to_string());
                        }
                    }
                    _ => {}
                },
                Err(e) => eprintln!("[mx] file watcher error: {}", e),
            }
        },
        notify::Config::default(),
    ).map_err(|e| e.to_string())?;

    // Drop old watcher for this window safely
    if let Some(old) = watchers.remove(&label) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(old)));
    }
    watchers.insert(label.clone(), watcher);

    // Watch the file's parent directory (more reliable than watching the file directly)
    if let Some(parent) = Path::new(&path).parent() {
        watchers.get_mut(&label).unwrap()
            .watch(parent, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn unwatch_file(window: tauri::Window) -> Result<(), String> {
    let mut watchers_lock = FILE_WATCHERS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(watchers) = watchers_lock.as_mut() {
        if let Some(watcher) = watchers.remove(window.label()) {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(watcher)));
        }
    }
    Ok(())
}

#[tauri::command]
fn watch_folder(path: String, window: tauri::Window) -> Result<(), String> {
    let mut watchers_lock = FOLDER_WATCHERS.lock().unwrap_or_else(|e| e.into_inner());
    let watchers = watchers_lock.get_or_insert_with(HashMap::new);
    let label = window.label().to_string();

    let watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            match res {
                Ok(event) => match event.kind {
                    EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                        let _ = window.emit("folder-changed", ());
                    }
                    _ => {}
                },
                Err(e) => eprintln!("[mx] folder watcher error: {}", e),
            }
        },
        notify::Config::default(),
    ).map_err(|e| e.to_string())?;

    if let Some(old) = watchers.remove(&label) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(old)));
    }
    watchers.insert(label.clone(), watcher);

    watchers.get_mut(&label).unwrap()
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn unwatch_folder(window: tauri::Window) -> Result<(), String> {
    let mut watchers_lock = FOLDER_WATCHERS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(watchers) = watchers_lock.as_mut() {
        if let Some(watcher) = watchers.remove(window.label()) {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || drop(watcher)));
        }
    }
    Ok(())
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

            // On Linux/Windows, file associations pass the path as a CLI arg
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            {
                let args: Vec<String> = std::env::args().collect();
                if args.len() > 1 {
                    let path = &args[1];
                    if !path.starts_with('-') && Path::new(path).exists() {
                        *INITIAL_FILE.lock().unwrap() = Some(path.clone());
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![read_file, save_file, word_count, list_directory, get_home_dir, get_initial_file, export_pdf, export_docx, create_file, create_directory, delete_entry, rename_entry, list_files_recursive, save_recovery, get_recovery_files, read_recovery_content, delete_recovery, duplicate_entry, reveal_in_finder, export_html, load_custom_css, watch_file, unwatch_file, watch_folder, unwatch_folder, search_in_files, create_window])
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
                    // Emit to focused window if available, otherwise broadcast
                    let emitted = _app.webview_windows().values()
                        .find(|w| w.is_focused().unwrap_or(false))
                        .map(|w| w.emit("open-file", path.clone()));
                    if emitted.is_none() {
                        let _ = _app.emit("open-file", path.clone());
                    }
                }
            }
        });
}

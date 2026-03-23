use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let web_dist = manifest_dir.join("../web/dist");
    println!("cargo:rerun-if-changed={}", web_dist.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let output_path = out_dir.join("embedded_assets.rs");
    let mut output = String::new();
    output.push_str("pub static EMBEDDED_ASSETS: &[EmbeddedAsset] = &[\n");

    if web_dist.join("index.html").exists() {
        let mut files = Vec::new();
        collect_files(&web_dist, &web_dist, &mut files);
        files.sort();
        for file in files {
            let rel = file
                .strip_prefix(&web_dist)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let web_path = format!("/{}", rel);
            let mime = infer_static_mime(&file);
            output.push_str(&format!(
                "    EmbeddedAsset {{ path: {:?}, content_type: {:?}, bytes: include_bytes!(r#\"{}\"#) }},\n",
                web_path,
                mime,
                file.display(),
            ));
        }
    }

    output.push_str("];\n");
    let mut file = fs::File::create(output_path).unwrap();
    file.write_all(output.as_bytes()).unwrap();
}

fn collect_files(root: &Path, current: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files);
        } else if path.is_file() {
            files.push(
                path.strip_prefix(root)
                    .map(|rel| root.join(rel))
                    .unwrap_or(path),
            );
        }
    }
}

fn infer_static_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

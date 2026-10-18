//! Strudel's REPL in a Chan tab: the embedded UI, the pinned Strudel inputs,
//! and per-session patterns, settings, and WAV exports.

mod store;

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;

use store::Store;

const SCOPE_HEADER: &str = "x-chan-extension-scope";
const STATE_FILE: &str = "state.json";
const EXPORTS_DIR: &str = "exports";
const SAMPLES_DIR: &str = "samples";
const REPOSITORY: &str = "https://github.com/fiorix/chan-ext-strudel";
const INDEX_HTML: &str = include_str!("../assets/index.html");
const APP_CSS: &str = include_str!("../assets/app.css");
const APP_JS: &str = include_str!("../assets/app.js");
const UI_JS: &str = include_str!("../assets/ui.js");
const STRUDEL_REPL_JS: &[u8] = include_bytes!("../../../runtime/strudel-repl.js");
const STRUDEL_REFERENCE_MJS: &[u8] = include_bytes!("../../../runtime/strudel-reference.mjs");
const STRUDEL_LOCK: &str = include_str!("../../../runtime/strudel.lock.json");
/// Caps on one session's record: its patterns, each pattern's code, and the
/// settings object. The store itself refuses records over 1 MiB.
const MAX_PATTERNS: usize = 500;
const MAX_CODE_BYTES: usize = 256 * 1024;
const MAX_SETTINGS_BYTES: usize = 16 * 1024;
/// A rendered WAV. Ten minutes of 48 kHz stereo 16-bit is about 110 MiB.
const MAX_EXPORT_BYTES: usize = 256 * 1024 * 1024;
const MAX_EXPORT_STEM: usize = 64;
/// One sample file, read into memory before it is sent.
const MAX_SAMPLE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Parser)]
#[command(name = "strudel-extension", about = "Strudel's REPL in a Chan tab")]
struct Cli {
    #[arg(long, default_value = "127.0.0.1:0")]
    listen: SocketAddr,
    /// Private storage for patterns, settings, and exports, and the samples
    /// folder patterns load from. Defaults to <chan-home>/strudel.
    #[arg(long)]
    data_dir: Option<PathBuf>,
}

struct AppState {
    token: String,
    store: Store,
    samples: PathBuf,
    meta: Value,
}

/// The pinned inputs, as `scripts/fetch-strudel.py` records them.
#[derive(Deserialize)]
struct Lock {
    version: u32,
    repl: String,
    files: BTreeMap<String, FilePin>,
    source: SourcePin,
}

#[derive(Deserialize)]
struct FilePin {
    package: String,
    bytes: usize,
    sha256: String,
}

#[derive(Deserialize)]
struct SourcePin {
    tag: String,
    commit: String,
    repository: String,
    packages: Vec<PackagePin>,
}

#[derive(Deserialize)]
struct PackagePin {
    name: String,
    version: String,
}

fn parse_lock(lock: &str) -> Result<Lock> {
    let lock: Lock = serde_json::from_str(lock).context("parsing the Strudel lock")?;
    if lock.version != 2 {
        bail!("Unsupported Strudel lock version {}.", lock.version);
    }
    Ok(lock)
}

/// Refuse to serve any file but the one the lock pins, before the handshake
/// hands the tab to Chan.
fn verify_file(lock: &Lock, name: &str, bytes: &[u8]) -> Result<()> {
    let pin = lock
        .files
        .get(name)
        .with_context(|| format!("the lock does not pin {name}"))?;
    if bytes.len() != pin.bytes {
        bail!("{name} is {} bytes, expected {}.", bytes.len(), pin.bytes);
    }
    let actual = digest(bytes);
    if actual != pin.sha256 {
        bail!("{name} sha256 is {actual}, expected {}.", pin.sha256);
    }
    Ok(())
}

/// What the About panel shows: the pinned Strudel release, the reference data,
/// and this extension.
fn meta(lock: &Lock) -> Result<Value> {
    let package = |name: &str| {
        lock.source
            .packages
            .iter()
            .find(|package| package.name == name)
            .with_context(|| format!("{name} is not in the lock's source list"))
    };
    let repl = package(&lock.repl)?;
    let reference_pin = lock
        .files
        .get("strudel-reference.mjs")
        .context("the lock does not pin strudel-reference.mjs")?;
    let reference = package(&reference_pin.package)?;
    Ok(json!({
        "strudel": {
            "name": repl.name,
            "version": repl.version,
            "tag": lock.source.tag,
            "commit": lock.source.commit,
            "repository": lock.source.repository,
        },
        "reference": {
            "name": reference.name,
            "version": reference.version,
        },
        "extension": {
            "version": env!("CARGO_PKG_VERSION"),
            "repository": REPOSITORY,
        },
    }))
}

fn chan_home() -> PathBuf {
    match std::env::var("CHAN_HOME") {
        Ok(home) if !home.trim().is_empty() => PathBuf::from(home),
        _ => match std::env::var("HOME") {
            Ok(home) if !home.trim().is_empty() => PathBuf::from(home).join(".chan"),
            _ => PathBuf::from(".chan"),
        },
    }
}

fn new_id() -> String {
    let mut bytes = [0; 16];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn digest(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// One record per Chan session: the scope Chan stamps on every proxied request.
fn owner_key(scope: &str) -> String {
    digest(format!("runtime:{scope}").as_bytes())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if !cli.listen.is_ipv4() || !cli.listen.ip().is_loopback() {
        bail!("--listen must use IPv4 loopback");
    }
    let lock = parse_lock(STRUDEL_LOCK)?;
    verify_file(&lock, "strudel-repl.js", STRUDEL_REPL_JS)?;
    verify_file(&lock, "strudel-reference.mjs", STRUDEL_REFERENCE_MJS)?;
    let meta = meta(&lock)?;
    let listener = TcpListener::bind(cli.listen)
        .await
        .context("binding extension server")?;
    let address = listener.local_addr()?;
    let token = format!("{}{}", new_id(), new_id());
    let data_dir = cli.data_dir.unwrap_or_else(|| chan_home().join("strudel"));
    let store = Store::new(data_dir.clone())?;
    // Create the folder so there is somewhere to put files. A symlink already
    // in its place is kept, and a failure only leaves the route serving 404s.
    let samples = data_dir.join(SAMPLES_DIR);
    if let Err(error) = std::fs::create_dir_all(&samples) {
        eprintln!("strudel: creating {}: {error}", samples.display());
    }
    let state = Arc::new(AppState {
        token: token.clone(),
        store,
        samples,
        meta,
    });
    let app = router(state);
    println!("CHAN_EXTENSION_V1={}", handshake(address, &token));
    use std::io::Write;
    std::io::stdout().flush()?;
    axum::serve(listener, app).await.context("serving Strudel")
}

fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/app.css", get(app_css))
        .route("/app.js", get(app_js))
        .route("/ui.js", get(ui_js))
        .route("/strudel-repl.js", get(strudel_repl_js))
        .route("/strudel-reference.mjs", get(strudel_reference_mjs))
        .route("/meta", get(meta_handler))
        .route("/state", get(state_get).put(state_put))
        .route("/samples/{*path}", get(sample))
        .route(
            "/export",
            post(export_wav).layer(DefaultBodyLimit::max(MAX_EXPORT_BYTES)),
        )
        .with_state(state)
}

fn handshake(address: SocketAddr, token: &str) -> Value {
    json!({
        "url": format!("http://{address}/"),
        "token": token,
        "singleton": true,
        "commands": [
            {
                "id": "toggle-presentation",
                "title": "Toggle Strudel Presentation",
                "keywords": ["strudel", "maximize", "restore"]
            }
        ]
    })
}

#[derive(Deserialize)]
struct AuthQuery {
    #[serde(default)]
    t: String,
}

fn check_auth(state: &AppState, auth: &AuthQuery) -> Result<(), StatusCode> {
    if auth.t == state.token {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn header_value(headers: &HeaderMap, name: &str) -> Result<String, StatusCode> {
    let value = headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::FORBIDDEN)?;
    if value.is_empty() || value.len() > 256 {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(value.to_string())
}

fn internal(error: anyhow::Error) -> StatusCode {
    eprintln!("strudel: {error:#}");
    StatusCode::INTERNAL_SERVER_ERROR
}

macro_rules! asset {
    ($name:ident, $content_type:literal, $body:expr) => {
        async fn $name(
            State(state): State<Arc<AppState>>,
            Query(auth): Query<AuthQuery>,
        ) -> Result<Response, StatusCode> {
            check_auth(&state, &auth)?;
            Ok(Response::builder()
                .header(header::CONTENT_TYPE, $content_type)
                .header(header::CACHE_CONTROL, "no-store")
                .body($body.into())
                .expect("embedded asset response"))
        }
    };
}

asset!(index, "text/html; charset=utf-8", INDEX_HTML);
asset!(app_css, "text/css; charset=utf-8", APP_CSS);
asset!(app_js, "text/javascript; charset=utf-8", APP_JS);
asset!(ui_js, "text/javascript; charset=utf-8", UI_JS);
asset!(
    strudel_repl_js,
    "text/javascript; charset=utf-8",
    STRUDEL_REPL_JS
);
asset!(
    strudel_reference_mjs,
    "text/javascript; charset=utf-8",
    STRUDEL_REFERENCE_MJS
);

async fn meta_handler(
    State(state): State<Arc<AppState>>,
    Query(auth): Query<AuthQuery>,
) -> Result<Json<Value>, StatusCode> {
    check_auth(&state, &auth)?;
    Ok(Json(state.meta.clone()))
}

/// One Chan session's patterns and settings. The editor buffer is the active
/// pattern, so the page writes the whole record on every change.
#[derive(Debug, Serialize, Deserialize)]
struct StateRecord {
    version: u32,
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    patterns: Vec<PatternRecord>,
    #[serde(default)]
    settings: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PatternRecord {
    id: String,
    code: String,
    #[serde(default)]
    created_at: u64,
    #[serde(default)]
    updated_at: u64,
}

fn check_state(record: &StateRecord) -> Result<(), StatusCode> {
    if record.version != 2 {
        return Err(StatusCode::BAD_REQUEST);
    }
    if record.patterns.len() > MAX_PATTERNS {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let mut ids = HashSet::new();
    for pattern in &record.patterns {
        if !valid_id(&pattern.id) || !ids.insert(pattern.id.as_str()) {
            return Err(StatusCode::BAD_REQUEST);
        }
        if pattern.code.len() > MAX_CODE_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
    }
    if let Some(active) = &record.active
        && !ids.contains(active.as_str())
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    if let Some(settings) = &record.settings {
        if !settings.is_object() {
            return Err(StatusCode::BAD_REQUEST);
        }
        if settings.to_string().len() > MAX_SETTINGS_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
    }
    Ok(())
}

fn empty_state() -> Value {
    json!({"version": 2, "active": null, "patterns": [], "settings": null})
}

async fn state_get(
    State(state): State<Arc<AppState>>,
    Query(auth): Query<AuthQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    check_auth(&state, &auth)?;
    let owner = owner_key(&header_value(&headers, SCOPE_HEADER)?);
    let store = state.store.clone();
    let record =
        tokio::task::spawn_blocking(move || store.owner(&owner)?.load::<Value>(STATE_FILE))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .map_err(internal)?;
    Ok(Json(record.unwrap_or_else(empty_state)))
}

async fn state_put(
    State(state): State<Arc<AppState>>,
    Query(auth): Query<AuthQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, StatusCode> {
    check_auth(&state, &auth)?;
    let owner = owner_key(&header_value(&headers, SCOPE_HEADER)?);
    let record: StateRecord = serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)?;
    check_state(&record)?;
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.owner(&owner)?.save(STATE_FILE, &record))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ExportQuery {
    #[serde(default)]
    t: String,
    #[serde(default)]
    name: String,
}

/// A file stem from the name the page sent: ASCII letters, digits, dots,
/// underscores, and hyphens only, no leading dot, no `.wav` suffix of its own.
fn export_stem(raw: &str) -> String {
    let kept: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(MAX_EXPORT_STEM)
        .collect();
    let without_suffix = kept
        .strip_suffix(".wav")
        .or_else(|| kept.strip_suffix(".WAV"))
        .unwrap_or(&kept);
    let stem = without_suffix.trim_matches(|c| c == '.' || c == '-');
    if stem.is_empty() {
        format!("strudel-{}", now())
    } else {
        stem.to_string()
    }
}

fn is_wav(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
}

/// Store a rendered WAV under the shared exports directory and answer with its
/// path. The sandbox blocks downloads, so this is how a render reaches disk.
async fn export_wav(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, StatusCode> {
    check_auth(&state, &AuthQuery { t: query.t })?;
    header_value(&headers, SCOPE_HEADER)?;
    if !is_wav(&body) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let stem = export_stem(&query.name);
    let bytes = body.len();
    let store = state.store.clone();
    let path = tokio::task::spawn_blocking(move || {
        store.subdir(EXPORTS_DIR)?.write_unique(&stem, "wav", &body)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(internal)?;
    Ok(Json(
        json!({"path": path.display().to_string(), "bytes": bytes}),
    ))
}

/// The media type served for a sample file name, or `None` to refuse it.
/// Only audio and JSON: the capability path shares Chan's origin, so an HTML
/// or SVG file opened from it in a top-level tab would run as Chan.
fn sample_type(name: &str) -> Option<&'static str> {
    let (_, extension) = name.rsplit_once('.')?;
    let content_type = match extension.to_ascii_lowercase().as_str() {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "aif" | "aiff" => "audio/aiff",
        "webm" => "audio/webm",
        "json" => "application/json",
        _ => return None,
    };
    Some(content_type)
}

/// The file a `/samples/...` request names, relative to the samples folder,
/// and its media type. Every segment must be a plain, visible name, so a
/// request leaves the folder only through a symlink the user put there.
fn sample_file(path: &str) -> Option<(PathBuf, &'static str)> {
    let mut relative = PathBuf::new();
    for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        if segment.starts_with('.')
            || segment
                .chars()
                .any(|c| c.is_control() || c == '\\' || c == ':')
        {
            return None;
        }
        relative.push(segment);
    }
    let content_type = sample_type(relative.file_name()?.to_str()?)?;
    Some((relative, content_type))
}

/// A regular file of at most `limit` bytes, following symlinks, or `None`
/// when there is no such file to serve.
fn read_sample(path: &Path, limit: u64) -> Result<Option<Vec<u8>>> {
    // Stat before opening: opening a FIFO blocks until a writer appears.
    if !std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file()) {
        return Ok(None);
    }
    let Ok(file) = File::open(path) else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        bail!(
            "{} exceeds the {} MiB sample limit.",
            path.display(),
            limit / (1024 * 1024)
        );
    }
    Ok(Some(bytes))
}

/// Serve a file from the samples folder, so a pattern can load local files
/// by relative URL, e.g. `samples('samples/kit/strudel.json')`.
async fn sample(
    State(state): State<Arc<AppState>>,
    Query(auth): Query<AuthQuery>,
    UrlPath(path): UrlPath<String>,
) -> Result<Response, StatusCode> {
    check_auth(&state, &auth)?;
    let (relative, content_type) = sample_file(&path).ok_or(StatusCode::NOT_FOUND)?;
    let file = state.samples.join(relative);
    let bytes = tokio::task::spawn_blocking(move || read_sample(&file, MAX_SAMPLE_BYTES))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(internal)?
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .body(bytes.into())
        .expect("sample response"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    fn test_state() -> (tempfile::TempDir, Arc<AppState>) {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState {
            token: "secret".into(),
            store: Store::new(dir.path().to_path_buf()).unwrap(),
            samples: dir.path().join(SAMPLES_DIR),
            meta: json!({}),
        });
        (dir, state)
    }

    fn auth() -> Query<AuthQuery> {
        Query(AuthQuery { t: "secret".into() })
    }

    fn scoped(scope: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(SCOPE_HEADER, scope.parse().unwrap());
        headers
    }

    fn record(active: Option<&str>, patterns: &[(&str, &str)]) -> Bytes {
        Bytes::from(
            serde_json::to_vec(&json!({
                "version": 2,
                "active": active,
                "patterns": patterns.iter().map(|(id, code)| json!({
                    "id": id, "code": code, "created_at": 1, "updated_at": 2
                })).collect::<Vec<_>>(),
                "settings": {"theme": "nord"},
            }))
            .unwrap(),
        )
    }

    #[test]
    fn handshake_is_singleton_with_one_valid_command() {
        let value = handshake("127.0.0.1:12345".parse().unwrap(), "secret");
        assert_eq!(value["singleton"], true);
        assert_eq!(value["url"], "http://127.0.0.1:12345/");
        assert!(!value.to_string().contains('\n'));
        let commands = value["commands"].as_array().unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0]["id"], "toggle-presentation");
        // Chan's command grammar (chan-server/src/routes/extensions.rs): a
        // command that fails it drops the whole handshake.
        for command in commands {
            let id = command["id"].as_str().unwrap();
            assert!(!id.is_empty() && id.len() <= 64);
            assert!(
                id.bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            );
            assert!(
                id.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            );
            let title = command["title"].as_str().unwrap().trim();
            assert!((1..=128).contains(&title.chars().count()));
            let keywords = command["keywords"].as_array().unwrap();
            assert!(keywords.len() <= 8);
            for keyword in keywords {
                assert!((1..=64).contains(&keyword.as_str().unwrap().chars().count()));
            }
        }
    }

    #[test]
    fn private_headers_are_required_and_bounded() {
        let mut headers = HeaderMap::new();
        assert!(header_value(&headers, SCOPE_HEADER).is_err());
        headers.insert(SCOPE_HEADER, "".parse().unwrap());
        assert!(header_value(&headers, SCOPE_HEADER).is_err());
        headers.insert(SCOPE_HEADER, "x".repeat(257).parse().unwrap());
        assert!(header_value(&headers, SCOPE_HEADER).is_err());
        headers.insert(SCOPE_HEADER, "scope".parse().unwrap());
        assert_eq!(header_value(&headers, SCOPE_HEADER).unwrap(), "scope");
    }

    #[test]
    fn owner_keys_are_scope_specific_and_opaque() {
        let key = owner_key("scope-a");
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(valid_id(&key));
        assert_ne!(key, owner_key("scope-b"));
    }

    #[test]
    fn assets_use_relative_urls_and_validate_parent_messages() {
        for body in [INDEX_HTML, APP_CSS, APP_JS, UI_JS] {
            for needle in ["src=\"/", "href=\"/", "url(/", "\"/api/", "import(\"/"] {
                assert!(!body.contains(needle), "{needle}");
            }
        }
        assert!(INDEX_HTML.contains("src=\"strudel-repl.js\""));
        assert!(APP_JS.contains("from \"./ui.js\""));
        assert!(UI_JS.contains("import(\"./strudel-reference.mjs\")"));
        assert!(APP_JS.contains("event.source !== window.parent"));
        assert!(APP_JS.contains("// Chan's keyboard relay."));
        assert!(APP_JS.contains("// End of Chan's keyboard relay."));
        assert!(APP_CSS.contains("display: none !important"));
    }

    #[test]
    fn page_runs_the_scheduler_on_worker_timers() {
        // Strudel's clock captures globalThis.setInterval when the editor is
        // created, so the worker-backed timers must be installed before the
        // editor mounts, or a hidden tab throttles playback.
        let install = APP_JS
            .find("installWorkerTimers();")
            .expect("the page installs worker timers");
        let mount = APP_JS
            .find("mountEditor(activePattern().code)")
            .expect("the page mounts the editor");
        assert!(install < mount);
        assert!(APP_JS.contains("new Worker("));
        assert!(APP_JS.contains("globalThis.setInterval ="));
    }

    #[test]
    fn embedded_files_match_the_pin_manifest() {
        let lock = parse_lock(STRUDEL_LOCK).unwrap();
        verify_file(&lock, "strudel-repl.js", STRUDEL_REPL_JS).unwrap();
        verify_file(&lock, "strudel-reference.mjs", STRUDEL_REFERENCE_MJS).unwrap();
        assert!(verify_file(&lock, "strudel-repl.js", b"not the bundle").is_err());
        let mut flipped = STRUDEL_REPL_JS.to_vec();
        flipped[0] ^= 1;
        assert!(verify_file(&lock, "strudel-repl.js", &flipped).is_err());
        assert!(verify_file(&lock, "unknown.js", b"").is_err());
    }

    #[test]
    fn embedded_bundle_is_self_contained() {
        // The bundle is served as one file under Chan's capability path, so a
        // relative chunk import would fail at runtime.
        for needle in ["import(\"./", "import('./", "import(\"../", "import('../"] {
            assert!(!contains(STRUDEL_REPL_JS, needle.as_bytes()), "{needle}");
        }
        assert!(contains(STRUDEL_REPL_JS, b"strudel-editor"));
        assert!(contains(STRUDEL_REFERENCE_MJS, b"as reference"));
    }

    #[test]
    fn meta_names_the_pinned_strudel_release() {
        let value = meta(&parse_lock(STRUDEL_LOCK).unwrap()).unwrap();
        assert_eq!(value["strudel"]["name"], "@strudel/repl");
        let version = value["strudel"]["version"].as_str().unwrap();
        assert_eq!(value["strudel"]["tag"], format!("@strudel/repl@{version}"));
        assert_eq!(value["reference"]["name"], "@strudel/reference");
        assert_eq!(value["extension"]["version"], env!("CARGO_PKG_VERSION"));
        assert!(parse_lock("{\"version\": 1}").is_err());
    }

    #[test]
    fn export_stems_are_safe_file_names() {
        assert_eq!(export_stem("take one.wav"), "takeone");
        assert_eq!(export_stem("../.hidden/evil.WAV"), "hiddenevil");
        assert!(export_stem("---").starts_with("strudel-"));
        assert!(export_stem("").starts_with("strudel-"));
        assert!(export_stem("...").starts_with("strudel-"));
        assert_eq!(export_stem(&"x".repeat(200)).len(), MAX_EXPORT_STEM);
        assert!(!export_stem("a.wav").ends_with(".wav"));
    }

    #[tokio::test]
    async fn state_round_trips_per_scope_and_rejects_bad_writes() {
        let (_dir, state) = test_state();
        let get = |scope: &str| state_get(State(Arc::clone(&state)), auth(), scoped(scope));
        let put = |scope: &str, body: Bytes| {
            state_put(State(Arc::clone(&state)), auth(), scoped(scope), body)
        };

        assert_eq!(get("a").await.unwrap().0["patterns"], json!([]));
        assert_eq!(
            put(
                "a",
                record(Some("one"), &[("one", "s(\"bd\")"), ("two", "")])
            )
            .await
            .unwrap(),
            StatusCode::NO_CONTENT
        );
        let saved = get("a").await.unwrap().0;
        assert_eq!(saved["active"], "one");
        assert_eq!(saved["patterns"].as_array().unwrap().len(), 2);
        assert_eq!(saved["patterns"][0]["code"], "s(\"bd\")");
        assert_eq!(saved["settings"]["theme"], "nord");
        assert_eq!(get("b").await.unwrap().0["patterns"], json!([]));

        let v1 = Bytes::from_static(b"{\"version\":1,\"code\":\"s(\\\"bd\\\")\"}");
        assert_eq!(put("a", v1).await.unwrap_err(), StatusCode::BAD_REQUEST);
        assert_eq!(
            put("a", record(Some("missing"), &[("one", "")]))
                .await
                .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            put("a", record(None, &[("dup", ""), ("dup", "")]))
                .await
                .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            put("a", record(None, &[("../x", "")])).await.unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        let big = "x".repeat(MAX_CODE_BYTES + 1);
        assert_eq!(
            put("a", record(None, &[("one", &big)])).await.unwrap_err(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let many: Vec<String> = (0..=MAX_PATTERNS).map(|i| format!("p{i}")).collect();
        let many: Vec<(&str, &str)> = many.iter().map(|id| (id.as_str(), "")).collect();
        assert_eq!(
            put("a", record(None, &many)).await.unwrap_err(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let bad_settings = Bytes::from_static(b"{\"version\":2,\"patterns\":[],\"settings\":[1]}");
        assert_eq!(
            put("a", bad_settings).await.unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            state_put(
                State(Arc::clone(&state)),
                Query(AuthQuery { t: "wrong".into() }),
                scoped("a"),
                record(None, &[])
            )
            .await
            .unwrap_err(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            state_get(State(Arc::clone(&state)), auth(), HeaderMap::new())
                .await
                .unwrap_err(),
            StatusCode::FORBIDDEN
        );
        // The refused writes left the record untouched.
        assert_eq!(get("a").await.unwrap().0["active"], "one");
    }

    #[tokio::test]
    async fn exports_land_under_the_shared_directory_without_overwriting() {
        let (dir, state) = test_state();
        let wav = Bytes::from_static(b"RIFF\x24\x00\x00\x00WAVEfmt ");
        let export = |name: &str, body: Bytes| {
            export_wav(
                State(Arc::clone(&state)),
                Query(ExportQuery {
                    t: "secret".into(),
                    name: name.into(),
                }),
                scoped("a"),
                body,
            )
        };
        let first = export("take one.wav", wav.clone()).await.unwrap().0;
        let second = export("take one", wav.clone()).await.unwrap().0;
        let first_path = PathBuf::from(first["path"].as_str().unwrap());
        let second_path = PathBuf::from(second["path"].as_str().unwrap());
        assert_eq!(first_path, dir.path().join(EXPORTS_DIR).join("takeone.wav"));
        assert_eq!(
            second_path,
            dir.path().join(EXPORTS_DIR).join("takeone-2.wav")
        );
        assert_eq!(std::fs::read(&first_path).unwrap(), wav.as_ref());
        assert_eq!(first["bytes"], wav.len());
        assert_eq!(
            export("x", Bytes::from_static(b"not a wav file at all"))
                .await
                .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            export_wav(
                State(Arc::clone(&state)),
                Query(ExportQuery {
                    t: "secret".into(),
                    name: "x".into(),
                }),
                HeaderMap::new(),
                wav.clone()
            )
            .await
            .unwrap_err(),
            StatusCode::FORBIDDEN
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&first_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn sample_paths_stay_in_the_folder_and_name_audio_or_json() {
        assert_eq!(
            sample_file("kit/bd.wav").unwrap(),
            (Path::new("kit").join("bd.wav"), "audio/wav")
        );
        assert_eq!(
            sample_file("/kit//Kick 1.WAV").unwrap(),
            (Path::new("kit").join("Kick 1.WAV"), "audio/wav")
        );
        assert_eq!(
            sample_file("kit/strudel.json").unwrap().1,
            "application/json"
        );
        assert_eq!(sample_file("a.flac").unwrap().1, "audio/flac");
        for path in [
            "",
            "/",
            "..",
            "../x.wav",
            "kit/../../x.wav",
            "./x.wav",
            ".hidden.wav",
            "kit/.git/x.wav",
            "kit\\..\\x.wav",
            "C:x.wav",
            "x\u{0}.wav",
            "kit/page.html",
            "kit/image.svg",
            "kit/app.js",
            "kit/noext",
        ] {
            assert!(sample_file(path).is_none(), "{path:?}");
        }
    }

    async fn body_bytes(response: Response) -> Bytes {
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn samples_serve_files_under_the_folder_and_nothing_else() {
        let (dir, state) = test_state();
        let kit = state.samples.join("kit");
        std::fs::create_dir_all(kit.join("dir.wav")).unwrap();
        std::fs::write(kit.join("bd.wav"), b"RIFF bd").unwrap();
        std::fs::write(kit.join("strudel.json"), b"{}").unwrap();
        std::fs::write(kit.join("page.html"), b"<script>").unwrap();
        std::fs::write(kit.join(".hidden.wav"), b"hidden").unwrap();
        std::fs::write(dir.path().join("outside.wav"), b"outside").unwrap();
        let get = |path: &str| sample(State(Arc::clone(&state)), auth(), UrlPath(path.to_string()));

        let response = get("kit/bd.wav").await.unwrap();
        assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/wav");
        assert!(
            response.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("sandbox")
        );
        assert_eq!(body_bytes(response).await.as_ref(), b"RIFF bd");
        let response = get("kit/strudel.json").await.unwrap();
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        for path in [
            "kit/page.html",
            "kit/.hidden.wav",
            "kit/dir.wav",
            "kit/missing.wav",
            "../outside.wav",
        ] {
            assert_eq!(
                get(path).await.unwrap_err(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        assert_eq!(
            sample(
                State(Arc::clone(&state)),
                Query(AuthQuery { t: "wrong".into() }),
                UrlPath("kit/bd.wav".into())
            )
            .await
            .unwrap_err(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[test]
    fn sample_reads_are_capped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.wav");
        std::fs::write(&path, b"1234").unwrap();
        assert_eq!(read_sample(&path, 4).unwrap().unwrap(), b"1234");
        assert!(read_sample(&path, 3).is_err());
        assert!(
            read_sample(&dir.path().join("missing.wav"), 4)
                .unwrap()
                .is_none()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn samples_follow_symlinks_the_user_placed() {
        use std::os::unix::fs::symlink;
        let (dir, state) = test_state();
        let library = dir.path().join("library");
        std::fs::create_dir_all(library.join("kit")).unwrap();
        std::fs::write(library.join("kit/sd.wav"), b"RIFF sd").unwrap();
        std::fs::create_dir_all(&state.samples).unwrap();
        symlink(&library, state.samples.join("linked")).unwrap();
        symlink(library.join("kit/sd.wav"), state.samples.join("sd.wav")).unwrap();
        for path in ["linked/kit/sd.wav", "sd.wav"] {
            let response = sample(State(Arc::clone(&state)), auth(), UrlPath(path.to_string()))
                .await
                .unwrap();
            assert_eq!(body_bytes(response).await.as_ref(), b"RIFF sd");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_not_opened() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("pipe.wav");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        assert!(read_sample(&fifo, 4).unwrap().is_none());
    }

    /// One raw HTTP/1.1 request, so the test sees the router's own path
    /// matching and percent-decoding.
    fn http_get(address: SocketAddr, target: &str) -> (String, Vec<u8>) {
        use std::io::Write;
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        write!(
            stream,
            "GET {target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        let head = String::from_utf8_lossy(&response[..split]).into_owned();
        (head, response[split + 4..].to_vec())
    }

    #[tokio::test]
    async fn samples_route_decodes_paths_and_requires_the_token() {
        let (dir, state) = test_state();
        std::fs::create_dir_all(state.samples.join("my kit")).unwrap();
        std::fs::write(state.samples.join("my kit/Kick 1.wav"), b"RIFF kick").unwrap();
        std::fs::write(dir.path().join("outside.wav"), b"outside").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router(state)).await });
        let get =
            |target: &'static str| tokio::task::spawn_blocking(move || http_get(address, target));

        let (head, body) = get("/samples/my%20kit/Kick%201.wav?t=secret")
            .await
            .unwrap();
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert_eq!(body, b"RIFF kick");
        let (head, _) = get("/samples/my%20kit/Kick%201.wav").await.unwrap();
        assert!(head.starts_with("HTTP/1.1 401"), "{head}");
        for target in [
            "/samples/%2e%2e/outside.wav?t=secret",
            "/samples/my%20kit/%2e%2e/%2e%2e/outside.wav?t=secret",
            "/samples/..%2foutside.wav?t=secret",
        ] {
            let (head, _) = get(target).await.unwrap();
            assert!(head.starts_with("HTTP/1.1 404"), "{target}: {head}");
        }
        let (head, _) = get("/samples/?t=secret").await.unwrap();
        assert!(head.starts_with("HTTP/1.1 404"), "{head}");
    }
}

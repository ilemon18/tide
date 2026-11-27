use crate::{
    error::{AppError, AppResult},
    paths,
    state::{resolve_in_root, AppState},
};
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;

// Bounded small-stack threads per running service; no runtime, watcher, file cache or timer when unused.
const FIRST_PORT: u16 = 5500;
const MAX_SERVERS: usize = 16;
const MAX_WINDOW_SERVERS: usize = 8;
const HEADER_LIMIT: usize = 8 * 1024;
const TRANSFER_BUFFER: usize = 32 * 1024;
const WORKER_STACK: usize = 256 * 1024;
const HTTP_WORKERS: usize = 2;
const QUEUED_CONNECTIONS: usize = 16;
const IO_TIMEOUT: Duration = Duration::from_secs(2);
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveInfo {
    pub id: String,
    pub root: String,
    pub rel: String,
    pub port: u16,
    pub url: String,
}

struct Server {
    info: LiveInfo,
    owner: String,
    root: PathBuf,
    file: PathBuf,
    stop: AtomicBool,
    revision: AtomicU64,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl Server {
    fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
        // Wake blocking accept without a periodic polling loop.
        let _ = TcpStream::connect_timeout(&([127, 0, 0, 1], self.info.port).into(), IO_TIMEOUT);
    }
    fn join(&self) {
        if let Some(worker) = self.worker.lock().take() {
            let _ = worker.join();
        }
    }
}

#[derive(Default)]
pub struct LiveRegistry {
    servers: Mutex<HashMap<String, Arc<Server>>>,
}
impl Drop for LiveRegistry {
    fn drop(&mut self) {
        self.stop_matching(None, None);
    }
}

impl LiveRegistry {
    fn start(&self, owner: &str, root: PathBuf, rel: &str) -> AppResult<LiveInfo> {
        let path = if root.is_file() {
            if !rel.is_empty() {
                return Err(AppError::c("path.invalidEmpty"));
            }
            root.clone()
        } else {
            resolve_in_root(&root, rel)?
        };
        if !matches!(
            path.extension()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("html" | "htm")
        ) {
            return Err(AppError::c("live.notHtml"));
        }
        let file = paths::canon(&path)?;
        if !paths::is_inside(&root, &file) || !file.is_file() {
            return Err(AppError::c("live.notHtml"));
        }
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(AppError::c("fs.symlinkUnsupported"));
        }
        let mut servers = self.servers.lock();
        servers.retain(|_, server| !server.stop.load(Ordering::Acquire));
        if let Some(server) = servers
            .values()
            .find(|server| server.owner == owner && server.file == file)
        {
            return Ok(server.info.clone());
        }
        if servers.len() >= MAX_SERVERS
            || servers
                .values()
                .filter(|server| server.owner == owner)
                .count()
                >= MAX_WINDOW_SERVERS
        {
            return Err(AppError::c("live.limit"));
        }
        let listener = bind_listener(FIRST_PORT)
            .map_err(|e| AppError::p("live.startFailed", [("error", e.to_string())]))?;
        let port = listener.local_addr()?.port();
        let id = format!(
            "{:x}-{:x}-{:x}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let served_rel = if root.is_file() {
            file.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("index.html")
                .to_owned()
        } else {
            rel.replace('\\', "/")
        };
        let info = LiveInfo {
            id: id.clone(),
            root: root.to_string_lossy().into_owned(),
            rel: rel.to_owned(),
            port,
            url: format!("http://127.0.0.1:{port}/{id}/{}", encode_path(&served_rel)),
        };
        let server = Arc::new(Server {
            info: info.clone(),
            owner: owner.to_owned(),
            root,
            file,
            stop: AtomicBool::new(false),
            revision: AtomicU64::new(0),
            worker: Mutex::new(None),
        });
        let worker_server = server.clone();
        let worker = thread::Builder::new()
            .name(format!("tide-live-{port}"))
            .stack_size(WORKER_STACK)
            .spawn(move || {
                // A bounded pool prevents idle browser preconnections or large media from blocking CSS/JS.
                let (sender, receiver) =
                    std::sync::mpsc::sync_channel::<TcpStream>(QUEUED_CONNECTIONS);
                let receiver = Arc::new(Mutex::new(receiver));
                let mut workers = Vec::new();
                for index in 0..HTTP_WORKERS {
                    let receiver = receiver.clone();
                    let server = worker_server.clone();
                    match thread::Builder::new()
                        .name(format!("tide-http-{port}-{index}"))
                        .stack_size(WORKER_STACK)
                        .spawn(move || loop {
                            let connection = receiver.lock().recv();
                            if server.stop.load(Ordering::Acquire) {
                                break;
                            }
                            match connection {
                                Ok(mut stream) => {
                                    let _ = serve(&server, &mut stream);
                                }
                                Err(_) => break,
                            }
                        }) {
                        Ok(worker) => workers.push(worker),
                        Err(_) => {
                            worker_server.stop.store(true, Ordering::Release);
                            break;
                        }
                    }
                }
                if !worker_server.stop.load(Ordering::Acquire) {
                    for connection in listener.incoming() {
                        if worker_server.stop.load(Ordering::Acquire) {
                            break;
                        }
                        match connection {
                            Ok(stream) => {
                                if let Err(std::sync::mpsc::TrySendError::Full(mut stream)) =
                                    sender.try_send(stream)
                                {
                                    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
                                    let _ = response(
                                        &mut stream,
                                        "503 Service Unavailable",
                                        b"Preview is busy; retry shortly",
                                        false,
                                    );
                                }
                            }
                            Err(error)
                                if matches!(
                                    error.kind(),
                                    io::ErrorKind::Interrupted | io::ErrorKind::ConnectionAborted
                                ) =>
                            {
                                continue
                            }
                            Err(_) => break,
                        }
                    }
                }
                drop(sender);
                for worker in workers {
                    let _ = worker.join();
                }
                worker_server.stop.store(true, Ordering::Release);
            })
            .map_err(|e| AppError::p("live.startFailed", [("error", e.to_string())]))?;
        *server.worker.lock() = Some(worker);
        servers.insert(id, server);
        Ok(info)
    }
    fn list(&self, owner: &str) -> Vec<LiveInfo> {
        let mut list: Vec<_> = self
            .servers
            .lock()
            .values()
            .filter(|server| server.owner == owner && !server.stop.load(Ordering::Acquire))
            .map(|server| server.info.clone())
            .collect();
        list.sort_by_key(|info| info.port);
        list
    }
    fn owned(&self, owner: &str, id: &str) -> AppResult<Arc<Server>> {
        self.servers
            .lock()
            .get(id)
            .filter(|server| server.owner == owner && !server.stop.load(Ordering::Acquire))
            .cloned()
            .ok_or_else(|| AppError::c("live.notRunning"))
    }
    fn stop(&self, owner: &str, id: &str) -> AppResult<()> {
        let server = self.owned(owner, id)?;
        self.servers.lock().remove(id);
        server.request_stop();
        server.join();
        Ok(())
    }
    pub fn stop_matching(&self, owner: Option<&str>, root: Option<&Path>) {
        let mut servers = self.servers.lock();
        let ids: Vec<_> = servers
            .iter()
            .filter(|(_, server)| {
                owner.is_none_or(|owner| server.owner == owner)
                    && root.is_none_or(|root| server.root == root)
            })
            .map(|(id, _)| id.clone())
            .collect();
        let stopped: Vec<_> = ids
            .into_iter()
            .filter_map(|id| servers.remove(&id))
            .collect();
        drop(servers);
        for server in &stopped {
            server.request_stop();
        }
        for server in stopped {
            server.join();
        }
    }
    pub fn notify(&self, root: &str) {
        for server in self.servers.lock().values() {
            if server.info.root == root {
                server.revision.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

fn bind_listener(first: u16) -> io::Result<TcpListener> {
    for port in first..=u16::MAX {
        match TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], port))) {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AddrInUse,
        "No free loopback port",
    ))
}
fn encode_path(path: &str) -> String {
    let mut result = String::new();
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-_.~".contains(&byte) {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}
fn decode_path(path: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut input = path.as_bytes().iter();
    while let Some(&byte) = input.next() {
        if byte == b'%' {
            let a = (*input.next()? as char).to_digit(16)?;
            let b = (*input.next()? as char).to_digit(16)?;
            bytes.push((a * 16 + b) as u8);
        } else {
            bytes.push(byte);
        }
    }
    let decoded = String::from_utf8(bytes).ok()?;
    if decoded.contains(['\\', '\0']) {
        return None;
    }
    if Path::new(&decoded).components().any(
        |part| !matches!(part, Component::Normal(name) if !name.to_string_lossy().starts_with('.')),
    ) {
        return None;
    }
    Some(decoded)
}
fn header(stream: &mut TcpStream, status: &str, mime: &str, size: u64) -> io::Result<()> {
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {size}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n")
}
fn response(stream: &mut TcpStream, status: &str, content: &[u8], head: bool) -> io::Result<()> {
    header(
        stream,
        status,
        "text/plain; charset=utf-8",
        content.len() as u64,
    )?;
    if !head {
        stream.write_all(content)?;
    }
    Ok(())
}
fn serve(server: &Server, stream: &mut TcpStream) -> io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let mut request = Vec::new();
    let mut chunk = [0; 512];
    while request.len() < HEADER_LIMIT && !request.windows(4).any(|part| part == b"\r\n\r\n") {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        request.extend_from_slice(&chunk[..read]);
    }
    if request.len() >= HEADER_LIMIT {
        return response(
            stream,
            "431 Request Header Fields Too Large",
            b"Request too large",
            false,
        );
    }
    let Ok(text) = std::str::from_utf8(&request) else {
        return response(stream, "400 Bad Request", b"Invalid request", false);
    };
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let method = first.next().unwrap_or_default();
    let target = first.next().unwrap_or_default();
    let head = method == "HEAD";
    if method != "GET" && !head {
        return response(stream, "405 Method Not Allowed", b"GET and HEAD only", head);
    }
    let host = lines.find_map(|line| {
        line.split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
            .map(|(_, value)| value.trim())
    });
    let expected = format!("127.0.0.1:{}", server.info.port);
    let localhost = format!("localhost:{}", server.info.port);
    if host != Some(expected.as_str()) && host != Some(localhost.as_str()) {
        return response(stream, "403 Forbidden", b"Loopback host required", head);
    }
    let prefix = format!("/{}/", server.info.id);
    let requested = target.split('?').next().unwrap_or_default();
    let raw = requested
        .strip_prefix(&prefix)
        .or_else(|| requested.strip_prefix('/'))
        .unwrap_or_default();
    if raw == "_tide/revision" {
        let metadata = fs::metadata(&server.file)?;
        let stamp = metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        return response(
            stream,
            "200 OK",
            format!(
                "{}-{stamp}-{}",
                server.revision.load(Ordering::Relaxed),
                metadata.len()
            )
            .as_bytes(),
            head,
        );
    }
    if raw == "_tide/client.js" {
        let script = format!("(()=>{{let revision;let busy=false;async function poll(){{if(document.hidden||busy)return;busy=true;try{{const r=await fetch('/{}/_tide/revision',{{cache:'no-store'}});if(!r.ok)return;const v=await r.text();if(revision!==undefined&&revision!==v)location.reload();revision=v;}}catch{{}}finally{{busy=false;}}}}poll();setInterval(poll,1000);document.addEventListener('visibilitychange',poll);}})();", server.info.id);
        header(
            stream,
            "200 OK",
            "text/javascript; charset=utf-8",
            script.len() as u64,
        )?;
        if !head {
            stream.write_all(script.as_bytes())?;
        }
        return Ok(());
    }
    let Some(rel) = decode_path(raw) else {
        return response(stream, "403 Forbidden", b"Invalid path", head);
    };
    let mut path = if server.root.is_file() {
        if server.file.file_name().and_then(|name| name.to_str()) != Some(rel.as_str()) {
            return response(
                stream,
                "404 Not Found",
                b"Open the containing folder to preview assets",
                head,
            );
        }
        server.file.clone()
    } else {
        server.root.join(rel)
    };
    if path.is_dir() {
        path = path.join("index.html");
    }
    let Ok(canonical) = paths::canon(&path) else {
        return response(stream, "404 Not Found", b"File not found", head);
    };
    if !paths::is_inside(&server.root, &canonical)
        || fs::symlink_metadata(&path)?.file_type().is_symlink()
        || !canonical.is_file()
    {
        return response(stream, "403 Forbidden", b"File unavailable", head);
    }
    let mut file = fs::File::open(&canonical)?;
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    };
    let injection = if matches!(extension.as_str(), "html" | "htm") {
        format!(
            "\n<script src=\"/{}/_tide/client.js\"></script>\n",
            server.info.id
        )
    } else {
        String::new()
    };
    header(
        stream,
        "200 OK",
        mime,
        file.metadata()?.len() + injection.len() as u64,
    )?;
    if head {
        return Ok(());
    }
    let mut buffer = [0; TRANSFER_BUFFER];
    loop {
        if server.stop.load(Ordering::Acquire) {
            break;
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        stream.write_all(&buffer[..read])?;
    }
    stream.write_all(injection.as_bytes())
}

#[tauri::command(async)]
pub fn live_start(
    window: tauri::Window,
    state: State<'_, AppState>,
    root: String,
    rel: String,
) -> AppResult<LiveInfo> {
    let root = state.authorize_window(window.label(), &root)?;
    state.live.start(window.label(), root, &rel)
}
#[tauri::command(async)]
pub fn live_list(window: tauri::Window, state: State<'_, AppState>) -> Vec<LiveInfo> {
    state.live.list(window.label())
}
#[tauri::command(async)]
pub fn live_stop(window: tauri::Window, state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.live.stop(window.label(), &id)
}
#[tauri::command(async)]
pub fn live_stop_all(window: tauri::Window, state: State<'_, AppState>) {
    state.live.stop_matching(Some(window.label()), None);
}
#[tauri::command(async)]
pub fn live_open(window: tauri::Window, state: State<'_, AppState>, id: String) -> AppResult<()> {
    let server = state.live.owned(window.label(), &id)?;
    #[cfg(windows)]
    let open = crate::proc::command("rundll32")
        .args(["url.dll,FileProtocolHandler", &server.info.url])
        .status();
    #[cfg(not(windows))]
    let open = crate::update::open_in_browser(&server.info.url);
    let status = open.map_err(|e| AppError::p("update.openFailed", [("error", e.to_string())]))?;
    if !status.success() {
        return Err(AppError::c("update.openFailedStatus"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tide-live-test-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("index.html"), "<html><body>Hello</body></html>").unwrap();
        fs::write(path.join("style.css"), "body { color: red }").unwrap();
        paths::canon(&path).unwrap()
    }
    fn get(info: &LiveInfo, path: &str, host: &str) -> String {
        let mut stream =
            TcpStream::connect(std::net::SocketAddr::from(([127, 0, 0, 1], info.port))).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }
    #[test]
    fn binds_next_available_port_without_check_then_bind_race() {
        let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = occupied.local_addr().unwrap().port();
        if port < u16::MAX {
            assert!(bind_listener(port).unwrap().local_addr().unwrap().port() > port);
        }
    }
    #[test]
    fn isolates_owners_reuses_same_file_and_streams_assets_with_reload() {
        let root = fixture();
        let registry = LiveRegistry::default();
        let one = registry.start("one", root.clone(), "index.html").unwrap();
        assert_eq!(
            registry
                .start("one", root.clone(), "index.html")
                .unwrap()
                .id,
            one.id
        );
        let two = registry.start("two", root.clone(), "index.html").unwrap();
        assert_ne!(one.port, two.port);
        assert!(registry.owned("two", &one.id).is_err());
        let host = format!("127.0.0.1:{}", one.port);
        let html = get(&one, &format!("/{}/index.html", one.id), &host);
        assert!(html.starts_with("HTTP/1.1 200"));
        assert!(html.contains("Hello"));
        assert!(html.contains("_tide/client.js"));
        assert!(get(&one, "/style.css", &host).ends_with("body { color: red }"));
        assert!(
            get(&one, &format!("/{}/%2e%2e/private", one.id), &host).starts_with("HTTP/1.1 403")
        );
        assert!(get(&one, "/.env", &host).starts_with("HTTP/1.1 403"));
        assert!(get(&one, "/index.html", "evil.example").starts_with("HTTP/1.1 403"));
        let revision = get(&one, &format!("/{}/_tide/revision", one.id), &host);
        registry.notify(&one.root);
        assert_ne!(
            revision,
            get(&one, &format!("/{}/_tide/revision", one.id), &host)
        );
        registry.stop_matching(Some("one"), Some(&root));
        assert!(registry.list("one").is_empty());
        assert_eq!(registry.list("two").len(), 1);
        registry.stop_matching(None, None);
        fs::remove_dir_all(root).unwrap();
    }
}

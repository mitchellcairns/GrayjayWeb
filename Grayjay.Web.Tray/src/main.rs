//! Grayjay Web tray app: a small taskbar/menu-bar icon that runs the Grayjay server in the background,
//! opens the web app already signed in on this computer, pairs phones by QR code, and turns on
//! remote access through Tailscale. Users never need a terminal or Docker.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

const DEFAULT_PORT: u16 = 11338;
const APP_NAME: &str = "Grayjay Web";

#[derive(Debug, Clone)]
enum Status {
    Starting,
    Running,
    Restarting(String),
    Failed(String),
}

#[derive(Debug)]
enum UserEvent {
    Menu(MenuEvent),
    Status(Status),
    Remote(Remote),
}

/// Where remote access (Tailscale Serve) stands, from "not installed" to "on".
#[derive(Debug, Clone, PartialEq)]
enum Remote {
    NotInstalled,
    /// Installed, but logged out or disconnected (BackendState other than "Running").
    NotConnected(String),
    /// Connected, but HTTPS certificates are off for the tailnet, so Serve can't get a certificate.
    NoHttps { dns: String },
    Off { dns: String },
    On { url: String },
}

struct Server {
    exe: PathBuf,
    port: u16,
    secret: String,
    data_dir: Option<PathBuf>,
    child: Mutex<Option<Child>>,
    quitting: AtomicBool,
}

impl Server {
    fn spawn(&self) -> std::io::Result<Child> {
        let log_path = log_dir().join("server.log");
        let log = std::fs::File::create(&log_path)?;
        let mut cmd = Command::new(&self.exe);
        cmd.env("GRAYJAY_PORT", self.port.to_string())
            .env("GRAYJAY_LOCAL_SECRET", &self.secret)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        if let Some(dir) = &self.data_dir {
            cmd.env("GRAYJAY_DATA_DIR", dir);
        }
        if let Some(dir) = self.exe.parent() {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.spawn()
    }

    fn kill(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// URL that signs this computer's browser in (local secret → session cookie) and then opens `next`.
    fn local_url(&self, next: &str) -> String {
        format!("{}/auth/Local?secret={}&next={}", self.base(), self.secret, url_encode(next))
    }
}

fn main() {
    let port = std::env::var("GRAYJAY_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);

    let Some(exe) = find_server_exe() else {
        show_error("Couldn't find the Grayjay server (GrayjayWebServer) next to the tray app. Reinstall Grayjay Web.");
        return;
    };

    // If something already answers on the port (another copy of the tray app), don't start a second server.
    if http_status(port, "/auth/Status").is_some() {
        show_error(&format!("Grayjay Web is already running on port {port}. Use its icon in the system tray."));
        return;
    }

    let server = Arc::new(Server {
        exe,
        port,
        secret: random_secret(),
        data_dir: std::env::var_os("GRAYJAY_DATA_DIR").map(PathBuf::from),
        child: Mutex::new(None),
        quitting: AtomicBool::new(false),
    });

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    {
        let proxy = Mutex::new(proxy.clone());
        MenuEvent::set_event_handler(Some(Arc::new(move |e: MenuEvent| {
            let _ = proxy.lock().unwrap().send_event(UserEvent::Menu(e));
        })));
    }

    // ---- Menu ----
    let status_item = MenuItem::new("Starting…", false, None);
    let open_item = MenuItem::new("Open Grayjay", true, None);
    let pair_item = MenuItem::new("Pair a phone…", true, None);
    let remote_status = MenuItem::new("Not set up", false, None);
    let remote_on = MenuItem::new("Turn on (Tailscale)", true, None);
    let remote_off = MenuItem::new("Turn off", false, None);
    let remote_copy = MenuItem::new("Open remote address", false, None);
    let remote_help = MenuItem::new("What is this?", true, None);
    let remote_menu = Submenu::with_items(
        "Remote access",
        true,
        &[&remote_status, &PredefinedMenuItem::separator(), &remote_on, &remote_off, &remote_copy, &remote_help],
    )
    .unwrap();
    let autostart = auto_launcher();
    let autostart_item = CheckMenuItem::new(
        "Start when I sign in",
        autostart.is_some(),
        autostart.as_ref().and_then(|a| a.is_enabled().ok()).unwrap_or(false),
        None,
    );
    let logs_item = MenuItem::new("Show logs", true, None);
    let restart_item = MenuItem::new("Restart server", true, None);
    let quit_item = MenuItem::new("Quit Grayjay", true, None);

    let menu = Menu::new();
    menu.append_items(&[
        &status_item,
        &PredefinedMenuItem::separator(),
        &open_item,
        &pair_item,
        &remote_menu,
        &PredefinedMenuItem::separator(),
        &autostart_item,
        &logs_item,
        &restart_item,
        &PredefinedMenuItem::separator(),
        &quit_item,
    ])
    .unwrap();

    supervise(server.clone(), proxy.clone());
    refresh_remote(server.port, proxy.clone());
    // Re-check now and then: Tailscale may be installed, signed in or reconfigured while the tray runs.
    {
        let port = server.port;
        let proxy = proxy.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(20));
            refresh_remote(port, proxy.clone());
        });
    }

    let mut tray: Option<TrayIcon> = None;
    let mut remote = Remote::NotInstalled;
    let mut opened_once = false;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                tray = Some(
                    TrayIconBuilder::new()
                        .with_menu(Box::new(menu.clone()))
                        .with_tooltip(format!("{APP_NAME} — starting"))
                        .with_icon(load_icon())
                        .build()
                        .expect("failed to create tray icon"),
                );
            }
            Event::UserEvent(UserEvent::Status(status)) => {
                let (text, tip) = match &status {
                    Status::Starting => ("Starting…".to_string(), format!("{APP_NAME} — starting")),
                    Status::Running => (format!("Running on port {}", server.port), format!("{APP_NAME} — running")),
                    Status::Restarting(why) => (format!("Restarting ({why})"), format!("{APP_NAME} — restarting")),
                    Status::Failed(why) => (format!("Stopped: {why}"), format!("{APP_NAME} — stopped")),
                };
                status_item.set_text(text);
                if let Some(t) = &tray {
                    let _ = t.set_tooltip(Some(tip));
                }
                // First launch: open the app so people see it's working.
                if matches!(status, Status::Running) && !opened_once {
                    opened_once = true;
                    if std::env::var_os("GRAYJAY_TRAY_NO_OPEN").is_none() && !first_run_marker_exists() {
                        let _ = open::that(server.local_url("/app/settings?pair=1"));
                        write_first_run_marker();
                    }
                }
            }
            Event::UserEvent(UserEvent::Remote(state)) => {
                if state == remote {
                    return;
                }
                remote = state;
                let (status, action, on, off, open) = match &remote {
                    Remote::NotInstalled => ("Tailscale isn't installed".to_string(), "Install Tailscale…", true, false, false),
                    Remote::NotConnected(s) => (format!("Tailscale isn't connected ({s}): open it and sign in"), "Open Tailscale…", true, false, false),
                    Remote::NoHttps { dns } => (format!("One step left for {dns}: turn on HTTPS certificates"), "Turn on HTTPS certificates…", true, false, false),
                    Remote::Off { dns } => (format!("Off. This PC is {dns}"), "Turn on (Tailscale)", true, false, false),
                    Remote::On { url } => (format!("On: {url}"), "Turn on (Tailscale)", false, true, true),
                };
                remote_status.set_text(status);
                remote_on.set_text(action);
                remote_on.set_enabled(on);
                remote_off.set_enabled(off);
                remote_copy.set_enabled(open);
            }
            Event::UserEvent(UserEvent::Menu(e)) => {
                let id = e.id;
                if id == open_item.id() {
                    let _ = open::that(server.local_url("/app/"));
                } else if id == pair_item.id() {
                    let _ = open::that(server.local_url("/app/settings?pair=1"));
                } else if id == remote_on.id() {
                    match &remote {
                        Remote::NotInstalled => {
                            let _ = open::that("https://tailscale.com/download");
                        }
                        Remote::NotConnected(_) => open_tailscale_app(),
                        Remote::NoHttps { .. } => {
                            // Admin console → DNS → HTTPS Certificates → Enable (MagicDNS must be on too).
                            let _ = open::that("https://login.tailscale.com/admin/dns");
                            show_info("In the Tailscale admin console that just opened, under DNS: make sure MagicDNS is on, then click Enable under HTTPS Certificates.\n\nThen come back and choose Remote access → Turn on. Grayjay notices the change within about 20 seconds.");
                        }
                        Remote::Off { .. } | Remote::On { .. } => {
                            let port = server.port;
                            let proxy = proxy.clone();
                            std::thread::spawn(move || {
                                if let Err(err) = tailscale_serve(port, true) {
                                    show_error(&format!("Couldn't turn on remote access:\n\n{err}"));
                                }
                                refresh_remote(port, proxy);
                            });
                        }
                    }
                } else if id == remote_off.id() {
                    let port = server.port;
                    let proxy = proxy.clone();
                    std::thread::spawn(move || {
                        let _ = tailscale_serve(port, false);
                        refresh_remote(port, proxy);
                    });
                } else if id == remote_copy.id() {
                    if let Remote::On { url } = &remote {
                        let _ = open::that(url);
                    }
                } else if id == remote_help.id() {
                    let _ = open::that("https://tailscale.com/kb/1312/serve");
                } else if id == autostart_item.id() {
                    if let Some(a) = &autostart {
                        let want = autostart_item.is_checked();
                        let _ = if want { a.enable() } else { a.disable() };
                        autostart_item.set_checked(a.is_enabled().unwrap_or(want));
                    }
                } else if id == logs_item.id() {
                    let _ = open::that(log_dir());
                } else if id == restart_item.id() {
                    server.kill(); // the supervisor restarts it
                } else if id == quit_item.id() {
                    server.quitting.store(true, Ordering::SeqCst);
                    server.kill();
                    tray.take();
                    *control_flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
}

/// Starts the server and restarts it if it exits unexpectedly (with backoff, giving up after repeated crashes).
fn supervise(server: Arc<Server>, proxy: EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || {
        let mut recent_crashes: Vec<Instant> = Vec::new();
        loop {
            let _ = proxy.send_event(UserEvent::Status(Status::Starting));
            match server.spawn() {
                Ok(child) => {
                #[cfg(windows)]
                job::assign(&child);
                *server.child.lock().unwrap() = Some(child);
            }
                Err(e) => {
                    let _ = proxy.send_event(UserEvent::Status(Status::Failed(format!("couldn't start: {e}"))));
                    return;
                }
            }

            // Wait until it answers, then report running. If it never answers, say so instead of "Starting…" forever.
            let started = Instant::now();
            let mut ready = false;
            while started.elapsed() < Duration::from_secs(90) {
                if server.quitting.load(Ordering::SeqCst) {
                    return;
                }
                if http_status(server.port, "/auth/Status") == Some(200) {
                    let _ = proxy.send_event(UserEvent::Status(Status::Running));
                    ready = true;
                    break;
                }
                if exited(&server) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(400));
            }
            if !ready && !exited(&server) {
                let _ = proxy.send_event(UserEvent::Status(Status::Failed("not responding — see Show logs".into())));
            }

            // Wait for exit.
            loop {
                if server.quitting.load(Ordering::SeqCst) {
                    return;
                }
                if exited(&server) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            if server.quitting.load(Ordering::SeqCst) {
                return;
            }

            recent_crashes.retain(|t| t.elapsed() < Duration::from_secs(120));
            recent_crashes.push(Instant::now());
            if recent_crashes.len() >= 5 {
                let _ = proxy.send_event(UserEvent::Status(Status::Failed("crashed repeatedly — see logs".into())));
                return;
            }
            let _ = proxy.send_event(UserEvent::Status(Status::Restarting("server exited".into())));
            std::thread::sleep(Duration::from_secs(2 * recent_crashes.len() as u64));
        }
    });
}

fn exited(server: &Server) -> bool {
    let mut guard = server.child.lock().unwrap();
    match guard.as_mut() {
        None => true,
        Some(child) => match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                true
            }
            Ok(None) => false,
            Err(_) => true,
        },
    }
}

/// Minimal HTTP GET against the local server, returning the status code.
fn http_status(port: u16, path: &str) -> Option<u16> {
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().ok()?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).ok()?;
    let head = std::str::from_utf8(&buf[..n]).ok()?;
    head.split_whitespace().nth(1)?.parse().ok()
}

// ---------------- Tailscale ----------------

fn tailscale_exe() -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![
            PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Tailscale\tailscale.exe"),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
            PathBuf::from("/usr/local/bin/tailscale"),
            PathBuf::from("/opt/homebrew/bin/tailscale"),
        ]
    } else {
        vec![PathBuf::from("/usr/bin/tailscale"), PathBuf::from("/usr/local/bin/tailscale"), PathBuf::from("/usr/sbin/tailscale")]
    };
    candidates.into_iter().find(|p| p.exists()).or_else(|| which("tailscale"))
}

fn tailscale_cmd() -> Option<Command> {
    let mut c = Command::new(tailscale_exe()?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    Some(c)
}

/// Runs a tailscale command, giving up after `timeout` (some commands wait for approval in a browser). Returns
/// (finished, success, stdout, stderr).
fn run_tailscale(args: &[&str], timeout: Duration) -> Result<(bool, bool, String, String), String> {
    let mut child = tailscale_cmd()
        .ok_or("Tailscale isn't installed")?
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = Arc::new(Mutex::new(String::new()));
    let stderr = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        readers.push(spawn_reader(out, stdout.clone()));
    }
    if let Some(err) = child.stderr.take() {
        readers.push(spawn_reader(err, stderr.clone()));
    }
    let start = Instant::now();
    let status = loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(st);
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(150));
    };
    for r in readers {
        let _ = r.join();
    }
    let out = stdout.lock().unwrap().clone();
    let err = stderr.lock().unwrap().clone();
    Ok((status.is_some(), status.is_some_and(|s| s.success()), out, err))
}

fn spawn_reader<R: std::io::Read + Send + 'static>(mut r: R, into: Arc<Mutex<String>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = r.read_to_string(&mut buf);
        into.lock().unwrap().push_str(&buf);
    })
}

/// Uses `tailscale serve` to publish the server at https://<machine>.<tailnet>.ts.net with a real certificate.
fn tailscale_serve(port: u16, on: bool) -> Result<(), String> {
    let target = format!("http://127.0.0.1:{port}");
    let args: Vec<&str> = if on { vec!["serve", "--bg", "--https=443", &target] } else { vec!["serve", "--https=443", "off"] };
    let (finished, ok, out, err) = run_tailscale(&args, Duration::from_secs(20))?;
    let text = format!("{out}
{err}");
    // Serve not yet allowed on the tailnet: the CLI prints an approval link and waits. Open it for the user.
    if let Some(link) = text.split_whitespace().find(|w| w.starts_with("https://login.tailscale.com/")) {
        let _ = open::that(link.trim_end_matches(['.', ',']));
        return Err("Tailscale needs you to allow this once in the browser window that just opened. Approve it, then choose Remote access → Turn on again.".into());
    }
    if !finished {
        return Err("Tailscale didn't respond. Make sure it's running and you're signed in.".into());
    }
    if ok { Ok(()) } else { Err(text.trim().to_string()) }
}

fn remote_state(port: u16) -> Remote {
    if tailscale_exe().is_none() {
        return Remote::NotInstalled;
    }
    let status = run_tailscale(&["status", "--json"], Duration::from_secs(8))
        .ok()
        .and_then(|(_, _, out, _)| serde_json::from_str::<serde_json::Value>(out.trim_start_matches(|c: char| c != '{')).ok());
    let Some(status) = status else {
        return Remote::NotConnected("not running".into());
    };
    let backend = status.get("BackendState").and_then(|v| v.as_str()).unwrap_or("unknown");
    if backend != "Running" {
        let reason = match backend {
            "NeedsLogin" => "signed out",
            "Stopped" => "turned off",
            "NeedsMachineAuth" => "waiting for admin approval",
            other => other,
        };
        return Remote::NotConnected(reason.to_string());
    }
    let dns = status
        .pointer("/Self/DNSName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim_end_matches('.')
        .to_string();
    if let Some(url) = serve_url(port) {
        return Remote::On { url };
    }
    let https = status.get("CertDomains").and_then(|v| v.as_array()).is_some_and(|a| !a.is_empty());
    if !https {
        return Remote::NoHttps { dns };
    }
    Remote::Off { dns }
}

/// The public https URL if `tailscale serve` is currently pointing at our port.
fn serve_url(port: u16) -> Option<String> {
    let (_, _, out, _) = run_tailscale(&["serve", "status", "--json"], Duration::from_secs(8)).ok()?;
    let serve: serde_json::Value = serde_json::from_str(out.trim_start_matches(|c: char| c != '{')).ok()?;
    let target = format!("127.0.0.1:{port}");
    let web = serve.get("Web")?.as_object()?;
    let host = web.iter().find_map(|(hostport, cfg)| {
        let handlers = cfg.get("Handlers")?.as_object()?;
        let points_here = handlers.values().any(|h| h.get("Proxy").and_then(|p| p.as_str()).is_some_and(|p| p.contains(&target)));
        points_here.then(|| hostport.trim_end_matches(":443").to_string())
    })?;
    Some(format!("https://{host}/app/"))
}

fn refresh_remote(port: u16, proxy: EventLoopProxy<UserEvent>) {
    std::thread::spawn(move || {
        let _ = proxy.send_event(UserEvent::Remote(remote_state(port)));
    });
}

fn open_tailscale_app() {
    let gui = if cfg!(windows) {
        Some(PathBuf::from(r"C:\Program Files\Tailscale\tailscale-ipn.exe"))
    } else if cfg!(target_os = "macos") {
        Some(PathBuf::from("/Applications/Tailscale.app"))
    } else {
        None
    };
    match gui.filter(|p| p.exists()) {
        Some(p) => {
            let _ = open::that(p);
        }
        None => {
            let _ = open::that("https://login.tailscale.com/");
        }
    }
}

// ---------------- Helpers ----------------

fn find_server_exe() -> Option<PathBuf> {
    let name = if cfg!(windows) { "GrayjayWebServer.exe" } else { "GrayjayWebServer" };
    if let Some(p) = std::env::var_os("GRAYJAY_SERVER_PATH").map(PathBuf::from) {
        return p.exists().then_some(p);
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let mut candidates = vec![dir.join("server").join(name), dir.join(name)];
    if cfg!(target_os = "macos") {
        candidates.push(dir.join("../Resources/server").join(name));
    }
    candidates.into_iter().find(|p| p.exists())
}

fn which(cmd: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let name = if cfg!(windows) { format!("{cmd}.exe") } else { cmd.to_string() };
    std::env::split_paths(&path).map(|d| d.join(&name)).find(|p| p.is_file())
}

fn random_secret() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("OS random number generator unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn state_dir() -> PathBuf {
    let base = std::env::var_os(if cfg!(windows) { "LOCALAPPDATA" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = if cfg!(windows) {
        base.join("GrayjayWeb")
    } else if cfg!(target_os = "macos") {
        base.join("Library/Application Support/GrayjayWeb")
    } else {
        base.join(".local/state/grayjay-web")
    };
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn log_dir() -> PathBuf {
    let d = state_dir().join("logs");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn first_run_marker() -> PathBuf {
    state_dir().join("first-run-done")
}
fn first_run_marker_exists() -> bool {
    first_run_marker().exists()
}
fn write_first_run_marker() {
    let _ = std::fs::write(first_run_marker(), b"1");
}

fn auto_launcher() -> Option<auto_launch::AutoLaunch> {
    let exe = std::env::current_exe().ok()?;
    auto_launch::AutoLaunchBuilder::new()
        .set_app_name(APP_NAME)
        .set_app_path(exe.to_str()?)
        .build()
        .ok()
}

fn load_icon() -> Icon {
    // Edge-to-edge Grayjay mark (no wordmark) so it stays legible at tray sizes. Windows tray slots are
    // 16–32 px, so a native 32 px render is sharper there than a downscaled 64 px one.
    #[cfg(windows)]
    let bytes: &[u8] = include_bytes!("../assets/icon-32.png");
    #[cfg(not(windows))]
    let bytes: &[u8] = include_bytes!("../assets/icon-64.png");
    let img = image::load_from_memory(bytes).expect("icon").into_rgba8();
    let (w, h) = img.dimensions();
    Icon::from_rgba(img.into_raw(), w, h).expect("icon rgba")
}

fn show_error(message: &str) {
    show_message(message, 0x10);
}

/// Non-blocking information box (its own thread, so the tray menu keeps working while it's open).
fn show_info(message: &str) {
    let message = message.to_string();
    std::thread::spawn(move || show_message(&message, 0x40));
}

fn show_message(message: &str, icon: u32) {
    #[cfg(windows)]
    {
        // MessageBoxW without pulling in a Windows API crate.
        #[link(name = "user32")]
        unsafe extern "system" {
            fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, utype: u32) -> i32;
        }
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        unsafe {
            MessageBoxW(std::ptr::null_mut(), wide(message).as_ptr(), wide(APP_NAME).as_ptr(), icon);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = icon;
        eprintln!("{APP_NAME}: {message}");
    }
}

/// Windows: put the server in a job object that is killed when the tray process exits for any reason
/// (including being killed from Task Manager), so the server never lingers without its tray icon.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::*;

    struct Job(isize);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<&'static Job> {
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            Some(Job(h as isize))
        })
        .as_ref()
    }

    pub fn assign(child: &std::process::Child) {
        if let Some(j) = job() {
            unsafe {
                AssignProcessToJobObject(j.0 as _, child.as_raw_handle() as _);
            }
        }
    }
}

mod auth;
mod chat_relay;
mod config;
mod dev;
mod dev_join;
mod discord_ipc;
mod engine;
mod flash_timer;
mod game_host;
mod game_stats;
mod graphics;
mod install;
mod net;
mod presence;
mod social;
mod title;
mod update;

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use config::{env_off, is_packaged, normalize_http_url, CachedSession, Paths, ServerList, SessionCache, StateStore};
use engine::{air::AirApp, projector::Projector, Launch};

pub type Bus = Arc<dyn Fn() + Send + Sync>;

const SHIM: &str = include_str!("shim.js");
const WINDOW: &str = "launcher";

#[derive(Clone, Default)]
struct Account {
    linked: bool,
    email: String,
    name: String,
}

#[derive(Default)]
struct Login {
    link: String,
    code_required: bool,
    code_rejected: bool,
    pending_code: String,
}

#[derive(Default)]
struct Live {
    projector: Option<Projector>,
    air: Option<AirApp>,
    graphics: Option<graphics::Detected>,
    game_engine: String,
    game_kill: Option<tokio::sync::oneshot::Sender<()>>,
    login: Option<Login>,
    login_code_ended: bool,
    account: Account,
    remembered: bool,
    server_reachable: Option<bool>,
    account_poll: Option<tauri::async_runtime::JoinHandle<()>>,
    recovery_last: u64,
    dev_bridge: Option<dev_join::Bridge>,
    dev_join_state: String,
    dev_join_error: String,
}

pub struct Launcher {
    app: AppHandle,
    paths: Paths,
    store: StateStore,
    sessions: SessionCache,
    servers: ServerList,
    version: String,
    launcher_on_gpu: bool,
    presence: presence::Presence,
    host: game_host::GameHost,
    stats: game_stats::GameStats,
    social: social::Social,
    chat: chat_relay::ChatRelay,
    updates: update::Updates,
    install: install::InstallLocation,
    dev: dev::DevServer,
    live: Mutex<Live>,
    push_scheduled: AtomicBool,
    last_pushed: Mutex<String>,
}

type L = Arc<Launcher>;

fn engine_for(air: bool, projector: bool) -> &'static str {
    let no_air_runtime = config::PLATFORM == "linux" || config::ARCH == "ia32" || cfg!(feature = "win7");
    if air || (!projector && !no_air_runtime) { "air" } else { "projector" }
}

fn problem(message: impl Into<String>) -> Value {
    json!({ "ok": false, "message": message.into() })
}

impl Launcher {
    fn new(app: AppHandle) -> L {
        let resource = app.path().resource_dir().ok();
        let paths = Paths::new(resource);
        let store = StateStore::new(&paths.data_dir);
        let launcher_on_gpu = store.read().renderer != "cpu";
        let version = app.package_info().version.to_string();
        let exe = std::env::current_exe().unwrap_or_default();
        Arc::new_cyclic(|weak: &std::sync::Weak<Launcher>| {
            let weak = weak.clone();
            let bus: Bus = Arc::new(move || {
                if let Some(l) = weak.upgrade() {
                    l.push();
                }
            });
            let presence = presence::Presence::new(paths.clone(), bus.clone());
            let social = social::Social::new(paths.clone(), bus.clone());
            Launcher {
                sessions: SessionCache::new(paths.data_dir.join("launcher-session.json")),
                servers: config::load_servers(&paths),
                host: game_host::GameHost::new(presence.clone()),
                stats: game_stats::GameStats::new(bus.clone()),
                chat: chat_relay::ChatRelay::new(social.clone(), bus.clone()),
                updates: update::Updates::new(version.clone(), bus.clone()),
                install: install::inspect(&exe),
                dev: dev::DevServer::new(&paths.data_dir, bus.clone()),
                presence,
                social,
                app,
                paths,
                store,
                version,
                launcher_on_gpu,
                live: Mutex::default(),
                push_scheduled: AtomicBool::new(false),
                last_pushed: Mutex::default(),
            }
        })
    }

    fn token(&self) -> String {
        self.sessions.read().token
    }

    fn token_fn(self: &L) -> social::TokenFn {
        let me = self.clone();
        Arc::new(move || me.token())
    }

    fn selected(&self) -> Option<config::Server> {
        let saved = self.store.read().server_id;
        let list = &self.servers.servers;
        list.iter()
            .find(|s| s.id == saved)
            .or_else(|| list.iter().find(|s| s.id == self.servers.default_server_id))
            .or_else(|| list.first())
            .cloned()
    }

    fn locate_engines(&self) {
        let mut air = engine::air::find(&self.paths);
        if let (Some(app), true) = (air.as_mut(), is_packaged()) {
            let check = engine::air::verify(&app.path);
            app.tampered = !check.ok;
            app.tamper_reason = check.reason;
        }
        let projector = self.locate_projector(&self.store.read().projector_path);
        match &air {
            Some(a) => println!("[AIR] {}{}", a.executable.display(), if a.tampered { format!(" REFUSED: {}", a.tamper_reason) } else { String::new() }),
            None => println!("[AIR] No AIR engine in this build."),
        }
        match &projector {
            Some(p) => println!("[Flash] {} Flash Player {} at {}", p.source, if p.version.is_empty() { "(version unknown)" } else { &p.version }, p.path.display()),
            None => println!("[Flash] No standalone Flash Player found."),
        }
        let mut live = self.live.lock().unwrap();
        live.air = air;
        live.projector = projector;
    }

    fn locate_projector(&self, preferred: &str) -> Option<Projector> {
        if is_packaged() {
            let mut found = engine::projector::find(&self.paths, "", true)?;
            let check = engine::projector::verify(&found.path);
            found.tampered = !check.ok;
            found.tamper_reason = check.reason;
            return Some(found);
        }
        engine::projector::find(&self.paths, preferred, false)
    }

    fn preferred_engine(&self) -> &'static str {
        let live = self.live.lock().unwrap();
        engine_for(live.air.is_some(), live.projector.is_some())
    }

    fn engine_problem(&self, engine: &str) -> String {
        let live = self.live.lock().unwrap();
        if engine == "air" {
            return match &live.air {
                None if is_packaged() => "The AIR engine is not part of this install. Reinstall the launcher to play.".into(),
                None => "The AIR engine is missing. Run `npm run build-air` with AIR_SDK_HOME set.".into(),
                Some(a) if a.tampered => format!("{}. Reinstall the launcher to play.", a.tamper_reason),
                Some(_) => String::new(),
            };
        }
        match &live.projector {
            None => "Flash Player is missing. Choose the standalone Flash Player (flashplayer_32_sa) by hand.".into(),
            Some(p) if p.arch_mismatch => format!("Flash Player is a {} program and cannot run on this machine.", p.architectures.join("/")),
            Some(p) if p.tampered => format!("{}. Reinstall the launcher to play.", p.tamper_reason),
            Some(_) => String::new(),
        }
    }

    fn playable(&self) -> bool {
        if !is_packaged() || config::env_is("DUNGEON_BLITZ_ALLOW_NO_FLASH", "1") {
            return true;
        }
        self.engine_problem("air").is_empty() || self.engine_problem("projector").is_empty()
    }

    fn state(&self) -> Value {
        let saved = self.store.read();
        let selected = self.selected();
        let live = self.live.lock().unwrap();
        let resolved = graphics::resolve(&saved.renderer, &saved.graphics_quality, live.graphics.as_ref());
        let social = self.social.snapshot();
        let presence = self.presence.snapshot();
        let flash = match &live.projector {
            None => json!({ "found": false, "armed": false, "locked": is_packaged(), "tampered": false, "path": "", "version": "", "source": "", "architectures": [], "archMismatch": false }),
            Some(p) => json!({
                "found": true, "armed": !p.arch_mismatch && !p.tampered, "locked": is_packaged(), "tampered": p.tampered,
                "path": p.path.to_string_lossy(), "version": p.version, "source": p.source,
                "architectures": p.architectures, "archMismatch": p.arch_mismatch
            }),
        };
        let air = json!({
            "found": live.air.is_some(),
            "ready": live.air.as_ref().map(|a| !a.tampered).unwrap_or(false),
            "tampered": live.air.as_ref().map(|a| a.tampered).unwrap_or(false)
        });
        let engine = engine_for(live.air.is_some(), live.projector.is_some());
        let login = live.login.as_ref();
        let mut chat = serde_json::to_value(self.chat.snapshot()).unwrap();
        chat["enabled"] = json!(!env_off("DUNGEON_BLITZ_CHAT_RELAY"));
        let mut stats = serde_json::to_value(self.stats.snapshot()).unwrap();
        stats["enabled"] = json!(!env_off("DUNGEON_BLITZ_GAME_STATS"));
        json!({
            "appVersion": self.version,
            "servers": self.servers.servers,
            "selectedServerUrl": selected.map(|s| s.url).unwrap_or_default(),
            "serverReachable": live.server_reachable,
            "gameRunning": live.game_kill.is_some(),
            "gameEngine": live.game_engine,
            "engine": engine,
            "windows": { "supported": true, "product": "", "architecture": config::ARCH, "architectureSupported": true, "reason": "", "requirements": "" },
            "flash": flash,
            "air": air,
            "presence": {
                "running": presence.running, "ready": presence.ready, "port": presence.port,
                "characterName": presence.character_name, "activity": presence.activity, "lastError": presence.last_error
            },
            "social": {
                "enabled": !env_off("DUNGEON_BLITZ_SOCIAL") && self.social.available(),
                "running": social.running, "lobbyReady": social.lobby_ready, "authPending": social.auth_pending,
                "lobbyId": social.lobby_id, "lastStatus": social.last_status
            },
            "chat": chat,
            "gameStats": stats,
            "graphics": {
                "renderer": saved.renderer, "quality": saved.graphics_quality,
                "resolvedRenderer": resolved.renderer, "resolvedQuality": resolved.quality,
                "detected": live.graphics.is_some(), "launcherOnGpu": self.launcher_on_gpu
            },
            "dev": {
                "enabled": saved.dev_mode, "serverRoot": saved.dev_server_root, "server": self.dev.summary(),
                "join": {
                    "state": if live.dev_join_state.is_empty() { "idle" } else { live.dev_join_state.as_str() },
                    "error": live.dev_join_error
                },
                "playing": live.dev_bridge.is_some()
            },
            "install": self.install,
            "update": self.updates.summary(),
            "discord": {
                "linked": live.account.linked, "email": live.account.email, "name": live.account.name,
                "remembered": live.remembered,
                "loginPending": login.is_some(),
                "loginLinkAvailable": login.map(|l| !l.link.is_empty()).unwrap_or(false),
                "loginCodeRequired": login.map(|l| l.code_required).unwrap_or(false),
                "loginCodeRejected": login.map(|l| l.code_rejected).unwrap_or(false),
                "loginCodeEnded": login.is_none() && live.login_code_ended
            }
        })
    }

    fn push(self: &L) {
        if self.push_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            me.push_scheduled.store(false, Ordering::SeqCst);
            let Some(window) = me.app.get_webview_window(WINDOW) else {
                me.last_pushed.lock().unwrap().clear();
                return;
            };
            let next = me.state();
            let serialized = next.to_string();
            {
                let mut last = me.last_pushed.lock().unwrap();
                if *last == serialized {
                    return;
                }
                *last = serialized;
            }
            let _ = window.emit("launcher:state", next);
        });
    }

    fn open_external(&self, url: &str) {
        let safe = normalize_http_url(url);
        if !safe.is_empty() {
            let _ = self.app.opener().open_url(safe, None::<&str>);
        }
    }

    fn remember(&self, email: &str, name: &str) {
        let changed = {
            let mut live = self.live.lock().unwrap();
            let email = email.trim().to_string();
            let name = if name.trim().is_empty() { live.account.name.clone() } else { name.trim().to_string() };
            let changed = email != live.account.email || name != live.account.name || !live.account.linked;
            live.account = Account { linked: true, email, name };
            live.remembered = true;
            changed.then(|| live.account.clone())
        };
        if let Some(account) = changed {
            self.store.write(json!({ "discordEmail": account.email, "discordName": account.name, "discordLinkedAt": config::now_ms() }));
        }
    }

    fn restore_login(&self) {
        let saved = self.store.read();
        let cached = self.sessions.read();
        if saved.discord_linked_at <= 0.0 && cached.token.is_empty() {
            return;
        }
        let mut live = self.live.lock().unwrap();
        live.account = Account {
            linked: true,
            email: if cached.email.is_empty() { saved.discord_email } else { cached.email },
            name: saved.discord_name,
        };
        live.remembered = true;
    }

    fn forget_login(self: &L) {
        let cached = self.sessions.read();
        if let (Some(server), false) = (self.selected(), cached.token.is_empty()) {
            let token = cached.token.clone();
            tauri::async_runtime::spawn(async move { auth::forget_session(&server.url, &token).await });
        }
        self.sessions.clear();
        {
            let mut live = self.live.lock().unwrap();
            live.account = Account::default();
            live.remembered = false;
        }
        self.store.write(json!({ "discordEmail": "", "discordName": "", "discordLinkedAt": 0 }));
    }

    async fn resume(self: &L, url: &str) -> bool {
        let cached: CachedSession = self.sessions.read();
        if cached.token.is_empty() {
            return false;
        }
        match auth::resume_session(url, &cached.token).await {
            auth::Resume::Ok(issued) => {
                let email = if issued.email.is_empty() { cached.email } else { issued.email };
                self.sessions.write(&issued.token, &email);
                self.remember(&email, "");
                false
            }
            auth::Resume::Expired => {
                self.sessions.clear();
                {
                    let mut live = self.live.lock().unwrap();
                    live.account = Account::default();
                    live.remembered = false;
                }
                self.store.write(json!({ "discordEmail": "", "discordLinkedAt": 0 }));
                true
            }
            auth::Resume::Unavailable => false,
        }
    }

    async fn capture_from_game_session(self: &L) -> bool {
        if !self.token().is_empty() {
            return false;
        }
        {
            let mut live = self.live.lock().unwrap();
            let now = config::now_ms();
            if now.saturating_sub(live.recovery_last) < 30_000 {
                return false;
            }
            live.recovery_last = now;
        }
        let Some(server) = self.selected() else { return false };
        let Some(issued) = auth::issue_session(&server.url, "").await else { return false };
        self.sessions.write(&issued.token, &issued.email);
        println!("[LauncherSession] Took a device token from the game session's own Discord sign-in");
        true
    }

    async fn refresh_account(self: &L) -> bool {
        let Some(server) = self.selected() else { return false };
        let Some(account) = auth::fetch_discord_account(&server.url).await else { return false };
        if !account.linked {
            return false;
        }
        let current = self.live.lock().unwrap().account.clone();
        let name = [account.global_name.as_str(), account.username.as_str(), current.name.as_str()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_string();
        if !current.linked || name != current.name || account.email != current.email {
            self.remember(&account.email, &name);
            self.push();
        }
        self.capture_from_game_session().await
    }

    fn start_account_polling(self: &L) {
        self.stop_account_polling();
        self.live.lock().unwrap().recovery_last = 0;
        let me = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            for _ in 0..24 {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if me.refresh_account().await {
                    me.stats.sync(me.token()).await;
                }
            }
        });
        self.live.lock().unwrap().account_poll = Some(handle);
    }

    fn stop_account_polling(&self) {
        if let Some(handle) = self.live.lock().unwrap().account_poll.take() {
            handle.abort();
        }
    }

    async fn end_session_services(&self) {
        self.host.stop().await;
        self.presence.stop().await;
        self.chat.stop();
        self.stats.stop();
    }

    async fn end_game_session(self: &L) {
        {
            let mut live = self.live.lock().unwrap();
            if let Some(mut bridge) = live.dev_bridge.take() {
                bridge.close();
            }
            if live.dev_join_state == "playing" {
                live.dev_join_state.clear();
            }
        }
        self.end_session_services().await;
        self.social.stop();
        self.stop_account_polling();
        match self.app.get_webview_window(WINDOW) {
            Some(window) => {
                let _ = window.show();
            }
            None => self.app.exit(0),
        }
        self.push();
    }

    async fn spawn_game(self: &L, engine: &str, label: &str, launch: Launch) -> Result<u32, String> {
        let mut command = tokio::process::Command::new(&launch.command);
        command.args(&launch.args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        if let Some(cwd) = &launch.cwd {
            command.current_dir(cwd);
        }
        for (k, v) in &launch.env {
            command.env(k, v);
        }
        let mut child = command.spawn().map_err(|e| format!("{label} could not be started: {e}"))?;
        let pid = child.id().unwrap_or(0);
        let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
        {
            let mut live = self.live.lock().unwrap();
            live.game_kill = Some(kill_tx);
            live.game_engine = engine.into();
        }
        let me = self.clone();
        let label = label.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::select! {
                status = child.wait() => println!("[{label}] exited ({})", status.map(|s| s.to_string()).unwrap_or_default()),
                _ = kill_rx => { let _ = child.kill().await; }
            }
            {
                let mut live = me.live.lock().unwrap();
                live.game_kill = None;
                live.game_engine.clear();
            }
            me.end_game_session().await;
        });
        Ok(pid)
    }

    fn resolved_graphics(&self) -> graphics::Resolved {
        let saved = self.store.read();
        graphics::resolve(&saved.renderer, &saved.graphics_quality, self.live.lock().unwrap().graphics.as_ref())
    }

    async fn launch_projector(self: &L, url: &str) -> Result<(), String> {
        let projector = self.live.lock().unwrap().projector.clone().ok_or("Flash Player is missing.")?;
        if is_packaged() {
            let check = engine::projector::verify(&projector.path);
            if !check.ok {
                if let Some(p) = self.live.lock().unwrap().projector.as_mut() {
                    p.tampered = true;
                    p.tamper_reason = check.reason.clone();
                }
                return Err(format!("{}. Reinstall the launcher to play.", check.reason));
            }
        }
        let preload = if config::PLATFORM == "linux" { engine::projector::find_flash_preload(&self.paths) } else { None };
        if let (Some(p), true) = (&preload, is_packaged()) {
            let check = engine::projector::verify_flash_preload(&p.directory);
            if !check.ok {
                return Err(format!("{}. Reinstall the launcher to play.", check.reason));
            }
        }
        let swf = engine::projector::resolve_swf_url(url).await;
        let resolved = self.resolved_graphics();
        let render = graphics::projector_render_mode(&resolved, &engine::projector::flash_render_mode());
        let quality = graphics::flash_quality(&resolved.quality);
        let launch = engine::projector::prepare_launch(&projector, &swf, &self.paths.data_dir.join("game"), preload.as_ref(), &render, quality)
            .map_err(|e| format!("Flash Player could not be prepared: {e}"))?;
        println!("[Flash] Render mode: {}, quality: {}", if render.is_empty() { "software" } else { &render }, resolved.quality);
        println!("[Flash] Starting {} {:?} for {swf}", launch.command.display(), launch.args);
        let pid = self.spawn_game("projector", "Flash Player", launch).await?;
        let alive = Arc::new(AtomicBool::new(true));
        flash_timer::boost(pid);
        title::keep_game_title(pid, alive.clone());
        self.watch_alive(alive);
        Ok(())
    }

    fn watch_alive(self: &L, alive: Arc<AtomicBool>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if me.live.lock().unwrap().game_kill.is_none() {
                    alive.store(false, Ordering::Relaxed);
                    return;
                }
            }
        });
    }

    async fn launch_air(self: &L, url: &str) -> Result<(), String> {
        let air = self.live.lock().unwrap().air.clone().ok_or("The AIR engine is missing.")?;
        if is_packaged() {
            let check = engine::air::verify(&air.path);
            if !check.ok {
                if let Some(a) = self.live.lock().unwrap().air.as_mut() {
                    a.tampered = true;
                    a.tamper_reason = check.reason.clone();
                }
                return Err(format!("{}. Reinstall the launcher to play.", check.reason));
            }
        }
        let swf = engine::projector::resolve_swf_url(url).await;
        let launch = engine::air::prepare_launch(&air, &swf, graphics::flash_quality(&self.resolved_graphics().quality));
        println!("[AIR] Starting {} {:?}", launch.command.display(), launch.args);
        self.spawn_game("air", "AIR", launch).await.map(|_| ())
    }

    async fn play(self: &L, requested: &str) -> Value {
        if self.live.lock().unwrap().game_kill.is_some() {
            return json!({ "ok": true });
        }
        let Some(selected) = self.selected() else { return problem("No servers configured. Check servers.json.") };
        let has_projector = self.live.lock().unwrap().projector.is_some();
        let engine = if requested == "projector" && has_projector { "projector" } else { self.preferred_engine() };
        let issue = self.engine_problem(engine);
        if !issue.is_empty() {
            return problem(issue);
        }
        self.store.write(json!({ "serverId": selected.id }));
        if self.resume(&selected.url).await {
            self.push();
            return problem("Your saved sign-in is no longer valid. Sign in with Discord again.");
        }
        let settings = self.store.read();
        if settings.start_discord_bridge {
            self.presence.start(&selected.url).await;
        }
        let social_on = settings.start_social_bridge && !env_off("DUNGEON_BLITZ_SOCIAL");
        if social_on && !env_off("DUNGEON_BLITZ_CHAT_RELAY") {
            self.chat.start(&selected.url);
        }
        if social_on {
            self.social.start(config::base_url(&selected.url), self.token_fn());
        }
        if !env_off("DUNGEON_BLITZ_GAME_STATS") {
            self.stats.start(&selected.url);
            let me = self.clone();
            tauri::async_runtime::spawn(async move {
                me.stats.sync(me.token()).await;
            });
        }
        if self.live.lock().unwrap().graphics.is_none() {
            self.detect_graphics().await;
        }
        let launched = if engine == "air" { self.launch_air(&selected.url).await } else { self.launch_projector(&selected.url).await };
        let result = match launched {
            Ok(()) => {
                self.host.start(&selected.url, settings.start_discord_bridge).await;
                self.start_account_polling();
                json!({ "ok": true })
            }
            Err(message) => {
                self.end_session_services().await;
                problem(message)
            }
        };
        self.push();
        result
    }

    async fn detect_graphics(self: &L) {
        let detected = tauri::async_runtime::spawn_blocking(graphics::detect).await.ok();
        if let Some(d) = &detected {
            println!("[Graphics] Detected: {}, {} tier ({})", if d.gpu { "GPU" } else { "CPU" }, d.tier, d.reason);
        }
        self.live.lock().unwrap().graphics = detected;
        self.push();
    }

    fn discord_login(self: &L) -> Value {
        let Some(server) = self.selected() else { return problem("No server selected.") };
        if self.live.lock().unwrap().login.is_some() {
            return json!({ "ok": true });
        }
        let key = auth::create_login_key();
        let link = auth::login_url(&server.url, &key);
        if normalize_http_url(&link).is_empty() {
            return problem("The sign-in address is not valid.");
        }
        {
            let mut live = self.live.lock().unwrap();
            live.login = Some(Login { link: link.clone(), ..Default::default() });
            live.login_code_ended = false;
        }
        self.open_external(&link);
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let deadline = std::time::Instant::now() + Duration::from_secs(6 * 60);
            let mut signed: Option<String> = None;
            while std::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let code = me.live.lock().unwrap().login.as_mut().map(|l| std::mem::take(&mut l.pending_code)).unwrap_or_default();
                let status = auth::fetch_login_status(&server.url, &key, &code).await;
                if status.signed_in {
                    signed = Some(status.email);
                    break;
                }
                let ended = {
                    let mut live = me.live.lock().unwrap();
                    let Some(login) = live.login.as_mut() else { break };
                    let ended = status.code_rejected && !status.code_required;
                    let rejected = status.code_rejected || (login.code_rejected && status.code_required);
                    let changed = login.code_required != status.code_required || login.code_rejected != rejected;
                    login.code_required = status.code_required;
                    login.code_rejected = rejected;
                    if ended {
                        live.login_code_ended = true;
                    }
                    if changed || ended {
                        me.push();
                    }
                    ended
                };
                if ended {
                    break;
                }
                if let Some(email) = auth::fetch_pending(&server.url).await {
                    signed = Some(email);
                    break;
                }
            }
            me.live.lock().unwrap().login = None;
            let Some(email) = signed else {
                me.stats.sign_in_missed();
                me.push();
                return;
            };
            me.remember(&email, "");
            if let Some(issued) = auth::issue_session(&server.url, &key).await {
                let email = if issued.email.is_empty() { email.clone() } else { issued.email };
                me.sessions.write(&issued.token, &email);
            }
            let running = me.live.lock().unwrap().game_kill.is_some();
            if !running {
                me.play("").await;
            } else if me.stats.snapshot().running {
                // A sign-in started from Sync game stats: the token just saved is what the
                // server was missing.
                if me.token().is_empty() {
                    me.stats.sign_in_missed();
                } else {
                    me.stats.sync(me.token()).await;
                }
            }
            me.push();
        });
        self.push();
        json!({ "ok": true })
    }

    async fn refresh_server_status(self: &L) {
        let reachable = match self.selected() {
            Some(server) => Some(auth::server_reachable(&server.url).await),
            None => None,
        };
        self.live.lock().unwrap().server_reachable = reachable;
        self.push();
    }

    /// A developer game: the bridge to `target` on this machine's game ports, then the AIR engine
    /// on the SWF its page names. None of the player's own session (sign-in, presence, lobby
    /// chat, the widget) starts: a test server is not the server those belong to.
    async fn play_dev(self: &L, target: dev_join::Target, label: &str) -> Value {
        if self.live.lock().unwrap().game_kill.is_some() {
            return problem("The game is already running. Close it first.");
        }
        if self.preferred_engine() != "air" {
            return problem("Developer servers play in the AIR engine, and this build does not carry it.");
        }
        let issue = self.engine_problem("air");
        if !issue.is_empty() {
            return problem(issue);
        }
        let Some(air) = self.live.lock().unwrap().air.clone() else { return problem("The AIR engine is missing.") };
        if is_packaged() {
            let check = engine::air::verify(&air.path);
            if !check.ok {
                return problem(format!("{}. Reinstall the launcher to play.", check.reason));
            }
        }
        let bridge = match dev_join::open_bridge(&target).await {
            Ok(bridge) => bridge,
            Err(message) => return problem(message),
        };
        let swf = engine::projector::resolve_swf_url(&bridge.page_url).await;
        let launch = engine::air::prepare_launch(&air, &swf, graphics::flash_quality(&self.resolved_graphics().quality));
        println!("[Dev] {label}: starting {} {:?}", launch.command.display(), launch.args);
        // Kept before the game starts, so a game that closes at once still closes its bridge.
        self.live.lock().unwrap().dev_bridge = Some(bridge);
        let result = match self.spawn_game("air", "AIR", launch).await {
            Ok(_) => json!({ "ok": true }),
            Err(message) => {
                self.live.lock().unwrap().dev_bridge = None;
                problem(format!("The game could not be started: {message}"))
            }
        };
        self.push();
        result
    }

    async fn join_dev(self: &L, address: &str) -> Value {
        {
            let mut live = self.live.lock().unwrap();
            live.dev_join_state = "joining".into();
            live.dev_join_error.clear();
        }
        self.push();
        let result = match dev_join::resolve_tunnel(address).await {
            Ok(target) => {
                let label = match &target {
                    dev_join::Target::Tunnel { web_host, .. } => format!("join {web_host}"),
                    dev_join::Target::Local => "join".into(),
                };
                self.play_dev(target, &label).await
            }
            Err(message) => problem(message),
        };
        {
            let mut live = self.live.lock().unwrap();
            let ok = result.get("ok") == Some(&json!(true));
            live.dev_join_state = if ok { "playing".into() } else { String::new() };
            live.dev_join_error = if ok { String::new() } else { result.get("message").and_then(Value::as_str).unwrap_or("").to_string() };
        }
        self.push();
        result
    }

    fn dev_off(&self) -> Option<Value> {
        (!self.store.read().dev_mode).then(|| problem("Developer mode is off."))
    }

    fn stop_game(&self) {
        if let Some(kill) = self.live.lock().unwrap().game_kill.take() {
            let _ = kill.send(());
        }
    }
}

fn create_window(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html".into()))
        .title("Dungeon Blitz: R")
        .inner_size(460.0, 580.0)
        .resizable(false)
        .maximizable(false)
        .initialization_script(SHIM)
        .on_navigation(|url| {
            let local = matches!(url.scheme(), "tauri" | "asset")
                || url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions) && url.host_str() == Some("localhost"));
            local
        })
        .build()?;
    let _ = window.show();
    Ok(())
}

macro_rules! launcher {
    ($state:expr) => {
        $state.inner().clone()
    };
}

type S<'a> = tauri::State<'a, L>;

#[tauri::command]
fn get_state(l: S) -> Value {
    l.state()
}

#[tauri::command]
fn discord_login(l: S) -> Value {
    launcher!(l).discord_login()
}

#[tauri::command]
fn submit_login_code(l: S, code: String) -> Value {
    let cleaned: String = code.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(16).collect();
    let ok = {
        let mut live = l.live.lock().unwrap();
        match (live.login.as_mut(), cleaned.is_empty()) {
            (Some(login), false) => {
                login.pending_code = cleaned;
                login.code_rejected = false;
                true
            }
            _ => false,
        }
    };
    l.push();
    json!({ "ok": ok })
}

#[tauri::command]
fn copy_sign_in_link(app: AppHandle, l: S) -> Value {
    let link = l.live.lock().unwrap().login.as_ref().map(|x| x.link.clone()).unwrap_or_default();
    if link.is_empty() {
        return json!({ "ok": false });
    }
    json!({ "ok": app.clipboard().write_text(link).is_ok() })
}

#[tauri::command]
fn forget_discord_login(l: S) -> Value {
    let l = launcher!(l);
    l.forget_login();
    l.state()
}

#[tauri::command]
async fn play(l: S<'_>, engine: Option<String>) -> Result<Value, ()> {
    let l = launcher!(l);
    Ok(l.play(engine.as_deref().unwrap_or("")).await)
}

#[tauri::command]
async fn browse_flash(app: AppHandle, l: S<'_>) -> Result<Value, ()> {
    let l = launcher!(l);
    let with_notice = |notice: &str| {
        let mut s = l.state();
        s["notice"] = json!(notice);
        s
    };
    if is_packaged() {
        return Ok(with_notice("This launcher only runs the Flash Player it was installed with."));
    }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Choose Flash Player (flashplayer_32_sa)").blocking_pick_file()
    })
    .await
    .ok()
    .flatten()
    .and_then(|p| p.into_path().ok());
    let Some(chosen) = picked else { return Ok(l.state()) };
    if !engine::projector::is_chosen_projector(&chosen) {
        return Ok(with_notice("That is not the standalone Flash Player (flashplayer_32_sa)."));
    }
    let text = chosen.to_string_lossy().into_owned();
    l.store.write(json!({ "projectorPath": text }));
    let found = l.locate_projector(&text);
    l.live.lock().unwrap().projector = found;
    Ok(l.state())
}

#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn quit(app: AppHandle, l: S) {
    l.stop_game();
    app.exit(0);
}

#[tauri::command]
fn move_to_applications(app: AppHandle, l: S) -> Value {
    let exe = std::env::current_exe().unwrap_or_default();
    match install::move_to_applications(&l.install, &exe) {
        Ok(next) => {
            let _ = std::process::Command::new(next).spawn();
            app.exit(0);
            json!({ "ok": true })
        }
        Err(message) => problem(message),
    }
}

#[tauri::command]
fn update_install() -> bool {
    false
}

#[tauri::command]
fn update_download(l: S) -> bool {
    let url = l.updates.download_url();
    if url.is_empty() {
        return false;
    }
    l.open_external(&url);
    true
}

#[tauri::command]
async fn game_stats_sync(l: S<'_>) -> Result<Value, ()> {
    let l = launcher!(l);
    l.live.lock().unwrap().recovery_last = 0;
    l.refresh_account().await;
    let snapshot = if l.token().is_empty() && l.stats.snapshot().running {
        // Without a device token the server answers 401 to every sync, so sign in first;
        // discord_login syncs once the token is saved.
        if l.discord_login().get("ok") == Some(&json!(true)) {
            l.stats.waiting_for_sign_in();
            l.stats.snapshot()
        } else {
            l.stats.sync(String::new()).await
        }
    } else {
        l.stats.sync(l.token()).await
    };
    let mut s = serde_json::to_value(snapshot).unwrap();
    s["enabled"] = json!(!env_off("DUNGEON_BLITZ_GAME_STATS"));
    Ok(s)
}

#[tauri::command]
fn set_graphics(l: S, settings: Value) -> Value {
    let mut patch = serde_json::Map::new();
    if let Some(r) = settings.get("renderer").and_then(Value::as_str) {
        patch.insert("renderer".into(), json!(graphics::normalize_renderer(r)));
    }
    if let Some(q) = settings.get("quality").and_then(Value::as_str) {
        patch.insert("graphicsQuality".into(), json!(graphics::normalize_quality(q)));
    }
    l.store.write(Value::Object(patch));
    l.state()
}

#[tauri::command]
fn set_dev_mode(l: S, on: Option<bool>) -> Value {
    let on = on == Some(true);
    l.store.write(json!({ "devMode": on }));
    if !on && l.dev.running() {
        l.dev.stop();
    }
    l.state()
}

#[tauri::command]
async fn dev_choose_server(app: AppHandle, l: S<'_>) -> Result<Value, ()> {
    let l = launcher!(l);
    if let Some(off) = l.dev_off() {
        return Ok(off);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Choose the game server checkout").blocking_pick_folder()
    })
    .await
    .ok()
    .flatten()
    .and_then(|p| p.into_path().ok());
    let Some(chosen) = picked else { return Ok(l.state()) };
    let chosen = chosen.to_string_lossy().into_owned();
    l.store.write(json!({ "devServerRoot": chosen }));
    let mut s = l.state();
    if let Err(problem) = dev::inspect_server_root(&chosen) {
        s["notice"] = json!(problem);
    }
    Ok(s)
}

#[tauri::command]
fn dev_create(l: S) -> Value {
    let l = launcher!(l);
    if let Some(off) = l.dev_off() {
        return off;
    }
    // Starting takes a while (a download the first time, two tunnels, the server's own start):
    // the window follows it through the state, so this answers at once.
    let root = l.store.read().dev_server_root;
    let server = l.dev.clone();
    tauri::async_runtime::spawn(async move {
        server.start(root).await;
    });
    json!({ "ok": true })
}

#[tauri::command]
fn dev_stop(l: S) -> Value {
    if let Some(off) = l.dev_off() {
        return off;
    }
    json!({ "ok": true, "server": l.dev.stop() })
}

#[tauri::command]
fn dev_copy_share(app: AppHandle, l: S) -> Value {
    if let Some(off) = l.dev_off() {
        return off;
    }
    let share = l.dev.summary().share_url;
    if share.is_empty() {
        return json!({ "ok": false });
    }
    json!({ "ok": app.clipboard().write_text(share).is_ok() })
}

#[tauri::command]
async fn dev_play_own(l: S<'_>) -> Result<Value, ()> {
    let l = launcher!(l);
    if let Some(off) = l.dev_off() {
        return Ok(off);
    }
    if l.dev.summary().state != "running" {
        return Ok(problem("Create the server first."));
    }
    Ok(l.play_dev(dev_join::Target::Local, "own server").await)
}

#[tauri::command]
async fn dev_join(l: S<'_>, address: Option<String>) -> Result<Value, ()> {
    let l = launcher!(l);
    if let Some(off) = l.dev_off() {
        return Ok(off);
    }
    Ok(l.join_dev(address.as_deref().unwrap_or("")).await)
}

fn error_box(app: &AppHandle, text: String) {
    app.dialog()
        .message(text)
        .title("Dungeon Blitz: R cannot start")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

fn warn_install_location(l: L) {
    if !l.install.relocate {
        return;
    }
    let target = l.install.target_path.clone();
    let detail = [
        l.install.message.clone(),
        if target.is_empty() { String::new() } else { format!("Move it to: {target}") },
        "Running the current build is what keeps the game and lobby chat working.".into(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    let buttons = if target.is_empty() {
        MessageDialogButtons::Ok
    } else {
        MessageDialogButtons::OkCancelCustom("Move to Applications".into(), "Not now".into())
    };
    let app = l.app.clone();
    std::thread::spawn(move || {
        let accepted = app
            .dialog()
            .message(detail)
            .title("This copy cannot update itself")
            .kind(MessageDialogKind::Warning)
            .buttons(buttons)
            .blocking_show();
        if accepted && !target.is_empty() {
            let exe = std::env::current_exe().unwrap_or_default();
            match install::move_to_applications(&l.install, &exe) {
                Ok(next) => {
                    let _ = std::process::Command::new(next).spawn();
                    app.exit(0);
                }
                Err(message) => error_box(&app, message),
            }
        }
    });
}

/// Release builds abort on a panic and macOS's crash report has no symbols, so the panic's own
/// message goes to launcher-crash.log in the data folder before the abort.
fn log_panics() {
    let Some(dir) = dirs::config_dir().map(|d| d.join(config::APP_DIRECTORY_NAME)) else { return };
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let line = format!("[{}] v{} {info}\n{backtrace}\n", config::now_ms(), env!("CARGO_PKG_VERSION"));
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("launcher-crash.log")) {
            use std::io::Write;
            let _ = file.write_all(line.as_bytes());
        }
        default(info);
    }));
}

pub fn run() {
    log_panics();
    if let Some(dir) = dirs::config_dir() {
        let saved = StateStore::new(&dir.join(config::APP_DIRECTORY_NAME)).read();
        if saved.renderer == "cpu" {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu");
        }
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            match app.get_webview_window(WINDOW) {
                Some(window) => {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                None => {
                    let _ = create_window(app);
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_state,
            discord_login,
            submit_login_code,
            copy_sign_in_link,
            forget_discord_login,
            play,
            browse_flash,
            relaunch,
            quit,
            move_to_applications,
            update_install,
            update_download,
            game_stats_sync,
            set_graphics,
            set_dev_mode,
            dev_choose_server,
            dev_create,
            dev_stop,
            dev_copy_share,
            dev_play_own,
            dev_join,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let l = Launcher::new(handle.clone());
            app.manage(l.clone());
            let _ = std::fs::create_dir_all(&l.paths.data_dir);
            l.locate_engines();
            l.restore_login();
            if !l.playable() {
                let running_from: PathBuf = std::env::current_exe().unwrap_or_default();
                error_box(
                    &handle,
                    format!(
                        "This copy of the launcher has no game engine (AIR or Flash Player), so the game could not start even after signing in.\n\nRunning from: {}\nThis is an incomplete or outdated build.\n\nFix: install the current build again from the installer.\n\nTo start anyway, set DUNGEON_BLITZ_ALLOW_NO_FLASH=1.",
                        running_from.display()
                    ),
                );
                std::process::exit(1);
            }
            create_window(&handle)?;
            l.updates.start();
            warn_install_location(l.clone());
            let me = l.clone();
            tauri::async_runtime::spawn(async move {
                me.detect_graphics().await;
            });
            let me = l.clone();
            tauri::async_runtime::spawn(async move {
                me.refresh_server_status().await;
            });
            let me = l.clone();
            tauri::async_runtime::spawn(async move {
                me.refresh_account().await;
            });
            let remembered = l.live.lock().unwrap().remembered;
            if remembered && l.engine_problem(l.preferred_engine()).is_empty() {
                let me = l.clone();
                tauri::async_runtime::spawn(async move {
                    me.play("").await;
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the launcher");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, code: None, .. } = &event {
            if let Some(l) = handle.try_state::<L>() {
                if l.live.lock().unwrap().game_kill.is_some() {
                    api.prevent_exit();
                }
            }
        }
        if let RunEvent::Exit = event {
            if let Some(l) = handle.try_state::<L>() {
                l.stop_game();
                l.social.stop();
                l.dev.stop();
            }
        }
    });
}

// ------------------------------------------------------------------
//  Title    |  Supervisor
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  Start every service in order, know when each is ready,
//           |  restart one that falls over, and stop them all when
//           |  the app quits, saying at each step what is happening.
//  How      |  Embedded Postgres first (pg0), then Knowledge (its
//           |  migrations, then the server), the Controller and the
//           |  lab when they are bundled, then Core, which serves the
//           |  Cockpit. Ready means GET /ready answers 200. A service
//           |  that exits is restarted after 1, 2, 4 … 30 s; five
//           |  exits in two minutes and it is left stopped, with the
//           |  log to read. Each service writes to logs/<name>.log.
//  Note     |  On Windows every child joins a job object that kills
//           |  the whole tree when the app goes, even if it crashes.
//           |  Postgres is stopped with `pg0 stop` first, cleanly.
// ------------------------------------------------------------------

use crate::layout::{exe, Layout};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const PG_INSTANCE_PREFIX: &str = "ancile-desktop";
const READY_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_EXITS: usize = 5;
const EXIT_WINDOW: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Waiting,
    Starting,
    Ready,
    Restarting,
    Failed,
    Stopped,
}

#[derive(Clone, Debug, Serialize)]
pub struct ServiceStatus {
    pub name: &'static str,
    pub state: State,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub message: String,
    pub hint: Option<String>,
    pub services: Vec<ServiceStatus>,
    pub ready: bool,
}

struct Spec {
    name: &'static str,
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    ready: Option<String>,
}

pub struct Supervisor {
    app: AppHandle,
    layout: Layout,
    env: BTreeMap<String, String>,
    pg_instance: String,
    children: Mutex<BTreeMap<&'static str, Child>>,
    status: Mutex<Status>,
    shutting: AtomicBool,
    #[cfg(windows)]
    job: Option<win32job::Job>,
}

impl Supervisor {
    pub fn new(
        app: AppHandle,
        layout: Layout,
        secrets: BTreeMap<&'static str, String>,
        profile: &str,
    ) -> Arc<Self> {
        let p = &layout.ports;
        let share = layout.sidecar("share");
        let pg_password = secrets
            .get("POSTGRES_PASSWORD")
            .cloned()
            .unwrap_or_default();
        let mut env: BTreeMap<String, String> = BTreeMap::new();
        let mut set = |k: &str, v: String| {
            env.insert(k.to_string(), v);
        };
        for (k, v) in &secrets {
            set(k, v.clone());
        }
        set("NODE_ENV", "production".into());
        set("ANCILE_RUNTIME", "desktop".into());
        set("ANCILE_HOST", "127.0.0.1".into());
        set("ANCILE_PORT", p.core.to_string());
        set("ANCILE_PUBLIC_URL", layout.core_url());
        set("ANCILE_DATA_DIR", layout.data.display().to_string());
        set(
            "ANCILE_CONFIG_DIR",
            share.join("config").display().to_string(),
        );
        set(
            "ANCILE_PROMPTS_DIR",
            share.join("prompts").display().to_string(),
        );
        set(
            "ANCILE_MEMORY_TEMPLATE_DIR",
            share.join("memory-template").display().to_string(),
        );
        set(
            "ANCILE_COCKPIT_DIST",
            layout.sidecar("cockpit").display().to_string(),
        );
        set("ANCILE_OFFLINE_MODELS", "1".into());
        set("POSTGRES_USER", "ancile".into());
        set("POSTGRES_DB", "ancile".into());
        set("POSTGRES_PORT", p.postgres.to_string());
        set(
            "DATABASE_URL",
            format!(
                "postgres://ancile:{}@127.0.0.1:{}/ancile",
                pg_password, p.postgres
            ),
        );
        set("KNOWLEDGE_PORT", p.knowledge.to_string());
        set("KNOWLEDGE_URL", format!("http://127.0.0.1:{}", p.knowledge));
        set(
            "CORE_INTERNAL_URL",
            format!("http://127.0.0.1:{}/internal/v1", p.core),
        );
        // Models bundled with the app are used in place; otherwise they are
        // downloaded once into the data folder on the first source.
        let bundled_models = layout.sidecar("models");
        set(
            "KNOWLEDGE_MODEL_CACHE",
            if bundled_models.exists() {
                bundled_models
            } else {
                layout.data.join("models")
            }
            .display()
            .to_string(),
        );
        if layout.has("controller/dist/main.js") {
            set("CONTROLLER_PORT", p.controller.to_string());
            set(
                "CONTROLLER_URL",
                format!("http://127.0.0.1:{}", p.controller),
            );
            // RunPod with no key: sample nodes until RunPod is connected in
            // Admin → Compute (Core keeps the key and gives it to the Controller).
            set("CONTROLLER_PROVIDER", "runpod".into());
        }
        if layout.has(&format!("lab/{}", exe("ancile-lab"))) {
            set("AGENT_ENGINE_PORT", p.lab.to_string());
            set("AGENT_ENGINE_URL", format!("http://127.0.0.1:{}", p.lab));
        }

        let services = ["database", "knowledge", "controller", "lab", "core"]
            .iter()
            .filter(|n| match **n {
                "controller" => env.contains_key("CONTROLLER_URL"),
                "lab" => env.contains_key("AGENT_ENGINE_URL"),
                _ => true,
            })
            .map(|n| ServiceStatus {
                name: n,
                state: State::Waiting,
            })
            .collect();

        Arc::new(Self {
            app,
            pg_instance: format!("{PG_INSTANCE_PREFIX}-{profile}"),
            layout,
            env,
            children: Mutex::new(BTreeMap::new()),
            status: Mutex::new(Status {
                message: "Starting".into(),
                hint: None,
                services,
                ready: false,
            }),
            shutting: AtomicBool::new(false),
            #[cfg(windows)]
            job: kill_on_close_job(),
        })
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// Core's service token (the desktop host's way into /internal/v1).
    #[allow(dead_code)] // used only with the updater feature
    pub fn service_token(&self) -> Option<&str> {
        self.env.get("ANCILE_SERVICE_TOKEN").map(String::as_str)
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn update(
        &self,
        name: Option<&'static str>,
        state: Option<State>,
        message: Option<&str>,
        hint: Option<Option<String>>,
    ) {
        let snapshot = {
            let mut s = self.status.lock().unwrap();
            if let (Some(n), Some(st)) = (name, state) {
                if let Some(svc) = s.services.iter_mut().find(|x| x.name == n) {
                    svc.state = st;
                }
            }
            if let Some(m) = message {
                s.message = m.to_string();
            }
            if let Some(h) = hint {
                s.hint = h;
            }
            s.ready = s.services.iter().all(|x| x.state == State::Ready);
            s.clone()
        };
        log::info!("status: {} {:?}", snapshot.message, name.zip(state));
        let _ = self.app.emit("ancile://status", &snapshot);
        crate::tray::refresh(&self.app, &snapshot);
    }

    fn log_file(&self, name: &str) -> File {
        let path = self.layout.logs.join(format!("{name}.log"));
        // Keep one previous log; start fresh above 20 MB.
        if std::fs::metadata(&path)
            .map(|m| m.len() > 20 * 1024 * 1024)
            .unwrap_or(false)
        {
            let _ = std::fs::rename(&path, self.layout.logs.join(format!("{name}.1.log")));
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .expect("log file")
    }

    fn command(&self, program: &PathBuf, args: &[String], cwd: &PathBuf, log: &str) -> Command {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(cwd)
            .envs(&self.env)
            .stdin(Stdio::null());
        let out = self.log_file(log);
        let err = out.try_clone().expect("log file handle");
        cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    /// Run a short command to completion (migrations, pg0 helpers).
    fn run_once(
        &self,
        program: &PathBuf,
        args: &[String],
        cwd: &PathBuf,
        log: &str,
        timeout: Duration,
    ) -> Result<(), String> {
        let mut child = self
            .command(program, args, cwd, log)
            .spawn()
            .map_err(|e| format!("{} could not start: {e}", program.display()))?;
        self.adopt(&child);
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(s)) if s.success() => return Ok(()),
                Ok(Some(s)) => return Err(format!("{log} ended with {s}")),
                Ok(None) if started.elapsed() > timeout => {
                    let _ = child.kill();
                    return Err(format!("{log} took longer than {} s", timeout.as_secs()));
                }
                Ok(None) => thread::sleep(Duration::from_millis(200)),
                Err(e) => return Err(e.to_string()),
            }
        }
    }

    fn adopt(&self, child: &Child) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            use std::os::windows::io::AsRawHandle;
            let _ = job.assign_process(child.as_raw_handle() as isize);
        }
        #[cfg(not(windows))]
        let _ = child;
    }

    fn wait_ready(&self, url: &str) -> bool {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(2))
            .build();
        let started = Instant::now();
        while started.elapsed() < READY_TIMEOUT {
            if self.shutting.load(Ordering::SeqCst) {
                return false;
            }
            if matches!(agent.get(url).call(), Ok(r) if r.status() == 200) {
                return true;
            }
            thread::sleep(Duration::from_millis(300));
        }
        false
    }

    // ---- Postgres -------------------------------------------------------------

    fn pg0(&self) -> PathBuf {
        self.layout.sidecar(&format!("pg0/{}", exe("pg0")))
    }

    fn start_database(&self) -> Result<(), String> {
        self.update(
            Some("database"),
            Some(State::Starting),
            Some("Starting the database"),
            None,
        );
        let pg0 = self.pg0();
        let pg_dir = self.layout.data.join("pg");
        std::fs::create_dir_all(&pg_dir).map_err(|e| e.to_string())?;
        let port = self.layout.ports.postgres.to_string();
        let password = self
            .env
            .get("POSTGRES_PASSWORD")
            .cloned()
            .unwrap_or_default();
        let args: Vec<String> = [
            "start",
            "--name",
            &self.pg_instance,
            "--port",
            &port,
            "--data-dir",
            &pg_dir.display().to_string(),
            "--username",
            "ancile",
            "--password",
            &password,
            "--database",
            "ancile",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        // pg0 starts the server in the background and returns. It prints the
        // connection URI, password included, so its output is never kept.
        let mut cmd = self.command(&pg0, &args, &self.layout.data, "database");
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd
            .spawn()
            .map_err(|e| format!("The database could not start: {e}"))?;
        self.adopt(&child);
        self.children.lock().unwrap().insert("pg0-start", child);
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(90) {
            if std::net::TcpStream::connect(("127.0.0.1", self.layout.ports.postgres)).is_ok()
                && self.pg_running()
            {
                break;
            }
            thread::sleep(Duration::from_millis(400));
        }
        if !self.pg_running() {
            return Err("The database did not start within 90 s. See database.log.".into());
        }
        // Extensions and schemas: idempotent, run on every start.
        let init = self.layout.sidecar("share/db/init.sql");
        self.run_once(
            &pg0,
            &[
                "psql".into(),
                "--name".into(),
                self.pg_instance.clone(),
                "--".into(),
                "-f".into(),
                init.display().to_string(),
            ],
            &self.layout.data,
            "database",
            Duration::from_secs(60),
        )?;
        self.update(Some("database"), Some(State::Ready), None, None);
        Ok(())
    }

    fn pg_running(&self) -> bool {
        Command::new(self.pg0())
            .args(["info", "--name", &self.pg_instance, "-o", "json"])
            .envs(&self.env)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
            .and_then(|v| v.get("running").and_then(|r| r.as_bool()))
            .unwrap_or(false)
    }

    fn stop_database(&self) {
        let _ = Command::new(self.pg0())
            .args(["stop", "--name", &self.pg_instance])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    // ---- Services -------------------------------------------------------------

    fn python(&self) -> PathBuf {
        if cfg!(windows) {
            self.layout.sidecar("knowledge/python/python.exe")
        } else {
            self.layout.sidecar("knowledge/python/bin/python3")
        }
    }

    fn node(&self) -> PathBuf {
        self.layout.sidecar(&format!("node/{}", exe("node")))
    }

    fn specs(&self) -> Vec<Spec> {
        let p = &self.layout.ports;
        let mut out = vec![Spec {
            name: "knowledge",
            program: self.python(),
            args: [
                "-m",
                "uvicorn",
                "ancile_knowledge.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                &p.knowledge.to_string(),
                "--no-access-log",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            cwd: self.layout.sidecar("knowledge/app"),
            ready: Some(format!("http://127.0.0.1:{}/ready", p.knowledge)),
        }];
        if self.env.contains_key("CONTROLLER_URL") {
            out.push(Spec {
                name: "controller",
                program: self.node(),
                args: vec!["dist/main.js".into()],
                cwd: self.layout.sidecar("controller"),
                ready: Some(format!("http://127.0.0.1:{}/ready", p.controller)),
            });
        }
        if self.env.contains_key("AGENT_ENGINE_URL") {
            out.push(Spec {
                name: "lab",
                program: self.layout.sidecar(&format!("lab/{}", exe("ancile-lab"))),
                args: vec![
                    "serve".into(),
                    "--port".into(),
                    p.lab.to_string(),
                    "--hostname".into(),
                    "127.0.0.1".into(),
                ],
                cwd: self.layout.data.clone(),
                ready: None,
            });
        }
        out.push(Spec {
            name: "core",
            program: self.node(),
            args: vec!["--enable-source-maps".into(), "dist/main.js".into()],
            cwd: self.layout.sidecar("core"),
            ready: Some(format!("http://127.0.0.1:{}/ready", p.core)),
        });
        out
    }

    fn spawn(&self, spec: &Spec) -> Result<(), String> {
        let child = self
            .command(&spec.program, &spec.args, &spec.cwd, spec.name)
            .spawn()
            .map_err(|e| format!("{} could not start: {e}", spec.name))?;
        self.adopt(&child);
        self.children.lock().unwrap().insert(spec.name, child);
        Ok(())
    }

    fn start_service(self: &Arc<Self>, spec: Spec) -> Result<(), String> {
        self.update(Some(spec.name), Some(State::Starting), None, None);
        self.spawn(&spec)?;
        if let Some(url) = &spec.ready {
            if !self.wait_ready(url) {
                self.update(Some(spec.name), Some(State::Failed), None, None);
                return Err(format!(
                    "{} did not become ready. See {}.log.",
                    spec.name, spec.name
                ));
            }
        }
        self.update(Some(spec.name), Some(State::Ready), None, None);
        self.watch(spec);
        Ok(())
    }

    /// Restart a service that exits, with backoff, until the app quits.
    fn watch(self: &Arc<Self>, spec: Spec) {
        let me = Arc::clone(self);
        thread::spawn(move || {
            let mut exits: Vec<Instant> = Vec::new();
            loop {
                thread::sleep(Duration::from_millis(500));
                if me.shutting.load(Ordering::SeqCst) {
                    return;
                }
                let exited = {
                    let mut kids = me.children.lock().unwrap();
                    match kids.get_mut(spec.name) {
                        Some(c) => matches!(c.try_wait(), Ok(Some(_))),
                        None => true,
                    }
                };
                if !exited {
                    continue;
                }
                let now = Instant::now();
                exits.retain(|t| now.duration_since(*t) < EXIT_WINDOW);
                exits.push(now);
                log::warn!(
                    "{} exited ({} in the last two minutes)",
                    spec.name,
                    exits.len()
                );
                if exits.len() >= MAX_EXITS {
                    me.update(
                        Some(spec.name),
                        Some(State::Failed),
                        Some("A service keeps stopping"),
                        Some(Some(format!(
                            "{} stopped {} times in two minutes. Its log is in {}.",
                            spec.name,
                            MAX_EXITS,
                            me.layout.logs.display()
                        ))),
                    );
                    return;
                }
                let wait = Duration::from_secs((1u64 << (exits.len() - 1)).min(30));
                let restarting = format!("Restarting {}", spec.name);
                me.update(
                    Some(spec.name),
                    Some(State::Restarting),
                    Some(&restarting),
                    None,
                );
                thread::sleep(wait);
                if me.shutting.load(Ordering::SeqCst) {
                    return;
                }
                if me.spawn(&spec).is_ok() {
                    let ok = spec
                        .ready
                        .as_deref()
                        .map(|u| me.wait_ready(u))
                        .unwrap_or(true);
                    let (state, message) = if ok {
                        (State::Ready, "Ready")
                    } else {
                        (State::Failed, "A service did not come back")
                    };
                    me.update(Some(spec.name), Some(state), Some(message), None);
                }
            }
        });
    }

    /// Start everything in order. Returns when Core is ready, or why not.
    pub fn start_all(self: &Arc<Self>) -> Result<(), String> {
        if !self.pg0().exists() || !self.node().exists() || !self.python().exists() {
            let msg = "This copy of NVX Ancile is missing its services";
            self.update(
                None,
                None,
                Some(msg),
                Some(Some("Reinstall NVX Ancile. If you built it yourself, run `pnpm --filter @nvx/ancile-desktop sidecars` first.".into())),
            );
            return Err(msg.into());
        }
        let fail = |me: &Arc<Self>, e: String| {
            me.update(
                None,
                None,
                Some("NVX Ancile could not start"),
                Some(Some(format!("{e} Logs: {}", me.layout.logs.display()))),
            );
            e
        };
        self.start_database().map_err(|e| fail(self, e))?;

        self.update(None, None, Some("Preparing sources and search"), None);
        let migrate = self.run_once(
            &self.python(),
            &[
                "-m".into(),
                "alembic".into(),
                "upgrade".into(),
                "head".into(),
            ],
            &self.layout.sidecar("knowledge/app"),
            "knowledge",
            Duration::from_secs(180),
        );
        migrate.map_err(|e| {
            fail(
                self,
                format!("The sources database could not be prepared: {e}."),
            )
        })?;

        for spec in self.specs() {
            let name = spec.name;
            let message = match name {
                "knowledge" => "Starting sources and search",
                "controller" => "Starting GPU nodes",
                "lab" => "Starting the lab",
                _ => "Starting Core",
            };
            self.update(None, None, Some(message), None);
            if let Err(e) = self.start_service(spec) {
                // The lab and the Controller are optional: carry on without them.
                if matches!(name, "lab" | "controller") {
                    log::warn!("{e}");
                    continue;
                }
                return Err(fail(self, e));
            }
        }
        self.update(None, None, Some("Ready"), Some(None));
        Ok(())
    }

    /// Stop everything: services first, then Postgres, cleanly.
    pub fn shutdown(&self) {
        if self.shutting.swap(true, Ordering::SeqCst) {
            return;
        }
        log::info!("stopping services");
        let pg0_start = {
            let mut kids = self.children.lock().unwrap();
            let pg0_start = kids.remove("pg0-start");
            for (_, child) in kids.iter_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            kids.clear();
            pg0_start
        };
        // Postgres gets a clean shutdown; only then is pg0's own process reaped.
        self.stop_database();
        if let Some(mut c) = pg0_start {
            if !matches!(c.try_wait(), Ok(Some(_))) {
                let _ = c.kill();
            }
            let _ = c.wait();
        }
        self.update(None, None, Some("Stopped"), None);
    }
}

#[cfg(windows)]
fn kill_on_close_job() -> Option<win32job::Job> {
    let job = win32job::Job::create().ok()?;
    let mut info = job.query_extended_limit_info().ok()?;
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&info).ok()?;
    Some(job)
}

// ------------------------------------------------------------------
//  Title    |  Layout: where everything is
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  One place that knows the read-only install (sidecars
//           |  bundled as resources), the writable data folder, the
//           |  logs folder and the ports, so the supervisor never
//           |  guesses a path.
//  How      |  Data lives in the OS data folder under "NVX Ancile"
//           |  (AppData\Roaming on Windows, Application Support on a
//           |  Mac, ~/.local/share on Linux). Ports prefer a fixed set
//           |  so bookmarks keep working, and fall back to any free
//           |  port when one is taken.
//  Note     |  ANCILE_DESKTOP_DATA_DIR and ANCILE_DESKTOP_PORT_BASE
//           |  move both, so a test run never touches your workspace.
// ------------------------------------------------------------------

use std::net::TcpListener;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Ports {
    pub postgres: u16,
    pub core: u16,
    pub knowledge: u16,
    pub controller: u16,
    pub lab: u16,
}

#[derive(Clone, Debug)]
pub struct Layout {
    /// The bundled sidecars (read-only).
    pub sidecars: PathBuf,
    /// Everything the user owns: database, memory, sources, settings.
    pub data: PathBuf,
    pub logs: PathBuf,
    pub ports: Ports,
}

/// The ports NVX Ancile prefers on the desktop. Away from the dev stack
/// (7700) and the test stack (7800) so all three can run on one machine.
const DEFAULT_BASE: u16 = 17700;

fn free(preferred: u16) -> u16 {
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(preferred)
}

impl Layout {
    pub fn new(resources: &Path, os_data: &Path) -> std::io::Result<Self> {
        let data = std::env::var_os("ANCILE_DESKTOP_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| os_data.join("NVX Ancile"));
        let logs = data.join("logs");
        std::fs::create_dir_all(&logs)?;
        let base = std::env::var("ANCILE_DESKTOP_PORT_BASE")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(DEFAULT_BASE);
        let ports = Ports {
            core: free(base),
            knowledge: free(base + 10),
            controller: free(base + 20),
            lab: free(base + 30),
            postgres: free(base + 33),
        };
        Ok(Self {
            sidecars: resources.join("sidecars"),
            data,
            logs,
            ports,
        })
    }

    pub fn sidecar(&self, rel: &str) -> PathBuf {
        self.sidecars.join(rel)
    }

    pub fn has(&self, rel: &str) -> bool {
        self.sidecar(rel).exists()
    }

    pub fn core_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.ports.core)
    }
}

/// The executable name on this platform.
pub fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_taken_port_falls_back_to_a_free_one() {
        let held = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        let got = free(port);
        assert_ne!(got, port);
        assert!(TcpListener::bind(("127.0.0.1", got)).is_ok());
    }
}

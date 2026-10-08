// ------------------------------------------------------------------
//  Title    |  Secrets in the OS keychain
//  ID       |  desktop
// ------------------------------------------------------------------
//  Purpose  |  The keys that protect your workspace (the key that
//           |  encrypts provider keys, the tokens the services use
//           |  with each other, the database password) are made on
//           |  first run and kept in the OS keychain, never in a file.
//  How      |  keyring: Windows Credential Manager, macOS Keychain,
//           |  the Secret Service on Linux. One entry per secret under
//           |  the service "NVX Ancile". They reach the sidecars as
//           |  environment variables of those processes only.
//  Note     |  Deleting these entries does not delete your data, but
//           |  provider keys saved in the app would have to be entered
//           |  again, and the database password must match the one
//           |  the database was created with (see docs/desktop.md).
// ------------------------------------------------------------------

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use rand::RngCore;
use std::collections::BTreeMap;

const SERVICE: &str = "NVX Ancile";

/// Every secret the services need, and how each is made.
const SECRETS: &[(&str, Kind)] = &[
    ("ANCILE_SECRET_KEY", Kind::Key32),
    ("ANCILE_SERVICE_TOKEN", Kind::Token),
    ("AGENT_ENGINE_TOKEN", Kind::Token),
    ("AGENT_GATEWAY_TOKEN", Kind::Token),
    ("CONTROLLER_TOKEN", Kind::Token),
    ("CONTROLLER_NODE_TOKEN", Kind::Token),
    ("POSTGRES_PASSWORD", Kind::Token),
];

#[derive(Clone, Copy)]
enum Kind {
    /// 32 random bytes, base64: AES-256 key material.
    Key32,
    /// 24 random bytes, base64url: a bearer token or password.
    Token,
}

fn make(kind: Kind) -> String {
    let mut bytes = vec![0u8; if matches!(kind, Kind::Key32) { 32 } else { 24 }];
    rand::thread_rng().fill_bytes(&mut bytes);
    match kind {
        Kind::Key32 => STANDARD.encode(bytes),
        Kind::Token => URL_SAFE_NO_PAD.encode(bytes),
    }
}

/// Read every secret, creating any that are missing. `account` separates
/// a test profile from your workspace.
pub fn load_or_create(account: &str) -> Result<BTreeMap<&'static str, String>, String> {
    let mut out = BTreeMap::new();
    for (name, kind) in SECRETS {
        let entry = keyring::Entry::new(SERVICE, &format!("{account}/{name}"))
            .map_err(|e| format!("The keychain could not be opened: {e}"))?;
        let value = match entry.get_password() {
            Ok(v) if !v.is_empty() => v,
            Ok(_) | Err(keyring::Error::NoEntry) => {
                let v = make(*kind);
                entry
                    .set_password(&v)
                    .map_err(|e| format!("A secret could not be saved in the keychain: {e}"))?;
                v
            }
            Err(e) => return Err(format!("The keychain refused to read a secret: {e}")),
        };
        out.insert(*name, value);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_tokens_have_the_right_shape() {
        let k = make(Kind::Key32);
        assert_eq!(STANDARD.decode(&k).unwrap().len(), 32);
        let t = make(Kind::Token);
        assert_eq!(URL_SAFE_NO_PAD.decode(&t).unwrap().len(), 24);
        assert_ne!(make(Kind::Token), t);
    }
}

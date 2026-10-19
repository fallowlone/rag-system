//! Database-key management. The SQLCipher key is 32 random bytes, base64
//! encoded, stored ONLY in the macOS login keychain — never in the DB, never
//! on disk, never in logs.

use crate::error::Result;

// Both are reached only from the macOS keychain provider below. Left
// ungated they become unused imports off-platform, and the clippy step runs
// with -D warnings — so the imports have to carry the same predicate as the
// code that uses them.
#[cfg(target_os = "macos")]
use crate::error::CoreError;
#[cfg(target_os = "macos")]
use rand::RngCore;

pub const KEYCHAIN_SERVICE: &str = "com.dokumente.app";
pub const KEYCHAIN_ACCOUNT: &str = "db-key";
pub const TOKEN_ACCOUNT: &str = "device-token";

/// Abstraction over the OS keychain so the store is testable without
/// touching (and without tests needing permission for) the real Keychain.
/// Must be Send + Sync for Tauri's spawn_blocking.
pub trait KeyProvider: Send + Sync {
    fn get_or_create_key(&self) -> Result<String>;
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, value: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}

/// macOS login-keychain-backed provider.
///
/// Gated to macOS because `security-framework` is a macOS-only dependency
/// (see Cargo.toml's `cfg(target_os = "macos")` block) while CI builds this
/// crate on Linux. Nothing in the library references this type — the only
/// consumer is the Tauri shell, which is macOS-only anyway — so the gate
/// costs nothing off-platform.
///
/// Uses `security-framework` directly (NOT the `keyring` crate): keyring's
/// default macOS credential targets the Data Protection keychain, whose items
/// are scoped to a code-signing identity — for unsigned/ad-hoc dev binaries
/// every rebuild gets a different identity, so a stored key becomes unreadable
/// immediately ("set" succeeds, "get" returns None). The legacy file keychain
/// has no such scoping and persists across rebuilds.
#[cfg(target_os = "macos")]
#[derive(Clone)]
pub struct KeychainProvider {
    service: String,
}

#[cfg(target_os = "macos")]
impl KeychainProvider {
    pub fn new() -> Self {
        Self {
            service: KEYCHAIN_SERVICE.to_string(),
        }
    }
}

#[cfg(target_os = "macos")]
impl Default for KeychainProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "macos")]
impl KeyProvider for KeychainProvider {
    fn get_or_create_key(&self) -> Result<String> {
        if let Some(existing) = self.get(KEYCHAIN_ACCOUNT)? {
            return Ok(existing);
        }
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let key = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        self.set(KEYCHAIN_ACCOUNT, &key)?;
        Ok(key)
    }

    fn get(&self, account: &str) -> Result<Option<String>> {
        match security_framework::passwords::get_generic_password(&self.service, account) {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|err| CoreError::Keychain(err.to_string())),
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(err) => Err(CoreError::Keychain(err.to_string())),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<()> {
        // Upsert: an existing item raises errSecDuplicateItem on plain add.
        let _ = security_framework::passwords::delete_generic_password(&self.service, account);
        security_framework::passwords::set_generic_password(
            &self.service,
            account,
            value.as_bytes(),
        )
        .map_err(|err| CoreError::Keychain(err.to_string()))
    }

    fn delete(&self, account: &str) -> Result<()> {
        match security_framework::passwords::delete_generic_password(&self.service, account) {
            Ok(()) => Ok(()),
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(err) => Err(CoreError::Keychain(err.to_string())),
        }
    }
}

/// errSecItemNotFound (-25300) — not re-exported as a constant by
/// security-framework 2.x.
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// Fixed key returned by the in-memory provider (32 bytes, base64). Public so
/// integration tests can verify a database with it.
pub const TEST_DB_KEY: &str = "dGVzdC1rZXktMzItYnl0ZXMtMDAwMDAwMDAwMDA=";

/// In-memory key provider — for unit tests, the integration test, and any
/// embedding that wants to bypass the OS keychain (never used in the app).
/// Uses `Mutex` (not `RefCell`) so it is `Send + Sync` and usable from
/// Tauri's `spawn_blocking` / tokio tasks.
pub struct InMemoryProvider {
    values: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl InMemoryProvider {
    pub fn new() -> Self {
        Self {
            values: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

impl Default for InMemoryProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyProvider for InMemoryProvider {
    fn get_or_create_key(&self) -> Result<String> {
        if let Some(existing) = self.get(KEYCHAIN_ACCOUNT)? {
            return Ok(existing);
        }
        let key = TEST_DB_KEY.to_string();
        self.set(KEYCHAIN_ACCOUNT, &key)?;
        Ok(key)
    }

    fn get(&self, account: &str) -> Result<Option<String>> {
        Ok(self.values.lock().unwrap().get(account).cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<()> {
        self.values
            .lock()
            .unwrap()
            .insert(account.into(), value.into());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<()> {
        self.values.lock().unwrap().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_or_create_key_is_stable_across_calls() {
        let provider = InMemoryProvider::new();
        let first = provider.get_or_create_key().unwrap();
        let second = provider.get_or_create_key().unwrap();
        assert_eq!(first, second);
        assert!(!first.is_empty());
    }

    #[test]
    fn set_get_delete_roundtrip() {
        let provider = InMemoryProvider::new();
        assert_eq!(provider.get(TOKEN_ACCOUNT).unwrap(), None);
        provider.set(TOKEN_ACCOUNT, "token").unwrap();
        assert_eq!(provider.get(TOKEN_ACCOUNT).unwrap(), Some("token".into()));
        provider.delete(TOKEN_ACCOUNT).unwrap();
        assert_eq!(provider.get(TOKEN_ACCOUNT).unwrap(), None);
    }
}

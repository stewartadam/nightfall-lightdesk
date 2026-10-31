// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Where the GDTF Share username and password are kept between runs.
//!
//! Desktop builds keep them in the operating system's keychain: Keychain on macOS,
//! Credential Manager on Windows and the Secret Service on Linux. A headless server can
//! instead set `GDTF_SHARE_USER` and `GDTF_SHARE_PASSWORD`, which take precedence.
//! Every keychain call blocks, so callers run them on the blocking pool.

use std::sync::Arc;

use keyring_core::{CredentialStore, Entry, Error};
use serde::{Deserialize, Serialize};

/// Keychain service name, which is what Keychain Access and Credential Manager list.
pub(crate) const KEYCHAIN_SERVICE: &str = "Nightfall GDTF Share";
/// Keychain account name. One GDTF Share account is kept per computer.
pub(crate) const KEYCHAIN_USER: &str = "account";

/// Environment variable naming the GDTF Share user on a headless server.
pub const USER_VARIABLE: &str = "GDTF_SHARE_USER";
/// Environment variable holding that user's GDTF Share password.
pub const PASSWORD_VARIABLE: &str = "GDTF_SHARE_PASSWORD";

/// A GDTF Share username and password.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credentials {
    /// GDTF Share username or email address.
    pub user: String,
    /// GDTF Share password.
    pub password: String,
}

impl std::fmt::Debug for Credentials {
    /// Shows the user but never the password, so credentials can appear in logs safely.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Credentials")
            .field("user", &self.user)
            .finish_non_exhaustive()
    }
}

impl Credentials {
    /// Reads credentials from `GDTF_SHARE_USER` and `GDTF_SHARE_PASSWORD`, when both are set.
    pub fn from_environment() -> Option<Self> {
        Self::from_pair(
            std::env::var(USER_VARIABLE).ok(),
            std::env::var(PASSWORD_VARIABLE).ok(),
        )
    }

    /// Pairs a trimmed user and a password, ignoring the pair unless both are non-empty.
    fn from_pair(user: Option<String>, password: Option<String>) -> Option<Self> {
        let user = user
            .map(|user| user.trim().to_string())
            .filter(|user| !user.is_empty())?;
        let password = password.filter(|password| !password.is_empty())?;
        Some(Self { user, password })
    }
}

/// Saves and loads the one GDTF Share account in a credential store.
///
/// A vault without a store still works for the current run; it just remembers nothing,
/// which is what happens on a Linux server with no Secret Service.
pub struct CredentialVault {
    store: Result<Arc<CredentialStore>, String>,
}

impl CredentialVault {
    /// Opens this platform's keychain, or a vault without a store when it is unavailable.
    pub fn platform() -> Self {
        let store = platform_store().map_err(|error| error.to_string());
        if let Err(error) = &store {
            tracing::warn!(%error, "The system keychain is unavailable; GDTF Share sign-in will not be remembered");
        }
        Self { store }
    }

    /// Uses `store`, which tests set to an in-memory mock.
    pub fn with_store(store: Arc<CredentialStore>) -> Self {
        Self { store: Ok(store) }
    }

    /// A vault that remembers nothing, explaining why with `reason`.
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            store: Err(reason.into()),
        }
    }

    /// Whether credentials saved here outlive this run.
    pub fn is_available(&self) -> bool {
        self.store.is_ok()
    }

    /// Opens the keychain entry for the account, or explains why there is none.
    fn entry(&self) -> Result<Entry, String> {
        let store = self.store.as_ref().map_err(Clone::clone)?;
        store
            .build(KEYCHAIN_SERVICE, KEYCHAIN_USER, None)
            .map_err(|error| error.to_string())
    }

    /// Loads the saved account, or `None` when nothing is saved or there is no keychain.
    pub fn load(&self) -> Result<Option<Credentials>, String> {
        if !self.is_available() {
            return Ok(None);
        }
        match self.entry()?.get_secret() {
            Ok(secret) => serde_json::from_slice(&secret)
                .map(Some)
                .map_err(|error| format!("The saved GDTF Share account is unreadable: {error}")),
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    /// Saves `credentials`, replacing any saved account.
    pub fn save(&self, credentials: &Credentials) -> Result<(), String> {
        let secret = serde_json::to_vec(credentials).map_err(|error| error.to_string())?;
        self.entry()?
            .set_secret(&secret)
            .map_err(|error| error.to_string())
    }

    /// Removes the saved account. Removing an account that was never saved succeeds.
    pub fn clear(&self) -> Result<(), String> {
        if !self.is_available() {
            return Ok(());
        }
        match self.entry()?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// Opens the keychain of the platform this build targets.
fn platform_store() -> keyring_core::Result<Arc<CredentialStore>> {
    #[cfg(target_os = "macos")]
    {
        let store: Arc<CredentialStore> = apple_native_keyring_store::keychain::Store::new()?;
        Ok(store)
    }
    #[cfg(target_os = "windows")]
    {
        let store: Arc<CredentialStore> = windows_native_keyring_store::Store::new()?;
        Ok(store)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let store: Arc<CredentialStore> = zbus_secret_service_keyring_store::Store::new()?;
        Ok(store)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(Error::NotSupportedByStore(
            "this platform has no supported keychain".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A vault backed by an in-memory store, isolated from the real keychain.
    fn mock_vault() -> CredentialVault {
        CredentialVault::with_store(keyring_core::mock::Store::new().unwrap())
    }

    /// Returns sample credentials for vault tests.
    fn sample() -> Credentials {
        Credentials {
            user: "lighting@example.com".into(),
            password: "correct horse".into(),
        }
    }

    /// Saved credentials load back intact, and clearing them leaves nothing saved.
    #[test]
    fn saves_loads_and_clears_the_account() {
        let vault = mock_vault();
        assert_eq!(vault.load().unwrap(), None);
        vault.save(&sample()).unwrap();
        assert_eq!(vault.load().unwrap(), Some(sample()));
        vault.clear().unwrap();
        assert_eq!(vault.load().unwrap(), None);
        vault.clear().unwrap();
    }

    /// A vault without a store loads nothing, clears quietly and reports saving as failed.
    #[test]
    fn unavailable_vault_remembers_nothing() {
        let vault = CredentialVault::unavailable("no keychain");
        assert!(!vault.is_available());
        assert_eq!(vault.load().unwrap(), None);
        assert_eq!(vault.save(&sample()), Err("no keychain".into()));
        vault.clear().unwrap();
    }

    /// Environment credentials need both a user and a password.
    #[test]
    fn environment_pair_requires_both_values() {
        let pair = |user: &str, password: &str| {
            Credentials::from_pair(Some(user.into()), Some(password.into()))
        };
        assert_eq!(
            pair("lighting", "secret"),
            Some(Credentials {
                user: "lighting".into(),
                password: "secret".into(),
            })
        );
        assert_eq!(pair(" ", "secret"), None);
        assert_eq!(
            pair(" lighting ", "secret").map(|credentials| credentials.user),
            Some("lighting".into())
        );
        assert_eq!(pair("lighting", ""), None);
        assert_eq!(Credentials::from_pair(Some("lighting".into()), None), None);
    }

    /// Debug output names the user but never prints the password.
    #[test]
    fn debug_output_hides_the_password() {
        let printed = format!("{:?}", sample());
        assert!(printed.contains("lighting@example.com"));
        assert!(!printed.contains("correct horse"));
    }
}

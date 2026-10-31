// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The engine's one GDTF Share account, shared by every connected client.

use std::sync::{Arc, OnceLock};

use serde::Serialize;
use tokio::sync::Mutex;

use crate::client::{Session, ShareClient, ShareError};
use crate::credentials::{CredentialVault, Credentials};

/// Where the signed-in account's credentials came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[typeshare::typeshare]
pub enum GdtfShareCredentialSource {
    /// Saved in the system keychain, so the account is remembered after a restart.
    Keychain,
    /// Set by `GDTF_SHARE_USER` and `GDTF_SHARE_PASSWORD` on the computer running Nightfall.
    Environment,
    /// Kept only until Nightfall quits, because the keychain could not save it.
    Session,
}

/// What clients show about the GDTF Share account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct GdtfShareAccountStatus {
    /// Signed-in GDTF Share username, or `None` when signed out.
    pub user: Option<String>,
    /// Where the signed-in account came from, or `None` when signed out.
    pub source: Option<GdtfShareCredentialSource>,
    /// Whether the system keychain can remember an account between runs.
    pub keychain_available: bool,
}

/// Why an account change failed.
#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    /// GDTF Share could not check the credentials, or refused them.
    #[error(transparent)]
    Share(#[from] ShareError),
    /// The account comes from environment variables, which the app cannot change.
    #[error(
        "This GDTF Share account is set by GDTF_SHARE_USER and GDTF_SHARE_PASSWORD on the computer running Nightfall."
    )]
    ManagedByEnvironment,
    /// The keychain failed while removing the saved account.
    #[error("The system keychain failed: {0}")]
    Keychain(String),
    /// No account is signed in, so GDTF Share cannot be searched or downloaded from.
    #[error("Sign in to GDTF Share in Settings first.")]
    SignedOut,
    /// A fixture list or archive could not be saved on this computer.
    #[error("Could not save to this computer: {0}")]
    Storage(String),
}

/// The account as currently known, loaded lazily from the keychain.
#[derive(Default)]
struct AccountState {
    loaded: bool,
    keychain_available: bool,
    credentials: Option<(Credentials, GdtfShareCredentialSource)>,
    /// Open session for `credentials`, reused until GDTF Share ends it.
    session: Option<Session>,
}

/// Opens the credential vault; called once, on the blocking pool.
pub type VaultOpener = Arc<dyn Fn() -> CredentialVault + Send + Sync>;

/// Signs in to GDTF Share and remembers the account between runs.
///
/// The keychain is opened on first use, off the async executor, because opening it can
/// block (the Linux Secret Service may wait for a D-Bus activation).
pub struct GdtfShareAccount {
    client: ShareClient,
    open_vault: VaultOpener,
    vault: Arc<OnceLock<CredentialVault>>,
    environment: Option<Credentials>,
    state: Mutex<AccountState>,
    /// Held while logging in for a request, so expired sessions are renewed once.
    login: Mutex<()>,
}

impl GdtfShareAccount {
    /// The production account: the real GDTF Share API, the platform keychain and any
    /// credentials set in the environment.
    pub fn new() -> Result<Self, ShareError> {
        Ok(Self::with_parts(
            ShareClient::new(crate::client::API_BASE_URL)?,
            Arc::new(CredentialVault::platform),
            Credentials::from_environment(),
        ))
    }

    /// Assembles an account from its parts, which tests replace with local doubles.
    pub fn with_parts(
        client: ShareClient,
        open_vault: VaultOpener,
        environment: Option<Credentials>,
    ) -> Self {
        Self {
            client,
            open_vault,
            vault: Arc::new(OnceLock::new()),
            environment,
            state: Mutex::new(AccountState::default()),
            login: Mutex::new(()),
        }
    }

    /// Runs `operation` on the keychain vault from the blocking pool, opening it first if needed.
    ///
    /// A keychain backend that panics fails the operation instead of the request.
    async fn with_vault<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&CredentialVault) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let vault = self.vault.clone();
        let open_vault = self.open_vault.clone();
        tokio::task::spawn_blocking(move || operation(vault.get_or_init(|| open_vault())))
            .await
            .unwrap_or_else(|error| Err(format!("the keychain stopped unexpectedly: {error}")))
    }

    /// Loads the saved or environment account once, before the first status or change.
    ///
    /// A keychain that fails to load (locked, or holding an unreadable entry) counts as
    /// signed out, so the user can still sign in and replace the entry.
    async fn ensure_loaded(&self, state: &mut AccountState) {
        if state.loaded {
            return;
        }
        state.keychain_available = self
            .with_vault(|vault| Ok(vault.is_available()))
            .await
            .unwrap_or(false);
        state.credentials = match &self.environment {
            Some(credentials) => {
                Some((credentials.clone(), GdtfShareCredentialSource::Environment))
            }
            None => match self.with_vault(CredentialVault::load).await {
                Ok(saved) => {
                    saved.map(|credentials| (credentials, GdtfShareCredentialSource::Keychain))
                }
                Err(error) => {
                    tracing::warn!(%error, "Could not load the saved GDTF Share account");
                    None
                }
            },
        };
        state.loaded = true;
    }

    /// Describes `state` for clients.
    fn describe(state: &AccountState) -> GdtfShareAccountStatus {
        GdtfShareAccountStatus {
            user: state
                .credentials
                .as_ref()
                .map(|(credentials, _)| credentials.user.clone()),
            source: state.credentials.as_ref().map(|(_, source)| *source),
            keychain_available: state.keychain_available,
        }
    }

    /// Returns the account status without contacting GDTF Share.
    pub async fn status(&self) -> GdtfShareAccountStatus {
        let mut state = self.state.lock().await;
        self.ensure_loaded(&mut state).await;
        Self::describe(&state)
    }

    /// Checks `credentials` with GDTF Share, then saves them as the account.
    ///
    /// The login runs before the account is locked, so status reads from other clients
    /// don't wait on a slow GDTF Share. When the keychain cannot save the credentials, the
    /// account still works until Nightfall quits and its status says so. When sign-ins
    /// overlap, the last one to finish is kept.
    pub async fn sign_in(
        &self,
        credentials: Credentials,
    ) -> Result<GdtfShareAccountStatus, AccountError> {
        if self.environment.is_some() {
            return Err(AccountError::ManagedByEnvironment);
        }
        let session = self.client.login(&credentials).await?;
        let mut state = self.state.lock().await;
        state.session = Some(session);
        self.ensure_loaded(&mut state).await;
        let saved = credentials.clone();
        let source = match self.with_vault(move |vault| vault.save(&saved)).await {
            Ok(()) => GdtfShareCredentialSource::Keychain,
            Err(error) => {
                tracing::warn!(%error, "Could not save the GDTF Share account to the keychain");
                // Drop any older saved account, so a restart doesn't sign back in as it.
                if let Err(error) = self.with_vault(CredentialVault::clear).await {
                    tracing::warn!(%error, "Could not remove the older saved GDTF Share account");
                }
                GdtfShareCredentialSource::Session
            }
        };
        state.credentials = Some((credentials, source));
        Ok(Self::describe(&state))
    }

    /// Forgets the account and removes it from the keychain.
    pub async fn sign_out(&self) -> Result<GdtfShareAccountStatus, AccountError> {
        if self.environment.is_some() {
            return Err(AccountError::ManagedByEnvironment);
        }
        let mut state = self.state.lock().await;
        self.ensure_loaded(&mut state).await;
        self.with_vault(CredentialVault::clear)
            .await
            .map_err(AccountError::Keychain)?;
        state.credentials = None;
        state.session = None;
        Ok(Self::describe(&state))
    }

    /// Whether an account is signed in, without contacting GDTF Share.
    pub async fn is_signed_in(&self) -> bool {
        self.status().await.user.is_some()
    }

    /// Runs `request` with a signed-in session.
    ///
    /// The session from the last sign-in or request is reused. Without one, or when GDTF
    /// Share reports a reused one expired, the account logs in again with its saved
    /// credentials and `request` runs once more.
    pub async fn with_session<T, Fut>(
        &self,
        request: impl Fn(ShareClient, Session) -> Fut,
    ) -> Result<T, AccountError>
    where
        Fut: Future<Output = Result<T, ShareError>>,
    {
        let (credentials, cached) = {
            let mut state = self.state.lock().await;
            self.ensure_loaded(&mut state).await;
            let Some((credentials, _)) = &state.credentials else {
                return Err(AccountError::SignedOut);
            };
            (credentials.clone(), state.session.clone())
        };
        let expired = match cached {
            Some(session) => match request(self.client.clone(), session.clone()).await {
                Err(ShareError::SessionExpired) => {
                    tracing::debug!("GDTF Share session expired; logging in again");
                    Some(session)
                }
                result => return result.map_err(AccountError::from),
            },
            None => None,
        };
        let session = self.renew_session(&credentials, expired).await?;
        Ok(request(self.client.clone(), session).await?)
    }

    /// Logs in again in place of the `expired` session (or none), once for every request
    /// that finds it expired at the same time.
    ///
    /// Requests that waited for another one's login use the session it opened.
    async fn renew_session(
        &self,
        credentials: &Credentials,
        expired: Option<Session>,
    ) -> Result<Session, AccountError> {
        let _login = self.login.lock().await;
        let current = self.state.lock().await.session.clone();
        if let Some(current) = current
            && expired
                .as_ref()
                .is_none_or(|expired| expired.cookie() != current.cookie())
        {
            return Ok(current);
        }
        let session = self.client.login(credentials).await?;
        let mut state = self.state.lock().await;
        // Keep the session only if the account was not changed during the login.
        if state
            .credentials
            .as_ref()
            .is_some_and(|(current, _)| current.user == credentials.user)
        {
            state.session = Some(session.clone());
        }
        Ok(session)
    }
}

#[cfg(test)]
mod tests;

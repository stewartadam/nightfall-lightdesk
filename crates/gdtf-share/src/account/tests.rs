// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;
use crate::testing::{MockShare, USER, valid_credentials};

/// Opens vaults on one shared in-memory store, standing in for the keychain across restarts.
fn mock_keychain() -> VaultOpener {
    let store = keyring_core::mock::Store::new().unwrap();
    Arc::new(move || CredentialVault::with_store(store.clone()))
}

/// An account on the mock API with `keychain` and no environment credentials.
fn account(share: &MockShare, keychain: VaultOpener) -> GdtfShareAccount {
    GdtfShareAccount::with_parts(share.client(), keychain, None)
}

/// Returns the status expected for `user` signed in from `source`.
fn signed_in(
    source: GdtfShareCredentialSource,
    keychain_available: bool,
) -> GdtfShareAccountStatus {
    GdtfShareAccountStatus {
        user: Some(USER.into()),
        source: Some(source),
        keychain_available,
    }
}

/// A fresh account is signed out, and reading its status never contacts GDTF Share.
#[tokio::test]
async fn starts_signed_out_without_contacting_share() {
    let share = MockShare::start().await;
    let status = account(&share, mock_keychain()).status().await;
    assert_eq!(
        status,
        GdtfShareAccountStatus {
            user: None,
            source: None,
            keychain_available: true,
        }
    );
    assert_eq!(share.login_count(), 0);
}

/// Signing in saves the account, so a later run starts signed in without logging in again.
#[tokio::test]
async fn sign_in_is_remembered_after_a_restart() {
    let share = MockShare::start().await;
    let keychain = mock_keychain();
    let status = account(&share, keychain.clone())
        .sign_in(valid_credentials())
        .await
        .unwrap();
    assert_eq!(status, signed_in(GdtfShareCredentialSource::Keychain, true));

    let restarted = account(&share, keychain);
    assert_eq!(
        restarted.status().await,
        signed_in(GdtfShareCredentialSource::Keychain, true)
    );
    assert_eq!(share.login_count(), 1);
}

/// Refused credentials leave the account signed out and save nothing.
#[tokio::test]
async fn refused_sign_in_saves_nothing() {
    let share = MockShare::start().await;
    let keychain = mock_keychain();
    let wrong = Credentials {
        password: "wrong".into(),
        ..valid_credentials()
    };
    let error = account(&share, keychain.clone())
        .sign_in(wrong)
        .await
        .unwrap_err();
    assert!(
        matches!(error, AccountError::Share(ShareError::Rejected(_))),
        "{error:?}"
    );
    assert_eq!(account(&share, keychain).status().await.user, None);
}

/// Signing out removes the saved account, so a later run starts signed out.
#[tokio::test]
async fn sign_out_forgets_the_saved_account() {
    let share = MockShare::start().await;
    let keychain = mock_keychain();
    let account_now = account(&share, keychain.clone());
    account_now.sign_in(valid_credentials()).await.unwrap();
    assert_eq!(account_now.sign_out().await.unwrap().user, None);
    assert_eq!(account(&share, keychain).status().await.user, None);
}

/// Without a keychain, signing in still works for this run and says it is not remembered.
#[tokio::test]
async fn sign_in_without_keychain_lasts_for_the_session() {
    let share = MockShare::start().await;
    let no_keychain: VaultOpener = Arc::new(|| CredentialVault::unavailable("no keychain"));
    let account = account(&share, no_keychain);
    assert_eq!(
        account.sign_in(valid_credentials()).await.unwrap(),
        signed_in(GdtfShareCredentialSource::Session, false)
    );
    assert_eq!(
        account.status().await,
        signed_in(GdtfShareCredentialSource::Session, false)
    );
}

/// An unreadable saved entry counts as signed out, and signing in replaces it.
#[tokio::test]
async fn unreadable_saved_account_counts_as_signed_out() {
    use keyring_core::api::CredentialStoreApi;

    let share = MockShare::start().await;
    let store = keyring_core::mock::Store::new().unwrap();
    store
        .build(
            crate::credentials::KEYCHAIN_SERVICE,
            crate::credentials::KEYCHAIN_USER,
            None,
        )
        .unwrap()
        .set_secret(b"not json")
        .unwrap();
    let keychain: VaultOpener = Arc::new(move || CredentialVault::with_store(store.clone()));
    let account = account(&share, keychain.clone());
    assert_eq!(account.status().await.user, None);
    account.sign_in(valid_credentials()).await.unwrap();
    assert_eq!(
        super::GdtfShareAccount::with_parts(share.client(), keychain, None)
            .status()
            .await,
        signed_in(GdtfShareCredentialSource::Keychain, true)
    );
}

/// Environment credentials are reported as such and cannot be replaced or removed.
#[tokio::test]
async fn environment_account_cannot_be_changed() {
    let share = MockShare::start().await;
    let account =
        GdtfShareAccount::with_parts(share.client(), mock_keychain(), Some(valid_credentials()));
    assert_eq!(
        account.status().await,
        signed_in(GdtfShareCredentialSource::Environment, true)
    );
    assert!(matches!(
        account.sign_in(valid_credentials()).await,
        Err(AccountError::ManagedByEnvironment)
    ));
    assert!(matches!(
        account.sign_out().await,
        Err(AccountError::ManagedByEnvironment)
    ));
    assert_eq!(share.login_count(), 0);
}

/// Lists the mock API's fixtures with the account's session.
async fn list(account: &GdtfShareAccount) -> Result<usize, AccountError> {
    account
        .with_session(|client, session| async move {
            client.list(&session).await.map(|entries| entries.len())
        })
        .await
}

/// Requests reuse the sign-in's session, and an expired one is replaced by logging in
/// once more.
#[tokio::test]
async fn requests_reuse_the_session_until_it_expires() {
    let share = MockShare::start().await;
    let account = account(&share, mock_keychain());
    account.sign_in(valid_credentials()).await.unwrap();
    list(&account).await.unwrap();
    list(&account).await.unwrap();
    assert_eq!((share.login_count(), share.list_count()), (1, 2));

    share.expire_sessions();
    list(&account).await.unwrap();
    list(&account).await.unwrap();
    assert_eq!((share.login_count(), share.list_count()), (2, 5));
}

/// A remembered account logs in on its first request after a restart.
#[tokio::test]
async fn remembered_account_logs_in_on_first_request() {
    let share = MockShare::start().await;
    let keychain = mock_keychain();
    account(&share, keychain.clone())
        .sign_in(valid_credentials())
        .await
        .unwrap();
    let restarted = account(&share, keychain);
    list(&restarted).await.unwrap();
    assert_eq!((share.login_count(), share.list_count()), (2, 1));
}

/// Without an account, requests fail without contacting GDTF Share.
#[tokio::test]
async fn requests_need_an_account() {
    let share = MockShare::start().await;
    let account = account(&share, mock_keychain());
    assert!(matches!(list(&account).await, Err(AccountError::SignedOut)));
    assert_eq!((share.login_count(), share.list_count()), (0, 0));
}

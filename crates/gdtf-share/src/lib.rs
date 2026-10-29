// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! GDTF Share integration for the native engine.
//!
//! [GDTF Share](https://gdtf-share.com) is the shared online library of GDTF fixture
//! profiles. Its API needs each user's own free account, so the engine signs in on the
//! user's behalf and keeps the account in the operating system's keychain. Every client
//! connected to the engine shares that one account.
//!
//! Everything is exposed as HTTP routes registered through [`register_routes`]. Nothing
//! contacts GDTF Share or the keychain until a client asks for the account.

#![warn(missing_docs)]

pub mod account;
pub mod client;
pub mod credentials;
mod routes;
#[cfg(test)]
mod testing;

pub use routes::register_routes;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::account::{GdtfShareAccount, GdtfShareAccountStatus, GdtfShareCredentialSource};
    pub use crate::register_routes as register_gdtf_share_routes;
}

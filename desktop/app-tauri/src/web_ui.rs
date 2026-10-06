// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Hands the web UI that Tauri embeds in the executable to the backend's HTTP server.

use std::{borrow::Cow, collections::HashSet, sync::Arc};

use nightfall_websocket::prelude::{SharedWebUiAssets, WebUiAssets};
use tauri::{AssetResolver, Wry};

/// Web UI files embedded by Tauri at build time, looked up by exact path.
///
/// Tauri's resolver falls back to `index.html` for any unknown path, which would turn a
/// missing script into an HTML response. The embedded file names are captured once so
/// only real files reach the resolver and the server decides how to treat the rest.
struct EmbeddedWebUi {
    resolver: AssetResolver<Wry>,
    paths: HashSet<String>,
}

impl WebUiAssets for EmbeddedWebUi {
    /// Returns the decompressed contents of an embedded file.
    ///
    /// The resolver percent-decodes its argument, while `path` is already decoded, so a
    /// literal `%` is escaped again to keep both lookups on the same key.
    fn get(&self, path: &str) -> Option<Cow<'static, [u8]>> {
        if !self.paths.contains(path) {
            return None;
        }
        self.resolver
            .get(path.replace('%', "%25"))
            .map(|asset| Cow::Owned(asset.bytes))
    }
}

/// Builds the backend's view of the embedded web UI, or `None` when nothing is embedded.
///
/// Development builds load the UI from the Vite dev server and embed no files, so the
/// backend serves no UI there and other devices use Vite instead.
pub(crate) fn embedded_web_ui(app: &tauri::App) -> Option<SharedWebUiAssets> {
    let resolver = app.asset_resolver();
    let paths: HashSet<String> = resolver
        .iter()
        .map(|(key, _)| key.trim_start_matches('/').to_string())
        .collect();
    if paths.is_empty() {
        return None;
    }
    tracing::debug!(
        files = paths.len(),
        "Serving embedded web UI to network clients"
    );
    Some(Arc::new(EmbeddedWebUi { resolver, paths }))
}

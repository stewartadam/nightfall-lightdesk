// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/// Prepare desktop resources and platform integration when building the desktop host.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    tauri_build::build()
}

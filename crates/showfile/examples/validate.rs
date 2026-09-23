// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Read-only validation of a showfile through the same migration boundary used by runtime hosts.

/// Parses a supplied showfile without rewriting it or starting the application.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: validate <showfile.json>")?;
    let json = std::fs::read_to_string(&path)?;
    let snapshot = nightfall_showfile::parse_showfile_snapshot_json(&json, &path)?;
    println!(
        "Valid showfile; loaded schema {}",
        snapshot.metadata.showfile_version
    );
    Ok(())
}

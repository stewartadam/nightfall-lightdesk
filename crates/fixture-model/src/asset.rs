// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Identity of a fixture definition file's contents.

/// Returns the fixture library's fingerprint of a definition file's `bytes`: a stable
/// FNV-1a hash in hex. Identical files share one, so it names a revision in the library
/// and lets an installer tell which library entry a file it wrote became.
pub fn fixture_asset_etag(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fingerprint is the 64-bit FNV-1a hash, so it stays stable across releases.
    #[test]
    fn matches_known_fnv1a_values() {
        assert_eq!(fixture_asset_etag(b""), "cbf29ce484222325");
        assert_eq!(fixture_asset_etag(b"a"), "af63dc4c8601ec8c");
    }
}

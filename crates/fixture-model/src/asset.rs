// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Identity of a fixture definition: its file's contents and the names it goes by.

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

/// Folds a manufacturer or fixture name so spellings of one name compare equal: lowercase,
/// with every run of spaces, punctuation and underscores read as one space. GDTF file names,
/// such as GDTF Share's `Manufacturer@Fixture@Revision.gdtf`, replace spaces and characters
/// file systems refuse with underscores, so a name read from one matches the name the GDTF
/// itself gives.
pub fn fixture_name_key(name: &str) -> String {
    name.split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Name keys ignore case, underscores, punctuation and repeated spaces, but not words.
    #[test]
    fn name_keys_fold_spelling() {
        assert_eq!(
            fixture_name_key("Robe_Lighting_s.r.o"),
            fixture_name_key("robe  lighting s.r.o.")
        );
        assert_ne!(fixture_name_key("Robe"), fixture_name_key("Robe Lighting"));
    }

    /// The fingerprint is the 64-bit FNV-1a hash, so it stays stable across releases.
    #[test]
    fn matches_known_fnv1a_values() {
        assert_eq!(fixture_asset_etag(b""), "cbf29ce484222325");
        assert_eq!(fixture_asset_etag(b"a"), "af63dc4c8601ec8c");
    }
}

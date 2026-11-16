// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::assert_equivalent_spellings;

/// Verifies the `tc` alias and the delete and rename verbs for timecode
/// sources parse like their canonical commands.
#[test]
fn timecode_spellings_share_one_ast() {
    assert_equivalent_spellings(&[
        &[
            "delete timecode 1",
            "del timecode 1",
            "rm timecode 1",
            "delete tc 1",
            "del tc 1",
            "rm tc 1",
        ],
        &[
            "rename timecode 1 2",
            "mv timecode 1 2",
            "rename tc 1 2",
            "mv tc 1 2",
        ],
        &["timecode 1 start", "tc 1 start"],
        &["timecode 1 pause", "tc 1 pause"],
        &["timecode 1 stop", "tc 1 stop"],
    ]);
}

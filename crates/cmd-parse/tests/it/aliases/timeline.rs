// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::assert_equivalent_spellings;

/// Verifies the `tl` alias and the delete and rename verbs for timelines parse
/// like their canonical commands.
#[test]
fn timeline_spellings_share_one_ast() {
    assert_equivalent_spellings(&[
        &[
            "delete timeline 1",
            "del timeline 1",
            "rm timeline 1",
            "delete tl 1",
            "del tl 1",
            "rm tl 1",
        ],
        &[
            "rename timeline 1 2",
            "mv timeline 1 2",
            "rename tl 1 2",
            "mv tl 1 2",
        ],
        &["timeline 1 start", "tl 1 start"],
        &["timeline 1 stop", "tl 1 stop"],
    ]);
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::assert_equivalent_spellings;

/// Verifies fixture object aliases (`fix`, `f`), the delete and rename verbs,
/// range spellings and channel aliases all parse like their canonical commands.
#[test]
fn fixture_spellings_share_one_ast() {
    assert_equivalent_spellings(&[
        &[
            "delete fixture 1",
            "del fixture 1",
            "rm fixture 1",
            "delete fix 1",
            "del fix 1",
            "rm fix 1",
            "delete f 1",
            "del f 1",
            "rm f 1",
        ],
        &[
            "rename fixture 1 2",
            "mv fixture 1 2",
            "rename fix 1 2",
            "mv fix 1 2",
            "rename f 1 2",
            "mv f 1 2",
        ],
        &["fix 1", "fixture 1", "f 1"],
        &["fix 1>10", "fix 1 thru 10", "fix 1 t 10"],
        &["channel 1.1 @ 255", "chan 1.1 @ 255", "ch 1.1 @ 255"],
    ]);
}

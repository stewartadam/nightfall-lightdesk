// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::assert_equivalent_spellings;

/// Verifies FX delete, rename and playback verbs, and the color attribute
/// aliases inside a step FX definition, parse like their canonical commands.
#[test]
fn fx_spellings_share_one_ast() {
    assert_equivalent_spellings(&[
        &["delete fx 1", "del fx 1", "rm fx 1"],
        &["rename fx 1 2", "mv fx 1 2"],
        &["fx 1 start", "fx 1 on"],
        &["fx 1 stop", "fx 1 off"],
        &[
            "store fx 1 step fix 1 5s int steps 100 0 r steps 100 0 g steps 100 0 b steps 100 0",
            "store fx 1 step fix 1 5s int steps 100 0 red steps 100 0 g steps 100 0 b steps 100 0",
            "store fx 1 step fix 1 5s int steps 100 0 red steps @100 0 g steps 100 0 b steps 100 0",
        ],
    ]);
}

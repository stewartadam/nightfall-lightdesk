// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::assert_equivalent_spellings;

/// Verifies programmer clear aliases and that fade and delay clauses parse the
/// same in either order.
#[test]
fn programmer_spellings_share_one_ast() {
    assert_equivalent_spellings(&[
        &["clear selection", "clear sel"],
        &["clear values", "clear val"],
        &["fix 1 @ 50 fade 3 delay 2", "fix 1 @ 50 delay 2 fade 3"],
    ]);
}

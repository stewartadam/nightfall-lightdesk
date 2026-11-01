// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::assert_equivalent_spellings;

/// Verifies the trailing delete and rename verbs on flow commands parse like
/// their canonical commands.
#[test]
fn flow_spellings_share_one_ast() {
    assert_equivalent_spellings(&[
        &["flow 1 delete", "flow 1 del", "flow 1 rm"],
        &["flow 1 rename 2", "flow 1 mv 2"],
    ]);
}

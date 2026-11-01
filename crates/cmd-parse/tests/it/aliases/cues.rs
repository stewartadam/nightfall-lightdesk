// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::assert_equivalent_spellings;

/// Verifies cue (`c`) and sequence (`seq`, `s`) aliases with their delete,
/// rename, store and recall verbs parse like their canonical commands.
#[test]
fn cue_and_sequence_spellings_share_one_ast() {
    assert_equivalent_spellings(&[
        &[
            "delete cue 1.5",
            "del cue 1.5",
            "rm cue 1.5",
            "delete c 1.5",
            "del c 1.5",
            "rm c 1.5",
        ],
        &[
            "rename cue 1.5 2.10",
            "mv cue 1.5 2.10",
            "rename c 1.5 2.10",
            "mv c 1.5 2.10",
        ],
        &["store cue 1.5", "store c 1.5"],
        &["recall cue 1.5", "recall c 1.5"],
        &[
            "delete sequence 1",
            "del sequence 1",
            "rm sequence 1",
            "delete seq 1",
            "del seq 1",
            "rm seq 1",
            "delete s 1",
            "del s 1",
            "rm s 1",
        ],
        &[
            "rename sequence 1 2",
            "mv sequence 1 2",
            "rename seq 1 2",
            "mv seq 1 2",
            "rename s 1 2",
            "mv s 1 2",
        ],
    ]);
}

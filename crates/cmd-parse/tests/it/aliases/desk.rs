// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::assert_equivalent_spellings;

/// Verifies group (`grp`, `g`), clip (`exec`, `e`) and blueprint (`bp`) aliases
/// with their delete, rename, store, recall and playback verbs parse like their
/// canonical commands.
#[test]
fn desk_object_spellings_share_one_ast() {
    assert_equivalent_spellings(&[
        &[
            "delete group 1",
            "del group 1",
            "rm group 1",
            "del grp 1",
            "rm g 1",
        ],
        &["rename group 1 2", "mv group 1 2", "mv grp 1 2", "mv g 1 2"],
        &["store group 5", "store grp 5", "store g 5"],
        &[
            "delete clip 1",
            "del clip 1",
            "rm clip 1",
            "del exec 1",
            "rm e 1",
        ],
        &["rename clip 1 2", "mv clip 1 2", "mv exec 1 2", "mv e 1 2"],
        &[
            "clip 1 start",
            "clip 1 on",
            "exec 1 start",
            "exec 1 on",
            "e 1 start",
            "e 1 on",
        ],
        &[
            "clip 1 stop",
            "clip 1 off",
            "exec 1 stop",
            "exec 1 off",
            "e 1 stop",
            "e 1 off",
        ],
        &["clip 1 go", "exec 1 go", "e 1 go"],
        &[
            "delete blueprint 1",
            "del blueprint 1",
            "rm blueprint 1",
            "delete bp 1",
            "del bp 1",
            "rm bp 1",
        ],
        &[
            "rename blueprint 1 2",
            "mv blueprint 1 2",
            "rename bp 1 2",
            "mv bp 1 2",
        ],
        &["store blueprint 1", "store bp 1"],
        &["recall blueprint 1", "recall bp 1"],
    ]);
}

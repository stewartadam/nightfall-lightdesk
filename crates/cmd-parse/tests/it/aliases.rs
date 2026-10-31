// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;

/// Groups of commands that must parse to the same AST. The first entry of each
/// group is the canonical spelling; every other entry is an alias or an
/// equivalent ordering of it.
const EQUIVALENT_COMMANDS: &[&[&str]] = &[
    // Object deletion verbs and object type aliases.
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
    &["delete fx 1", "del fx 1", "rm fx 1"],
    &[
        "delete timeline 1",
        "del timeline 1",
        "rm timeline 1",
        "delete tl 1",
        "del tl 1",
        "rm tl 1",
    ],
    &[
        "delete timecode 1",
        "del timecode 1",
        "rm timecode 1",
        "delete tc 1",
        "del tc 1",
        "rm tc 1",
    ],
    &[
        "delete group 1",
        "del group 1",
        "rm group 1",
        "del grp 1",
        "rm g 1",
    ],
    &[
        "delete clip 1",
        "del clip 1",
        "rm clip 1",
        "del exec 1",
        "rm e 1",
    ],
    &[
        "delete cue 1.5",
        "del cue 1.5",
        "rm cue 1.5",
        "delete c 1.5",
        "del c 1.5",
        "rm c 1.5",
    ],
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
        "delete blueprint 1",
        "del blueprint 1",
        "rm blueprint 1",
        "delete bp 1",
        "del bp 1",
        "rm bp 1",
    ],
    &["flow 1 delete", "flow 1 del", "flow 1 rm"],
    // Object rename verbs and object type aliases.
    &[
        "rename fixture 1 2",
        "mv fixture 1 2",
        "rename fix 1 2",
        "mv fix 1 2",
        "rename f 1 2",
        "mv f 1 2",
    ],
    &["rename fx 1 2", "mv fx 1 2"],
    &[
        "rename timeline 1 2",
        "mv timeline 1 2",
        "rename tl 1 2",
        "mv tl 1 2",
    ],
    &[
        "rename timecode 1 2",
        "mv timecode 1 2",
        "rename tc 1 2",
        "mv tc 1 2",
    ],
    &["rename group 1 2", "mv group 1 2", "mv grp 1 2", "mv g 1 2"],
    &["rename clip 1 2", "mv clip 1 2", "mv exec 1 2", "mv e 1 2"],
    &[
        "rename cue 1.5 2.10",
        "mv cue 1.5 2.10",
        "rename c 1.5 2.10",
        "mv c 1.5 2.10",
    ],
    &[
        "rename sequence 1 2",
        "mv sequence 1 2",
        "rename seq 1 2",
        "mv seq 1 2",
        "rename s 1 2",
        "mv s 1 2",
    ],
    &[
        "rename blueprint 1 2",
        "mv blueprint 1 2",
        "rename bp 1 2",
        "mv bp 1 2",
    ],
    &["flow 1 rename 2", "flow 1 mv 2"],
    // Playback verbs and playback object aliases.
    &["fx 1 start", "fx 1 on"],
    &["fx 1 stop", "fx 1 off"],
    &["timeline 1 start", "tl 1 start"],
    &["timeline 1 stop", "tl 1 stop"],
    &["timecode 1 start", "tc 1 start"],
    &["timecode 1 pause", "tc 1 pause"],
    &["timecode 1 stop", "tc 1 stop"],
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
    // Store and recall object aliases.
    &["store cue 1.5", "store c 1.5"],
    &["store group 5", "store grp 5", "store g 5"],
    &["store blueprint 1", "store bp 1"],
    &["recall cue 1.5", "recall c 1.5"],
    &["recall blueprint 1", "recall bp 1"],
    // Selection, channel and clear aliases.
    &["fix 1", "fixture 1", "f 1"],
    &["fix 1>10", "fix 1 thru 10", "fix 1 t 10"],
    &["channel 1.1 @ 255", "chan 1.1 @ 255", "ch 1.1 @ 255"],
    &["clear selection", "clear sel"],
    &["clear values", "clear val"],
    // Attribute aliases and timing clause order.
    &[
        "store fx 1 step fix 1 5s int steps 100 0 r steps 100 0 g steps 100 0 b steps 100 0",
        "store fx 1 step fix 1 5s int steps 100 0 red steps 100 0 g steps 100 0 b steps 100 0",
        "store fx 1 step fix 1 5s int steps 100 0 red steps @100 0 g steps 100 0 b steps 100 0",
    ],
    &["fix 1 @ 50 fade 3 delay 2", "fix 1 @ 50 delay 2 fade 3"],
];

/// Verifies every alias, short form and equivalent clause order in
/// `EQUIVALENT_COMMANDS` parses to exactly the AST of its group's canonical
/// command, reporting the first spelling that diverges.
#[test]
fn equivalent_spellings_share_one_ast() {
    for group in EQUIVALENT_COMMANDS {
        let (canonical, aliases) = group.split_first().expect("group is not empty");
        let expected = generate_ast(canonical)
            .unwrap_or_else(|error| panic!("parse {canonical:?}: {error:?}"));
        for alias in aliases {
            let actual =
                generate_ast(alias).unwrap_or_else(|error| panic!("parse {alias:?}: {error:?}"));
            assert_eq!(
                actual, expected,
                "{alias:?} should parse like {canonical:?}"
            );
        }
    }
}

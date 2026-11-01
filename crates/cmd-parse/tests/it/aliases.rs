// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Alias and equivalent-spelling tests, one module per command family.

use nightfall_cmd_parse::generate_ast;

mod cues;
mod desk;
mod fixtures;
mod flow;
mod fx;
mod programmer;
mod timecode;
mod timeline;

/// Asserts that every spelling in each group parses to exactly the AST of the
/// group's first entry, which is the canonical command. Every mismatch and
/// parse failure is reported together so one run shows all broken spellings.
fn assert_equivalent_spellings(groups: &[&[&str]]) {
    let mut failures = Vec::new();
    for group in groups {
        let (canonical, aliases) = group.split_first().expect("group is not empty");
        let expected = match generate_ast(canonical) {
            Ok(ast) => ast,
            Err(error) => {
                failures.push(format!("{canonical:?} does not parse: {error:?}"));
                continue;
            }
        };
        for alias in aliases {
            match generate_ast(alias) {
                Ok(actual) if actual == expected => {}
                Ok(_) => failures.push(format!("{alias:?} should parse like {canonical:?}")),
                Err(error) => failures.push(format!("{alias:?} does not parse: {error:?}")),
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

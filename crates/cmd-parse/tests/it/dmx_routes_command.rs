// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::ast::*;
use nightfall_cmd_parse::generate_ast;

fn assert_identifier_range(expr: &IdentifierExpressionAst, start: u32, end: u32) {
    match &expr.head {
        TermAst::Range(range) => {
            assert_eq!(
                range.start.target,
                TargetAst::FixtureRef { fixture_id: start }
            );
            assert_eq!(range.end.target, TargetAst::FixtureRef { fixture_id: end });
        }
        other => panic!("Expected range identifier expression, got {:?}", other),
    }
}

fn assert_identifier_single(expr: &IdentifierExpressionAst, fixture_id: u32) {
    match &expr.head {
        TermAst::Single(single) => {
            assert_eq!(single.target, TargetAst::FixtureRef { fixture_id });
        }
        other => panic!("Expected single identifier expression, got {:?}", other),
    }
}

fn assert_fixture_map(expr: &IdentifierExpressionAst, start: u32, end: u32, element: u32) {
    match &expr.head {
        TermAst::FixtureMap(map) => {
            assert_eq!(map.fixtures.start, start);
            assert_eq!(map.fixtures.end, end);
            assert_eq!(map.elements, ElementSelectorAst::Single(element));
        }
        other => panic!(
            "Expected fixture map identifier expression, got {:?}",
            other
        ),
    }
}

#[test]
fn test_patch_transport_to_console_with_priority() {
    let input = "patch sacn @ console prio 4";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            assert!(matches!(cmd.source, PatchEndpointAst::Transport(_)));
            assert!(matches!(cmd.target, PatchEndpointAst::Console(_)));
            let priority = cmd.priority.expect("Expected priority");
            assert_eq!(priority.value.0, "4");
            assert!(cmd.clone.is_none(), "Did not expect /clone");
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_transport_to_console_with_priority_keyword() {
    let input = "patch sacn @ console priority 4";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            assert!(matches!(cmd.source, PatchEndpointAst::Transport(_)));
            assert!(matches!(cmd.target, PatchEndpointAst::Console(_)));
            let priority = cmd.priority.expect("Expected priority");
            assert_eq!(priority.value.0, "4");
            assert!(cmd.clone.is_none(), "Did not expect /clone");
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_transport_passthrough_to_console() {
    let input = "patch sacn @ console";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            match cmd.source {
                PatchEndpointAst::Transport(source) => {
                    assert_eq!(source.transport.0, "sacn");
                    assert!(source.range.is_none());
                    assert!(source.address.is_none());
                }
                other => panic!("Expected transport source, got {:?}", other),
            }

            match cmd.target {
                PatchEndpointAst::Console(target) => {
                    assert!(target.range.is_none());
                    assert!(target.address.is_none());
                }
                other => panic!("Expected console target, got {:?}", other),
            }

            assert!(cmd.priority.is_none(), "Did not expect priority");
            assert!(cmd.clone.is_none(), "Did not expect /clone");
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_transport_range_to_disabled() {
    let input = "patch artnet:1>5 @ disabled";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => match cmd.source {
            PatchEndpointAst::Transport(source) => {
                let range = source.range.expect("Expected universe range");
                assert_eq!(range.start.0, "1");
                assert_eq!(range.end.unwrap().0, "5");
            }
            other => panic!("Expected transport source, got {:?}", other),
        },
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_transport_to_console_remap() {
    let input = "patch sacn:1 @ console:5";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            match cmd.source {
                PatchEndpointAst::Transport(source) => {
                    let range = source.range.expect("Expected transport universe");
                    assert_eq!(range.start.0, "1");
                    assert!(range.end.is_none());
                    assert!(source.address.is_none());
                }
                other => panic!("Expected transport source, got {:?}", other),
            }

            match cmd.target {
                PatchEndpointAst::Console(target) => {
                    let range = target.range.expect("Expected console universe");
                    assert_eq!(range.start.0, "5");
                    assert!(range.end.is_none());
                    assert!(target.address.is_none());
                }
                other => panic!("Expected console target, got {:?}", other),
            }
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_console_range_to_disabled() {
    let input = "patch console:4>5 @ disabled";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => match cmd.source {
            PatchEndpointAst::Console(source) => {
                let range = source.range.expect("Expected console universe range");
                assert_eq!(range.start.0, "4");
                assert_eq!(range.end.unwrap().0, "5");
            }
            other => panic!("Expected console source, got {:?}", other),
        },
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_console_passthrough_to_transport() {
    let input = "patch console @ sacn";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            match cmd.source {
                PatchEndpointAst::Console(source) => {
                    assert!(source.range.is_none());
                    assert!(source.address.is_none());
                }
                other => panic!("Expected console source, got {:?}", other),
            }

            match cmd.target {
                PatchEndpointAst::Transport(target) => {
                    assert_eq!(target.transport.0, "sacn");
                    assert!(target.range.is_none());
                    assert!(target.address.is_none());
                }
                other => panic!("Expected transport target, got {:?}", other),
            }
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_transport_to_transport_compact_syntax() {
    let input = "patch sacn@sacn";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            match cmd.source {
                PatchEndpointAst::Transport(source) => {
                    assert_eq!(source.transport.0, "sacn");
                    assert!(source.range.is_none());
                    assert!(source.address.is_none());
                }
                other => panic!("Expected transport source, got {:?}", other),
            }

            match cmd.target {
                PatchEndpointAst::Transport(target) => {
                    assert_eq!(target.transport.0, "sacn");
                    assert!(target.range.is_none());
                    assert!(target.address.is_none());
                }
                other => panic!("Expected transport target, got {:?}", other),
            }

            assert!(cmd.priority.is_none(), "Did not expect priority");
            assert!(cmd.clone.is_none(), "Did not expect /clone");
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_fix_to_console() {
    let input = "patch fix 211>215 @ console:2";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            match cmd.source {
                PatchEndpointAst::Fixture(source) => {
                    assert_identifier_range(&source.ids, 211, 215);
                }
                other => panic!("Expected fixture source, got {:?}", other),
            }

            match cmd.target {
                PatchEndpointAst::Console(target) => {
                    let range = target.range.expect("Expected console universe");
                    assert_eq!(range.start.0, "2");
                    assert!(range.end.is_none());
                    assert!(target.address.is_none());
                }
                other => panic!("Expected console target, got {:?}", other),
            }
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_fix_to_transport_with_priority() {
    let input = "patch fix 421 @ artnet:1.17 priority 0";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            match cmd.source {
                PatchEndpointAst::Fixture(source) => {
                    assert_identifier_single(&source.ids, 421);
                    assert!(source.target.is_none(), "Did not expect fixture target");
                }
                other => panic!("Expected fixture source, got {:?}", other),
            }

            match cmd.target {
                PatchEndpointAst::Transport(target) => {
                    assert_eq!(target.transport.0, "artnet");
                    let range = target.range.expect("Expected transport universe");
                    assert_eq!(range.start.0, "1");
                    assert!(range.end.is_none());
                    let address = target.address.expect("Expected address");
                    assert_eq!(address.value.0, "17");
                }
                other => panic!("Expected transport target, got {:?}", other),
            }

            let priority = cmd.priority.expect("Expected priority");
            assert_eq!(priority.value.0, "0");
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_transport_to_fixture_param_with_clone() {
    let input = "patch artnet:3.78 @ fix 311>315 .1 param intensity prio 2 /clone";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            match cmd.source {
                PatchEndpointAst::Transport(source) => {
                    let range = source.range.expect("Expected universe");
                    assert_eq!(range.start.0, "3");
                    assert!(range.end.is_none());
                    let address = source.address.expect("Expected address");
                    assert_eq!(address.value.0, "78");
                }
                other => panic!("Expected transport source, got {:?}", other),
            }

            match cmd.target {
                PatchEndpointAst::Fixture(target) => {
                    assert_fixture_map(&target.ids, 311, 315, 1);
                    let fixture_target = target.target.expect("Expected fixture target");
                    assert!(
                        fixture_target.element.is_none(),
                        "Did not expect element target"
                    );
                    let param = fixture_target.param.expect("Expected param target");
                    assert_eq!(param.name.0, "intensity");
                }
                other => panic!("Expected fixture target, got {:?}", other),
            }

            assert_eq!(cmd.priority.unwrap().value.0, "2");
            assert!(cmd.clone.is_some(), "Expected /clone");
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_fixture_to_fixture_range() {
    let input = "patch fix 211>215 @ fix 311>315";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            match cmd.source {
                PatchEndpointAst::Fixture(source) => {
                    assert_identifier_range(&source.ids, 211, 215);
                    assert!(source.target.is_none(), "Did not expect fixture target");
                }
                other => panic!("Expected fixture source, got {:?}", other),
            }

            match cmd.target {
                PatchEndpointAst::Fixture(target) => {
                    assert_identifier_range(&target.ids, 311, 315);
                    assert!(target.target.is_none(), "Did not expect fixture target");
                }
                other => panic!("Expected fixture target, got {:?}", other),
            }
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_fixture_to_fixture_clone() {
    let input = "patch fix 211 @ fix 311>315 /clone";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            match cmd.source {
                PatchEndpointAst::Fixture(source) => {
                    assert_identifier_single(&source.ids, 211);
                    assert!(source.target.is_none(), "Did not expect fixture target");
                }
                other => panic!("Expected fixture source, got {:?}", other),
            }

            match cmd.target {
                PatchEndpointAst::Fixture(target) => {
                    assert_identifier_range(&target.ids, 311, 315);
                    assert!(target.target.is_none(), "Did not expect fixture target");
                }
                other => panic!("Expected fixture target, got {:?}", other),
            }

            assert!(cmd.clone.is_some(), "Expected /clone");
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_patch_console_to_transport_remap() {
    let input = "patch console:1 @ sacn:10";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::PatchAdd(cmd) => {
            match cmd.source {
                PatchEndpointAst::Console(source) => {
                    let range = source.range.expect("Expected console universe");
                    assert_eq!(range.start.0, "1");
                    assert!(range.end.is_none());
                    assert!(source.address.is_none());
                }
                other => panic!("Expected console source, got {:?}", other),
            }

            match cmd.target {
                PatchEndpointAst::Transport(target) => {
                    assert_eq!(target.transport.0, "sacn");
                    let range = target.range.expect("Expected transport universe");
                    assert_eq!(range.start.0, "10");
                    assert!(range.end.is_none());
                    assert!(target.address.is_none());
                }
                other => panic!("Expected transport target, got {:?}", other),
            }
        }
        other => panic!("Expected PatchAdd command, got {:?}", other),
    }
}

#[test]
fn test_rm_patch_source_and_target() {
    let input = "rm patch fix 421 @ artnet:1.17";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::RmPatch(cmd) => {
            assert!(cmd.source.is_some(), "Expected source endpoint");
            assert!(cmd.target.is_some(), "Expected target endpoint");
            assert!(cmd.priority.is_none(), "Did not expect priority");
            assert!(cmd.clone.is_none(), "Did not expect /clone");
        }
        other => panic!("Expected RmPatch command, got {:?}", other),
    }
}

#[test]
fn test_rm_patch_target_disabled() {
    let input = "rm patch @ disabled";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::RmPatch(cmd) => {
            assert!(cmd.source.is_none(), "Did not expect source endpoint");
            match cmd.target {
                Some(PatchEndpointAst::Disabled(_)) => {}
                other => panic!("Expected disabled target, got {:?}", other),
            }
            assert!(cmd.priority.is_none(), "Did not expect priority");
            assert!(cmd.clone.is_none(), "Did not expect /clone");
        }
        other => panic!("Expected RmPatch command, got {:?}", other),
    }
}

#[test]
fn test_rm_patch_target_only() {
    let input = "rm patch @ console:2";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::RmPatch(cmd) => {
            assert!(cmd.source.is_none(), "Did not expect source endpoint");
            assert!(cmd.target.is_some(), "Expected target endpoint");
            assert!(cmd.priority.is_none(), "Did not expect priority");
            assert!(cmd.clone.is_none(), "Did not expect /clone");
        }
        other => panic!("Expected RmPatch command, got {:?}", other),
    }
}

#[test]
fn test_rm_patch_source_only() {
    let input = "rm patch artnet:3 @";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::RmPatch(cmd) => {
            assert!(cmd.source.is_some(), "Expected source endpoint");
            assert!(cmd.target.is_none(), "Did not expect target endpoint");
            assert!(cmd.priority.is_none(), "Did not expect priority");
            assert!(cmd.clone.is_none(), "Did not expect /clone");
        }
        other => panic!("Expected RmPatch command, got {:?}", other),
    }
}

#[test]
fn test_rm_patch_with_priority_and_clone() {
    let input = "rm patch artnet:3.78 @ fix 311>315 .1 param intensity prio 2 /clone";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::RmPatch(cmd) => {
            assert!(cmd.source.is_some(), "Expected source endpoint");
            assert!(cmd.target.is_some(), "Expected target endpoint");
            let priority = cmd.priority.expect("Expected priority");
            assert_eq!(priority.value.0, "2");
            assert!(cmd.clone.is_some(), "Expected /clone");
        }
        other => panic!("Expected RmPatch command, got {:?}", other),
    }
}

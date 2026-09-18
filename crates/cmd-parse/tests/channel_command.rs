// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::ast::*;
use nightfall_cmd_parse::generate_ast;

#[test]
fn test_channel_command_single() {
    let input = "ch 1.100 @ 255";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::Channel(channel_cmd) => {
            // Verify value
            assert_eq!(channel_cmd.value.0, "255", "Expected value '255'");

            // Verify channel expression structure
            match &channel_cmd.channels.head {
                DmxChannelTermAst::Single(single) => {
                    assert_eq!(single.channel.universe, 1, "Expected universe 1");
                    assert_eq!(single.channel.address, 100, "Expected address 100");
                }
                other => panic!("Expected Single channel term, got {:?}", other),
            }

            // Verify no tail operations
            assert_eq!(
                channel_cmd.channels.tail.len(),
                0,
                "Expected no tail operations"
            );
        }
        other => panic!("Expected Channel command, got {:?}", other),
    }
}

#[test]
fn test_channel_command_range() {
    let input = "ch 2.56>2.59 @ 128";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::Channel(channel_cmd) => {
            // Verify value
            assert_eq!(channel_cmd.value.0, "128", "Expected value '128'");

            // Verify channel expression is a range
            match &channel_cmd.channels.head {
                DmxChannelTermAst::Range(range) => {
                    assert_eq!(range.start.channel.universe, 2, "Expected start universe 2");
                    assert_eq!(range.start.channel.address, 56, "Expected start address 56");
                    assert_eq!(range.end.channel.universe, 2, "Expected end universe 2");
                    assert_eq!(range.end.channel.address, 59, "Expected end address 59");
                }
                other => panic!("Expected Range channel term, got {:?}", other),
            }

            // Verify no tail operations
            assert_eq!(
                channel_cmd.channels.tail.len(),
                0,
                "Expected no tail operations"
            );
        }
        other => panic!("Expected Channel command, got {:?}", other),
    }
}

#[test]
fn test_channel_command_complex_expression() {
    let input = "ch 2.56>2.59+3.51 @ 255";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::Channel(channel_cmd) => {
            // Verify value
            assert_eq!(channel_cmd.value.0, "255", "Expected value '255'");

            // Verify head is a range
            match &channel_cmd.channels.head {
                DmxChannelTermAst::Range(range) => {
                    assert_eq!(range.start.channel.universe, 2);
                    assert_eq!(range.start.channel.address, 56);
                    assert_eq!(range.end.channel.universe, 2);
                    assert_eq!(range.end.channel.address, 59);
                }
                other => panic!("Expected Range in head, got {:?}", other),
            }

            // Verify tail has one Add operation
            assert_eq!(
                channel_cmd.channels.tail.len(),
                1,
                "Expected one tail operation"
            );
            let tail_op = &channel_cmd.channels.tail[0];

            assert!(
                matches!(tail_op.op, SetOperatorAst::Add),
                "Expected Add operator"
            );

            match &tail_op.term {
                DmxChannelTermAst::Single(single) => {
                    assert_eq!(single.channel.universe, 3);
                    assert_eq!(single.channel.address, 51);
                }
                other => panic!("Expected Single in tail, got {:?}", other),
            }
        }
        other => panic!("Expected Channel command, got {:?}", other),
    }
}

#[test]
fn test_channel_command_with_subtraction() {
    let input = "ch 1.1>1.10-1.5 @ 200";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::Channel(channel_cmd) => {
            // Verify value
            assert_eq!(channel_cmd.value.0, "200", "Expected value '200'");

            // Verify head is a range
            match &channel_cmd.channels.head {
                DmxChannelTermAst::Range(range) => {
                    assert_eq!(range.start.channel.universe, 1);
                    assert_eq!(range.start.channel.address, 1);
                    assert_eq!(range.end.channel.universe, 1);
                    assert_eq!(range.end.channel.address, 10);
                }
                other => panic!("Expected Range in head, got {:?}", other),
            }

            // Verify tail has one Remove operation
            assert_eq!(
                channel_cmd.channels.tail.len(),
                1,
                "Expected one tail operation"
            );
            let tail_op = &channel_cmd.channels.tail[0];

            assert!(
                matches!(tail_op.op, SetOperatorAst::Remove),
                "Expected Remove operator"
            );

            match &tail_op.term {
                DmxChannelTermAst::Single(single) => {
                    assert_eq!(single.channel.universe, 1);
                    assert_eq!(single.channel.address, 5);
                }
                other => panic!("Expected Single in tail, got {:?}", other),
            }
        }
        other => panic!("Expected Channel command, got {:?}", other),
    }
}

#[test]
fn test_channel_command_with_grouping() {
    let input = "ch (1.1>1.5)+(2.1>2.5) @ 100";
    let command_ast = generate_ast(input).expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::Channel(channel_cmd) => {
            // Verify value
            assert_eq!(channel_cmd.value.0, "100", "Expected value '100'");

            // Verify head is a grouped expression
            match &channel_cmd.channels.head {
                DmxChannelTermAst::Grouped(grouped) => {
                    // Inner expression should be a range
                    match &grouped.expr.head {
                        DmxChannelTermAst::Range(range) => {
                            assert_eq!(range.start.channel.universe, 1);
                            assert_eq!(range.start.channel.address, 1);
                            assert_eq!(range.end.channel.universe, 1);
                            assert_eq!(range.end.channel.address, 5);
                        }
                        other => panic!("Expected Range in grouped head, got {:?}", other),
                    }
                }
                other => panic!("Expected Grouped in head, got {:?}", other),
            }

            // Verify tail has one Add operation with another grouped range
            assert_eq!(
                channel_cmd.channels.tail.len(),
                1,
                "Expected one tail operation"
            );
            let tail_op = &channel_cmd.channels.tail[0];

            assert!(
                matches!(tail_op.op, SetOperatorAst::Add),
                "Expected Add operator"
            );

            match &tail_op.term {
                DmxChannelTermAst::Grouped(grouped) => match &grouped.expr.head {
                    DmxChannelTermAst::Range(range) => {
                        assert_eq!(range.start.channel.universe, 2);
                        assert_eq!(range.start.channel.address, 1);
                        assert_eq!(range.end.channel.universe, 2);
                        assert_eq!(range.end.channel.address, 5);
                    }
                    other => panic!("Expected Range in grouped tail, got {:?}", other),
                },
                other => panic!("Expected Grouped in tail, got {:?}", other),
            }
        }
        other => panic!("Expected Channel command, got {:?}", other),
    }
}

#[test]
fn test_channel_command_alternate_keywords() {
    let chan_ast = generate_ast("chan 1.100 @ 255").expect("Failed to parse 'chan'");
    let channel_ast = generate_ast("channel 1.100 @ 255").expect("Failed to parse 'channel'");
    let ch_ast = generate_ast("ch 1.100 @ 255").expect("Failed to parse 'ch'");

    // All three should produce Channel commands
    assert!(
        matches!(chan_ast, CommandAst::Channel(_)),
        "Expected Channel command from 'chan'"
    );
    assert!(
        matches!(channel_ast, CommandAst::Channel(_)),
        "Expected Channel command from 'channel'"
    );
    assert!(
        matches!(ch_ast, CommandAst::Channel(_)),
        "Expected Channel command from 'ch'"
    );

    // Extract and verify they all have the same structure
    if let (CommandAst::Channel(cmd1), CommandAst::Channel(cmd2), CommandAst::Channel(cmd3)) =
        (&chan_ast, &channel_ast, &ch_ast)
    {
        assert_eq!(
            cmd1.value.0, cmd2.value.0,
            "Values should match between chan and channel"
        );
        assert_eq!(
            cmd2.value.0, cmd3.value.0,
            "Values should match between channel and ch"
        );

        // Verify all have the same channel structure
        match (
            &cmd1.channels.head,
            &cmd2.channels.head,
            &cmd3.channels.head,
        ) {
            (
                DmxChannelTermAst::Single(s1),
                DmxChannelTermAst::Single(s2),
                DmxChannelTermAst::Single(s3),
            ) => {
                assert_eq!(s1.channel.universe, s2.channel.universe);
                assert_eq!(s2.channel.universe, s3.channel.universe);
                assert_eq!(s1.channel.address, s2.channel.address);
                assert_eq!(s2.channel.address, s3.channel.address);
            }
            _ => panic!("All should have Single channel terms"),
        }
    }
}

#[test]
fn test_channel_command_invalid_value() {
    let input = "ch 1.100 @ 999";
    let command_ast = generate_ast(input).expect("Grammar and AST parsing should succeed");

    // Verify it parses as a Channel command with value "999"
    match command_ast {
        CommandAst::Channel(channel_cmd) => {
            assert_eq!(
                channel_cmd.value.0, "999",
                "Value should be parsed as '999' (validation happens at conversion stage)"
            );
        }
        other => panic!("Expected Channel command, got {:?}", other),
    }
}

#[test]
fn test_channel_expansion() {
    use nightfall::command_types::{DmxChannelExpr, DmxChannelRef};

    // Test single channel
    let single = DmxChannelExpr::Single(DmxChannelRef {
        universe: 1,
        address: 100,
    });
    let expanded = single.expand();
    assert_eq!(expanded.len(), 1);
    assert_eq!(expanded[0].universe, 1);
    assert_eq!(expanded[0].address, 100);

    // Test range
    let range = DmxChannelExpr::Range {
        start: DmxChannelRef {
            universe: 2,
            address: 56,
        },
        end: DmxChannelRef {
            universe: 2,
            address: 59,
        },
    };
    let expanded = range.expand();
    assert_eq!(expanded.len(), 4);
    assert_eq!(expanded[0].address, 56);
    assert_eq!(expanded[1].address, 57);
    assert_eq!(expanded[2].address, 58);
    assert_eq!(expanded[3].address, 59);

    // Test add
    let add = DmxChannelExpr::Add {
        lhs: Box::new(DmxChannelExpr::Single(DmxChannelRef {
            universe: 1,
            address: 1,
        })),
        rhs: Box::new(DmxChannelExpr::Single(DmxChannelRef {
            universe: 1,
            address: 2,
        })),
    };
    let expanded = add.expand();
    assert_eq!(expanded.len(), 2);
    assert!(expanded.contains(&DmxChannelRef {
        universe: 1,
        address: 1
    }));
    assert!(expanded.contains(&DmxChannelRef {
        universe: 1,
        address: 2
    }));
}

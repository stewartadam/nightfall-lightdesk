// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::command_types::DmxChannelExpr;
use nightfall::prelude::ColorPathId;
use nightfall_cmd_parse::generate_ast;
use nightfall_dmx::prelude::{Attribute, ParameterValue, Percentage};
use nightfall_engine::prelude::*;
use nightfall_fixtures::FixtureCommand;
use nightfall_fixtures::ast_conv::FixtureAstConverter;
use nightfall_fixtures::prelude::{BindingEndpoint, DmxRange};

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_delete_fixture_aliases() {
    let base_ast = generate_ast("delete fixture 1").expect("Failed to parse 'delete fixture 1'");

    // Test "delete" command aliases
    let del_ast = generate_ast("del fixture 1").expect("Failed to parse 'del fixture 1'");
    assert_eq!(
        base_ast, del_ast,
        "'del' should produce identical AST to 'delete'"
    );

    let rm_ast = generate_ast("rm fixture 1").expect("Failed to parse 'rm fixture 1'");
    assert_eq!(
        base_ast, rm_ast,
        "'rm' should produce identical AST to 'delete'"
    );

    // Test "fixture" object type aliases
    let delete_fix_ast = generate_ast("delete fix 1").expect("Failed to parse 'delete fix 1'");
    assert_eq!(
        base_ast, delete_fix_ast,
        "'fix' should produce identical AST to 'fixture'"
    );

    let del_fix_ast = generate_ast("del fix 1").expect("Failed to parse 'del fix 1'");
    assert_eq!(
        base_ast, del_fix_ast,
        "'del fix' should produce identical AST to 'delete fixture'"
    );

    let rm_fix_ast = generate_ast("rm fix 1").expect("Failed to parse 'rm fix 1'");
    assert_eq!(
        base_ast, rm_fix_ast,
        "'rm fix' should produce identical AST to 'delete fixture'"
    );

    let delete_f_ast = generate_ast("delete f 1").expect("Failed to parse 'delete f 1'");
    assert_eq!(
        base_ast, delete_f_ast,
        "'f' should produce identical AST to 'fixture'"
    );

    let del_f_ast = generate_ast("del f 1").expect("Failed to parse 'del f 1'");
    assert_eq!(
        base_ast, del_f_ast,
        "'del f' should produce identical AST to 'delete fixture'"
    );

    let rm_f_ast = generate_ast("rm f 1").expect("Failed to parse 'rm f 1'");
    assert_eq!(
        base_ast, rm_f_ast,
        "'rm f' should produce identical AST to 'delete fixture'"
    );
}

#[test]
fn test_rename_fixture_aliases() {
    let base_ast =
        generate_ast("rename fixture 1 2").expect("Failed to parse 'rename fixture 1 2'");

    // Test "rename" command aliases
    let mv_ast = generate_ast("mv fixture 1 2").expect("Failed to parse 'mv fixture 1 2'");
    assert_eq!(
        base_ast, mv_ast,
        "'mv' should produce identical AST to 'rename'"
    );

    // Test "fixture" object type aliases
    let rename_fix_ast = generate_ast("rename fix 1 2").expect("Failed to parse 'rename fix 1 2'");
    assert_eq!(
        base_ast, rename_fix_ast,
        "'fix' should produce identical AST to 'fixture'"
    );

    let mv_fix_ast = generate_ast("mv fix 1 2").expect("Failed to parse 'mv fix 1 2'");
    assert_eq!(
        base_ast, mv_fix_ast,
        "'mv fix' should produce identical AST to 'rename fixture'"
    );

    let rename_f_ast = generate_ast("rename f 1 2").expect("Failed to parse 'rename f 1 2'");
    assert_eq!(
        base_ast, rename_f_ast,
        "'f' should produce identical AST to 'fixture'"
    );

    let mv_f_ast = generate_ast("mv f 1 2").expect("Failed to parse 'mv f 1 2'");
    assert_eq!(
        base_ast, mv_f_ast,
        "'mv f' should produce identical AST to 'rename fixture'"
    );
}

#[test]
fn test_delete_fixture_range() {
    let ast = generate_ast("delete fixture 1>10").expect("Failed to parse 'delete fixture 1>10'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    // Should generate 10 commands (fixtures 1 through 10 inclusive)
    assert_eq!(commands.len(), 10, "Expected 10 commands for range 1>10");

    // Verify each command is a DeleteFixture with the correct ID
    for (i, cmd) in commands.iter().enumerate() {
        let fixture_cmd = cmd.as_any().downcast_ref::<FixtureCommand>();
        assert!(
            fixture_cmd.is_some(),
            "Command {} is not a FixtureCommand",
            i
        );

        match fixture_cmd.unwrap() {
            FixtureCommand::DeleteFixture(id) => {
                assert_eq!(
                    *id,
                    (i + 1) as u32,
                    "Expected fixture ID {}, got {}",
                    i + 1,
                    id
                );
            }
            other => panic!("Expected DeleteFixture command, got {:?}", other),
        }
    }
}

#[test]
fn test_delete_fixture_range_additive() {
    let ast =
        generate_ast("delete fixture 1>5+10").expect("Failed to parse 'delete fixture 1>5+10'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    // Should generate 6 commands (1,2,3,4,5,10)
    assert_eq!(commands.len(), 6, "Expected 6 commands for range 1>5+10");

    let expected_ids: Vec<u32> = vec![1, 2, 3, 4, 5, 10];
    for (i, cmd) in commands.iter().enumerate() {
        let fixture_cmd = cmd
            .as_any()
            .downcast_ref::<FixtureCommand>()
            .expect("Command is not a FixtureCommand");
        match fixture_cmd {
            FixtureCommand::DeleteFixture(id) => {
                assert_eq!(
                    *id, expected_ids[i],
                    "Expected fixture ID {}, got {}",
                    expected_ids[i], id
                );
            }
            other => panic!("Expected DeleteFixture command, got {:?}", other),
        }
    }
}

#[test]
fn test_delete_fixture_range_subtractive() {
    let ast =
        generate_ast("delete fixture 1>10-5").expect("Failed to parse 'delete fixture 1>10-5'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    // Should generate 9 commands (1,2,3,4,6,7,8,9,10 - excluding 5)
    assert_eq!(commands.len(), 9, "Expected 9 commands for range 1>10-5");

    // Verify fixture 5 is not in the list
    for cmd in commands.iter() {
        let fixture_cmd = cmd
            .as_any()
            .downcast_ref::<FixtureCommand>()
            .expect("Command is not a FixtureCommand");
        match fixture_cmd {
            FixtureCommand::DeleteFixture(id) => {
                assert_ne!(*id, 5, "Fixture 5 should be excluded from range");
            }
            other => panic!("Expected DeleteFixture command, got {:?}", other),
        }
    }
}

#[test]
fn test_delete_fixture_complex_expression() {
    // Complex expression: two ranges added, then a range subtracted
    // 1>5 = [1,2,3,4,5], +10>12 = [1,2,3,4,5,10,11,12], -3>4 = [1,2,5,10,11,12]
    let ast = generate_ast("delete fixture 1>5+10>12-3>4")
        .expect("Failed to parse 'delete fixture 1>5+10>12-3>4'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    let expected_ids: Vec<u32> = vec![1, 2, 5, 10, 11, 12];
    assert_eq!(
        commands.len(),
        expected_ids.len(),
        "Expected {} commands for 1>5+10>12-3>4",
        expected_ids.len()
    );

    for (i, cmd) in commands.iter().enumerate() {
        let fixture_cmd = cmd
            .as_any()
            .downcast_ref::<FixtureCommand>()
            .expect("Command is not a FixtureCommand");
        match fixture_cmd {
            FixtureCommand::DeleteFixture(id) => {
                assert_eq!(
                    *id, expected_ids[i],
                    "Expected fixture ID {}, got {}",
                    expected_ids[i], id
                );
            }
            other => panic!("Expected DeleteFixture command, got {:?}", other),
        }
    }
}

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_delete_fixture_conversion() {
    let ast = generate_ast("delete fixture 1").expect("Failed to parse 'delete fixture 1'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::DeleteFixture(fixture_id) => {
            assert_eq!(*fixture_id, 1, "Expected fixture ID 1, got {}", fixture_id);
        }
        other => panic!("Expected DeleteFixture command, got {:?}", other),
    }
}

#[test]
fn test_rename_fixture_conversion() {
    let ast = generate_ast("rename fixture 1 2").expect("Failed to parse 'rename fixture 1 2'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::RenameFixture { id, new_id } => {
            assert_eq!(*id, 1, "Expected original fixture ID 1, got {}", id);
            assert_eq!(*new_id, 2, "Expected new fixture ID 2, got {}", new_id);
        }
        other => panic!("Expected RenameFixture command, got {:?}", other),
    }
}

#[test]
fn test_rename_fixture_different_ids_conversion() {
    let ast = generate_ast("rename fixture 5 15").expect("Failed to parse 'rename fixture 5 15'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::RenameFixture { id, new_id } => {
            assert_eq!(*id, 5, "Expected original fixture ID 5, got {}", id);
            assert_eq!(*new_id, 15, "Expected new fixture ID 15, got {}", new_id);
        }
        other => panic!("Expected RenameFixture command, got {:?}", other),
    }
}

#[test]
fn test_store_fixture_offset_conversion() {
    let ast = generate_ast("store fixture 1 offset red 10")
        .expect("Failed to parse 'store fixture 1 offset red 10'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::UpdateFixtureParameterOffset {
            id,
            attribute,
            offset,
        } => {
            assert_eq!(*id, 1, "Expected fixture ID 1, got {}", id);
            assert_eq!(*attribute, Attribute::Red, "Expected red attribute");
            assert_eq!(
                *offset,
                ParameterValue::Absolute { value: 10.0 },
                "Expected absolute offset 10.0, got {:?}",
                offset
            );
        }
        other => panic!(
            "Expected UpdateFixtureParameterOffset command, got {:?}",
            other
        ),
    }
}

#[test]
fn test_store_fixture_offset_signed_conversion() {
    let ast = generate_ast("store fixture 1 offset red +30")
        .expect("Failed to parse 'store fixture 1 offset red +30'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::UpdateFixtureParameterOffset { offset, .. } => {
            assert_eq!(
                *offset,
                ParameterValue::Absolute { value: 30.0 },
                "Expected absolute offset 30.0, got {:?}",
                offset
            );
        }
        other => panic!(
            "Expected UpdateFixtureParameterOffset command, got {:?}",
            other
        ),
    }
}

#[test]
fn test_store_fixture_offset_percent_conversion() {
    let ast = generate_ast("store fixture 1 offset pan 25%")
        .expect("Failed to parse 'store fixture 1 offset pan 25%'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::UpdateFixtureParameterOffset {
            id,
            attribute,
            offset,
        } => {
            assert_eq!(*id, 1, "Expected fixture ID 1, got {}", id);
            assert_eq!(*attribute, Attribute::Pan, "Expected pan attribute");
            assert_eq!(
                *offset,
                ParameterValue::AbsolutePercent {
                    value: Percentage::from(0.25),
                },
                "Expected absolute percent offset 25%, got {:?}",
                offset
            );
        }
        other => panic!(
            "Expected UpdateFixtureParameterOffset command, got {:?}",
            other
        ),
    }
}

/// Verifies fixture path assignment converts to a by-ID fixture command.
#[test]
fn test_fixture_path_default_conversion() {
    let ast = generate_ast("fixture 301 path 101").expect("Failed to parse 'fixture 301 path 101'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::SetColorPathDefaultById {
            id,
            element_index,
            color_path_id,
        } => {
            assert_eq!(*id, 301, "Expected fixture ID 301, got {}", id);
            assert_eq!(
                *element_index, None,
                "Expected whole-fixture color path default"
            );
            assert_eq!(
                *color_path_id,
                Some(ColorPathId(101)),
                "Expected color path ID 101"
            );
        }
        other => panic!("Expected SetColorPathDefaultById command, got {:?}", other),
    }
}

/// Verifies fixture element path assignment preserves the element index.
#[test]
fn test_fixture_element_path_default_conversion() {
    let ast =
        generate_ast("fixture 301.2 path 101").expect("Failed to parse 'fixture 301.2 path 101'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::SetColorPathDefaultById {
            id,
            element_index,
            color_path_id,
        } => {
            assert_eq!(*id, 301, "Expected fixture ID 301, got {}", id);
            assert_eq!(*element_index, Some(2), "Expected element index 2");
            assert_eq!(
                *color_path_id,
                Some(ColorPathId(101)),
                "Expected color path ID 101"
            );
        }
        other => panic!("Expected SetColorPathDefaultById command, got {:?}", other),
    }
}

/// Verifies fixture path clearing converts to a by-ID fixture command without a path ID.
#[test]
fn test_fixture_path_default_clear_conversion() {
    let ast =
        generate_ast("fixture 301 path clear").expect("Failed to parse 'fixture 301 path clear'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::SetColorPathDefaultById {
            id,
            element_index,
            color_path_id,
        } => {
            assert_eq!(*id, 301, "Expected fixture ID 301, got {}", id);
            assert_eq!(
                *element_index, None,
                "Expected whole-fixture color path default"
            );
            assert_eq!(*color_path_id, None, "Expected cleared color path ID");
        }
        other => panic!("Expected SetColorPathDefaultById command, got {:?}", other),
    }
}

#[test]
fn test_channel_command_aliases() {
    let base_ast = generate_ast("channel 1.1 @ 255").expect("Failed to parse 'channel 1.1 @ 255'");

    // Test "chan" alias produces identical AST to "channel"
    let chan_ast = generate_ast("chan 1.1 @ 255").expect("Failed to parse 'chan 1.1 @ 255'");
    assert_eq!(
        base_ast, chan_ast,
        "'chan' should produce identical AST to 'channel'"
    );

    // Test "ch" alias produces identical AST to "channel"
    let ch_ast = generate_ast("ch 1.1 @ 255").expect("Failed to parse 'ch 1.1 @ 255'");
    assert_eq!(
        base_ast, ch_ast,
        "'ch' should produce identical AST to 'channel'"
    );
}

#[test]
fn test_set_dmx_channel_single_conversion() {
    let ast = generate_ast("ch 1.1 @ 255").expect("Failed to parse 'ch 1.1 @ 255'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::SetDmxChannels { channels, value } => {
            assert_eq!(*value, 255, "Expected DMX value 255, got {}", value);

            // Verify it's a single channel expression
            match channels {
                DmxChannelExpr::Single(ch_ref) => {
                    assert_eq!(
                        ch_ref.universe, 1,
                        "Expected universe 1, got {}",
                        ch_ref.universe
                    );
                    assert_eq!(
                        ch_ref.address, 1,
                        "Expected address 1, got {}",
                        ch_ref.address
                    );
                }
                other => panic!("Expected Single channel expression, got {:?}", other),
            }
        }
        other => panic!("Expected SetDmxChannels command, got {:?}", other),
    }
}

#[test]
fn test_set_dmx_channel_different_value_conversion() {
    let ast = generate_ast("ch 2.56 @ 128").expect("Failed to parse 'ch 2.56 @ 128'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::SetDmxChannels { channels, value } => {
            assert_eq!(*value, 128, "Expected DMX value 128, got {}", value);

            match channels {
                DmxChannelExpr::Single(ch_ref) => {
                    assert_eq!(
                        ch_ref.universe, 2,
                        "Expected universe 2, got {}",
                        ch_ref.universe
                    );
                    assert_eq!(
                        ch_ref.address, 56,
                        "Expected address 56, got {}",
                        ch_ref.address
                    );
                }
                other => panic!("Expected Single channel expression, got {:?}", other),
            }
        }
        other => panic!("Expected SetDmxChannels command, got {:?}", other),
    }
}

#[test]
fn test_set_dmx_channel_range_conversion() {
    let ast = generate_ast("ch 2.56>2.59 @ 255").expect("Failed to parse 'ch 2.56>2.59 @ 255'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::SetDmxChannels { channels, value } => {
            assert_eq!(*value, 255, "Expected DMX value 255, got {}", value);

            match channels {
                DmxChannelExpr::Range { start, end } => {
                    assert_eq!(
                        start.universe, 2,
                        "Expected start universe 2, got {}",
                        start.universe
                    );
                    assert_eq!(
                        start.address, 56,
                        "Expected start address 56, got {}",
                        start.address
                    );
                    assert_eq!(
                        end.universe, 2,
                        "Expected end universe 2, got {}",
                        end.universe
                    );
                    assert_eq!(
                        end.address, 59,
                        "Expected end address 59, got {}",
                        end.address
                    );
                }
                other => panic!("Expected Range channel expression, got {:?}", other),
            }
        }
        other => panic!("Expected SetDmxChannels command, got {:?}", other),
    }
}

#[test]
fn test_set_dmx_channel_additive_conversion() {
    let ast =
        generate_ast("ch 2.56>2.59+3.51 @ 255").expect("Failed to parse 'ch 2.56>2.59+3.51 @ 255'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::SetDmxChannels { channels, value } => {
            assert_eq!(*value, 255, "Expected DMX value 255, got {}", value);

            // Verify it's an Add expression
            match channels {
                DmxChannelExpr::Add { lhs, rhs } => {
                    // Verify LHS is a range
                    match lhs.as_ref() {
                        DmxChannelExpr::Range { start, end } => {
                            assert_eq!(start.universe, 2);
                            assert_eq!(start.address, 56);
                            assert_eq!(end.universe, 2);
                            assert_eq!(end.address, 59);
                        }
                        other => panic!("Expected Range in LHS, got {:?}", other),
                    }

                    // Verify RHS is a single channel
                    match rhs.as_ref() {
                        DmxChannelExpr::Single(ch_ref) => {
                            assert_eq!(ch_ref.universe, 3);
                            assert_eq!(ch_ref.address, 51);
                        }
                        other => panic!("Expected Single in RHS, got {:?}", other),
                    }
                }
                other => panic!("Expected Add channel expression, got {:?}", other),
            }
        }
        other => panic!("Expected SetDmxChannels command, got {:?}", other),
    }
}

#[test]
fn test_set_dmx_channel_subtractive_conversion() {
    let ast =
        generate_ast("ch 1.1>1.10-1.5 @ 100").expect("Failed to parse 'ch 1.1>1.10-1.5 @ 100'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::SetDmxChannels { channels, value } => {
            assert_eq!(*value, 100, "Expected DMX value 100, got {}", value);

            // Verify it's a Sub expression
            match channels {
                DmxChannelExpr::Sub { lhs, rhs } => {
                    // Verify LHS is a range
                    match lhs.as_ref() {
                        DmxChannelExpr::Range { start, end } => {
                            assert_eq!(start.universe, 1);
                            assert_eq!(start.address, 1);
                            assert_eq!(end.universe, 1);
                            assert_eq!(end.address, 10);
                        }
                        other => panic!("Expected Range in LHS, got {:?}", other),
                    }

                    // Verify RHS is a single channel
                    match rhs.as_ref() {
                        DmxChannelExpr::Single(ch_ref) => {
                            assert_eq!(ch_ref.universe, 1);
                            assert_eq!(ch_ref.address, 5);
                        }
                        other => panic!("Expected Single in RHS, got {:?}", other),
                    }
                }
                other => panic!("Expected Sub channel expression, got {:?}", other),
            }
        }
        other => panic!("Expected SetDmxChannels command, got {:?}", other),
    }
}

#[test]
fn test_set_dmx_channel_grouped_conversion() {
    let ast = generate_ast("ch (1.1+1.2) @ 50").expect("Failed to parse 'ch (1.1+1.2) @ 50'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::SetDmxChannels { channels, value } => {
            assert_eq!(*value, 50, "Expected DMX value 50, got {}", value);

            // Verify it's a Span wrapping an Add expression
            match channels {
                DmxChannelExpr::Span(inner) => match inner.as_ref() {
                    DmxChannelExpr::Add { lhs, rhs } => match (lhs.as_ref(), rhs.as_ref()) {
                        (DmxChannelExpr::Single(ch1), DmxChannelExpr::Single(ch2)) => {
                            assert_eq!(ch1.universe, 1);
                            assert_eq!(ch1.address, 1);
                            assert_eq!(ch2.universe, 1);
                            assert_eq!(ch2.address, 2);
                        }
                        other => panic!("Expected Single channels in Add, got {:?}", other),
                    },
                    other => panic!("Expected Add in Span, got {:?}", other),
                },
                other => panic!("Expected Span channel expression, got {:?}", other),
            }
        }
        other => panic!("Expected SetDmxChannels command, got {:?}", other),
    }
}

// Fixture Placement Command Tests
#[test]
fn test_fixture_placement_position_axis_chain_conversion() {
    let ast = generate_ast("fix 1 3d pos (1.5,2.0,3.5)")
        .expect("Failed to parse 'fix 1 3d pos (1.5,2.0,3.5)'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::UpdateFixturePlacements { updates } => {
            assert_eq!(updates.len(), 1, "Expected one fixture update");

            let update = &updates[0];
            assert_eq!(update.id, 1, "Expected fixture ID 1, got {}", update.id);
            match update.position.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementPositionUpdate::All(position) => {
                    assert_eq!(position.x, 1.5, "Expected x=1.5, got {}", position.x);
                    assert_eq!(position.y, 2.0, "Expected y=2.0, got {}", position.y);
                    assert_eq!(position.z, 3.5, "Expected z=3.5, got {}", position.z);
                }
                other => panic!("Expected full position update, got {:?}", other),
            }
            assert!(update.rotation.is_none(), "Rotation should not be set");
        }
        other => panic!("Expected UpdateFixturePlacements command, got {:?}", other),
    }
}

#[test]
fn test_fixture_placement_position_single_axis_conversion() {
    let ast = generate_ast("fix 1 3d pos x 1.5").expect("Failed to parse 'fix 1 3d pos x 1.5'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::UpdateFixturePlacements { updates } => {
            assert_eq!(updates.len(), 1, "Expected one fixture update");
            let update = &updates[0];
            assert_eq!(update.id, 1, "Expected fixture ID 1, got {}", update.id);

            assert!(update.position.is_some(), "Position should be set");
            match update.position.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementPositionUpdate::X(x) => {
                    assert_eq!(*x, 1.5, "Expected x=1.5, got {}", x);
                }
                other => panic!("Expected X position update, got {:?}", other),
            }

            assert!(update.rotation.is_none(), "Rotation should not be set");
        }
        other => panic!("Expected UpdateFixturePlacements command, got {:?}", other),
    }
}

#[test]
fn test_fixture_placement_position_multi_axis_chain_conversion() {
    let ast = generate_ast("fix 1 3d pos x 1.5 y 2.0 z 3.5")
        .expect("Failed to parse 'fix 1 3d pos x 1.5 y 2.0 z 3.5'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::UpdateFixturePlacements { updates } => {
            assert_eq!(updates.len(), 3, "Expected three fixture updates");

            match updates[0].position.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementPositionUpdate::X(x) => {
                    assert_eq!(*x, 1.5, "Expected x=1.5, got {}", x);
                }
                other => panic!("Expected X position update, got {:?}", other),
            }

            match updates[1].position.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementPositionUpdate::Y(y) => {
                    assert_eq!(*y, 2.0, "Expected y=2.0, got {}", y);
                }
                other => panic!("Expected Y position update, got {:?}", other),
            }

            match updates[2].position.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementPositionUpdate::Z(z) => {
                    assert_eq!(*z, 3.5, "Expected z=3.5, got {}", z);
                }
                other => panic!("Expected Z position update, got {:?}", other),
            }
        }
        other => panic!("Expected UpdateFixturePlacements command, got {:?}", other),
    }
}

#[test]
fn test_fixture_placement_rotation_axis_chain_conversion() {
    let ast =
        generate_ast("fix 1 3d rot (0,90,0)").expect("Failed to parse 'fix 1 3d rot (0,90,0)'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::UpdateFixturePlacements { updates } => {
            assert_eq!(updates.len(), 1, "Expected one fixture update");

            let update = &updates[0];
            assert_eq!(update.id, 1, "Expected fixture ID 1, got {}", update.id);
            assert!(update.position.is_none(), "Position should not be set");
            match update.rotation.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementRotationUpdate::All(rotation) => {
                    assert_eq!(rotation.x, 0.0, "Expected x=0, got {}", rotation.x);
                    assert_eq!(rotation.y, 90.0, "Expected y=90, got {}", rotation.y);
                    assert_eq!(rotation.z, 0.0, "Expected z=0, got {}", rotation.z);
                }
                other => panic!("Expected full rotation update, got {:?}", other),
            }
        }
        other => panic!("Expected UpdateFixturePlacements command, got {:?}", other),
    }
}

#[test]
fn test_fixture_placement_rotation_multi_axis_chain_conversion() {
    let ast = generate_ast("fix 1 3d rot x 0 y 90 z 0")
        .expect("Failed to parse 'fix 1 3d rot x 0 y 90 z 0'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::UpdateFixturePlacements { updates } => {
            assert_eq!(updates.len(), 3, "Expected three fixture updates");

            match updates[0].rotation.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementRotationUpdate::X(x) => {
                    assert_eq!(*x, 0.0, "Expected x=0, got {}", x);
                }
                other => panic!("Expected X rotation update, got {:?}", other),
            }

            match updates[1].rotation.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementRotationUpdate::Y(y) => {
                    assert_eq!(*y, 90.0, "Expected y=90, got {}", y);
                }
                other => panic!("Expected Y rotation update, got {:?}", other),
            }

            match updates[2].rotation.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementRotationUpdate::Z(z) => {
                    assert_eq!(*z, 0.0, "Expected z=0, got {}", z);
                }
                other => panic!("Expected Z rotation update, got {:?}", other),
            }
        }
        other => panic!("Expected UpdateFixturePlacements command, got {:?}", other),
    }
}

#[test]
fn test_fixture_placement_combined_conversion() {
    let ast = generate_ast("fix 1 3d pos x 1 rot z 180")
        .expect("Failed to parse 'fix 1 3d pos x 1 rot z 180'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::UpdateFixturePlacements { updates } => {
            assert_eq!(updates.len(), 2, "Expected two fixture updates");

            let update_x = &updates[0];
            assert_eq!(update_x.id, 1, "Expected fixture ID 1, got {}", update_x.id);
            match update_x.position.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementPositionUpdate::X(x) => {
                    assert_eq!(*x, 1.0, "Expected x=1, got {}", x);
                }
                other => panic!("Expected X position update, got {:?}", other),
            }
            assert!(update_x.rotation.is_none(), "Rotation should not be set");

            let update_z = &updates[1];
            assert_eq!(update_z.id, 1, "Expected fixture ID 1, got {}", update_z.id);
            assert!(update_z.position.is_none(), "Position should not be set");
            match update_z.rotation.as_ref().unwrap() {
                nightfall_fixtures::FixturePlacementRotationUpdate::Z(z) => {
                    assert_eq!(*z, 180.0, "Expected z=180, got {}", z);
                }
                other => panic!("Expected Z rotation update, got {:?}", other),
            }
        }
        other => panic!("Expected UpdateFixturePlacements command, got {:?}", other),
    }
}

// Store Fixture Command Tests
#[test]
fn test_store_fixture_rgbw_bar_conversion() {
    let ast = generate_ast("store fix 1 \"Generic\" \"12-segment RGBW Bar\" RGBW")
        .expect("Failed to parse 'store fix 1 \"Generic\" \"12-segment RGBW Bar\" RGBW'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::StoreFixture(fixture) => {
            assert_eq!(
                fixture.identifiers.id, 1,
                "Expected fixture ID 1, got {}",
                fixture.identifiers.id
            );
            assert_eq!(
                fixture.make, "Generic",
                "Expected make 'Generic', got {}",
                fixture.make
            );
            assert_eq!(
                fixture.model, "12-segment RGBW Bar",
                "Expected model '12-segment RGBW Bar', got {}",
                fixture.model
            );
            assert_eq!(
                fixture.elements.len(),
                12,
                "Expected 12 elements for RGBW bar, got {}",
                fixture.elements.len()
            );
        }
        other => panic!("Expected StoreFixture command, got {:?}", other),
    }
}

/// Verifies fixture store ranges instantiate the requested fixture for each ID.
#[test]
fn test_store_fixture_range_conversion() {
    let ast = generate_ast("store fix 1>3 \"Generic\" \"12-segment RGBW Bar\" RGBW")
        .expect("Failed to parse fixture store range");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    let ids = commands
        .iter()
        .map(|command| {
            let command = command
                .as_any()
                .downcast_ref::<FixtureCommand>()
                .expect("Command is not a FixtureCommand");
            let FixtureCommand::StoreFixture(fixture) = command else {
                panic!("Expected StoreFixture command, got {command:?}");
            };
            fixture.identifiers.id
        })
        .collect::<Vec<_>>();

    assert_eq!(ids, vec![1, 2, 3]);
}

#[test]
fn test_store_fixture_rgb_bar_conversion() {
    let ast = generate_ast("store fix 2 \"Generic\" \"RGBPixelTape 180ch\" RGB")
        .expect("Failed to parse 'store fix 2 \"Generic\" \"RGBPixelTape 180ch\" RGB'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::StoreFixture(fixture) => {
            assert_eq!(
                fixture.identifiers.id, 2,
                "Expected fixture ID 2, got {}",
                fixture.identifiers.id
            );
            assert_eq!(
                fixture.elements.len(),
                60,
                "Expected 60 elements for RGB bar, got {}",
                fixture.elements.len()
            );
        }
        other => panic!("Expected StoreFixture command, got {:?}", other),
    }
}

#[test]
fn test_store_fixture_strobe_conversion() {
    let ast = generate_ast("store fix 3 \"Generic\" \"Strobe Matrix 308ch\" Strobe")
        .expect("Failed to parse 'store fix 3 \"Generic\" \"Strobe Matrix 308ch\" Strobe'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::StoreFixture(fixture) => {
            assert_eq!(
                fixture.identifiers.id, 3,
                "Expected fixture ID 3, got {}",
                fixture.identifiers.id
            );
            assert_eq!(
                fixture.elements.len(),
                115,
                "Expected 115 elements for strobe (96 RGB + 16 white + 3 control), got {}",
                fixture.elements.len()
            );
        }
        other => panic!("Expected StoreFixture command, got {:?}", other),
    }
}

/// Verifies the 312-channel strobe profile is available through fixture commands.
#[test]
fn test_store_fixture_strobe_312ch_conversion() {
    let ast = generate_ast("store fix 4 \"Generic\" \"Strobe Matrix 312ch\" Strobe")
        .expect("Failed to parse the 312-channel strobe store command");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::StoreFixture(fixture) => {
            assert_eq!(fixture.identifiers.id, 4);
            assert_eq!(fixture.elements.len(), 119);
            assert_eq!(fixture.elements[22].label, "Strobe Dimmer 20");
            assert_eq!(fixture.elements[23].label, "RGB Pixel 1");
        }
        other => panic!("Expected StoreFixture command, got {:?}", other),
    }
}

#[test]
fn test_store_fixture_rgb_strobe_bar_conversion() {
    let ast = generate_ast("store fix 5 \"Generic\" \"RGB Strobe Bar 168ch\" Strobe")
        .expect("Failed to parse 'store fix 5 \"Generic\" \"RGB Strobe Bar 168ch\" Strobe'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::StoreFixture(fixture) => {
            assert_eq!(
                fixture.identifiers.id, 5,
                "Expected fixture ID 5, got {}",
                fixture.identifiers.id
            );
            assert_eq!(
                fixture.elements.len(),
                72,
                "Expected 72 elements for RGB strobe bar, got {}",
                fixture.elements.len()
            );
            assert_eq!(fixture.elements[0].label, "White Segment 1");
            assert_eq!(fixture.elements[24].label, "Top RGB Segment 1");
            assert_eq!(fixture.elements[48].label, "Bottom RGB Segment 1");
        }
        other => panic!("Expected StoreFixture command, got {:?}", other),
    }
}

#[test]
/// Verifies store fixture conversion can create the Generic wash beam profile.
fn test_store_fixture_rotating_wash_beam_conversion() {
    let ast = generate_ast("store fix 6 \"Generic\" \"12-segment Rotating Wash Beam\" Beam")
        .expect("Failed to parse 'store fix 6 \"Generic\" \"12-segment Rotating Wash Beam\" Beam'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::StoreFixture(fixture) => {
            assert_eq!(
                fixture.identifiers.id, 6,
                "Expected fixture ID 6, got {}",
                fixture.identifiers.id
            );
            assert_eq!(
                fixture.elements.len(),
                37,
                "Expected 37 elements for Generic wash beam, got {}",
                fixture.elements.len()
            );
            assert_eq!(fixture.elements[0].label, "Control");
            assert_eq!(fixture.elements[1].label, "Beam 1");
            assert_eq!(fixture.elements[12].label, "Beam 12");
            assert_eq!(fixture.elements[13].label, "Top Strip Pixel 1");
            assert_eq!(fixture.elements[25].label, "Bottom Strip Pixel 1");
        }
        other => panic!("Expected StoreFixture command, got {:?}", other),
    }
}

#[test]
fn test_store_fixture_moving_spot_conversion() {
    let ast = generate_ast("store fix 4 \"Generic\" \"Moving Head RGBW\" Spot")
        .expect("Failed to parse 'store fix 4 \"Generic\" \"Moving Head RGBW\" Spot'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::StoreFixture(fixture) => {
            assert_eq!(
                fixture.identifiers.id, 4,
                "Expected fixture ID 4, got {}",
                fixture.identifiers.id
            );
            assert_eq!(
                fixture.elements.len(),
                1,
                "Expected 1 element for moving spot, got {}",
                fixture.elements.len()
            );
            assert!(
                fixture.physical.is_some(),
                "Moving spot should have physical data"
            );
        }
        other => panic!("Expected StoreFixture command, got {:?}", other),
    }
}

#[test]
fn test_store_fixture_unknown_model_error() {
    let ast = generate_ast("store fix 1 \"Unknown\" \"Unknown Model\" UnknownMode")
        .expect("Failed to parse 'store fix 1 \"Unknown\" \"Unknown Model\" UnknownMode'");
    let result = FixtureAstConverter::convert(&ast);

    assert!(
        result.is_err(),
        "Should fail to convert unknown fixture make/model"
    );
    match result {
        Err(nightfall_engine::prelude::DispatchError::ConversionFailed(msg)) => {
            assert!(
                msg.contains("unknown fixture"),
                "Error message should mention unknown fixture"
            );
        }
        other => panic!("Expected ConversionFailed error, got {:?}", other),
    }
}

#[test]
fn test_patch_binding_transport_to_console_conversion() {
    let ast = generate_ast("patch sacn:1 @ console:5")
        .expect("Failed to parse 'patch sacn:1 @ console:5'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::PatchBinding {
            source,
            target,
            priority,
            clone,
        } => {
            assert_eq!(*priority, 0, "Expected default priority 0");
            assert!(!*clone, "Expected clone to be false");
            assert_eq!(
                *source,
                BindingEndpoint::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange { start: 1, end: 1 }),
                    address: None,
                }
            );
            assert_eq!(
                *target,
                BindingEndpoint::Console {
                    universe: Some(DmxRange { start: 5, end: 5 }),
                    address: None,
                }
            );
        }
        other => panic!("Expected PatchBinding command, got {:?}", other),
    }
}

/// Verifies `break N` converts to a whole-fixture break endpoint, and that
/// break 1 or an element-qualified break is rejected.
#[test]
fn test_patch_binding_fixture_break_conversion() {
    let ast = generate_ast("patch fix 12 break 2 @ artnet:2.1")
        .expect("Failed to parse fixture break patch");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");
    match commands[0].as_any().downcast_ref::<FixtureCommand>() {
        Some(FixtureCommand::PatchBinding { source, .. }) => assert_eq!(
            *source,
            BindingEndpoint::FixtureBreak {
                ids: vec![12],
                dmx_break: 2,
            }
        ),
        other => panic!("Expected PatchBinding command, got {:?}", other),
    }

    for input in [
        "patch fix 12 break 1 @ artnet:2.1",
        "patch fix 12.1 break 2 @ artnet:2.1",
    ] {
        let ast = generate_ast(input).expect("Failed to parse fixture break patch");
        assert!(
            FixtureAstConverter::convert(&ast).is_err(),
            "{input} should be rejected"
        );
    }
}

#[test]
fn test_patch_binding_transport_to_transport_compact_syntax_conversion() {
    let ast = generate_ast("patch sacn@sacn").expect("Failed to parse 'patch sacn@sacn'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::PatchBinding {
            source,
            target,
            priority,
            clone,
        } => {
            assert_eq!(*priority, 0, "Expected default priority 0");
            assert!(!*clone, "Expected clone to be false");
            assert_eq!(
                *source,
                BindingEndpoint::Transport {
                    target: "sacn".to_string(),
                    universe: None,
                    address: None,
                }
            );
            assert_eq!(
                *target,
                BindingEndpoint::Transport {
                    target: "sacn".to_string(),
                    universe: None,
                    address: None,
                }
            );
        }
        other => panic!("Expected PatchBinding command, got {:?}", other),
    }
}

#[test]
fn test_patch_binding_transport_to_fixture_clone_conversion() {
    let ast = generate_ast("patch artnet:3.78 @ fix 311>315 .1 param intensity prio 2 /clone")
        .expect("Failed to parse patch binding with fixture target");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::PatchBinding {
            source,
            target,
            priority,
            clone,
        } => {
            assert_eq!(*priority, 2, "Expected priority 2");
            assert!(*clone, "Expected clone to be true");
            assert_eq!(
                *source,
                BindingEndpoint::Transport {
                    target: "artnet".to_string(),
                    universe: Some(DmxRange { start: 3, end: 3 }),
                    address: Some(78),
                }
            );
            assert_eq!(
                *target,
                BindingEndpoint::Fixture {
                    ids: vec![311, 312, 313, 314, 315],
                    element: Some(1),
                    param: Some("intensity".to_string()),
                }
            );
        }
        other => panic!("Expected PatchBinding command, got {:?}", other),
    }
}

#[test]
fn test_patch_binding_transport_to_disabled_conversion() {
    let ast = generate_ast("patch artnet:1>5 @ disabled")
        .expect("Failed to parse 'patch artnet:1>5 @ disabled'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::PatchBinding {
            source,
            target,
            priority,
            clone,
        } => {
            assert_eq!(*priority, 0, "Expected default priority 0");
            assert!(!*clone, "Expected clone to be false");
            assert_eq!(
                *source,
                BindingEndpoint::Transport {
                    target: "artnet".to_string(),
                    universe: Some(DmxRange { start: 1, end: 5 }),
                    address: None,
                }
            );
            assert_eq!(*target, BindingEndpoint::Disabled);
        }
        other => panic!("Expected PatchBinding command, got {:?}", other),
    }
}

#[test]
fn test_patch_binding_fixture_to_fixture_clone_conversion() {
    let ast = generate_ast("patch fix 211 @ fix 311>315 /clone")
        .expect("Failed to parse 'patch fix 211 @ fix 311>315 /clone'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::PatchBinding {
            source,
            target,
            priority,
            clone,
        } => {
            assert_eq!(*priority, 0, "Expected default priority 0");
            assert!(*clone, "Expected clone to be true");
            assert_eq!(
                *source,
                BindingEndpoint::Fixture {
                    ids: vec![211],
                    element: None,
                    param: None,
                }
            );
            assert_eq!(
                *target,
                BindingEndpoint::Fixture {
                    ids: vec![311, 312, 313, 314, 315],
                    element: None,
                    param: None,
                }
            );
        }
        other => panic!("Expected PatchBinding command, got {:?}", other),
    }
}

#[test]
fn test_rm_patch_binding_disabled_conversion() {
    let ast = generate_ast("rm patch @ disabled").expect("Failed to parse 'rm patch @ disabled'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::RemovePatchBinding {
            source,
            target,
            priority,
            clone,
        } => {
            assert!(source.is_none(), "Expected no source filter");
            assert!(priority.is_none(), "Expected no priority filter");
            assert!(clone.is_none(), "Expected no clone filter");
            assert_eq!(target, &Some(BindingEndpoint::Disabled));
        }
        other => panic!("Expected RemovePatchBinding command, got {:?}", other),
    }
}

#[test]
fn test_rm_patch_binding_exact_conversion() {
    let ast = generate_ast("rm patch fix 421 @ artnet:1.17")
        .expect("Failed to parse 'rm patch fix 421 @ artnet:1.17'");
    let commands = FixtureAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<FixtureCommand>();
    assert!(cmd.is_some(), "Command is not a FixtureCommand");

    match cmd.unwrap() {
        FixtureCommand::RemovePatchBinding {
            source,
            target,
            priority,
            clone,
        } => {
            assert_eq!(
                source,
                &Some(BindingEndpoint::Fixture {
                    ids: vec![421],
                    element: None,
                    param: None,
                })
            );
            assert_eq!(
                target,
                &Some(BindingEndpoint::Transport {
                    target: "artnet".to_string(),
                    universe: Some(DmxRange { start: 1, end: 1 }),
                    address: Some(17),
                })
            );
            assert!(priority.is_none(), "Expected no priority filter");
            assert!(clone.is_none(), "Expected no clone filter");
        }
        other => panic!("Expected RemovePatchBinding command, got {:?}", other),
    }
}

#[test]
fn test_patch_binding_fixture_element_selector_mismatch_errors() {
    let ast = generate_ast("patch console @ fix 311.2 .1 param intensity")
        .expect("Failed to parse element mismatch patch");
    let result = FixtureAstConverter::convert(&ast);
    assert!(
        result.is_err(),
        "Expected conversion error for element mismatch"
    );
    match result {
        Err(nightfall_engine::prelude::DispatchError::ConversionFailed(msg)) => {
            assert!(
                msg.contains("fixture element selector mismatch"),
                "Expected element selector mismatch error, got '{msg}'"
            );
        }
        other => panic!("Expected ConversionFailed error, got {:?}", other),
    }
}

#[test]
fn test_patch_binding_fixture_element_ranges_in_ids_errors() {
    let ast = generate_ast("patch console @ fix 311>315 . 1>2")
        .expect("Failed to parse element range patch");
    let result = FixtureAstConverter::convert(&ast);
    assert!(
        result.is_err(),
        "Expected conversion error for fixture element ranges"
    );
    match result {
        Err(nightfall_engine::prelude::DispatchError::ConversionFailed(msg)) => {
            assert!(
                msg.contains("fixture element ranges are not supported in bindings"),
                "Expected fixture element range unsupported error, got '{msg}'"
            );
        }
        other => panic!("Expected ConversionFailed error, got {:?}", other),
    }
}

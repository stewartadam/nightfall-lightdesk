// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::ast::*;
use nightfall_cmd_parse::generate_ast;

#[test]
fn test_clip_on_command() {
    let input = "clip 1 on";
    let command_ast = generate_ast(input).expect("Failed to parse clip on command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            // Verify action is On
            assert_eq!(clip_cmd.action, PlaybackActionAst::On);

            // Verify clip ID
            match &clip_cmd.clip_id.head {
                SimpleTermAst::Single(id) => {
                    assert_eq!(id.id, 1, "Expected clip ID 1");
                }
                other => panic!("Expected Single term, got {:?}", other),
            }
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

#[test]
fn test_clip_off_command() {
    let input = "clip 2 off";
    let command_ast = generate_ast(input).expect("Failed to parse clip off command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            // Verify action is Off
            assert_eq!(clip_cmd.action, PlaybackActionAst::Off);

            // Verify clip ID
            match &clip_cmd.clip_id.head {
                SimpleTermAst::Single(id) => {
                    assert_eq!(id.id, 2, "Expected clip ID 2");
                }
                other => panic!("Expected Single term, got {:?}", other),
            }
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

#[test]
fn test_clip_go_command() {
    let input = "clip 3 go";
    let command_ast = generate_ast(input).expect("Failed to parse clip go command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            // Verify action is Go
            assert_eq!(clip_cmd.action, PlaybackActionAst::Go);

            // Verify clip ID
            match &clip_cmd.clip_id.head {
                SimpleTermAst::Single(id) => {
                    assert_eq!(id.id, 3, "Expected clip ID 3");
                }
                other => panic!("Expected Single term, got {:?}", other),
            }
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

/// Verifies clip back commands parse as playback back actions.
#[test]
fn test_clip_back_command() {
    let input = "clip 3 back";
    let command_ast = generate_ast(input).expect("Failed to parse clip back command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            assert_eq!(clip_cmd.action, PlaybackActionAst::Back);

            match &clip_cmd.clip_id.head {
                SimpleTermAst::Single(id) => {
                    assert_eq!(id.id, 3, "Expected clip ID 3");
                }
                other => panic!("Expected Single term, got {:?}", other),
            }
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

#[test]
fn test_clip_goto_command() {
    let input = "clip 1 goto 5";
    let command_ast = generate_ast(input).expect("Failed to parse clip goto command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            // Verify action is Goto with position 5
            assert_eq!(
                clip_cmd.action,
                PlaybackActionAst::Goto(5),
                "Expected Goto action with position 5"
            );

            // Verify clip ID
            match &clip_cmd.clip_id.head {
                SimpleTermAst::Single(id) => {
                    assert_eq!(id.id, 1, "Expected clip ID 1");
                }
                other => panic!("Expected Single term, got {:?}", other),
            }
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

#[test]
fn test_clip_goto_large_position() {
    let input = "clip 2 goto 100";
    let command_ast = generate_ast(input).expect("Failed to parse clip goto command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            assert_eq!(
                clip_cmd.action,
                PlaybackActionAst::Goto(100),
                "Expected Goto action with position 100"
            );
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

#[test]
fn test_clip_goto_position_one() {
    let input = "clip 1 goto 1";
    let command_ast = generate_ast(input).expect("Failed to parse clip goto command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            assert_eq!(
                clip_cmd.action,
                PlaybackActionAst::Goto(1),
                "Expected Goto action with position 1"
            );
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

/// Verifies clip rate commands parse as playback rate actions.
#[test]
fn test_clip_rate_command() {
    let input = "exec 1 rate 2.5";
    let command_ast = generate_ast(input).expect("Failed to parse clip rate command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            assert_eq!(
                clip_cmd.action,
                PlaybackActionAst::Rate(2.5),
                "Expected Rate action with multiplier 2.5"
            );
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

#[test]
fn test_clip_start_keyword() {
    let input = "clip 1 start";
    let command_ast = generate_ast(input).expect("Failed to parse clip start command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            // Verify 'start' is treated as 'on'
            assert_eq!(clip_cmd.action, PlaybackActionAst::On);
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

#[test]
fn test_clip_stop_keyword() {
    let input = "clip 1 stop";
    let command_ast = generate_ast(input).expect("Failed to parse clip stop command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            // Verify 'stop' is treated as 'off'
            assert_eq!(clip_cmd.action, PlaybackActionAst::Off);
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

#[test]
fn test_clip_shorthand_exec() {
    let input = "exec 1 goto 3";
    let command_ast = generate_ast(input).expect("Failed to parse clip goto command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            assert_eq!(clip_cmd.action, PlaybackActionAst::Goto(3));
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

#[test]
fn test_clip_shorthand_e() {
    let input = "e 2 goto 7";
    let command_ast = generate_ast(input).expect("Failed to parse clip goto command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            assert_eq!(clip_cmd.action, PlaybackActionAst::Goto(7));
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

#[test]
fn test_clip_range_aliases() {
    let input = "clip 1>5 on";
    let command_ast = generate_ast(input).expect("Failed to parse clip range alias command");

    match command_ast {
        CommandAst::Clip(clip_cmd) => {
            assert_eq!(clip_cmd.action, PlaybackActionAst::On);
            match &clip_cmd.clip_id.head {
                SimpleTermAst::Range(range) => {
                    assert_eq!(range.start.id, 1);
                    assert_eq!(range.end.id, 5);
                }
                other => panic!("Expected Range term, got {:?}", other),
            }
        }
        other => panic!("Expected Clip command, got {:?}", other),
    }
}

/// Verifies compact target assignment syntax parses to a generic set property AST.
#[test]
fn test_set_clip_target_compact_command() {
    let input = "set exec 1 target=fx 2";
    let command_ast = generate_ast(input).expect("Failed to parse clip target set command");

    match command_ast {
        CommandAst::General(GeneralCommandAst::SetObjectProperty(set_cmd)) => {
            assert_eq!(set_cmd.object_type, ObjectTypeAst::Clip);
            assert_eq!(set_cmd.property, SetObjectPropertyAst::Target);
            assert_eq!(set_cmd.target.object_type, SetObjectTargetTypeAst::Fx);
            match (&set_cmd.id.head, &set_cmd.target.id.head) {
                (SimpleTermAst::Single(clip_id), SimpleTermAst::Single(target_id)) => {
                    assert_eq!(clip_id.id, 1);
                    assert_eq!(target_id.id, 2);
                }
                other => panic!("Expected single clip and target IDs, got {:?}", other),
            }
        }
        other => panic!("Expected set object property command, got {:?}", other),
    }
}

/// Verifies separated target assignment syntax accepts non-regular FX target kinds.
#[test]
fn test_set_clip_target_separated_stepfx_command() {
    let input = "set exec 1 target = stepfx 2";
    let command_ast = generate_ast(input).expect("Failed to parse clip target set command");

    match command_ast {
        CommandAst::General(GeneralCommandAst::SetObjectProperty(set_cmd)) => {
            assert_eq!(set_cmd.object_type, ObjectTypeAst::Clip);
            assert_eq!(set_cmd.property, SetObjectPropertyAst::Target);
            assert_eq!(set_cmd.target.object_type, SetObjectTargetTypeAst::StepFx);
        }
        other => panic!("Expected set object property command, got {:?}", other),
    }
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::generate_ast;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_programmer::ast_conv::ProgrammerAstConverter;
use nightfall_programmer::prelude::*;

// ============================================================================
// AST Alias Equality Tests
// ============================================================================

#[test]
fn test_fade_delay_order_aliases() {
    // Fade then delay
    let fade_delay_ast = generate_ast("fix 1 @ 50 fade 3 delay 2")
        .expect("Failed to parse 'fix 1 @ 50 fade 3 delay 2'");

    // Delay then fade - should produce identical AST (order shouldn't matter)
    let delay_fade_ast = generate_ast("fix 1 @ 50 delay 2 fade 3")
        .expect("Failed to parse 'fix 1 @ 50 delay 2 fade 3'");

    assert_eq!(
        fade_delay_ast, delay_fade_ast,
        "Fade and delay order shouldn't affect AST"
    );
}

#[test]
fn test_timing_keyword_without_argument_is_invalid_syntax() {
    assert!(generate_ast("fix 1 @ 50 fade").is_err());
    assert!(generate_ast("fix 1 @ 50 delay").is_err());
}

#[test]
fn test_timing_keyword_with_bare_sign_is_invalid_syntax() {
    assert!(generate_ast("fix 1 @ 50 fade +").is_err());
    assert!(generate_ast("fix 1 @ 50 delay -").is_err());
}

#[test]
fn test_trailing_dot_duration_literals_are_invalid_syntax() {
    assert!(generate_ast("fix 1 @ 50 fade 1.").is_err());
    assert!(generate_ast("fix 1 @ 50 delay 1.").is_err());
    assert!(generate_ast("fix 1 @ 50 fade int 1.").is_err());
}

// ============================================================================
// AST -> Command Conversion Tests
// ============================================================================

#[test]
fn test_fade_timing_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast = generate_ast("fix 1 @ 50 fade 3").expect("Failed to parse 'fix 1 @ 50 fade 3'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // Verify intensity attribute is set
            assert!(
                instruction.values.contains_key(&Attribute::Intensity),
                "Expected intensity attribute"
            );
            // Validate fade timing values
            let fade_in = instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing");
            match fade_in {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(*dur, Duration::from_secs_f32(3.0), "Expected 3 second fade");
                }
                _ => panic!("Expected Fixed transition mode, got {:?}", fade_in),
            }

            let fade_out = instruction
                .transitions
                .fade_out
                .as_ref()
                .expect("Expected fade_out timing");
            match fade_out {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(*dur, Duration::from_secs_f32(3.0), "Expected 3 second fade");
                }
                _ => panic!("Expected Fixed transition mode, got {:?}", fade_out),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

/// Verifies explicit fade-in timing writes only assertion timing.
#[test]
fn test_fade_in_timing_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast = generate_ast("fix 1 @ 50 fade in 3").expect("Failed to parse 'fix 1 @ 50 fade in 3'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            let fade_in = instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing");
            match fade_in {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(*dur, Duration::from_secs_f32(3.0), "Expected 3 second fade");
                }
                _ => panic!("Expected Fixed transition mode, got {:?}", fade_in),
            }
            assert!(
                instruction.transitions.fade_out.is_none(),
                "Fade in should not set release timing"
            );
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

/// Verifies explicit fade-out timing writes only release timing.
#[test]
fn test_fade_out_timing_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast =
        generate_ast("fix 1 @ 50 fade out 3").expect("Failed to parse 'fix 1 @ 50 fade out 3'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            assert!(
                instruction.transitions.fade_in.is_none(),
                "Fade out should not set assertion timing"
            );
            let fade_out = instruction
                .transitions
                .fade_out
                .as_ref()
                .expect("Expected fade_out timing");
            match fade_out {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(*dur, Duration::from_secs_f32(3.0), "Expected 3 second fade");
                }
                _ => panic!("Expected Fixed transition mode, got {:?}", fade_out),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_delay_timing_conversion() {
    let ast = generate_ast("fix 1 @ 50 delay 2").expect("Failed to parse 'fix 1 @ 50 delay 2'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // Verify intensity attribute is set
            assert!(
                instruction.values.contains_key(&Attribute::Intensity),
                "Expected intensity attribute"
            );
            // Validate delay timing
            assert!(
                instruction.transitions.delay_in.is_some(),
                "Expected delay_in timing"
            );
            assert!(
                instruction.transitions.delay_out.is_some(),
                "Expected delay_out timing"
            );
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

/// Verifies paired fade directions populate assertion and release timing together.
#[test]
fn test_fade_in_and_out_timing_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast = generate_ast("fix 1 @ 50 fade in 1 fade out 5")
        .expect("Failed to parse 'fix 1 @ 50 fade in 1 fade out 5'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            match instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing")
            {
                TransitionMode::Fixed(dur) => assert_eq!(*dur, Duration::from_secs(1)),
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
            match instruction
                .transitions
                .fade_out
                .as_ref()
                .expect("Expected fade_out timing")
            {
                TransitionMode::Fixed(dur) => assert_eq!(*dur, Duration::from_secs(5)),
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

/// Verifies one fade keyword can set explicit fade-in and fade-out durations.
#[test]
fn test_single_fade_keyword_with_paired_direction_durations() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast = generate_ast("fix 1 @ 50 fade in 2s out 100ms")
        .expect("Failed to parse 'fix 1 @ 50 fade in 2s out 100ms'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            match instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing")
            {
                TransitionMode::Fixed(dur) => assert_eq!(*dur, Duration::from_secs(2)),
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
            match instruction
                .transitions
                .fade_out
                .as_ref()
                .expect("Expected fade_out timing")
            {
                TransitionMode::Fixed(dur) => assert_eq!(*dur, Duration::from_secs_f32(0.1)),
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

/// Verifies explicit fade attributes attach to the active direction segment.
#[test]
fn test_single_fade_keyword_with_directed_attribute_override() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast = generate_ast("fix 1 red @ 50 fade in 1 red 1>5 out 2s")
        .expect("Failed to parse 'fix 1 red @ 50 fade in 1 red 1>5 out 2s'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            match instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected global fade_in")
            {
                TransitionMode::Fixed(dur) => assert_eq!(*dur, Duration::from_secs(1)),
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
            match instruction
                .transitions
                .fade_out
                .as_ref()
                .expect("Expected global fade_out")
            {
                TransitionMode::Fixed(dur) => assert_eq!(*dur, Duration::from_secs(2)),
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }

            let red_transition = instruction
                .transitions_by_attribute
                .get(&Attribute::Red)
                .expect("Expected red fade override");
            match red_transition
                .fade_in
                .as_ref()
                .expect("Expected red fade_in")
            {
                TransitionMode::Interpolated { start, end } => {
                    assert_eq!(*start, Duration::from_secs(1));
                    assert_eq!(*end, Duration::from_secs(5));
                }
                other => panic!("Expected Interpolated transition mode, got {:?}", other),
            }
            assert!(
                red_transition.fade_out.is_none(),
                "Directed fade-in override should not set red fade_out"
            );
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

/// Verifies explicit delay-out timing writes only release timing.
#[test]
fn test_delay_out_timing_conversion() {
    let ast =
        generate_ast("fix 1 @ 50 delay out 2").expect("Failed to parse 'fix 1 @ 50 delay out 2'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            assert!(
                instruction.transitions.delay_in.is_none(),
                "Delay out should not set assertion timing"
            );
            assert!(
                instruction.transitions.delay_out.is_some(),
                "Expected delay_out timing"
            );
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

/// Verifies paired delay directions populate assertion and release timing together.
#[test]
fn test_delay_in_and_out_timing_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast = generate_ast("fix 1 @ 50 delay in 1 delay out 5")
        .expect("Failed to parse 'fix 1 @ 50 delay in 1 delay out 5'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            match instruction
                .transitions
                .delay_in
                .as_ref()
                .expect("Expected delay_in timing")
            {
                TransitionMode::Fixed(dur) => assert_eq!(*dur, Duration::from_secs(1)),
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
            match instruction
                .transitions
                .delay_out
                .as_ref()
                .expect("Expected delay_out timing")
            {
                TransitionMode::Fixed(dur) => assert_eq!(*dur, Duration::from_secs(5)),
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_fade_and_delay_conversion() {
    let ast = generate_ast("fix 1 @ 50 fade 3 delay 2")
        .expect("Failed to parse 'fix 1 @ 50 fade 3 delay 2'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // Verify intensity attribute is set
            assert!(
                instruction.values.contains_key(&Attribute::Intensity),
                "Expected intensity attribute"
            );
            // Validate both fade and delay timings
            assert!(
                instruction.transitions.fade_in.is_some(),
                "Expected fade_in timing"
            );
            assert!(
                instruction.transitions.fade_out.is_some(),
                "Expected fade_out timing"
            );
            assert!(
                instruction.transitions.delay_in.is_some(),
                "Expected delay_in timing"
            );
            assert!(
                instruction.transitions.delay_out.is_some(),
                "Expected delay_out timing"
            );
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_fade_with_attribute_override_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // No global fade, only per-attribute override for intensity
    let ast =
        generate_ast("fix 1 @ 50 fade int 5").expect("Failed to parse 'fix 1 @ 50 fade int 5'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // Verify intensity attribute is set
            assert!(
                instruction.values.contains_key(&Attribute::Intensity),
                "Expected intensity attribute"
            );

            // No global fade should be set (only per-attribute override)
            assert!(
                instruction.transitions.fade_in.is_none(),
                "Global fade_in should not be set when only attribute override is provided"
            );
            assert!(
                instruction.transitions.fade_out.is_none(),
                "Global fade_out should not be set when only attribute override is provided"
            );

            // Intensity should have a per-attribute fade override
            let int_transition = instruction
                .transitions_by_attribute
                .get(&Attribute::Intensity)
                .expect("Expected per-attribute transition for Intensity");

            match int_transition.fade_in.as_ref().expect("Expected fade_in") {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs_f32(5.0),
                        "Expected 5 second fade for intensity"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
            match int_transition.fade_out.as_ref().expect("Expected fade_out") {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs_f32(5.0),
                        "Expected 5 second fade for intensity"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_fade_with_default_and_attribute_override() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // Global fade of 3s, with red override of 1s
    // Green is NOT in the per-attribute hashmap (uses default)
    let ast = generate_ast("fix 1 r @ 100 g @ 100 fade 3 r 1")
        .expect("Failed to parse 'fix 1 r @ 100 g @ 100 fade 3 r 1'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // Verify both attributes are set
            assert!(
                instruction.values.contains_key(&Attribute::Red),
                "Expected red attribute"
            );
            assert!(
                instruction.values.contains_key(&Attribute::Green),
                "Expected green attribute"
            );

            // Global fade should be 3s
            let fade_in = instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected global fade_in");
            match fade_in {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs_f32(3.0),
                        "Expected 3 second default fade"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
            let fade_out = instruction
                .transitions
                .fade_out
                .as_ref()
                .expect("Expected global fade_out");
            match fade_out {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs_f32(3.0),
                        "Expected 3 second default fade"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }

            // Only Red should have a per-attribute override
            assert!(
                instruction
                    .transitions_by_attribute
                    .contains_key(&Attribute::Red),
                "Red should have per-attribute override"
            );
            assert!(
                !instruction
                    .transitions_by_attribute
                    .contains_key(&Attribute::Green),
                "Green should NOT have per-attribute override (uses default)"
            );

            // Verify red's override is 1s
            let red_transition = instruction
                .transitions_by_attribute
                .get(&Attribute::Red)
                .expect("Expected per-attribute transition for Red");

            match red_transition.fade_in.as_ref().expect("Expected fade_in") {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs_f32(1.0),
                        "Expected 1 second fade for red"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
            match red_transition.fade_out.as_ref().expect("Expected fade_out") {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs_f32(1.0),
                        "Expected 1 second fade for red"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_multi_attribute_fade_override_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast = generate_ast("fix 1 @ 50 r @ 100 fade int 3 r 5")
        .expect("Failed to parse 'fix 1 @ 50 r @ 100 fade int 3 r 5'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // Verify both attributes are set
            assert!(
                instruction.values.contains_key(&Attribute::Intensity),
                "Expected intensity attribute"
            );
            assert!(
                instruction.values.contains_key(&Attribute::Red),
                "Expected red attribute"
            );

            // No global fade (only per-attribute overrides)
            assert!(
                instruction.transitions.fade_in.is_none(),
                "Global fade_in should not be set when only attribute overrides are provided"
            );

            // Both intensity and red should have per-attribute overrides
            let int_transition = instruction
                .transitions_by_attribute
                .get(&Attribute::Intensity)
                .expect("Expected per-attribute transition for Intensity");
            match int_transition.fade_in.as_ref().expect("Expected fade_in") {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs_f32(3.0),
                        "Expected 3 second fade for intensity"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }

            let red_transition = instruction
                .transitions_by_attribute
                .get(&Attribute::Red)
                .expect("Expected per-attribute transition for Red");
            match red_transition.fade_in.as_ref().expect("Expected fade_in") {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs_f32(5.0),
                        "Expected 5 second fade for red"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_delay_with_attribute_override_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast =
        generate_ast("fix 1 @ 50 delay int 2").expect("Failed to parse 'fix 1 @ 50 delay int 2'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // Verify intensity attribute is set
            assert!(
                instruction.values.contains_key(&Attribute::Intensity),
                "Expected intensity attribute"
            );

            // No global delay (only per-attribute override)
            assert!(
                instruction.transitions.delay_in.is_none(),
                "Global delay_in should not be set when only attribute override is provided"
            );

            // Intensity should have a per-attribute delay override
            let int_transition = instruction
                .transitions_by_attribute
                .get(&Attribute::Intensity)
                .expect("Expected per-attribute transition for Intensity");

            match int_transition.delay_in.as_ref().expect("Expected delay_in") {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs_f32(2.0),
                        "Expected 2 second delay for intensity"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_without_fade_conversion() {
    // Command without fade timing
    let ast = generate_ast("fix 1 @ 50").expect("Failed to parse 'fix 1 @ 50'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // Verify intensity attribute is set
            assert!(
                instruction.values.contains_key(&Attribute::Intensity),
                "Expected intensity attribute"
            );
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_without_delay_conversion() {
    // Command without delay timing
    let ast = generate_ast("fix 1 @ 50").expect("Failed to parse 'fix 1 @ 50'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // Verify intensity attribute is set
            assert!(
                instruction.values.contains_key(&Attribute::Intensity),
                "Expected intensity attribute"
            );
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_fanned_fade_two_values() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // Test fanned fade with two values (linear interpolation)
    let ast = generate_ast("fix 1 @ 50 fade 0>5").expect("Failed to parse 'fix 1 @ 50 fade 0>5'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            let fade_in = instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing");
            match fade_in {
                TransitionMode::Interpolated { start, end } => {
                    assert_eq!(*start, Duration::from_secs(0), "Expected 0 second start");
                    assert_eq!(*end, Duration::from_secs(5), "Expected 5 second end");
                }
                _ => panic!("Expected Interpolated transition mode, got {:?}", fade_in),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_fanned_fade_three_values() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // Test fanned fade with three values (manual/envelope)
    let ast =
        generate_ast("fix 1 @ 50 fade 0>3>1").expect("Failed to parse 'fix 1 @ 50 fade 0>3>1'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            let fade_in = instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing");
            match fade_in {
                TransitionMode::Manual(durations) => {
                    assert_eq!(durations.len(), 3, "Expected 3 manual duration values");
                    assert_eq!(durations[0], Duration::from_secs(0));
                    assert_eq!(durations[1], Duration::from_secs(3));
                    assert_eq!(durations[2], Duration::from_secs(1));
                }
                _ => panic!("Expected Manual transition mode, got {:?}", fade_in),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

/// Verifies a `0>5>0` programmer fade parses as a manual envelope.
#[test]
fn test_fanned_fade_center_waypoint() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast =
        generate_ast("fix 1 @ 50 fade 0>5>0").expect("Failed to parse 'fix 1 @ 50 fade 0>5>0'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            let fade_in = instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing");
            match fade_in {
                TransitionMode::Manual(durations) => {
                    assert_eq!(
                        durations,
                        &vec![
                            Duration::from_secs(0),
                            Duration::from_secs(5),
                            Duration::from_secs(0),
                        ]
                    );
                    assert_eq!(fade_in.resolve(1, 3), Duration::from_secs(5));
                    assert_eq!(fade_in.resolve(0, 3), Duration::from_secs(0));
                    assert_eq!(fade_in.resolve(2, 3), Duration::from_secs(0));
                }
                _ => panic!("Expected Manual transition mode, got {:?}", fade_in),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_fanned_delay_two_values() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // Test fanned delay with two values
    let ast = generate_ast("fix 1 @ 50 delay 0>2").expect("Failed to parse 'fix 1 @ 50 delay 0>2'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            let delay_in = instruction
                .transitions
                .delay_in
                .as_ref()
                .expect("Expected delay_in timing");
            match delay_in {
                TransitionMode::Interpolated { start, end } => {
                    assert_eq!(*start, Duration::from_secs(0), "Expected 0 second start");
                    assert_eq!(*end, Duration::from_secs(2), "Expected 2 second end");
                }
                _ => panic!("Expected Interpolated transition mode, got {:?}", delay_in),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_fanned_attribute_override_timing() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // Test fanned fade with attribute override
    let ast = generate_ast("fix 1 @ 50 fade 1 pan 0>3")
        .expect("Failed to parse 'fix 1 @ 50 fade 1 pan 0>3'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // Global fade should be Fixed
            let fade_in = instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing");
            match fade_in {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs(1),
                        "Expected 1 second global fade"
                    );
                }
                _ => panic!("Expected Fixed transition mode for global fade"),
            }

            // Pan-specific fade should be Interpolated
            let pan_transition = instruction
                .transitions_by_attribute
                .get(&Attribute::Pan)
                .expect("Expected Pan attribute override");
            let pan_fade = pan_transition
                .fade_in
                .as_ref()
                .expect("Expected pan fade_in");
            match pan_fade {
                TransitionMode::Interpolated { start, end } => {
                    assert_eq!(*start, Duration::from_secs(0));
                    assert_eq!(*end, Duration::from_secs(3));
                }
                _ => panic!("Expected Interpolated transition mode for pan"),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

// ============================================================================
// Duration Unit Tests
// ============================================================================

#[test]
fn test_fade_bpm_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // 60bpm = 1 beat per second = 1 second fade
    let ast =
        generate_ast("fix 1 @ 100 fade 60bpm").expect("Failed to parse 'fix 1 @ 100 fade 60bpm'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            let fade_in = instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing");
            match fade_in {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs(1),
                        "Expected 1 second fade (60bpm)"
                    );
                }
                _ => panic!("Expected Fixed transition mode, got {:?}", fade_in),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_fade_milliseconds_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // 1500ms = 1.5 second fade
    let ast =
        generate_ast("fix 1 @ 100 fade 1500ms").expect("Failed to parse 'fix 1 @ 100 fade 1500ms'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            let fade_in = instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing");
            match fade_in {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_millis(1500),
                        "Expected 1.5 second fade (1500ms)"
                    );
                }
                _ => panic!("Expected Fixed transition mode, got {:?}", fade_in),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_fade_hz_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // 2hz = 0.5 second fade
    let ast = generate_ast("fix 1 @ 100 fade 2hz").expect("Failed to parse 'fix 1 @ 100 fade 2hz'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            let fade_in = instruction
                .transitions
                .fade_in
                .as_ref()
                .expect("Expected fade_in timing");
            match fade_in {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_millis(500),
                        "Expected 0.5 second fade (2hz)"
                    );
                }
                _ => panic!("Expected Fixed transition mode, got {:?}", fade_in),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_delay_milliseconds_conversion() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    let ast =
        generate_ast("fix 1 @ 100 delay 500ms").expect("Failed to parse 'fix 1 @ 100 delay 500ms'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            let delay_in = instruction
                .transitions
                .delay_in
                .as_ref()
                .expect("Expected delay_in timing");
            match delay_in {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_millis(500),
                        "Expected 0.5 second delay (500ms)"
                    );
                }
                _ => panic!("Expected Fixed transition mode, got {:?}", delay_in),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_attribute_override_with_duration_unit() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // Test attribute override with milliseconds: fade int 1500ms = 1.5 second fade for intensity
    let ast = generate_ast("fix 1 @ 100 r @ 50 fade int 1500ms")
        .expect("Failed to parse 'fix 1 @ 100 r @ 50 fade int 1500ms'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            // No global fade (only per-attribute override)
            assert!(
                instruction.transitions.fade_in.is_none(),
                "Global fade_in should not be set when only attribute override is provided"
            );

            // Intensity should have per-attribute override with 1.5s fade
            let int_transition = instruction
                .transitions_by_attribute
                .get(&Attribute::Intensity)
                .expect("Expected per-attribute transition for Intensity");
            match int_transition.fade_in.as_ref().expect("Expected fade_in") {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_millis(1500),
                        "Expected 1.5 second fade (1500ms) for intensity"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

#[test]
fn test_attribute_override_with_bpm_unit() {
    use std::time::Duration;

    use nightfall::prelude::TransitionMode;

    // Test attribute override with bpm: fade int 60bpm = 1 second fade for intensity
    let ast = generate_ast("fix 1 @ 100 r @ 50 fade int 60bpm")
        .expect("Failed to parse 'fix 1 @ 100 r @ 50 fade int 60bpm'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    match cmd.unwrap() {
        ProgrammerCommand::AddProgrammerInstruction { instruction, .. } => {
            let int_transition = instruction
                .transitions_by_attribute
                .get(&Attribute::Intensity)
                .expect("Expected per-attribute transition for Intensity");
            match int_transition.fade_in.as_ref().expect("Expected fade_in") {
                TransitionMode::Fixed(dur) => {
                    assert_eq!(
                        *dur,
                        Duration::from_secs(1),
                        "Expected 1 second fade (60bpm) for intensity"
                    );
                }
                other => panic!("Expected Fixed transition mode, got {:?}", other),
            }
        }
        other => panic!("Expected AddProgrammerInstruction, got {:?}", other),
    }
}

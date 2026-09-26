// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall::prelude::*;
use nightfall_cmd_parse::generate_ast;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_programmer::ast_conv::ProgrammerAstConverter;
use nightfall_programmer::prelude::*;

/// Verifies Blueprint sources retain address kind, category, resolution, and selection binding.
#[test]
fn converts_blueprint_attribute_operations() {
    let cases = [
        (
            "color @ blueprint \"foo\"",
            false,
            BlueprintResolution::Reference,
            BlueprintAddress::Label("foo".to_owned()),
        ),
        (
            "fix 311 color @ bp 5 /absolute",
            true,
            BlueprintResolution::Absolute,
            BlueprintAddress::Id(5),
        ),
    ];
    for (input, has_selection, expected_resolution, expected_address) in cases {
        let ast = generate_ast(input).expect("Blueprint command should parse");
        let commands = ProgrammerAstConverter::convert(&ast).expect("command should convert");
        let command = commands[0]
            .as_any()
            .downcast_ref::<ProgrammerCommand>()
            .expect("command should target the programmer");
        let ProgrammerCommand::ApplyAttributeOperations {
            selection,
            operations,
            ..
        } = command
        else {
            panic!("expected shared attribute operation command");
        };
        assert_eq!(selection.is_some(), has_selection);
        assert_eq!(operations.len(), 1);
        assert_eq!(
            operations[0].target,
            BlueprintSelector::Category(AttributeCategory::Color)
        );
        let ProgrammerAttributeSource::Blueprint {
            address,
            resolution,
        } = &operations[0].source
        else {
            panic!("expected Blueprint value source");
        };
        assert_eq!(address, &expected_address);
        assert_eq!(*resolution, expected_resolution);
    }
}

/// Verifies `/absolute` changes only the Blueprint source that immediately precedes it.
#[test]
fn scopes_absolute_resolution_to_one_blueprint_operation() {
    let ast = generate_ast("fix 311 red @ bp 5 /absolute blue @ bp 6")
        .expect("mixed Blueprint sources should parse");
    let commands = ProgrammerAstConverter::convert(&ast).expect("command should convert");
    let command = commands[0]
        .as_any()
        .downcast_ref::<ProgrammerCommand>()
        .expect("command should target the programmer");
    let ProgrammerCommand::ApplyAttributeOperations { operations, .. } = command else {
        panic!("expected shared attribute operation command");
    };
    assert_eq!(operations.len(), 2);
    assert!(matches!(
        operations[0].source,
        ProgrammerAttributeSource::Blueprint {
            address: BlueprintAddress::Id(5),
            resolution: BlueprintResolution::Absolute,
        }
    ));
    assert!(matches!(
        operations[1].source,
        ProgrammerAttributeSource::Blueprint {
            address: BlueprintAddress::Id(6),
            resolution: BlueprintResolution::Reference,
        }
    ));
}

/// Verifies a complete Blueprint application retains an all-attributes selector.
#[test]
fn converts_complete_blueprint_application() {
    let ast = generate_ast("fix 311 @ blueprint 5").expect("complete application should parse");
    let commands = ProgrammerAstConverter::convert(&ast).expect("command should convert");
    let command = commands[0]
        .as_any()
        .downcast_ref::<ProgrammerCommand>()
        .expect("programmer command");
    let ProgrammerCommand::ApplyAttributeOperations { operations, .. } = command else {
        panic!("expected shared operation command");
    };
    assert_eq!(operations[0].target, BlueprintSelector::All);
}

#[test]
fn test_set_intensity() {
    let base_ast = generate_ast("fix 1 @ 50").expect("Failed to parse 'fix 1 @ 50'");
    let commands = ProgrammerAstConverter::convert(&base_ast).expect("Failed to convert AST");
    assert_eq!(commands.len(), 1);

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    if let ProgrammerCommand::AddProgrammerInstruction {
        selection,
        instruction,
    } = cmd.unwrap()
    {
        // Verify selection is fixture 1
        if let SelectionExpr::Fixture(fix_ref) = &selection.source {
            assert_eq!(fix_ref.fixture_id, 1);
        } else {
            panic!("Expected Fixture selection");
        }
        assert!(selection.clauses.is_empty());

        // Verify intensity value is 50%
        assert!(instruction.values.contains_key(&Attribute::Intensity));
        if let Some(ValueSource::Inline(param_val)) = instruction.values.get(&Attribute::Intensity)
        {
            if let ParameterValue::AbsolutePercent { value } = param_val {
                // Check that value is approximately 50% (0.5)
                assert!(
                    (format!("{}", value).contains("50") || format!("{}", value).contains("0.5")),
                    "Expected 50%, got {}",
                    value
                );
            } else {
                panic!("Expected AbsolutePercent");
            }
        }
    } else {
        panic!("Expected AddProgrammerInstruction");
    }
}

/// Verifies `Release` and `R` attribute targets convert to cue release markers.
#[test]
fn test_release_attribute_marker_values() {
    for input in ["fix 311 red @ Release", "fix 311 red @ R"] {
        let ast = generate_ast(input).expect("marker command should parse");
        let commands = ProgrammerAstConverter::convert(&ast).expect("marker command converts");
        let command = commands[0]
            .as_any()
            .downcast_ref::<ProgrammerCommand>()
            .expect("command should be a programmer command");

        let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = command else {
            panic!("Expected AddProgrammerInstruction");
        };
        assert_eq!(
            instruction.values.get(&Attribute::Red),
            Some(&ValueSource::Release)
        );
    }
}

/// Verifies `Hold` and `H` attribute targets convert to hold-position markers.
#[test]
fn test_hold_attribute_marker_values() {
    for input in ["fix 311 tilt @ Hold", "fix 311 tilt @ H"] {
        let ast = generate_ast(input).expect("marker command should parse");
        let commands = ProgrammerAstConverter::convert(&ast).expect("marker command converts");
        let command = commands[0]
            .as_any()
            .downcast_ref::<ProgrammerCommand>()
            .expect("command should be a programmer command");

        let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = command else {
            panic!("Expected AddProgrammerInstruction");
        };
        assert_eq!(
            instruction.values.get(&Attribute::Tilt),
            Some(&ValueSource::HoldPosition)
        );
    }
}

/// Verifies marker values work against the existing active programmer selection.
#[test]
fn test_active_selection_attribute_marker_values() {
    for input in [
        "tilt @ hold",
        "tilt @ Hold",
        "tilt @ H",
        "red @ release",
        "red @ Release",
        "red @ R",
    ] {
        let ast = generate_ast(input).expect("active marker command should parse");
        let commands =
            ProgrammerAstConverter::convert(&ast).expect("active marker command converts");
        let command = commands[0]
            .as_any()
            .downcast_ref::<ProgrammerCommand>()
            .expect("command should be a programmer command");

        let ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(instruction) = command
        else {
            panic!("Expected AddProgrammerInstructionWithActiveSelection");
        };
        let (attribute, expected) = if input.starts_with("tilt") {
            (Attribute::Tilt, ValueSource::HoldPosition)
        } else {
            (Attribute::Red, ValueSource::Release)
        };
        assert_eq!(instruction.values.get(&attribute), Some(&expected));
    }
}

/// Attribute command conversion preserves spatial clauses on explicit selections.
#[test]
fn test_spatial_selection_attribute_command_preserves_clauses() {
    let base_ast =
        generate_ast("group 1>4|wings 2 @ 50").expect("Failed to parse spatial attribute command");
    let commands = ProgrammerAstConverter::convert(&base_ast).expect("Failed to convert AST");
    assert_eq!(commands.len(), 1);

    let cmd = commands[0]
        .as_any()
        .downcast_ref::<ProgrammerCommand>()
        .expect("Command is not a ProgrammerCommand");

    if let ProgrammerCommand::AddProgrammerInstruction { selection, .. } = cmd {
        assert!(matches!(selection.source, SelectionExpr::Group(_)));
        assert_eq!(selection.clauses.len(), 1);
    } else {
        panic!("Expected AddProgrammerInstruction");
    }
}

#[test]
fn test_set_full_intensity() {
    let base_ast = generate_ast("fix 1 @@").expect("Failed to parse 'fix 1 @@'");
    let commands = ProgrammerAstConverter::convert(&base_ast).expect("Failed to convert AST");
    assert_eq!(commands.len(), 1);

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some());

    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        // Verify intensity value is 100%
        if let Some(ValueSource::Inline(param_val)) = instruction.values.get(&Attribute::Intensity)
            && let ParameterValue::AbsolutePercent { value } = param_val
        {
            // Check that value is 100%
            assert!(
                format!("{}", value).contains("100"),
                "Expected 100%, got {}",
                value
            );
        }
    }
}

#[test]
fn test_explicit_intensity_attribute() {
    // Base command with "int" alias
    let base_ast = generate_ast("fix 1 int @ 75").expect("Failed to parse 'fix 1 int @ 75'");

    // Test "i" alias - produces identical AST to "int"
    let i_ast = generate_ast("fix 1 i @ 75").expect("Failed to parse 'fix 1 i @ 75'");
    assert_eq!(base_ast, i_ast, "'i' should produce identical AST to 'int'");

    // Verify command works
    let commands = ProgrammerAstConverter::convert(&base_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap()
        && let Some(ValueSource::Inline(ParameterValue::AbsolutePercent { value })) =
            instruction.values.get(&Attribute::Intensity)
    {
        // Check that value is 75%
        assert!(
            format!("{}", value).contains("75"),
            "Expected 75%, got {}",
            value
        );
    }
}

#[test]
fn test_color_attributes() {
    // Test red aliases
    let red_base_ast = generate_ast("fix 1 red @ 100").expect("Failed to parse 'fix 1 red @ 100'");
    let r_ast = generate_ast("fix 1 r @ 100").expect("Failed to parse 'fix 1 r @ 100'");
    assert_eq!(
        red_base_ast, r_ast,
        "'r' should produce identical AST to 'red'"
    );

    // Test green aliases
    let green_base_ast =
        generate_ast("fix 1 green @ 50").expect("Failed to parse 'fix 1 green @ 50'");
    let g_ast = generate_ast("fix 1 g @ 50").expect("Failed to parse 'fix 1 g @ 50'");
    assert_eq!(
        green_base_ast, g_ast,
        "'g' should produce identical AST to 'green'"
    );

    // Test blue aliases
    let blue_base_ast = generate_ast("fix 1 blue @ 75").expect("Failed to parse 'fix 1 blue @ 75'");
    let b_ast = generate_ast("fix 1 b @ 75").expect("Failed to parse 'fix 1 b @ 75'");
    assert_eq!(
        blue_base_ast, b_ast,
        "'b' should produce identical AST to 'blue'"
    );

    // Test white aliases
    let white_base_ast =
        generate_ast("fix 1 white @ 100").expect("Failed to parse 'fix 1 white @ 100'");
    let w_ast = generate_ast("fix 1 w @ 100").expect("Failed to parse 'fix 1 w @ 100'");
    assert_eq!(
        white_base_ast, w_ast,
        "'w' should produce identical AST to 'white'"
    );

    // Verify different colors produce different ASTs
    assert_ne!(
        red_base_ast, green_base_ast,
        "Red and green should produce different ASTs"
    );
    assert_ne!(
        green_base_ast, blue_base_ast,
        "Green and blue should produce different ASTs"
    );
    assert_ne!(
        blue_base_ast, white_base_ast,
        "Blue and white should produce different ASTs"
    );

    // Verify red command works
    let commands = ProgrammerAstConverter::convert(&red_base_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        assert!(instruction.values.contains_key(&Attribute::Red));
        if let Some(ValueSource::Inline(ParameterValue::AbsolutePercent { value })) =
            instruction.values.get(&Attribute::Red)
        {
            // Check that value is 100%
            assert!(
                format!("{}", value).contains("100"),
                "Expected 100%, got {}",
                value
            );
        }
    }
}

#[test]
fn test_generic_attributes() {
    let pan_ast = generate_ast("fix 1 pan @ 50").expect("Failed to parse 'fix 1 pan @ 50'");
    let commands = ProgrammerAstConverter::convert(&pan_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        assert!(instruction.values.contains_key(&Attribute::Pan));
    }

    let tilt_ast = generate_ast("fix 1 tilt @ 50").expect("Failed to parse 'fix 1 tilt @ 50'");
    let commands = ProgrammerAstConverter::convert(&tilt_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        assert!(instruction.values.contains_key(&Attribute::Tilt));
    }

    let zoom_ast = generate_ast("fix 1 zoom @ 75").expect("Failed to parse 'fix 1 zoom @ 75'");
    let commands = ProgrammerAstConverter::convert(&zoom_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        assert!(instruction.values.contains_key(&Attribute::Zoom));
    }
}

#[test]
fn test_quoted_attributes() {
    let pan_ast =
        generate_ast(r#"fix 1 "Pan" @ 50"#).expect(r#"Failed to parse 'fix 1 "Pan" @ 50'"#);
    let _commands = ProgrammerAstConverter::convert(&pan_ast).expect("Failed to convert AST");

    let custom_ast = generate_ast(r#"fix 1 "My Custom Attr" @ 100"#)
        .expect(r#"Failed to parse 'fix 1 "My Custom Attr" @ 100'"#);
    let _commands = ProgrammerAstConverter::convert(&custom_ast).expect("Failed to convert AST");
}

#[test]
fn test_multiple_attributes() {
    let multi_ast =
        generate_ast("fix 1 @ 50 red @ 100").expect("Failed to parse 'fix 1 @ 50 red @ 100'");
    let commands = ProgrammerAstConverter::convert(&multi_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        assert!(instruction.values.contains_key(&Attribute::Intensity));
        assert!(instruction.values.contains_key(&Attribute::Red));
        assert_eq!(instruction.values.len(), 2, "Expected 2 attributes");
    }

    let rgb_ast = generate_ast("fix 1 @ 75 r @ 100 g @ 50 b @ 75")
        .expect("Failed to parse 'fix 1 @ 75 r @ 100 g @ 50 b @ 75'");
    let commands = ProgrammerAstConverter::convert(&rgb_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        assert!(instruction.values.contains_key(&Attribute::Intensity));
        assert!(instruction.values.contains_key(&Attribute::Red));
        assert!(instruction.values.contains_key(&Attribute::Green));
        assert!(instruction.values.contains_key(&Attribute::Blue));
        assert_eq!(instruction.values.len(), 4, "Expected 4 attributes");
    }
}

#[test]
fn test_active_selection_attributes() {
    // Test basic intensity
    let base_ast = generate_ast("@ 50").expect("Failed to parse '@ 50'");
    let commands = ProgrammerAstConverter::convert(&base_ast).expect("Failed to convert AST");
    assert_eq!(commands.len(), 1);

    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some());

    if let ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(instruction) =
        cmd.unwrap()
    {
        assert!(instruction.values.contains_key(&Attribute::Intensity));
    } else {
        panic!("Expected AddProgrammerInstructionWithActiveSelection");
    }

    // Test full intensity
    let full_ast = generate_ast("@@").expect("Failed to parse '@@'");
    let commands = ProgrammerAstConverter::convert(&full_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(instruction) =
        cmd.unwrap()
        && let Some(ValueSource::Inline(ParameterValue::AbsolutePercent { value })) =
            instruction.values.get(&Attribute::Intensity)
    {
        // Check that value is 100%
        assert!(
            format!("{}", value).contains("100"),
            "Expected 100%, got {}",
            value
        );
    }

    // Test explicit attribute
    let int_ast = generate_ast("int @ 75").expect("Failed to parse 'int @ 75'");
    let _commands = ProgrammerAstConverter::convert(&int_ast).expect("Failed to convert AST");

    // Test multiple attributes
    let multi_ast = generate_ast("@ 50 red @ 100").expect("Failed to parse '@ 50 red @ 100'");
    let commands = ProgrammerAstConverter::convert(&multi_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(instruction) =
        cmd.unwrap()
    {
        assert_eq!(instruction.values.len(), 2);
    }
}

#[test]
fn test_delete_aliases_are_not_parsed_as_active_selection_attributes() {
    assert!(generate_ast("rm @ 0").is_err());
    assert!(generate_ast("del @ 0").is_err());
    assert!(generate_ast("delete @ 0").is_err());
}

#[test]
fn test_reserved_command_heads_are_not_parsed_as_active_selection_attributes() {
    assert!(generate_ast("fx @ 2").is_err());
    assert!(generate_ast("flow @ 2").is_err());
}

#[test]
fn test_active_selection_custom_attribute_with_delete_prefix_converts() {
    let ast = generate_ast("rmx @ 10").expect("Failed to parse 'rmx @ 10'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");

    assert_eq!(commands.len(), 1);
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    assert!(cmd.is_some(), "Command is not a ProgrammerCommand");

    if let ProgrammerCommand::AddProgrammerInstructionWithActiveSelection(instruction) =
        cmd.unwrap()
    {
        assert!(instruction.values.keys().any(|attribute| {
            matches!(attribute, Attribute::Custom { label } if label == "rmx")
        }));
    } else {
        panic!("Expected AddProgrammerInstructionWithActiveSelection");
    }
}

#[test]
fn test_relative_values() {
    // Test positive relative intensity
    let plus_ast = generate_ast("fix 1 ~ 10").expect("Failed to parse 'fix 1 ~ 10'");
    let commands = ProgrammerAstConverter::convert(&plus_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap()
        && let Some(ValueSource::Inline(param_val)) = instruction.values.get(&Attribute::Intensity)
    {
        assert!(
            matches!(param_val, ParameterValue::RelativePercent { .. }),
            "Expected RelativePercent"
        );
    }

    // Test negative relative intensity
    let minus_ast = generate_ast("fix 1 ~ -10").expect("Failed to parse 'fix 1 ~ -10'");
    let commands = ProgrammerAstConverter::convert(&minus_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap()
        && let Some(ValueSource::Inline(param_val)) = instruction.values.get(&Attribute::Intensity)
    {
        assert!(matches!(param_val, ParameterValue::RelativePercent { .. }));
    }

    // Test relative attribute value
    let red_ast = generate_ast("fix 1 red ~ 25").expect("Failed to parse 'fix 1 red ~ 25'");
    let commands = ProgrammerAstConverter::convert(&red_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap()
        && let Some(ValueSource::Inline(param_val)) = instruction.values.get(&Attribute::Red)
    {
        assert!(matches!(param_val, ParameterValue::RelativePercent { .. }));
    }

    let pan_ast = generate_ast("fix 1 pan ~ -15").expect("Failed to parse 'fix 1 pan ~ -15'");
    let commands = ProgrammerAstConverter::convert(&pan_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap()
        && let Some(ValueSource::Inline(param_val)) = instruction.values.get(&Attribute::Pan)
    {
        assert!(matches!(param_val, ParameterValue::RelativePercent { .. }));
    }
}

#[test]
fn test_signed_absolute_values() {
    let pan_ast = generate_ast("fix 1 pan @ -15").expect("Failed to parse signed pan value");
    let commands = ProgrammerAstConverter::convert(&pan_ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();
    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap()
        && let Some(ValueSource::Inline(param_val)) = instruction.values.get(&Attribute::Pan)
    {
        match param_val {
            ParameterValue::AbsolutePercent { value } => {
                let pct = value.as_f32();
                assert!((pct + 0.15).abs() < 0.001);
            }
            other => panic!("Expected signed AbsolutePercent, got {:?}", other),
        }
    }

    let intensity_ast =
        generate_ast("fix 1 @ -10").expect("Failed to parse unsigned negative intensity");
    assert!(
        ProgrammerAstConverter::convert(&intensity_ast).is_err(),
        "unsigned absolute negative intensity should fail conversion"
    );
}

#[test]
fn test_trailing_dot_value_literals_are_invalid_syntax() {
    assert!(generate_ast("fix 1 @ 1.").is_err());
    assert!(generate_ast("fix 1 red @ +1.").is_err());
    assert!(generate_ast("@ 1.").is_err());
}

#[test]
fn test_fanned_intensity_two_values() {
    // Test fanned intensity with two values (linear fan)
    let ast = generate_ast("fix 1 @ 0>100").expect("Failed to parse 'fix 1 @ 0>100'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();

    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        assert!(instruction.values.contains_key(&Attribute::Intensity));
        if let Some(ValueSource::Fanned { values }) = instruction.values.get(&Attribute::Intensity)
        {
            assert_eq!(values.len(), 2, "Expected 2 fanned values");
            // First value should be 0%
            if let ParameterValue::AbsolutePercent { value } = &values[0] {
                assert!(
                    format!("{}", value).contains("0"),
                    "Expected 0%, got {}",
                    value
                );
            }
            // Second value should be 100%
            if let ParameterValue::AbsolutePercent { value } = &values[1] {
                assert!(
                    format!("{}", value).contains("100"),
                    "Expected 100%, got {}",
                    value
                );
            }
        } else {
            panic!("Expected Fanned ValueSource");
        }
    }
}

#[test]
fn test_fanned_intensity_three_values() {
    // Test fanned intensity with three values (envelope)
    let ast = generate_ast("fix 1 @ 0>100>50").expect("Failed to parse 'fix 1 @ 0>100>50'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();

    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        if let Some(ValueSource::Fanned { values }) = instruction.values.get(&Attribute::Intensity)
        {
            assert_eq!(values.len(), 3, "Expected 3 fanned values");
        } else {
            panic!("Expected Fanned ValueSource with 3 values");
        }
    }
}

#[test]
fn test_fanned_attribute() {
    // Test fanned values on a named attribute
    let ast = generate_ast("fix 1 pan @ 0>180").expect("Failed to parse 'fix 1 pan @ 0>180'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();

    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        if let Some(ValueSource::Fanned { values }) = instruction.values.get(&Attribute::Pan) {
            assert_eq!(values.len(), 2, "Expected 2 fanned values for pan");
        } else {
            panic!("Expected Fanned ValueSource for pan attribute");
        }
    }
}

#[test]
fn test_mixed_fanned_and_inline() {
    // Test command with both fanned and inline values
    let ast =
        generate_ast("fix 1 @ 0>100 red @ 50").expect("Failed to parse 'fix 1 @ 0>100 red @ 50'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();

    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        // Intensity should be fanned
        assert!(
            matches!(
                instruction.values.get(&Attribute::Intensity),
                Some(ValueSource::Fanned { .. })
            ),
            "Expected Intensity to be Fanned"
        );
        // Red should be inline
        assert!(
            matches!(
                instruction.values.get(&Attribute::Red),
                Some(ValueSource::Inline(_))
            ),
            "Expected Red to be Inline"
        );
    }
}

#[test]
fn test_single_value_not_fanned() {
    // Verify that single values remain as Inline, not Fanned
    let ast = generate_ast("fix 1 @ 50").expect("Failed to parse 'fix 1 @ 50'");
    let commands = ProgrammerAstConverter::convert(&ast).expect("Failed to convert AST");
    let cmd = commands[0].as_any().downcast_ref::<ProgrammerCommand>();

    if let ProgrammerCommand::AddProgrammerInstruction { instruction, .. } = cmd.unwrap() {
        assert!(
            matches!(
                instruction.values.get(&Attribute::Intensity),
                Some(ValueSource::Inline(_))
            ),
            "Single value should remain as Inline, not Fanned"
        );
    }
}

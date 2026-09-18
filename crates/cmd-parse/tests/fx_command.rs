// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::{ast, generate_ast};

// ============================================================================
// AST -> Command Structure Tests
// ============================================================================

/// Verifies a stored Step FX preserves percentage duration units.
#[test]
fn test_fx_duration_percent_ast() {
    let command_ast = generate_ast("store fx 1 step fix 1 50% int steps 100 0")
        .expect("Failed to parse FX command");

    match command_ast {
        ast::CommandAst::General(ast::GeneralCommandAst::StoreStepFx(command)) => {
            assert_eq!(command.definition.duration.value.0, "50");
            assert_eq!(
                command.definition.duration.unit.as_ref().map(|u| u.0),
                Some("%")
            );
        }
        other => panic!("Expected stored Step FX command, got {:?}", other),
    }
}

/// Verifies a following attribute finalizes a unitless Step FX duration.
#[test]
fn test_fx_duration_without_unit_ast() {
    let command_ast = generate_ast("store fx 1 step fix 1 5 int steps 100 0")
        .expect("Failed to parse FX command with a unitless duration");

    match command_ast {
        ast::CommandAst::General(ast::GeneralCommandAst::StoreStepFx(command)) => {
            assert_eq!(command.definition.duration.value.0, "5");
            assert!(command.definition.duration.unit.is_none());
        }
        other => panic!("Expected stored Step FX command, got {:?}", other),
    }
}

/// Verifies phase grouping must be expressed in the spatial selection language.
#[test]
fn test_fx_step_rejects_legacy_phase_groups() {
    let command_ast = generate_ast("store fx 1 step fix 1 5s groups 4 int steps 100 0");
    assert!(
        command_ast.is_err(),
        "legacy Step FX phase groups should be rejected"
    );
}

/// Verifies Step FX creation rejects unsupported parameter selections.
#[test]
fn test_fx_step_rejects_parameter_selection_head() {
    let command_ast = generate_ast("store fx 1 step param 1 50% int steps 100 0");
    assert!(
        command_ast.is_err(),
        "parameter selection head should be rejected"
    );
}

/// Verifies FX step selections preserve transform-bearing source text in the AST.
#[test]
fn test_fx_step_accepts_transformed_selection() {
    let command_ast = generate_ast("store fx 1 step fix 1>10|wings 2 5s int steps 100 0")
        .expect("Failed to parse transformed FX selection");

    match command_ast {
        ast::CommandAst::General(ast::GeneralCommandAst::StoreStepFx(command)) => {
            assert_eq!(command.definition.selection.source, "fix 1>10|wings 2");
            assert!(matches!(
                command.definition.selection.selection.selection_type,
                ast::SelectionTypeAst::Fixture
            ));
        }
        other => panic!("Expected stored Step FX command, got {:?}", other),
    }
}

/// Verifies FX step selections accept spaced transform pipelines before duration.
#[test]
fn test_fx_step_accepts_spaced_transformed_selection() {
    let command_ast =
        generate_ast("store fx 1 step group 1 | grid 4x2 | mirror y 5s int steps 100 0")
            .expect("Failed to parse spaced transformed FX selection");

    match command_ast {
        ast::CommandAst::General(ast::GeneralCommandAst::StoreStepFx(command)) => {
            assert_eq!(
                command.definition.selection.source,
                "group 1 | grid 4x2 | mirror y"
            );
            assert!(matches!(
                command.definition.selection.selection.selection_type,
                ast::SelectionTypeAst::Group
            ));
        }
        other => panic!("Expected stored Step FX command, got {:?}", other),
    }
}

/// Verifies FX step selections accept subset transforms before duration.
#[test]
fn test_fx_step_accepts_take_and_skip_transforms() {
    let command_ast =
        generate_ast("store fx 1 step fix 311>315 | skip 60 | take 60 5s int steps 100 0")
            .expect("Failed to parse FX selection with subset transforms");

    match command_ast {
        ast::CommandAst::General(ast::GeneralCommandAst::StoreStepFx(command)) => {
            assert_eq!(
                command.definition.selection.source,
                "fix 311>315 | skip 60 | take 60"
            );
            assert!(matches!(
                command.definition.selection.selection.selection_type,
                ast::SelectionTypeAst::Fixture
            ));
        }
        other => panic!("Expected stored Step FX command, got {:?}", other),
    }
}

/// Verifies Step FX accepts quoted group labels without an explicit selection head.
#[test]
fn test_fx_step_accepts_quoted_group_source() {
    let command_ast = generate_ast("store fx 1 step \"No Fixtures\" 5s int steps 100 0")
        .expect("Failed to parse quoted Step FX selection");

    assert!(matches!(
        command_ast,
        ast::CommandAst::General(ast::GeneralCommandAst::StoreStepFx(_))
    ));
}

/// Verifies Step FX accepts parenthesized spatial pipelines as its selection source.
#[test]
fn test_fx_step_accepts_parenthesized_spatial_source() {
    let command_ast =
        generate_ast("store fx 1 step (fix 1>8 | group 2) | take 1 5s int steps 100 0")
            .expect("Failed to parse parenthesized Step FX selection");

    assert!(matches!(
        command_ast,
        ast::CommandAst::General(ast::GeneralCommandAst::StoreStepFx(_))
    ));
}

/// Verifies multi-token invert clauses remain live through their attribute list.
#[test]
fn test_fx_step_accepts_invert_attribute_transform() {
    let command_ast =
        generate_ast("store fx 1 step fix 1 | invert wing attrs pan 5s int steps 100 0")
            .expect("Failed to parse Step FX invert attributes");

    assert!(matches!(
        command_ast,
        ast::CommandAst::General(ast::GeneralCommandAst::StoreStepFx(_))
    ));
}

/// Verifies playback-rate parsing remains under the non-store FX command.
#[test]
fn test_fx_rate_decimal_ast() {
    let command_ast = generate_ast("fx 1 rate 2.5").expect("Failed to parse FX rate command");

    match command_ast {
        ast::CommandAst::Fx(fx_ast) => match fx_ast.action {
            ast::FxActionAst::SetRate(rate) => {
                assert_eq!(rate.value.0, "2.5");
            }
            other => panic!("Expected SetRate FX action, got {:?}", other),
        },
        other => panic!("Expected FX command, got {:?}", other),
    }
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::ast::{FxActionAst, SetFxRateAst, ValueAst};
use nightfall_cmd_parse::generate_ast;
use nightfall_fx::events::StepFxCommand;
use nightfall_fx::stepfx_commands_from_ast;

#[test]
fn set_rate_conversion() {
    // Test AST conversion directly
    let set_rate = SetFxRateAst {
        value: ValueAst("2.5"),
    };
    let action = FxActionAst::SetRate(set_rate);
    let cmds = stepfx_commands_from_ast(7, &action).expect("conversion should succeed");
    assert_eq!(cmds.len(), 1);
    match &cmds[0] {
        StepFxCommand::SetRate { fx_id, rate } => {
            assert_eq!(*fx_id, 7);
            assert!(((*rate) - 2.5).abs() < 1e-6);
        }
        other => panic!("unexpected command variant: {:?}", other),
    }

    // Test that parsing produces consistent ASTs
    let _base_ast = generate_ast("fx 1 rate 2.5").expect("Failed to parse 'fx 1 rate 2.5'");
}

#[test]
fn start_stop_conversion() {
    // Test AST conversion directly - Start
    let start_action = FxActionAst::Start;
    let cmds = stepfx_commands_from_ast(3, &start_action).expect("start conversion");
    assert_eq!(cmds.len(), 1);
    match &cmds[0] {
        StepFxCommand::Start(id) => assert_eq!(*id, 3),
        other => panic!("unexpected command variant for start: {:?}", other),
    }

    // Test AST conversion directly - Stop
    let stop_action = FxActionAst::Stop;
    let cmds2 = stepfx_commands_from_ast(3, &stop_action).expect("stop conversion");
    assert_eq!(cmds2.len(), 1);
    match &cmds2[0] {
        StepFxCommand::Stop(id) => assert_eq!(*id, 3),
        other => panic!("unexpected command variant for stop: {:?}", other),
    }

    // Test that parsing produces consistent ASTs
    let start_ast = generate_ast("fx 1 start").expect("Failed to parse 'fx 1 start'");
    let on_ast = generate_ast("fx 1 on").expect("Failed to parse 'fx 1 on'");
    assert_eq!(
        start_ast, on_ast,
        "'start' and 'on' should produce identical ASTs"
    );

    let stop_ast = generate_ast("fx 1 stop").expect("Failed to parse 'fx 1 stop'");
    let off_ast = generate_ast("fx 1 off").expect("Failed to parse 'fx 1 off'");
    assert_eq!(
        stop_ast, off_ast,
        "'stop' and 'off' should produce identical ASTs"
    );
}

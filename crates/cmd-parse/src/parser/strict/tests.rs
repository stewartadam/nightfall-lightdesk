// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::branch_view::{merged_slot_span, tokens_in_span};
use super::{
    lex_command, materialize_strict_ast_from_structural_dispatch, parse_channel_command,
    parse_clear_command, parse_log_command, parse_patch_add_command, parse_release_command,
    parse_rm_patch_command, parse_selection_ast, parse_set_fps_command, parse_simple_clip_command,
    parse_simple_flow_command, parse_simple_general_command, parse_simple_general_object_commands,
    parse_simple_identifier_expression_from_tokens, parse_simple_selection_command,
    parse_simple_timecode_command, parse_simple_timeline_command, parse_sleep_command,
    parse_strict, strict_preparse,
};
use crate::ast::{
    ClearTargetAst, CommandAst, DmxChannelTermAst, FlowActionAst, FxActionAst, GeneralCommandAst,
    LogCommandAst, LogFilterCommandAst, ObjectTypeAst, PatchEndpointAst, PlaybackActionAst,
    QuotedStringAst, ReleaseDmxChannelTermAst, ReleaseTargetAst, RotationActionAst,
    RotationValueAst, SelectionTypeAst, SetOperatorAst, SimpleTermAst, StartStopAst, TermAst,
    TimecodeActionAst, TimingDirectionAst,
};

#[test]
fn strict_preparse_accepts_word_head() {
    assert!(strict_preparse("fix 1 red @ 100").is_ok());
}

#[test]
fn strict_preparse_accepts_active_selection_head() {
    assert!(strict_preparse("@ 50").is_ok());
}

#[test]
fn strict_preparse_accepts_leading_whitespace() {
    assert!(strict_preparse("  flow 1 start").is_ok());
}

#[test]
fn strict_preparse_rejects_empty_input() {
    assert!(strict_preparse("").is_err());
}

#[test]
fn simple_general_parser_accepts_mixed_case_commands() {
    assert!(matches!(
        parse_simple_general_command("SaVe"),
        Some(CommandAst::General(GeneralCommandAst::Save(save))) if save.name.is_none()
    ));
    assert!(matches!(
        parse_simple_general_command("  ReDo  "),
        Some(CommandAst::General(GeneralCommandAst::Redo(_)))
    ));
}

/// Verifies simple save/load commands can carry an optional showfile name.
#[test]
fn simple_general_parser_accepts_named_showfile_commands() {
    assert!(matches!(
        parse_simple_general_command("save demo"),
        Some(CommandAst::General(GeneralCommandAst::Save(save)))
            if save.name.as_ref().is_some_and(|name| name.0 == "demo")
    ));
    assert!(matches!(
        parse_simple_general_command("load demo"),
        Some(CommandAst::General(GeneralCommandAst::Load(load)))
            if load.name.as_ref().is_some_and(|name| name.0 == "demo")
    ));
    assert!(matches!(
        parse_simple_general_command("load draft/default"),
        Some(CommandAst::General(GeneralCommandAst::Load(load)))
            if load.name.as_ref().is_some_and(|name| name.0 == "draft/default")
    ));
    assert!(matches!(
        parse_simple_general_command("load backups/default-20260707-151450"),
        Some(CommandAst::General(GeneralCommandAst::Load(load)))
            if load.name.as_ref().is_some_and(|name| name.0 == "backups/default-20260707-151450")
    ));
    assert!(parse_simple_general_command("save demo extra").is_none());
}

/// Verifies the new-show command form is accepted without an inline name.
#[test]
fn simple_general_parser_accepts_new_show_command() {
    assert!(matches!(
        parse_simple_general_command("new show"),
        Some(CommandAst::General(GeneralCommandAst::NewShowfile(_)))
    ));
    assert!(matches!(
        parse_simple_general_command("new showfile"),
        Some(CommandAst::General(GeneralCommandAst::NewShowfile(_)))
    ));
    assert!(parse_simple_general_command("new show demo").is_none());
}

/// The shared command entry point dispatches programmer syntax to its own AST family.
#[test]
fn command_parser_dispatches_non_general_commands() {
    assert!(matches!(
        parse_simple_general_command("fix 1 @ 100"),
        Some(CommandAst::Attribute(_))
    ));
}

#[test]
fn simple_clip_parser_supports_aliases_and_goto() {
    assert!(matches!(
        parse_simple_clip_command("exec 1 start"),
        Some(CommandAst::Clip(clip))
            if clip.action == PlaybackActionAst::On
    ));
    assert!(matches!(
        parse_simple_clip_command("e 2 goto 5"),
        Some(CommandAst::Clip(clip))
            if clip.action == PlaybackActionAst::Goto(5)
    ));
}

#[test]
fn simple_timecode_and_timeline_parsers_support_aliases() {
    assert!(matches!(
        parse_simple_timecode_command("tc 3 pause"),
        Some(CommandAst::Timecode(command))
            if command.action == TimecodeActionAst::Pause
    ));
    assert!(matches!(
        parse_simple_timeline_command("tl 4 stop"),
        Some(CommandAst::Timeline(command))
            if command.action == StartStopAst::Stop
    ));
}

#[test]
fn simple_identifier_expression_parser_supports_ranges_and_set_ops() {
    let command = "1>3+5";
    let tokens = lex_command(command);
    let parsed =
        parse_simple_identifier_expression_from_tokens(command, &tokens.iter().collect::<Vec<_>>())
            .expect("expected expression to parse");

    match parsed.head {
        SimpleTermAst::Range(range) => {
            assert_eq!(range.start.id, 1);
            assert_eq!(range.end.id, 3);
        }
        other => panic!("expected range head, got {:?}", other),
    }

    assert_eq!(parsed.tail.len(), 1);
    assert!(matches!(parsed.tail[0].op, SetOperatorAst::Add));
}

#[test]
fn simple_clip_parser_supports_complex_ids() {
    assert!(matches!(
        parse_simple_clip_command("clip 1>5 on"),
        Some(CommandAst::Clip(clip))
            if matches!(clip.clip_id.head, SimpleTermAst::Range(_))
    ));
}

#[test]
fn simple_flow_parser_supports_delete_and_rename_aliases() {
    assert!(matches!(
        parse_simple_flow_command("flow 1 del"),
        Some(CommandAst::Flow(flow))
            if flow.action == FlowActionAst::Delete
    ));
    assert!(matches!(
        parse_simple_flow_command("flow 3 mv 9"),
        Some(CommandAst::Flow(flow))
            if matches!(flow.action, FlowActionAst::Rename(_))
    ));
}

/// Verifies the retired flow-create syntax is no longer accepted.
#[test]
fn simple_flow_parser_rejects_legacy_create_syntax() {
    assert!(parse_simple_flow_command("flow 5 create").is_none());
    assert!(parse_strict("flow 5 create").is_err());
}

/// Verifies the store-flow parser preserves an escaped serialized payload.
#[test]
fn strict_parser_handles_store_flow_payloads_in_strict_mode() {
    assert!(matches!(
        parse_strict("store flow 7 \"{\\\"x\\\":1}\""),
        Ok(CommandAst::General(GeneralCommandAst::StoreFlow(flow)))
            if flow.payload == Some(QuotedStringAst("\"{\\\"x\\\":1}\""))
    ));
}

#[test]
fn simple_flow_parser_supports_complex_ids() {
    assert!(matches!(
        parse_simple_flow_command("flow 1>2 start"),
        Some(CommandAst::Flow(flow))
            if matches!(flow.flow_id.head, SimpleTermAst::Range(_))
    ));
    assert!(matches!(
        parse_simple_flow_command("flow 3 mv 7>9"),
        Some(CommandAst::Flow(flow))
            if matches!(flow.action, FlowActionAst::Rename(_))
    ));
}

#[test]
fn simple_general_parser_supports_help_alias() {
    assert!(matches!(
        parse_simple_general_command("?"),
        Some(CommandAst::General(GeneralCommandAst::Help(_)))
    ));
}

#[test]
fn simple_general_parser_supports_fps_and_sleep_commands() {
    assert!(matches!(
        parse_set_fps_command("fps +120"),
        Some(CommandAst::General(GeneralCommandAst::SetFps(fps)))
            if fps.fps.0 == "+120"
    ));
    assert!(matches!(
        parse_sleep_command("sleep 1.5sec"),
        Some(CommandAst::General(GeneralCommandAst::Sleep(sleep)))
            if sleep.duration.value.0 == "1.5"
                && sleep.duration.unit.map(|unit| unit.0) == Some("sec")
    ));
    assert!(matches!(
        parse_sleep_command("sleep -2"),
        Some(CommandAst::General(GeneralCommandAst::Sleep(sleep)))
            if sleep.duration.value.0 == "-2" && sleep.duration.unit.is_none()
    ));
}

#[test]
fn log_parser_supports_level_filter_and_fixture_forms() {
    assert!(matches!(
        parse_log_command("log level warn,foo=debug"),
        Some(CommandAst::General(GeneralCommandAst::Log(log)))
            if matches!(log.command, LogCommandAst::Level(_))
    ));
    assert!(matches!(
        parse_log_command("log filter clear"),
        Some(CommandAst::General(GeneralCommandAst::Log(log)))
            if matches!(
                &log.command,
                LogCommandAst::Filter(filter)
                    if matches!(filter.filter, LogFilterCommandAst::Clear(_))
            )
    ));
    assert!(matches!(
        parse_log_command("log fix 1 red"),
        Some(CommandAst::General(GeneralCommandAst::Log(log)))
            if matches!(log.command, LogCommandAst::Fixture(_))
    ));
}

#[test]
fn materialize_log_ast_from_branch_handles_fixture_form() {
    let input = "log fix 1 red";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_log_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::Log(log)))
            if matches!(log.command, LogCommandAst::Fixture(_))
    ));
}

#[test]
fn simple_general_object_parser_supports_store_group_delete_and_recall_cue() {
    assert!(matches!(
        parse_simple_general_object_commands("store g 1>3"),
        Some(CommandAst::General(GeneralCommandAst::StoreGroup(_)))
    ));
    assert!(matches!(
        parse_simple_general_object_commands("rm fixture 5"),
        Some(CommandAst::General(GeneralCommandAst::Delete(cmd)))
            if matches!(cmd.object_type, ObjectTypeAst::Fixture)
    ));
    assert!(matches!(
        parse_simple_general_object_commands("recall c 1.2"),
        Some(CommandAst::General(GeneralCommandAst::RecallCue(_)))
    ));
}

#[test]
fn simple_selection_parser_supports_aliases_and_set_expressions() {
    assert!(matches!(
        parse_simple_selection_command("f 1>3+5"),
        Some(CommandAst::Selection(selection))
            if matches!(selection.selection.selection_type, SelectionTypeAst::Fixture)
                && matches!(selection.selection.ids.head, TermAst::Range(_))
    ));
    assert!(matches!(
        parse_simple_selection_command("grp 12"),
        Some(CommandAst::Selection(selection))
            if matches!(selection.selection.selection_type, SelectionTypeAst::Group)
    ));
}

#[test]
fn parse_selection_ast_supports_selection_aliases() {
    assert!(matches!(
        parse_selection_ast("grp 12"),
        Ok(selection) if matches!(selection.selection_type, SelectionTypeAst::Group)
    ));
}

#[test]
fn channel_parser_supports_aliases_and_grouped_expressions() {
    assert!(matches!(
        parse_channel_command("chan 1.100 @ 255"),
        Some(CommandAst::Channel(channel))
            if channel.value.0 == "255"
                && matches!(channel.channels.head, DmxChannelTermAst::Single(_))
    ));
    assert!(matches!(
        parse_channel_command("ch (1.1>1.5)+(2.1>2.5) @ 100"),
        Some(CommandAst::Channel(channel))
            if matches!(channel.channels.head, DmxChannelTermAst::Grouped(_))
                && channel.channels.tail.len() == 1
    ));
}

#[test]
fn strict_parser_handles_channel_commands_in_strict_mode() {
    assert!(matches!(
        parse_strict("channel 2.56>2.59+3.51 @ 128"),
        Ok(CommandAst::Channel(channel))
            if matches!(channel.channels.head, DmxChannelTermAst::Range(_))
    ));
}

#[test]
fn strict_parser_handles_patch_commands_in_strict_mode() {
    assert!(matches!(
        parse_patch_add_command("patch sacn@sacn"),
        Some(CommandAst::PatchAdd(command))
            if matches!(command.source, PatchEndpointAst::Transport(_))
                && matches!(command.target, PatchEndpointAst::Transport(_))
    ));
    assert!(matches!(
        parse_patch_add_command("patch artnet:3.78 @ fix 311>315 .1 param intensity prio 2 /clone"),
        Some(CommandAst::PatchAdd(command))
            if matches!(command.target, PatchEndpointAst::Fixture(_))
                && command.priority.is_some()
                && command.clone.is_some()
    ));
    assert!(matches!(
        parse_strict("patch console @ fix 311.2 .1 param intensity"),
        Ok(CommandAst::PatchAdd(command))
            if matches!(command.target, PatchEndpointAst::Fixture(_))
    ));
}

#[test]
fn strict_parser_handles_rm_patch_commands_in_strict_mode() {
    assert!(matches!(
        parse_rm_patch_command("rm patch @ disabled"),
        Some(CommandAst::RmPatch(command))
            if command.source.is_none() && command.target.is_some()
    ));
    assert!(matches!(
        parse_rm_patch_command("rm patch artnet:3 @"),
        Some(CommandAst::RmPatch(command))
            if command.source.is_some() && command.target.is_none()
    ));
    assert!(matches!(
        parse_strict("rm patch artnet:3.78 @ fix 311>315 .1 param intensity prio 2 /clone"),
        Ok(CommandAst::RmPatch(command))
            if command.source.is_some()
                && command.target.is_some()
                && command.priority.is_some()
                && command.clone.is_some()
    ));
}

/// Verifies strict parsing recognizes store commands that carry creation data.
#[test]
fn strict_parser_handles_store_payload_commands_in_strict_mode() {
    assert!(matches!(
        parse_strict("store fix 1 \"Acme\" \"Wash\" mode1"),
        Ok(CommandAst::General(GeneralCommandAst::StoreFixture(_)))
    ));
    assert!(matches!(
        parse_strict("store fixture 1 offset int 50%"),
        Ok(CommandAst::General(GeneralCommandAst::StoreFixtureOffset(
            _
        )))
    ));
    assert!(matches!(
        parse_strict("store blueprint 9 filter red blue"),
        Ok(CommandAst::General(GeneralCommandAst::StoreBlueprint(_)))
    ));
    assert!(matches!(
        parse_strict("store clip 5"),
        Ok(CommandAst::General(GeneralCommandAst::StoreClip(_)))
    ));
    assert!(matches!(
        parse_strict("store flow 5"),
        Ok(CommandAst::General(GeneralCommandAst::StoreFlow(_)))
    ));
    assert!(matches!(
        parse_strict("store timecode 5"),
        Ok(CommandAst::General(GeneralCommandAst::StoreTimecode(_)))
    ));
    assert!(matches!(
        parse_strict("store timeline 5"),
        Ok(CommandAst::General(GeneralCommandAst::StoreTimeline(_)))
    ));
    assert!(matches!(
        parse_strict("store fx 5 step fix 1 5s int steps 100 0"),
        Ok(CommandAst::General(GeneralCommandAst::StoreStepFx(_)))
    ));
}

/// Verifies store commands preserve top-level and nested identifier ranges.
#[test]
fn strict_parser_handles_ranged_store_targets() {
    assert!(matches!(
        parse_strict("store exec 1>5"),
        Ok(CommandAst::General(GeneralCommandAst::StoreClip(command)))
            if matches!(command.id.head, SimpleTermAst::Range(_))
    ));
    assert!(matches!(
        parse_strict("store cue 11.(1>5)"),
        Ok(CommandAst::General(GeneralCommandAst::StoreCue(command)))
            if matches!(
                &command.target,
                crate::ast::StoreCueTargetAst::Cues {
                    sequence_id: 11,
                    cue_ids,
                } if matches!(cue_ids.head, SimpleTermAst::Grouped(_))
            )
    ));
}

#[test]
fn strict_structural_dispatch_accepts_fully_consumed_store_blueprint_branch() {
    assert!(matches!(
        materialize_strict_ast_from_structural_dispatch("store blueprint 9 filter red blue",),
        Some(CommandAst::General(GeneralCommandAst::StoreBlueprint(_)))
    ));
}

#[test]
fn materialize_store_ast_from_branch_handles_blueprint_payload() {
    let input = "store blueprint 9 filter red blue";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_store_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::StoreBlueprint(_)))
    ));
}

#[test]
fn materialize_store_ast_from_branch_handles_cue_ref() {
    let input = "store cue 1.2";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert_eq!(
        super::materialize_store_ast_from_branch(input, branch),
        parse_simple_general_object_commands(input),
    );
}

#[test]
fn materialize_store_ast_from_branch_handles_group_expression() {
    let input = "store g 1>3";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert_eq!(
        super::materialize_store_ast_from_branch(input, branch),
        parse_simple_general_object_commands(input),
    );
}

#[test]
fn materialize_store_ast_from_branch_handles_fixture_payload() {
    let input = "store fix 1 \"Acme\" \"Wash\" mode1";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert_eq!(
        super::materialize_store_ast_from_branch(input, branch),
        super::parse_store_extended_command(input),
    );
}

#[test]
fn materialize_store_ast_from_branch_handles_fixture_offset() {
    let input = "store fixture 1 offset int 50%";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert_eq!(
        super::materialize_store_ast_from_branch(input, branch),
        super::parse_store_extended_command(input),
    );
}

#[test]
fn materialize_release_ast_from_branch_handles_attribute_target() {
    let input = "release attr red";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_release_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::Release(_)))
    ));
}

#[test]
fn materialize_clear_ast_from_branch_handles_fixture_attribute_target() {
    let input = "clear fix 1 attr red";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_clear_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::Clear(_)))
    ));
}

#[test]
fn materialize_channel_ast_from_branch_handles_grouped_expression() {
    let input = "channel (1.1>1.5)+(2.1>2.5) @ 100";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_channel_ast_from_branch(input, branch),
        Some(CommandAst::Channel(_))
    ));
}

#[test]
fn materialize_sleep_ast_from_branch_handles_duration_value() {
    let input = "sleep 1.5sec";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_sleep_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::Sleep(command)))
            if command.duration.value.0 == "1.5"
                && command.duration.unit.map(|unit| unit.0) == Some("sec")
    ));
}

#[test]
fn materialize_fps_ast_from_branch_handles_signed_value() {
    let input = "fps +120";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_fps_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::SetFps(command)))
            if command.fps.0 == "+120"
    ));
}

#[test]
fn materialize_recall_ast_from_branch_handles_cue_ref() {
    let input = "recall cue 1.1";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_recall_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::RecallCue(_)))
    ));
}

#[test]
fn materialize_general_object_ast_from_branch_handles_debug_form() {
    let input = "debug fixture 1";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_general_object_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::Debug(_)))
    ));
}

#[test]
fn materialize_general_object_ast_from_branch_handles_rename_form() {
    let input = "rename fixture 1 3";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_general_object_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::Rename(_)))
    ));
}

#[test]
fn materialize_general_object_ast_from_branch_handles_rm_cue_form() {
    let input = "rm cue 1.1";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_general_object_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::DeleteCue(_)))
    ));
}

#[test]
fn materialize_rm_patch_ast_from_branch_handles_modifiers() {
    let input = "rm patch artnet:3.78 @ fix 311 prio 2 /clone";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_rm_patch_ast_from_branch(input, branch),
        Some(CommandAst::RmPatch(command))
            if command.source.is_some()
                && command.target.is_some()
                && command.priority.is_some()
                && command.clone.is_some()
    ));
}

/// Verifies store-flow materialization accepts a flow without serialized data.
#[test]
fn strict_parser_materializes_store_flow_without_payload() {
    assert!(matches!(
        parse_strict("store flow 7"),
        Ok(CommandAst::General(GeneralCommandAst::StoreFlow(flow)))
            if flow.payload.is_none()
    ));
}

/// Verifies store-flow materialization retains escaped serialized data.
#[test]
fn strict_parser_materializes_store_flow_with_escaped_payload() {
    assert!(matches!(
        parse_strict("store flow 7 \"{\\\"x\\\":1}\""),
        Ok(CommandAst::General(GeneralCommandAst::StoreFlow(flow)))
            if flow.payload == Some(QuotedStringAst("\"{\\\"x\\\":1}\""))
    ));
}

#[test]
fn materialize_selection_ast_from_branch_handles_group_selection() {
    let input = "grp 12";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");
    let ids_span = merged_slot_span(branch, crate::slots::contracts::SlotId::SelectionIdentifier)
        .expect("expected selection identifier span");

    assert_eq!(&input[ids_span.clone()], "12");
    assert!(
        super::parse_identifier_expression_from_tokens(input, &tokens_in_span(&tokens, ids_span))
            .is_some()
    );

    assert!(matches!(
        super::materialize_selection_ast_from_branch(input, branch),
        Some(CommandAst::Selection(selection))
            if matches!(selection.selection.selection_type, SelectionTypeAst::Group)
    ));
}

#[test]
fn materialize_selection_ast_from_branch_handles_complex_fixture_selection() {
    let input = "fix 1>3+5";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert_eq!(
        super::materialize_selection_ast_from_branch(input, branch),
        parse_simple_selection_command(input)
    );
}

#[test]
fn materialize_fx_ast_from_branch_handles_start_action() {
    let input = "fx 1 start";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_fx_ast_from_branch(input, branch),
        Some(CommandAst::Fx(command)) if matches!(command.action, FxActionAst::Start)
    ));
}

#[test]
fn materialize_fx_ast_from_branch_handles_rate_action() {
    let input = "fx 1 rate 50";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_fx_ast_from_branch(input, branch),
        Some(CommandAst::Fx(command))
            if matches!(command.action, FxActionAst::SetRate(ref rate) if rate.value.0 == "50")
    ));
}

/// Verifies the structural store branch materializes a Step FX definition.
#[test]
fn materialize_store_ast_from_branch_handles_step_fx() {
    let input = "store fx 1 step fix 1 50% int steps 100 0";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_store_ast_from_branch(input, branch),
        Some(CommandAst::General(GeneralCommandAst::StoreStepFx(command)))
            if command.definition.attributes.len() == 1
                && command.definition.attributes[0].steps.len() == 2
    ));
}

#[test]
fn strict_structural_dispatch_handles_fx_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fx 1 start"),
        Some(CommandAst::Fx(command)) if matches!(command.action, FxActionAst::Start)
    ));
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fx 1 rate 50"),
        Some(CommandAst::Fx(command))
            if matches!(command.action, FxActionAst::SetRate(ref rate) if rate.value.0 == "50")
    ));
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fx 1 rate 2.5"),
        Some(CommandAst::Fx(command))
            if matches!(command.action, FxActionAst::SetRate(ref rate) if rate.value.0 == "2.5")
    ));
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch(
            "store fx 1 step fix 1 50% int steps 100 0"
        ),
        Some(CommandAst::General(GeneralCommandAst::StoreStepFx(command)))
            if command.definition.attributes.len() == 1
                && command.definition.attributes[0].steps.len() == 2
    ));
}

#[test]
fn materialize_attribute_ast_from_branch_handles_active_selection_timings() {
    let input = "red @ 100 fade 1";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = branches
        .iter()
        .find(|branch| {
            branch
                .consumed_items
                .iter()
                .any(|item| item.slot.slot == crate::slots::contracts::SlotId::SetAttrAttribute)
                && branch
                    .consumed_items
                    .iter()
                    .any(|item| item.slot.slot == crate::slots::contracts::SlotId::TimingsKeyword)
        })
        .expect("expected active-selection structural branch");

    assert!(matches!(
        super::materialize_attribute_ast_from_branch(input, branch),
        Some(CommandAst::ActiveSelectionAttribute(command))
            if command.timings.as_ref().and_then(|timings| timings.fades.as_ref()).is_some()
    ));
}

#[test]
fn strict_structural_dispatch_handles_active_selection_attribute_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("red @ 100 fade 1"),
        Some(CommandAst::ActiveSelectionAttribute(command))
            if command.timings.as_ref().and_then(|timings| timings.fades.as_ref()).is_some()
    ));
}

#[test]
fn strict_structural_dispatch_handles_explicit_selection_attribute_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fix 311 red @ 100 fade 1"),
        Some(CommandAst::Attribute(command))
            if matches!(command.selection.selection.selection_type, SelectionTypeAst::Fixture)
                && command.timings.as_ref().and_then(|timings| timings.fades.as_ref()).is_some()
    ));
}

/// Strict parser preserves clause-bearing selection source on explicit attribute commands.
#[test]
fn strict_parser_handles_spatial_selection_attribute_branch() {
    assert!(matches!(
        parse_strict("group 1>4|wings 2 @ 50"),
        Ok(CommandAst::Attribute(command))
            if command.selection.source == "group 1>4|wings 2"
                && matches!(command.selection.selection.selection_type, SelectionTypeAst::Group)
    ));
}

#[test]
fn strict_structural_dispatch_handles_complex_selection_branch() {
    let input = "fix 1>3+5";
    assert_eq!(
        super::materialize_strict_ast_from_structural_dispatch(input),
        parse_simple_selection_command(input)
    );
}

#[test]
fn materialize_fixture_placement_ast_from_branch_handles_chained_actions() {
    let input = "fix 1 3d pos x 1 rot z 180";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_fixture_placement_ast_from_branch(input, branch),
        Some(CommandAst::FixturePlacement(command))
            if command.actions.position.is_some() && command.actions.rotation.is_some()
    ));
}

#[test]
fn strict_structural_dispatch_handles_fixture_placement_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fix 1 3d pos x 1 rot z 180"),
        Some(CommandAst::FixturePlacement(command))
            if command.actions.position.is_some() && command.actions.rotation.is_some()
    ));
}

#[test]
fn materialize_patch_add_ast_from_branch_handles_modifiers() {
    let input = "patch artnet:3.78 @ fix 311 prio 2 /clone";
    let tokens = crate::parser::lexer::lex_command(input);
    let branches = super::super::structural::execute_branches_from_tokens(
        &super::build_strict_prefix_context(&tokens, input.len()),
        &tokens,
        input.len(),
    );
    let branch = super::best_completed_structural_branch(&branches, input.len())
        .expect("expected fully consumed structural branch");

    assert!(matches!(
        super::materialize_patch_add_ast_from_branch(input, branch),
        Some(CommandAst::PatchAdd(command))
            if matches!(command.source, PatchEndpointAst::Transport(_))
                && matches!(command.target, PatchEndpointAst::Fixture(_))
                && command.priority.is_some()
                && command.clone.is_some()
    ));
}

#[test]
fn strict_structural_dispatch_handles_patch_add_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch(
            "patch artnet:3.78 @ fix 311 prio 2 /clone",
        ),
        Some(CommandAst::PatchAdd(command))
            if matches!(command.source, PatchEndpointAst::Transport(_))
                && matches!(command.target, PatchEndpointAst::Fixture(_))
                && command.priority.is_some()
                && command.clone.is_some()
    ));
}

#[test]
fn strict_structural_dispatch_handles_rm_patch_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch(
            "rm patch artnet:3.78 @ fix 311 prio 2 /clone",
        ),
        Some(CommandAst::RmPatch(command))
            if command.source.is_some()
                && command.target.is_some()
                && command.priority.is_some()
                && command.clone.is_some()
    ));
}

#[test]
fn strict_structural_dispatch_handles_patch_passthrough_and_fixture_source_variants() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("patch sacn @ console"),
        Some(CommandAst::PatchAdd(command))
            if matches!(command.source, PatchEndpointAst::Transport(_))
                && matches!(command.target, PatchEndpointAst::Console(_))
    ));
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("patch fix 211>215 @ console:2"),
        Some(CommandAst::PatchAdd(command))
            if matches!(command.source, PatchEndpointAst::Fixture(_))
                && matches!(command.target, PatchEndpointAst::Console(_))
    ));
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("rm patch @ console:2"),
        Some(CommandAst::RmPatch(command))
            if command.source.is_none() && command.target.is_some()
    ));
}

/// Verifies `break N` on a fixture endpoint parses as a whole-fixture DMX break target.
#[test]
fn strict_structural_dispatch_handles_patch_fixture_break() {
    let Some(CommandAst::PatchAdd(command)) =
        super::materialize_strict_ast_from_structural_dispatch("patch fix 12 break 2 @ artnet:2.1")
    else {
        panic!("expected patch add command");
    };
    let PatchEndpointAst::Fixture(fixture) = &command.source else {
        panic!("expected fixture source");
    };
    let target = fixture.target.as_ref().expect("fixture target");
    assert_eq!(target.dmx_break.as_ref().map(|value| value.0), Some("2"));
    assert!(target.element.is_none() && target.param.is_none());
    assert!(matches!(command.target, PatchEndpointAst::Transport(_)));
}

#[test]
fn strict_structural_dispatch_handles_rm_general_object_branch() {
    assert_eq!(
        super::materialize_strict_ast_from_structural_dispatch("rm fixture 5"),
        parse_simple_general_object_commands("rm fixture 5")
    );
    assert_eq!(
        super::materialize_strict_ast_from_structural_dispatch("rm cue 1.1"),
        parse_simple_general_object_commands("rm cue 1.1")
    );
}

#[test]
fn strict_structural_dispatch_handles_clip_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("clip 1 goto 5"),
        Some(CommandAst::Clip(command))
            if matches!(command.action, PlaybackActionAst::Goto(5))
    ));
}

#[test]
fn strict_structural_dispatch_handles_clip_range_alias_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("clip 1>5 on"),
        Some(CommandAst::Clip(command))
            if matches!(command.action, PlaybackActionAst::On)
    ));
}

#[test]
fn strict_structural_dispatch_handles_timecode_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("timecode 3 pause"),
        Some(CommandAst::Timecode(command))
            if matches!(command.action, TimecodeActionAst::Pause)
    ));
}

#[test]
fn strict_structural_dispatch_handles_timeline_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("timeline 4 stop"),
        Some(CommandAst::Timeline(command))
            if matches!(command.action, StartStopAst::Stop)
    ));
}

#[test]
fn strict_structural_dispatch_handles_flow_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("flow 3 start"),
        Some(CommandAst::Flow(flow))
            if matches!(flow.action, FlowActionAst::Start)
    ));
    assert_eq!(
        super::materialize_strict_ast_from_structural_dispatch("flow 3 mv 7>9"),
        parse_simple_flow_command("flow 3 mv 7>9")
    );
}

#[test]
fn strict_structural_dispatch_handles_release_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("release attr red"),
        Some(CommandAst::General(GeneralCommandAst::Release(_)))
    ));
}

#[test]
fn strict_structural_dispatch_handles_release_fixture_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("release fix 1.1"),
        Some(CommandAst::General(GeneralCommandAst::Release(release)))
            if matches!(release.target, Some(ReleaseTargetAst::Fixture(_)))
    ));
}

#[test]
fn strict_structural_dispatch_handles_clear_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("clear fix 1 attr red"),
        Some(CommandAst::General(GeneralCommandAst::Clear(_)))
    ));
}

#[test]
fn strict_structural_dispatch_handles_channel_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("channel (1.1>1.5)+(2.1>2.5) @ 100",),
        Some(CommandAst::Channel(_))
    ));
}

#[test]
fn strict_structural_dispatch_handles_programmer_timing_chain_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fix 1 red @ 50 fade 3 delay 2"),
        Some(CommandAst::Attribute(command))
            if command.timings.as_ref().and_then(|timings| timings.fades.as_ref()).is_some()
                && command
                    .timings
                    .as_ref()
                    .and_then(|timings| timings.delays.as_ref())
                    .is_some()
    ));
}

/// Verifies explicit timing directions are captured by strict structural dispatch.
#[test]
fn strict_structural_dispatch_handles_programmer_timing_directions() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fix 1 red @ 50 fade in 3"),
        Some(CommandAst::Attribute(command))
            if command
                .timings
                .as_ref()
                .and_then(|timings| timings.fades.as_ref())
                .and_then(|fades| fades.direction)
                == Some(TimingDirectionAst::In)
    ));
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fix 1 red @ 50 fade out 3"),
        Some(CommandAst::Attribute(command))
            if command
                .timings
                .as_ref()
                .and_then(|timings| timings.fades.as_ref())
                .and_then(|fades| fades.direction)
                == Some(TimingDirectionAst::Out)
    ));
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fix 1 red @ 50 delay out 2"),
        Some(CommandAst::Attribute(command))
            if command
                .timings
                .as_ref()
                .and_then(|timings| timings.delays.as_ref())
                .and_then(|delays| delays.direction)
                == Some(TimingDirectionAst::Out)
    ));
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch(
            "fix 1 red @ 50 fade in 1 fade out 5"
        ),
        Some(CommandAst::Attribute(command))
            if command
                .timings
                .as_ref()
                .and_then(|timings| timings.fades.as_ref())
                .is_some_and(|fades| fades.direction == Some(TimingDirectionAst::In)
                    && fades.additional.len() == 1
                    && fades.additional[0].direction == Some(TimingDirectionAst::Out))
    ));
}

/// Verifies representative programmer fade syntax materializes through structural dispatch.
#[test]
fn strict_structural_dispatch_handles_programmer_fade_examples() {
    for input in [
        "fix 311>390 | blocks 2 red @ 100 fade 2",
        "fix 311>390 | blocks 2 red @ 100 fade 2 red 3",
        "fix 311>390 | blocks 2 red @ 100 fade red 3",
        "fix 311>390 | blocks 2 red @ 100 fade in 2s out 100ms",
        "fix 311>390 | blocks 2 red @ 100 fade in 1>5 out 0",
        "fix 311>390 | blocks 2 red @ 100 fade in 1 red 1>5 out 2s",
    ] {
        assert!(
            matches!(
                parse_strict(input),
                Ok(CommandAst::Attribute(command))
                    if command
                        .timings
                        .as_ref()
                        .and_then(|timings| timings.fades.as_ref())
                        .is_some()
            ),
            "expected fade timing AST for {input}"
        );
    }
}

#[test]
fn strict_structural_dispatch_handles_programmer_implicit_intensity_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fix 1 @ 50"),
        Some(CommandAst::Attribute(_))
    ));
}

#[test]
fn strict_structural_dispatch_handles_programmer_dynamic_attribute_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fix 311 zoom @ 100"),
        Some(CommandAst::Attribute(_))
    ));
}

#[test]
fn strict_structural_dispatch_handles_fixture_placement_tuple_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fix 1 3d rot (0,90,0)"),
        Some(CommandAst::FixturePlacement(command)) if command.actions.rotation.is_some()
    ));
}

#[test]
fn strict_structural_dispatch_handles_sleep_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("sleep 1.5sec"),
        Some(CommandAst::General(GeneralCommandAst::Sleep(command)))
            if command.duration.value.0 == "1.5"
                && command.duration.unit.map(|unit| unit.0) == Some("sec")
    ));
}

#[test]
fn strict_structural_dispatch_handles_fps_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("fps +120"),
        Some(CommandAst::General(GeneralCommandAst::SetFps(command)))
            if command.fps.0 == "+120"
    ));
}

#[test]
fn strict_structural_dispatch_handles_recall_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("recall cue 1.1"),
        Some(CommandAst::General(GeneralCommandAst::RecallCue(_)))
    ));
}

#[test]
fn strict_structural_dispatch_handles_store_general_object_branch() {
    assert_eq!(
        super::materialize_strict_ast_from_structural_dispatch("store cue 1.2"),
        parse_simple_general_object_commands("store cue 1.2")
    );
    assert_eq!(
        super::materialize_strict_ast_from_structural_dispatch("store g 1>3"),
        parse_simple_general_object_commands("store g 1>3")
    );
    assert_eq!(
        super::materialize_strict_ast_from_structural_dispatch("store fixture 1 offset int 50%",),
        super::parse_store_extended_command("store fixture 1 offset int 50%")
    );
    assert_eq!(
        super::materialize_strict_ast_from_structural_dispatch(
            "store fix 1 \"Acme\" \"Wash\" mode1",
        ),
        super::parse_store_extended_command("store fix 1 \"Acme\" \"Wash\" mode1")
    );
    assert_eq!(
        super::materialize_strict_ast_from_structural_dispatch("store fixture 1 offset red +30",),
        super::parse_store_extended_command("store fixture 1 offset red +30")
    );
    assert_eq!(
        super::materialize_strict_ast_from_structural_dispatch("store fixture 1 offset pan 25%",),
        super::parse_store_extended_command("store fixture 1 offset pan 25%")
    );
}

#[test]
fn strict_structural_dispatch_handles_log_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("log fix 1 red"),
        Some(CommandAst::General(GeneralCommandAst::Log(log)))
            if matches!(log.command, LogCommandAst::Fixture(_))
    ));
}

#[test]
fn strict_structural_dispatch_handles_log_level_clear_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("log level clear"),
        Some(CommandAst::General(GeneralCommandAst::Log(log)))
            if matches!(
                &log.command,
                LogCommandAst::Level(level) if level.level.0 == "clear"
            )
    ));
}

#[test]
fn strict_structural_dispatch_handles_log_filter_field_only_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("log filter myfield"),
        Some(CommandAst::General(GeneralCommandAst::Log(log)))
            if matches!(
                &log.command,
                LogCommandAst::Filter(filter)
                    if matches!(
                        &filter.filter,
                        LogFilterCommandAst::Set(set)
                            if set.field.name.0 == "myfield" && set.value.is_none()
                    )
            )
    ));
}

#[test]
fn strict_structural_dispatch_handles_debug_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("debug fixture 1"),
        Some(CommandAst::General(GeneralCommandAst::Debug(_)))
    ));
}

#[test]
fn strict_structural_dispatch_handles_rename_branch() {
    assert!(matches!(
        super::materialize_strict_ast_from_structural_dispatch("rename fixture 1 3"),
        Some(CommandAst::General(GeneralCommandAst::Rename(_)))
    ));
}

#[test]
fn strict_parser_handles_attribute_and_timing_commands_in_strict_mode() {
    assert!(matches!(
        parse_strict("fix 1 red @ 50 fade 3 delay 2"),
        Ok(CommandAst::Attribute(command))
            if command.timings.as_ref().and_then(|timings| timings.fades.as_ref()).is_some()
                && command
                    .timings
                    .as_ref()
                    .and_then(|timings| timings.delays.as_ref())
                    .is_some()
    ));
    assert!(matches!(
        parse_strict("red @ 100 fade 1"),
        Ok(CommandAst::ActiveSelectionAttribute(command))
            if command.timings.as_ref().and_then(|timings| timings.fades.as_ref()).is_some()
    ));
}

#[test]
fn strict_parser_handles_fixture_placement_commands_in_strict_mode() {
    assert!(matches!(
        parse_strict("fix 1 3d pos x 1 rot z 180"),
        Ok(CommandAst::FixturePlacement(command))
            if command.actions.position.is_some() && command.actions.rotation.is_some()
    ));
    assert!(matches!(
        parse_strict("fix 1 3d rot (0,90,0)"),
        Ok(CommandAst::FixturePlacement(command))
            if command.actions.rotation.is_some()
    ));
    assert!(matches!(
        parse_strict("fix 1 3d rot x 0 y 90 z 0"),
        Ok(CommandAst::FixturePlacement(command))
            if matches!(
                command.actions.rotation,
                Some(RotationActionAst {
                    value: RotationValueAst::AxisChain(ref axes),
                }) if axes.len() == 3
            )
    ));
}

#[test]
fn strict_parser_rejects_duplicate_axes_in_fixture_placement() {
    assert!(parse_strict("fix 1 3d pos x 1 x 2").is_err());
    assert!(parse_strict("fix 1 3d rot y 90 y 45").is_err());
}

#[test]
fn strict_parser_handles_fx_commands_in_strict_mode() {
    let incomplete_step_fx = "store fx 1 step group 14 5s red";
    assert!(parse_strict(incomplete_step_fx).is_err());
    let incomplete_tokens = lex_command(incomplete_step_fx);
    assert!(
        super::materialize_strict_ast_with_tokens(incomplete_step_fx, &incomplete_tokens).is_err()
    );
    assert!(matches!(
        parse_strict("fx 1 on"),
        Ok(CommandAst::Fx(command))
            if matches!(command.action, FxActionAst::Start)
    ));
    assert!(matches!(
        parse_strict("fx 1 rate 50"),
        Ok(CommandAst::Fx(command))
            if matches!(command.action, FxActionAst::SetRate(ref rate) if rate.value.0 == "50")
    ));
    assert!(matches!(
        parse_strict("store fx 1 step fix 1 50% int steps 100 0"),
        Ok(CommandAst::General(GeneralCommandAst::StoreStepFx(_)))
    ));
    assert!(parse_strict("fx 1 step fix 1 50% int steps 100 0").is_err());
}

/// Verifies structural object parsing preserves decimal cue references and ranged deletions.
#[test]
fn strict_parser_handles_structural_object_identifier_expressions() {
    for command in [
        "rename cue 1.5 2.10",
        "delete fixture 1>10",
        "delete fixture 1>5+10",
        "delete fixture 1>10-5",
        "delete fixture 1>5+10>12-3>4",
    ] {
        assert!(parse_strict(command).is_ok(), "failed to parse {command:?}");
    }
}

/// Verifies structural log parsing accepts level expressions and optional filter values.
#[test]
fn strict_parser_handles_structural_log_forms() {
    for command in [
        "log filter clear",
        "log filter myfield myvalue",
        "log level info",
        "log level nightfall=trace",
        "log level warn,foo=debug",
    ] {
        assert!(parse_strict(command).is_ok(), "failed to parse {command:?}");
    }
}

/// Verifies structural log filters reject tokens beyond the optional single value.
#[test]
fn strict_parser_rejects_extra_log_filter_values() {
    for command in ["log filter foo bar baz", "log filter clear extra"] {
        assert!(
            parse_strict(command).is_err(),
            "unexpectedly parsed {command:?}"
        );
    }
}

/// Verifies structural clear and release roots materialize without optional targets.
#[test]
fn strict_parser_handles_empty_and_simple_clear_release_forms() {
    for command in [
        "release",
        "clear",
        "clear selection",
        "clear selection values",
        "clear values selection",
        "clear selection selection",
    ] {
        assert!(parse_strict(command).is_ok(), "failed to parse {command:?}");
    }
}

/// Verifies a standalone clear attribute qualifier materializes as an attribute target.
#[test]
fn strict_structural_dispatch_materializes_clear_attribute_target() {
    let structural = super::materialize_strict_ast_from_structural_dispatch("clear attr red");

    assert!(
        matches!(
            structural,
            Some(CommandAst::General(GeneralCommandAst::Clear(ref clear)))
                if matches!(clear.targets.as_slice(), [ClearTargetAst::Attribute(_)])
        ),
        "unexpected structural AST: {structural:#?}"
    );
}

/// Verifies structural placement parsing retains decimal axis components.
#[test]
fn strict_parser_handles_decimal_fixture_placement() {
    for command in ["fix 1 3d pos x 1.5", "fix 1 3d pos x 1.5 y 2.0 z 3.5"] {
        assert!(parse_strict(command).is_ok(), "failed to parse {command:?}");
    }
}

/// Verifies legacy Blueprint type syntax is rejected while cue recall aliases remain valid.
#[test]
fn strict_parser_rejects_legacy_blueprint_types_and_handles_cue_recall_aliases() {
    for command in [
        "store blueprint 1 type attribute",
        "store bp 1 type attr",
        "store blueprint 1 type selective",
    ] {
        assert!(
            parse_strict(command).is_err(),
            "unexpectedly parsed {command:?}"
        );
    }
    assert!(parse_strict("recall c 1.5").is_ok());
}

#[test]
fn release_parser_supports_empty_and_dmx_targets() {
    assert!(matches!(
        parse_release_command("release"),
        Some(CommandAst::General(GeneralCommandAst::Release(release)))
            if release.target.is_none()
    ));
    assert!(matches!(
        parse_release_command("release ch 5.13>5.500+6.1"),
        Some(CommandAst::General(GeneralCommandAst::Release(release)))
            if matches!(
                release.target,
                Some(ReleaseTargetAst::Dmx(ref dmx))
                    if matches!(dmx.channels.head, ReleaseDmxChannelTermAst::Range(_))
            )
    ));
    assert!(matches!(
        parse_release_command("release channel 5."),
        Some(CommandAst::General(GeneralCommandAst::Release(release)))
            if matches!(
                release.target,
                Some(ReleaseTargetAst::Dmx(ref dmx))
                    if matches!(dmx.channels.head, ReleaseDmxChannelTermAst::Single(_))
            )
    ));
}

#[test]
fn release_parser_supports_fixture_and_attribute_targets() {
    assert!(matches!(
        parse_release_command("release f 1 attr red"),
        Some(CommandAst::General(GeneralCommandAst::Release(release)))
            if matches!(release.target, Some(ReleaseTargetAst::Fixture(_)))
    ));
    assert!(matches!(
        parse_release_command("release attr red blue"),
        Some(CommandAst::General(GeneralCommandAst::Release(release)))
            if matches!(release.target, Some(ReleaseTargetAst::Attribute(_)))
    ));
}

#[test]
fn clear_parser_supports_simple_targets() {
    assert!(matches!(
        parse_clear_command("clear"),
        Some(CommandAst::General(GeneralCommandAst::Clear(clear)))
            if clear.targets.is_empty()
    ));
    assert!(matches!(
        parse_clear_command("clear sel val"),
        Some(CommandAst::General(GeneralCommandAst::Clear(clear)))
            if clear.targets.len() == 2
                && matches!(clear.targets[0], ClearTargetAst::Selection(_))
                && matches!(clear.targets[1], ClearTargetAst::Values(_))
    ));
    assert!(matches!(
        parse_clear_command("clear fix 1 attr red"),
        Some(CommandAst::General(GeneralCommandAst::Clear(clear)))
            if clear.targets.len() == 1
                && matches!(clear.targets[0], ClearTargetAst::Fixture(_))
    ));
    assert!(matches!(
        parse_clear_command("clear attr red"),
        Some(CommandAst::General(GeneralCommandAst::Clear(clear)))
            if clear.targets.len() == 1
                && matches!(clear.targets[0], ClearTargetAst::Attribute(_))
    ));
}

#[test]
fn strict_parser_handles_complex_release_and_clear_targets_in_strict_mode() {
    assert!(parse_release_command("release fix 1.1").is_some());
    assert!(parse_clear_command("clear fix 1.1 attr red").is_some());
    assert!(parse_strict("release fix 1.1").is_ok());
    assert!(parse_strict("clear fix 1.1 attr red").is_ok());
}

#[test]
fn strict_parser_handles_fixture_element_selection_in_strict_mode() {
    assert!(parse_simple_selection_command("fix 133.1").is_some());
    assert!(parse_simple_selection_command("fix 1>3 .1").is_some());
    assert!(parse_strict("fix 133.1").is_ok());
}

/// Verifies block and unblock cue commands accept cue and cue-part targets.
#[test]
fn strict_parser_handles_block_and_unblock_cue_targets() {
    assert!(parse_strict("block cue 1.5").is_ok());
    assert!(parse_strict("block cue 1.5 /overwrite").is_ok());
    assert!(parse_strict("block cue 1.5p2").is_ok());
    assert!(parse_strict("block cue 1.5p2 /overwrite").is_ok());
    assert!(parse_strict("unblock cue 1.5").is_ok());
    assert!(parse_strict("unblock cue 1.5p2").is_ok());
}

/// Verifies cue tracking marker words are valid attribute value targets.
#[test]
fn strict_parser_handles_cue_tracking_marker_attribute_targets() {
    assert!(parse_strict("fix 311 red @ Release").is_ok());
    assert!(parse_strict("fix 311 red @ R").is_ok());
    assert!(parse_strict("fix 311 pan @ Hold").is_ok());
    assert!(parse_strict("fix 311 tilt @ H").is_ok());
}

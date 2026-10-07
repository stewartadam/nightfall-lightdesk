// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_cmd_parse::ast::*;
use nightfall_cmd_parse::generate_ast;

#[test]
fn test_clear_fixture_attr_ast() {
    let command_ast =
        generate_ast("clear fix 1>3 attr red blue").expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::General(GeneralCommandAst::Clear(clear_cmd)) => {
            assert_eq!(clear_cmd.targets.len(), 1);
            match &clear_cmd.targets[0] {
                ClearTargetAst::Fixture(target) => {
                    assert!(target.attributes.is_some(), "Expected attr qualifier");
                    let attrs = target
                        .attributes
                        .as_ref()
                        .map(|a| a.attributes.len())
                        .unwrap_or(0);
                    assert_eq!(attrs, 2, "Expected two attributes");
                }
                other => panic!("Expected fixture clear target, got {:?}", other),
            }
        }
        other => panic!("Expected clear command AST, got {:?}", other),
    }
}

#[test]
fn test_clear_attr_ast() {
    let command_ast = generate_ast("clear attr red").expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::General(GeneralCommandAst::Clear(clear_cmd)) => {
            assert_eq!(clear_cmd.targets.len(), 1);
            match &clear_cmd.targets[0] {
                ClearTargetAst::Attribute(target) => {
                    assert_eq!(
                        target.attributes.attributes.len(),
                        1,
                        "Expected one attribute"
                    );
                }
                other => panic!("Expected clear attr target, got {:?}", other),
            }
        }
        other => panic!("Expected clear command AST, got {:?}", other),
    }
}

#[test]
fn test_release_fixture_attr_ast() {
    let command_ast =
        generate_ast("release f 1 attr red").expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::General(GeneralCommandAst::Release(release_cmd)) => {
            let target = release_cmd.target.expect("Expected release target");
            match target {
                ReleaseTargetAst::Fixture(fixture_target) => {
                    assert!(
                        fixture_target.attributes.is_some(),
                        "Expected attr qualifier"
                    );
                }
                other => panic!("Expected release fixture target, got {:?}", other),
            }
        }
        other => panic!("Expected release command AST, got {:?}", other),
    }
}

#[test]
fn test_release_attr_ast() {
    let command_ast =
        generate_ast("release attr red blue").expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::General(GeneralCommandAst::Release(release_cmd)) => {
            let target = release_cmd.target.expect("Expected release target");
            match target {
                ReleaseTargetAst::Attribute(attribute_target) => {
                    assert_eq!(
                        attribute_target.attributes.attributes.len(),
                        2,
                        "Expected two attributes"
                    );
                }
                other => panic!("Expected release attr target, got {:?}", other),
            }
        }
        other => panic!("Expected release command AST, got {:?}", other),
    }
}

#[test]
fn test_release_channel_universe_shorthand_ast() {
    let command_ast = generate_ast("release ch 5.").expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::General(GeneralCommandAst::Release(release_cmd)) => {
            let target = release_cmd.target.expect("Expected release target");
            match target {
                ReleaseTargetAst::Dmx(dmx_target) => match &dmx_target.channels.head {
                    ReleaseDmxChannelTermAst::Single(single) => {
                        assert_eq!(single.channel.universe, 5);
                        assert_eq!(single.channel.address, None);
                    }
                    other => panic!("Expected single DMX term, got {:?}", other),
                },
                other => panic!("Expected release dmx target, got {:?}", other),
            }
        }
        other => panic!("Expected release command AST, got {:?}", other),
    }
}

#[test]
fn test_release_channel_mixed_expression_ast() {
    let command_ast =
        generate_ast("release channel 5.13>5.500+6.1").expect("Failed to parse and convert to AST");

    match command_ast {
        CommandAst::General(GeneralCommandAst::Release(release_cmd)) => {
            let target = release_cmd.target.expect("Expected release target");
            match target {
                ReleaseTargetAst::Dmx(dmx_target) => {
                    match &dmx_target.channels.head {
                        ReleaseDmxChannelTermAst::Range(range) => {
                            assert_eq!(range.start.channel.universe, 5);
                            assert_eq!(range.start.channel.address, Some(13));
                            assert_eq!(range.end.channel.universe, 5);
                            assert_eq!(range.end.channel.address, Some(500));
                        }
                        other => panic!("Expected range head term, got {:?}", other),
                    }
                    assert_eq!(dmx_target.channels.tail.len(), 1);
                    match &dmx_target.channels.tail[0].term {
                        ReleaseDmxChannelTermAst::Single(single) => {
                            assert_eq!(single.channel.universe, 6);
                            assert_eq!(single.channel.address, Some(1));
                        }
                        other => panic!("Expected single tail term, got {:?}", other),
                    }
                }
                other => panic!("Expected release dmx target, got {:?}", other),
            }
        }
        other => panic!("Expected release command AST, got {:?}", other),
    }
}

#[test]
fn test_release_channel_aliases() {
    let base_ast = generate_ast("release ch 5.13").expect("Failed to parse 'release ch 5.13'");
    let chan_ast = generate_ast("release chan 5.13").expect("Failed to parse 'release chan 5.13'");
    let channel_ast =
        generate_ast("release channel 5.13").expect("Failed to parse 'release channel 5.13'");

    assert_eq!(
        base_ast, chan_ast,
        "'ch' and 'chan' should parse identically"
    );
    assert_eq!(
        base_ast, channel_ast,
        "'ch' and 'channel' should parse identically"
    );
}

/// Verifies stale input release syntax parses as a release target.
#[test]
fn test_release_stale_inputs_ast() {
    let command_ast =
        generate_ast("release stale-inputs").expect("Failed to parse 'release stale-inputs'");

    match command_ast {
        CommandAst::General(GeneralCommandAst::Release(release_cmd)) => {
            assert!(matches!(
                release_cmd.target,
                Some(ReleaseTargetAst::StaleInputs)
            ));
        }
        other => panic!("Expected release command AST, got {:?}", other),
    }
}

#[test]
fn test_clear_aliases_for_new_qualifiers() {
    let clear_fix_ast =
        generate_ast("clear fix 1 attr red").expect("Failed to parse 'clear fix 1 attr red'");
    let clear_f_ast =
        generate_ast("clear f 1 attribute red").expect("Failed to parse 'clear f 1 attribute red'");

    assert_eq!(
        clear_fix_ast, clear_f_ast,
        "Fixture and attribute aliases should parse identically"
    );
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Canonical token inventory.

use crate::lexicon::aliases::canonicalize_alias_any_scope;
use crate::parser::analysis::TokenId;

/// Lexicon entry that binds a parser token to its display text and aliases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenSpec {
    pub id: TokenId,
    pub canonical: &'static str,
}

const TOKEN_SPECS: &[TokenSpec] = &[
    spec(TokenId::Pipe, "|"),
    spec(TokenId::Equals, "="),
    spec(TokenId::StepFx, "stepfx"),
    spec(TokenId::FxModule, "fxmodule"),
    spec(TokenId::Stale, "stale"),
    spec(TokenId::Inputs, "inputs"),
    spec(TokenId::Save, "save"),
    spec(TokenId::Load, "load"),
    spec(TokenId::New, "new"),
    spec(TokenId::Showfile, "showfile"),
    spec(TokenId::Help, "help"),
    spec(TokenId::Quit, "quit"),
    spec(TokenId::Undo, "undo"),
    spec(TokenId::Redo, "redo"),
    spec(TokenId::Block, "block"),
    spec(TokenId::Unblock, "unblock"),
    spec(TokenId::Overwrite, "/overwrite"),
    spec(TokenId::Set, "set"),
    spec(TokenId::Copy, "copy"),
    spec(TokenId::Label, "label"),
    spec(TokenId::Target, "target"),
    spec(TokenId::AtSign, "@"),
    spec(TokenId::DoubleAtSign, "@@"),
    spec(TokenId::Dot, "."),
    spec(TokenId::Colon, ":"),
    spec(TokenId::Tilde, "~"),
    spec(TokenId::Plus, "+"),
    spec(TokenId::Minus, "-"),
    spec(TokenId::GreaterThan, ">"),
    spec(TokenId::LeftParen, "("),
    spec(TokenId::RightParen, ")"),
    spec(TokenId::LeftBrace, "{"),
    spec(TokenId::RightBrace, "}"),
    spec(TokenId::Semicolon, ";"),
    spec(TokenId::Quote, "\""),
    spec(TokenId::Fixture, "fixture"),
    spec(TokenId::Group, "group"),
    spec(TokenId::Parameter, "parameter"),
    spec(TokenId::Fx, "fx"),
    spec(TokenId::Module, "module"),
    spec(TokenId::Step, "step"),
    spec(TokenId::Patch, "patch"),
    spec(TokenId::Channel, "channel"),
    spec(TokenId::Clip, "clip"),
    spec(TokenId::Flow, "flow"),
    spec(TokenId::Timecode, "timecode"),
    spec(TokenId::Timeline, "timeline"),
    spec(TokenId::Store, "store"),
    spec(TokenId::Rename, "rename"),
    spec(TokenId::Rm, "rm"),
    spec(TokenId::Clear, "clear"),
    spec(TokenId::Release, "release"),
    spec(TokenId::Recall, "recall"),
    spec(TokenId::Debug, "debug"),
    spec(TokenId::Sleep, "sleep"),
    spec(TokenId::Fps, "fps"),
    spec(TokenId::Log, "log"),
    spec(TokenId::Fade, "fade"),
    spec(TokenId::Delay, "delay"),
    spec(TokenId::In, "in"),
    spec(TokenId::Out, "out"),
    spec(TokenId::Start, "start"),
    spec(TokenId::Stop, "stop"),
    spec(TokenId::Pause, "pause"),
    spec(TokenId::Go, "go"),
    spec(TokenId::Back, "back"),
    spec(TokenId::Goto, "goto"),
    spec(TokenId::Rate, "rate"),
    spec(TokenId::Width, "width"),
    spec(TokenId::Ramp, "ramp"),
    spec(TokenId::Steps, "steps"),
    spec(TokenId::ThreeD, "3d"),
    spec(TokenId::Pos, "pos"),
    spec(TokenId::Rot, "rot"),
    spec(TokenId::X, "x"),
    spec(TokenId::Y, "y"),
    spec(TokenId::Z, "z"),
    spec(TokenId::Console, "console"),
    spec(TokenId::Sacn, "sacn"),
    spec(TokenId::Artnet, "artnet"),
    spec(TokenId::Udmx, "udmx"),
    spec(TokenId::Disabled, "disabled"),
    spec(TokenId::Intensity, "int"),
    spec(TokenId::Red, "red"),
    spec(TokenId::Green, "green"),
    spec(TokenId::Blue, "blue"),
    spec(TokenId::White, "white"),
    spec(TokenId::Attribute, "attribute"),
    spec(TokenId::Attr, "attr"),
    spec(TokenId::Type, "type"),
    spec(TokenId::Filter, "filter"),
    spec(TokenId::Values, "values"),
    spec(TokenId::Selected, "selected"),
    spec(TokenId::Blueprint, "blueprint"),
    spec(TokenId::Absolute, "/absolute"),
    spec(TokenId::Cue, "cue"),
    spec(TokenId::Sequence, "sequence"),
    spec(TokenId::Path, "path"),
    spec(TokenId::Level, "level"),
    spec(TokenId::Create, "create"),
];

const fn spec(id: TokenId, canonical: &'static str) -> TokenSpec {
    TokenSpec { id, canonical }
}

/// Returns the canonical token catalog used by parsing and completion.
pub fn token_specs() -> &'static [TokenSpec] {
    TOKEN_SPECS
}

/// Returns the canonical command words that can start a top-level command.
pub fn top_level_command_heads() -> &'static [&'static str] {
    static HEADS: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    HEADS
        .get_or_init(|| {
            use crate::slots::contracts::{ClauseEntryKind, clause_schema, command_grammar};
            command_grammar()
                .roots
                .iter()
                .flat_map(|root| match clause_schema(*root).entry {
                    ClauseEntryKind::RootCommandHead(heads) => heads,
                    _ => &[],
                })
                .filter_map(|head| canonical_text(*head))
                .collect()
        })
        .as_slice()
}

/// Returns whether the text exactly matches a canonical top-level command head.
pub fn is_exact_top_level_command_head(text: &str) -> bool {
    top_level_command_heads()
        .iter()
        .any(|head| head.eq_ignore_ascii_case(text))
}

/// Returns the canonical text emitted for a token ID.
pub fn canonical_text(token_id: TokenId) -> Option<&'static str> {
    token_specs()
        .iter()
        .find(|spec| spec.id == token_id)
        .map(|spec| spec.canonical)
}

/// Looks up a token ID by canonical text or any registered alias.
pub fn token_id_for_text(text: &str) -> Option<TokenId> {
    let lower = text.to_ascii_lowercase();
    if lower == "cp" {
        return Some(TokenId::Copy);
    }
    if lower == "none" {
        return Some(TokenId::Clear);
    }
    if lower == "?" {
        return Some(TokenId::Help);
    }
    if lower == "show" {
        return Some(TokenId::Showfile);
    }
    if let Some(token_id) = token_specs()
        .iter()
        .find(|spec| spec.canonical.eq_ignore_ascii_case(&lower))
        .map(|spec| spec.id)
    {
        return Some(token_id);
    }

    let canonical = canonicalize_alias_any_scope(&lower)?;
    token_specs()
        .iter()
        .find(|spec| spec.canonical == canonical)
        .map(|spec| spec.id)
}

#[cfg(test)]
mod tests {
    use super::{canonical_text, token_id_for_text};
    use crate::parser::analysis::TokenId;

    #[test]
    fn resolves_token_aliases_from_shared_alias_inventory() {
        assert_eq!(token_id_for_text("fix"), Some(TokenId::Fixture));
        assert_eq!(token_id_for_text("val"), Some(TokenId::Values));
        assert_eq!(token_id_for_text("selection"), Some(TokenId::Selected));
        assert_eq!(token_id_for_text("intensity"), Some(TokenId::Intensity));
    }

    #[test]
    fn prefers_canonical_text_before_alias_resolution() {
        assert_eq!(token_id_for_text("green"), Some(TokenId::Green));
        assert_eq!(canonical_text(TokenId::Green), Some("green"));
    }
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! AST converter for `tempo` command-line commands.

use nightfall_cmd_parse::ast;
use nightfall_engine::prelude::*;

use crate::TempoCommand;

/// Converts parsed `tempo` commands into tempo engine commands.
pub struct TempoAstConverter;

impl AstConvert for TempoAstConverter {
    /// Maps a parsed `tempo` command line to one validated engine command; other commands
    /// are left for their own converters.
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
        let ast::CommandAst::Tempo(tempo) = ast else {
            return Err(DispatchError::NotApplicable);
        };
        let command = tempo_command(&tempo.action)?;
        command
            .validate()
            .map_err(DispatchError::ConversionFailed)?;
        Ok(vec![Box::new(command)])
    }
}

/// Maps one parsed tempo action to its engine command, parsing numeric source text.
fn tempo_command(action: &ast::TempoActionAst) -> Result<TempoCommand, DispatchError> {
    Ok(match action {
        ast::TempoActionAst::SetBpm(bpm) => TempoCommand::SetBpm(parse_number(bpm.0, "tempo")?),
        ast::TempoActionAst::Tap => TempoCommand::Tap(None),
        ast::TempoActionAst::Resync => TempoCommand::Resync,
        ast::TempoActionAst::Snap => TempoCommand::Snap,
        ast::TempoActionAst::Half => TempoCommand::Multiply(0.5),
        ast::TempoActionAst::Double => TempoCommand::Multiply(2.0),
        ast::TempoActionAst::Nudge(beats) => TempoCommand::Nudge(parse_number(beats.0, "nudge")?),
        ast::TempoActionAst::BeatsPerBar(beats) => {
            TempoCommand::SetBeatsPerBar(beats.0.parse::<u8>().map_err(|_| {
                DispatchError::ConversionFailed(format!("invalid beats per bar '{}'", beats.0))
            })?)
        }
    })
}

/// Parses decimal source text, naming the field in the error.
fn parse_number(text: &str, field: &str) -> Result<f64, DispatchError> {
    text.parse::<f64>()
        .map_err(|_| DispatchError::ConversionFailed(format!("invalid {field} value '{text}'")))
}

#[cfg(test)]
mod tests {
    use nightfall_cmd_parse::generate_ast;

    use super::*;

    /// Parses and converts one command line, returning the tempo command it produced.
    fn convert(input: &str) -> Result<TempoCommand, DispatchError> {
        let ast =
            generate_ast(input).unwrap_or_else(|error| panic!("'{input}' should parse: {error:?}"));
        let mut payloads = TempoAstConverter::convert(&ast)?;
        assert_eq!(payloads.len(), 1);
        Ok(payloads
            .remove(0)
            .as_any()
            .downcast_ref::<TempoCommand>()
            .cloned()
            .expect("payload should be a tempo command"))
    }

    /// Verifies every command-line form maps to the matching engine command.
    #[test]
    fn converts_every_tempo_form() {
        assert_eq!(
            convert("tempo 128.5").ok(),
            Some(TempoCommand::SetBpm(128.5))
        );
        assert_eq!(convert("tempo tap").ok(), Some(TempoCommand::Tap(None)));
        assert_eq!(convert("tempo resync").ok(), Some(TempoCommand::Resync));
        assert_eq!(convert("tempo snap").ok(), Some(TempoCommand::Snap));
        assert_eq!(
            convert("tempo half").ok(),
            Some(TempoCommand::Multiply(0.5))
        );
        assert_eq!(
            convert("tempo double").ok(),
            Some(TempoCommand::Multiply(2.0))
        );
        assert_eq!(
            convert("tempo nudge -0.1").ok(),
            Some(TempoCommand::Nudge(-0.1))
        );
        assert_eq!(
            convert("tempo bar 3").ok(),
            Some(TempoCommand::SetBeatsPerBar(3))
        );
    }

    /// Verifies zero tempos and empty bars parse but are rejected on conversion.
    #[test]
    fn rejects_zero_values() {
        assert!(convert("tempo 0").is_err());
        assert!(convert("tempo bar 0").is_err());
    }
}

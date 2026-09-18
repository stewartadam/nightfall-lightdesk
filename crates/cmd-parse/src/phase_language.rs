// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Parser and canonical formatter for authored phase waypoint expressions.

use crate::ParseError;

/// Parses a non-empty `>`-delimited phase expression into unwrapped degree waypoints.
pub fn parse_phase_expression_text(input: &str) -> Result<Vec<f32>, ParseError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(ParseError::Failure(
            "phase expression cannot be empty".to_string(),
        ));
    }

    trimmed
        .split('>')
        .enumerate()
        .map(|(index, component)| {
            let component = component.trim();
            if !crate::parser::strict::exact_decimal_surface(component) {
                return Err(ParseError::Failure(format!(
                    "phase waypoint {} must be a decimal number",
                    index + 1
                )));
            }
            let value = component.parse::<f32>().map_err(|_| {
                ParseError::Failure(format!(
                    "phase waypoint {} is outside the supported numeric range",
                    index + 1
                ))
            })?;
            if !value.is_finite() {
                return Err(ParseError::Failure(format!(
                    "phase waypoint {} must be finite",
                    index + 1
                )));
            }
            Ok(value)
        })
        .collect()
}

/// Formats unwrapped degree waypoints as a canonical `>`-delimited phase expression.
pub fn format_phase_expression_degrees(waypoints: &[f32]) -> Result<String, ParseError> {
    if waypoints.is_empty() {
        return Err(ParseError::Failure(
            "phase expression requires at least one waypoint".to_string(),
        ));
    }
    if let Some(index) = waypoints.iter().position(|value| !value.is_finite()) {
        return Err(ParseError::Failure(format!(
            "phase waypoint {} must be finite",
            index + 1
        )));
    }

    Ok(waypoints
        .iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join(">"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies scalar and envelope syntax preserve authored waypoint structure.
    #[test]
    fn parses_scalar_and_multi_waypoint_phase_expressions() {
        assert_eq!(parse_phase_expression_text("180").unwrap(), vec![180.0]);
        assert_eq!(
            parse_phase_expression_text(" 0 > 360 > -90 ").unwrap(),
            vec![0.0, 360.0, -90.0]
        );
    }

    /// Verifies malformed and empty waypoint components are rejected.
    #[test]
    fn rejects_invalid_phase_expressions() {
        for input in ["", "0>", ">360", "0>>360", "0>phase"] {
            assert!(
                parse_phase_expression_text(input).is_err(),
                "{input:?} should be rejected"
            );
        }
    }

    /// Verifies formatting emits canonical syntax without expanding authored waypoints.
    #[test]
    fn formats_authored_waypoints_without_expansion() {
        assert_eq!(
            format_phase_expression_degrees(&[0.0, 360.0, 0.0]).unwrap(),
            "0>360>0"
        );
    }
}

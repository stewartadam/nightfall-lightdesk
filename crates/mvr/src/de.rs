// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Serde helpers for MVR's text-encoded values.
//!
//! Exporters disagree on empty values: some omit a node, others write it empty
//! (`<FixtureID></FixtureID>`, `<GDTFSpec/>`). Every optional helper here treats an empty
//! or whitespace-only value like a missing one, and rejects text that is present but
//! malformed so a broken file fails loudly instead of losing data.

use std::fmt::Display;
use std::str::FromStr;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer};
use uuid::Uuid;

use crate::transform::Transform;
use crate::values::{CieColor, parse_bool, parse_uuid};

/// Reads an optional text value, trimming it and mapping empty text to `None`.
fn trimmed<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
    let text = Option::<String>::deserialize(deserializer)?;
    Ok(text
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty()))
}

/// Reads a mandatory `uuid` attribute, failing when it is missing or not a UUID.
pub(crate) fn uuid<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Uuid, D::Error> {
    let text = String::deserialize(deserializer)?;
    parse_uuid(&text).ok_or_else(|| D::Error::custom(format!("invalid UUID {text:?}")))
}

/// Reads an optional UUID reference such as `Classing`, `Position` or `Focus`.
///
/// The nil UUID is not a valid MVR identifier, and exporters write it to mean "no
/// reference", so it reads as `None`.
pub(crate) fn opt_uuid<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Uuid>, D::Error> {
    let uuid = trimmed(deserializer)?
        .map(|text| {
            parse_uuid(&text).ok_or_else(|| D::Error::custom(format!("invalid UUID {text:?}")))
        })
        .transpose()?;
    Ok(uuid.filter(|uuid| !uuid.is_nil()))
}

/// Reads optional free text, such as a file name or fixture ID, without its surrounding
/// whitespace.
pub(crate) fn opt_text<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    trimmed(deserializer)
}

/// Reads an optional integer written in base 10.
pub(crate) fn opt_int<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: FromStr,
    T::Err: Display,
{
    trimmed(deserializer)?
        .map(|text| {
            text.parse()
                .map_err(|error| D::Error::custom(format!("invalid integer {text:?}: {error}")))
        })
        .transpose()
}

/// Reads an optional boolean.
pub(crate) fn opt_bool<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<bool>, D::Error> {
    trimmed(deserializer)?
        .map(|text| {
            parse_bool(&text).ok_or_else(|| D::Error::custom(format!("invalid boolean {text:?}")))
        })
        .transpose()
}

/// Reads an optional `Matrix` node.
pub(crate) fn opt_matrix<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Transform>, D::Error> {
    trimmed(deserializer)?
        .map(|text| {
            Transform::parse(&text)
                .ok_or_else(|| D::Error::custom(format!("invalid matrix {text:?}")))
        })
        .transpose()
}

/// Reads an optional CIE xyY `Color` node.
pub(crate) fn opt_color<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<CieColor>, D::Error> {
    trimmed(deserializer)?
        .map(|text| {
            CieColor::parse(&text)
                .ok_or_else(|| D::Error::custom(format!("invalid color {text:?}")))
        })
        .transpose()
}

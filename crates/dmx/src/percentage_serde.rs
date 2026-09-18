// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Serde adapter for serializing `Percentage` as f64.

use serde_with::{DeserializeAs, SerializeAs};

use crate::Percentage;

/// Serde adapter that serializes [`Percentage`] as an f64.
///
/// Use with `#[serde_as(as = "PercentageAsF64")]` on fields.
pub struct PercentageAsF64;

impl SerializeAs<Percentage> for PercentageAsF64 {
    fn serialize_as<S>(value: &Percentage, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_f64(value.as_f64())
    }
}

impl<'de> DeserializeAs<'de, Percentage> for PercentageAsF64 {
    fn deserialize_as<D>(deserializer: D) -> Result<Percentage, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let f: f64 = serde::Deserialize::deserialize(deserializer)?;
        Ok(Percentage::from(f))
    }
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};
    use serde_with::serde_as;

    use super::*;

    /// Serde test fixture used to verify percentage encoding and decoding.
    #[serde_as]
    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    struct TestStruct {
        #[serde_as(as = "PercentageAsF64")]
        value: Percentage,
    }

    #[test]
    fn serialize_percentage_as_f64() {
        let test = TestStruct {
            value: Percentage::from(0.5),
        };
        let json = serde_json::to_string(&test).unwrap();
        assert_eq!(json, r#"{"value":0.5}"#);
    }

    #[test]
    fn deserialize_f64_as_percentage() {
        let json = r#"{"value":0.75}"#;
        let test: TestStruct = serde_json::from_str(json).unwrap();
        assert_eq!(test.value, Percentage::from(0.75));
    }

    #[test]
    fn roundtrip() {
        let original = TestStruct {
            value: Percentage::from(0.333),
        };
        let json = serde_json::to_string(&original).unwrap();
        let parsed: TestStruct = serde_json::from_str(&json).unwrap();
        assert_eq!(original, parsed);
    }
}

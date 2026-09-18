// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! A fixture is a physical device that can be controlled by the lighting desk.
use nightfall::prelude::*;
use serde::{Deserialize, Serialize};

use crate::physical::FixturePhysical;
use crate::placement::FixturePlacement;
use crate::prelude::*;

/// Logical representation for a physical lighting fixture.
///
/// This struct contains user-configured fixture data that is serialized and persisted.
/// Geometry data for 3D visualization is provided separately via `FixtureGeometry`.
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct Fixture {
    /// Identifiers for the fixture
    pub identifiers: Identifiers,
    /// Name of the fixture manufacturer
    pub make: String,
    /// Fixture model
    pub model: String,
    /// Explicit rendering and element wiring layout, independent of display names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<FixtureLayout>,
    /// DMX mode name (used to look up geometry from library)
    pub mode: String,
    /// List of controllable elements available for the fixture.
    pub elements: Vec<FixtureElement>,
    /// Physical beam characteristics for visualizer rendering
    #[serde(default)]
    pub physical: Option<FixturePhysical>,
    /// 3D position and rotation for visualizer rendering
    #[serde(default)]
    pub placement: FixturePlacement,
    /// Optional fixture library content ETag fingerprint
    #[serde(default)]
    pub library_asset_etag: Option<String>,
}
impl HasIdentifiers for Fixture {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

/// Elements are controllable sub-components of a fixture, sometimes known as
/// segments or sub-fixtures in other desks.
///
/// Most older fixtures only have a single element, but modern LED fixtures and
/// light bars typically have several individually controllable segments.
#[derive(Default, Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FixtureElement {
    /// Label for the element
    pub label: String,
    /// Parameters available for the element
    pub parameters: Vec<ParameterMetadata>,
}

/// Built-in physical layouts with defined visualization and DMX element ordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "kebab-case")]
pub enum FixtureLayout {
    /// Linear row of independently colored segments.
    LedBar,
    /// Moving head with a single emitter.
    MovingHead,
    /// Tilting matrix with RGB pixels and white strobe segments.
    StrobeMatrix,
    /// Bar with 24 white and 48 RGB segments in hardware wiring order.
    RgbStrobeBar,
    /// Twelve rotating beams with two decorative twelve-segment strips.
    RotatingWashBeam,
    /// Ten rotating RGBW segments without decorative strips.
    LinearWashBar,
}

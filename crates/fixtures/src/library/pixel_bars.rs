// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Explicit built-in profiles for generic pixel bars and pixel tape.

use nightfall::prelude::Identifiers;
use nightfall_dmx::DmxValueResolution;
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use uuid::Uuid;

use crate::prelude::*;

/// Creates an RGBW bar fixture with 12 elements.
///
/// Each element has VirtualIntensity, Red, Green, Blue, White parameters.
pub(super) fn create_rgbw_bar_12(id: u32, make: &str, model: &str) -> Fixture {
    let parameters = vec![
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::VirtualIntensity,
            native_unit: Attribute::VirtualIntensity.native_unit(),
            value_polarity: Attribute::VirtualIntensity.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::HTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: true,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Red,
            native_unit: Attribute::Red.native_unit(),
            value_polarity: Attribute::Red.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Green,
            native_unit: Attribute::Green.native_unit(),
            value_polarity: Attribute::Green.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Blue,
            native_unit: Attribute::Blue.native_unit(),
            value_polarity: Attribute::Blue.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::White,
            native_unit: Attribute::White.native_unit(),
            value_polarity: Attribute::White.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
    ];

    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(), // Built-in fixture, no library mode
        elements: (1..=12)
            .map(|i| FixtureElement {
                label: format!("Pixel {}", i),
                parameters: parameters.clone(),
            })
            .collect(),
        physical: None,
        placement: FixturePlacement::default(),
        layout: Some(FixtureLayout::LedBar),
        library_asset_etag: None,
    }
}

/// Creates an RGB bar fixture with 60 elements.
///
/// Each element has VirtualIntensity, Red, Green, Blue parameters.
pub(super) fn create_rgb_bar_60(id: u32, make: &str, model: &str) -> Fixture {
    let parameters = vec![
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::VirtualIntensity,
            native_unit: Attribute::VirtualIntensity.native_unit(),
            value_polarity: Attribute::VirtualIntensity.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::HTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: true,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Red,
            native_unit: Attribute::Red.native_unit(),
            value_polarity: Attribute::Red.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Green,
            native_unit: Attribute::Green.native_unit(),
            value_polarity: Attribute::Green.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Blue,
            native_unit: Attribute::Blue.native_unit(),
            value_polarity: Attribute::Blue.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
    ];

    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(), // Built-in fixture, no library mode
        elements: (1..=60)
            .map(|i| FixtureElement {
                label: format!("Pixel {}", i),
                parameters: parameters.clone(),
            })
            .collect(),
        physical: None,
        placement: FixturePlacement::default(),
        layout: Some(FixtureLayout::LedBar),
        library_asset_etag: None,
    }
}

/// Creates a GRB pixel tape fixture with 40 elements.
///
/// Each element has VirtualIntensity, Green, Red, Blue parameters so its non-virtual
/// DMX footprint follows the hardware GRB channel order.
pub(super) fn create_grb_bar_40(id: u32, make: &str, model: &str) -> Fixture {
    let parameters = vec![
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::VirtualIntensity,
            native_unit: Attribute::VirtualIntensity.native_unit(),
            value_polarity: Attribute::VirtualIntensity.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::HTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: true,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Green,
            native_unit: Attribute::Green.native_unit(),
            value_polarity: Attribute::Green.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Red,
            native_unit: Attribute::Red.native_unit(),
            value_polarity: Attribute::Red.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Blue,
            native_unit: Attribute::Blue.native_unit(),
            value_polarity: Attribute::Blue.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
    ];

    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(),
        elements: (1..=40)
            .map(|i| FixtureElement {
                label: format!("Pixel {}", i),
                parameters: parameters.clone(),
            })
            .collect(),
        physical: None,
        placement: FixturePlacement::default(),
        layout: Some(FixtureLayout::LedBar),
        library_asset_etag: None,
    }
}

/// Creates a RGB pixel tape fixture with 40 elements.
///
/// Each element has VirtualIntensity, Red, Green, Blue parameters so its non-virtual
/// DMX footprint follows the hardware RGB channel order.
pub(super) fn create_rgb_bar_40(id: u32, make: &str, model: &str) -> Fixture {
    let parameters = vec![
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::VirtualIntensity,
            native_unit: Attribute::VirtualIntensity.native_unit(),
            value_polarity: Attribute::VirtualIntensity.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::HTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: true,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Red,
            native_unit: Attribute::Red.native_unit(),
            value_polarity: Attribute::Red.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Green,
            native_unit: Attribute::Green.native_unit(),
            value_polarity: Attribute::Green.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
        ParameterMetadata {
            dmx_slots: Default::default(),
            functions: Vec::new(),
            default_dmx: None,
            highlight_dmx: None,
            attribute: Attribute::Blue,
            native_unit: Attribute::Blue.native_unit(),
            value_polarity: Attribute::Blue.value_polarity(),
            is_inverted: false,
            is_snap: false,
            max: 255.0,
            offset: ParameterValue::Absolute { value: 0.0 },
            merge_type: MergeStrategy::LTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
    ];

    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(),
        elements: (1..=40)
            .map(|i| FixtureElement {
                label: format!("Pixel {}", i),
                parameters: parameters.clone(),
            })
            .collect(),
        physical: None,
        placement: FixturePlacement::default(),
        layout: Some(FixtureLayout::LedBar),
        library_asset_etag: None,
    }
}

/// Creates a hundred independently controllable RGB segments for the sample stage.
pub(super) fn create_rgb_bar_100(id: u32, make: &str, model: &str) -> Fixture {
    let mut fixture = create_rgb_bar_60(id, make, model);
    let segment = fixture.elements[0].clone();
    fixture.elements = (1..=100)
        .map(|index| FixtureElement {
            label: format!("Segment {index}"),
            ..segment.clone()
        })
        .collect();
    fixture
}

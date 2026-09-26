// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Explicit built-in profiles for Generic strobe fixtures.

use nightfall::prelude::Identifiers;
use nightfall_dmx::DmxValueResolution;
use nightfall_dmx::prelude::{Attribute, ParameterUnit, ParameterValue};
use uuid::Uuid;

use crate::prelude::*;

/// Creates the 308-channel strobe matrix, which has 16 white segments.
pub(super) fn create_strobe_matrix_308(id: u32, make: &str, model: &str) -> Fixture {
    create_strobe(id, make, model, 16)
}

/// Creates the 312-channel strobe matrix, which has 20 white segments.
pub(super) fn create_strobe_matrix_312(id: u32, make: &str, model: &str) -> Fixture {
    create_strobe(id, make, model, 20)
}

/// Creates a strobe fixture with 96 RGB pixels and the requested white segment count.
///
/// The hardware control prefix is Tilt, Rotation Speed, and Reset. Tilt uses
/// coarse and fine DMX slots, so the non-emitter prefix occupies four slots.
pub(super) fn create_strobe(
    id: u32,
    make: &str,
    model: &str,
    white_segment_count: usize,
) -> Fixture {
    let vdim_parameter = ParameterMetadata {
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
    };

    let rgb_parameters = vec![
        vdim_parameter.clone(),
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

    let white_dimmer_parameters = vec![
        vdim_parameter,
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
            merge_type: MergeStrategy::HTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
    ];

    let tilt_parameter = ParameterMetadata {
        dmx_slots: Default::default(),
        functions: Vec::new(),
        default_dmx: None,
        highlight_dmx: None,
        attribute: Attribute::Tilt,
        native_unit: Attribute::Tilt.native_unit(),
        value_polarity: Attribute::Tilt.value_polarity(),
        is_inverted: false,
        is_snap: false,
        max: 270.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        merge_type: MergeStrategy::LTP,
        min: 0.0,
        resolution: DmxValueResolution::Fine,
        use_grandmaster: false,
    };

    let rotation_speed_parameter = ParameterMetadata {
        dmx_slots: Default::default(),
        functions: Vec::new(),
        default_dmx: None,
        highlight_dmx: None,
        attribute: Attribute::Custom {
            label: "Rotation Speed".to_owned(),
        },
        native_unit: ParameterUnit::Percent,
        value_polarity: ParameterValuePolarity::Unsigned,
        is_inverted: false,
        is_snap: false,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        merge_type: MergeStrategy::LTP,
        min: 0.0,
        resolution: DmxValueResolution::Coarse,
        use_grandmaster: false,
    };

    let reset_parameter = ParameterMetadata {
        dmx_slots: Default::default(),
        functions: Vec::new(),
        default_dmx: None,
        highlight_dmx: None,
        attribute: Attribute::Custom {
            label: "Reset".to_owned(),
        },
        native_unit: ParameterUnit::Percent,
        value_polarity: ParameterValuePolarity::Unsigned,
        is_inverted: false,
        is_snap: true,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        merge_type: MergeStrategy::LTP,
        min: 0.0,
        resolution: DmxValueResolution::Coarse,
        use_grandmaster: false,
    };

    let mut elements = Vec::with_capacity(96 + white_segment_count + 3);

    elements.push(FixtureElement {
        label: "Tilt Axis".to_owned(),
        parameters: vec![tilt_parameter],
    });
    elements.push(FixtureElement {
        label: "Rotation Speed".to_owned(),
        parameters: vec![rotation_speed_parameter],
    });
    elements.push(FixtureElement {
        label: "Reset".to_owned(),
        parameters: vec![reset_parameter],
    });

    for i in 1..=white_segment_count {
        elements.push(FixtureElement {
            label: format!("Strobe Dimmer {}", i),
            parameters: white_dimmer_parameters.clone(),
        });
    }

    for i in 1..=96 {
        elements.push(FixtureElement {
            label: format!("RGB Pixel {}", i),
            parameters: rgb_parameters.clone(),
        });
    }

    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(), // Built-in fixture, no library mode
        elements,
        physical: None,
        placement: FixturePlacement::default(),
        layout: Some(FixtureLayout::StrobeMatrix),
        library_asset_etag: None,
    }
}

/// Creates a Generic RGB Strobe Bar profile with 24 white segments and 48 RGB segments.
///
/// Elements are ordered for selection as white left-to-right, top RGB left-to-right,
/// then bottom RGB left-to-right.
/// in 16ch mode strobe goes from 0-8=full 9=34.7bpm, 15=43.08bpm 23=55.5bpm 31=70.78bpm 64=147.7bpm 128=257.3bpm 192=465bpm (~7.8hz)
pub(super) fn create_rgb_strobe_bar_168(id: u32, make: &str, model: &str) -> Fixture {
    let vdim_parameter = ParameterMetadata {
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
    };

    let rgb_parameters = vec![
        vdim_parameter.clone(),
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

    let white_parameters = vec![
        vdim_parameter,
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
            merge_type: MergeStrategy::HTP,
            min: 0.0,
            resolution: DmxValueResolution::Coarse,
            use_grandmaster: false,
        },
    ];

    let mut elements = Vec::with_capacity(72);

    for i in 1..=24 {
        elements.push(FixtureElement {
            label: format!("White Segment {}", i),
            parameters: white_parameters.clone(),
        });
    }

    for i in 1..=24 {
        elements.push(FixtureElement {
            label: format!("Top RGB Segment {}", i),
            parameters: rgb_parameters.clone(),
        });
    }

    for i in 1..=24 {
        elements.push(FixtureElement {
            label: format!("Bottom RGB Segment {}", i),
            parameters: rgb_parameters.clone(),
        });
    }

    Fixture {
        identifiers: Identifiers {
            id,
            uid: Uuid::new_v4(),
            ..Default::default()
        },
        make: make.to_owned(),
        model: model.to_owned(),
        mode: String::new(), // Built-in fixture, no library mode
        elements,
        physical: None,
        placement: FixturePlacement::default(),
        layout: Some(FixtureLayout::RgbStrobeBar),
        library_asset_etag: None,
    }
}

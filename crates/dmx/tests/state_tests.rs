// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Exact mutable channel state without parser or application dependencies.

use std::sync::Arc;

use nightfall_dmx::state::{RawChannelLayout, RawChannelSpec};

/// Mix physical and virtual channels with optional highlights and different precision.
fn layout() -> Arc<RawChannelLayout> {
    Arc::new(
        RawChannelLayout::new(vec![
            RawChannelSpec {
                bytes: 4,
                default: u32::MAX - 1,
                highlight: Some(u32::MAX),
                physical: true,
            },
            RawChannelSpec {
                bytes: 1,
                default: 80,
                highlight: None,
                physical: false,
            },
            RawChannelSpec {
                bytes: 2,
                default: 1234,
                highlight: Some(65535),
                physical: true,
            },
        ])
        .unwrap(),
    )
}

/// Fixtures share validated rules while updates, cloning and highlight leave other instances unchanged.
#[test]
fn instance_values_and_temporary_highlights_are_independent() {
    let layout = layout();
    let mut first = layout.new_state();
    let second = layout.new_state();
    assert!(Arc::ptr_eq(first.layout(), second.layout()));
    first.set_many(&[(0, 16777217), (1, 42)]).unwrap();
    assert_eq!(first.snapshot(true), [u32::MAX, 42, 65535]);
    assert_eq!(first.snapshot(false), [16777217, 42, 1234]);
    assert_eq!(second.values(), [u32::MAX - 1, 80, 1234]);
    let mut cloned = first.clone();
    cloned.set_many(&[(2, 5)]).unwrap();
    assert_eq!(first.values()[2], 1234);
    assert_eq!(cloned.values()[2], 5);
    first.reset();
    assert_eq!(first.values(), second.values());
}

/// Incoming wire data retains virtual programming and omitted physical values without clamping.
#[test]
fn input_updates_preserve_unwired_values_and_exact_32_bit_steps() {
    let mut state = layout().new_state();
    state.set_many(&[(1, 128)]).unwrap();
    state.apply_input(&[Some(0xabcdef01), None, None]).unwrap();
    assert_eq!(state.values(), [0xabcdef01, 128, 1234]);
    state
        .apply_input(&[Some(u32::MAX), None, Some(65535)])
        .unwrap();
    assert_eq!(state.values(), [u32::MAX, 128, 65535]);
}

/// Invalid later updates cannot change earlier values, whether supplied by operators or wire input.
#[test]
fn invalid_batches_are_rejected_before_any_state_change() {
    let mut state = layout().new_state();
    let original = state.values().to_vec();
    for (updates, code) in [
        (vec![(0, 1), (2, 65536)], "raw_value_out_of_range"),
        (vec![(0, 1), (3, 0)], "invalid_channel_index"),
        (vec![(1, 256)], "raw_value_out_of_range"),
    ] {
        assert_eq!(state.set_many(&updates).unwrap_err().code, code);
        assert_eq!(state.values(), original);
    }
    for (input, code) in [
        (vec![Some(1), None, Some(65536)], "raw_value_out_of_range"),
        (vec![Some(1), Some(0), None], "virtual_channel_input"),
        (vec![Some(1)], "channel_count_mismatch"),
    ] {
        assert_eq!(state.apply_input(&input).unwrap_err().code, code);
        assert_eq!(state.values(), original);
    }
    state.set_many(&[(0, 1), (0, 2)]).unwrap();
    assert_eq!(state.values()[0], 2);
}

/// Layout construction rejects invalid precision and metadata at every supported byte width.
#[test]
fn layout_validates_defaults_and_highlights_before_creating_state() {
    for bytes in [0, 5, u8::MAX] {
        let spec = RawChannelSpec {
            bytes,
            default: 0,
            highlight: None,
            physical: false,
        };
        assert_eq!(
            RawChannelLayout::new(vec![spec]).unwrap_err().code,
            "invalid_channel_width"
        );
    }
    for bytes in 1..=4 {
        let maximum = u32::MAX >> (32 - u32::from(bytes) * 8);
        let spec = RawChannelSpec {
            bytes,
            default: maximum,
            highlight: Some(maximum),
            physical: true,
        };
        let layout = Arc::new(RawChannelLayout::new(vec![spec]).unwrap());
        assert_eq!(layout.new_state().snapshot(true), [maximum]);
        if bytes < 4 {
            for invalid in [
                RawChannelSpec {
                    default: maximum + 1,
                    ..spec
                },
                RawChannelSpec {
                    highlight: Some(maximum + 1),
                    ..spec
                },
            ] {
                let error = RawChannelLayout::new(vec![spec, invalid]).unwrap_err();
                assert_eq!(error.code, "raw_value_out_of_range");
                assert_eq!(error.channel, Some(1));
            }
        }
    }
}

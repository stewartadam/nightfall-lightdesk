// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Independent expected byte layouts for explicit break patches.

use std::collections::BTreeMap;

use nightfall_dmx::patch::BreakPatch;
use nightfall_dmx::wire::{ChannelWire, ModeWires};

/// Build a sparse two-break mode with a virtual channel between physical channels.
fn mode() -> ModeWires {
    ModeWires {
        channels: vec![
            Some(ChannelWire {
                dmx_break: 7,
                offsets: vec![4, 1],
            }),
            None,
            Some(ChannelWire {
                dmx_break: 11,
                offsets: vec![4, 1, 3, 2],
            }),
        ],
        footprints: BTreeMap::from([(7, 4), (11, 4)]),
    }
}

/// Build deliberately nonsequential universe placements; neither universe matches a break number.
fn breaks() -> BTreeMap<u32, BreakPatch> {
    BTreeMap::from([
        (
            7,
            BreakPatch {
                universe: 20,
                address: 100,
            },
        ),
        (
            11,
            BreakPatch {
                universe: 3,
                address: 509,
            },
        ),
    ])
}

/// Sparse significance and independent universes survive exact whole-mode byte input and output.
#[test]
fn patches_keep_breaks_virtual_indices_and_sparse_byte_order() {
    let patch = mode().patch(&breaks()).unwrap();
    assert_eq!(
        patch.channels()[0].as_ref().unwrap().wire().offsets,
        [103, 100]
    );
    assert!(patch.channels()[1].is_none());
    assert_eq!(patch.channels()[2].as_ref().unwrap().universe(), 3);
    assert_eq!(
        patch.channels()[2].as_ref().unwrap().wire().offsets,
        [512, 509, 511, 510]
    );
    let mut buffers = BTreeMap::from([(20, [0xee; 512]), (3, [0xee; 512])]);
    patch
        .write_raw(&[0xabcd, u32::MAX, 0xabcdef01], &mut buffers)
        .unwrap();
    let mut expected_20 = [0xee; 512];
    expected_20[99] = 0xcd;
    expected_20[102] = 0xab;
    let mut expected_3 = [0xee; 512];
    expected_3[508..].copy_from_slice(&[0xcd, 0x01, 0xef, 0xab]);
    assert_eq!(
        buffers,
        BTreeMap::from([(20, expected_20), (3, expected_3)])
    );
    assert_eq!(
        patch.read_raw(&buffers).unwrap(),
        [Some(0xabcd), None, Some(0xabcdef01)]
    );
}

/// Every invalid placement is rejected, including stale maps and implicit rollover attempts.
#[test]
fn patch_rejects_missing_unused_colliding_and_out_of_bounds_breaks() {
    for (break_id, replacement, expected) in [
        (7, None, "missing_break_patch"),
        (
            7,
            Some(BreakPatch {
                universe: 20,
                address: 0,
            }),
            "invalid_patch_address",
        ),
        (
            7,
            Some(BreakPatch {
                universe: 20,
                address: 513,
            }),
            "invalid_patch_address",
        ),
        (
            11,
            Some(BreakPatch {
                universe: 3,
                address: 510,
            }),
            "patch_out_of_bounds",
        ),
        (
            11,
            Some(BreakPatch {
                universe: 20,
                address: 100,
            }),
            "patch_collision",
        ),
        (
            99,
            Some(BreakPatch {
                universe: 1,
                address: 1,
            }),
            "unused_break_patch",
        ),
    ] {
        let mut bindings = breaks();
        bindings.remove(&break_id);
        if let Some(replacement) = replacement {
            bindings.insert(break_id, replacement);
        }
        assert_eq!(mode().patch(&bindings).unwrap_err().code, expected);
    }
}

/// Public/deserialized contracts cannot bypass width, footprint or channel collision validation.
#[test]
fn patch_revalidates_untrusted_mode_contracts() {
    let original = mode();
    for (offsets, expected) in [
        (vec![], "invalid_channel_width"),
        (vec![0], "invalid_offset"),
        (vec![1, 1], "duplicate_byte"),
        (vec![513], "wire_buffer_too_short"),
        (vec![u32::MAX], "wire_buffer_too_short"),
    ] {
        let mut mode = original.clone();
        mode.channels[0].as_mut().unwrap().offsets = offsets;
        assert_eq!(mode.patch(&breaks()).unwrap_err().code, expected);
    }
    let mut mode = original.clone();
    mode.footprints.insert(7, 3);
    assert_eq!(
        mode.patch(&breaks()).unwrap_err().code,
        "invalid_footprints"
    );
    let mut mode = original;
    mode.channels.push(mode.channels[0].clone());
    assert_eq!(mode.patch(&breaks()).unwrap_err().code, "patch_collision");
}

/// A bad later value or absent universe cannot partially write an earlier valid channel.
#[test]
fn whole_mode_writes_validate_before_mutating_any_universe() {
    let patch = mode().patch(&breaks()).unwrap();
    let original = BTreeMap::from([(20, [0x77; 512]), (3, [0x55; 512])]);
    for (values, expected) in [
        (vec![0x10000, 0, 10], "raw_value_out_of_range"),
        (vec![1, 2], "channel_count_mismatch"),
    ] {
        let mut buffers = original.clone();
        assert_eq!(
            patch.write_raw(&values, &mut buffers).unwrap_err().code,
            expected
        );
        assert_eq!(buffers, original);
    }
    let mut buffers = BTreeMap::from([(20, [0x77; 512])]);
    let original = buffers.clone();
    assert_eq!(
        patch.write_raw(&[1, 0, 2], &mut buffers).unwrap_err().code,
        "missing_universe"
    );
    assert_eq!(buffers, original);
    assert_eq!(
        patch.read_raw(&buffers).unwrap_err().code,
        "missing_universe"
    );
    let mut reversed = mode();
    reversed.channels.reverse();
    let patch = reversed.patch(&breaks()).unwrap();
    let original = BTreeMap::from([(20, [0x77; 512]), (3, [0x55; 512])]);
    let mut buffers = original.clone();
    assert_eq!(
        patch
            .write_raw(&[123, 0, 65536], &mut buffers)
            .unwrap_err()
            .code,
        "raw_value_out_of_range"
    );
    assert_eq!(buffers, original);
}

/// Breaks may share a universe if actual bytes do not collide; virtual-only modes consume nothing.
#[test]
fn nonoverlapping_breaks_share_a_universe_without_inventing_virtual_slots() {
    let mut bindings = breaks();
    bindings.insert(
        11,
        BreakPatch {
            universe: 20,
            address: 104,
        },
    );
    let patch = mode().patch(&bindings).unwrap();
    assert_eq!(
        patch.channels()[2].as_ref().unwrap().wire().offsets,
        [107, 104, 106, 105]
    );
    let virtual_mode = ModeWires {
        channels: vec![None, None],
        footprints: BTreeMap::new(),
    };
    let patch = virtual_mode.patch(&BTreeMap::new()).unwrap();
    let mut buffers = BTreeMap::new();
    patch.write_raw(&[42, u32::MAX], &mut buffers).unwrap();
    assert!(buffers.is_empty());
    assert_eq!(patch.read_raw(&buffers).unwrap(), [None, None]);
}

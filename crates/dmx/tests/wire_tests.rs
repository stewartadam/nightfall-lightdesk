// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Parser-independent physical wire contracts and exact raw byte operations.

use nightfall_dmx::wire::{ChannelWire, ModeWires};

/// Independently authored buffers verify byte significance, gaps, and exact values at every width.
#[test]
fn raw_codec_preserves_sparse_slots_and_integer_precision() {
    for (offsets, raw, expected) in [
        (vec![4], 0xab, vec![0xee, 0xee, 0xee, 0xab]),
        (vec![4, 1], 0xabcd, vec![0xcd, 0xee, 0xee, 0xab]),
        (vec![4, 1, 3], 0xabcdef, vec![0xcd, 0xee, 0xef, 0xab]),
        (vec![4, 1, 3, 2], 0xabcdef01, vec![0xcd, 0x01, 0xef, 0xab]),
    ] {
        let wire = ChannelWire {
            dmx_break: 7,
            offsets,
        };
        assert_eq!(wire.read_raw(&expected).unwrap(), raw);
        let mut output = vec![0xee; 4];
        wire.write_raw(raw, &mut output).unwrap();
        assert_eq!(output, expected);
        let maximum = u32::MAX >> ((4 - wire.offsets.len()) * 8);
        for value in [0, 1, maximum - 1, maximum] {
            wire.write_raw(value, &mut output).unwrap();
            assert_eq!(wire.read_raw(&output).unwrap(), value);
        }
    }
}

/// Rejected writes are transactional even when a valid byte precedes an invalid one.
#[test]
fn raw_codec_rejects_invalid_layouts_and_overflow_without_partial_writes() {
    for (dmx_break, offsets, raw, expected) in [
        (0, vec![1], 1, "invalid_break"),
        (1, vec![], 1, "invalid_channel_width"),
        (1, vec![1, 2, 3, 4, 5], 1, "invalid_channel_width"),
        (1, vec![1, 0], 1, "invalid_offset"),
        (1, vec![1, 5], 1, "wire_buffer_too_short"),
        (1, vec![1, 1], 1, "duplicate_byte"),
        (1, vec![1], 256, "raw_value_out_of_range"),
        (1, vec![1, 3], 65536, "raw_value_out_of_range"),
        (1, vec![1, 3, 2], 16777216, "raw_value_out_of_range"),
    ] {
        let wire = ChannelWire { dmx_break, offsets };
        let mut output = [0x99; 4];
        assert_eq!(wire.write_raw(raw, &mut output).unwrap_err().code, expected);
        assert_eq!(output, [0x99; 4]);
        if expected != "raw_value_out_of_range" {
            assert_eq!(wire.read_raw(&output).unwrap_err().code, expected);
        }
    }
}

/// Serialized compiler output retains virtual slots, independent breaks and significant byte order.
#[test]
fn wire_contract_roundtrip_preserves_exact_addresses() {
    let source = serde_json::json!({
        "channels": [
            {"dmxBreak": 7, "offsets": [4, 1, 3, 2]},
            null,
            {"dmxBreak": 11, "offsets": [513]}
        ],
        "footprints": {"7": 4, "11": 513}
    });
    let wires: ModeWires = serde_json::from_value(source.clone()).unwrap();
    assert_eq!(serde_json::to_value(&wires).unwrap(), source);
    assert_eq!(
        wires.channels[0]
            .as_ref()
            .unwrap()
            .read_raw(&[0xcd, 0x01, 0xef, 0xab])
            .unwrap(),
        0xabcdef01
    );
    assert!(wires.channels[1].is_none());
    let mut buffer = [0; 513];
    wires.channels[2]
        .as_ref()
        .unwrap()
        .write_raw(255, &mut buffer)
        .unwrap();
    assert_eq!(buffer[512], 255);
    assert_eq!(wires.channels[2].as_ref().unwrap().dmx_break, 11);
}

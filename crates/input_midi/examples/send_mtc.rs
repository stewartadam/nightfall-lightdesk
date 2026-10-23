// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Plays MIDI timecode from a virtual MIDI port, for trying timecodes that follow MTC without
//! a playback deck.
//!
//! Opens a virtual output port named "Nightfall MTC", locates to the start time with a
//! full-frame message, then plays 25 fps quarter frames for the given number of seconds and
//! stops. Pass a start in seconds and a length in seconds; both default to 0 and 30.
//!
//! ```text
//! cargo run -p nightfall-input-midi --example send_mtc -- 3600 30
//! ```

use std::process;

/// Reports that virtual MIDI ports need CoreMIDI or ALSA and exits with a failure status.
#[cfg(not(unix))]
fn main() {
    eprintln!("send_mtc requires virtual MIDI port support (CoreMIDI or ALSA).");
    process::exit(1);
}

/// Opens the virtual port, locates, then plays quarter frames in real time.
#[cfg(unix)]
fn main() {
    use std::time::{Duration, Instant};

    use midir::MidiOutput;
    use midir::os::unix::VirtualOutput;

    const FPS: u64 = 25;
    const RATE_BITS: u8 = 1;

    let mut args = std::env::args().skip(1);
    let mut number = |default: u64| {
        args.next()
            .map(|arg| {
                arg.parse().unwrap_or_else(|_| {
                    eprintln!("Expected a whole number of seconds, got '{arg}'");
                    process::exit(1);
                })
            })
            .unwrap_or(default)
    };
    let start_seconds = number(0);
    let length_seconds = number(30);

    let midi_out = MidiOutput::new("nightfall-send-mtc").unwrap_or_else(|error| {
        eprintln!("Failed to create MIDI output: {error}");
        process::exit(1);
    });
    let mut connection = midi_out
        .create_virtual("Nightfall MTC")
        .unwrap_or_else(|error| {
            eprintln!("Failed to create virtual MIDI port: {error}");
            process::exit(1);
        });
    // Give the engine's hotplug refresh time to connect to the new port.
    println!("Opened virtual port 'Nightfall MTC'; starting in 2 seconds");
    std::thread::sleep(Duration::from_secs(2));

    let address = |frame: u64| {
        let seconds = frame / FPS;
        [
            (seconds / 3600 % 24) as u8,
            (seconds / 60 % 60) as u8,
            (seconds % 60) as u8,
            (frame % FPS) as u8,
        ]
    };
    let start_frame = start_seconds * FPS;
    let [hours, minutes, seconds, frames] = address(start_frame);
    let locate = [
        0xF0,
        0x7F,
        0x7F,
        0x01,
        0x01,
        RATE_BITS << 5 | hours,
        minutes,
        seconds,
        frames,
        0xF7,
    ];
    let _ = connection.send(&locate);
    println!("Located to {hours:02}:{minutes:02}:{seconds:02}:{frames:02}; playing");

    let quarter = Duration::from_secs(1) / (FPS as u32 * 4);
    let started = Instant::now();
    let quarters = length_seconds * FPS * 4;
    for index in 0..quarters {
        let piece = (index % 8) as u8;
        let [hours, minutes, seconds, frames] = address(start_frame + index / 8 * 2);
        let nibble = match piece {
            0 => frames & 0x0F,
            1 => frames >> 4,
            2 => seconds & 0x0F,
            3 => seconds >> 4,
            4 => minutes & 0x0F,
            5 => minutes >> 4,
            6 => hours & 0x0F,
            _ => RATE_BITS << 1 | hours >> 4,
        };
        let _ = connection.send(&[0xF1, piece << 4 | nibble]);
        let next = started + quarter * (index as u32 + 1);
        std::thread::sleep(next.saturating_duration_since(Instant::now()));
    }
    println!("Stopped");
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Scriptable virtual MIDI controller for end-to-end tests.
//!
//! Opens a virtual MIDI output port under the given name, prints
//! `READY <port-name>` to stdout once the port exists, then sends each line read from stdin
//! as one raw MIDI message. Every line is a JSON array of bytes such as `[144, 60, 127]`,
//! and every sent line is acknowledged with `SENT <line>` so a driver can sequence its
//! messages. The port closes and the process exits when stdin reaches end of file.
//!
//! ```text
//! cargo run -p nightfall-input-midi --example virtual_controller -- "E2E Pad"
//! ```

use std::process;

/// Reports that virtual MIDI ports need CoreMIDI or ALSA and exits with a failure status.
#[cfg(not(unix))]
fn main() {
    eprintln!("virtual_controller requires virtual MIDI port support (CoreMIDI or ALSA).");
    process::exit(1);
}

/// Opens the named virtual port and relays stdin messages to it until end of file.
#[cfg(unix)]
fn main() {
    use std::io::{BufRead, Write};

    use midir::MidiOutput;
    use midir::os::unix::VirtualOutput;

    let port_name = port_name_or_exit();
    let midi_out = MidiOutput::new("nightfall-virtual-controller").unwrap_or_else(|error| {
        eprintln!("Failed to create MIDI output: {error}");
        process::exit(1);
    });
    let mut connection = midi_out.create_virtual(&port_name).unwrap_or_else(|error| {
        eprintln!("Failed to create virtual MIDI output port '{port_name}': {error}");
        process::exit(1);
    });

    let mut stdout = std::io::stdout().lock();
    announce(&mut stdout, &format!("READY {port_name}"));

    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap_or_else(|error| {
            eprintln!("Failed to read stdin: {error}");
            process::exit(1);
        });
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message = parse_message(line).unwrap_or_else(|error| {
            eprintln!("Invalid MIDI message '{line}': {error}");
            process::exit(1);
        });
        if let Err(error) = connection.send(&message) {
            eprintln!("Failed to send {line} on virtual port '{port_name}': {error}");
            process::exit(1);
        }
        announce(&mut stdout, &format!("SENT {line}"));
    }

    /// Writes one line to stdout and flushes it so a piped reader sees it immediately.
    fn announce(stdout: &mut impl Write, line: &str) {
        if writeln!(stdout, "{line}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            process::exit(1);
        }
    }
}

/// Returns the single required port-name argument, or prints usage and exits.
fn port_name_or_exit() -> String {
    let mut args = std::env::args().skip(1);
    match (args.next(), args.next()) {
        (Some(name), None) if !name.is_empty() && name != "--help" && name != "-h" => name,
        _ => {
            eprintln!("Usage: virtual_controller <PORT-NAME>");
            eprintln!();
            eprintln!("Reads newline-delimited JSON byte arrays such as [144, 60, 127] from stdin");
            eprintln!("and sends each as one MIDI message until end of file.");
            process::exit(2);
        }
    }
}

/// Parses one JSON byte array into a non-empty MIDI message whose first byte is a status byte.
fn parse_message(line: &str) -> Result<Vec<u8>, String> {
    let message: Vec<u8> = serde_json::from_str(line).map_err(|error| error.to_string())?;
    match message.first() {
        None => Err("message is empty".to_string()),
        Some(status) if status & 0x80 == 0 => {
            Err(format!("first byte {status} is not a status byte"))
        }
        Some(_) if message[1..].iter().any(|byte| byte & 0x80 != 0) => {
            Err("data bytes must be 0-127".to_string())
        }
        Some(_) => Ok(message),
    }
}

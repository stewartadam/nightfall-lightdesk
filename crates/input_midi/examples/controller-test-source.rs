// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Virtual OS MIDI endpoint for end-to-end controller tests, driven by JSON byte arrays on stdin.

/// Creates a native source and sends note, CC, or pitch-bend messages until stdin closes.
#[cfg(unix)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{BufRead, Write};

    use midir::os::unix::VirtualOutput;

    let name = std::env::args()
        .nth(1)
        .ok_or("a unique port name is required")?;
    let output = midir::MidiOutput::new(&name)?;
    let mut connection = output.create_virtual(&name)?;
    println!("READY");
    std::io::stdout().flush()?;
    for line in std::io::stdin().lock().lines() {
        let message: Vec<u8> = serde_json::from_str(&line?)?;
        if message.len() != 3
            || !matches!(message[0] & 0xf0, 0x80 | 0x90 | 0xb0 | 0xe0)
            || message[1..].iter().any(|value| *value > 127)
        {
            return Err("expected a three-byte MIDI note, CC, or pitch-bend message".into());
        }
        connection.send(&message)?;
    }
    Ok(())
}

/// Reports unsupported native virtual endpoints instead of silently bypassing the MIDI service.
#[cfg(not(unix))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    Err("virtual MIDI test sources require a Unix MIDI backend".into())
}

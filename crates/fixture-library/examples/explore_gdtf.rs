// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::env;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        eprintln!("Usage: explore_gdtf <file1.gdtf> [file2.gdtf ...]");
        std::process::exit(1);
    }

    for gdtf_path in &args {
        explore_gdtf_file(gdtf_path);
        if args.len() > 1 {
            println!("\n{}\n", "=".repeat(80));
        }
    }
}

fn explore_gdtf_file(gdtf_path: &str) {
    println!("Processing: {}\n", gdtf_path);

    let file = match std::fs::File::open(gdtf_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Failed to open GDTF file '{}': {}", gdtf_path, e);
            return;
        }
    };

    let gdtf = match gdtf::GdtfFile::new(file) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("Failed to parse GDTF file '{}': {}", gdtf_path, e);
            return;
        }
    };

    println!("=== GDTF Structure Exploration ===\n");

    // Description contains the main data
    println!(
        "Description data version: {:?}",
        gdtf.description.data_version
    );

    // Fixture types
    println!("\nFixture Types: {}", gdtf.description.fixture_types.len());
    for ft in &gdtf.description.fixture_types {
        println!("\nFixture Type:");
        println!("  Name: {:?}", ft.name);
        println!("  Manufacturer: {}", ft.manufacturer);
        println!("  Long Name: {}", ft.long_name);

        // DMX Modes
        println!("\n  DMX Modes: {}", ft.dmx_modes.len());
        for (i, mode) in ft.dmx_modes.iter().enumerate() {
            println!("\n    Mode {}: {:?}", i, mode.name);
            println!("      Geometry: {:?}", mode.geometry);

            // Channels
            println!("      Channels: {}", mode.dmx_channels.len());
            for (j, channel) in mode.dmx_channels.iter().enumerate() {
                println!(
                    "        Channel {}: Offset={:?}, Highlight={:?}",
                    j, channel.offset, channel.highlight
                );

                // Logical channels contain the actual attribute info
                for lc in &channel.logical_channels {
                    println!(
                        "          Logical: Attribute={:?}, Snap={:?}",
                        lc.attribute, lc.snap
                    );
                }
            }
        }
    }
}

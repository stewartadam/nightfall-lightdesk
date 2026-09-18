// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Test fixture parsers with real GDTF and OFL files

use std::env;
use std::path::Path;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        eprintln!("Usage: parse_fixture_definition <file1> [file2 ...]");
        eprintln!("  Supported formats: .gdtf, .json (OFL)");
        std::process::exit(1);
    }

    println!("Testing fixture parsers with {} file(s)...\n", args.len());

    for file_path in &args {
        if file_path.ends_with(".json") {
            test_ofl_parser(file_path);
        } else if file_path.ends_with(".gdtf") {
            test_gdtf_parser(file_path);
        } else {
            eprintln!("⚠️  Unknown file format: {}", file_path);
        }

        if args.len() > 1 {
            println!("{}\n", "=".repeat(80));
        }
    }

    println!("✅ Parsing completed!");
}

fn test_ofl_parser(ofl_path: &str) {
    println!("=== Testing OFL Parser: {} ===", ofl_path);

    match open_fixture_library::OflFixture::from_file(Path::new(ofl_path)) {
        Ok(fixture) => {
            println!("✓ Successfully parsed OFL fixture!");
            println!("  Manufacturer: {}", fixture.manufacturer());
            println!("  Name: {}", fixture.name());
            println!("  Categories: {:?}", fixture.categories());
            println!("  Modes: {}", fixture.modes().len());

            for (i, mode) in fixture.modes().iter().enumerate() {
                println!(
                    "    Mode {}: {} ({} channels)",
                    i + 1,
                    mode.name,
                    mode.channels.len()
                );
            }

            if let Some(physical) = fixture.physical() {
                if let Some(dims) = &physical.dimensions {
                    println!("  Dimensions: {:?} mm", dims);
                }
                if let Some(weight) = physical.weight {
                    println!("  Weight: {} kg", weight);
                }
            }

            println!(
                "  Available channels: {}",
                fixture.available_channels().len()
            );
            for (key, _channel) in fixture.available_channels().iter().take(5) {
                println!("    - {}", key);
            }
            if fixture.available_channels().len() > 5 {
                println!(
                    "    ... and {} more",
                    fixture.available_channels().len() - 5
                );
            }
        }
        Err(e) => {
            eprintln!("✗ Failed to parse OFL fixture '{}': {}", ofl_path, e);
        }
    }
    println!();
}

fn test_gdtf_parser(gdtf_path: &str) {
    println!("=== Testing GDTF Parser: {} ===", gdtf_path);

    match std::fs::File::open(gdtf_path) {
        Ok(file) => {
            match gdtf::GdtfFile::new(file) {
                Ok(gdtf_file) => {
                    println!("✓ Successfully parsed GDTF fixture!");
                    println!("  Description: {:?}", gdtf_file.description);
                    // Note: We can't easily extract all info without deep inspection
                    // of the GDTF structure, but we verified it parses!
                }
                Err(e) => {
                    eprintln!("✗ Failed to parse GDTF file '{}': {}", gdtf_path, e);
                }
            }
        }
        Err(e) => {
            eprintln!("✗ Failed to open GDTF file '{}': {}", gdtf_path, e);
        }
    }
    println!();
}

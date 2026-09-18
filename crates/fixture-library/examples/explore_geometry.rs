// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Explore GDTF geometry structure to understand multi-element fixtures

use std::env;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        eprintln!("Usage: explore_geometry <file1.gdtf> [file2.gdtf ...]");
        std::process::exit(1);
    }

    for gdtf_path in &args {
        explore_geometry_file(gdtf_path);
        if args.len() > 1 {
            println!("\n{}\n", "=".repeat(80));
        }
    }
}

fn explore_geometry_file(gdtf_path: &str) {
    println!("=== Exploring GDTF Geometry: {} ===\n", gdtf_path);

    let file = match std::fs::File::open(gdtf_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("✗ Failed to open file '{}': {}", gdtf_path, e);
            return;
        }
    };

    match gdtf::GdtfFile::new(file) {
        Ok(gdtf) => {
            println!("✓ Successfully opened GDTF file\n");

            if let Some(fixture_type) = gdtf.description.fixture_types.first() {
                let fixture_name = fixture_type
                    .name
                    .as_ref()
                    .map(|n| n.to_string())
                    .unwrap_or("Unknown".to_string());
                println!("Fixture: {}\n", fixture_name);

                // Print all geometries
                println!("=== Geometries ===");
                print_geometries(&fixture_type.geometries, 0);

                // Print DMX modes
                println!("\n=== DMX Modes ===");
                for (i, mode) in fixture_type.dmx_modes.iter().enumerate() {
                    let mode_name = mode
                        .name
                        .as_ref()
                        .map(|n| n.to_string())
                        .unwrap_or("Unnamed".to_string());
                    println!("\nMode {}: {}", i + 1, mode_name);
                    println!("  Geometry: {:?}", mode.geometry);
                    println!("  Channels: {}", mode.dmx_channels.len());

                    // Print all channels
                    for (j, channel) in mode.dmx_channels.iter().enumerate() {
                        println!("\n  Channel {}: geometry={}", j + 1, channel.geometry);
                        println!("    Offset: {:?}", channel.offset);
                        println!("    Logical channels: {}", channel.logical_channels.len());

                        for logical in &channel.logical_channels {
                            println!("      - Attribute: {}", logical.attribute);
                        }
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("✗ Failed to open GDTF file '{}': {}", gdtf_path, e);
        }
    }
}

fn print_geometries(geometries: &[gdtf::geometry::Geometry], indent: usize) {
    use gdtf::geometry::{AnyGeometry, Geometry};

    for geom in geometries {
        let prefix = "  ".repeat(indent);
        let name = geom
            .name()
            .map(|n| n.to_string())
            .unwrap_or("Unnamed".to_string());
        let geom_type = match geom {
            Geometry::Generic(_) => "Generic",
            Geometry::Axis(_) => "Axis",
            Geometry::Beam(_) => "Beam",
            Geometry::Display(_) => "Display",
            Geometry::FilterBeam(_) => "FilterBeam",
            Geometry::FilterColor(_) => "FilterColor",
            Geometry::FilterGobo(_) => "FilterGobo",
            Geometry::FilterShaper(_) => "FilterShaper",
            Geometry::MediaServerLayer(_) => "MediaServerLayer",
            Geometry::MediaServerCamera(_) => "MediaServerCamera",
            Geometry::MediaServerMaster(_) => "MediaServerMaster",
            Geometry::Reference(_) => "Reference",
            Geometry::Laser(_) => "Laser",
            Geometry::WiringObject(_) => "WiringObject",
            Geometry::Inventory(_) => "Inventory",
            Geometry::Structure(_) => "Structure",
            Geometry::Support(_) => "Support",
            Geometry::Magnet(_) => "Magnet",
        };

        println!("{}{} ({})", prefix, name, geom_type);

        // Print children recursively
        print_geometries(geom.children(), indent + 1);
    }
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! GDTF DMX Mode and Geometry Tree Explorer
//!
//! This tool implements the GDTF specification's algorithm for mapping DMX channels
//! to beam geometries. Given a DMX mode, it shows:
//! - All DMX channels and their attributes
//! - The geometry tree with relevant nodes down to beams
//! - Which DMX channels control which geometry segments
//!
//! Usage: explore_gdtf2 <file.gdtf> <mode_name>

use std::collections::{HashMap, HashSet};
use std::env;

use gdtf::dmx_mode::{DmxChannel, DmxMode, LogicalChannel};
use gdtf::fixture_type::FixtureType;
use gdtf::geometry::{AnyGeometry, Geometry};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.len() < 2 {
        eprintln!("Usage: explore_gdtf2 <file.gdtf> <mode_name>");
        eprintln!();
        eprintln!("Arguments:");
        eprintln!("  file.gdtf   Path to a GDTF file");
        eprintln!("  mode_name   Name of the DMX mode to explore");
        eprintln!();
        eprintln!("To list available modes, run with just the file:");
        eprintln!("  explore_gdtf2 <file.gdtf> --list-modes");
        std::process::exit(1);
    }

    let gdtf_path = &args[0];
    let mode_name = &args[1];

    let file = match std::fs::File::open(gdtf_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Failed to open GDTF file '{}': {}", gdtf_path, e);
            std::process::exit(1);
        }
    };

    let gdtf = match gdtf::GdtfFile::new(file) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("Failed to parse GDTF file '{}': {}", gdtf_path, e);
            std::process::exit(1);
        }
    };

    // Get the first fixture type (GDTF files typically have one)
    let ft = match gdtf.description.fixture_types.first() {
        Some(ft) => ft,
        None => {
            eprintln!("No fixture types found in GDTF file");
            std::process::exit(1);
        }
    };

    println!("Fixture: {} - {}", ft.manufacturer, ft.long_name);
    println!();

    // List modes if requested
    if mode_name == "--list-modes" {
        println!("Available DMX Modes:");
        for mode in &ft.dmx_modes {
            let name = mode
                .name
                .as_ref()
                .map(|n| n.as_ref())
                .unwrap_or("<unnamed>");
            let channel_count = mode.dmx_channels.len();
            let geometry = mode
                .geometry
                .as_ref()
                .map(|n| n.as_ref())
                .unwrap_or("<none>");
            println!(
                "  - {} ({} channels, geometry: {})",
                name, channel_count, geometry
            );
        }
        return;
    }

    // Find the requested mode
    let mode = match ft.dmx_mode(mode_name) {
        Some(m) => m,
        None => {
            eprintln!("DMX mode '{}' not found.", mode_name);
            eprintln!();
            eprintln!("Available modes:");
            for mode in &ft.dmx_modes {
                let name = mode
                    .name
                    .as_ref()
                    .map(|n| n.as_ref())
                    .unwrap_or("<unnamed>");
                eprintln!("  - {}", name);
            }
            std::process::exit(1);
        }
    };

    explore_mode(ft, mode);
}

fn explore_mode(ft: &FixtureType, mode: &DmxMode) {
    let mode_name = mode
        .name
        .as_ref()
        .map(|n| n.as_ref())
        .unwrap_or("<unnamed>");
    let root_geometry_name = mode
        .geometry
        .as_ref()
        .map(|n| n.as_ref())
        .unwrap_or("<none>");

    println!("═══════════════════════════════════════════════════════════════════════════════");
    println!("DMX MODE: {}", mode_name);
    println!("Root Geometry: {}", root_geometry_name);
    println!("═══════════════════════════════════════════════════════════════════════════════");
    println!();

    // Section 1: DMX Channels
    println!("┌─────────────────────────────────────────────────────────────────────────────┐");
    println!("│ DMX CHANNELS                                                                │");
    println!("└─────────────────────────────────────────────────────────────────────────────┘");
    println!();

    for (i, channel) in mode.dmx_channels.iter().enumerate() {
        print_dmx_channel(i, channel);
    }

    // Section 2: Geometry Tree
    println!();
    println!("┌─────────────────────────────────────────────────────────────────────────────┐");
    println!("│ GEOMETRY TREE                                                               │");
    println!("└─────────────────────────────────────────────────────────────────────────────┘");
    println!();

    // Get the root geometry for this mode
    if let Some(root_geom) = mode.geometry(ft) {
        print_geometry_tree(ft, root_geom, 0, &mut HashSet::new());
    } else {
        println!("  (Root geometry not found)");
    }

    // Section 3: Geometry to DMX Channel Mapping
    println!();
    println!("┌─────────────────────────────────────────────────────────────────────────────┐");
    println!("│ GEOMETRY → DMX CHANNEL MAPPING                                              │");
    println!("└─────────────────────────────────────────────────────────────────────────────┘");
    println!();

    // Build a map of geometry name -> channels that control it
    let geom_to_channels = build_geometry_channel_map(mode);

    // For each geometry that has channels, print the mapping
    let mut geom_names: Vec<_> = geom_to_channels.keys().collect();
    geom_names.sort();

    for geom_name in geom_names {
        let channels = &geom_to_channels[geom_name];
        println!("  {} :", geom_name);
        for (channel_name, attrs) in channels {
            let attrs_str = attrs.join(", ");
            println!("    └─ {} [{}]", channel_name, attrs_str);
        }
        println!();
    }

    // Section 4: Beam Discovery
    println!("┌─────────────────────────────────────────────────────────────────────────────┐");
    println!("│ BEAM DISCOVERY (per DMX channel)                                            │");
    println!("└─────────────────────────────────────────────────────────────────────────────┘");
    println!();

    for channel in &mode.dmx_channels {
        let channel_name = channel.name();
        let geom_name = channel.geometry.as_ref();

        println!("  Channel: {}", channel_name);
        println!("    Controls geometry: {}", geom_name);

        // Find the geometry this channel controls
        if let Some(geom) = ft.nested_geometry(geom_name) {
            // Find all beam descendants
            let beams = find_beam_descendants(ft, geom, &mut HashSet::new());
            if beams.is_empty() {
                println!("    Beams affected: (none - no beam descendants)");
            } else {
                println!("    Beams affected:");
                for beam_info in &beams {
                    println!("      └─ {}", beam_info);
                }
            }
        } else {
            println!("    Beams affected: (geometry not found)");
        }
        println!();
    }
}

fn print_dmx_channel(index: usize, channel: &DmxChannel) {
    let offset_str = match &channel.offset {
        Some(offsets) => offsets
            .iter()
            .map(|o| o.to_string())
            .collect::<Vec<_>>()
            .join(","),
        None => "None".to_string(),
    };

    println!(
        "  [{}] {} (offset: {}, geometry: {})",
        index,
        channel.name(),
        offset_str,
        channel.geometry
    );

    for lc in &channel.logical_channels {
        print_logical_channel(lc);
    }
    println!();
}

fn print_logical_channel(lc: &LogicalChannel) {
    let attr_name = lc.name();
    let snap = if lc.snap { " [snap]" } else { "" };

    println!("      └─ Attribute: {}{}", attr_name, snap);

    for cf in &lc.channel_functions {
        let cf_name = cf.name.as_ref().map(|n| n.as_ref()).unwrap_or("<unnamed>");
        let cf_attr = cf
            .attribute
            .first()
            .map(|n| n.as_ref())
            .unwrap_or("NoFeature");

        let emitter_str = cf
            .emitter
            .as_ref()
            .map(|e| format!(" -> Emitter: {}", e))
            .unwrap_or_default();

        println!(
            "          └─ {} (attr: {}, dmx_from: {:?}, phys: {}..{}){}",
            cf_name, cf_attr, cf.dmx_from, cf.physical_from, cf.physical_to, emitter_str
        );
    }
}

fn print_geometry_tree(
    ft: &FixtureType,
    geom: &Geometry,
    depth: usize,
    visited: &mut HashSet<String>,
) {
    let indent = "  ".repeat(depth);
    let name = geom.name().map(|n| n.as_ref()).unwrap_or("<unnamed>");

    // Prevent infinite loops from circular references
    if visited.contains(name) {
        println!("{}└─ {} (circular reference)", indent, name);
        return;
    }
    visited.insert(name.to_string());

    let geom_type = geometry_type_name(geom);
    let extra_info = geometry_extra_info(geom);

    let prefix = if depth == 0 { "" } else { "└─ " };
    println!("{}{}{} [{}]{}", indent, prefix, name, geom_type, extra_info);

    // Handle GeometryReference specially - expand the referenced geometry
    if let Geometry::Reference(ref_geom) = geom {
        if let Some(ref_name) = &ref_geom.geometry {
            if let Some(referenced) = ft.root_geometry(ref_name.as_ref()) {
                let breaks_str = if ref_geom.breaks.is_empty() {
                    String::new()
                } else {
                    let breaks: Vec<_> = ref_geom
                        .breaks
                        .iter()
                        .map(|b| format!("break{}@{:?}", b.dmx_break, b.dmx_offset))
                        .collect();
                    format!(" breaks: [{}]", breaks.join(", "))
                };
                println!("{}   → references: {}{}", indent, ref_name, breaks_str);

                // Show the referenced geometry's structure (indented)
                print_referenced_geometry_tree(ft, referenced, depth + 2, &mut visited.clone());
            }
        }
    }

    // Print children
    for child in geom.children() {
        print_geometry_tree(ft, child, depth + 1, visited);
    }

    visited.remove(name);
}

fn print_referenced_geometry_tree(
    _ft: &FixtureType,
    geom: &Geometry,
    depth: usize,
    visited: &mut HashSet<String>,
) {
    let indent = "  ".repeat(depth);
    let name = geom.name().map(|n| n.as_ref()).unwrap_or("<unnamed>");

    if visited.contains(name) {
        return;
    }
    visited.insert(name.to_string());

    let geom_type = geometry_type_name(geom);
    let extra_info = geometry_extra_info(geom);

    println!("{}(ref) {} [{}]{}", indent, name, geom_type, extra_info);

    for child in geom.children() {
        print_referenced_geometry_tree(_ft, child, depth + 1, visited);
    }

    visited.remove(name);
}

fn geometry_type_name(geom: &Geometry) -> &'static str {
    match geom {
        Geometry::Generic(_) => "Geometry",
        Geometry::Axis(_) => "Axis",
        Geometry::FilterBeam(_) => "FilterBeam",
        Geometry::FilterColor(_) => "FilterColor",
        Geometry::FilterGobo(_) => "FilterGobo",
        Geometry::FilterShaper(_) => "FilterShaper",
        Geometry::Beam(_) => "Beam",
        Geometry::MediaServerLayer(_) => "MediaServerLayer",
        Geometry::MediaServerCamera(_) => "MediaServerCamera",
        Geometry::MediaServerMaster(_) => "MediaServerMaster",
        Geometry::Display(_) => "Display",
        Geometry::Reference(_) => "GeometryReference",
        Geometry::Laser(_) => "Laser",
        Geometry::WiringObject(_) => "WiringObject",
        Geometry::Inventory(_) => "Inventory",
        Geometry::Structure(_) => "Structure",
        Geometry::Support(_) => "Support",
        Geometry::Magnet(_) => "Magnet",
    }
}

fn geometry_extra_info(geom: &Geometry) -> String {
    match geom {
        Geometry::Beam(beam) => {
            format!(
                " lamp:{:?}, beam_angle:{:.1}°, luminous_flux:{}lm",
                beam.lamp_type, beam.beam_angle, beam.luminous_flux
            )
        }
        Geometry::Axis(_) => " (rotation axis)".to_string(),
        Geometry::Reference(ref_geom) => {
            let ref_name = ref_geom
                .geometry
                .as_ref()
                .map(|n| n.as_ref())
                .unwrap_or("<none>");
            format!(" -> {}", ref_name)
        }
        Geometry::Laser(laser) => {
            format!(" output:{}W", laser.output_strength)
        }
        _ => String::new(),
    }
}

fn build_geometry_channel_map(mode: &DmxMode) -> HashMap<String, Vec<(String, Vec<String>)>> {
    let mut map: HashMap<String, Vec<(String, Vec<String>)>> = HashMap::new();

    for channel in &mode.dmx_channels {
        let geom_name = channel.geometry.to_string();
        let channel_name = channel.name().to_string();

        let attrs: Vec<String> = channel
            .logical_channels
            .iter()
            .map(|lc| lc.name().to_string())
            .collect();

        map.entry(geom_name)
            .or_default()
            .push((channel_name, attrs));
    }

    map
}

fn find_beam_descendants(
    ft: &FixtureType,
    geom: &Geometry,
    visited: &mut HashSet<String>,
) -> Vec<String> {
    let mut beams = Vec::new();

    let name = geom.name().map(|n| n.to_string()).unwrap_or_default();
    if visited.contains(&name) {
        return beams;
    }
    visited.insert(name.clone());

    // Check if this geometry itself is a beam
    if let Geometry::Beam(beam) = geom {
        let beam_name = beam
            .name
            .as_ref()
            .map(|n| n.as_ref())
            .unwrap_or("<unnamed>");
        let emitter_info = beam
            .emitter_spectrum
            .as_ref()
            .map(|e| format!(" (emitter: {})", e))
            .unwrap_or_default();
        beams.push(format!(
            "{} [{:?}, {:.1}°, {}lm]{}",
            beam_name, beam.lamp_type, beam.beam_angle, beam.luminous_flux, emitter_info
        ));
    }

    // Check if this is a laser (also emits light)
    if let Geometry::Laser(laser) = geom {
        let laser_name = laser
            .name
            .as_ref()
            .map(|n| n.as_ref())
            .unwrap_or("<unnamed>");
        beams.push(format!(
            "{} [Laser, {}W]",
            laser_name, laser.output_strength
        ));
    }

    // Handle GeometryReference - look up and traverse the referenced geometry
    if let Geometry::Reference(ref_geom) = geom {
        if let Some(ref_name) = &ref_geom.geometry {
            if let Some(referenced) = ft.root_geometry(ref_name.as_ref()) {
                let ref_beams = find_beam_descendants(ft, referenced, visited);
                for beam_info in ref_beams {
                    // Prefix with reference name to show path
                    beams.push(format!("{} -> {}", name, beam_info));
                }
            }
        }
    }

    // Recurse into children
    for child in geom.children() {
        beams.extend(find_beam_descendants(ft, child, visited));
    }

    visited.remove(&name);
    beams
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::env;
use std::process;
use std::thread;
use std::time::Duration;

use midir::MidiOutput;
#[cfg(not(any(windows, target_arch = "wasm32")))]
use midir::os::unix::VirtualOutput;

/// Command-line arguments parsed by this example utility.
struct Cli {
    port_name: String,
    channel: u8,
    note: u8,
    velocity: u8,
    hold_ms: u64,
    send_note_off: bool,
    wait_ms: u64,
    linger_ms: u64,
}

#[cfg(any(windows, target_arch = "wasm32"))]
fn main() {
    eprintln!("This example requires virtual MIDI port support (not available on this platform).");
    process::exit(1);
}

#[cfg(not(any(windows, target_arch = "wasm32")))]
fn main() {
    let cli = parse_cli_or_exit();

    let midi_out = MidiOutput::new("nightfall-midi-virtual-device").unwrap_or_else(|error| {
        eprintln!("Failed to create MIDI output: {error}");
        process::exit(1);
    });

    let mut connection = midi_out
        .create_virtual(&cli.port_name)
        .unwrap_or_else(|error| {
            eprintln!(
                "Failed to create virtual MIDI output port '{}': {}",
                cli.port_name, error
            );
            process::exit(1);
        });

    println!("Created virtual MIDI device '{}'.", cli.port_name);
    println!(
        "Will send Note On on channel {} note {} velocity {} in {}ms.",
        cli.channel, cli.note, cli.velocity, cli.wait_ms
    );
    println!("Keep this process running while backend connects to the virtual device.");

    if cli.wait_ms > 0 {
        thread::sleep(Duration::from_millis(cli.wait_ms));
    }

    let channel_zero_based = cli.channel - 1;
    let note_on_status = 0x90_u8.saturating_add(channel_zero_based);
    let note_off_status = 0x80_u8.saturating_add(channel_zero_based);
    let note_on = [note_on_status, cli.note, cli.velocity];
    let note_off = [note_off_status, cli.note, 0];

    if let Err(error) = connection.send(&note_on) {
        eprintln!(
            "Failed to send Note On on virtual port '{}': {}",
            cli.port_name, error
        );
        process::exit(1);
    }
    println!(
        "Sent Note On: status={} channel={} note={} velocity={}",
        note_on_status, cli.channel, cli.note, cli.velocity
    );

    if cli.send_note_off {
        thread::sleep(Duration::from_millis(cli.hold_ms));
        if let Err(error) = connection.send(&note_off) {
            eprintln!(
                "Failed to send Note Off on virtual port '{}': {}",
                cli.port_name, error
            );
            process::exit(1);
        }
        println!(
            "Sent Note Off: status={} channel={} note={}",
            note_off_status, cli.channel, cli.note
        );
    }

    if cli.linger_ms > 0 {
        println!("Keeping virtual device open for {}ms...", cli.linger_ms);
        thread::sleep(Duration::from_millis(cli.linger_ms));
    } else {
        println!("Keeping virtual device open until interrupted (Ctrl+C).");
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }
}

fn parse_cli_or_exit() -> Cli {
    let mut port_name = "nightfall-virtual-midi-device".to_string();
    let mut channel = 1_u8;
    let mut note = 1_u8;
    let mut velocity = 127_u8;
    let mut hold_ms = 120_u64;
    let mut send_note_off = false;
    let mut wait_ms = 1000_u64;
    let mut linger_ms = 30000_u64;

    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--port-name" => port_name = next_arg_value(&mut args, "--port-name"),
            "--channel" => {
                let raw = next_arg_value(&mut args, "--channel");
                let parsed = raw.parse::<u8>().unwrap_or_else(|_| {
                    eprintln!("Invalid --channel '{raw}', expected 1-16.");
                    process::exit(1);
                });
                if !(1..=16).contains(&parsed) {
                    eprintln!("Invalid --channel '{parsed}', expected 1-16.");
                    process::exit(1);
                }
                channel = parsed;
            }
            "--note" => {
                let raw = next_arg_value(&mut args, "--note");
                note = parse_u7_or_exit(&raw, "--note");
            }
            "--velocity" => {
                let raw = next_arg_value(&mut args, "--velocity");
                velocity = parse_u7_or_exit(&raw, "--velocity");
            }
            "--hold-ms" => {
                let raw = next_arg_value(&mut args, "--hold-ms");
                hold_ms = parse_u64_or_exit(&raw, "--hold-ms");
            }
            "--wait-ms" => {
                let raw = next_arg_value(&mut args, "--wait-ms");
                wait_ms = parse_u64_or_exit(&raw, "--wait-ms");
            }
            "--linger-ms" => {
                let raw = next_arg_value(&mut args, "--linger-ms");
                linger_ms = parse_u64_or_exit(&raw, "--linger-ms");
            }
            "--note-off" => send_note_off = true,
            "--no-note-off" => send_note_off = false,
            "--help" | "-h" => print_usage_and_exit(),
            _ => {
                eprintln!("Unknown argument: {flag}");
                print_usage_and_exit();
            }
        }
    }

    Cli {
        port_name,
        channel,
        note,
        velocity,
        hold_ms,
        send_note_off,
        wait_ms,
        linger_ms,
    }
}

fn parse_u7_or_exit(raw: &str, flag: &str) -> u8 {
    let value = raw.parse::<u8>().unwrap_or_else(|_| {
        eprintln!("Invalid {flag} value '{raw}', expected 0-127.");
        process::exit(1);
    });
    if value > 127 {
        eprintln!("Invalid {flag} value '{raw}', expected 0-127.");
        process::exit(1);
    }
    value
}

fn parse_u64_or_exit(raw: &str, flag: &str) -> u64 {
    raw.parse::<u64>().unwrap_or_else(|_| {
        eprintln!("Invalid {flag} value '{raw}', expected a non-negative integer.");
        process::exit(1);
    })
}

fn next_arg_value(args: &mut impl Iterator<Item = String>, flag: &str) -> String {
    args.next().unwrap_or_else(|| {
        eprintln!("Missing value for {flag}");
        print_usage_and_exit();
    })
}

fn print_usage_and_exit() -> ! {
    eprintln!("Usage:");
    eprintln!(
        "  cargo run -p nightfall-input-midi --example send_midi_note -- [--port-name <NAME>] [--channel <1-16>] [--note <0-127>] [--velocity <0-127>] [--wait-ms <MS>] [--linger-ms <MS>] [--note-off] [--hold-ms <MS>]"
    );
    eprintln!();
    eprintln!("Defaults:");
    eprintln!("  port-name = nightfall-virtual-midi-device");
    eprintln!("  channel   = 1");
    eprintln!("  note      = 1");
    eprintln!("  velocity  = 127");
    eprintln!("  note-off  = disabled");
    eprintln!("  wait-ms   = 1000");
    eprintln!("  linger-ms = 30000");
    eprintln!();
    eprintln!("Examples:");
    eprintln!("  cargo run -p nightfall-input-midi --example send_midi_note");
    eprintln!(
        "  cargo run -p nightfall-input-midi --example send_midi_note -- --port-name test-midi --note 60 --velocity 100 --note-off --hold-ms 200 --linger-ms 0"
    );
    process::exit(1);
}

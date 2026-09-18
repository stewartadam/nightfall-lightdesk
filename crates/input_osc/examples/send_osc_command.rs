// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::env;
use std::net::UdpSocket;
use std::process;

use nightfall_config::RuntimeConfigLoader;
use rosc::{OscMessage, OscPacket, OscType, encoder};

/// Command-line arguments parsed by this example utility.
struct Cli {
    host: String,
    port: u16,
    endpoint: String,
    args: Vec<OscType>,
}

/// Loads startup configuration and sends an OSC command from CLI arguments.
fn main() {
    let runtime_config = RuntimeConfigLoader::new().load().unwrap_or_else(|error| {
        eprintln!("Failed to load startup configuration: {error}");
        process::exit(2);
    });
    let cli = parse_cli_or_exit(runtime_config.osc_bind_addr.port());

    if !cli.endpoint.starts_with('/') {
        eprintln!("Error: endpoint must start with '/'. Got: {}", cli.endpoint);
        print_usage_and_exit();
    }

    let target = format!("{}:{}", cli.host, cli.port);
    let payload = encoder::encode(&OscPacket::Message(OscMessage {
        addr: cli.endpoint.clone(),
        args: cli.args,
    }))
    .unwrap_or_else(|error| {
        eprintln!("Failed to encode OSC packet: {error}");
        process::exit(1);
    });

    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(socket) => socket,
        Err(error) => {
            eprintln!("Failed to create UDP socket: {error}");
            process::exit(1);
        }
    };

    if let Err(error) = socket.send_to(&payload, &target) {
        eprintln!("Failed to send OSC packet to {target}: {error}");
        process::exit(1);
    }

    println!(
        "Sent OSC message to {target}: endpoint={} bytes={}",
        cli.endpoint,
        payload.len()
    );
}

/// Parses command-line arguments with the configured OSC port as the default.
fn parse_cli_or_exit(default_port: u16) -> Cli {
    let mut host: Option<String> = None;
    let mut port = None;
    let mut endpoint = None;
    let mut osc_args = Vec::new();

    let mut args = env::args().skip(1);

    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--host" => host = Some(next_arg_value(&mut args, "--host")),
            "--port" => {
                let raw = next_arg_value(&mut args, "--port");
                let parsed_port = raw.parse::<u16>().unwrap_or_else(|_| {
                    eprintln!(
                        "Invalid --port value '{raw}', expected a number between 0 and 65535."
                    );
                    process::exit(1);
                });
                port = Some(parsed_port);
            }
            "--endpoint" => endpoint = Some(next_arg_value(&mut args, "--endpoint")),
            "--arg" => {
                let raw = next_arg_value(&mut args, "--arg");
                let parsed = parse_osc_arg(&raw).unwrap_or_else(|error| {
                    eprintln!("Invalid --arg value '{raw}': {error}");
                    print_usage_and_exit();
                });
                osc_args.push(parsed);
            }
            "--help" | "-h" => print_usage_and_exit(),
            _ => {
                eprintln!("Unknown argument: {flag}");
                print_usage_and_exit();
            }
        }
    }

    Cli {
        host: host.unwrap_or_else(|| "127.0.0.1".to_string()),
        port: port.unwrap_or(default_port),
        endpoint: endpoint.unwrap_or_else(|| missing_argument("--endpoint")),
        args: osc_args,
    }
}

fn next_arg_value(args: &mut impl Iterator<Item = String>, flag: &str) -> String {
    args.next().unwrap_or_else(|| {
        eprintln!("Missing value for {flag}");
        print_usage_and_exit();
    })
}

fn missing_argument(name: &str) -> ! {
    eprintln!("Missing required argument: {name}");
    print_usage_and_exit();
}

fn print_usage_and_exit() -> ! {
    eprintln!("Usage:");
    eprintln!(
        "  cargo run -p nightfall-input-osc --example send_osc_command -- --endpoint <ENDPOINT> [--host <HOST>] [--port <PORT>] [--arg <TYPE:VALUE>]..."
    );
    eprintln!();
    eprintln!("Default host: 127.0.0.1");
    eprintln!(
        "Default port: NIGHTFALL_OSC_BIND, then NIGHTFALL_OSC_PORT, then NIGHTFALL_PORT + 2 (3032 by default)"
    );
    eprintln!();
    eprintln!("Arg formats:");
    eprintln!("  --arg int:7");
    eprintln!("  --arg float:0.5");
    eprintln!("  --arg string:hello");
    eprintln!("  --arg bool:true");
    eprintln!("  --arg long:9223372036854775807");
    eprintln!("  --arg double:3.14159");
    eprintln!("  --arg blob:deadbeef");
    eprintln!("  --arg char:x");
    eprintln!("  --arg time:12:34");
    eprintln!("  --arg midi:1,144,60,127");
    eprintln!("  --arg color:255,0,0,255");
    eprintln!("  --arg nil");
    eprintln!("  --arg inf");
    eprintln!();
    eprintln!("Example:");
    eprintln!(
        "  cargo run -p nightfall-input-osc --example send_osc_command -- --endpoint /exec/start --arg int:6 --arg string:go"
    );
    process::exit(1);
}

fn parse_osc_arg(raw: &str) -> Result<OscType, String> {
    if raw.eq_ignore_ascii_case("nil") {
        return Ok(OscType::Nil);
    }
    if raw.eq_ignore_ascii_case("inf") {
        return Ok(OscType::Inf);
    }

    let (kind, value) = raw
        .split_once(':')
        .ok_or_else(|| "expected TYPE:VALUE".to_string())?;
    let kind = kind.to_ascii_lowercase();

    match kind.as_str() {
        "int" | "i" => parse_i32(value).map(OscType::Int),
        "float" | "f" => parse_f32(value).map(OscType::Float),
        "double" | "d" => parse_f64(value).map(OscType::Double),
        "long" | "h" => parse_i64(value).map(OscType::Long),
        "string" | "s" => Ok(OscType::String(value.to_string())),
        "bool" | "b" => parse_bool(value).map(OscType::Bool),
        "blob" => parse_blob(value).map(OscType::Blob),
        "char" | "c" => parse_char(value).map(OscType::Char),
        "time" | "t" => parse_time(value).map(OscType::Time),
        "midi" | "m" => parse_midi(value).map(OscType::Midi),
        "color" | "r" => parse_color(value).map(OscType::Color),
        _ => Err(format!("unsupported arg type '{kind}'")),
    }
}

fn parse_i32(value: &str) -> Result<i32, String> {
    value.parse::<i32>().map_err(|_| "expected i32".to_string())
}

fn parse_i64(value: &str) -> Result<i64, String> {
    value.parse::<i64>().map_err(|_| "expected i64".to_string())
}

fn parse_f32(value: &str) -> Result<f32, String> {
    value.parse::<f32>().map_err(|_| "expected f32".to_string())
}

fn parse_f64(value: &str) -> Result<f64, String> {
    value.parse::<f64>().map_err(|_| "expected f64".to_string())
}

fn parse_bool(value: &str) -> Result<bool, String> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err("expected bool true/false/1/0".to_string()),
    }
}

fn parse_blob(value: &str) -> Result<Vec<u8>, String> {
    let hex = value.strip_prefix("0x").unwrap_or(value);
    if hex.len() % 2 != 0 {
        return Err("blob hex length must be even".to_string());
    }

    (0..hex.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&hex[index..index + 2], 16)
                .map_err(|_| "blob must be valid hex".to_string())
        })
        .collect()
}

fn parse_char(value: &str) -> Result<char, String> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err("char cannot be empty".to_string());
    };
    if chars.next().is_some() {
        return Err("char must be a single Unicode scalar".to_string());
    }
    Ok(first)
}

fn parse_time(value: &str) -> Result<rosc::OscTime, String> {
    let (seconds, fractional) = value
        .split_once(':')
        .ok_or_else(|| "time expects seconds:fractional".to_string())?;
    let seconds = seconds
        .parse::<u32>()
        .map_err(|_| "time seconds must be u32".to_string())?;
    let fractional = fractional
        .parse::<u32>()
        .map_err(|_| "time fractional must be u32".to_string())?;
    Ok(rosc::OscTime {
        seconds,
        fractional,
    })
}

fn parse_midi(value: &str) -> Result<rosc::OscMidiMessage, String> {
    let parts = parse_csv_u8::<4>(value, "midi expects port,status,data1,data2")?;
    Ok(rosc::OscMidiMessage {
        port: parts[0],
        status: parts[1],
        data1: parts[2],
        data2: parts[3],
    })
}

fn parse_color(value: &str) -> Result<rosc::OscColor, String> {
    let parts = parse_csv_u8::<4>(value, "color expects red,green,blue,alpha")?;
    Ok(rosc::OscColor {
        red: parts[0],
        green: parts[1],
        blue: parts[2],
        alpha: parts[3],
    })
}

fn parse_csv_u8<const N: usize>(value: &str, error: &str) -> Result<[u8; N], String> {
    let parts = value.split(',').map(str::trim).collect::<Vec<_>>();
    if parts.len() != N {
        return Err(error.to_string());
    }

    let mut parsed = [0_u8; N];
    for (index, part) in parts.iter().enumerate() {
        parsed[index] = part.parse::<u8>().map_err(|_| error.to_string())?;
    }
    Ok(parsed)
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::thread::sleep;
use std::time::Duration;

use artnet_protocol::{ArtCommand, Output, PortAddress};

fn main() {
    let mut config = Config::default();
    if let Err(error) = config.apply_args(std::env::args().skip(1)) {
        eprintln!("{error}");
        eprintln!("{USAGE}");
        std::process::exit(2);
    }

    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).expect("failed to bind UDP socket");
    socket
        .set_broadcast(true)
        .expect("failed to enable broadcast");

    let target = SocketAddrV4::new(config.target_ip, 6454);
    let mut sequence = 0u8;
    let mut chase_index = 0usize;

    loop {
        let mut data = vec![0u8; 512];
        apply_pattern(&mut data, &config, &mut chase_index);

        sequence = sequence.wrapping_add(1).max(1);

        let port_address =
            PortAddress::try_from(config.universe).expect("invalid Art-Net universe");
        let output = Output {
            sequence,
            port_address,
            data: data.into(),
            ..Output::default()
        };
        let command = ArtCommand::Output(output);
        let bytes = command
            .write_to_buffer()
            .expect("failed to encode Art-Net packet");

        socket
            .send_to(&bytes, target)
            .expect("failed to send Art-Net packet");

        if config.fps <= 0.0 {
            break;
        }

        sleep(frame_delay(config.fps));
    }
}

const USAGE: &str = "Usage: send-artnet [--universe N] [--ip A.B.C.D] [--fps N] [--pattern solid:V|ramp|chase] [--channels START-END]";

/// Command-line options for this network utility.
#[derive(Clone)]
struct Config {
    universe: u16,
    target_ip: Ipv4Addr,
    fps: f32,
    pattern: Pattern,
    channel_start: usize,
    channel_end: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            universe: 1,
            target_ip: Ipv4Addr::BROADCAST,
            fps: 30.0,
            pattern: Pattern::Solid(255),
            channel_start: 1,
            channel_end: 512,
        }
    }
}

impl Config {
    fn apply_args<I>(&mut self, mut args: I) -> Result<(), String>
    where
        I: Iterator<Item = String>,
    {
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--universe" => {
                    let value = args.next().ok_or("--universe requires a value")?;
                    self.universe = value.parse::<u16>().map_err(|_| "invalid universe value")?;
                }
                "--ip" => {
                    let value = args.next().ok_or("--ip requires a value")?;
                    self.target_ip = value
                        .parse::<Ipv4Addr>()
                        .map_err(|_| "invalid IP address")?;
                }
                "--fps" => {
                    let value = args.next().ok_or("--fps requires a value")?;
                    self.fps = value.parse::<f32>().map_err(|_| "invalid fps value")?;
                }
                "--pattern" => {
                    let value = args.next().ok_or("--pattern requires a value")?;
                    self.pattern = Pattern::parse(&value)?;
                }
                "--channels" => {
                    let value = args.next().ok_or("--channels requires a value")?;
                    let (start, end) = parse_range(&value)?;
                    self.channel_start = start;
                    self.channel_end = end;
                }
                "--help" | "-h" => {
                    return Err("".to_string());
                }
                other => {
                    return Err(format!("Unknown argument: {other}"));
                }
            }
        }

        if self.channel_start == 0
            || self.channel_end > 512
            || self.channel_start > self.channel_end
        {
            return Err("channels must be within 1-512".to_string());
        }

        if self.universe == 0 || self.universe > 32_767 {
            return Err("universe must be within 1-32767".to_string());
        }

        Ok(())
    }
}

/// Frame patterns emitted by the network sender example.
#[derive(Clone)]
enum Pattern {
    Solid(u8),
    Ramp,
    Chase,
}

impl Pattern {
    fn parse(input: &str) -> Result<Self, String> {
        if let Some(value) = input.strip_prefix("solid:") {
            let value = value.parse::<u8>().map_err(|_| "invalid solid value")?;
            return Ok(Pattern::Solid(value));
        }

        match input {
            "ramp" => Ok(Pattern::Ramp),
            "chase" => Ok(Pattern::Chase),
            _ => Err("invalid pattern".to_string()),
        }
    }
}

fn parse_range(input: &str) -> Result<(usize, usize), String> {
    let mut parts = input.split('-');
    let start = parts
        .next()
        .ok_or("invalid channel range")?
        .parse::<usize>()
        .map_err(|_| "invalid channel range")?;
    let end = parts
        .next()
        .ok_or("invalid channel range")?
        .parse::<usize>()
        .map_err(|_| "invalid channel range")?;
    Ok((start, end))
}

fn apply_pattern(data: &mut [u8], config: &Config, chase_index: &mut usize) {
    let start = config.channel_start - 1;
    let end = config.channel_end - 1;

    match config.pattern {
        Pattern::Solid(value) => {
            for channel in &mut data[start..=end] {
                *channel = value;
            }
        }
        Pattern::Ramp => {
            let span = end - start + 1;
            for (offset, channel) in data[start..=end].iter_mut().enumerate() {
                let value = (offset * 255) / span.max(1);
                *channel = value as u8;
            }
        }
        Pattern::Chase => {
            for channel in &mut data[start..=end] {
                *channel = 0;
            }

            let span = end - start + 1;
            let position = start + (*chase_index % span);
            data[position] = 255;
            *chase_index = chase_index.wrapping_add(1);
        }
    }
}

fn frame_delay(fps: f32) -> Duration {
    if fps <= 0.0 {
        return Duration::from_secs(0);
    }
    let frame_time = 1.0 / fps as f64;
    Duration::from_secs_f64(frame_time)
}

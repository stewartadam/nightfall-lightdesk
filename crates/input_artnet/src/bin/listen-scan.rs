// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};

use artnet_protocol::ArtCommand;

fn main() {
    let mut config = Config::default();
    if let Err(error) = config.apply_args(std::env::args().skip(1)) {
        eprintln!("{error}");
        eprintln!("{USAGE}");
        std::process::exit(2);
    }

    let bind_addr = SocketAddrV4::new(config.bind_ip, config.port);
    let socket = UdpSocket::bind(bind_addr).expect("failed to bind UDP socket");

    println!(
        "Listening for Art-Net on {}:{} (all universes)",
        config.bind_ip, config.port
    );

    let mut buffer = [0u8; 2048];
    loop {
        let (len, addr) = socket
            .recv_from(&mut buffer)
            .expect("failed to receive UDP packet");

        let Ok(command) = ArtCommand::from_buffer(&buffer[..len]) else {
            continue;
        };

        let ArtCommand::Output(output) = command else {
            continue;
        };

        let universe_id: u16 = output.port_address.into();
        let data = to_dmx_frame(output.data.as_ref());
        println!(
            "Universe {} from {} ({} channels)",
            universe_id,
            addr.ip(),
            output.data.as_ref().len()
        );
        print_grid(&data);
    }
}

const USAGE: &str = "Usage: listen-scan [--bind A.B.C.D] [--port N]";

/// Command-line options for this network utility.
struct Config {
    bind_ip: Ipv4Addr,
    port: u16,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind_ip: Ipv4Addr::UNSPECIFIED,
            port: 6454,
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
                "--bind" => {
                    let value = args.next().ok_or("--bind requires a value")?;
                    self.bind_ip = value.parse::<Ipv4Addr>().map_err(|_| "invalid bind IP")?;
                }
                "--port" => {
                    let value = args.next().ok_or("--port requires a value")?;
                    self.port = value.parse::<u16>().map_err(|_| "invalid port")?;
                }
                "--help" | "-h" => {
                    return Err("".to_string());
                }
                other => {
                    return Err(format!("Unknown argument: {other}"));
                }
            }
        }

        Ok(())
    }
}

fn to_dmx_frame(payload: &[u8]) -> [u8; 512] {
    let mut data = [0u8; 512];
    let copy_len = payload.len().min(512);
    data[..copy_len].copy_from_slice(&payload[..copy_len]);
    data
}

fn print_grid(data: &[u8; 512]) {
    for row in 0..16 {
        let start = row * 32;
        let mut line = format!("{:>4}: ", start + 1);
        for col in 0..32 {
            let value = data[start + col];
            line.push_str(&format!("{:>3}", value));
            if col < 31 {
                line.push(' ');
            }
        }
        println!("{line}");
    }
}

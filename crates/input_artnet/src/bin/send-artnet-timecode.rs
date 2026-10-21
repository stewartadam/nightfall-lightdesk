// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Plays Art-Net timecode, for trying timecodes that follow Art-Net without a media server.
//!
//! Broadcasts one 25 fps ArtTimeCode packet per frame from the start time for the given length,
//! then stops. Pass a start in seconds, a length in seconds and an optional target IP; they
//! default to 0, 30 and the broadcast address.
//!
//! ```text
//! cargo run -p nightfall-input-artnet --bin send-artnet-timecode -- 3600 30 127.0.0.1
//! ```

use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::time::{Duration, Instant};

use artnet_protocol::{ArtCommand, FrameType, Timecode};

const FPS: u64 = 25;
const USAGE: &str = "Usage: send-artnet-timecode [START_SECONDS] [LENGTH_SECONDS] [TARGET_IP]";

/// Sends ArtTimeCode packets in real time until the requested length has played.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let number = |index: usize, default: u64| {
        args.get(index).map_or(default, |arg| {
            arg.parse().unwrap_or_else(|_| {
                eprintln!("{USAGE}");
                std::process::exit(2);
            })
        })
    };
    let start_seconds = number(0, 0);
    let length_seconds = number(1, 30);
    let target_ip: Ipv4Addr = args.get(2).map_or(Ipv4Addr::BROADCAST, |arg| {
        arg.parse().unwrap_or_else(|_| {
            eprintln!("{USAGE}");
            std::process::exit(2);
        })
    });

    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).expect("failed to bind UDP socket");
    socket
        .set_broadcast(true)
        .expect("failed to enable broadcast");
    let target = SocketAddrV4::new(target_ip, 6454);

    let frame_length = Duration::from_secs(1) / FPS as u32;
    let started = Instant::now();
    let start_frame = start_seconds * FPS;
    for index in 0..length_seconds * FPS {
        let frame = start_frame + index;
        let seconds = frame / FPS;
        let bytes = ArtCommand::OpTimeCode(Timecode {
            version: [0, 14],
            filler1: 0,
            stream_id: 0,
            frames: (frame % FPS) as u8,
            seconds: (seconds % 60) as u8,
            minutes: (seconds / 60 % 60) as u8,
            hours: (seconds / 3600 % 24) as u8,
            frame_type: FrameType::EBU,
        })
        .write_to_buffer()
        .expect("failed to encode ArtTimeCode packet");
        socket
            .send_to(&bytes, target)
            .expect("failed to send ArtTimeCode packet");
        let next = started + frame_length * (index as u32 + 1);
        std::thread::sleep(next.saturating_duration_since(Instant::now()));
    }
    println!("Stopped");
}

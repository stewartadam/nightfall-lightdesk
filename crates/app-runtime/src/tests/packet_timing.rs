// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Checks that Art-Net and sACN output stay on the output tick grid while the engine plays a
//! timeline in the sample show.

use std::collections::HashSet;
use std::net::{Ipv4Addr, UdpSocket};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use nightfall_io::get_default_interface;
use nightfall_service_host::prelude::{GridTiming, GridTolerance};
use nightfall_timecode::prelude::TimecodeGenerator;

use super::{WorldBootstrap, WorldFactory, queue_startup_command, test_log_config};

/// Default DMX output rate the sample show uses.
const RATE_HZ: u64 = 44;
/// How long the engine runs before packets are collected, so the startup commands have been
/// handled and the timeline is playing.
const WARM_UP: Duration = Duration::from_secs(1);
/// How long packets are collected for.
const RUN: Duration = Duration::from_secs(10);
/// How far packets may stray from the grid.
const TOLERANCE: GridTolerance = GridTolerance {
    max_missed_share: 0.0,
    max_p95_lateness: Duration::from_millis(3),
    max_lateness: Duration::from_millis(10),
};
/// sACN universes whose multicast groups the receiver joins; the sample show starts at 1.
const SACN_UNIVERSES: std::ops::RangeInclusive<u16> = 1..=8;

/// Reads the universe and levels out of a DMX packet, or `None` for any other packet.
type PacketParser = fn(&[u8]) -> Option<(u16, &[u8])>;

/// One received DMX packet: when it arrived, its universe and a fingerprint of its levels.
struct Arrival {
    at: Instant,
    universe: u16,
    levels: u64,
}

/// Runs the sample show with a timeline playing and Art-Net and sACN routed from the console,
/// and checks that for ten seconds each protocol's lowest universe arrives once per output
/// tick, with no skipped ticks and each packet within a few milliseconds of its tick.
///
/// Packets are received on the default interface the output binds to: Art-Net broadcasts and
/// sACN multicast both loop back to local receivers. Arrival is timed at the receiver, so the
/// lateness includes its thread's wake-up, and the engine competes with the output workers for
/// the CPU. The test also checks that the levels changed during the run, so the engine was
/// really busy playing the timeline.
///
/// Like the headless binary, the engine runs on a multi-threaded tokio runtime, which its web
/// server needs.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "timing-sensitive and binds the Art-Net and sACN ports; run alone with `pnpm run test:packet-timing`"]
async fn output_stays_on_grid_while_a_timeline_plays() {
    let _guard = crate::process_config_lock()
        .lock()
        .expect("process config lock");
    let root = tempfile::tempdir().expect("test data root");
    nightfall::set_nightfall_data_dir(Some(root.path().to_path_buf()));
    nightfall::clear_active_show_data_dir();
    let interface_ip = get_default_interface()
        .and_then(|interface| interface.addresses.first()?.parse::<Ipv4Addr>().ok())
        .expect("a default network interface with an IPv4 address");
    let artnet = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 6454)).expect("bind Art-Net port 6454");
    let sacn = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 5568)).expect("bind sACN port 5568");
    for universe in SACN_UNIVERSES {
        let [high, low] = universe.to_be_bytes();
        sacn.join_multicast_v4(&Ipv4Addr::new(239, 255, high, low), &interface_ip)
            .expect("join sACN multicast group");
    }

    let mut app = WorldFactory::new(test_log_config(), true, false, false)
        .build(WorldBootstrap::SampleData {
            showfile_name: None,
        })
        .expect("sample world");
    queue_startup_command(
        &mut app,
        "test",
        "patch console @ artnet; patch console @ sacn; timecode 1 start".to_owned(),
    );
    let warm_up_end = Instant::now() + WARM_UP;
    while Instant::now() < warm_up_end {
        app.update();
    }
    let playing = app
        .world_mut()
        .query::<&TimecodeGenerator>()
        .iter(app.world())
        .any(|timecode| timecode.state.is_active);
    assert!(
        playing,
        "timecode 1 should be playing timeline 1 after warm-up"
    );

    let collecting = Arc::new(AtomicBool::new(true));
    let artnet_arrivals = receive(artnet, &collecting, parse_artnet);
    let sacn_arrivals = receive(sacn, &collecting, parse_sacn);
    let run_end = Instant::now() + RUN;
    while Instant::now() < run_end {
        app.update();
    }
    collecting.store(false, Ordering::Release);
    let artnet_arrivals = artnet_arrivals.join().expect("Art-Net receiver");
    let sacn_arrivals = sacn_arrivals.join().expect("sACN receiver");

    let artnet = check_protocol("Art-Net", &artnet_arrivals);
    let sacn = check_protocol("sACN", &sacn_arrivals);
    println!("Art-Net: {artnet}\nsACN: {sacn}");
}

/// Checks the lowest universe a protocol sent stayed on the grid and changed during the run,
/// returning the timing summary or panicking with it.
fn check_protocol(protocol: &str, arrivals: &[Arrival]) -> String {
    let universe = arrivals
        .iter()
        .map(|arrival| arrival.universe)
        .min()
        .unwrap_or_else(|| panic!("no {protocol} packets arrived"));
    let (times, levels): (Vec<Instant>, HashSet<u64>) = arrivals
        .iter()
        .filter(|arrival| arrival.universe == universe)
        .map(|arrival| (arrival.at, arrival.levels))
        .unzip();
    let period = Duration::from_secs(1) / RATE_HZ as u32;
    let summary = GridTiming::measure(&times, period)
        .check(RATE_HZ * RUN.as_secs(), &TOLERANCE)
        .unwrap_or_else(|failure| {
            panic!("{protocol} universe {universe} left the output grid: {failure}")
        });
    assert!(
        levels.len() > 1,
        "{protocol} universe {universe} never changed, so the timeline was not driving output"
    );
    format!(
        "universe {universe}, {} distinct looks, {summary}",
        levels.len()
    )
}

/// Collects every packet `parse` accepts on `socket` until `collecting` turns false.
fn receive(
    socket: UdpSocket,
    collecting: &Arc<AtomicBool>,
    parse: PacketParser,
) -> JoinHandle<Vec<Arrival>> {
    let collecting = Arc::clone(collecting);
    let mut buffer = [0u8; 1144];
    // Packets queued during the warm-up would all arrive at once and land in the first tick.
    socket.set_nonblocking(true).expect("set nonblocking");
    while socket.recv(&mut buffer).is_ok() {}
    socket.set_nonblocking(false).expect("set blocking");
    socket
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("set timeout");
    std::thread::spawn(move || {
        let mut arrivals = Vec::new();
        while collecting.load(Ordering::Acquire) {
            let length = match socket.recv(&mut buffer) {
                Ok(length) => length,
                Err(error) if is_timeout(&error) => continue,
                Err(error) => panic!("receiving DMX packets failed: {error}"),
            };
            let at = Instant::now();
            if let Some((universe, levels)) = parse(&buffer[..length]) {
                arrivals.push(Arrival {
                    at,
                    universe,
                    levels: fingerprint(levels),
                });
            }
        }
        arrivals
    })
}

/// Returns the universe and levels of an ArtDmx packet.
fn parse_artnet(packet: &[u8]) -> Option<(u16, &[u8])> {
    let opcode = u16::from_le_bytes(packet.get(8..10)?.try_into().ok()?);
    if !packet.starts_with(b"Art-Net\0") || opcode != 0x5000 {
        return None;
    }
    let universe = u16::from_le_bytes(packet.get(14..16)?.try_into().ok()?);
    let length = usize::from(u16::from_be_bytes(packet.get(16..18)?.try_into().ok()?));
    Some((universe, packet.get(18..18 + length)?))
}

/// Returns the universe and levels of an E1.31 data packet, read at the fixed offsets of its
/// root, framing and DMP layers.
fn parse_sacn(packet: &[u8]) -> Option<(u16, &[u8])> {
    let vector = |offset: usize| -> Option<u32> {
        Some(u32::from_be_bytes(
            packet.get(offset..offset + 4)?.try_into().ok()?,
        ))
    };
    // Root layer VECTOR_ROOT_E131_DATA and framing layer VECTOR_E131_DATA_PACKET.
    if vector(18)? != 0x0000_0004 || vector(40)? != 0x0000_0002 {
        return None;
    }
    let universe = u16::from_be_bytes(packet.get(113..115)?.try_into().ok()?);
    // Levels follow the start code at offset 125.
    Some((universe, packet.get(126..)?))
}

/// Hashes a universe's levels so arrivals can be compared without keeping every packet.
fn fingerprint(levels: &[u8]) -> u64 {
    use std::hash::{BuildHasher, BuildHasherDefault, DefaultHasher};

    BuildHasherDefault::<DefaultHasher>::default().hash_one(levels)
}

/// Returns whether a receive error only means the read timeout passed with no packet.
fn is_timeout(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Checks that the sACN output worker puts packets on the wire on the shared tick grid.

use std::net::UdpSocket;
use std::time::{Duration, Instant};

use nightfall_service_host::prelude::{FixedRatePeriod, GridTiming, GridTolerance};
use sacn::packet::{AcnRootLayerProtocol, E131RootLayerData};

use super::*;

/// Output rate under test, the default DMX output rate.
const RATE_HZ: u32 = 44;
/// How long packets are collected for.
const RUN: Duration = Duration::from_secs(2);
/// How far packets may stray from the grid.
const TOLERANCE: GridTolerance = GridTolerance {
    max_missed_share: 0.0,
    max_p95_lateness: Duration::from_millis(3),
    max_lateness: Duration::from_millis(10),
};

/// Runs the real output worker at 44 Hz over loopback for two seconds and checks the first
/// universe's packets land on the tick grid: one per tick, no skipped ticks, and each within a
/// few milliseconds of its tick.
///
/// Arrival is timed at a loopback receiver, so the lateness includes the socket send and the
/// receiving thread's wake-up as well as the worker's own scheduling. A receiver that wakes
/// late can also read two queued packets within one tick, so this only holds on an otherwise
/// idle machine.
#[test]
#[ignore = "timing-sensitive; run alone with `pnpm run test:packet-timing`"]
fn packets_stay_on_the_output_grid() {
    let receiver = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind receiver");
    receiver
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("set timeout");
    let port = receiver.local_addr().expect("receiver address").port();
    let mut source = SacnSource::with_ip("test", sacn_output_bind_addr(Ipv4Addr::LOCALHOST))
        .expect("open sACN source");
    source.set_is_sending_discovery(false);
    let client = SacnOutputClient::default();
    let period = Duration::from_secs(1) / RATE_HZ;
    // Unicast frames go to the receiver's port, so the test needs no fixed sACN port.
    let mut worker = SacnWorker::start(source, client.clone(), FixedRatePeriod::new(period), port)
        .expect("start worker");
    client.publish(
        [1, 2]
            .map(|universe| SacnFrame {
                universe,
                unicast_ip: Some(Ipv4Addr::LOCALHOST),
                data: [0; MAX_CHANNELS_PER_UNIVERSE],
            })
            .to_vec(),
    );

    let arrivals = first_universe_arrivals(&receiver, RUN);
    worker.shutdown();

    let expected_ticks = u64::from(RATE_HZ) * RUN.as_secs();
    match GridTiming::measure(&arrivals, period).check(expected_ticks, &TOLERANCE) {
        Ok(summary) => println!("sACN packets stayed on grid: {summary}"),
        Err(failure) => panic!("sACN packets left the output grid: {failure}"),
    }
}

/// Receives packets for `run` and returns when each data packet for universe 1 arrived.
fn first_universe_arrivals(receiver: &UdpSocket, run: Duration) -> Vec<Instant> {
    let mut buffer = [0u8; 1144];
    let mut arrivals = Vec::new();
    let end = Instant::now() + run;
    while Instant::now() < end {
        let length = match receiver.recv(&mut buffer) {
            Ok(length) => length,
            Err(error) if is_timeout(&error) => continue,
            Err(error) => panic!("receiving sACN packets failed: {error}"),
        };
        let arrived = Instant::now();
        let Ok(packet) = AcnRootLayerProtocol::parse(&buffer[..length]) else {
            continue;
        };
        if let E131RootLayerData::DataPacket(data) = packet.pdu.data
            && data.universe == 1
        {
            arrivals.push(arrived);
        }
    }
    arrivals
}

/// Returns whether a receive error only means the read timeout passed with no packet.
fn is_timeout(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! uDMX protocol: channel ranges written with USB vendor control transfers.

use std::time::Duration;

use nightfall_dmx::prelude::MAX_CHANNELS_PER_UNIVERSE;
use nusb::MaybeFuture;

use crate::driver::{Universe, WriteOutcome};

/// `bRequest` of the uDMX "set channel range" vendor request.
const UDMX_SET_CHANNEL_RANGE: u8 = 2;

/// Timeout of one control transfer.
const TRANSFER_TIMEOUT: Duration = Duration::from_millis(500);

/// Unchanged channels between two changed runs below which the runs are written as one
/// transfer, since each USB control transfer costs more than a few extra channels.
const RUN_MERGE_GAP: usize = 16;

/// Claimed interface of a uDMX device.
pub(crate) struct UdmxInterface {
    interface: nusb::Interface,
}

impl UdmxInterface {
    /// Opens the device and claims its interface.
    ///
    /// Some uDMX clones need configuration 1 set before the interface can be claimed, while
    /// others reject the request, so it is only set when the first claim fails.
    pub(crate) fn open(device: &nusb::DeviceInfo) -> Option<Self> {
        let opened = match device.open().wait() {
            Ok(device) => device,
            Err(error) => {
                tracing::error!("failed to open uDMX device: {}", error);
                return None;
            }
        };

        if let Ok(interface) = opened.claim_interface(0).wait() {
            return Some(Self { interface });
        }
        if let Err(error) = opened.set_configuration(1).wait() {
            tracing::error!("failed to set uDMX configuration: {}", error);
            return None;
        }
        match opened.claim_interface(0).wait() {
            Ok(interface) => Some(Self { interface }),
            Err(error) => {
                tracing::error!("failed to claim uDMX interface: {}", error);
                None
            }
        }
    }

    /// Writes the channels of `next` that differ from `written`, every channel when `written` is
    /// unknown.
    ///
    /// The uDMX firmware needs roughly 66 ms to take all 512 channels, so writing whole
    /// universes would cap output near 15 Hz; a chase or strobe usually changes a few channels,
    /// which transfer within one tick.
    pub(crate) fn write(&mut self, written: Option<&Universe>, next: &Universe) -> WriteOutcome {
        for (start, end) in changed_runs(written, next) {
            let outcome = self.write_range(start, &next[start..end]);
            if outcome != WriteOutcome::Written {
                return outcome;
            }
        }
        WriteOutcome::Written
    }

    /// Writes `data` to the device's channels starting at zero-based channel `start`.
    fn write_range(&mut self, start: usize, data: &[u8]) -> WriteOutcome {
        let control_out = nusb::transfer::ControlOut {
            control_type: nusb::transfer::ControlType::Vendor,
            recipient: nusb::transfer::Recipient::Interface,
            request: UDMX_SET_CHANNEL_RANGE,
            value: data.len() as u16,
            index: start as u16,
            data,
        };

        match self
            .interface
            .control_out(control_out, TRANSFER_TIMEOUT)
            .wait()
        {
            Ok(()) => WriteOutcome::Written,
            Err(nusb::transfer::TransferError::Disconnected) => WriteOutcome::Disconnected,
            Err(error) => {
                tracing::warn!("uDMX USB transfer failed: {}", error);
                WriteOutcome::Failed
            }
        }
    }
}

/// Returns the channel ranges `start..end` that must be written for a device holding
/// `written` to show `next`, empty when nothing changed.
///
/// Runs of changed channels closer than [`RUN_MERGE_GAP`] are merged, so channels changing far
/// apart in the universe do not turn into one near-full-universe transfer. A device whose
/// contents are unknown gets every channel.
fn changed_runs(written: Option<&Universe>, next: &Universe) -> Vec<(usize, usize)> {
    let Some(written) = written else {
        return vec![(0, MAX_CHANNELS_PER_UNIVERSE)];
    };
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for channel in
        (0..MAX_CHANNELS_PER_UNIVERSE).filter(|&channel| written[channel] != next[channel])
    {
        match runs.last_mut() {
            Some((_, end)) if channel - *end < RUN_MERGE_GAP => *end = channel + 1,
            _ => runs.push((channel, channel + 1)),
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A device whose contents are unknown is sent the whole universe.
    #[test]
    fn changed_runs_without_written_frame_cover_every_channel() {
        let next = [7u8; MAX_CHANNELS_PER_UNIVERSE];
        assert_eq!(
            changed_runs(None, &next),
            vec![(0, MAX_CHANNELS_PER_UNIVERSE)]
        );
    }

    /// An unchanged frame writes nothing, nearby changes share one run, distant changes get
    /// their own runs, and the final channel of the universe is covered.
    #[test]
    fn changed_runs_group_nearby_changes_and_split_distant_ones() {
        let written = [0u8; MAX_CHANNELS_PER_UNIVERSE];
        assert!(changed_runs(Some(&written), &written).is_empty());

        let mut next = written;
        next[3] = 255;
        next[3 + RUN_MERGE_GAP - 1] = 10;
        next[480] = 1;
        next[MAX_CHANNELS_PER_UNIVERSE - 1] = 1;
        assert_eq!(
            changed_runs(Some(&written), &next),
            vec![
                (3, 3 + RUN_MERGE_GAP),
                (480, 481),
                (MAX_CHANNELS_PER_UNIVERSE - 1, MAX_CHANNELS_PER_UNIVERSE),
            ]
        );
    }
}

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    fmt,
    sync::atomic::{AtomicU64, Ordering},
};

use bevy::app::{App, First, Plugin};
use tracing_subscriber::fmt::{
    format::Writer,
    time::{FormatTime, SystemTime as WallClockTimer},
};

static CURRENT_ENGINE_FRAME: AtomicU64 = AtomicU64::new(0);
static NEXT_ENGINE_FRAME: AtomicU64 = AtomicU64::new(0);

/// Preserves wall-clock log timestamps and enriches them with the absolute engine frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct EngineLogTimer;

impl FormatTime for EngineLogTimer {
    /// Write the wall-clock timestamp followed by the absolute engine frame.
    fn format_time(&self, writer: &mut Writer<'_>) -> fmt::Result {
        WallClockTimer.format_time(writer)?;
        write!(
            writer,
            " frame={} ",
            CURRENT_ENGINE_FRAME.load(Ordering::Relaxed)
        )
    }
}

/// Publishes the current Bevy update number for the tracing timestamp formatter.
pub(crate) struct EngineLogTimePlugin;

impl Plugin for EngineLogTimePlugin {
    /// Advance the process-wide frame counter before the main schedules run.
    fn build(&self, app: &mut App) {
        app.add_systems(First, advance_engine_frame);
    }
}

/// Advance the process-wide frame without resetting when a staged world replaces the active world.
fn advance_engine_frame() {
    publish_next_engine_frame(&CURRENT_ENGINE_FRAME, &NEXT_ENGINE_FRAME);
}

/// Publish the next zero-based frame while saturating before integer overflow.
fn publish_next_engine_frame(current_frame: &AtomicU64, next_frame: &AtomicU64) {
    let frame = next_frame
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |frame| {
            Some(frame.saturating_add(1))
        })
        .expect("engine frame update closure always succeeds");
    current_frame.store(frame, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use bevy::app::App;
    use tracing_subscriber::fmt::{format::Writer, time::FormatTime};

    use super::{
        CURRENT_ENGINE_FRAME, EngineLogTimePlugin, EngineLogTimer, publish_next_engine_frame,
    };

    /// Keep the standard wall timestamp while appending the named engine frame.
    #[test]
    fn enriches_wall_timestamp_with_engine_frame() {
        let timer = EngineLogTimer;
        let mut output = String::new();

        timer
            .format_time(&mut Writer::new(&mut output))
            .expect("format enriched log timestamp");

        let (wall_timestamp, frame) = output
            .trim_end()
            .split_once(" frame=")
            .expect("engine frame field");
        assert!(wall_timestamp.contains('T'));
        assert!(wall_timestamp.ends_with('Z'));
        assert!(frame.parse::<u64>().is_ok());
    }

    /// Publish the first engine update as frame zero before advancing subsequent updates.
    #[test]
    fn publishes_zero_based_frames() {
        let current_frame = std::sync::atomic::AtomicU64::new(0);
        let next_frame = std::sync::atomic::AtomicU64::new(0);

        publish_next_engine_frame(&current_frame, &next_frame);
        assert_eq!(current_frame.load(Ordering::Relaxed), 0);

        publish_next_engine_frame(&current_frame, &next_frame);
        assert_eq!(current_frame.load(Ordering::Relaxed), 1);
    }

    /// Keep the process frame monotonic when replacement worlds install the plugin.
    #[test]
    fn preserves_frame_across_plugin_reinstallation() {
        let before_initial_install = CURRENT_ENGINE_FRAME.load(Ordering::Relaxed);
        let mut initial_app = App::new();
        initial_app.add_plugins(EngineLogTimePlugin);
        let after_initial_install = CURRENT_ENGINE_FRAME.load(Ordering::Relaxed);
        initial_app.update();
        let after_initial_update = CURRENT_ENGINE_FRAME.load(Ordering::Relaxed);

        let mut replacement_app = App::new();
        replacement_app.add_plugins(EngineLogTimePlugin);
        let after_replacement_install = CURRENT_ENGINE_FRAME.load(Ordering::Relaxed);
        replacement_app.update();
        let after_replacement_update = CURRENT_ENGINE_FRAME.load(Ordering::Relaxed);

        assert!(after_initial_install >= before_initial_install);
        assert!(after_initial_update >= after_initial_install);
        assert!(after_replacement_install >= after_initial_update);
        assert!(after_replacement_update > after_replacement_install);
    }
}

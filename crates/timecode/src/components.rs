// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Timecode components
use std::time::Duration;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;

use crate::prelude::*;

/// Component for an active timecode generator in the ECS
#[derive(Component, Debug, Clone)]
pub struct TimecodeGenerator {
    /// The timecode data
    pub timecode: Timecode,
    /// The timecode state
    pub state: TimecodeState,
    /// The accumulated time
    pub accumulated_time: Duration,
}

impl Default for TimecodeGenerator {
    fn default() -> Self {
        let timecode = Timecode {
            identifiers: Identifiers {
                id: 1,
                uid: uuid::Uuid::new_v4(),
                label: "Default".to_string(),
            },
            rate: TimecodeRate::Fps30,
            source: TimecodeSource::Internal,
        };

        let state = TimecodeState {
            timecode_id: 1,
            is_active: false,
            current_time: Duration::ZERO,
            start_time: None,
            end_time: None,
        };

        Self {
            timecode,
            state,
            accumulated_time: Duration::ZERO,
        }
    }
}

impl TimecodeGenerator {
    /// Create a new timecode generator
    pub fn new(timecode: Timecode) -> Self {
        let state = TimecodeState {
            timecode_id: timecode.identifiers.id,
            is_active: false,
            current_time: Duration::ZERO,
            start_time: None,
            end_time: None,
        };

        Self {
            timecode,
            state,
            accumulated_time: Duration::ZERO,
        }
    }

    /// Start the timecode generator
    pub fn start(&mut self) {
        if !self.state.is_active {
            self.state.is_active = true;
        }
    }

    /// Pause the timecode generator
    pub fn pause(&mut self) {
        if self.state.is_active {
            self.state.is_active = false;
        }
    }

    /// Stop the timecode generator
    pub fn stop(&mut self) {
        self.state.is_active = false;
        self.accumulated_time = Duration::ZERO;
        self.state.current_time = Duration::ZERO;
    }

    /// Seek the timecode generator to a specific time
    pub fn seek(&mut self, time: Duration) {
        self.accumulated_time = time;
        self.state.current_time = time;
    }

    /// Update the timecode generator based on elapsed time
    pub fn update(&mut self, delta: Duration) {
        if self.state.is_active {
            self.accumulated_time += delta;
            self.state.current_time = self.accumulated_time;

            // Check if we've reached the end time
            if let Some(end_time) = self.state.end_time
                && self.accumulated_time >= end_time
            {
                self.stop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_timecode_generator() {
        let timecode = Timecode {
            identifiers: Identifiers {
                id: 2,
                uid: uuid::Uuid::new_v4(),
                label: "Test".to_string(),
            },
            rate: TimecodeRate::Fps24,
            source: TimecodeSource::Internal,
        };

        let generator = TimecodeGenerator::new(timecode.clone());

        assert_eq!(generator.timecode.identifiers.id, 2);
        assert_eq!(generator.timecode.identifiers.label, "Test");
        assert_eq!(generator.state.timecode_id, 2);
        assert!(!generator.state.is_active);
        assert_eq!(generator.state.current_time, Duration::ZERO);
        assert_eq!(generator.accumulated_time, Duration::ZERO);
    }

    #[test]
    fn test_start_stop() {
        let mut generator = TimecodeGenerator::default();

        // Test start
        generator.start();
        assert!(generator.state.is_active);

        // Test stop
        generator.stop();
        assert!(!generator.state.is_active);
        assert_eq!(generator.accumulated_time, Duration::ZERO);
        assert_eq!(generator.state.current_time, Duration::ZERO);
    }

    #[test]
    fn test_pause_resume() {
        let mut generator = TimecodeGenerator::default();

        generator.start();
        generator.update(Duration::from_millis(50));
        generator.pause();

        assert!(!generator.state.is_active);
        let paused_time = generator.accumulated_time;
        assert!(paused_time > Duration::ZERO);

        // Time should not advance while paused
        generator.update(Duration::from_millis(50));
        assert_eq!(generator.accumulated_time, paused_time);

        // Resume and check time advances
        generator.start();
        generator.update(Duration::from_millis(50));
        assert!(generator.accumulated_time > paused_time);
    }

    #[test]
    fn test_seek() {
        let mut generator = TimecodeGenerator::default();
        let target_time = Duration::from_secs(5);

        generator.seek(target_time);
        assert_eq!(generator.accumulated_time, target_time);
        assert_eq!(generator.state.current_time, target_time);
    }

    #[test]
    fn test_update_with_end_time() {
        let mut generator = TimecodeGenerator::default();
        let end_time = Duration::from_millis(100);
        generator.state.end_time = Some(end_time);

        generator.start();
        generator.update(Duration::from_millis(110));

        // Generator should have stopped automatically
        assert!(!generator.state.is_active);
        assert_eq!(generator.accumulated_time, Duration::ZERO);
        assert_eq!(generator.state.current_time, Duration::ZERO);
    }

    #[test]
    fn test_time_accumulation() {
        let mut generator = TimecodeGenerator::default();

        generator.start();
        generator.update(Duration::from_millis(50));

        let first_duration = generator.accumulated_time;
        assert!(first_duration > Duration::ZERO);

        generator.update(Duration::from_millis(50));

        assert!(generator.accumulated_time > first_duration);
    }
}

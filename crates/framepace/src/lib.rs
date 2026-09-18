// Based on https://github.com/aevyrie/bevy_framepace
//
// MIT License

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
//! This is a `bevy` plugin that adds framepacing and framelimiting to improve input latency and
//! power use.
//!
//! # How it works
//!
//! This works by sleeping the app immediately before the event loop starts. In doing so, this
//! minimizes the time from when user input is captured (start of event loop), to when the frame is
//! presented on screen. Graphically, it looks like this:
//!
//! ```none
//!           /-- latency --\             /-- latency --\
//!  sleep -> input -> render -> sleep -> input -> render
//!  \----- event loop -----/    \----- event loop -----/
//! ```
//!
//! One of the interesting benefits of this is that you can keep latency low even if the framerate
//! is limited to a low value. Assuming you are able to reach the target frametime, there should be
//! no difference in motion-to-photon latency when limited to 10fps or 120fps.
//!
//! ```none
//!                same                                              same
//!           /-- latency --\                                   /-- latency --\
//!  sleep -> input -> render -> sleeeeeeeeeeeeeeeeeeeeeeeep -> input -> render
//!  \----- event loop -----/    \---------------- event loop ----------------/
//!           60 fps                           limited to 10 fps
//! ```

#![warn(missing_docs)]

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
    time::{Duration, Instant},
};

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use bevy_reflect::prelude::*;
use nightfall_engine::prelude::*;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::FramePaceStats;
    pub use crate::FramepacePlugin;
    pub use crate::FramepaceSettings;
    pub use crate::Limiter;
}

/// Adds framepacing and framelimiting functionality to your [`App`].
#[derive(Debug, Clone, Component)]
pub struct FramepacePlugin;
impl Plugin for FramepacePlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering FramepacePlugin");
        app.register_type::<FramepaceSettings>();

        let settings = FramepaceSettings::default();
        let stats = FramePaceStats::default();

        app.insert_resource(settings);
        app.insert_resource(FrameTimer::default());
        app.insert_resource(stats.clone());
        app.add_systems(Update, handle_events.in_set(EventHandling));
        app.add_systems(PostUpdate, framerate_limiter);
    }
}

/// Handles engine commands to update framepace settings.
pub fn handle_events(
    mut events: MessageReader<CommandEnvelope<EngineCommand>>,
    mut framepace: ResMut<FramepaceSettings>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        if let EngineCommand::SetFps(fps) = &event.command {
            if *fps == 0 {
                tracing::debug!("Disabling frame target (unlimited fps)");
                framepace.limiter = Limiter::Off;
            } else {
                tracing::debug!("Setting frame target to {} fps", fps);
                framepace.limiter = Limiter::from_framerate(*fps as f64);
            }
            if let Err(error) = responder.succeed(event.command_id) {
                tracing::error!(command_id = %event.command_id, %error, "set_fps_completion_failed");
            }
        }
    }
}

/// Framepacing plugin configuration.
#[derive(Debug, Clone, Resource, Reflect)]
#[reflect(Resource)]
pub struct FramepaceSettings {
    /// Configures the framerate limiting strategy.
    pub limiter: Limiter,
}
impl FramepaceSettings {
    /// Builds plugin settings with the specified [`Limiter`] configuration.
    pub fn with_limiter(mut self, limiter: Limiter) -> Self {
        self.limiter = limiter;
        self
    }
}
impl Default for FramepaceSettings {
    fn default() -> FramepaceSettings {
        FramepaceSettings {
            limiter: Limiter::Off,
        }
    }
}

/// Configures the framelimiting technique for the app.
#[derive(Debug, Default, Clone, Reflect)]
pub enum Limiter {
    /// Set a fixed manual frametime limit. This should be greater than the monitors frametime
    /// (`1.0 / monitor frequency`).
    Manual(Duration),
    /// Disables frame limiting
    #[default]
    Off,
}

impl Limiter {
    /// Returns `true` if the [`Limiter`] is enabled.
    pub fn is_enabled(&self) -> bool {
        !matches!(self, Limiter::Off)
    }

    /// Constructs a new [`Limiter`] from the provided `framerate`.
    pub fn from_framerate(framerate: f64) -> Self {
        Limiter::Manual(Duration::from_secs_f64(1.0 / framerate))
    }
}

impl std::fmt::Display for Limiter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Limiter::Manual(t) => write!(f, "{:.2} fps", 1.0 / t.as_secs_f32()),
            Limiter::Off => write!(f, "Off"),
        }
    }
}

/// Current frametime limit based on settings and monitor refresh rate.
#[derive(Debug, Default, Clone, Resource)]
pub struct FrametimeLimit(pub Arc<Mutex<Duration>>);

/// Tracks the instant of the end of the previous frame.
#[derive(Debug, Clone, Resource)]
pub struct FrameTimer {
    sleep_end: Instant,
}
impl Default for FrameTimer {
    fn default() -> Self {
        FrameTimer {
            sleep_end: Instant::now(),
        }
    }
}

/// Holds frame time measurements for framepacing diagnostics
#[derive(Clone, Debug, Resource)]
pub struct FramePaceStats {
    frametime: Arc<Mutex<Duration>>,
    oversleep: Arc<Mutex<Duration>>,
    /// EMA of sleep error (actual - requested) in nanoseconds.
    avg_sleep_error_ns: Arc<AtomicI64>,
}

impl Default for FramePaceStats {
    fn default() -> Self {
        FramePaceStats {
            frametime: Arc::new(Mutex::new(Duration::ZERO)),
            oversleep: Arc::new(Mutex::new(Duration::ZERO)),
            avg_sleep_error_ns: Arc::new(AtomicI64::new(0)),
        }
    }
}

impl FramePaceStats {
    /// Returns the frame time duration, or None if the lock cannot be acquired
    pub fn frametime(&self) -> Option<Duration> {
        self.frametime.try_lock().ok().map(|guard| *guard)
    }

    /// Returns the oversleep duration, or None if the lock cannot be acquired
    pub fn oversleep(&self) -> Option<Duration> {
        self.oversleep.try_lock().ok().map(|guard| *guard)
    }

    /// Returns the current EMA sleep error in nanoseconds.
    pub fn avg_sleep_error_ns(&self) -> i64 {
        self.avg_sleep_error_ns.load(Ordering::Relaxed)
    }
}

/// Accurately sleeps until it's time to start the next frame.
///
/// The `spin_sleep` dependency makes it possible to get extremely accurate sleep times across
/// platforms. Using `std::thread::sleep()` will not be precise enough, especially windows. Using a
/// spin lock, even with `std::hint::spin_loop()`, will result in significant power usage.
///
/// `spin_sleep` sleeps as long as possible given the platform's sleep accuracy, and spins for the
/// remainder. The dependency is however not WASM compatible, which is fine, because frame limiting
/// should not be used in a browser; this would compete with the browser's frame limiter.
#[allow(unused_variables)]
fn framerate_limiter(
    mut timer: ResMut<FrameTimer>,
    stats: Res<FramePaceStats>,
    settings: Res<FramepaceSettings>,
) {
    let frame_target = match settings.limiter {
        Limiter::Manual(target) => target,
        Limiter::Off => Duration::ZERO,
    };

    let frame_time = timer.sleep_end.elapsed();
    #[cfg(not(target_arch = "wasm32"))]
    {
        let oversleep = stats
            .oversleep
            .try_lock()
            .as_deref()
            .cloned()
            .unwrap_or_default();

        // Read EMA of previous sleep error (ns). We'll treat negative avg as zero compensation.
        let avg_err_ns = stats.avg_sleep_error_ns.load(Ordering::Relaxed);
        let compensation = if avg_err_ns > 0 {
            Duration::from_nanos(avg_err_ns as u64)
        } else {
            Duration::ZERO
        };

        // Compensate requested sleep by EMA of previous sleep error.
        let sleep_time = frame_target.saturating_sub(frame_time + oversleep + compensation);
        if settings.limiter.is_enabled() {
            let before_sleep = Instant::now();
            spin_sleep::sleep(sleep_time);
            let after_sleep = Instant::now();
            let actual_sleep = after_sleep.duration_since(before_sleep);

            tracing::trace!(
                ?frame_target,
                ?frame_time,
                prev_oversleep = ?oversleep,
                compensation_ns = avg_err_ns,
                requested_sleep = ?sleep_time,
                ?actual_sleep,
                "Frame limiter sleep completed"
            );

            // Update EMA of sleep error (actual - requested) in ns using integer alpha=1/5.
            let requested_ns = sleep_time.as_nanos() as i64;
            let actual_ns = actual_sleep.as_nanos() as i64;
            let error = actual_ns - requested_ns;
            let old = stats.avg_sleep_error_ns.load(Ordering::Relaxed);
            let new = old + ((error - old) / 5); // alpha ~= 0.2
            stats.avg_sleep_error_ns.store(new, Ordering::Relaxed);
        }
    }

    let frame_time_total = timer.sleep_end.elapsed();
    timer.sleep_end = Instant::now();
    if let Ok(mut frametime) = stats.frametime.try_lock() {
        *frametime = frame_time;
    }
    if let Ok(mut oversleep) = stats.oversleep.try_lock() {
        *oversleep = frame_time_total.saturating_sub(frame_target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies that setting frame pace mutates state before completing the command.
    #[test]
    fn set_fps_mutates_and_returns_success() {
        let mut app = App::new();
        app.insert_resource(FramepaceSettings::default());
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<EngineCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(Update, handle_events);
        let command = CommandEnvelope::new(
            EngineCommand::SetFps(60),
            CommandOrigin::WebUi,
            ReplyTarget::ClientBroadcast,
        );
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&command)
            .unwrap();
        app.world_mut().write_message(command);

        app.update();

        assert!(matches!(
            app.world().resource::<FramepaceSettings>().limiter,
            Limiter::Manual(_)
        ));
        let result = app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("set fps should publish one result");
        assert_eq!(result.outcome, CommandOutcome::succeeded());
    }
}

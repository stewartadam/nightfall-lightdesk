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
//!
//! Regular frames start on the shared tick grid from [`nightfall_service_host::tick_grid`], which
//! the DMX output workers also transmit on. A [`FrameWaker`] wake (sent when a command arrives)
//! ends the sleep early so the command is handled without waiting for the next tick. Early frames
//! leave the grid unchanged, and DMX output keeps its own fixed rate, so they only cost CPU time.

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
#[cfg(not(target_arch = "wasm32"))]
use nightfall_service_host::prelude::next_grid_tick;

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
#[derive(Debug, Default, Clone, PartialEq, Eq, Reflect)]
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

/// Earliest an early (command-woken) frame may start after the previous frame started.
///
/// Bounds what a burst of commands can cost to a few extra frames per tick.
#[cfg(not(target_arch = "wasm32"))]
const EARLY_FRAME_MIN_INTERVAL: Duration = Duration::from_millis(5);

/// Final stretch before a tick that is slept with `spin_sleep`, so regular frames start
/// precisely on the tick. A wake arriving inside it waits for the tick.
#[cfg(not(target_arch = "wasm32"))]
const SPIN_TAIL: Duration = Duration::from_millis(2);

/// Final stretch before a tick that is not left to the condition variable wait.
///
/// On Windows that wait is only as precise as the system timer (about 15.6 ms by default), so
/// the stretch between this and [`SPIN_TAIL`] is slept in short high-resolution native sleeps
/// that check for wakes in between.
#[cfg(windows)]
const PRECISE_TAIL: Duration = Duration::from_millis(16);
#[cfg(not(any(windows, target_arch = "wasm32")))]
const PRECISE_TAIL: Duration = SPIN_TAIL;

/// Native sleep slice used to poll for wakes between [`PRECISE_TAIL`] and [`SPIN_TAIL`].
#[cfg(not(target_arch = "wasm32"))]
const WAKE_POLL_INTERVAL: Duration = Duration::from_millis(1);

/// Tracks when the current frame started and which tick the next regular frame starts on.
#[derive(Debug, Clone, Resource)]
pub struct FrameTimer {
    /// When the current frame started, after the previous limiter sleep.
    frame_start: Instant,
    /// The grid tick the next regular frame starts on, with the period it was computed for.
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    next_tick: Option<(Instant, Duration)>,
    /// [`FrameWaker`] generation observed when the current frame started. A newer generation
    /// means a command arrived since, so the next frame starts early. `None` until the first
    /// frame, so wakes from before this world existed do not start an early frame.
    seen_wake: Option<u64>,
}
impl Default for FrameTimer {
    fn default() -> Self {
        FrameTimer {
            frame_start: Instant::now(),
            next_tick: None,
            seen_wake: None,
        }
    }
}

/// Holds frame time measurements for framepacing diagnostics
#[derive(Clone, Debug, Resource)]
pub struct FramePaceStats {
    frametime: Arc<Mutex<Duration>>,
    oversleep: Arc<Mutex<Duration>>,
    overrun: Arc<Mutex<Duration>>,
    /// EMA of sleep error (actual - requested) in nanoseconds.
    avg_sleep_error_ns: Arc<AtomicI64>,
}

impl Default for FramePaceStats {
    fn default() -> Self {
        FramePaceStats {
            frametime: Arc::new(Mutex::new(Duration::ZERO)),
            oversleep: Arc::new(Mutex::new(Duration::ZERO)),
            overrun: Arc::new(Mutex::new(Duration::ZERO)),
            avg_sleep_error_ns: Arc::new(AtomicI64::new(0)),
        }
    }
}

impl FramePaceStats {
    /// Returns the frame time duration, or None if the lock cannot be acquired
    pub fn frametime(&self) -> Option<Duration> {
        self.frametime.try_lock().ok().map(|guard| *guard)
    }

    /// Returns how much longer the limiter's last sleep took than it requested, or None if the
    /// lock cannot be acquired. This is zero when the limiter did not need to sleep.
    pub fn oversleep(&self) -> Option<Duration> {
        self.oversleep.try_lock().ok().map(|guard| *guard)
    }

    /// Returns how far the last frame's work exceeded the frame target, or None if the lock cannot
    /// be acquired. This is zero when the frame fit its budget or the limiter is off.
    pub fn overrun(&self) -> Option<Duration> {
        self.overrun.try_lock().ok().map(|guard| *guard)
    }

    /// Returns the current EMA sleep error in nanoseconds.
    pub fn avg_sleep_error_ns(&self) -> i64 {
        self.avg_sleep_error_ns.load(Ordering::Relaxed)
    }
}

/// Accurately sleeps until the next tick, or until a command wakes the engine.
///
/// The `spin_sleep` dependency makes it possible to get extremely accurate sleep times across
/// platforms. Using `std::thread::sleep()` will not be precise enough, especially windows. Using a
/// spin lock, even with `std::hint::spin_loop()`, will result in significant power usage.
///
/// `spin_sleep` sleeps as long as possible given the platform's sleep accuracy, and spins for the
/// remainder. The dependency is however not WASM compatible, which is fine, because frame limiting
/// should not be used in a browser; this would compete with the browser's frame limiter.
///
/// Regular frames start on the tick grid shared with DMX output (see
/// [`nightfall_service_host::tick_grid`]). A [`FrameWaker`] wake newer than the one observed at the
/// start of this frame starts the next frame early, no sooner than [`EARLY_FRAME_MIN_INTERVAL`]
/// after this one started, and leaves the pending tick in place.
#[allow(unused_variables, unused_mut)]
fn framerate_limiter(
    mut timer: ResMut<FrameTimer>,
    stats: Res<FramePaceStats>,
    settings: Res<FramepaceSettings>,
    waker: Option<Res<FrameWaker>>,
) {
    let frame_target = match settings.limiter {
        Limiter::Manual(target) => target,
        Limiter::Off => Duration::ZERO,
    };

    let frame_time = timer.frame_start.elapsed();
    let mut oversleep = Duration::ZERO;
    #[cfg(not(target_arch = "wasm32"))]
    if settings.limiter.is_enabled() {
        let tick = match timer.next_tick {
            Some((tick, period)) if period == frame_target => tick,
            _ => next_grid_tick(frame_target, timer.frame_start),
        };

        // Read EMA of previous sleep error (ns). We'll treat negative avg as zero compensation.
        let avg_err_ns = stats.avg_sleep_error_ns.load(Ordering::Relaxed);
        let compensation = if avg_err_ns > 0 {
            Duration::from_nanos(avg_err_ns as u64)
        } else {
            Duration::ZERO
        };

        // Compensate the wake-up time by the EMA of previous sleep error.
        let wake_at = tick.checked_sub(compensation).unwrap_or(tick);
        let before_sleep = Instant::now();
        let woke_early = sleep_until_tick_or_wake(
            wake_at,
            timer.frame_start + EARLY_FRAME_MIN_INTERVAL,
            waker.as_deref(),
            timer
                .seen_wake
                .or_else(|| waker.as_deref().map(FrameWaker::generation))
                .unwrap_or_default(),
        );
        let after_sleep = Instant::now();

        if woke_early {
            timer.next_tick = Some((tick, frame_target));
        } else {
            timer.next_tick = Some((
                next_grid_tick(frame_target, tick.max(after_sleep)),
                frame_target,
            ));
            if before_sleep < wake_at {
                oversleep = after_sleep.saturating_duration_since(wake_at);

                // Update EMA of sleep error (actual - requested) in ns using integer alpha=1/5.
                let error = after_sleep.duration_since(before_sleep).as_nanos() as i64
                    - wake_at.duration_since(before_sleep).as_nanos() as i64;
                let old = stats.avg_sleep_error_ns.load(Ordering::Relaxed);
                let new = old + ((error - old) / 5); // alpha ~= 0.2
                stats.avg_sleep_error_ns.store(new, Ordering::Relaxed);
            }
        }

        tracing::trace!(
            ?frame_target,
            ?frame_time,
            compensation_ns = avg_err_ns,
            woke_early,
            slept = ?after_sleep.duration_since(before_sleep),
            "Frame limiter sleep completed"
        );
    }

    timer.frame_start = Instant::now();
    timer.seen_wake = waker.as_deref().map(FrameWaker::generation);
    if let Ok(mut frametime) = stats.frametime.try_lock() {
        *frametime = frame_time;
    }
    if let Ok(mut stat) = stats.oversleep.try_lock() {
        *stat = oversleep;
    }
    if let Ok(mut overrun) = stats.overrun.try_lock() {
        *overrun = if settings.limiter.is_enabled() {
            frame_time.saturating_sub(frame_target)
        } else {
            Duration::ZERO
        };
    }
}

/// Sleeps until `wake_at`, returning `true` instead once a wake newer than `seen` has arrived and
/// `earliest_early` has passed.
///
/// Most of the sleep blocks on the waker's condition variable so a wake ends it at once. The last
/// [`SPIN_TAIL`] is left to `spin_sleep` so regular frames start precisely on the tick; on
/// platforms where the condition variable is coarse, the stretch up to [`PRECISE_TAIL`] is slept
/// in [`WAKE_POLL_INTERVAL`] native sleeps.
#[cfg(not(target_arch = "wasm32"))]
fn sleep_until_tick_or_wake(
    wake_at: Instant,
    earliest_early: Instant,
    waker: Option<&FrameWaker>,
    seen: u64,
) -> bool {
    loop {
        let now = Instant::now();
        if now >= wake_at {
            return false;
        }
        let woken = waker.is_some_and(|waker| waker.generation() != seen);
        if woken && now >= earliest_early {
            return true;
        }

        let until = if woken {
            earliest_early.min(wake_at)
        } else {
            wake_at
        };
        let remaining = until - now;
        match waker {
            Some(waker) if !woken && remaining > PRECISE_TAIL => {
                waker.wait_timeout(seen, remaining - PRECISE_TAIL);
            }
            Some(_) if !woken && remaining > SPIN_TAIL => {
                spin_sleep::native_sleep(WAKE_POLL_INTERVAL.min(remaining - SPIN_TAIL));
            }
            _ => spin_sleep::sleep(remaining),
        }
    }
}

#[cfg(test)]
mod tests {
    use nightfall_service_host::prelude::grid_epoch;

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

    /// Builds an app that runs `work` of busy time each frame, followed by the frame limiter
    /// capped at `fps`.
    fn limited_app(fps: f64, work: Duration) -> App {
        let mut app = App::new();
        app.insert_resource(
            FramepaceSettings::default().with_limiter(Limiter::from_framerate(fps)),
        );
        app.insert_resource(FrameTimer::default());
        app.insert_resource(FramePaceStats::default());
        app.add_systems(Update, move || std::thread::sleep(work));
        app.add_systems(PostUpdate, framerate_limiter);
        app
    }

    /// Verifies that frames exceeding their budget report the excess as overrun, not oversleep,
    /// since the limiter requests no sleep for them.
    #[test]
    fn over_budget_frames_report_overrun_not_oversleep() {
        let mut app = limited_app(100.0, Duration::from_millis(30));
        for _ in 0..5 {
            app.update();
        }

        let stats = app.world().resource::<FramePaceStats>();
        let oversleep = stats.oversleep().unwrap();
        let overrun = stats.overrun().unwrap();
        assert!(
            oversleep < Duration::from_millis(5),
            "limiter should not sleep past an over-budget frame, got {oversleep:?}"
        );
        assert!(
            overrun >= Duration::from_millis(15),
            "30 ms of work against a 10 ms target should overrun by about 20 ms, got {overrun:?}"
        );
    }

    /// Verifies that frames within budget are paced to the target frame time with no overrun.
    #[test]
    fn under_budget_frames_are_paced_to_target() {
        let mut app = limited_app(50.0, Duration::from_millis(2));
        app.update();

        let frames = 10;
        let start = Instant::now();
        for _ in 0..frames {
            app.update();
        }
        let average = start.elapsed() / frames;

        let stats = app.world().resource::<FramePaceStats>();
        assert_eq!(stats.overrun().unwrap(), Duration::ZERO);
        assert!(
            average >= Duration::from_millis(18) && average <= Duration::from_millis(25),
            "frames should average about 20 ms, got {average:?}"
        );
    }

    /// Builds a limited app with no per-frame work whose limiter listens to a [`FrameWaker`].
    fn wakeable_app(fps: f64) -> (App, FrameWaker) {
        let mut app = limited_app(fps, Duration::ZERO);
        let waker = FrameWaker::default();
        app.insert_resource(waker.clone());
        (app, waker)
    }

    /// Verifies that a wake ends the limiter sleep early and that the pending tick is kept, so the
    /// following regular frame still starts on the original grid.
    #[test]
    fn wake_starts_frame_early_without_moving_the_tick() {
        let (mut app, waker) = wakeable_app(10.0);
        app.update();

        let start = Instant::now();
        let remote = waker.clone();
        let handle = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            remote.wake();
        });
        app.update();
        let early = start.elapsed();
        handle.join().expect("waking thread should finish");
        assert!(
            early < Duration::from_millis(60),
            "a wake 20 ms into a 100 ms sleep should end it early, took {early:?}"
        );

        app.update();
        let through_tick = start.elapsed();
        assert!(
            through_tick <= Duration::from_millis(110),
            "the frame after an early frame should start on the original tick, took {through_tick:?}"
        );
    }

    /// Verifies that a wake already pending when the limiter runs still waits out the minimum
    /// interval after the previous frame started.
    #[test]
    fn early_frames_respect_minimum_interval() {
        let (mut app, waker) = wakeable_app(10.0);
        app.update();

        let start = Instant::now();
        waker.wake();
        app.update();
        let elapsed = start.elapsed();
        assert!(
            elapsed >= EARLY_FRAME_MIN_INTERVAL.saturating_sub(Duration::from_millis(1))
                && elapsed < Duration::from_millis(50),
            "a pending wake should start the next frame after about {EARLY_FRAME_MIN_INTERVAL:?}, took {elapsed:?}"
        );
    }

    /// Verifies that regular frames start on the shared grid so they stay in phase with DMX output.
    ///
    /// The limiter wakes up to its sleep-error compensation before the tick, so the frame may
    /// start just before or just after a grid tick.
    #[test]
    fn regular_frames_start_on_grid_ticks() {
        let mut app = limited_app(50.0, Duration::ZERO);
        app.update();
        app.update();

        let period = Duration::from_millis(20);
        let since_epoch = Instant::now().saturating_duration_since(grid_epoch());
        let phase = Duration::from_nanos((since_epoch.as_nanos() % period.as_nanos()) as u64);
        let distance = phase.min(period - phase);
        assert!(
            distance < Duration::from_millis(3),
            "a frame should start next to a grid tick, got phase {phase:?}"
        );
    }
}

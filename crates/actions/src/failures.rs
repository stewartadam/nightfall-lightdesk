// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Decides which invocation failures reach clients.
//!
//! Discrete input (triggers, presses, releases) is operator-paced, so every failure is
//! published. Continuous scalar input from a fader can arrive hundreds of times per second;
//! a fader bound to a deleted master must not flood clients with identical failures.

use std::collections::HashMap;
use std::time::Duration;

use bevy_ecs::prelude::Resource;
use web_time::Instant;

use crate::invocation::{ActionInput, ActionInvocation, InvocationOutcome};

/// Interval during which a repeated scalar failure with the same code is not re-published.
pub const FAILURE_REPEAT_WINDOW: Duration = Duration::from_secs(5);

/// Number of tracked bindings above which expired entries are pruned.
const PRUNE_THRESHOLD: usize = 256;

/// Last failure published for one continuous binding.
#[derive(Debug, Clone)]
struct PublishedFailure {
    /// Failure code most recently published for the binding.
    code: String,
    /// When that failure was published.
    published_at: Instant,
}

/// Rate limiter for failures produced by continuous scalar input.
///
/// A scalar failure is published when it is the first failure for its binding, when its code
/// differs from the last published code, or when the repeat window has elapsed. Any
/// non-failed outcome for the binding clears its entry, so the next failure after a recovery
/// is published immediately.
#[derive(Debug, Resource)]
pub struct InvocationFailureThrottle {
    /// Interval during which an identical failure is suppressed.
    window: Duration,
    /// Last published failure keyed by surface and action reference.
    published: HashMap<String, PublishedFailure>,
}

impl Default for InvocationFailureThrottle {
    /// Creates a throttle using [`FAILURE_REPEAT_WINDOW`].
    fn default() -> Self {
        Self::with_window(FAILURE_REPEAT_WINDOW)
    }
}

impl InvocationFailureThrottle {
    /// Creates a throttle that suppresses identical scalar failures for `window`.
    pub fn with_window(window: Duration) -> Self {
        Self {
            window,
            published: HashMap::new(),
        }
    }

    /// Records one invocation outcome and returns whether its failure should be published.
    ///
    /// Returns `false` for every non-failed outcome.
    pub fn admit(
        &mut self,
        invocation: &ActionInvocation,
        outcome: &InvocationOutcome,
        now: Instant,
    ) -> bool {
        if !matches!(invocation.input, ActionInput::Scalar(_)) {
            return matches!(outcome, InvocationOutcome::Failed(_));
        }
        let InvocationOutcome::Failed(error) = outcome else {
            if !self.published.is_empty() {
                self.published.remove(&binding_key(invocation));
            }
            return false;
        };
        let key = binding_key(invocation);
        if let Some(previous) = self.published.get(&key)
            && previous.code == error.code
            && now.saturating_duration_since(previous.published_at) < self.window
        {
            return false;
        }
        if self.published.len() >= PRUNE_THRESHOLD {
            let window = self.window;
            self.published
                .retain(|_, entry| now.saturating_duration_since(entry.published_at) < window);
        }
        self.published.insert(
            key,
            PublishedFailure {
                code: error.code.clone(),
                published_at: now,
            },
        );
        true
    }
}

/// Identifies the binding behind a scalar invocation by surface and action reference.
///
/// The source label is excluded because OSC senders may change ports between packets while
/// still driving the same mapping.
fn binding_key(invocation: &ActionInvocation) -> String {
    format!(
        "{}|{}|{}",
        invocation.surface.label(),
        invocation.action.id.as_str(),
        invocation.action.arguments
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::descriptor::ActionSurface;
    use crate::invocation::{ActionReference, InvocationError};

    /// Builds a scalar invocation for a master level binding.
    fn fader(master: u32, value: f32) -> ActionInvocation {
        ActionInvocation::scalar(
            ActionReference::new("master.level", json!({ "master": master })),
            ActionSurface::Midi,
            value,
        )
    }

    /// Builds a failed outcome with the given code.
    fn failed(code: &str) -> InvocationOutcome {
        InvocationOutcome::Failed(InvocationError::new(code, "failure"))
    }

    /// Verifies a repeated fader failure is published once until the repeat window elapses.
    #[test]
    fn repeated_scalar_failure_is_suppressed_within_window() {
        let mut throttle = InvocationFailureThrottle::with_window(Duration::from_secs(5));
        let start = Instant::now();

        assert!(throttle.admit(&fader(1, 0.1), &failed("master.not_found"), start));
        assert!(!throttle.admit(
            &fader(1, 0.2),
            &failed("master.not_found"),
            start + Duration::from_millis(10)
        ));
        assert!(!throttle.admit(
            &fader(1, 0.3),
            &failed("master.not_found"),
            start + Duration::from_secs(4)
        ));
        assert!(throttle.admit(
            &fader(1, 0.4),
            &failed("master.not_found"),
            start + Duration::from_secs(5)
        ));
    }

    /// Verifies a changed failure code or a different binding is published immediately.
    #[test]
    fn scalar_failure_publishes_on_code_or_binding_change() {
        let mut throttle = InvocationFailureThrottle::default();
        let now = Instant::now();

        assert!(throttle.admit(&fader(1, 0.1), &failed("master.not_found"), now));
        assert!(throttle.admit(&fader(1, 0.1), &failed("action.not_registered"), now));
        assert!(throttle.admit(&fader(2, 0.1), &failed("action.not_registered"), now));
        assert!(!throttle.admit(&fader(2, 0.5), &failed("action.not_registered"), now));
    }

    /// Verifies a successful scalar outcome resets the binding so the next failure publishes.
    #[test]
    fn scalar_success_resets_binding() {
        let mut throttle = InvocationFailureThrottle::default();
        let now = Instant::now();

        assert!(throttle.admit(&fader(1, 0.1), &failed("master.not_found"), now));
        assert!(!throttle.admit(
            &fader(1, 0.2),
            &InvocationOutcome::Succeeded { output: None },
            now
        ));
        assert!(throttle.admit(&fader(1, 0.3), &failed("master.not_found"), now));
    }

    /// Verifies discrete failures are always published, however quickly they repeat.
    #[test]
    fn discrete_failures_are_never_suppressed() {
        let mut throttle = InvocationFailureThrottle::default();
        let now = Instant::now();
        let press = ActionInvocation::new(
            ActionReference::new("clip.start", json!({ "clip": 1 })),
            ActionSurface::Keyboard,
            ActionInput::Press,
        );

        for _ in 0..3 {
            assert!(throttle.admit(&press, &failed("clip.not_found"), now));
        }
        assert!(!throttle.admit(&press, &InvocationOutcome::Ignored, now));
    }
}

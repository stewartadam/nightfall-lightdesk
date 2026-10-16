// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Live state of the target an action addresses, for controller LEDs, motor faders and
//! on-screen buttons.
//!
//! Feedback is a binding read in reverse: a binding says "this control drives this action
//! reference", and the domain owning the action reports what that reference's target looks
//! like now. Every surface showing a bound control reads the same readers, so they agree.

use serde::{Deserialize, Serialize};

/// Whether a bound control should show its target as idle, running or held.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub enum FeedbackState {
    /// The target exists but is not running or enabled, or the target is missing.
    #[default]
    Idle,
    /// The target is running, enabled or above zero.
    Active,
    /// A flash binding is currently holding the target.
    Held,
}

/// What a control bound to an action shows for the action's target.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct ActionFeedback {
    /// Whether the target is idle, running or held.
    pub state: FeedbackState,
    /// Normalized level the action drives (`0.0..=1.0`), for absolute actions such as faders.
    pub level: Option<f32>,
}

impl ActionFeedback {
    /// Feedback for a target that is idle, or whose target could not be resolved.
    pub const IDLE: Self = Self {
        state: FeedbackState::Idle,
        level: None,
    };

    /// Feedback for a running or enabled target without a level.
    pub const ACTIVE: Self = Self {
        state: FeedbackState::Active,
        level: None,
    };

    /// Feedback that is active when `active` holds and idle otherwise.
    pub fn active_if(active: bool) -> Self {
        if active { Self::ACTIVE } else { Self::IDLE }
    }

    /// Feedback carrying a normalized level, active while the level is above zero.
    pub fn level(level: f32) -> Self {
        let level = level.clamp(0.0, 1.0);
        Self {
            state: if level > 0.0 {
                FeedbackState::Active
            } else {
                FeedbackState::Idle
            },
            level: Some(level),
        }
    }
}

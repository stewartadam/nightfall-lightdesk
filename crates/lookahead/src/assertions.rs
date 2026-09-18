// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::Component;
use moonshine_kind::prelude::Instance;
use nightfall_compositor::prelude::Layer;
use nightfall_dmx::prelude::ParameterValue;
use nightfall_fixtures::prelude::Parameter;

/// Reason a playback is asking to assert a parameter before normal activation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LookaheadReason {
    /// Lookahead pre-positioning for a dark fixture.
    Lookahead,
}

/// One source-owned assertion that may be applied before normal activation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LookaheadAssertion {
    /// Parameter that should receive the lookahead value.
    pub parameter: Instance<Parameter>,
    /// Absolute value to assert.
    pub value: ParameterValue,
    /// Why this assertion exists.
    pub reason: LookaheadReason,
}

/// Source-produced assertions that can be applied before normal activation.
#[derive(Component, Clone, Debug, Default, PartialEq)]
pub struct LookaheadAssertions {
    /// Pending lookahead assertions for this playback.
    pub assertions: Vec<LookaheadAssertion>,
}

impl LookaheadAssertions {
    /// Applies the assertions to a rendered layer without transition timing.
    pub fn apply_to_layer(&self, layer: &mut Layer) {
        for assertion in &self.assertions {
            layer
                .absolute
                .insert(assertion.parameter, (assertion.value, None));
            layer.transitioning.remove(assertion.parameter);
        }
    }
}

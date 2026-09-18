// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compositor stages for the compositor pipeline.
pub mod attribution;
pub mod merge;
pub mod transition;

// Re-export stage functions for convenience
pub use attribution::merge_layer_with_attribution;
pub use merge::merge;
pub use transition::apply_transitions_with_compositing_context;

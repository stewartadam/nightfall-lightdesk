// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compositor module for managing visual layers and rendering pipelines.
#![warn(missing_docs)]

use std::marker::PhantomData;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::add_removal_messages;
use nightfall_engine::Compositing;

use crate::types::{
    CompositorParameter, FinalLayerAttributedAssertions, FinalLayerOutput, LayerCompositingContext,
    ReleaseMarker,
};

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::add_compositor_removal_messages;
    pub use crate::pipeline::CompositorPipeline;
    pub use crate::system::compositor;
    pub use crate::types::*;
}

pub mod pipeline;
pub mod stages;
pub mod system;
pub mod types;

/// Registers the removal messages the [`compositor`](system::compositor) system reads.
///
/// The compositor only runs in render updates, so it reads removals as
/// [`ComponentRemoved`](nightfall_engine::prelude::ComponentRemoved) messages, which survive the
/// input-only updates in between. Apps that add the system without [`CompositorPlugin`] call this.
pub fn add_compositor_removal_messages<P: CompositorParameter>(app: &mut App) {
    add_removal_messages::<P>(app);
    add_removal_messages::<ReleaseMarker>(app);
    add_removal_messages::<LayerCompositingContext>(app);
}

/// Compositor plugin that adds the layer compositing system to a Bevy app.
///
/// The compositor layer stack and final layer resources are global for the app, so this plugin is
/// intended to be registered once for the app's single active parameter component domain.
pub struct CompositorPlugin<P: CompositorParameter> {
    parameter: PhantomData<fn() -> P>,
}

impl<P: CompositorParameter> Default for CompositorPlugin<P> {
    fn default() -> Self {
        Self {
            parameter: PhantomData,
        }
    }
}

impl<P: CompositorParameter> Plugin for CompositorPlugin<P> {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering CompositorPlugin");
        // Initialize the final layer resources.
        app.init_resource::<FinalLayerAttributedAssertions>();
        app.init_resource::<FinalLayerOutput>();
        add_compositor_removal_messages::<P>(app);

        // Add system to compose the layers from materialized outputs
        app.add_systems(
            Update,
            (
                crate::system::compositor::<P>.in_set(Compositing),
                // ensure current OutputLayer is available for the next systems
                ApplyDeferred,
            )
                .chain(),
        );
    }
}

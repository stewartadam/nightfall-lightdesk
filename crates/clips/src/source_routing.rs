// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Registry of playback domains that run clip sources.
//!
//! Clip routing never names a playback plugin. Each plugin registers the source kinds it plays
//! with [`ClipSourceAppExt::register_clip_source`] and reads [`ClipSourceOperation`] for the
//! starts and stops routed to it, ordering those systems after
//! [`DeskEventSet::ClipRouting`](nightfall_engine::prelude::DeskEventSet::ClipRouting). A clip whose source kind has no registered domain fails to
//! start with an operator-facing error.

use std::collections::HashMap;

use bevy_app::App;
use bevy_ecs::prelude::*;
use nightfall::engine::{EngineIngressMeta, EngineOperation, EnginePayload};
use nightfall_engine::{prelude::EngineOperationEnvelope, register_engine_operation};
use nightfall_instances::{ClipInstanceStartContext, InstanceId, InstanceKind};
use nightfall_playback_planner::PlaybackReconstructionTiming;

use crate::Source;

/// Source kind of a clip, without the source's identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ClipSourceKind {
    /// Cue sequence.
    Sequence,
    /// Parameter effect.
    Fx,
    /// Step effect.
    StepFx,
    /// Flow graph.
    Flow,
    /// Effect module.
    FxModule,
}

impl ClipSourceKind {
    /// Operator-facing name used in routing errors.
    pub fn label(self) -> &'static str {
        match self {
            Self::Sequence => "sequence",
            Self::Fx => "FX",
            Self::StepFx => "step FX",
            Self::Flow => "flow",
            Self::FxModule => "FX module",
        }
    }
}

impl Source {
    /// Returns the kind of playback domain this source needs.
    pub fn kind(&self) -> ClipSourceKind {
        match self {
            Self::Sequence(_) => ClipSourceKind::Sequence,
            Self::Fx(_) => ClipSourceKind::Fx,
            Self::StepFx(_) => ClipSourceKind::StepFx,
            Self::Flow(_) => ClipSourceKind::Flow,
            Self::FxModule(_) => ClipSourceKind::FxModule,
        }
    }
}

/// How the clip router treats one registered source kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipSourceDomain {
    /// Kind of playback instance the domain spawns for this source.
    pub playback_kind: InstanceKind,
    /// Whether the domain reads [`crate::ClipOperation`] itself, publishes command outcomes for
    /// its clips, and detaches their clip links on stop. The router sends such a domain no
    /// [`ClipSourceOperation`] and leaves those clips' outcomes to it.
    pub handles_clip_operations: bool,
    /// Whether a clip go on this source starts its playback again, like a start.
    pub restarts_on_go: bool,
}

/// Playback domains registered for each clip source kind.
#[derive(Debug, Default, Resource)]
pub struct ClipSourceRegistry {
    domains: HashMap<ClipSourceKind, ClipSourceDomain>,
}

impl ClipSourceRegistry {
    /// Returns the domain registered for a source kind.
    pub fn domain(&self, kind: ClipSourceKind) -> Option<&ClipSourceDomain> {
        self.domains.get(&kind)
    }

    /// Returns the domain registered for a clip's source, if the clip has one.
    pub fn domain_for(&self, source: Option<&Source>) -> Option<&ClipSourceDomain> {
        source.and_then(|source| self.domain(source.kind()))
    }

    /// Returns whether a domain that handles clip operations itself spawns this playback kind.
    pub fn playback_kind_handles_clip_operations(&self, kind: &InstanceKind) -> bool {
        self.domains
            .values()
            .any(|domain| domain.handles_clip_operations && &domain.playback_kind == kind)
    }
}

/// Clip playback work routed to the domain that plays the clip's source.
#[derive(Debug, Clone)]
pub enum ClipSourceOperation {
    /// Start or refresh playback of a clip source.
    Start {
        /// Source to play. Each domain acts only on the kinds it registered.
        source: Source,
        /// Clip metadata for the start.
        context: ClipInstanceStartContext,
    },
    /// Release the playback attached to a stopped clip.
    ///
    /// Sent to every domain, since a clip that was retargeted can still have playback attached
    /// from a domain other than its current source's.
    Stop {
        /// Numeric ID of the stopped clip.
        clip_id: u32,
        /// The clip's current source, if any.
        source: Option<Source>,
        /// Runtime instances currently attached to the clip.
        attached_instances: Vec<InstanceId>,
        /// Optional source-local release timing.
        timing: Option<PlaybackReconstructionTiming>,
    },
}

impl EnginePayload for ClipSourceOperation {}

impl EngineIngressMeta for ClipSourceOperation {
    const COMMAND_MODULE: &'static str = "ClipSourceOperation";
}

impl EngineOperation for ClipSourceOperation {}

/// Registers clip source playback domains on an app.
pub trait ClipSourceAppExt {
    /// Declares that this app plays clips whose source has `kind`, as described by `domain`.
    ///
    /// Also installs the [`ClipSourceOperation`] message and the registry, so plugins can call it
    /// in any order.
    fn register_clip_source(&mut self, kind: ClipSourceKind, domain: ClipSourceDomain)
    -> &mut Self;
}

impl ClipSourceAppExt for App {
    /// Records the domain in [`ClipSourceRegistry`], replacing any earlier registration.
    fn register_clip_source(
        &mut self,
        kind: ClipSourceKind,
        domain: ClipSourceDomain,
    ) -> &mut Self {
        register_clip_source_routing(self);
        self.world_mut()
            .resource_mut::<ClipSourceRegistry>()
            .domains
            .insert(kind, domain);
        self
    }
}

/// Installs the registry and the routed operation message, keeping any registrations made so
/// far.
pub fn register_clip_source_routing(app: &mut App) {
    app.init_resource::<ClipSourceRegistry>();
    if !app
        .world()
        .contains_resource::<Messages<EngineOperationEnvelope<ClipSourceOperation>>>()
    {
        register_engine_operation::<ClipSourceOperation>(app);
    }
}

#[cfg(test)]
mod tests {
    use nightfall_engine::prelude::EngineOperationRouter;
    use uuid::Uuid;

    use super::*;

    /// Builds an app with the engine operation router that registration needs.
    fn app() -> App {
        let mut app = App::new();
        app.init_resource::<EngineOperationRouter>();
        app
    }

    /// Verifies registered kinds resolve to their domain and unregistered kinds stay unknown.
    #[test]
    fn registry_resolves_registered_source_kinds() {
        let mut app = app();
        let fx = ClipSourceDomain {
            playback_kind: InstanceKind::Fx,
            handles_clip_operations: false,
            restarts_on_go: false,
        };
        app.register_clip_source(ClipSourceKind::Fx, fx.clone());
        let registry = app.world().resource::<ClipSourceRegistry>();

        assert_eq!(
            registry.domain_for(Some(&Source::Fx(Uuid::from_u128(1)))),
            Some(&fx)
        );
        assert_eq!(
            registry.domain_for(Some(&Source::FxModule(Uuid::from_u128(2)))),
            None
        );
        assert_eq!(registry.domain_for(None), None);
    }

    /// Verifies the registry reports which playback kinds belong to self-reporting domains.
    #[test]
    fn registry_reports_playback_kinds_that_handle_clip_operations() {
        let mut app = app();
        app.register_clip_source(
            ClipSourceKind::Sequence,
            ClipSourceDomain {
                playback_kind: InstanceKind::Sequence,
                handles_clip_operations: true,
                restarts_on_go: false,
            },
        );
        app.register_clip_source(
            ClipSourceKind::Flow,
            ClipSourceDomain {
                playback_kind: InstanceKind::Flow,
                handles_clip_operations: false,
                restarts_on_go: false,
            },
        );
        let registry = app.world().resource::<ClipSourceRegistry>();

        assert!(registry.playback_kind_handles_clip_operations(&InstanceKind::Sequence));
        assert!(!registry.playback_kind_handles_clip_operations(&InstanceKind::Flow));
    }
}

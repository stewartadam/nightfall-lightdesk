// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! ECS access to every store that holds or resolves references.

use bevy_app::App;
use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall::prelude::*;
use nightfall_cues::prelude::{Cue, Sequence};
use nightfall_desk::prelude::{Master, MasterTarget};
use nightfall_engine::prelude::*;
use nightfall_fixtures::binding_resolution::output_transport_from_target_id;
use nightfall_fixtures::prelude::{FixtureDataProviderExt, OutputBindings, OutputTarget};
use nightfall_flow::prelude::FlowDefinition;
use nightfall_fx::prelude::{Fx, StepFx, StoredFxModule};
use nightfall_io::{NetworkDmxOutputTargets, UsbDmxOutputTargets};
use nightfall_selection::{
    ReferenceAuditor, ReferenceDomain, ReferenceLookup, ReferenceOwner, ReferenceReport,
};

/// Initializes every store [`ReferenceSources`] reads, for runtimes that do not add the plugin
/// owning one of them.
pub(crate) fn init_source_resources(app: &mut App) {
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<DataProvider<Group>>();
    app.init_resource::<DataProvider<Cue>>();
    app.init_resource::<DataProvider<Sequence>>();
    app.init_resource::<DataProvider<Fx>>();
    app.init_resource::<DataProvider<StoredFxModule>>();
    app.init_resource::<DataProvider<FlowDefinition>>();
    app.init_resource::<DataProvider<Master>>();
    app.init_resource::<DataProvider<Blueprint>>();
    app.init_resource::<OutputBindings>();
    app.init_resource::<NetworkDmxOutputTargets>();
    app.init_resource::<UsbDmxOutputTargets>();
}

/// Every store whose objects hold references, and every store those references resolve against.
#[derive(SystemParam)]
pub struct ReferenceSources<'w, 's> {
    pub(crate) fixtures: Res<'w, FixtureDataProviderExt>,
    pub(crate) groups: Res<'w, DataProvider<Group>>,
    pub(crate) cues: Res<'w, DataProvider<Cue>>,
    pub(crate) sequences: Res<'w, DataProvider<Sequence>>,
    pub(crate) fx: Res<'w, DataProvider<Fx>>,
    pub(crate) step_fx: Query<'w, 's, &'static StepFx>,
    changed_step_fx: Query<'w, 's, (), Changed<StepFx>>,
    removed_step_fx: RemovedComponents<'w, 's, StepFx>,
    pub(crate) fx_modules: Res<'w, DataProvider<StoredFxModule>>,
    pub(crate) flows: Res<'w, DataProvider<FlowDefinition>>,
    pub(crate) masters: Res<'w, DataProvider<Master>>,
    blueprints: Res<'w, DataProvider<Blueprint>>,
    output_bindings: Res<'w, OutputBindings>,
    network_outputs: Res<'w, NetworkDmxOutputTargets>,
    usb_outputs: Res<'w, UsbDmxOutputTargets>,
    /// Identity and scope of every master at the last run, sorted by UID.
    master_scopes: Local<'s, Vec<(Identifiers, MasterTarget)>>,
}

impl ReferenceSources<'_, '_> {
    /// Returns whether any store changed since the system using this parameter last ran.
    ///
    /// Moving a master fader changes the master store every frame, so a master change only counts
    /// when a master's identity or scope changed. Reads removed Step FX, so call it once per run.
    pub fn is_changed(&mut self) -> bool {
        let removed_step_fx = self.removed_step_fx.read().next().is_some();
        let masters_changed = self.masters.is_changed() && self.refresh_master_scopes();
        masters_changed
            || self.fixtures.is_changed()
            || self.groups.is_changed()
            || self.cues.is_changed()
            || self.sequences.is_changed()
            || self.fx.is_changed()
            || !self.changed_step_fx.is_empty()
            || removed_step_fx
            || self.fx_modules.is_changed()
            || self.flows.is_changed()
            || self.blueprints.is_changed()
            || self.output_bindings.is_changed()
            || self.network_outputs.is_changed()
            || self.usb_outputs.is_changed()
    }

    /// Records every master's identity and scope, returning whether they differ from the last
    /// record.
    fn refresh_master_scopes(&mut self) -> bool {
        let mut scopes = self
            .masters
            .iter()
            .map(|entry| {
                let master = entry.value();
                (master.identifiers.clone(), master.target.clone())
            })
            .collect::<Vec<_>>();
        scopes.sort_by_key(|(identifiers, _)| identifiers.uid);
        if scopes == *self.master_scopes {
            return false;
        }
        *self.master_scopes = scopes;
        true
    }

    /// Builds the live targets references are checked against.
    pub fn lookup(&self) -> ReferenceLookup {
        let mut lookup = ReferenceLookup::default();
        for entry in self.fixtures.inner.iter() {
            let fixture = entry.value();
            lookup.add_fixture(
                fixture.identifiers.uid,
                fixture.identifiers.id,
                fixture.elements.len() as u32,
            );
        }
        for entry in self.groups.iter() {
            let group = entry.value();
            lookup.add_group(
                group.identifiers.uid,
                group.identifiers.id,
                &group.identifiers.label,
            );
        }
        for entry in self.blueprints.iter() {
            lookup.add_blueprint(entry.value().identifiers.uid);
        }
        for binding in &self.output_bindings.bindings {
            if let OutputTarget::Transport { target, .. } = &binding.target
                && output_transport_from_target_id(target, &self.network_outputs, &self.usb_outputs)
                    .is_some()
            {
                lookup.add_output_target(target.clone());
            }
        }
        lookup
    }

    /// Audits every reference held by every object.
    pub fn audit(&self) -> ReferenceReport {
        let lookup = self.lookup();
        let mut auditor = ReferenceAuditor::new(&lookup);
        for entry in self.groups.iter() {
            let group = entry.value();
            auditor.audit(
                ReferenceOwner::object(ReferenceDomain::Group, &group.identifiers),
                group,
            );
        }
        for entry in self.cues.iter() {
            let cue = entry.value();
            auditor.audit(
                ReferenceOwner::object(ReferenceDomain::Cue, &cue.identifiers),
                cue,
            );
        }
        for entry in self.sequences.iter() {
            let sequence = entry.value();
            auditor.audit(
                ReferenceOwner::object(ReferenceDomain::Sequence, &sequence.identifiers),
                sequence,
            );
        }
        for entry in self.fx.iter() {
            let fx = entry.value();
            auditor.audit(
                ReferenceOwner::object(ReferenceDomain::Fx, &fx.identifiers),
                fx,
            );
        }
        for step_fx in &self.step_fx {
            auditor.audit(
                ReferenceOwner::object(ReferenceDomain::StepFx, &step_fx.identifiers),
                step_fx,
            );
        }
        for entry in self.fx_modules.iter() {
            let fx_module = entry.value();
            auditor.audit(
                ReferenceOwner::object(ReferenceDomain::FxModule, &fx_module.identifiers),
                fx_module,
            );
        }
        for entry in self.flows.iter() {
            let flow = entry.value();
            auditor.audit(
                ReferenceOwner::object(ReferenceDomain::Flow, &flow.identifiers),
                flow,
            );
        }
        for entry in self.masters.iter() {
            let master = entry.value();
            auditor.audit(
                ReferenceOwner::object(ReferenceDomain::Master, &master.identifiers),
                master,
            );
        }
        for (index, binding) in self.output_bindings.bindings.iter().enumerate() {
            auditor.audit(ReferenceOwner::output_binding(index), binding);
        }
        auditor.finish()
    }
}

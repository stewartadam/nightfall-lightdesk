// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! ECS access to every store that holds or resolves references, and the change tracking that
//! decides which objects to re-audit.

use std::collections::{HashMap, HashSet};

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
    OwnerKey, OwnerReferences, ReferenceBook, ReferenceDomain, ReferenceLookup, ReferenceOwner,
    ReferenceSource, audit_owner,
};
use uuid::Uuid;

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

/// How far the reference book has followed every store, and the live targets as of then.
#[derive(Default)]
pub(crate) struct AuditCursor {
    /// Whether a full audit has run, so the revisions below are meaningful.
    started: bool,
    fixtures: DataRevision,
    groups: DataRevision,
    cues: DataRevision,
    sequences: DataRevision,
    fx: DataRevision,
    fx_modules: DataRevision,
    flows: DataRevision,
    masters: DataRevision,
    blueprints: DataRevision,
    /// Live targets references are checked against.
    lookup: ReferenceLookup,
    /// UID of every Step FX entity, to name the ones whose component was removed.
    step_fx_uids: HashMap<Entity, Uuid>,
    /// Number of output bindings, to drop the audits of removed ones.
    binding_count: usize,
    /// Identity and scope of every master, so level moves (stored every frame while a fader
    /// moves) do not re-audit the master.
    master_scopes: HashMap<Uuid, (Identifiers, MasterTarget)>,
}

/// Audits to store in the reference book after a change.
pub(crate) struct AuditUpdate {
    /// Whether the audits cover every object, so stored audits missing from them are stale.
    pub(crate) full: bool,
    /// New audit of each re-audited object, or none when the object no longer exists.
    pub(crate) audits: Vec<(OwnerKey, Option<OwnerReferences>)>,
}

/// Every store whose objects hold references, and every store those references resolve against.
#[derive(SystemParam)]
pub struct ReferenceSources<'w, 's> {
    pub(crate) fixtures: Res<'w, FixtureDataProviderExt>,
    pub(crate) groups: Res<'w, DataProvider<Group>>,
    pub(crate) cues: Res<'w, DataProvider<Cue>>,
    pub(crate) sequences: Res<'w, DataProvider<Sequence>>,
    pub(crate) fx: Res<'w, DataProvider<Fx>>,
    pub(crate) step_fx: Query<'w, 's, (Entity, &'static StepFx)>,
    changed_step_fx: Query<'w, 's, (Entity, &'static StepFx), Changed<StepFx>>,
    removed_step_fx: RemovedComponents<'w, 's, StepFx>,
    pub(crate) fx_modules: Res<'w, DataProvider<StoredFxModule>>,
    pub(crate) flows: Res<'w, DataProvider<FlowDefinition>>,
    pub(crate) masters: Res<'w, DataProvider<Master>>,
    blueprints: Res<'w, DataProvider<Blueprint>>,
    output_bindings: Res<'w, OutputBindings>,
    network_outputs: Res<'w, NetworkDmxOutputTargets>,
    usb_outputs: Res<'w, UsbDmxOutputTargets>,
}

impl ReferenceSources<'_, '_> {
    /// Brings `cursor` up to date and audits the objects the changes since it affect: objects
    /// that changed, and objects whose references read a target that changed.
    ///
    /// Audits every object when `full` is set, on the first run, or when a store was cleared or
    /// replaced. Returns none when nothing the audit reads changed. Reads removed Step FX, so call
    /// it once per run.
    pub(crate) fn audit_changes(
        &mut self,
        cursor: &mut AuditCursor,
        book: &ReferenceBook,
        full: bool,
    ) -> Option<AuditUpdate> {
        let removed_step_fx = self.removed_step_fx.read().collect::<Vec<_>>();
        let changes = (
            items(self.fixtures.inner.changes_since(cursor.fixtures)),
            items(self.groups.changes_since(cursor.groups)),
            items(self.blueprints.changes_since(cursor.blueprints)),
            items(self.cues.changes_since(cursor.cues)),
            items(self.sequences.changes_since(cursor.sequences)),
            items(self.fx.changes_since(cursor.fx)),
            items(self.fx_modules.changes_since(cursor.fx_modules)),
            items(self.flows.changes_since(cursor.flows)),
            items(self.masters.changes_since(cursor.masters)),
        );
        let (
            Some(fixtures),
            Some(groups),
            Some(blueprints),
            Some(cues),
            Some(sequences),
            Some(fx),
            Some(fx_modules),
            Some(flows),
            Some(masters),
        ) = changes
        else {
            return Some(self.audit_everything(cursor));
        };
        if full || !cursor.started {
            return Some(self.audit_everything(cursor));
        }
        self.record_revisions(cursor);

        let mut owners = HashSet::new();
        let mut lookups = Vec::new();
        for uid in fixtures {
            let fixture = self
                .fixtures
                .inner
                .get(uid)
                .ok()
                .map(|fixture| (fixture.identifiers.id, fixture.elements.len() as u32));
            lookups.extend(cursor.lookup.set_fixture(uid, fixture));
        }
        for uid in &groups {
            let group = self.groups.get(*uid).ok();
            let group = group
                .as_ref()
                .map(|group| (group.identifiers.id, group.identifiers.label.as_str()));
            lookups.extend(cursor.lookup.set_group(*uid, group));
        }
        for uid in blueprints {
            let exists = self.blueprints.get(uid).is_ok();
            lookups.extend(cursor.lookup.set_blueprint(uid, exists));
        }
        let masters = masters
            .into_iter()
            .filter(|uid| {
                let scope = self
                    .masters
                    .get(*uid)
                    .ok()
                    .map(|master| master_scope(&master));
                if cursor.master_scopes.get(uid) == scope.as_ref() {
                    return false;
                }
                match scope {
                    Some(scope) => cursor.master_scopes.insert(*uid, scope),
                    None => cursor.master_scopes.remove(uid),
                };
                true
            })
            .collect::<Vec<_>>();
        for (domain, uids) in [
            (ReferenceDomain::Group, groups),
            (ReferenceDomain::Cue, cues),
            (ReferenceDomain::Sequence, sequences),
            (ReferenceDomain::Fx, fx),
            (ReferenceDomain::FxModule, fx_modules),
            (ReferenceDomain::Flow, flows),
            (ReferenceDomain::Master, masters),
        ] {
            owners.extend(uids.into_iter().map(|uid| object_key(domain, uid)));
        }
        for entity in removed_step_fx {
            if let Some(uid) = cursor.step_fx_uids.remove(&entity) {
                owners.insert(object_key(ReferenceDomain::StepFx, uid));
            }
        }
        for (entity, step_fx) in &self.changed_step_fx {
            let uid = step_fx.identifiers.uid;
            if let Some(previous) = cursor.step_fx_uids.insert(entity, uid)
                && previous != uid
            {
                owners.insert(object_key(ReferenceDomain::StepFx, previous));
            }
            owners.insert(object_key(ReferenceDomain::StepFx, uid));
        }
        if self.output_bindings.is_changed()
            || self.network_outputs.is_changed()
            || self.usb_outputs.is_changed()
        {
            lookups.extend(cursor.lookup.set_output_targets(self.output_targets()));
        }
        if self.output_bindings.is_changed() {
            let count = self.output_bindings.bindings.len();
            owners.extend((0..count.max(cursor.binding_count)).map(binding_key));
            cursor.binding_count = count;
        }

        owners.extend(book.readers(&lookups));
        if owners.is_empty() {
            return None;
        }
        let step_fx_entities = cursor
            .step_fx_uids
            .iter()
            .map(|(entity, uid)| (*uid, *entity))
            .collect::<HashMap<_, _>>();
        let audits = owners
            .into_iter()
            .map(|key| {
                let audit = self.audit_key(&cursor.lookup, &step_fx_entities, &key);
                (key, audit)
            })
            .collect();
        Some(AuditUpdate {
            full: false,
            audits,
        })
    }

    /// Rebuilds `cursor` from the current stores and audits every object.
    fn audit_everything(&self, cursor: &mut AuditCursor) -> AuditUpdate {
        self.record_revisions(cursor);
        cursor.started = true;
        cursor.lookup = self.lookup();
        cursor.step_fx_uids = self
            .step_fx
            .iter()
            .map(|(entity, step_fx)| (entity, step_fx.identifiers.uid))
            .collect();
        cursor.binding_count = self.output_bindings.bindings.len();
        cursor.master_scopes = self
            .masters
            .iter()
            .map(|entry| (*entry.key(), master_scope(entry.value())))
            .collect();

        let lookup = &cursor.lookup;
        let mut audits = Vec::new();
        let mut audit = |owner: ReferenceOwner, source: &dyn ReferenceSource| {
            audits.push((
                OwnerKey::of(&owner),
                Some(audit_owner(lookup, owner, source)),
            ));
        };
        audit_store(&self.groups, ReferenceDomain::Group, &mut audit);
        audit_store(&self.cues, ReferenceDomain::Cue, &mut audit);
        audit_store(&self.sequences, ReferenceDomain::Sequence, &mut audit);
        audit_store(&self.fx, ReferenceDomain::Fx, &mut audit);
        for (_, step_fx) in &self.step_fx {
            audit(
                ReferenceOwner::object(ReferenceDomain::StepFx, &step_fx.identifiers),
                step_fx,
            );
        }
        audit_store(&self.fx_modules, ReferenceDomain::FxModule, &mut audit);
        audit_store(&self.flows, ReferenceDomain::Flow, &mut audit);
        audit_store(&self.masters, ReferenceDomain::Master, &mut audit);
        for (index, binding) in self.output_bindings.bindings.iter().enumerate() {
            audit(ReferenceOwner::output_binding(index), binding);
        }
        AuditUpdate { full: true, audits }
    }

    /// Records the current revision of every store in `cursor`.
    fn record_revisions(&self, cursor: &mut AuditCursor) {
        cursor.fixtures = self.fixtures.inner.revision();
        cursor.groups = self.groups.revision();
        cursor.cues = self.cues.revision();
        cursor.sequences = self.sequences.revision();
        cursor.fx = self.fx.revision();
        cursor.fx_modules = self.fx_modules.revision();
        cursor.flows = self.flows.revision();
        cursor.masters = self.masters.revision();
        cursor.blueprints = self.blueprints.revision();
    }

    /// Audits the object `key` names, or returns none when it no longer exists. Step FX are found
    /// through `step_fx_entities`, their entity by UID.
    fn audit_key(
        &self,
        lookup: &ReferenceLookup,
        step_fx_entities: &HashMap<Uuid, Entity>,
        key: &OwnerKey,
    ) -> Option<OwnerReferences> {
        if key.domain == ReferenceDomain::PatchBinding {
            let index = key.uid.strip_prefix(BINDING_UID_PREFIX)?.parse().ok()?;
            let binding = self.output_bindings.bindings.get(index)?;
            return Some(audit_owner(
                lookup,
                ReferenceOwner::output_binding(index),
                binding,
            ));
        }
        let uid = Uuid::parse_str(&key.uid).ok()?;
        match key.domain {
            ReferenceDomain::Group => audit_stored(&self.groups, key.domain, uid, lookup),
            ReferenceDomain::Cue => audit_stored(&self.cues, key.domain, uid, lookup),
            ReferenceDomain::Sequence => audit_stored(&self.sequences, key.domain, uid, lookup),
            ReferenceDomain::Fx => audit_stored(&self.fx, key.domain, uid, lookup),
            ReferenceDomain::FxModule => audit_stored(&self.fx_modules, key.domain, uid, lookup),
            ReferenceDomain::Flow => audit_stored(&self.flows, key.domain, uid, lookup),
            ReferenceDomain::Master => audit_stored(&self.masters, key.domain, uid, lookup),
            ReferenceDomain::StepFx => step_fx_entities
                .get(&uid)
                .and_then(|entity| self.step_fx.get(*entity).ok())
                .map(|(_, step_fx)| {
                    let owner = ReferenceOwner::object(key.domain, &step_fx.identifiers);
                    audit_owner(lookup, owner, step_fx)
                }),
            ReferenceDomain::PatchBinding => None,
        }
    }

    /// Returns the output transport target identifiers bindings name that resolve to a
    /// configured output.
    fn output_targets(&self) -> HashSet<String> {
        self.output_bindings
            .bindings
            .iter()
            .filter_map(|binding| match &binding.target {
                OutputTarget::Transport { target, .. }
                    if output_transport_from_target_id(
                        target,
                        &self.network_outputs,
                        &self.usb_outputs,
                    )
                    .is_some() =>
                {
                    Some(target.clone())
                }
                _ => None,
            })
            .collect()
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
        lookup.set_output_targets(self.output_targets());
        lookup
    }
}

/// Prefix of the owner UID [`ReferenceOwner::output_binding`] assigns, before the binding index.
const BINDING_UID_PREFIX: &str = "output-binding-";

/// Returns the changed item UIDs, or none when every item must be treated as changed.
fn items(changes: DataChanges) -> Option<Vec<Uuid>> {
    match changes {
        DataChanges::All => None,
        DataChanges::Items(uids) => Some(uids),
    }
}

/// Returns what a master's references depend on: its identity and its fixture scope.
fn master_scope(master: &Master) -> (Identifiers, MasterTarget) {
    (master.identifiers.clone(), master.target.clone())
}

/// Returns the book key of the showfile object `uid` in `domain`.
fn object_key(domain: ReferenceDomain, uid: Uuid) -> OwnerKey {
    OwnerKey::new(domain, &uid.simple().to_string())
}

/// Returns the book key of the output binding at `index`.
fn binding_key(index: usize) -> OwnerKey {
    OwnerKey::of(&ReferenceOwner::output_binding(index))
}

/// Passes every object in `store` to `audit` as an owner in `domain`.
fn audit_store<T: HasIdentifiers + ReferenceSource>(
    store: &DataProvider<T>,
    domain: ReferenceDomain,
    audit: &mut impl FnMut(ReferenceOwner, &dyn ReferenceSource),
) {
    for entry in store.iter() {
        let object = entry.value();
        audit(ReferenceOwner::object(domain, object.identifiers()), object);
    }
}

/// Audits the object `uid` in `store`, or returns none when it no longer exists.
fn audit_stored<T: HasIdentifiers + ReferenceSource>(
    store: &DataProvider<T>,
    domain: ReferenceDomain,
    uid: Uuid,
    lookup: &ReferenceLookup,
) -> Option<OwnerReferences> {
    let object = store.get(uid).ok()?;
    let owner = ReferenceOwner::object(domain, object.identifiers());
    Some(audit_owner(lookup, owner, &*object))
}

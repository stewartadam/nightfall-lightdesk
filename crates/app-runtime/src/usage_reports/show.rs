// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Summarizes a show for usage reports: how many of each object it holds, which protocols and
//! interfaces it uses, and which library fixtures it patches. Names, labels, and values the
//! operator typed never leave the summary, apart from interface model names.

use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    hash::{Hash, Hasher},
    net::Ipv4Addr,
};

use nightfall_fixtures::prelude::{Fixture, InputSource};
use nightfall_io::prelude::{ArtNetDelivery, OutputTransport, RouteTransport, SacnDelivery};
use nightfall_showfile::ShowfileSnapshot;
use nightfall_timecode::prelude::TimecodeSource;
use rustc_hash::FxHasher;
use serde_json::{Map, Value, json};

/// Most fixture models and interfaces reported for one show; the most used come first.
const MAX_LISTED_MODELS: usize = 100;

/// Where a patched fixture's definition comes from, which decides how it is reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    not(feature = "fixture-library"),
    allow(dead_code, reason = "without the library every fixture is custom")
)]
pub(crate) enum FixtureOrigin {
    /// A built-in or Open Fixture Library format definition: reported by make and model. OFL
    /// files can also be ones the operator wrote and imported, so their names are reported too.
    Library,
    /// A GDTF file the operator imported: counted only.
    Gdtf,
    /// Anything else, including fixtures built by hand: counted only, since their names often
    /// contain venue or client names.
    Custom,
}

/// DMX universes a show's patch resolves to, read from the running world.
#[derive(Debug, Default, Clone)]
pub(crate) struct PatchedOutputs {
    /// Console universes that patched parameters occupy.
    pub(crate) console_universes: BTreeSet<u16>,
    /// Transport and universe pairs the patch sends frames to.
    pub(crate) transport_universes: HashSet<(OutputTransport, u16)>,
}

/// One usage event: its name and properties.
pub(crate) type UsageEvent = (&'static str, Map<String, Value>);

/// What a usage report says about one show.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct ShowSummary {
    counts: BTreeMap<&'static str, usize>,
    features: BTreeMap<&'static str, bool>,
    fixture_models: BTreeMap<(String, String), usize>,
    interfaces: BTreeSet<(&'static str, String)>,
}

impl ShowSummary {
    /// Summarizes `snapshot`, using `origin` to decide which fixtures are reported by model and
    /// `outputs` for the protocols and universes the patch actually drives.
    pub(crate) fn new(
        snapshot: &ShowfileSnapshot,
        origin: impl Fn(&Fixture) -> FixtureOrigin,
        outputs: &PatchedOutputs,
    ) -> Self {
        let mut fixture_models = BTreeMap::new();
        let (mut gdtf_fixtures, mut custom_fixtures) = (0, 0);
        for fixture in &snapshot.fixtures {
            match origin(fixture) {
                FixtureOrigin::Library => {
                    *fixture_models
                        .entry((fixture.make.clone(), fixture.model.clone()))
                        .or_default() += 1;
                }
                FixtureOrigin::Gdtf => gdtf_fixtures += 1,
                FixtureOrigin::Custom => custom_fixtures += 1,
            }
        }

        let mut counts = BTreeMap::from([
            ("fixtures", snapshot.fixtures.len()),
            ("fixtures_gdtf", gdtf_fixtures),
            ("fixtures_custom", custom_fixtures),
            ("fixture_models", fixture_models.len()),
            ("scene_objects", snapshot.scene_objects.len()),
            ("cues", snapshot.cues.len()),
            ("sequences", snapshot.sequences.len()),
            ("groups", snapshot.groups.len()),
            ("masters", snapshot.masters.len()),
            ("blueprints", snapshot.blueprints.len()),
            ("color_paths", snapshot.color_paths.len()),
            ("fx", snapshot.fx.len()),
            ("fx_modules", snapshot.fx_module.len()),
            ("step_fx", snapshot.step_fx.len()),
            ("flows", snapshot.flows.len()),
            ("timecodes", snapshot.timecodes.len()),
            ("timelines", snapshot.timelines.len()),
            ("clips", snapshot.clips.len()),
            ("boards", snapshot.boards.len()),
            ("macros", snapshot.macros.len()),
            ("input_routes", snapshot.routes.input.len()),
            ("output_routes", snapshot.routes.output.len()),
            ("console_universes", outputs.console_universes.len()),
            ("output_universes", outputs.transport_universes.len()),
        ]);
        #[cfg(feature = "midi")]
        counts.insert("midi_mappings", snapshot.midi_mappings.len());
        #[cfg(feature = "osc")]
        counts.insert("osc_mappings", snapshot.osc_mappings.len());

        let output_uses = |used: fn(&OutputTransport) -> bool| {
            outputs
                .transport_universes
                .iter()
                .any(|(transport, _)| used(transport))
        };
        let input_uses = |wanted: RouteTransport| {
            snapshot.routes.input.iter().any(|route| {
                matches!(&route.source, InputSource::Transport { transport, .. } if *transport == wanted)
            })
        };
        let timecode_uses = |wanted: fn(&TimecodeSource) -> bool| {
            snapshot
                .timecodes
                .iter()
                .any(|timecode| wanted(&timecode.source))
        };
        #[cfg_attr(
            not(any(feature = "midi", feature = "osc")),
            allow(unused_mut, reason = "MIDI and OSC entries are compiled out")
        )]
        let mut features = BTreeMap::from([
            (
                "output_sacn",
                output_uses(|transport| matches!(transport, OutputTransport::Sacn { .. })),
            ),
            (
                "output_artnet",
                output_uses(|transport| matches!(transport, OutputTransport::ArtNet { .. })),
            ),
            (
                "output_usb_dmx",
                output_uses(|transport| matches!(transport, OutputTransport::Udmx { .. })),
            ),
            ("input_sacn", input_uses(RouteTransport::Sacn)),
            ("input_artnet", input_uses(RouteTransport::ArtNet)),
            ("input_usb_dmx", input_uses(RouteTransport::Udmx)),
            (
                "timecode_midi",
                timecode_uses(|source| matches!(source, TimecodeSource::MidiMtc)),
            ),
            (
                "timecode_ltc",
                timecode_uses(|source| matches!(source, TimecodeSource::SmpteLtc)),
            ),
            (
                "timecode_artnet",
                timecode_uses(|source| matches!(source, TimecodeSource::ArtNet)),
            ),
        ]);
        #[cfg(feature = "midi")]
        features.insert("input_midi", !snapshot.midi_mappings.is_empty());
        #[cfg(feature = "osc")]
        features.insert("input_osc", !snapshot.osc_mappings.is_empty());
        let network = NetworkOutputs::new(outputs);
        counts.extend(network.counts());
        features.extend(network.features());

        let mut interfaces = BTreeSet::new();
        for target in &snapshot.io_settings.usb_dmx_outputs.targets {
            let Some(label) = &target.device_label else {
                continue;
            };
            if outputs
                .transport_universes
                .iter()
                .any(|(transport, _)| *transport == target.output_transport())
            {
                interfaces.insert(("usb_dmx", usb_model_name(label).to_string()));
            }
        }
        #[cfg(feature = "midi")]
        counts.insert(
            "midi_devices",
            snapshot
                .midi_mappings
                .iter()
                .map(|mapping| &mapping.device_name)
                .collect::<BTreeSet<_>>()
                .len(),
        );

        Self {
            counts,
            features,
            fixture_models,
            interfaces,
        }
    }

    /// Returns a value that changes whenever any reported detail changes, so an unchanged show
    /// is not reported twice. The hash is fixed across builds, since fingerprints are saved.
    pub(crate) fn fingerprint(&self) -> u64 {
        let mut hasher = FxHasher::default();
        self.hash(&mut hasher);
        hasher.finish()
    }

    /// Builds the events for this show: `show_analytics` with its counts and features, then one
    /// `show_fixture_model` per library fixture model and one `show_interface` per interface
    /// model, so dashboards can break them down by make or model.
    pub(crate) fn events(&self) -> Vec<UsageEvent> {
        let mut snapshot = Map::new();
        for (name, count) in &self.counts {
            snapshot.insert((*name).into(), json!(count));
        }
        for (name, used) in &self.features {
            snapshot.insert((*name).into(), json!(used));
        }
        let mut events = vec![("show_analytics", snapshot)];

        let mut models: Vec<_> = self.fixture_models.iter().collect();
        models.sort_by(|left, right| right.1.cmp(left.1));
        events.extend(
            models
                .into_iter()
                .take(MAX_LISTED_MODELS)
                .map(|((make, model), count)| {
                    let properties = json!({ "make": make, "model": model, "count": count });
                    ("show_fixture_model", into_map(properties))
                }),
        );
        events.extend(
            self.interfaces
                .iter()
                .take(MAX_LISTED_MODELS)
                .map(|(kind, model)| {
                    let properties = json!({ "kind": kind, "model": model });
                    ("show_interface", into_map(properties))
                }),
        );
        events
    }
}

/// How a show's patch reaches each output protocol: the universes it sends on and how frames
/// are delivered. Unicast destinations are only counted, never listed, since they are
/// addresses on the operator's network.
#[derive(Default)]
struct NetworkOutputs {
    sacn_universes: BTreeSet<u16>,
    artnet_universes: BTreeSet<u16>,
    usb_dmx_universes: BTreeSet<u16>,
    sacn_multicast: bool,
    artnet_broadcast: bool,
    sacn_unicast_targets: HashSet<Ipv4Addr>,
    artnet_unicast_targets: HashSet<Ipv4Addr>,
}

impl NetworkOutputs {
    /// Sorts the patched transport and universe pairs by protocol and delivery mode.
    fn new(outputs: &PatchedOutputs) -> Self {
        let mut network = Self::default();
        for (transport, universe) in &outputs.transport_universes {
            match transport {
                OutputTransport::Sacn { mode } => {
                    network.sacn_universes.insert(*universe);
                    match mode {
                        SacnDelivery::Multicast => network.sacn_multicast = true,
                        SacnDelivery::Unicast { ip } => {
                            network.sacn_unicast_targets.insert(*ip);
                        }
                    }
                }
                OutputTransport::ArtNet { mode } => {
                    network.artnet_universes.insert(*universe);
                    match mode {
                        ArtNetDelivery::Broadcast => network.artnet_broadcast = true,
                        ArtNetDelivery::Unicast { ip } => {
                            network.artnet_unicast_targets.insert(*ip);
                        }
                    }
                }
                OutputTransport::Udmx { .. } => {
                    network.usb_dmx_universes.insert(*universe);
                }
                OutputTransport::Disabled => {}
            }
        }
        network
    }

    /// Universes driven per protocol, and how many unicast destinations each protocol sends to.
    fn counts(&self) -> [(&'static str, usize); 5] {
        [
            ("output_universes_sacn", self.sacn_universes.len()),
            ("output_universes_artnet", self.artnet_universes.len()),
            ("output_universes_usb_dmx", self.usb_dmx_universes.len()),
            (
                "output_unicast_targets_sacn",
                self.sacn_unicast_targets.len(),
            ),
            (
                "output_unicast_targets_artnet",
                self.artnet_unicast_targets.len(),
            ),
        ]
    }

    /// Which delivery modes each network protocol uses.
    fn features(&self) -> [(&'static str, bool); 4] {
        [
            ("output_sacn_multicast", self.sacn_multicast),
            ("output_sacn_unicast", !self.sacn_unicast_targets.is_empty()),
            ("output_artnet_broadcast", self.artnet_broadcast),
            (
                "output_artnet_unicast",
                !self.artnet_unicast_targets.is_empty(),
            ),
        ]
    }
}

/// Cuts a USB interface label down to its model name, dropping the ` (vvvv:pppp)` vendor and
/// product pair and anything after it, such as a serial number or bus location.
fn usb_model_name(label: &str) -> &str {
    let is_id_pair = |rest: &str| {
        let bytes = rest.as_bytes();
        bytes.len() >= 10
            && bytes[9] == b')'
            && bytes[4] == b':'
            && bytes[..4]
                .iter()
                .chain(&bytes[5..9])
                .all(u8::is_ascii_hexdigit)
    };
    label
        .match_indices(" (")
        .find(|(index, _)| is_id_pair(&label[index + 2..]))
        .map_or(label, |(index, _)| &label[..index])
        .trim()
}

/// Unwraps a JSON object literal into its property map.
fn into_map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use nightfall_fixtures::prelude::{InputRoute, InputTarget};
    use nightfall_io::prelude::UsbDmxOutputTarget;

    use super::*;

    /// Returns a fixture with the given make and model and defaults elsewhere.
    fn fixture(make: &str, model: &str) -> Fixture {
        Fixture {
            make: make.into(),
            model: model.into(),
            ..Default::default()
        }
    }

    /// Builds a show with library, GDTF, and custom fixtures, a USB interface, and sACN input.
    fn show() -> (ShowfileSnapshot, PatchedOutputs) {
        let mut snapshot = ShowfileSnapshot {
            fixtures: vec![
                fixture("Robe", "Spiider"),
                fixture("Robe", "Spiider"),
                fixture("Chauvet", "Rogue R2"),
                fixture("Imported", "From GDTF"),
                fixture("Venue Name", "House Wash"),
            ],
            ..Default::default()
        };
        snapshot.routes.input.push(InputRoute {
            source: InputSource::Transport {
                transport: RouteTransport::Sacn,
                universe: None,
                address: None,
            },
            target: InputTarget::Disabled,
            priority: 0,
            clone: false,
        });
        snapshot.io_settings.usb_dmx_outputs.targets = vec![
            UsbDmxOutputTarget {
                id: "udmx".into(),
                device: "id-16c0:05dc".into(),
                device_label: Some("Anyma uDMX".into()),
            },
            UsbDmxOutputTarget {
                id: "spare".into(),
                device: "id-0403:6001".into(),
                device_label: Some("Unused interface".into()),
            },
        ];
        let outputs = PatchedOutputs {
            console_universes: BTreeSet::from([1, 2]),
            transport_universes: HashSet::from([
                (
                    OutputTransport::Sacn {
                        mode: SacnDelivery::Multicast,
                    },
                    1,
                ),
                (
                    OutputTransport::Udmx {
                        device: "id-16c0:05dc".into(),
                    },
                    1,
                ),
            ]),
        };
        (snapshot, outputs)
    }

    /// Classifies the test fixtures by their make.
    fn origin(fixture: &Fixture) -> FixtureOrigin {
        match fixture.make.as_str() {
            "Imported" => FixtureOrigin::Gdtf,
            "Venue Name" => FixtureOrigin::Custom,
            _ => FixtureOrigin::Library,
        }
    }

    /// Library fixtures are listed by model, others only counted, and only interfaces the patch
    /// drives are named.
    #[test]
    fn reports_library_models_and_counts_the_rest() {
        let (snapshot, outputs) = show();
        let events = ShowSummary::new(&snapshot, origin, &outputs).events();
        let (name, show) = &events[0];
        assert_eq!(*name, "show_analytics");
        assert_eq!(show["fixtures"], 5);
        assert_eq!(show["fixtures_gdtf"], 1);
        assert_eq!(show["fixtures_custom"], 1);
        assert_eq!(show["fixture_models"], 2);
        assert_eq!(show["console_universes"], 2);
        assert_eq!(show["output_universes"], 2);
        assert_eq!(show["output_sacn"], true);
        assert_eq!(show["output_artnet"], false);
        assert_eq!(show["output_usb_dmx"], true);
        assert_eq!(show["output_universes_sacn"], 1);
        assert_eq!(show["output_universes_usb_dmx"], 1);
        assert_eq!(show["output_sacn_multicast"], true);
        assert_eq!(show["output_sacn_unicast"], false);
        assert_eq!(show["input_sacn"], true);

        let names: Vec<_> = events[1..]
            .iter()
            .map(|(name, properties)| (*name, properties.clone()))
            .collect();
        assert_eq!(
            names[0],
            (
                "show_fixture_model",
                into_map(json!({ "make": "Robe", "model": "Spiider", "count": 2 }))
            )
        );
        assert_eq!(names[1].1["model"], "Rogue R2");
        assert_eq!(
            names[2],
            (
                "show_interface",
                into_map(json!({ "kind": "usb_dmx", "model": "Anyma uDMX" }))
            )
        );
        assert_eq!(names.len(), 3);
        let serialized = serde_json::to_string(&events).unwrap();
        assert!(!serialized.contains("Venue Name") && !serialized.contains("Imported"));
    }

    /// Universes and delivery modes are reported per protocol, and unicast destinations are
    /// counted without their addresses appearing anywhere in the report.
    #[test]
    fn reports_network_outputs_per_protocol() {
        let (snapshot, _) = show();
        let sacn_unicast = |ip: [u8; 4]| OutputTransport::Sacn {
            mode: SacnDelivery::Unicast { ip: ip.into() },
        };
        let artnet_unicast = |ip: [u8; 4]| OutputTransport::ArtNet {
            mode: ArtNetDelivery::Unicast { ip: ip.into() },
        };
        let outputs = PatchedOutputs {
            console_universes: BTreeSet::from([1, 2, 3]),
            transport_universes: HashSet::from([
                (
                    OutputTransport::Sacn {
                        mode: SacnDelivery::Multicast,
                    },
                    1,
                ),
                (sacn_unicast([10, 0, 0, 7]), 1),
                (sacn_unicast([10, 0, 0, 8]), 2),
                (artnet_unicast([10, 0, 0, 9]), 3),
                (artnet_unicast([10, 0, 0, 9]), 4),
            ]),
        };
        let events = ShowSummary::new(&snapshot, origin, &outputs).events();
        let show = &events[0].1;
        assert_eq!(show["output_universes"], 5);
        assert_eq!(show["output_universes_sacn"], 2);
        assert_eq!(show["output_universes_artnet"], 2);
        assert_eq!(show["output_universes_usb_dmx"], 0);
        assert_eq!(show["output_unicast_targets_sacn"], 2);
        assert_eq!(show["output_unicast_targets_artnet"], 1);
        assert_eq!(show["output_sacn_multicast"], true);
        assert_eq!(show["output_sacn_unicast"], true);
        assert_eq!(show["output_artnet_broadcast"], false);
        assert_eq!(show["output_artnet_unicast"], true);
        let serialized = serde_json::to_string(&events).unwrap();
        assert!(!serialized.contains("10.0.0"));
    }

    /// USB labels lose the vendor and product pair and the serial number or bus location after
    /// it, and other labels are left alone.
    #[test]
    fn usb_labels_keep_only_the_model_name() {
        assert_eq!(
            usb_model_name("Anyma uDMX (16c0:05dc) - serial A1B2C3"),
            "Anyma uDMX"
        );
        assert_eq!(
            usb_model_name("ENTTEC DMX USB PRO (0403:6001)"),
            "ENTTEC DMX USB PRO"
        );
        assert_eq!(usb_model_name("Anyma uDMX"), "Anyma uDMX");
        assert_eq!(usb_model_name("Box (rev 2)"), "Box (rev 2)");
    }

    /// The fingerprint follows reported details only.
    #[test]
    fn fingerprint_changes_with_the_patch() {
        let (mut snapshot, outputs) = show();
        let before = ShowSummary::new(&snapshot, origin, &outputs).fingerprint();
        assert_eq!(
            ShowSummary::new(&snapshot, origin, &outputs).fingerprint(),
            before
        );
        snapshot.fixtures.push(fixture("Robe", "Spiider"));
        assert_ne!(
            ShowSummary::new(&snapshot, origin, &outputs).fingerprint(),
            before
        );
    }
}

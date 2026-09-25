// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Upgrades showfile JSON written by released builds to the current schema.
//!
//! Each step rewrites the raw JSON of one schema version into the next, so persisted
//! data that no longer has a runtime type can still be read and converted.

mod action_references;

use nightfall_fixtures::bindings::{DmxRange, OutputSource};
use serde_json::Value;

use crate::CURRENT_SHOWFILE_VERSION;

/// Oldest schema version that can still be upgraded to [`CURRENT_SHOWFILE_VERSION`].
pub(crate) const OLDEST_MIGRATABLE_SHOWFILE_VERSION: u32 = 17;

/// Upgrades showfile JSON from `version` to [`CURRENT_SHOWFILE_VERSION`] in place.
///
/// Applies every migration step after `version` in order and stamps the current schema
/// version into the metadata. Callers reject versions outside the migratable range first.
pub(crate) fn migrate_showfile_json(showfile: &mut Value, version: u32) -> Result<(), String> {
    let mut version = version;
    while version < CURRENT_SHOWFILE_VERSION {
        match version {
            17 => remove_output_disabled_bindings(showfile)?,
            18 => action_references::migrate_v18_to_v19(showfile),
            _ => return Err(format!("no migration from showfile version {version}")),
        }
        version += 1;
    }
    showfile["metadata"]["showfileVersion"] = Value::from(CURRENT_SHOWFILE_VERSION);
    Ok(())
}

/// Schema 17 → 18: drops output disabled rules while keeping what they silenced unsent.
///
/// Schema 17 could disable outputs with `Output` entries in `bindings.disabled` and with
/// output bindings targeting `Disabled`. Both acted as filters that skipped every output
/// binding whose source they matched, regardless of priority. Outputs can no longer be
/// disabled, so the filters are removed together with the output bindings they matched.
fn remove_output_disabled_bindings(showfile: &mut Value) -> Result<(), String> {
    let Some(bindings) = showfile.get_mut("bindings") else {
        return Ok(());
    };

    let mut filters = Vec::new();
    if let Some(Value::Array(disabled)) = bindings.get_mut("disabled") {
        let mut retained = Vec::with_capacity(disabled.len());
        for rule in disabled.drain(..) {
            if rule["type"] == "Output" {
                filters.push(legacy_output_source(&rule["data"]["source"])?);
            } else {
                retained.push(rule);
            }
        }
        *disabled = retained;
    }

    let Some(Value::Array(outputs)) = bindings.get_mut("output") else {
        return Ok(());
    };
    let mut retained = Vec::with_capacity(outputs.len());
    let mut sources = Vec::with_capacity(outputs.len());
    for binding in outputs.drain(..) {
        let source = legacy_output_source(&binding["source"])?;
        if binding["target"]["type"] == "Disabled" {
            filters.push(source);
        } else {
            sources.push(source);
            retained.push(binding);
        }
    }

    let removed_rules = filters.len();
    let mut removed_bindings = 0;
    *outputs = retained
        .into_iter()
        .zip(sources)
        .filter_map(|(binding, source)| {
            if filters
                .iter()
                .any(|filter| legacy_filter_matches(&source, filter))
            {
                removed_bindings += 1;
                None
            } else {
                Some(binding)
            }
        })
        .collect();

    if removed_rules > 0 {
        tracing::info!(
            removed_rules,
            removed_bindings,
            "Migrated output disabled rules out of showfile"
        );
    }
    Ok(())
}

/// Reads a persisted output binding source.
fn legacy_output_source(source: &Value) -> Result<OutputSource, String> {
    serde_json::from_value(source.clone())
        .map_err(|error| format!("invalid output binding source in showfile: {error}"))
}

/// Returns whether a schema 17 output disabled filter silenced output from `source`.
///
/// Fixture filters match sources sharing a fixture, narrowed by the filter's element and
/// parameter; a whole-fixture filter also silences that fixture's additional DMX breaks.
/// Console filters match overlapping universes and, when both set one, equal addresses.
fn legacy_filter_matches(source: &OutputSource, filter: &OutputSource) -> bool {
    match (source, filter) {
        (
            OutputSource::Fixture {
                uids,
                element,
                param,
            },
            OutputSource::Fixture {
                uids: filter_uids,
                element: filter_element,
                param: filter_param,
            },
        ) => {
            uids.iter().any(|uid| filter_uids.contains(uid))
                && filter_element.is_none_or(|index| *element == Some(index))
                && filter_param
                    .as_ref()
                    .is_none_or(|name| param.as_ref() == Some(name))
        }
        (
            OutputSource::FixtureBreak { uids, dmx_break },
            OutputSource::FixtureBreak {
                uids: filter_uids,
                dmx_break: filter_break,
            },
        ) => dmx_break == filter_break && uids.iter().any(|uid| filter_uids.contains(uid)),
        (
            OutputSource::FixtureBreak { uids, .. },
            OutputSource::Fixture {
                uids: filter_uids,
                element: None,
                param: None,
            },
        ) => uids.iter().any(|uid| filter_uids.contains(uid)),
        (
            OutputSource::Console { universe, address },
            OutputSource::Console {
                universe: filter_universe,
                address: filter_address,
            },
        ) => {
            ranges_overlap(*universe, *filter_universe)
                && filter_address.is_none_or(|filter| address.is_none_or(|addr| addr == filter))
        }
        _ => false,
    }
}

/// Returns whether two optional universe ranges overlap, treating an unset range as any.
fn ranges_overlap(lhs: Option<DmxRange>, rhs: Option<DmxRange>) -> bool {
    match (lhs, rhs) {
        (Some(lhs), Some(rhs)) => lhs.start <= rhs.end && rhs.start <= lhs.end,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const FIXTURE_A: &str = "4ae7db64-12d9-4a7f-982e-268791b84766";
    const FIXTURE_B: &str = "65f290d5-06d9-4809-9e02-f7a5ab73218f";

    /// Builds a schema 17 output binding from a fixture to an sACN universe.
    fn fixture_to_sacn(uid: &str, universe: u16) -> Value {
        json!({
            "source": {"type": "Fixture", "data": {"uids": [uid], "element": null, "param": null}},
            "target": {"type": "Transport", "data": {
                "target": "sacn", "universe": {"start": universe, "end": universe}, "address": 1
            }},
            "priority": 0,
            "clone": false
        })
    }

    /// Builds a schema 17 whole-fixture output disabled rule.
    fn disabled_fixture(uid: &str) -> Value {
        json!({"type": "Output", "data": {
            "source": {"type": "Fixture", "data": {"uids": [uid], "element": null, "param": null}},
            "priority": 0,
            "clone": false
        }})
    }

    /// Builds a schema 17 input disabled rule for an sACN universe.
    fn disabled_sacn_input() -> Value {
        json!({"type": "Input", "data": {
            "source": {"type": "Transport", "data": {
                "transport": "sacn", "universe": {"start": 3, "end": 3}, "address": null
            }},
            "priority": 0,
            "clone": false
        }})
    }

    /// Output disabled rules are dropped together with the output bindings they silenced,
    /// while input rules and unaffected outputs survive and the version is stamped.
    #[test]
    fn schema_17_disabled_rules_drop_the_outputs_they_silenced() {
        let mut showfile = json!({
            "metadata": {"showfileVersion": 17},
            "bindings": {
                "input": [],
                "output": [fixture_to_sacn(FIXTURE_A, 1), fixture_to_sacn(FIXTURE_B, 2)],
                "disabled": [disabled_fixture(FIXTURE_A), disabled_sacn_input()]
            }
        });

        migrate_showfile_json(&mut showfile, 17).expect("migrate");

        assert_eq!(
            showfile["metadata"]["showfileVersion"],
            CURRENT_SHOWFILE_VERSION
        );
        assert_eq!(
            showfile["bindings"]["output"],
            json!([fixture_to_sacn(FIXTURE_B, 2)])
        );
        assert_eq!(
            showfile["bindings"]["disabled"],
            json!([disabled_sacn_input()])
        );
    }

    /// An output binding targeting `Disabled` silenced its source's other output bindings.
    #[test]
    fn schema_17_disabled_targets_drop_the_outputs_they_silenced() {
        let disabled_target = json!({
            "source": {"type": "Fixture", "data": {"uids": [FIXTURE_A], "element": null, "param": null}},
            "target": {"type": "Disabled"},
            "priority": 5,
            "clone": false
        });
        let mut showfile = json!({
            "metadata": {"showfileVersion": 17},
            "bindings": {
                "input": [],
                "output": [fixture_to_sacn(FIXTURE_A, 1), disabled_target, fixture_to_sacn(FIXTURE_B, 2)],
                "disabled": []
            }
        });

        migrate_showfile_json(&mut showfile, 17).expect("migrate");

        assert_eq!(
            showfile["bindings"]["output"],
            json!([fixture_to_sacn(FIXTURE_B, 2)])
        );
    }

    /// A whole-fixture filter silenced additional breaks, but element filters did not.
    #[test]
    fn legacy_filters_match_breaks_and_respect_element_scope() {
        let uid = FIXTURE_A.parse().unwrap();
        let fixture = |element| OutputSource::Fixture {
            uids: vec![uid],
            element,
            param: None,
        };
        let second_break = OutputSource::FixtureBreak {
            uids: vec![uid],
            dmx_break: 2,
        };

        assert!(legacy_filter_matches(&second_break, &fixture(None)));
        assert!(!legacy_filter_matches(&second_break, &fixture(Some(1))));
        assert!(legacy_filter_matches(&fixture(Some(1)), &fixture(Some(1))));
        assert!(!legacy_filter_matches(&fixture(None), &fixture(Some(1))));
    }

    /// Console filters matched overlapping universes and equal or unset addresses.
    #[test]
    fn legacy_console_filters_match_overlapping_universes() {
        let console = |start, end, address| OutputSource::Console {
            universe: Some(DmxRange { start, end }),
            address,
        };

        assert!(legacy_filter_matches(
            &console(1, 2, Some(5)),
            &console(2, 3, None)
        ));
        assert!(legacy_filter_matches(
            &console(1, 1, None),
            &console(1, 1, Some(5))
        ));
        assert!(!legacy_filter_matches(
            &console(1, 1, Some(4)),
            &console(1, 1, Some(5))
        ));
        assert!(!legacy_filter_matches(
            &console(1, 1, None),
            &console(2, 2, None)
        ));
    }
}

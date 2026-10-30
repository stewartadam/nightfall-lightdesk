// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Applies draft edits to a GDTF fixture type.
//!
//! Edits address modes, channels, functions and wheels by their position in
//! the draft view. Functions are counted across a channel's logical channels
//! in file order. Every edit either applies completely or returns an error,
//! and the caller discards the partly edited copy on error.

use std::num::NonZeroU8;

use gdtf::dmx_mode::{ChannelFunction, ChannelSet, DmxBreak, DmxChannel, DmxMode, LogicalChannel};
use gdtf::fixture_type::FixtureType;
use gdtf::geometry::{AnyGeometry, Geometry};
use gdtf::values::{ColorCie, DmxValue, Name, Node};
use gdtf::wheel::{Wheel, WheelSlot, WheelSlotOptic};

use super::catalog;
use super::commands::{BodyShape, DraftEdit, DraftFunctionFields, DraftSetFields, DraftSlotFields};
use super::draft::DraftState;
use super::templates;
use super::view::{channel_resolution, value_at};

/// Applies one edit to a draft state.
pub(super) fn apply_edit(state: &mut DraftState, edit: &DraftEdit) -> Result<(), String> {
    let fixture_type = &mut state.description.fixture_types[0];
    match edit {
        DraftEdit::SetInfo(info) => {
            fixture_type.name = Some(gdtf_name(&info.name)?);
            fixture_type.short_name = info.short_name.clone();
            fixture_type.long_name = info.long_name.clone();
            fixture_type.manufacturer = info.manufacturer.clone();
            fixture_type.description = info.description.clone();
        }
        DraftEdit::SetBody(shape) => {
            set_body(fixture_type, *shape)?;
            state.body = Some(*shape);
        }
        DraftEdit::AddMode { name, copy_of } => add_mode(fixture_type, name, *copy_of)?,
        DraftEdit::RenameMode { mode, name } => {
            let name = gdtf_name(name)?;
            ensure_unique_mode(fixture_type, &name, Some(*mode))?;
            mode_mut(fixture_type, *mode)?.name = Some(name);
        }
        DraftEdit::RemoveMode { mode } => {
            let index = position(fixture_type.dmx_modes.len(), *mode, "mode")?;
            fixture_type.dmx_modes.remove(index);
        }
        DraftEdit::AddChannel {
            mode,
            index,
            attribute,
            resolution,
        } => add_channel(fixture_type, *mode, *index, attribute, *resolution)?,
        DraftEdit::RemoveChannel { mode, channel } => {
            let mode = mode_mut(fixture_type, *mode)?;
            let index = position(mode.dmx_channels.len(), *channel, "channel")?;
            take_channel(mode, index);
        }
        DraftEdit::MoveChannel { mode, from, to } => {
            let mode = mode_mut(fixture_type, *mode)?;
            let from = position(mode.dmx_channels.len(), *from, "channel")?;
            let to = position(mode.dmx_channels.len(), *to, "channel")?;
            let channel = take_channel(mode, from);
            place_channel(mode, to, channel);
        }
        DraftEdit::SetChannelResolution {
            mode,
            channel,
            resolution,
        } => {
            let bytes = resolution_bytes(*resolution)?;
            let mode = mode_mut(fixture_type, *mode)?;
            let index = position(mode.dmx_channels.len(), *channel, "channel")?;
            resize_addresses(mode, index, bytes);
            rescale_values(&mut mode.dmx_channels[index], bytes);
        }
        DraftEdit::SetChannelHighlight {
            mode,
            channel,
            value,
        } => {
            let channel = channel_mut(mode_mut(fixture_type, *mode)?, *channel)?;
            let bytes = channel_bytes(channel);
            channel.highlight = value
                .map(|value| dmx_value(value, bytes, "highlight"))
                .transpose()?;
        }
        DraftEdit::AddFunction {
            mode,
            channel,
            function,
        } => add_function(fixture_type, *mode, *channel, function)?,
        DraftEdit::UpdateFunction {
            mode,
            channel,
            function,
            fields,
        } => update_function(fixture_type, *mode, *channel, *function, fields)?,
        DraftEdit::RemoveFunction {
            mode,
            channel,
            function,
        } => {
            let channel = channel_mut(mode_mut(fixture_type, *mode)?, *channel)?;
            let (logical, index) = function_slot(channel, *function)?;
            if function_count(channel) == 1 {
                return Err("A channel needs at least one function".to_string());
            }
            channel.logical_channels[logical]
                .channel_functions
                .remove(index);
            channel
                .logical_channels
                .retain(|logical| !logical.channel_functions.is_empty());
        }
        DraftEdit::SetFunctionSets {
            mode,
            channel,
            function,
            sets,
        } => {
            let wheels = wheel_slot_counts(fixture_type);
            let channel = channel_mut(mode_mut(fixture_type, *mode)?, *channel)?;
            set_function_sets(channel, *function, sets, &wheels)?;
        }
        DraftEdit::AddWheel { name } => {
            let name = gdtf_name(name)?;
            ensure_unique_wheel(fixture_type, &name, None)?;
            let mut wheel: Wheel = fragment("<Wheel/>")?;
            wheel.name = Some(name);
            fixture_type.wheels.push(wheel);
        }
        DraftEdit::RenameWheel { wheel, name } => rename_wheel(fixture_type, *wheel, name)?,
        DraftEdit::RemoveWheel { wheel } => {
            let index = position(fixture_type.wheels.len(), *wheel, "wheel")?;
            let name = fixture_type.wheels[index].name.clone().unwrap_or_default();
            if wheel_is_used(fixture_type, &name) {
                return Err(format!("Wheel {name} is used by a channel function"));
            }
            fixture_type.wheels.remove(index);
        }
        DraftEdit::SetWheelSlots { wheel, slots } => {
            let index = position(fixture_type.wheels.len(), *wheel, "wheel")?;
            set_wheel_slots(&mut fixture_type.wheels[index], slots)?;
        }
    }
    drop_dangling_initial_functions(fixture_type);
    Ok(())
}

/// Validates text as a GDTF name.
pub(super) fn gdtf_name(text: &str) -> Result<Name, String> {
    Name::new(text).map_err(|text| {
        format!(
            "\"{text}\" contains characters GDTF names cannot use (such as . or non-ASCII letters)"
        )
    })
}

/// Parses a GDTF element from an XML fragment.
pub(super) fn fragment<T: serde::de::DeserializeOwned>(xml: &str) -> Result<T, String> {
    quick_xml::de::from_str(xml).map_err(|error| error.to_string())
}

/// Checks a list position, naming the kind of item when it is out of range.
fn position(len: usize, index: u32, what: &str) -> Result<usize, String> {
    let index = index as usize;
    if index < len {
        Ok(index)
    } else {
        Err(format!("There is no {what} {}", index + 1))
    }
}

/// Looks up a mode by position.
fn mode_mut(fixture_type: &mut FixtureType, mode: u32) -> Result<&mut DmxMode, String> {
    let index = position(fixture_type.dmx_modes.len(), mode, "mode")?;
    Ok(&mut fixture_type.dmx_modes[index])
}

/// Looks up a channel of a mode by position.
fn channel_mut(mode: &mut DmxMode, channel: u32) -> Result<&mut DmxChannel, String> {
    let index = position(mode.dmx_channels.len(), channel, "channel")?;
    Ok(&mut mode.dmx_channels[index])
}

/// Number of functions across a channel's logical channels.
fn function_count(channel: &DmxChannel) -> usize {
    channel
        .logical_channels
        .iter()
        .map(|logical| logical.channel_functions.len())
        .sum()
}

/// Resolves a function position counted across logical channels into a logical channel and function index.
fn function_slot(channel: &DmxChannel, function: u32) -> Result<(usize, usize), String> {
    let mut remaining = function as usize;
    for (logical_index, logical) in channel.logical_channels.iter().enumerate() {
        if remaining < logical.channel_functions.len() {
            return Ok((logical_index, remaining));
        }
        remaining -= logical.channel_functions.len();
    }
    Err(format!("There is no function {}", function as usize + 1))
}

/// Checks a channel resolution in bytes.
fn resolution_bytes(resolution: u8) -> Result<NonZeroU8, String> {
    NonZeroU8::new(resolution)
        .filter(|bytes| bytes.get() <= 4)
        .ok_or_else(|| format!("Resolution must be 1 to 4 bytes, not {resolution}"))
}

/// Bytes per value of a channel.
fn channel_bytes(channel: &DmxChannel) -> NonZeroU8 {
    NonZeroU8::new(channel_resolution(channel)).unwrap_or(NonZeroU8::MIN)
}

/// Builds a DMX value at a channel resolution, rejecting values that do not fit.
fn dmx_value(value: u32, bytes: NonZeroU8, what: &str) -> Result<DmxValue, String> {
    let max = (1u64 << (8 * u32::from(bytes.get()))) - 1;
    DmxValue::new(u64::from(value), bytes, false)
        .filter(|_| u64::from(value) <= max)
        .ok_or_else(|| {
            format!(
                "The {what} value {value} does not fit in {} bytes",
                bytes.get()
            )
        })
}

/// Expresses an existing value at another resolution, as the library reads it.
fn rescale(value: DmxValue, bytes: NonZeroU8) -> DmxValue {
    DmxValue::new(u64::from(value_at(value, bytes.get())), bytes, false).unwrap_or(value)
}

/// Rejects a mode name another mode already uses.
fn ensure_unique_mode(
    fixture_type: &FixtureType,
    name: &Name,
    except: Option<u32>,
) -> Result<(), String> {
    let taken = fixture_type
        .dmx_modes
        .iter()
        .enumerate()
        .any(|(index, mode)| Some(index as u32) != except && mode.name.as_ref() == Some(name));
    if taken {
        return Err(format!("There is already a mode named {name}"));
    }
    Ok(())
}

/// Rejects a wheel name another wheel already uses.
fn ensure_unique_wheel(
    fixture_type: &FixtureType,
    name: &Name,
    except: Option<usize>,
) -> Result<(), String> {
    let taken = fixture_type
        .wheels
        .iter()
        .enumerate()
        .any(|(index, wheel)| Some(index) != except && wheel.name.as_ref() == Some(name));
    if taken {
        return Err(format!("There is already a wheel named {name}"));
    }
    Ok(())
}

/// Replaces the geometry with a body shape and points every mode and channel at it.
fn set_body(fixture_type: &mut FixtureType, shape: BodyShape) -> Result<(), String> {
    let (models, geometries) = templates::body(shape)?;
    fixture_type.models = models;
    fixture_type.geometries = geometries;
    let root = fixture_type.geometries[0]
        .name()
        .cloned()
        .unwrap_or_default();
    for mode_index in 0..fixture_type.dmx_modes.len() {
        fixture_type.dmx_modes[mode_index].geometry = Some(root.clone());
        for channel_index in 0..fixture_type.dmx_modes[mode_index].dmx_channels.len() {
            let attribute = fixture_type.dmx_modes[mode_index].dmx_channels[channel_index]
                .logical_channels
                .first()
                .map(|logical| logical.attribute.to_string())
                .unwrap_or_default();
            let geometry = geometry_for_attribute(fixture_type, &root, &attribute);
            fixture_type.dmx_modes[mode_index].dmx_channels[channel_index].geometry = geometry;
        }
    }
    Ok(())
}

/// Picks the geometry a new channel for `attribute` controls.
///
/// Pan moves the first axis, tilt the first axis inside it, and every other
/// attribute the first beam. Missing parts fall back to the mode's root.
pub(super) fn geometry_for_attribute(
    fixture_type: &FixtureType,
    root: &Name,
    attribute: &str,
) -> Name {
    let root_geometry = fixture_type
        .geometries
        .iter()
        .find(|geometry| geometry.name() == Some(root));
    let pan_axis = root_geometry.and_then(|geometry| find_geometry(geometry, &is_axis));
    let target = match attribute {
        "Pan" => pan_axis,
        "Tilt" => pan_axis.and_then(|axis| {
            axis.children()
                .iter()
                .find_map(|child| find_geometry(child, &is_axis))
        }),
        _ => root_geometry.and_then(|geometry| {
            find_geometry(geometry, &|geometry| matches!(geometry, Geometry::Beam(_)))
        }),
    };
    target
        .and_then(|geometry| geometry.name().cloned())
        .unwrap_or_else(|| root.clone())
}

/// Whether a geometry is a rotation axis.
fn is_axis(geometry: &Geometry) -> bool {
    matches!(geometry, Geometry::Axis(_))
}

/// Finds the first geometry, depth first from `geometry` itself, that matches.
fn find_geometry<'a>(
    geometry: &'a Geometry,
    matches: &dyn Fn(&Geometry) -> bool,
) -> Option<&'a Geometry> {
    if matches(geometry) {
        return Some(geometry);
    }
    geometry
        .children()
        .iter()
        .find_map(|child| find_geometry(child, matches))
}

/// Adds an empty mode on the first top-level geometry, or a copy of another mode.
fn add_mode(
    fixture_type: &mut FixtureType,
    name: &str,
    copy_of: Option<u32>,
) -> Result<(), String> {
    let name = gdtf_name(name)?;
    ensure_unique_mode(fixture_type, &name, None)?;
    let mut mode = match copy_of {
        Some(source) => {
            let index = position(fixture_type.dmx_modes.len(), source, "mode")?;
            fixture_type.dmx_modes[index].clone()
        }
        None => {
            let root = fixture_type
                .geometries
                .first()
                .and_then(|geometry| geometry.name().cloned())
                .ok_or("Pick a body shape before adding a mode")?;
            let mut mode: DmxMode = fragment("<DMXMode/>")?;
            mode.geometry = Some(root);
            mode
        }
    };
    mode.name = Some(name);
    fixture_type.dmx_modes.push(mode);
    Ok(())
}

/// Adds a channel with one function over its whole range, after the slots of the channels before it.
fn add_channel(
    fixture_type: &mut FixtureType,
    mode: u32,
    index: Option<u32>,
    attribute: &str,
    resolution: u8,
) -> Result<(), String> {
    let bytes = resolution_bytes(resolution)?;
    let attribute_name = gdtf_name(attribute)?;
    if attribute.is_empty() {
        return Err("A channel needs an attribute".to_string());
    }
    let mode_index = position(fixture_type.dmx_modes.len(), mode, "mode")?;
    let root = fixture_type.dmx_modes[mode_index]
        .geometry
        .clone()
        .ok_or("The mode has no geometry")?;
    let geometry = geometry_for_attribute(fixture_type, &root, attribute);
    catalog::ensure_attribute(fixture_type, attribute)?;

    let mut channel: DmxChannel = fragment(
        r#"<DMXChannel DMXBreak="1" Offset="1" Geometry="Body"><LogicalChannel Attribute="Dimmer"><ChannelFunction Name="Dimmer 1" Attribute="Dimmer" DMXFrom="0/1" Default="0/1" PhysicalFrom="0" PhysicalTo="1"/></LogicalChannel></DMXChannel>"#,
    )?;
    channel.geometry = geometry;
    let logical = &mut channel.logical_channels[0];
    logical.attribute = Node::new(vec![attribute_name.clone()]);
    let (physical_from, physical_to) = catalog::physical_range(attribute);
    let function = &mut logical.channel_functions[0];
    function.name = Some(gdtf_name(&format!("{attribute} 1"))?);
    function.attribute = Node::new(vec![attribute_name]);
    function.physical_from = physical_from;
    function.physical_to = physical_to;
    if let Some(offset) = &mut channel.offset {
        offset.resize(usize::from(bytes.get()), 0);
    }
    rescale_values(&mut channel, bytes);

    let dmx_mode = &mut fixture_type.dmx_modes[mode_index];
    if dmx_mode
        .dmx_channels
        .iter()
        .any(|existing| existing.name() == channel.name())
    {
        return Err(format!("The mode already has a {} channel", channel.name()));
    }
    let at = index.map_or(dmx_mode.dmx_channels.len(), |index| {
        (index as usize).min(dmx_mode.dmx_channels.len())
    });
    place_channel(dmx_mode, at, channel);
    Ok(())
}

/// Rescales every DMX value a channel holds to a new resolution.
fn rescale_values(channel: &mut DmxChannel, bytes: NonZeroU8) {
    channel.highlight = channel.highlight.map(|value| rescale(value, bytes));
    for function in channel
        .logical_channels
        .iter_mut()
        .flat_map(|logical| &mut logical.channel_functions)
    {
        function.dmx_from = rescale(function.dmx_from, bytes);
        function.default = rescale(function.default, bytes);
        for set in &mut function.channel_sets {
            set.dmx_from = rescale(set.dmx_from, bytes);
        }
    }
}

/// Moves every address above `after` in one DMX break by `delta`.
///
/// Address edits shift only what lies behind the edited channel, so gaps
/// and the order of the rest of the footprint stay as the file had them.
fn shift_addresses(mode: &mut DmxMode, dmx_break: DmxBreak, after: i32, delta: i32) {
    for channel in mode
        .dmx_channels
        .iter_mut()
        .filter(|channel| channel.dmx_break == dmx_break)
    {
        for address in channel.offset.iter_mut().flatten() {
            if *address > after {
                *address += delta;
            }
        }
    }
}

/// Removes a channel and moves the addresses behind it down to close its slots.
fn take_channel(mode: &mut DmxMode, index: usize) -> DmxChannel {
    let channel = mode.dmx_channels.remove(index);
    if let Some(&last) = channel.offset.iter().flatten().max() {
        let width = channel.offset.as_ref().map_or(0, Vec::len) as i32;
        shift_addresses(mode, channel.dmx_break, last, -width);
    }
    channel
}

/// Inserts a channel, giving it the slots right after the channels before it in its break.
///
/// Addresses behind the new slots move up to make room. Virtual channels
/// keep having no addresses.
fn place_channel(mode: &mut DmxMode, index: usize, mut channel: DmxChannel) {
    if let Some(offset) = &mut channel.offset
        && !offset.is_empty()
    {
        let start = mode.dmx_channels[..index]
            .iter()
            .filter(|before| before.dmx_break == channel.dmx_break)
            .flat_map(|before| before.offset.iter().flatten())
            .copied()
            .max()
            .unwrap_or(0);
        let width = offset.len() as i32;
        shift_addresses(mode, channel.dmx_break, start, width);
        *offset = (start + 1..=start + width).collect();
    }
    mode.dmx_channels.insert(index, channel);
}

/// Gives a channel `bytes` slots starting at its first one, moving the addresses behind it.
fn resize_addresses(mode: &mut DmxMode, index: usize, bytes: NonZeroU8) {
    let channel = &mode.dmx_channels[index];
    let Some(first) = channel.offset.iter().flatten().copied().min() else {
        return;
    };
    let old_width = channel.offset.as_ref().map_or(0, Vec::len) as i32;
    let new_width = i32::from(bytes.get());
    let dmx_break = channel.dmx_break;
    shift_addresses(
        mode,
        dmx_break,
        first + old_width - 1,
        new_width - old_width,
    );
    mode.dmx_channels[index].offset = Some((first..first + new_width).collect());
}

/// Adds a function to a channel's last logical channel, in DMX order.
fn add_function(
    fixture_type: &mut FixtureType,
    mode: u32,
    channel: u32,
    fields: &DraftFunctionFields,
) -> Result<(), String> {
    catalog::ensure_attribute(fixture_type, &fields.attribute)?;
    let wheels = wheel_names(fixture_type);
    let channel = channel_mut(mode_mut(fixture_type, mode)?, channel)?;
    let bytes = channel_bytes(channel);
    let logical = channel
        .logical_channels
        .last_mut()
        .ok_or("The channel has no logical channel")?;
    let mut function: ChannelFunction = fragment(
        r#"<ChannelFunction Name="Function" Attribute="Dimmer" DMXFrom="0/1" Default="0/1" PhysicalFrom="0" PhysicalTo="1"/>"#,
    )?;
    apply_function_fields(&mut function, fields, bytes, &wheels)?;
    insert_function(logical, function, bytes)
}

/// Replaces a function's editable values and keeps its logical channel in DMX order.
///
/// A logical channel with only this function follows its attribute.
fn update_function(
    fixture_type: &mut FixtureType,
    mode: u32,
    channel: u32,
    function: u32,
    fields: &DraftFunctionFields,
) -> Result<(), String> {
    catalog::ensure_attribute(fixture_type, &fields.attribute)?;
    let wheels = wheel_names(fixture_type);
    let channel = channel_mut(mode_mut(fixture_type, mode)?, channel)?;
    let bytes = channel_bytes(channel);
    let (logical_index, index) = function_slot(channel, function)?;
    let logical = &mut channel.logical_channels[logical_index];
    let mut updated = logical.channel_functions.remove(index);
    apply_function_fields(&mut updated, fields, bytes, &wheels)?;
    if logical.channel_functions.is_empty() {
        logical.attribute = updated.attribute.clone();
    }
    insert_function(logical, updated, bytes)
}

/// Inserts a function before the first function starting above it, rejecting duplicate names and starts.
fn insert_function(
    logical: &mut LogicalChannel,
    function: ChannelFunction,
    bytes: NonZeroU8,
) -> Result<(), String> {
    let start = |function: &ChannelFunction| value_at(function.dmx_from, bytes.get());
    if let Some(existing) = logical
        .channel_functions
        .iter()
        .find(|existing| existing.name == function.name || start(existing) == start(&function))
    {
        return Err(format!(
            "Function {} already uses that name or start value",
            existing.name.clone().unwrap_or_default()
        ));
    }
    let at = logical
        .channel_functions
        .iter()
        .position(|existing| start(existing) > start(&function))
        .unwrap_or(logical.channel_functions.len());
    logical.channel_functions.insert(at, function);
    Ok(())
}

/// Copies editable values onto a function, validating names, values and the wheel.
fn apply_function_fields(
    function: &mut ChannelFunction,
    fields: &DraftFunctionFields,
    bytes: NonZeroU8,
    wheels: &[Name],
) -> Result<(), String> {
    function.name = Some(gdtf_name(&fields.name)?);
    function.attribute = Node::new(vec![gdtf_name(&fields.attribute)?]);
    function.dmx_from = dmx_value(fields.dmx_from, bytes, "start")?;
    function.default = dmx_value(fields.default, bytes, "default")?;
    function.physical_from = fields.physical_from;
    function.physical_to = fields.physical_to;
    function.wheel = match &fields.wheel {
        Some(wheel) => {
            let name = gdtf_name(wheel)?;
            if !wheels.contains(&name) {
                return Err(format!("There is no wheel named {wheel}"));
            }
            Some(Node::new(vec![name]))
        }
        None => None,
    };
    Ok(())
}

/// Replaces a function's named ranges after checking they are ascending, inside the
/// function, and select slots its wheel has.
fn set_function_sets(
    channel: &mut DmxChannel,
    function: u32,
    sets: &[DraftSetFields],
    wheels: &[(Name, usize)],
) -> Result<(), String> {
    let bytes = channel_bytes(channel);
    let (logical_index, index) = function_slot(channel, function)?;
    let functions = &mut channel.logical_channels[logical_index].channel_functions;
    let start = u64::from(value_at(functions[index].dmx_from, bytes.get()));
    let end = functions
        .get(index + 1)
        .map_or((1u64 << (8 * u32::from(bytes.get()))) - 1, |next| {
            u64::from(value_at(next.dmx_from, bytes.get())).saturating_sub(1)
        });
    let slots = functions[index]
        .wheel
        .as_ref()
        .and_then(|wheel| {
            wheels
                .iter()
                .find(|(name, _)| wheel.as_ref() == std::slice::from_ref(name))
        })
        .map(|(_, slots)| *slots);
    let mut previous = None;
    let mut channel_sets = Vec::with_capacity(sets.len());
    for fields in sets {
        let value = u64::from(fields.dmx_from);
        if value < start || value > end {
            return Err(format!(
                "Range {} starts at {value}, outside the function's {start} to {end}",
                fields.name
            ));
        }
        if previous.is_some_and(|previous| value <= previous) {
            return Err(format!(
                "Range {} must start after the range before it",
                fields.name
            ));
        }
        if let Some(slot) = fields.wheel_slot {
            let Some(slots) = slots else {
                return Err(format!(
                    "Range {} selects a wheel slot, but the function has no wheel",
                    fields.name
                ));
            };
            if slot < 1 || slot as usize > slots {
                return Err(format!(
                    "Range {} selects slot {slot}, but the wheel has {slots} slots",
                    fields.name
                ));
            }
        }
        previous = Some(value);
        let mut set: ChannelSet = fragment(r#"<ChannelSet DMXFrom="0/1"/>"#)?;
        set.name = Some(gdtf_name(&fields.name)?);
        set.dmx_from = dmx_value(fields.dmx_from, bytes, "range start")?;
        set.wheel_slot_index = fields.wheel_slot;
        channel_sets.push(set);
    }
    functions[index].channel_sets = channel_sets;
    Ok(())
}

/// Name and slot count of every named wheel of a fixture type.
pub(super) fn wheel_slot_counts(fixture_type: &FixtureType) -> Vec<(Name, usize)> {
    fixture_type
        .wheels
        .iter()
        .filter_map(|wheel| Some((wheel.name.clone()?, wheel.slots.len())))
        .collect()
}

/// Names of every wheel of a fixture type.
fn wheel_names(fixture_type: &FixtureType) -> Vec<Name> {
    fixture_type
        .wheels
        .iter()
        .filter_map(|wheel| wheel.name.clone())
        .collect()
}

/// Every channel function of a fixture type, for changing.
fn functions_mut(fixture_type: &mut FixtureType) -> impl Iterator<Item = &mut ChannelFunction> {
    fixture_type
        .dmx_modes
        .iter_mut()
        .flat_map(|mode| &mut mode.dmx_channels)
        .flat_map(|channel| &mut channel.logical_channels)
        .flat_map(|logical| &mut logical.channel_functions)
}

/// Whether any channel function selects slots of the named wheel.
fn wheel_is_used(fixture_type: &FixtureType, name: &Name) -> bool {
    fixture_type
        .dmx_modes
        .iter()
        .flat_map(|mode| &mode.dmx_channels)
        .flat_map(|channel| &channel.logical_channels)
        .flat_map(|logical| &logical.channel_functions)
        .any(|function| references_wheel(function, name))
}

/// Whether a function's wheel link names `wheel`.
fn references_wheel(function: &ChannelFunction, wheel: &Name) -> bool {
    function
        .wheel
        .as_ref()
        .is_some_and(|node| node.as_ref() == std::slice::from_ref(wheel))
}

/// Renames a wheel and every function link to it.
fn rename_wheel(fixture_type: &mut FixtureType, wheel: u32, name: &str) -> Result<(), String> {
    let index = position(fixture_type.wheels.len(), wheel, "wheel")?;
    let name = gdtf_name(name)?;
    ensure_unique_wheel(fixture_type, &name, Some(index))?;
    let old = fixture_type.wheels[index].name.replace(name.clone());
    if let Some(old) = old {
        for function in functions_mut(fixture_type) {
            if references_wheel(function, &old) {
                function.wheel = Some(Node::new(vec![name.clone()]));
            }
        }
    }
    Ok(())
}

/// Replaces a wheel's slots, keeping media, facets and filters of slots that stay in place.
fn set_wheel_slots(wheel: &mut Wheel, slots: &[DraftSlotFields]) -> Result<(), String> {
    let mut existing = std::mem::take(&mut wheel.slots).into_iter();
    let mut updated = Vec::with_capacity(slots.len());
    for fields in slots {
        let mut slot = match existing.next() {
            Some(slot) => slot,
            None => fragment::<WheelSlot>(r#"<Slot Color="0.3127,0.3290,100"/>"#)?,
        };
        slot.name = Some(gdtf_name(&fields.name)?);
        if let Some([x, y, z]) = fields.color {
            slot.optic = WheelSlotOptic::Color(ColorCie { x, y, z });
        }
        updated.push(slot);
    }
    wheel.slots = updated;
    Ok(())
}

/// Clears initial-function links that no longer name one of their channel's functions.
///
/// The link spells out the channel name, which follows the channel's
/// geometry and first attribute, so edits to either break it. A channel
/// without the link starts at its first function.
fn drop_dangling_initial_functions(fixture_type: &mut FixtureType) {
    for channel in fixture_type
        .dmx_modes
        .iter_mut()
        .flat_map(|mode| &mut mode.dmx_channels)
    {
        let Some(initial) = &channel.initial_function else {
            continue;
        };
        let channel_name = channel.name();
        let valid = channel.logical_channels.iter().any(|logical| {
            logical.channel_functions.iter().any(|function| {
                let [channel_part, logical_part, function_part] = initial.as_ref() else {
                    return false;
                };
                *channel_part == channel_name
                    && logical.attribute.as_ref().last() == Some(logical_part)
                    && function.name.as_ref() == Some(function_part)
            })
        });
        if !valid {
            channel.initial_function = None;
        }
    }
}

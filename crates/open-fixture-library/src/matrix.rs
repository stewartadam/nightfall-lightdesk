// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Matrix pixel layout semantics from the OFL fixture format

use std::cmp::Ordering;

use crate::schema::{
    OflAllPixels, OflMatrix, OflPixelConstraints, OflPixelGroup, OflRepeatFor, OflRepeatOrder,
};

/// A matrix pixel and its 1-based position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OflPixel {
    /// Pixel key, which replaces `$pixelKey` in template channel keys
    pub key: String,
    /// 1-based position along X, Y and Z
    pub position: [usize; 3],
}

/// Axis indexes into an [`OflPixel::position`].
const X: usize = 0;
/// Y axis index.
const Y: usize = 1;
/// Z axis index.
const Z: usize = 2;

impl OflMatrix {
    /// Returns every pixel in definition order: Z outermost, then Y, then X.
    ///
    /// Pixels come from `pixelKeys` when present. Otherwise keys are generated from
    /// `pixelCount` like OFL does: `"3"` for a single axis, `"(2, 3)"` for two and
    /// `"(1, 2, 3)"` for three.
    pub fn pixels(&self) -> Vec<OflPixel> {
        if let Some(pixel_keys) = &self.pixel_keys {
            let mut pixels = Vec::new();
            for (z, plane) in pixel_keys.iter().enumerate() {
                for (y, row) in plane.iter().enumerate() {
                    for (x, key) in row.iter().enumerate() {
                        if let Some(key) = key {
                            pixels.push(OflPixel {
                                key: key.clone(),
                                position: [x + 1, y + 1, z + 1],
                            });
                        }
                    }
                }
            }
            return pixels;
        }

        let [count_x, count_y, count_z] = self
            .pixel_count
            .unwrap_or([0; 3])
            .map(|count| count as usize);
        let defined_axes: Vec<usize> = [(X, count_x), (Y, count_y), (Z, count_z)]
            .into_iter()
            .filter(|(_, count)| *count > 1)
            .map(|(axis, _)| axis)
            .collect();
        let mut pixels = Vec::new();
        for z in 1..=count_z {
            for y in 1..=count_y {
                for x in 1..=count_x {
                    let position = [x, y, z];
                    let key = match defined_axes.as_slice() {
                        [_, _, _] => format!("({x}, {y}, {z})"),
                        [first, second] => format!("({}, {})", position[*first], position[*second]),
                        _ => x.max(y).max(z).to_string(),
                    };
                    pixels.push(OflPixel { key, position });
                }
            }
        }
        pixels
    }

    /// Returns the axes that hold more than one pixel, outermost (Z) first.
    pub fn defined_axes(&self) -> Vec<usize> {
        let pixels = self.pixels();
        [Z, Y, X]
            .into_iter()
            .filter(|axis| pixels.iter().any(|pixel| pixel.position[*axis] > 1))
            .collect()
    }

    /// Returns every pixel key sorted in natural order, so `"2"` sorts before `"10"`.
    pub fn pixel_keys_abc(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.pixels().into_iter().map(|pixel| pixel.key).collect();
        keys.sort_by(|a, b| natural_cmp(a, b));
        keys
    }

    /// Returns every pixel key with `first` changing fastest, then `second`, then `third`.
    fn pixel_keys_by_axes(&self, first: usize, second: usize, third: usize) -> Vec<String> {
        let mut pixels = self.pixels();
        pixels.sort_by(|a, b| natural_cmp(&a.key, &b.key));
        pixels.sort_by_key(|pixel| {
            (
                pixel.position[third],
                pixel.position[second],
                pixel.position[first],
            )
        });
        pixels.into_iter().map(|pixel| pixel.key).collect()
    }

    /// Returns each pixel group's key and member pixel keys, in definition order.
    pub fn pixel_groups(&self) -> Vec<(String, Vec<String>)> {
        self.pixel_groups
            .iter()
            .map(|(group_key, group)| {
                let members = match group {
                    OflPixelGroup::All(OflAllPixels::All) => self.pixel_keys_abc(),
                    OflPixelGroup::Keys(keys) => keys.clone(),
                    OflPixelGroup::Constraints(constraints) => self.pixels_matching(constraints),
                };
                (group_key.clone(), members)
            })
            .collect()
    }

    /// Returns the keys of pixels satisfying every constraint, in natural key order when
    /// a name constraint is present and in X, Y, Z order otherwise, as OFL does.
    fn pixels_matching(&self, constraints: &OflPixelConstraints) -> Vec<String> {
        let candidates = if constraints.name.is_empty() {
            self.pixel_keys_by_axes(X, Y, Z)
        } else {
            self.pixel_keys_abc()
        };
        let positions: std::collections::HashMap<String, [usize; 3]> = self
            .pixels()
            .into_iter()
            .map(|pixel| (pixel.key, pixel.position))
            .collect();
        let patterns: Option<Vec<regex::Regex>> = constraints
            .name
            .iter()
            .map(|pattern| regex::Regex::new(pattern).ok())
            .collect();
        let Some(patterns) = patterns else {
            return Vec::new();
        };
        candidates
            .into_iter()
            .filter(|key| {
                let position = positions[key];
                [&constraints.x, &constraints.y, &constraints.z]
                    .into_iter()
                    .enumerate()
                    .all(|(axis, axis_constraints)| {
                        axis_constraints
                            .iter()
                            .all(|constraint| position_matches(constraint, position[axis]))
                    })
                    && patterns.iter().all(|pattern| pattern.is_match(key))
            })
            .collect()
    }

    /// Returns the pixel or pixel group keys a matrix channel insert repeats for, in order.
    pub fn repeat_for_keys(&self, repeat_for: &OflRepeatFor) -> Vec<String> {
        let order = match repeat_for {
            OflRepeatFor::Keys(keys) => return keys.clone(),
            OflRepeatFor::Order(order) => *order,
        };
        match order {
            OflRepeatOrder::EachPixelGroup => self.pixel_groups.keys().cloned().collect(),
            OflRepeatOrder::EachPixelAbc => self.pixel_keys_abc(),
            OflRepeatOrder::EachPixelXyz => self.pixel_keys_by_axes(X, Y, Z),
            OflRepeatOrder::EachPixelXzy => self.pixel_keys_by_axes(X, Z, Y),
            OflRepeatOrder::EachPixelYxz => self.pixel_keys_by_axes(Y, X, Z),
            OflRepeatOrder::EachPixelYzx => self.pixel_keys_by_axes(Y, Z, X),
            OflRepeatOrder::EachPixelZxy => self.pixel_keys_by_axes(Z, X, Y),
            OflRepeatOrder::EachPixelZyx => self.pixel_keys_by_axes(Z, Y, X),
        }
    }
}

/// Returns whether a 1-based pixel position satisfies an OFL position constraint:
/// `"=n"`, `">=n"`, `"<=n"`, `"an"`, `"an+b"`, `"even"` or `"odd"`. Malformed
/// constraints match nothing.
fn position_matches(constraint: &str, position: usize) -> bool {
    let parse = |text: &str| text.parse::<usize>().ok();
    if let Some(min) = constraint.strip_prefix(">=") {
        return parse(min).is_some_and(|min| position >= min);
    }
    if let Some(max) = constraint.strip_prefix("<=") {
        return parse(max).is_some_and(|max| position <= max);
    }
    if let Some(exact) = constraint.strip_prefix('=') {
        return parse(exact).is_some_and(|exact| position == exact);
    }
    let constraint = match constraint {
        "even" => "2n",
        "odd" => "2n+1",
        other => other,
    };
    let Some((divisor, remainder)) = constraint.split_once('n') else {
        return false;
    };
    let remainder = match remainder {
        "" => Some(0),
        remainder => remainder.strip_prefix('+').and_then(parse),
    };
    match (parse(divisor), remainder) {
        (Some(divisor), Some(remainder)) if divisor > 0 => position % divisor == remainder,
        _ => false,
    }
}

/// Compares keys in natural order: digit runs compare by value and other text compares
/// case-insensitively, so `"Pixel 2"` sorts before `"Pixel 10"`. Keys equal under
/// those rules fall back to plain string order, so the order stays total.
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut rest_a, mut rest_b) = (a, b);
    loop {
        match (rest_a.chars().next(), rest_b.chars().next()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(char_a), Some(char_b)) if char_a.is_ascii_digit() && char_b.is_ascii_digit() => {
                let (number_a, after_a) = split_digits(rest_a);
                let (number_b, after_b) = split_digits(rest_b);
                let trimmed_a = number_a.trim_start_matches('0');
                let trimmed_b = number_b.trim_start_matches('0');
                let ordering = trimmed_a
                    .len()
                    .cmp(&trimmed_b.len())
                    .then_with(|| trimmed_a.cmp(trimmed_b));
                if ordering != Ordering::Equal {
                    return ordering;
                }
                (rest_a, rest_b) = (after_a, after_b);
            }
            (Some(char_a), Some(char_b)) => {
                let ordering = char_a.to_lowercase().cmp(char_b.to_lowercase());
                if ordering != Ordering::Equal {
                    return ordering;
                }
                rest_a = &rest_a[char_a.len_utf8()..];
                rest_b = &rest_b[char_b.len_utf8()..];
            }
        }
    }
}

/// Splits `text` after its leading run of ASCII digits.
fn split_digits(text: &str) -> (&str, &str) {
    let end = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    text.split_at(end)
}

#[cfg(test)]
mod tests;

// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/// A result type that represents a partial success: the operation produced a value,
/// but encountered issues that the caller should be aware of.
///
/// Unlike `Result<T, E>`, `PartialResult` always contains a value. The caller must
/// decide whether to use the partial value or treat the issues as fatal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartialResult<T> {
    /// The (possibly partial) result value
    pub value: T,
    /// Issues encountered during the operation
    pub issues: Vec<String>,
}

impl<T> PartialResult<T> {
    /// Creates a complete result with no issues.
    pub fn complete(value: T) -> Self {
        Self {
            value,
            issues: vec![],
        }
    }

    /// Creates a partial result with one issue.
    pub fn partial(value: T, issue: impl Into<String>) -> Self {
        Self {
            value,
            issues: vec![issue.into()],
        }
    }

    /// Creates a partial result with multiple issues.
    pub fn partial_many(value: T, issues: Vec<String>) -> Self {
        Self { value, issues }
    }

    /// Returns true if the result is complete (no issues).
    pub fn is_complete(&self) -> bool {
        self.issues.is_empty()
    }

    /// Returns true if the result is partial (has issues).
    pub fn is_partial(&self) -> bool {
        !self.issues.is_empty()
    }

    /// Adds an issue to this result.
    pub fn add_issue(&mut self, issue: impl Into<String>) {
        self.issues.push(issue.into());
    }

    /// Consumes the result, returning just the value and discarding issues.
    pub fn into_value(self) -> T {
        self.value
    }

    /// Consumes the result, returning the value and issues separately.
    pub fn into_parts(self) -> (T, Vec<String>) {
        (self.value, self.issues)
    }

    /// Maps the value while preserving issues.
    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> PartialResult<U> {
        PartialResult {
            value: f(self.value),
            issues: self.issues,
        }
    }

    /// Merges another partial result, combining values and issues.
    pub fn merge<U, V>(
        self,
        other: PartialResult<U>,
        combine: impl FnOnce(T, U) -> V,
    ) -> PartialResult<V> {
        let mut issues = self.issues;
        issues.extend(other.issues);
        PartialResult {
            value: combine(self.value, other.value),
            issues,
        }
    }

    /// Extends this result's issues with issues from another result.
    pub fn extend_issues(&mut self, other: &PartialResult<impl Sized>) {
        self.issues.extend(other.issues.iter().cloned());
    }
}

impl<T: Default> Default for PartialResult<T> {
    fn default() -> Self {
        Self::complete(T::default())
    }
}

impl<T> From<T> for PartialResult<T> {
    fn from(value: T) -> Self {
        Self::complete(value)
    }
}

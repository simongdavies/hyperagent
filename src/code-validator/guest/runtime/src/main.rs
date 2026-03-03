/*
Copyright 2026  The Hyperlight Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

//! Hyperlight Analysis Runtime - Entry Point
//!
//! This binary provides secure, ReDoS-safe code analysis functions
//! running inside a Hyperlight micro-VM.
//!
//! When compiled for `hyperlight` target, it runs as a guest binary.
//! When compiled normally, it provides a CLI for local testing.

#![cfg_attr(hyperlight, no_std)]
#![cfg_attr(hyperlight, no_main)]
// Prevent panics in release code - guest crashes bring down the host
#![deny(clippy::unwrap_used)]
#![deny(clippy::expect_used)]
#![deny(clippy::panic)]

#[cfg(hyperlight)]
mod libc;

#[cfg(hyperlight)]
include!("main/hyperlight.rs");

#[cfg(not(hyperlight))]
include!("main/native.rs");

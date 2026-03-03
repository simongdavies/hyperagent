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

// Native CLI entry point for local testing.
//
// This module is compiled when NOT targeting the Hyperlight micro-VM.
// It provides a command-line interface for testing analysis functions.

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "hyperlight-analysis-runtime")]
#[command(about = "Code analysis runtime - native CLI for testing")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Ping the runtime (test connectivity)
    Ping {
        /// Message to echo back
        message: String,
    },
}

#[allow(clippy::unwrap_used)] // CLI code - panics are acceptable for output errors
fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Ping { message } => {
            let result = hyperlight_analysis_runtime::ping(&message);
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
        }
    }
}

mod engine;
mod limits;
mod margin;
mod pnl;
mod types;

use engine::RiskEngine;
use std::io::{self, BufRead, Write};
use types::Command;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    let mut engine = RiskEngine::new();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                let _ = writeln!(stdout, r#"{{"error":"stdin read error: {}"}}"#, e);
                continue;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let cmd: Command = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                let _ = writeln!(stdout, r#"{{"error":"parse error: {}"}}"#, e);
                let _ = stdout.flush();
                continue;
            }
        };

        let response = engine.handle(cmd);
        let json = serde_json::to_string(&response).unwrap_or_else(|e| {
            format!(r#"{{"error":"serialize error: {}"}}"#, e)
        });

        let _ = writeln!(stdout, "{}", json);
        let _ = stdout.flush();
    }
}

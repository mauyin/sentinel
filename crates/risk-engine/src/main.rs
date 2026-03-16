mod circuit;
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

        // WS1.5: Parse as Value first to extract seq ID
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(stdout, r#"{{"error":"parse error: {}"}}"#, e);
                let _ = stdout.flush();
                continue;
            }
        };

        // Extract optional seq field
        let seq = value.get("seq").and_then(|v| v.as_u64());

        // Deserialize the command (ignores unknown fields like seq)
        let cmd: Command = match serde_json::from_value(value) {
            Ok(c) => c,
            Err(e) => {
                let err_json = if let Some(seq) = seq {
                    format!(r#"{{"seq":{},"error":"parse error: {}"}}"#, seq, e)
                } else {
                    format!(r#"{{"error":"parse error: {}"}}"#, e)
                };
                let _ = writeln!(stdout, "{}", err_json);
                let _ = stdout.flush();
                continue;
            }
        };

        let response = engine.handle(cmd);

        // Serialize response and inject seq if present
        let json = match serde_json::to_value(&response) {
            Ok(mut val) => {
                if let Some(seq) = seq {
                    if let serde_json::Value::Object(ref mut map) = val {
                        map.insert(
                            "seq".to_string(),
                            serde_json::Value::Number(seq.into()),
                        );
                    }
                }
                serde_json::to_string(&val).unwrap_or_else(|e| {
                    format!(r#"{{"error":"serialize error: {}"}}"#, e)
                })
            }
            Err(e) => {
                format!(r#"{{"error":"serialize error: {}"}}"#, e)
            }
        };

        let _ = writeln!(stdout, "{}", json);
        let _ = stdout.flush();
    }
}

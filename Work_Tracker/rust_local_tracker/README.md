# Rust Local Tracker

This folder is a starter for moving the local monitoring logic out of Python into Rust.

## Current purpose
- create the SQLite schema locally
- capture session metadata such as employee, role, task, project
- prepare a future Rust polling loop for app/window tracking
- keep the Python cloud API untouched for now

## Run

```bash
cd rust_local_tracker
cargo run
```

## Future direction
- replace Python polling logic with Rust foreground-window sampling
- serialize metadata as JSON and forward to the cloud API
- keep classification and analytics in Python on the cloud side

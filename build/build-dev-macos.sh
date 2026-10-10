#!/bin/bash
source "$HOME/.cargo/env"
cd build/tauri && npm run tauri:dev -- --features debug-tools

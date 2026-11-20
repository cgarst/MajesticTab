#!/bin/bash

# Works from any directory
cd "$(dirname "$0")/../.." || exit 1

# Run on macOS only
python3 support/tools/simulator_screenshots.py all

# Run on Linux only
# node support/tools/flathub_screenshots.mjs

# Run anywhere
python3 support/tools/store_screenshots.py all
python3 support/tools/webpage_screenshots.py
python3 support/tools/marketing_art.py all

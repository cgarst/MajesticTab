"""Patch the Microsoft Store listing text in a submission JSON from support/listing.

Usage: msstore_listing.py <submission.json> [language]

Reads the draft produced by `msstore submission get`, replaces the description, short
description and release notes of the given listing language (default en-us), and rewrites the file in place so
it can be sent back with `msstore submission update`. Everything else in the draft is left as is.
"""
import json
import subprocess
import sys
from pathlib import Path

LISTING = Path(__file__).resolve().parents[1] / "listing"


def release_notes():
    """Current version's notes, from the same script the other channels use (fails on a placeholder)."""
    script = Path(__file__).resolve().parents[2] / "build" / "release-notes.mjs"
    return subprocess.run(["node", str(script)], check=True, capture_output=True, text=True).stdout.strip()


def read_sections(directory):
    return {
        "Short description": (directory / "short_description.txt").read_text(encoding="utf-8").strip(),
        "Full description": (directory / "full_description.txt").read_text(encoding="utf-8").strip(),
        "Release notes": release_notes(),
    }


def pick(mapping, key):
    for k in mapping:
        if k.lower() == key.lower():
            return k
    raise SystemExit(f"No '{key}' key in {sorted(mapping)}")


def main():
    path = Path(sys.argv[1])
    language = sys.argv[2] if len(sys.argv) > 2 else "en-us"
    text = read_sections(LISTING)
    draft = json.loads(path.read_text(encoding="utf-8"))

    listings = draft[pick(draft, "listings")]
    listing = listings[pick(listings, language)]
    base = listing[pick(listing, "baseListing")]
    base[pick(base, "description")] = text["Full description"]
    base[pick(base, "shortDescription")] = text["Short description"]
    base[pick(base, "releaseNotes")] = text["Release notes"]

    path.write_text(json.dumps(draft, indent=2), encoding="utf-8")
    print(f"Patched {language}: {len(text['Full description'])} chars description")


if __name__ == "__main__":
    main()

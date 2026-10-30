"""Patch the Microsoft Store listing text in a submission JSON from support/store/description.txt.

Usage: msstore_listing.py <submission.json> [language]

Reads the draft produced by `msstore submission get`, replaces the description and short
description of the given listing language (default en-us), and rewrites the file in place so
it can be sent back with `msstore submission update`. Everything else in the draft is left as is.
"""
import json
import re
import sys
from pathlib import Path

DESCRIPTION = Path(__file__).resolve().parent.parent / "store" / "description.txt"


def read_sections(path):
    sections = {}
    name = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if re.fullmatch(r"-{3,}", line.strip()):
            continue
        if line in ("Short description", "Full description"):
            name = line
            sections[name] = []
        elif name:
            sections[name].append(line)
    return {k: "\n".join(v).strip() for k, v in sections.items()}


def pick(mapping, key):
    for k in mapping:
        if k.lower() == key.lower():
            return k
    raise SystemExit(f"No '{key}' key in {sorted(mapping)}")


def main():
    path = Path(sys.argv[1])
    language = sys.argv[2] if len(sys.argv) > 2 else "en-us"
    text = read_sections(DESCRIPTION)
    draft = json.loads(path.read_text(encoding="utf-8"))

    listings = draft[pick(draft, "listings")]
    listing = listings[pick(listings, language)]
    base = listing[pick(listing, "baseListing")]
    base[pick(base, "description")] = text["Full description"]
    base[pick(base, "shortDescription")] = text["Short description"]

    path.write_text(json.dumps(draft, indent=2), encoding="utf-8")
    print(f"Patched {language}: {len(text['Full description'])} chars description")


if __name__ == "__main__":
    main()

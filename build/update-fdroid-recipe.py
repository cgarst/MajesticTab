#!/usr/bin/env python3
"""Update F-Droid's net.zathu.majestictab.yml recipe for a new release."""

import argparse
import json
import re
from pathlib import Path

ABI_OFFSETS = {
    "armeabi-v7a": 1,
    "arm64-v8a": 2,
    "x86_64": 4,
}


def update_recipe(text: str, version: str, base_vercode: int, commit: str) -> str:
    """Update versionName, versionCode, commit, and CurrentVersion* in-place."""
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError(f"Expected X.Y.Z version, got: {version!r}")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError(f"Expected 40-char commit SHA, got: {commit!r}")

    # Split into header, Builds blocks, and footer (AllowedAPKSigningKeys onward).
    builds_match = re.search(r"(?m)^Builds:\n", text)
    footer_match = re.search(r"(?m)^AllowedAPKSigningKeys:", text)
    if not builds_match or not footer_match or footer_match.start() <= builds_match.end():
        raise ValueError("Could not locate Builds: ... AllowedAPKSigningKeys: section")

    header = text[: builds_match.end()]
    builds_body = text[builds_match.end() : footer_match.start()]
    footer = text[footer_match.start() :]

    # Split Builds into individual `- versionName:` blocks.
    block_starts = [m.start() for m in re.finditer(r"(?m)^  - versionName:", builds_body)]
    if len(block_starts) != len(ABI_OFFSETS):
        raise ValueError(
            f"Expected {len(ABI_OFFSETS)} build blocks in Builds:, found {len(block_starts)}"
        )

    blocks = [
        builds_body[block_starts[i] : (block_starts[i + 1] if i + 1 < len(block_starts) else len(builds_body))]
        for i in range(len(block_starts))
    ]

    seen_abis = set()
    updated_blocks = []
    for block in blocks:
        abi_match = re.search(r"--abi=(armeabi-v7a|arm64-v8a|x86_64)\b", block)
        if not abi_match:
            raise ValueError("Build block is missing --abi=<abi>")
        abi = abi_match.group(1)
        seen_abis.add(abi)
        vercode = base_vercode * 10 + ABI_OFFSETS[abi]

        block, n1 = re.subn(r"(?m)^(  - versionName: ).+$", rf"\g<1>{version}", block, count=1)
        block, n2 = re.subn(r"(?m)^(    versionCode: ).+$", rf"\g<1>{vercode}", block, count=1)
        block, n3 = re.subn(r"(?m)^(    commit: ).+$", rf"\g<1>{commit}", block, count=1)
        if (n1, n2, n3) != (1, 1, 1):
            raise ValueError(f"Failed to update fields in {abi} block: {(n1, n2, n3)}")
        updated_blocks.append(block)

    if seen_abis != set(ABI_OFFSETS):
        raise ValueError(f"Missing ABIs in Builds:: {set(ABI_OFFSETS) - seen_abis}")

    max_vercode = base_vercode * 10 + max(ABI_OFFSETS.values())
    footer, n4 = re.subn(r"(?m)^(CurrentVersion: ).+$", rf"\g<1>{version}", footer, count=1)
    footer, n5 = re.subn(r"(?m)^(CurrentVersionCode: ).+$", rf"\g<1>{max_vercode}", footer, count=1)
    if (n4, n5) != (1, 1):
        raise ValueError(f"Failed to update CurrentVersion/CurrentVersionCode: {(n4, n5)}")

    return header + "".join(updated_blocks) + footer


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recipe", type=Path, required=True, help="Path to net.zathu.majestictab.yml")
    parser.add_argument("--commit", required=True, help="Full 40-char git commit SHA of the release tag")
    parser.add_argument("--version", help="App version (defaults to tauri.conf.json)")
    parser.add_argument("--base-vercode", type=int, help="Base versionCode (defaults to tauri.android.conf.json)")
    args = parser.parse_args()

    version = args.version or json.loads(
        (repo_root / "build/tauri/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
    )["version"]
    base_vercode = args.base_vercode or json.loads(
        (repo_root / "build/tauri/src-tauri/tauri.android.conf.json").read_text(encoding="utf-8")
    )["bundle"]["android"]["versionCode"]

    original = args.recipe.read_text(encoding="utf-8")
    updated = update_recipe(original, version=version, base_vercode=base_vercode, commit=args.commit)
    args.recipe.write_text(updated, encoding="utf-8")


if __name__ == "__main__":
    main()

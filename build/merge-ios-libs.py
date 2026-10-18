#!/usr/bin/env python3
import sys, os, glob, subprocess, shutil

def main():
    if len(sys.argv) < 3:
        print("Usage: merge-ios-libs.py <apple_project_dir> <configuration>")
        sys.exit(1)

    project_dir = os.path.abspath(sys.argv[1])
    config = sys.argv[2] # e.g. "Release" or "debug"

    # Tauri places rust target outputs in build/tauri/src-tauri/target
    src_tauri_dir = os.path.abspath(os.path.join(project_dir, "..", ".."))
    target_dir = os.path.join(src_tauri_dir, "target", "aarch64-apple-ios", config.lower())

    libapp_path = os.path.join(project_dir, "Externals", "arm64", config, "libapp.a")
    if not os.path.exists(libapp_path):
        print(f"[merge-ios-libs] Warning: {libapp_path} not found")
        sys.exit(0)

    # Search for Swift-RS built static libraries: libTauri.a, libtauri-plugin-opener.a, etc.
    swift_libs = glob.glob(os.path.join(target_dir, "build", "**", "lib*.a"), recursive=True)
    needed_libs_set = set()
    for lib in swift_libs:
        basename = os.path.basename(lib)
        if basename in ("libTauri.a", "libtauri-plugin-opener.a"):
            needed_libs_set.add(os.path.realpath(lib))
    needed_libs = sorted(list(needed_libs_set))

    if not needed_libs:
        print("[merge-ios-libs] No Swift plugin libraries found to merge.")
        sys.exit(0)

    print(f"[merge-ios-libs] Merging {len(needed_libs)} Swift libraries into {libapp_path}...")
    for lib in needed_libs:
        print(f"  + {lib}")

    temp_out = libapp_path + ".merged.a"
    cmd = ["libtool", "-static", "-o", temp_out, libapp_path] + needed_libs
    subprocess.check_call(cmd)
    shutil.move(temp_out, libapp_path)
    print(f"[merge-ios-libs] Successfully merged libraries into {libapp_path}")

if __name__ == "__main__":
    main()

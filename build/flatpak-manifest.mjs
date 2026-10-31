// Fills the values that vary per build into build/tauri/flatpak/manifest.yml: the distribution channel and the CI
// channel/build id embedded in the app. Used by build-tauri.mjs linux. Throws when manifest.yml no longer has a line
// it expects, so the two cannot drift apart silently.

export function fillManifest(template, { channel, ciChannel, buildId }) {
  const replacements = [
    ['MAJESTICTAB_STORE_CHANNEL: direct', `MAJESTICTAB_STORE_CHANNEL: ${channel}`],
    ['MAJESTICTAB_CHANNEL: dev', `MAJESTICTAB_CHANNEL: ${ciChannel || 'dev'}`],
    ['MAJESTICTAB_BUILD_ID: dev', `MAJESTICTAB_BUILD_ID: ${buildId || 'dev'}`],
    ['node build/cargo-toml.mjs direct', `node build/cargo-toml.mjs ${channel}`],
    ['node build/verify-channel.mjs direct', `node build/verify-channel.mjs ${channel}`],
  ];
  let manifest = template;
  for (const [from, to] of replacements) {
    if (manifest.split(from).length !== 2) throw new Error(`manifest.yml must contain "${from}" exactly once.`);
    manifest = manifest.replace(from, () => to);
  }
  return manifest;
}

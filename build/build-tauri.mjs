import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyOrExit } from './verify-channel.mjs';
import { DEFAULT_CHANNEL, cargoFeatures, channels, isValidChannel } from './channels.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const tauriDir = path.join(scriptDir, 'tauri');
const distDir = path.join(rootDir, 'dist');
const target = process.argv[2];
const channelOption = process.argv.slice(3).find((option) => option.startsWith('--channel='));
const buildOptions = process.argv.slice(3).filter((option) => option !== channelOption);
const channel = channelOption ? channelOption.slice('--channel='.length) : DEFAULT_CHANNEL;
const channelCapabilities = isValidChannel(channel) ? channels[channel].capabilities : {};
const debugTools = buildOptions.includes('--debug-tools') || buildOptions.includes('--debug');
const macosX64 = buildOptions.includes('--x86_64');
const macosAppStore = buildOptions.includes('--appstore') || channel === 'appstore-mac';
const validTargets = ['windows', 'macos', 'linux', 'android', 'ios'];
async function loadEnvFiles() {
  const possiblePaths = [
    path.join(rootDir, '.env'),
    path.join(scriptDir, '.env'),
    path.join(tauriDir, '.env'),
  ];
  for (const envPath of possiblePaths) {
    try {
      const content = await readFile(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
        if (match) {
          const key = match[1];
          let val = match[2].trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch {}
  }
}

await loadEnvFiles();

const rustBin = path.join(process.env.HOME ?? '', '.cargo', 'bin');
const env = {
  ...process.env,
  CARGO_TARGET_DIR: path.join(tauriDir, 'target'),
  PATH: [rustBin, process.env.PATH].filter(Boolean).join(path.delimiter),
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!validTargets.includes(target)
  || !isValidChannel(channel)
  || !channels[channel].platforms.includes(target)
  || (buildOptions.includes('--appstore') && channelOption && channel !== 'appstore-mac')
  || buildOptions.some((option) => option !== '--debug-tools' && option !== '--debug' && option !== '--x86_64' && option !== '--appstore')
  || new Set(buildOptions).size !== buildOptions.length
  || (buildOptions.includes('--debug-tools') && buildOptions.includes('--debug'))
  || (debugTools && (target === 'android' || target === 'ios') && buildOptions.includes('--debug-tools'))
  || (macosX64 && target !== 'macos')
  || (macosAppStore && (target !== 'macos' || macosX64))) {
  console.error(`Usage: node build/build-tauri.mjs [${validTargets.join('|')}] [--debug-tools|--debug] [--x86_64 (macos only)] [--appstore (macos only, sandboxed Mac App Store build)] [--channel=<${Object.keys(channels).join('|')}> (default ${DEFAULT_CHANNEL}; must match the target platform)]`);
  process.exit(2);
}

env.MAJESTICTAB_STORE_CHANNEL = channel;
if (target === 'macos') env.MAJESTICTAB_ARCH = macosX64 ? 'x86_64' : 'aarch64';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: tauriDir,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function requireHost(expected, name) {
  if (process.platform !== expected) {
    fail(`The ${name} target must be built on ${name}.`);
  }
}

// makeappx.exe and makepri.exe ship with the Windows SDK, which windows-latest runners include.
async function findWindowsSdkTool(exeName) {
  const binRoot = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = (await readdir(binRoot).catch(() => [])).filter((name) => /^10\./.test(name)).sort();
  for (const version of versions.reverse()) {
    const candidate = path.join(binRoot, version, 'x64', exeName);
    if (await stat(candidate).catch(() => null)) return candidate;
  }
  return fail(`${exeName} not found. Install the Windows 10/11 SDK.`);
}

async function findAndroidArtifact(directory, extension) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findAndroidArtifact(entryPath, extension);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      return entryPath;
    }
  }
  return null;
}

async function findIpa(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findIpa(entryPath);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith('.ipa')) {
      return entryPath;
    }
  }
  return null;
}

async function findAppBundle(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) {
        return entryPath;
      }
      const nested = await findAppBundle(entryPath);
      if (nested) return nested;
    }
  }
  return null;
}

async function packageAppToIpa(appPath, outIpaPath) {
  const tempPayloadDir = path.join(tauriDir, 'target', 'ipa-payload-temp');
  await rm(tempPayloadDir, { recursive: true, force: true });
  const payloadDir = path.join(tempPayloadDir, 'Payload');
  await mkdir(payloadDir, { recursive: true });
  await cp(appPath, path.join(payloadDir, path.basename(appPath)), { recursive: true });
  await rm(outIpaPath, { force: true });
  const zipResult = spawnSync('zip', ['-qr', outIpaPath, 'Payload'], {
    cwd: tempPayloadDir,
    stdio: 'inherit',
  });
  await rm(tempPayloadDir, { recursive: true, force: true });
  if (zipResult.error || zipResult.status !== 0) {
    fail('Failed to package .app bundle into .ipa archive.');
  }
}

async function ensureSwiftPublicCdecl() {
  spawnSync('cargo', ['fetch', '--manifest-path', path.join(tauriDir, 'src-tauri', 'Cargo.toml')], {
    stdio: 'ignore',
  });
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const cargoSrcDir = path.join(homeDir, '.cargo', 'registry', 'src');
  if (!(await stat(cargoSrcDir).catch(() => null))) return;

  async function patchDir(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await patchDir(p);
      } else if (entry.isFile() && (entry.name === 'Tauri.swift' || entry.name === 'OpenerPlugin.swift')) {
        try {
          const content = await readFile(p, 'utf8');
          const patched = content.replace(/@_cdecl\((.*?)\)\nfunc /g, '@_cdecl($1)\npublic func ');
          if (patched !== content) {
            await writeFile(p, patched, 'utf8');
            console.log(`[build-tauri] Patched Swift cdecl visibility in: ${p}`);
          }
        } catch {}
      }
    }
  }
  await patchDir(cargoSrcDir);
}

async function copyBundleArtifacts(bundleDir, extension) {
  const files = [];
  async function collect(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await collect(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(extension) && !entry.name.startsWith('rw.') && !entry.name.startsWith('.')) {
        files.push(entryPath);
      }
    }
  }
  await collect(bundleDir);
  if (files.length === 0) fail(`No ${extension} distributable was created.`);
  for (const file of files) {
    await cp(file, path.join(distDir, path.basename(file)));
  }
}

if (target === 'windows') requireHost('win32', 'Windows');
if (target === 'macos' || target === 'ios') requireHost('darwin', target === 'ios' ? 'iOS' : 'macOS');
if (target === 'linux') requireHost('linux', 'Linux');

await mkdir(distDir, { recursive: true });
const packageManifest = JSON.parse(await readFile(path.join(tauriDir, 'package.json'), 'utf8'));
const requiredPackages = { ...packageManifest.dependencies, ...packageManifest.devDependencies };
const installedVersions = await Promise.all(Object.entries(requiredPackages).map(async ([name, version]) => {
  const packagePath = path.join(tauriDir, 'node_modules', name, 'package.json');
  try {
    const installedPackage = JSON.parse(await readFile(packagePath, 'utf8'));
    return installedPackage.version === version;
  } catch {
    return false;
  }
}));
if (installedVersions.some((installed) => !installed)) {
  run('npm', ['ci']);
}
// Tauri rejects a capability naming a plugin that isn't compiled in, so the in-app purchase permissions
// are written only for channels with monetization 'iap', and removed again when the build exits.
async function ensureIapCapability() {
  const capabilityPath = path.join(tauriDir, 'src-tauri', 'capabilities', 'iap.json');
  if (channelCapabilities.monetization !== 'iap') {
    await rm(capabilityPath, { force: true });
    return;
  }
  await writeFile(capabilityPath, `${JSON.stringify({
    $schema: '../gen/schemas/desktop-schema.json',
    identifier: 'iap',
    description: 'In-app purchase of MajesticTab Supporter',
    windows: ['main'],
    permissions: ['iap:allow-get-products', 'iap:allow-purchase', 'iap:allow-restore-purchases', 'iap:allow-get-product-status', 'iap:allow-acknowledge-purchase'],
  }, null, 2)}\n`);
  process.on('exit', () => rmSync(capabilityPath, { force: true }));
}

async function ensureCrateTypeForTarget(currentTarget) {
  const cargoTomlPath = path.join(tauriDir, 'src-tauri', 'Cargo.toml');
  let content = await readFile(cargoTomlPath, 'utf8');
  const originalContent = content;
  const targetTypes = currentTarget === 'android'
    ? 'crate-type = ["staticlib", "cdylib", "rlib"]'
    : 'crate-type = ["staticlib", "rlib"]';
  const pattern = /crate-type\s*=\s*\[.*?\]/;
  if (pattern.test(content)) {
    content = content.replace(pattern, targetTypes);
  }
  // Channel capabilities (self-update, userscripts) become the crate's default features.
  const defaultFeatures = `default = [${cargoFeatures(channel).map((feature) => `"${feature}"`).join(', ')}]`;
  content = content.replace(/^default\s*=\s*\[.*?\]$/m, defaultFeatures);
  if (content !== originalContent) {
    await writeFile(cargoTomlPath, content);
    // Restore the committed Cargo.toml so builds don't leave the tree dirty.
    process.on('exit', () => writeFileSync(cargoTomlPath, originalContent));
  }
}

run('npm', [
  'run',
  'prepare:frontend',
  ...(target === 'android' ? ['--', '--android'] : []),
  ...(target === 'ios' ? ['--', '--ios'] : []),
]);
run('node', ['generate-icons.mjs', target]);
await ensureCrateTypeForTarget(target);
await ensureIapCapability();
await verifyOrExit(channel, { cargoToml: path.join(tauriDir, 'src-tauri', 'Cargo.toml'), debugTools });

if (target === 'android') {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome || !(await stat(javaHome).catch(() => null))) {
    fail('Android builds require JAVA_HOME pointing to JDK 17-26. JDK 17 is recommended.');
  }
  const javaExecutable = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const javaResult = spawnSync(javaExecutable, ['-version'], { encoding: 'utf8' });
  const javaOutput = `${javaResult.stdout ?? ''}\n${javaResult.stderr ?? ''}`;
  const javaVersion = /(?:openjdk|java)(?: version)?\s+"?(\d+)/i.exec(javaOutput);
  const javaMajor = javaVersion ? Number(javaVersion[1]) : null;
  if (javaResult.error || javaResult.status !== 0 || javaMajor === null) {
    fail(`Could not determine the JDK version at JAVA_HOME: ${javaHome}`);
  }
  if (javaMajor < 17 || javaMajor > 26) {
    fail(`Android builds require JDK 17-26 for this Gradle/Android Gradle Plugin setup; found JDK ${javaMajor} at ${javaHome}. Install/select JDK 17 and set JAVA_HOME to it.`);
  }

  const androidSdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  let androidNdk = process.env.NDK_HOME ?? process.env.ANDROID_NDK_HOME;
  if (!androidSdk || !(await stat(androidSdk).catch(() => null))) {
    fail('Android builds require ANDROID_HOME or ANDROID_SDK_ROOT pointing to the Android SDK.');
  }
  if (!androidNdk || !(await stat(androidNdk).catch(() => null))) {
    const ndkRoot = path.join(androidSdk, 'ndk');
    try {
      const versions = (await readdir(ndkRoot)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (versions.length > 0) {
        androidNdk = path.join(ndkRoot, versions[versions.length - 1]);
      }
    } catch {}
  }
  if (!androidNdk || !(await stat(androidNdk).catch(() => null))) {
    fail('Install the Android NDK (Side by side) and set NDK_HOME to its installed directory.');
  }
  env.ANDROID_HOME = androidSdk;
  env.ANDROID_SDK_ROOT = androidSdk;
  env.NDK_HOME = androidNdk;
  env.JAVA_HOME = javaHome;
  env.PATH = [
    path.join(androidSdk, 'cmdline-tools', 'latest', 'bin'),
    path.join(androidSdk, 'platform-tools'),
    path.join(javaHome, 'bin'),
    env.PATH,
  ].join(path.delimiter);
  env.WRY_RUSTWEBVIEW_CLASS_EXTENSION = await readFile(
    path.join(tauriDir, 'android-youtube-referer.kotlin'),
    'utf8',
  );
  const sdkmanager = path.join(androidSdk, 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
  if (!(await stat(sdkmanager).catch(() => null))) {
    fail('Install Android SDK Command-line Tools in Android Studio (SDK Manager).');
  }
  const androidProject = path.join(tauriDir, 'src-tauri', 'gen', 'android');
  const androidPackageDir = path.join(androidProject, 'app', 'src', 'main', 'java', 'net', 'zathu', 'majestictab');
  // A project generated under the old identifier must be regenerated.
  if (!(await stat(androidPackageDir).catch(() => null))) {
    await rm(androidProject, { recursive: true, force: true });
    run('npm', ['run', 'tauri', '--', 'android', 'init', '--ci']);
  }
  // `android init` only copies icons once, so refresh them on every build.
  const androidRes = path.join(androidProject, 'app', 'src', 'main', 'res');
  for (const entry of await readdir(androidRes)) {
    if (entry.startsWith('mipmap-')) await rm(path.join(androidRes, entry), { recursive: true, force: true });
  }
  await rm(path.join(androidRes, 'drawable-v24', 'ic_launcher_foreground.xml'), { force: true });
  await rm(path.join(androidRes, 'drawable', 'ic_launcher_background.xml'), { force: true });
  await cp(path.join(tauriDir, 'src-tauri', 'icons', 'android'), androidRes, { recursive: true });
  let mainActivity = await readFile(path.join(tauriDir, 'android-MainActivity.kt'), 'utf8');
  if (!channelCapabilities.selfUpdate) {
    mainActivity = mainActivity.replace(/[ \t]*\/\/ @selfUpdate:begin[\s\S]*?\/\/ @selfUpdate:end\n?/, '');
  }
  await writeFile(path.join(androidPackageDir, 'MainActivity.kt'), mainActivity);
  // Jam mode: LAN sockets plus mDNS discovery (multicast) for finding hosts; tuner: microphone.
  const manifestPath = path.join(androidProject, 'app', 'src', 'main', 'AndroidManifest.xml');
  let manifest = await readFile(manifestPath, 'utf8');
  for (const permission of ['ACCESS_NETWORK_STATE', 'ACCESS_WIFI_STATE', 'CHANGE_WIFI_MULTICAST_STATE', 'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS']) {
    const tag = `<uses-permission android:name="android.permission.${permission}" />`;
    if (!manifest.includes(tag)) {
      manifest = manifest.replace('<uses-permission android:name="android.permission.INTERNET" />', `<uses-permission android:name="android.permission.INTERNET" />\n    ${tag}`);
    }
  }
  // In-app updates install the downloaded APK, which needs the install permission and a FileProvider for the cache folder.
  // Channels without selfUpdate (play, fdroid) get neither, and any left over from an earlier build is removed.
  const installTag = '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />';
  if (!channelCapabilities.selfUpdate) {
    manifest = manifest.replace(new RegExp(`[ \\t]*${installTag}\\n?`), '');
    manifest = manifest.replace(/[ \t]*<provider\s+android:name="androidx\.core\.content\.FileProvider"[^>]*updateprovider[\s\S]*?<\/provider>\s*/, '');
  } else if (!manifest.includes(installTag)) {
    manifest = manifest.replace('<uses-permission android:name="android.permission.INTERNET" />', `<uses-permission android:name="android.permission.INTERNET" />\n    ${installTag}`);
  }
  if (channelCapabilities.selfUpdate && !manifest.includes('.updateprovider')) {
    const provider = `<provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.updateprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/majestictab_update_paths" />
        </provider>
    `;
    manifest = manifest.replace('</application>', `${provider}</application>`);
  }
  await writeFile(manifestPath, manifest);
  await verifyOrExit(channel, { androidProject });
  if (channelCapabilities.selfUpdate) {
    await mkdir(path.join(androidRes, 'xml'), { recursive: true });
    await writeFile(
      path.join(androidRes, 'xml', 'majestictab_update_paths.xml'),
      '<?xml version="1.0" encoding="utf-8"?>\n<paths>\n    <cache-path name="updates" path="updates/" />\n</paths>\n',
    );
  } else {
    await rm(path.join(androidRes, 'xml', 'majestictab_update_paths.xml'), { force: true });
  }
  const keystore = process.env.ANDROID_KEYSTORE_FILE;
  const keystorePassword = process.env.ANDROID_KEYSTORE_PASSWORD;
  const keyAlias = process.env.ANDROID_KEY_ALIAS;
  const keyPassword = process.env.ANDROID_KEY_PASSWORD ?? keystorePassword;
  const signRelease = Boolean(keystore);
  if (signRelease && (!keystorePassword || !keyAlias)) {
    fail('ANDROID_KEYSTORE_FILE requires ANDROID_KEYSTORE_PASSWORD and ANDROID_KEY_ALIAS.');
  }
  // Google Play only accepts an AAB, so the play channel also bundles one beside the APK.
  const buildAab = channel === 'play';
  if (buildAab && !signRelease) {
    fail('The play channel requires ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD and ANDROID_KEY_ALIAS to sign the AAB.');
  }
  const outputsDir = path.join(androidProject, 'app', 'build', 'outputs');
  await rm(path.join(outputsDir, 'apk'), { recursive: true, force: true });
  await rm(path.join(outputsDir, 'bundle'), { recursive: true, force: true });
  run('npm', ['run', 'tauri', '--', 'android', 'build', '--apk', ...(buildAab ? ['--aab'] : []), ...(signRelease ? [] : ['--debug']), '--target', 'aarch64']);
  const apk = await findAndroidArtifact(path.join(outputsDir, 'apk'), '.apk');
  if (!apk) fail('Tauri completed without producing an Android APK.');
  if (signRelease) {
    const buildToolsRoot = path.join(androidSdk, 'build-tools');
    const versions = (await readdir(buildToolsRoot)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const buildTools = path.join(buildToolsRoot, versions[versions.length - 1]);
    const ext = process.platform === 'win32' ? '.bat' : '';
    const aligned = path.join(distDir, 'MajesticTab-android-aligned.apk');
    const signed = path.join(distDir, 'MajesticTab-android.apk');
    run(path.join(buildTools, 'zipalign' + (process.platform === 'win32' ? '.exe' : '')), ['-f', '-p', '4', apk, aligned]);
    run(path.join(buildTools, 'apksigner' + ext), [
      'sign', '--ks', keystore, '--ks-key-alias', keyAlias,
      '--ks-pass', 'env:ANDROID_KEYSTORE_PASSWORD', '--key-pass', 'env:ANDROID_KEY_PASSWORD',
      '--out', signed, aligned,
    ], { env: { ...env, ANDROID_KEYSTORE_PASSWORD: keystorePassword, ANDROID_KEY_PASSWORD: keyPassword } });
    await rm(aligned, { force: true });
    await rm(signed + '.idsig', { force: true });
    if (buildAab) {
      const aab = await findAndroidArtifact(path.join(outputsDir, 'bundle'), '.aab');
      if (!aab) fail('Tauri completed without producing an Android App Bundle.');
      const signedAab = path.join(distDir, 'MajesticTab-android.aab');
      await cp(aab, signedAab);
      // Play wants a jarsigner signature (the upload key); apksigner only handles APKs.
      run(path.join(javaHome, 'bin', 'jarsigner' + (process.platform === 'win32' ? '.exe' : '')), [
        '-keystore', keystore, '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD', '-keypass:env', 'ANDROID_KEY_PASSWORD',
        '-sigalg', 'SHA256withRSA', '-digestalg', 'SHA-256', signedAab, keyAlias,
      ], { env: { ...env, ANDROID_KEYSTORE_PASSWORD: keystorePassword, ANDROID_KEY_PASSWORD: keyPassword } });
    }
  } else {
    await cp(apk, path.join(distDir, 'MajesticTab-android-debug.apk'));
  }
} else if (target === 'ios') {
  await ensureSwiftPublicCdecl();
  const iosProject = path.join(tauriDir, 'src-tauri', 'gen', 'apple');
  const iosSources = path.join(iosProject, 'Sources');
  if (!(await stat(iosSources).catch(() => null))) {
    run('npm', ['run', 'tauri', '--', 'ios', 'init', '--ci']);
  }
  // Sync version-controlled iOS configuration and manifest templates
  const templateProjectYml = path.join(tauriDir, 'ios-project.yml');
  if (await stat(templateProjectYml).catch(() => null)) {
    await cp(templateProjectYml, path.join(iosProject, 'project.yml'));
  }
  const templateInfoPlist = path.join(tauriDir, 'ios-Info.plist');
  if (await stat(templateInfoPlist).catch(() => null)) {
    await cp(templateInfoPlist, path.join(iosProject, 'majestictab_iOS', 'Info.plist'));
  }
  const templatePrivacyManifest = path.join(tauriDir, 'ios-PrivacyInfo.xcprivacy');
  if (await stat(templatePrivacyManifest).catch(() => null)) {
    await cp(templatePrivacyManifest, path.join(iosProject, 'majestictab_iOS', 'PrivacyInfo.xcprivacy'));
  }
  run('xcodegen', ['generate'], { cwd: iosProject });
  // Refresh iOS AppIcon assets from src-tauri/icons/ios
  const iosAppIcon = path.join(iosProject, 'Assets.xcassets', 'AppIcon.appiconset');
  if (await stat(iosAppIcon).catch(() => null)) {
    const iconSourceDir = path.join(tauriDir, 'src-tauri', 'icons', 'ios');
    for (const file of await readdir(iconSourceDir)) {
      if (file.endsWith('.png')) {
        await cp(path.join(iconSourceDir, file), path.join(iosAppIcon, file));
      }
    }
  }
  const buildArgs = ['run', 'tauri', '--', 'ios', 'build', '--target', 'aarch64', '--ci'];
  if (debugTools) {
    buildArgs.push('--debug');
  }
  if (process.env.IOS_SIGNING_IDENTITY) {
    buildArgs.push('--export-method', process.env.IOS_EXPORT_METHOD || 'debugging');
  } else {
    buildArgs.push('--no-sign');
  }
  run('npm', buildArgs);

  const ipa = (await findIpa(path.join(tauriDir, 'src-tauri', 'gen', 'apple')))
    || (await findIpa(path.join(tauriDir, 'target')));
  if (ipa) {
    await cp(ipa, path.join(distDir, 'MajesticTab-ios.ipa'));
  } else {
    const appBundle = (await findAppBundle(path.join(tauriDir, 'src-tauri', 'gen', 'apple')))
      || (await findAppBundle(path.join(tauriDir, 'target')));
    if (appBundle) {
      await packageAppToIpa(appBundle, path.join(distDir, 'MajesticTab-ios.ipa'));
    } else {
      fail('Tauri completed without producing an iOS IPA or .app bundle.');
    }
  }
} else if (target === 'linux') {
  for (const command of ['flatpak-builder', 'flatpak']) {
    const result = spawnSync(command, ['--version'], { env, stdio: 'ignore' });
    if (result.error) fail(`The Linux target requires ${command}.`);
  }
  run('npm', ['run', 'tauri', '--', 'build', '--no-bundle']);
  const repoDir = path.join(tauriDir, 'target', 'flatpak-repo');
  const buildDir = path.join(tauriDir, 'target', 'flatpak-build');
  const flatpakCacheDir = path.join(rootDir, '.flatpak-builder');
  // Clear any cached Flatpak build/repo directories to avoid stale artifacts
  await rm(repoDir, { recursive: true, force: true });
  await rm(buildDir, { recursive: true, force: true });
  await rm(flatpakCacheDir, { recursive: true, force: true });
  run('flatpak-builder', [
    '--force-clean',
    '--disable-cache',
    `--repo=${repoDir}`,
    buildDir,
    path.join(tauriDir, 'flatpak', 'manifest.yml'),
  ], { cwd: rootDir });
  run('flatpak', [
    'build-bundle',
    repoDir,
    path.join(distDir, 'MajesticTab.flatpak'),
    'net.zathu.majestictab',
  ], { cwd: rootDir });
} else if (target === 'windows' && channel === 'msstore') {
  // The Store signs MSIX packages itself, so this one is left unsigned. The identity values come from
  // Partner Center (Product identity) and must match it exactly.
  const identity = {
    IDENTITY_NAME: process.env.MSSTORE_IDENTITY_NAME,
    PUBLISHER: process.env.MSSTORE_PUBLISHER,
    PUBLISHER_DISPLAY_NAME: process.env.MSSTORE_PUBLISHER_DISPLAY_NAME,
  };
  const missing = Object.entries(identity).filter(([, value]) => !value).map(([key]) => `MSSTORE_${key}`);
  if (missing.length > 0) fail(`The msstore channel needs ${missing.join(', ')} (Partner Center, Product identity).`);
  const makeappx = await findWindowsSdkTool('makeappx.exe');
  const makepri = await findWindowsSdkTool('makepri.exe');
  const version = JSON.parse(await readFile(path.join(tauriDir, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Cannot make an MSIX version from "${version}".`);
  run('npm', ['run', 'tauri', '--', 'build', '--no-bundle']);

  const layout = path.join(tauriDir, 'target', 'msix-layout');
  await rm(layout, { recursive: true, force: true });
  await mkdir(path.join(layout, 'Assets'), { recursive: true });
  await cp(path.join(tauriDir, 'target', 'release', 'majestictab.exe'), path.join(layout, 'majestictab.exe'));
  const iconDir = path.join(tauriDir, 'src-tauri', 'icons', 'windows');
  for (const [size, name] of [[44, 'Square44x44Logo'], [50, 'StoreLogo'], [150, 'Square150x150Logo']]) {
    await cp(path.join(iconDir, `${size}x${size}.png`), path.join(layout, 'Assets', `${name}.png`));
  }
  // Target-size and unplated variants (dark + light taskbar) keep Windows from drawing the accent-color plate.
  for (const size of [16, 24, 32, 48, 256]) {
    for (const suffix of ['', '_altform-unplated', '_altform-lightunplated']) {
      await cp(path.join(iconDir, `${size}x${size}.png`), path.join(layout, 'Assets', `Square44x44Logo.targetsize-${size}${suffix}.png`));
    }
  }
  // The Store requires a four-part version whose last part is 0.
  const tokens = { ...identity, VERSION: `${version}.0` };
  const manifest = (await readFile(path.join(tauriDir, 'msix', 'AppxManifest.xml'), 'utf8'))
    .replace(/\{\{(\w+)\}\}/g, (_, key) => String(tokens[key]).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'));
  const manifestPath = path.join(layout, 'AppxManifest.xml');
  await writeFile(manifestPath, manifest);
  // Windows only resolves targetsize / altform-unplated asset qualifiers when indexed in resources.pri.
  const priConfig = path.join(tauriDir, 'target', 'msix-priconfig.xml');
  run(makepri, ['createconfig', '/cf', priConfig, '/dq', 'en-US', '/pv', '10.0.0', '/o'], { shell: false });
  run(makepri, ['new', '/pr', layout, '/cf', priConfig, '/mn', manifestPath, '/of', path.join(layout, 'resources.pri'), '/o'], { shell: false });
  const msix = path.join(distDir, 'MajesticTab-msstore.msix');
  await rm(msix, { force: true });
  run(makeappx, ['pack', '/o', '/d', layout, '/p', msix], { shell: false });
} else {
  // Signed update bundles (.sig plus .app.tar.gz on macOS) are only produced when the updater
  // signing key is available, so local builds without it still work.
  // The public key comes from TAURI_UPDATER_PUBKEY and is merged over the placeholder in tauri.conf.json.
  const updaterPubkey = macosAppStore || !channelCapabilities.selfUpdate ? '' : (process.env.TAURI_UPDATER_PUBKEY ?? '').trim();
  const signUpdates = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH)
    && updaterPubkey !== '';
  if (!macosAppStore && channelCapabilities.selfUpdate && (process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) && !updaterPubkey) {
    console.warn('[build-tauri] Skipping update bundles: TAURI_UPDATER_PUBKEY is not set.');
  }
  const bundles = macosAppStore ? ['app'] : target === 'macos' ? ['dmg', 'app'] : ['nsis'];
  const buildEnv = target === 'macos' ? { ...env, CI: 'true' } : env;
  const buildArgs = ['run', 'tauri', '--', 'build', '--bundles', ...bundles];
  if (updaterPubkey) {
    const updaterConfig = path.join(tauriDir, 'target', 'updater-config.json');
    await mkdir(path.dirname(updaterConfig), { recursive: true });
    await writeFile(updaterConfig, JSON.stringify({
      plugins: { updater: { pubkey: updaterPubkey } },
      ...(signUpdates ? { bundle: { createUpdaterArtifacts: true } } : {}),
    }));
    buildArgs.push('--config', updaterConfig);
  }
  if (macosAppStore) {
    // Sandbox entitlements. The identity comes from APPLE_SIGNING_IDENTITY (an Apple Distribution certificate).
    buildArgs.push('--config', path.join(tauriDir, 'src-tauri', 'tauri.macos.appstore.conf.json'));
  }
  if (debugTools) buildArgs.push('--features', 'debug-tools');
  if (macosX64) buildArgs.push('--target', 'x86_64-apple-darwin');
  run('npm', buildArgs, { env: buildEnv });
  const bundleRoot = macosX64
    ? path.join(tauriDir, 'target', 'x86_64-apple-darwin', 'release', 'bundle')
    : path.join(tauriDir, 'target', 'release', 'bundle');
  if (macosAppStore) {
    await rm(path.join(distDir, 'MajesticTab-appstore.app'), { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });
    await cp(path.join(bundleRoot, 'macos', 'MajesticTab.app'), path.join(distDir, 'MajesticTab-appstore.app'), { recursive: true });
  } else {
    await copyBundleArtifacts(path.join(bundleRoot, target === 'macos' ? 'dmg' : 'nsis'), target === 'macos' ? '.dmg' : '.exe');
  }
  if (signUpdates) {
    if (target === 'macos') {
      // Both architectures produce MajesticTab.app.tar.gz, so the arch goes into the name.
      const arch = macosX64 ? 'x86_64' : 'aarch64';
      for (const suffix of ['.app.tar.gz', '.app.tar.gz.sig']) {
        const source = path.join(bundleRoot, 'macos', `MajesticTab${suffix}`);
        if (!(await stat(source).catch(() => null))) fail(`Missing update artifact: ${source}`);
        await cp(source, path.join(distDir, `MajesticTab_${arch}${suffix}`));
      }
    } else {
      await copyBundleArtifacts(path.join(bundleRoot, 'nsis'), '.exe.sig');
    }
  }
}

console.log(`Build output: ${distDir}`);
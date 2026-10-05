import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const tauriDir = path.join(scriptDir, 'tauri');
const distDir = path.join(rootDir, 'dist');
const target = process.argv[2];
const buildOptions = process.argv.slice(3);
const debugTools = buildOptions.includes('--debug-tools');
const macosX64 = buildOptions.includes('--x86_64');
const validTargets = ['windows', 'macos', 'linux', 'android'];
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
  || buildOptions.some((option) => option !== '--debug-tools' && option !== '--x86_64')
  || new Set(buildOptions).size !== buildOptions.length
  || (debugTools && target === 'android')
  || (macosX64 && target !== 'macos')) {
  console.error(`Usage: node build/build-tauri.mjs [${validTargets.join('|')}] [--debug-tools] [--x86_64 (macos only)]`);
  process.exit(2);
}

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

async function findApk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findApk(entryPath);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith('.apk')) {
      return entryPath;
    }
  }
  return null;
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
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
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
if (target === 'macos') requireHost('darwin', 'macOS');
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
run('npm', [
  'run',
  'prepare:frontend',
  ...(target === 'android' ? ['--', '--android'] : []),
]);
run('node', ['generate-icons.mjs', target]);

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
  const androidNdk = process.env.NDK_HOME ?? process.env.ANDROID_NDK_HOME;
  if (!androidSdk || !(await stat(androidSdk).catch(() => null))) {
    fail('Android builds require ANDROID_HOME or ANDROID_SDK_ROOT pointing to the Android SDK.');
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
  await writeFile(
    path.join(androidPackageDir, 'MainActivity.kt'),
    await readFile(path.join(tauriDir, 'android-MainActivity.kt'), 'utf8'),
  );
  const keystore = process.env.ANDROID_KEYSTORE_FILE;
  const keystorePassword = process.env.ANDROID_KEYSTORE_PASSWORD;
  const keyAlias = process.env.ANDROID_KEY_ALIAS;
  const keyPassword = process.env.ANDROID_KEY_PASSWORD ?? keystorePassword;
  const signRelease = Boolean(keystore);
  if (signRelease && (!keystorePassword || !keyAlias)) {
    fail('ANDROID_KEYSTORE_FILE requires ANDROID_KEYSTORE_PASSWORD and ANDROID_KEY_ALIAS.');
  }
  await rm(path.join(androidProject, 'app', 'build', 'outputs', 'apk'), { recursive: true, force: true });
  run('npm', ['run', 'tauri', '--', 'android', 'build', '--apk', ...(signRelease ? [] : ['--debug']), '--target', 'aarch64']);
  const apk = await findApk(path.join(androidProject, 'app', 'build', 'outputs', 'apk'));
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
  } else {
    await cp(apk, path.join(distDir, 'MajesticTab-android-debug.apk'));
  }
} else if (target === 'linux') {
  for (const command of ['flatpak-builder', 'flatpak']) {
    const result = spawnSync(command, ['--version'], { env, stdio: 'ignore' });
    if (result.error) fail(`The Linux target requires ${command}.`);
  }
  run('npm', ['run', 'tauri', '--', 'build', '--no-bundle']);
  const repoDir = path.join(tauriDir, 'target', 'flatpak-repo');
  const buildDir = path.join(tauriDir, 'target', 'flatpak-build');
  // A cached target/ can restore an empty repo dir that flatpak-builder cannot open.
  await rm(repoDir, { recursive: true, force: true });
  run('flatpak-builder', [
    '--force-clean',
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
} else {
  const bundle = target === 'macos' ? 'dmg' : 'nsis';
  const extension = target === 'macos' ? '.dmg' : '.exe';
  const buildEnv = target === 'macos' ? { ...env, CI: 'true' } : env;
  const buildArgs = ['run', 'tauri', '--', 'build', '--bundles', bundle];
  if (debugTools) buildArgs.push('--features', 'debug-tools');
  if (macosX64) buildArgs.push('--target', 'x86_64-apple-darwin');
  run('npm', buildArgs, { env: buildEnv });
  const bundleDir = macosX64
    ? path.join(tauriDir, 'target', 'x86_64-apple-darwin', 'release', 'bundle')
    : path.join(tauriDir, 'target', 'release', 'bundle');
  await copyBundleArtifacts(bundleDir, extension);
}

console.log(`Build output: ${distDir}`);
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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
  || buildOptions.some((option) => option !== '--debug-tools')
  || buildOptions.filter((option) => option === '--debug-tools').length > 1
  || (debugTools && target === 'android')) {
  console.error(`Usage: node build/build-tauri.mjs [${validTargets.join('|')}] [--debug-tools]`);
  process.exit(2);
}

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
if (!(await stat(path.join(tauriDir, 'node_modules')).catch(() => null))) {
  run('npm', ['ci']);
}
run('npm', ['run', 'prepare:frontend']);
run('npm', [
  'run',
  'tauri',
  '--',
  'icon',
  path.join(rootDir, 'icons', 'android-chrome-512x512.png'),
  '--output',
  path.join(tauriDir, 'src-tauri', 'icons'),
]);

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
  if (!(await stat(androidProject).catch(() => null))) {
    run('npm', ['run', 'tauri', '--', 'android', 'init', '--ci']);
  }
  await writeFile(
    path.join(androidProject, 'app', 'src', 'main', 'java', 'io', 'github', 'cgarst', 'MajesticTab', 'MainActivity.kt'),
    await readFile(path.join(tauriDir, 'android-MainActivity.kt'), 'utf8'),
  );
  run('npm', ['run', 'tauri', '--', 'android', 'build', '--apk', '--debug', '--target', 'aarch64']);
  const apk = await findApk(path.join(androidProject, 'app', 'build', 'outputs', 'apk'));
  if (!apk) fail('Tauri completed without producing an Android APK.');
  await cp(apk, path.join(distDir, 'MajesticTab-android-debug.apk'));
} else if (target === 'linux') {
  for (const command of ['flatpak-builder', 'flatpak']) {
    const result = spawnSync(command, ['--version'], { env, stdio: 'ignore' });
    if (result.error) fail(`The Linux target requires ${command}.`);
  }
  run('npm', ['run', 'tauri', '--', 'build', '--no-bundle']);
  const repoDir = path.join(tauriDir, 'target', 'flatpak-repo');
  const buildDir = path.join(tauriDir, 'target', 'flatpak-build');
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
    'io.github.cgarst.MajesticTab',
  ], { cwd: rootDir });
} else {
  const bundle = target === 'macos' ? 'dmg' : 'nsis';
  const extension = target === 'macos' ? '.dmg' : '.exe';
  const buildEnv = target === 'macos' ? { ...env, CI: 'true' } : env;
  const buildArgs = ['run', 'tauri', '--', 'build', '--bundles', bundle];
  if (debugTools) buildArgs.push('--features', 'debug-tools');
  run('npm', buildArgs, { env: buildEnv });
  await copyBundleArtifacts(path.join(tauriDir, 'target', 'release', 'bundle'), extension);
}

console.log(`Build output: ${distDir}`);
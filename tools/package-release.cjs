const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { copyFile, mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { dirname, join, relative, resolve } = require('node:path');

const core = resolve(__dirname, '../core');
const requireCore = createRequire(join(core, 'package.json'));
const pkgManifest = requireCore.resolve('pkg/package.json');
const pkgMain = resolve(dirname(pkgManifest), require(pkgManifest).bin.pkg);
const targets = {
  'node18-win-x64': 'QQ农场助手.exe',
  'node18-linux-x64': 'qq-farm-bot-linux-x64',
  'node18-macos-x64': 'qq-farm-bot-macos-x64',
  'node18-macos-arm64': 'qq-farm-bot-macos-arm64',
};

async function packageWindows(target, output) {
  const requirePkg = createRequire(pkgManifest);
  const { need } = requirePkg('pkg-fetch');
  const { cachePath } = requirePkg('pkg-fetch/lib-es5/places');
  const runtime = await need({ nodeRange: 'node18', platform: 'win', arch: 'x64' });
  const temp = await mkdtemp(join(tmpdir(), 'qq-farm-pkg-'));

  try {
    // Edit the runtime before pkg appends the application and records its offsets.
    const bundledRuntime = join(temp, relative(cachePath, runtime).replace(/fetched-([^/\\]+)$/, 'built-$1'));
    await mkdir(dirname(bundledRuntime), { recursive: true });
    await copyFile(runtime, bundledRuntime);

    const response = await fetch('https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe');
    if (!response.ok) throw new Error('无法下载图标工具，HTTP ' + response.status);
    const editor = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(editor).digest('hex');
    if (hash !== '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a') {
      throw new Error('图标工具的 SHA-256 校验失败');
    }
    const editorPath = join(temp, 'rcedit.exe');
    const iconPath = resolve(__dirname, '../web/public/icon.ico');
    await writeFile(editorPath, editor);
    const options = [bundledRuntime, '--set-icon', iconPath, '--set-version-string', 'ProductName', 'QQ农场助手',
      '--set-version-string', 'FileDescription', 'QQ农场助手', '--set-version-string', 'OriginalFilename', targets[target]];
    if (process.platform === 'win32') {
      execFileSync(editorPath, options, { stdio: 'inherit' });
    } else {
      execFileSync('wine', [editorPath, ...options], { stdio: 'inherit' });
    }
    packageTarget(target, output, { ...process.env, PKG_CACHE_PATH: temp });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function packageTarget(target, output, env = process.env) {
  execFileSync(process.execPath, [pkgMain, '.', '--no-bytecode', '--targets', target, '--output', output], {
    cwd: core,
    env,
    stdio: 'inherit',
  });
}

async function main() {
  const requested = process.argv.slice(2);
  for (const target of requested.length ? requested : Object.keys(targets)) {
    if (!Object.hasOwn(targets, target)) throw new Error('不支持的打包目标 ' + target);
    const output = join(core, 'dist', 'bin', targets[target]);
    if (target === 'node18-win-x64') await packageWindows(target, output);
    else packageTarget(target, output);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

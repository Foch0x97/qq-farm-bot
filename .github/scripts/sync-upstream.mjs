import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORK_INTRO = '本 Fork 保留上游功能，并增加**微信扫码授权保存、掉线自动换 Code、恢复挂机**。';
export const FORK_IMAGE = '![应用宝登录与自动重连](docs/images/yyb-login.jpg)';
const UPSTREAM_URL = 'https://github.com/liyangpengs/qq-farm-bot.git';
const UPSTREAM_REF = 'refs/remotes/upstream-sync/master';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Only the known introduction conflict is automatic. All other conflicts stop.
export function resolveReadme(text) {
  let resolved = 0;
  const result = text.replace(/^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*(?:\n|$)/gm, (block, ours, theirs) => {
    const expected = `${FORK_INTRO}\n\n${FORK_IMAGE}`;
    if (ours.trim() !== expected || !/^基于 Node\.js 的/.test(theirs.trim()) || theirs.trim().includes('\n')) return block;
    resolved++;
    return `${expected}\n`;
  });
  if (!resolved || /^(<<<<<<< |=======|>>>>>>> )/m.test(result)) throw new Error('README contains a conflict outside the managed Fork introduction');
  return result;
}

export function mergeUpstream({ upstreamUrl = UPSTREAM_URL, upstreamBranch = 'master' } = {}) {
  if (git('status', '--porcelain')) throw new Error('Working tree must be clean before synchronization');
  const base = git('rev-parse', 'HEAD');
  git('fetch', '--no-tags', upstreamUrl, `${upstreamBranch}:${UPSTREAM_REF}`);
  const upstream = git('rev-parse', UPSTREAM_REF);
  if (git('rev-list', '--count', `HEAD..${upstream}`) === '0') return { changed: false, base, head: base, upstream };
  try {
    try { git('merge', '--no-ff', '--no-commit', UPSTREAM_REF); }
    catch (error) {
      const conflicts = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
      if (conflicts.length !== 1 || conflicts[0] !== 'README.md') throw error;
      fs.writeFileSync('README.md', resolveReadme(fs.readFileSync('README.md', 'utf8').replaceAll('\r\n', '\n')));
      git('add', 'README.md');
    }
    git('diff', '--cached', '--check');
    git('commit', '-m', `Merge upstream master (${upstream.slice(0, 12)})`);
    return { changed: true, base, head: git('rev-parse', 'HEAD'), upstream };
  } catch (error) {
    try { git('merge', '--abort'); } catch {}
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = mergeUpstream();
    fs.writeFileSync('sync-result.json', JSON.stringify(result));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\nbase=${result.base}\nhead=${result.head}\nupstream=${result.upstream}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.changed
      ? `已合并上游 ${result.upstream}，等待测试通过后更新 master。\n`
      : `当前 master 已包含上游 ${result.upstream}，无需更新。\n`);
    console.log(JSON.stringify(result));
  } catch (error) {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '自动同步停止：合并冲突或检查失败，主分支未更新。请查看失败步骤。\n');
    console.error(error.message);
    process.exitCode = 1;
  }
}

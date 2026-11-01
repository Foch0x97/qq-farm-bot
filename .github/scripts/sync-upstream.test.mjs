import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FORK_INTRO, FORK_IMAGE, resolveReadme, mergeUpstream } from './sync-upstream.mjs';

test('only resolves the exact Fork introduction and preserves other merged documentation', () => {
  const text = `# Title\n\n<<<<<<< HEAD\n${FORK_INTRO}\n\n${FORK_IMAGE}\n=======\n基于 Node.js 的新版上游介绍。\n>>>>>>> upstream\n\n## New upstream documentation\n`;
  const result = resolveReadme(text);
  assert.ok(result.includes(FORK_INTRO)); assert.ok(result.includes(FORK_IMAGE));
  assert.ok(result.includes('## New upstream documentation')); assert.ok(!result.includes('<<<<<<<'));
});
test('refuses unrelated or additional README conflicts', () => {
  assert.throws(() => resolveReadme('<<<<<<< HEAD\ncustom instructions\n=======\nother content\n>>>>>>> upstream\n'));
});

test('real Git synchronization preserves Fork commits, no-ops after sync, and aborts code conflicts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-upstream-sync-'));
  const previous = process.cwd();
  const run = (cwd, ...args) => execFileSync('git', args, {cwd, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
  try {
    const upstream = path.join(directory, 'upstream'); const fork = path.join(directory, 'fork');
    fs.mkdirSync(upstream); run(upstream, 'init', '-b', 'master');
    run(upstream, 'config', 'user.name', 'Test'); run(upstream, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(upstream, 'README.md'), '# Title\n\n基于 Node.js 的旧版介绍。\n');
    fs.writeFileSync(path.join(upstream, 'code.txt'), 'base\n');
    run(upstream, 'add', '.'); run(upstream, 'commit', '-m', 'base');
    run(directory, 'clone', upstream, fork); run(fork, 'config', 'user.name', 'Test'); run(fork, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(fork, 'README.md'), `# Title\n\n${FORK_INTRO}\n\n${FORK_IMAGE}\n`);
    fs.writeFileSync(path.join(fork, 'feature.txt'), 'WeChat feature\n');
    run(fork, 'add', '.'); run(fork, 'commit', '-m', 'Fork feature');
    const forkBase = run(fork, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(upstream, 'README.md'), '# Title\n\n基于 Node.js 的新版介绍。\n');
    fs.writeFileSync(path.join(upstream, 'update.txt'), 'new upstream\n'); run(upstream, 'add', '.'); run(upstream, 'commit', '-m', 'upstream update');
    process.chdir(fork);
    const result = mergeUpstream({upstreamUrl:upstream});
    assert.equal(result.changed, true); assert.equal(result.base, forkBase);
    assert.equal(run(fork, 'rev-list', '--count', `HEAD..${result.upstream}`), '0');
    assert.ok(fs.readFileSync('README.md','utf8').includes(FORK_IMAGE)); assert.ok(fs.existsSync('feature.txt')); assert.ok(fs.existsSync('update.txt'));
    assert.equal(mergeUpstream({upstreamUrl:upstream}).changed, false);
    fs.writeFileSync('code.txt', 'fork code\n'); run(fork, 'add', '.'); run(fork, 'commit', '-m', 'fork code');
    const before = run(fork, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(upstream, 'code.txt'), 'upstream code\n'); run(upstream, 'add', '.'); run(upstream, 'commit', '-m', 'upstream code');
    assert.throws(() => mergeUpstream({upstreamUrl:upstream}));
    assert.equal(run(fork, 'rev-parse', 'HEAD'), before); assert.equal(run(fork, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync('code.txt','utf8').replaceAll('\r\n','\n'), 'fork code\n');
  } finally { process.chdir(previous); fs.rmSync(directory, {recursive:true, force:true}); }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const moduleUrl = new URL('../scripts/provenance.ts', import.meta.url).href;
const baseEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
});
function git(directory: string, args: string[], env = baseEnv()): string {
  return execFileSync('git', args, {
    cwd: directory,
    env,
    windowsHide: true,
    encoding: 'utf8',
  }).trim();
}
function evidence(directory: string, env = baseEnv()) {
  const script =
    'const {sourceEvidence}=await import(process.argv[1]);console.log(JSON.stringify(await sourceEvidence(process.argv[2])))';
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', script, moduleUrl, directory],
      {
        cwd: directory,
        env,
        windowsHide: true,
        encoding: 'utf8',
      },
    ),
  );
}

test('provenance ignores ambient Git redirection and trace output while preserving clean and dirty identity', async () => {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'intent-provenance-environment-'));
  const project = join(directory, 'project');
  const unrelated = join(directory, 'unrelated');
  try {
    for (const [path, name] of [
      [project, 'project'],
      [unrelated, 'unrelated'],
    ] as const) {
      await mkdir(join(path, 'src'), { recursive: true });
      await writeFile(join(path, 'src/fixture.txt'), name);
      git(path, ['init', '--quiet', '--template=', '-b', 'main']);
      git(path, ['add', 'src/fixture.txt']);
      git(path, [
        '-c',
        'user.name=Synthetic Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        name,
      ]);
    }
    const head = git(project, ['rev-parse', 'HEAD']);
    const unrelatedHead = git(unrelated, ['rev-parse', 'HEAD']);
    const unrelatedIndex = await readFile(join(unrelated, '.git/index'));
    const clean = evidence(project);
    assert.equal(clean.git.head, head);
    assert.equal(clean.git.dirty, false);
    const overrides = {
      ...baseEnv(),
      GIT_DIR: join(unrelated, '.git'),
      GIT_WORK_TREE: unrelated,
      GIT_COMMON_DIR: join(unrelated, '.git'),
      GIT_INDEX_FILE: join(unrelated, '.git/index'),
      GIT_OBJECT_DIRECTORY: join(unrelated, '.git/objects'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: unrelated,
    };
    // Negative control: unsanitized Git really resolves the other repository and writes a trace.
    const controlTrace = join(directory, 'control.trace');
    assert.equal(
      git(project, ['rev-parse', 'HEAD'], { ...overrides, GIT_TRACE: controlTrace }),
      unrelatedHead,
    );
    assert.ok((await readFile(controlTrace)).byteLength > 0);
    // The production provenance path must read the actual project with no outside trace output.
    const protectedTrace = join(directory, 'must-not-exist.trace');
    const contaminated = evidence(project, { ...overrides, GIT_TRACE: protectedTrace });
    assert.deepEqual(contaminated, clean);
    await assert.rejects(readFile(protectedTrace), { code: 'ENOENT' });
    await writeFile(join(project, 'src/fixture.txt'), 'changed');
    const dirty = evidence(project, { ...overrides, GIT_TRACE: protectedTrace });
    assert.equal(dirty.git.head, head);
    assert.equal(dirty.git.dirty, true);
    assert.notEqual(dirty.sha256, clean.sha256);
    await assert.rejects(readFile(protectedTrace), { code: 'ENOENT' });
    assert.equal(git(unrelated, ['rev-parse', 'HEAD']), unrelatedHead);
    assert.equal(git(unrelated, ['status', '--porcelain', '--untracked-files=all']), '');
    assert.deepEqual(await readFile(join(unrelated, '.git/index')), unrelatedIndex);
    // A mismatched worktree in local repository configuration is also not valid provenance.
    git(project, ['config', 'core.worktree', unrelated]);
    assert.equal(resolve(git(project, ['rev-parse', '--show-toplevel'])), resolve(unrelated));
    const mismatched = evidence(project);
    assert.deepEqual(mismatched.git, { state: 'unavailable' });
  } finally {
    assert.equal(dirname(resolve(directory)), parent);
    assert.ok(directory.startsWith(join(parent, 'intent-provenance-environment-')));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { sourceEvidence } from '../scripts/provenance.ts';

async function fixture() {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'intent-provenance-'));
  const project = join(directory, 'project');
  await mkdir(project);
  return {
    directory,
    project,
    async cleanup() {
      assert.equal(dirname(directory), parent);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('public runtime assets participate in a stable source manifest and content changes alter its digest', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.project, 'src'));
    await mkdir(join(f.project, 'public'));
    await writeFile(join(f.project, 'src/main.ts'), 'export const synthetic = true;');
    await writeFile(join(f.project, 'public/runtime.js'), 'console.log(1);');
    const first = await sourceEvidence(f.project);
    assert.deepEqual(await sourceEvidence(f.project), first);
    assert.ok(first.files.some((file) => file.path === 'public/runtime.js'));
    assert.equal(first.git.state, 'uninitialized');
    await writeFile(join(f.project, 'public/runtime.js'), 'console.log(2);');
    const changed = await sourceEvidence(f.project);
    assert.notEqual(changed.sha256, first.sha256);
    assert.notEqual(
      changed.files.find((file) => file.path === 'public/runtime.js')?.sha256,
      first.files.find((file) => file.path === 'public/runtime.js')?.sha256,
    );
    assert.equal(
      changed.files.find((file) => file.path === 'src/main.ts')?.sha256,
      first.files.find((file) => file.path === 'src/main.ts')?.sha256,
    );
  } finally {
    await f.cleanup();
  }
});

test('a selected source root cannot be a directory junction or symbolic link outside the project', async () => {
  const f = await fixture();
  try {
    const outside = join(f.directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'synthetic-only.ts'), 'export const synthetic = true;');
    await symlink(
      outside,
      join(f.project, 'src'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(sourceEvidence(f.project), /does not follow symbolic links/);
  } finally {
    await f.cleanup();
  }
});

test('nested source links and non-regular root manifest files are rejected', async () => {
  const f = await fixture();
  try {
    const outside = join(f.directory, 'outside');
    await mkdir(outside);
    await mkdir(join(f.project, 'src'));
    await symlink(
      outside,
      join(f.project, 'src/nested'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(sourceEvidence(f.project), /does not follow symbolic links/);
    await rm(join(f.project, 'src/nested'));
    await mkdir(join(f.project, 'package.json'));
    await assert.rejects(sourceEvidence(f.project), /requires regular files/);
  } finally {
    await f.cleanup();
  }
});

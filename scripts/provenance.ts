import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
// Read this repository's identity without inherited repository/config/trace overrides.
// This is environment isolation for Git, not a sandbox for hostile source code.
const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
});
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const roots = ['src', 'scripts', 'tests', 'docs', 'public', '.github'];
const files = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'README.md',
  'README.ko.md',
  'SECURITY.md',
  'LICENSE',
  '.gitignore',
  '.gitattributes',
  '.prettierrc.json',
  '.prettierignore',
];
export interface SourceEvidence {
  sha256: string;
  files: Array<{ path: string; sha256: string }>;
  git: { state: 'uninitialized' | 'available' | 'unavailable'; head?: string; dirty?: boolean };
}

export async function sourceEvidence(root = projectRoot): Promise<SourceEvidence> {
  const paths: string[] = [];
  async function walk(path: string): Promise<void> {
    let entries;
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error('Source evidence does not follow symbolic links.');
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        throw new Error('Source evidence does not follow symbolic links.');
      const next = join(path, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) paths.push(next);
    }
  }
  for (const directory of roots) await walk(join(root, directory));
  for (const file of files) {
    const path = join(root, file);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error('Source manifest requires regular files.');
      paths.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const manifest = await Promise.all(
    paths.map(async (path) => ({
      path: relative(root, path).replaceAll('\\', '/'),
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    })),
  );
  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let git: SourceEvidence['git'] = { state: 'uninitialized' };
  try {
    // Never attribute this nested project to an enclosing private workspace.
    await access(join(root, '.git'));
    const run = (args: string[]) =>
      exec('git', args, {
        cwd: root,
        env: gitEnvironment(),
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 100_000,
      });
    const top = (await run(['rev-parse', '--show-toplevel'])).stdout.trim();
    // Windows short paths (and directory aliases) can name the same physical root.
    const [actualRoot, requestedRoot] = await Promise.all([realpath(top), realpath(root)]);
    const normalized = (path: string) =>
      process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    if (normalized(actualRoot) !== normalized(requestedRoot))
      throw new Error('Unexpected Git root.');
    const head = (await run(['rev-parse', 'HEAD'])).stdout.trim();
    const status = (await run(['status', '--porcelain', '--untracked-files=all'])).stdout;
    git = { state: 'available', head, dirty: status.length > 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') git = { state: 'unavailable' };
  }
  return {
    sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    files: manifest,
    git,
  };
}

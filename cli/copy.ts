/**
 * Copies the template tree into a new project directory, renaming file
 * contents and paths on the way. The file list comes from git when the
 * template is a repository (tracked plus untracked-but-not-ignored files),
 * so ignored junk never travels; otherwise a filesystem walk applies the
 * exclude list. The exclude list is applied to the git list as well.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isBinary, renamePath, renameText, type Names } from './rename';

const EXCLUDED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  '.turbo',
  '.next',
  'verify-logs',
  'test-results',
  'playwright-report',
]);
const EXCLUDED_FILES = new Set(['.env', '.env.local', '.env.agent']);
const PU_KEPT = new Set(['.pu/config.yaml', '.pu/agent-context.md']);

/**
 * The generator (cli/), the npm bootstrapper (create/) and the template's own
 * release history stay with the template; a new project starts its own.
 */
const TEMPLATE_ONLY_ROOTS = new Set(['cli', 'create']);
const TEMPLATE_ONLY_FILES = new Set(['CHANGELOG.md']);
const templateOnly = (path: string, root: string): boolean =>
  TEMPLATE_ONLY_ROOTS.has(root) || TEMPLATE_ONLY_FILES.has(path);

/** True when a template-relative path must not reach the new project. */
export function isExcluded(path: string): boolean {
  const segments = path.split('/');
  const base = segments.at(-1) ?? '';
  if (templateOnly(path, segments[0] ?? '')) return true;
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true;
  if (EXCLUDED_FILES.has(base)) return true;
  if (base.endsWith('.tsbuildinfo')) return true;
  if (segments[0] === '.pu' && !PU_KEPT.has(path)) return true;
  return segments[0] === '.claude' && segments[1] === 'worktrees';
}

function gitFileList(root: string): string[] | null {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  // A path is listed once even when it is both cached and modified.
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
}

function walk(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    if (isExcluded(rel)) return [];
    return entry.isDirectory() ? walk(root, full) : [rel];
  });
}

/** Template-relative files to copy, sorted, with exclusions applied. */
export function templateFiles(root: string): string[] {
  const listed = gitFileList(root) ?? walk(root);
  return (
    listed
      .filter((path) => !isExcluded(path))
      // Tracked files deleted in the working tree are skipped.
      .filter((path) => {
        try {
          lstatSync(join(root, path));
          return true;
        } catch {
          return false;
        }
      })
      .sort()
  );
}

export type CopyResult = { readonly files: number; readonly binary: number };

/** Copies `files` from `root` into `target`, renaming text and paths. */
export function copyTemplate(
  root: string,
  target: string,
  files: readonly string[],
  names: Names,
): CopyResult {
  let binary = 0;
  for (const file of files) {
    const source = join(root, file);
    const destination = join(target, renamePath(file, names));
    mkdirSync(dirname(destination), { recursive: true });
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      symlinkSync(
        renameText(readlinkSync(source), names, { path: true }),
        destination,
      );
      continue;
    }
    if (stat.isDirectory()) continue; // a nested repository listed by git
    const bytes = readFileSync(source);
    if (isBinary(bytes)) {
      binary += 1;
      writeFileSync(destination, bytes);
    } else {
      writeFileSync(destination, renameText(bytes.toString('utf8'), names));
    }
    chmodSync(destination, statSync(source).mode & 0o777);
  }
  return { files: files.length, binary };
}

/** A target is usable when it does not exist or is an empty directory. */
export function targetProblem(target: string): string | null {
  if (!existsSync(target)) return null;
  if (!statSync(target).isDirectory())
    return `${target} exists and is not a directory`;
  return readdirSync(target).length === 0
    ? null
    : `${target} exists and is not empty`;
}

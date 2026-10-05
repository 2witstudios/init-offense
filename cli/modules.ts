/**
 * Optional template modules (`cli/modules.json`) that `--without` removes.
 * Removal happens on the template file list before copying; afterwards the
 * generated tree is scanned for anything still pointing at a removed file
 * or package, so a not-yet-decoupled module produces a warning list instead
 * of a silently broken project.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { isBinary } from './rename';

export type PackageJsonEdit = {
  readonly file: string;
  readonly removeScripts?: readonly string[];
  readonly removeDependencies?: readonly string[];
};

type ModuleSpec = {
  readonly description: string;
  readonly experimental?: boolean;
  readonly paths: readonly string[];
  readonly packageJsonEdits?: readonly PackageJsonEdit[];
  readonly notes?: string;
};

export type Modules = Readonly<Record<string, ModuleSpec>>;

export function loadModules(
  file: string = join(import.meta.dir, 'modules.json'),
): Modules {
  return JSON.parse(readFileSync(file, 'utf8')) as Modules;
}

/** Unknown module names, so a typo fails instead of removing nothing. */
export const unknownModules = (
  modules: Modules,
  names: readonly string[],
): string[] => names.filter((name) => !Object.hasOwn(modules, name));

const GLOB_CHARS = /[*?[\]{}]/;

/** True when `path` falls under a module pattern (a glob or a path prefix). */
export function matchesPattern(pattern: string, path: string): boolean {
  if (GLOB_CHARS.test(pattern)) return new Bun.Glob(pattern).match(path);
  return path === pattern || path.startsWith(`${pattern}/`);
}

/** Splits template files into kept and removed for the chosen modules. */
export function partitionFiles(
  files: readonly string[],
  modules: Modules,
  without: readonly string[],
): { kept: string[]; removed: string[] } {
  const patterns = without.flatMap((name) => modules[name]?.paths ?? []);
  const removed = files.filter((file) =>
    patterns.some((pattern) => matchesPattern(pattern, file)),
  );
  const removedSet = new Set(removed);
  return { kept: files.filter((file) => !removedSet.has(file)), removed };
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ways a script in `dir/package.json` can name a removed file. */
const spellings = (dir: string, file: string): string[] => {
  if (dir === '.') return [file];
  return file.startsWith(`${dir}/`)
    ? [file, file.slice(dir.length + 1)]
    : [file];
};

const runsRemoved = (
  command: unknown,
  dir: string,
  removed: readonly string[],
): boolean =>
  typeof command === 'string' &&
  removed.some((file) =>
    spellings(dir, file).some((candidate) =>
      new RegExp(`(^|[\\s/'"])${escapeRegExp(candidate)}($|[\\s'"])`).test(
        command,
      ),
    ),
  );

const withoutKeys = (
  value: unknown,
  drop: (key: string, value: unknown) => boolean,
): { kept: Json; dropped: string[] } => {
  const entries = Object.entries(record(value));
  return {
    kept: Object.fromEntries(entries.filter(([k, v]) => !drop(k, v))),
    dropped: entries.filter(([k, v]) => drop(k, v)).map(([k]) => k),
  };
};

/**
 * Drops package.json scripts that run a removed file (relative to the
 * package directory or the repository root) plus any explicit edits.
 * Returns `file: field.key` labels for what was dropped.
 */
export function prunePackageJson(
  path: string,
  content: string,
  removed: readonly string[],
  edits: readonly PackageJsonEdit[] = [],
): { content: string; dropped: string[] } {
  const json = JSON.parse(content) as Json;
  const explicit = edits.filter((edit) => edit.file === path);
  const scriptNames = new Set(explicit.flatMap((e) => e.removeScripts ?? []));
  const depNames = new Set(explicit.flatMap((e) => e.removeDependencies ?? []));
  const dir = dirname(path);
  const drops: Record<string, (key: string, value: unknown) => boolean> = {
    scripts: (key, command) =>
      scriptNames.has(key) || runsRemoved(command, dir, removed),
    dependencies: (key) => depNames.has(key),
    devDependencies: (key) => depNames.has(key),
  };
  const next: Json = { ...json };
  const dropped: string[] = [];
  for (const [field, drop] of Object.entries(drops)) {
    if (json[field] === undefined) continue;
    const result = withoutKeys(json[field], drop);
    next[field] = result.kept;
    dropped.push(...result.dropped.map((key) => `${path}: ${field}.${key}`));
  }
  if (dropped.length === 0) return { content, dropped };
  return { content: `${JSON.stringify(next, null, 2)}\n`, dropped };
}

export type Reference = {
  readonly file: string;
  readonly line: number;
  readonly kind: 'import' | 'mention';
  readonly target: string;
  readonly text: string;
};

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bmodule\s*\(\s*|^\s*import\s+)['"]([^'"\n]+)['"]/g;
const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '/index.ts',
  '/index.tsx',
];

const resolveRelative = (
  from: string,
  specifier: string,
  removed: ReadonlySet<string>,
): string | null => {
  const base = normalize(join(dirname(from), specifier));
  return (
    RESOLVE_SUFFIXES.map((suffix) => `${base}${suffix}`).find((c) =>
      removed.has(c),
    ) ?? null
  );
};

/** Removed directories (common parents) worth reporting as plain mentions. */
const removedRoots = (
  removed: readonly string[],
  patterns: readonly string[],
): string[] =>
  patterns
    .filter((pattern) => !GLOB_CHARS.test(pattern))
    .filter((pattern) =>
      removed.some(
        (file) => file === pattern || file.startsWith(`${pattern}/`),
      ),
    );

type ScanInput = {
  readonly root: string;
  readonly files: readonly string[];
  readonly removed: readonly string[];
  readonly removedPackages: readonly string[];
  readonly removedPatterns: readonly string[];
};

type LineContext = {
  readonly file: string;
  readonly removed: ReadonlySet<string>;
  readonly packages: readonly string[];
  readonly mentionTargets: readonly string[];
};

const importTarget = (
  specifier: string,
  context: LineContext,
): string | null => {
  if (specifier.startsWith('.'))
    return resolveRelative(context.file, specifier, context.removed);
  return (
    context.packages.find(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    ) ?? null
  );
};

/** At most one reference per line: an import wins over a mention. */
const lineReference = (
  text: string,
  line: number,
  context: LineContext,
): Reference | null => {
  const reference = (kind: Reference['kind'], target: string): Reference => ({
    file: context.file,
    line,
    kind,
    target,
    text: text.trim().slice(0, 160),
  });
  for (const match of text.matchAll(SPECIFIER)) {
    const target = importTarget(match[1] ?? '', context);
    if (target) return reference('import', target);
  }
  const mention =
    context.packages.find((name) => text.includes(name)) ??
    context.mentionTargets.find((target) => text.includes(target));
  return mention ? reference('mention', mention) : null;
};

const textOf = (full: string): string | null => {
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  const bytes = readFileSync(full);
  return isBinary(bytes) ? null : bytes.toString('utf8');
};

/**
 * Finds references in the generated tree to removed files: relative imports
 * that resolve to a removed file, imports of removed packages, and plain
 * mentions of removed paths or package names.
 */
export function findReferences(input: ScanInput): Reference[] {
  const removed = new Set(input.removed);
  const mentionTargets = [
    ...removedRoots(input.removed, input.removedPatterns),
    ...input.removed.map((file) => file.replace(/\.(tsx?|mjs|js)$/, '')),
  ];
  return input.files.flatMap((file) => {
    const text = textOf(join(input.root, file));
    if (text === null) return [];
    const context = {
      file,
      removed,
      packages: input.removedPackages,
      mentionTargets,
    };
    return text
      .split('\n')
      .map((line, index) => lineReference(line, index + 1, context))
      .filter((reference): reference is Reference => reference !== null);
  });
}

/** Package names declared by removed package.json files. */
export const removedPackageNames = (
  root: string,
  removed: readonly string[],
): string[] =>
  removed
    .filter((file) => file.endsWith('package.json'))
    .map(
      (file) => record(JSON.parse(readFileSync(join(root, file), 'utf8'))).name,
    )
    .filter((name): name is string => typeof name === 'string');

/** Applies package.json pruning across the generated tree. */
export function pruneGeneratedPackageJsons(
  root: string,
  files: readonly string[],
  removed: readonly string[],
  edits: readonly PackageJsonEdit[],
): string[] {
  return files
    .filter((file) => file === 'package.json' || file.endsWith('/package.json'))
    .flatMap((file) => {
      const full = join(root, file);
      const result = prunePackageJson(
        file,
        readFileSync(full, 'utf8'),
        removed,
        edits,
      );
      if (result.dropped.length > 0) writeFileSync(full, result.content);
      return result.dropped;
    });
}

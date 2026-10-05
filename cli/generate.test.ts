import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { parseProjectConfig } from '../scripts/project-config';
import type { Options } from './args';
import {
  generateTree,
  newProjectConfig,
  stripTemplateWiring,
} from './generate';
import { isBinary } from './rename';

setupRitewayBun();

const scratch = mkdtempSync(join(tmpdir(), 'init-offense-generate-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const options = (overrides: Partial<Options> = {}): Options => ({
  target: join(scratch, 'out'),
  slug: 'widget-app',
  display: 'Widget App',
  owner: 'someone',
  repo: 'someone/widget-app',
  without: [],
  drive: false,
  github: false,
  install: false,
  yes: true,
  ...overrides,
});

describe('newProjectConfig', () => {
  test('replaces identity and nulls every id', () => {
    assert({
      given: 'a provisioned template config',
      should: 'carry the new identity with no PageSpace ids',
      actual: newProjectConfig(
        {
          version: 1,
          name: 'acme',
          pagespace: {
            apiUrl: 'https://p',
            driveName: 'Acme',
            driveId: 'x',
            pages: { a: 'p' },
            channels: { b: 'c' },
            agents: { d: 'e' },
          },
        },
        options(),
      ),
      expected: {
        version: 1,
        name: 'widget-app',
        displayName: 'Widget App',
        repo: 'someone/widget-app',
        owner: 'someone',
        pagespace: {
          apiUrl: 'https://p',
          driveName: 'Widget App',
          driveId: null,
          pages: { a: null },
          channels: { b: null },
          agents: { d: null },
        },
      },
    });
  });
});

const listTree = (root: string, dir = root): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    const rel = relative(root, full);
    return entry.isDirectory() ? [`${rel}/`, ...listTree(root, full)] : [rel];
  });

const occurrences = (root: string, word: string): string[] =>
  listTree(root).flatMap((path) => {
    const pattern = new RegExp(word, 'gi');
    const hits = pattern.test(path) ? [`name: ${path}`] : [];
    if (path.endsWith('/')) return hits;
    const bytes = readFileSync(join(root, path));
    if (isBinary(bytes)) return hits;
    const count = bytes.toString('utf8').match(pattern)?.length ?? 0;
    return count > 0 ? [...hits, `content: ${path} (${count})`] : hits;
  });

describe('generation from the real template', () => {
  const target = join(scratch, 'widget-app');
  const generated = generateTree(options({ target }));
  const tree = listTree(target);

  test('no placeholder survives', () => {
    assert({
      given: 'the generated tree',
      should: 'contain no case-insensitive "acme" in file names or text',
      actual: occurrences(target, 'acme'),
      expected: [],
    });
  });

  test('no source-project name survives', () => {
    assert({
      given: 'the generated tree',
      should: 'contain no case-insensitive "daisy" in file names or text',
      actual: occurrences(target, 'daisy'),
      expected: [],
    });
  });

  test('project.config.json', () => {
    const config = parseProjectConfig(
      JSON.parse(readFileSync(join(target, 'project.config.json'), 'utf8')),
    );
    assert({
      given: 'the generated config',
      should: 'validate and carry the new identity with no drive ids',
      actual: {
        name: config.name,
        displayName: config.displayName,
        repo: config.repo,
        driveName: config.pagespace.driveName,
        driveId: config.pagespace.driveId,
        noPageIds: Object.values(config.pagespace.pages).every(
          (id) => id === null,
        ),
      },
      expected: {
        name: 'widget-app',
        displayName: 'Widget App',
        repo: 'someone/widget-app',
        driveName: 'Widget App',
        driveId: null,
        noPageIds: true,
      },
    });
  });

  test('excluded paths', () => {
    assert({
      given: 'the generated tree',
      should: 'carry no cli/, .git, node_modules or local env files',
      actual: tree.filter((path) =>
        /^(cli\/|\.git\/|\.env$|\.env\.local$|\.env\.agent$)|node_modules/.test(
          path,
        ),
      ),
      expected: [],
    });
  });

  test('nothing removed without --without', () => {
    assert({
      given: 'no modules dropped',
      should: 'remove, drop and report nothing',
      actual: [generated.removed, generated.dropped, generated.references],
      expected: [[], [], []],
    });
  });
});

describe('module removal', () => {
  test('--without realtime,docs removes module files and reports leftovers', () => {
    const target = join(scratch, 'slim');
    const result = generateTree(
      options({ target, without: ['realtime', 'docs'] }),
    );
    const tree = new Set(listTree(target));
    assert({
      given: 'both experimental modules removed',
      should:
        'delete their files, drop docs scripts and report remaining references',
      actual: {
        realtimeApp: tree.has('apps/realtime/'),
        docsScript: tree.has('scripts/docs-verify.ts'),
        droppedDocsScripts: result.dropped.some((line) =>
          line.includes('docs:verify'),
        ),
        hasReferences: result.references.length > 0,
      },
      expected: {
        realtimeApp: false,
        docsScript: false,
        droppedDocsScripts: true,
        hasReferences: true,
      },
    });
  });
});

describe('stripTemplateWiring', () => {
  test('removes the cli and create test runs and knip entries', () => {
    assert({
      given: 'the template package.json test script',
      should: 'drop the cli and create test runs',
      actual: stripTemplateWiring(
        'package.json',
        '"test": "bun test ./scripts && bun test ./cli && bun test ./create && turbo run test",',
      ),
      expected: '"test": "bun test ./scripts && turbo run test",',
    });
    assert({
      given: 'the template knip root entry',
      should: 'drop cli/init.ts',
      actual: stripTemplateWiring(
        'knip.jsonc',
        '".": { "entry": ["cli/init.ts", "cli/**/*.test.ts", "scenarios/*.ts"] },',
      ),
      expected: '".": { "entry": ["scenarios/*.ts"] },',
    });
    assert({
      given: 'the template knip root entry as prettier lays it out',
      should: 'drop every cli/ and create/ entry line',
      actual: stripTemplateWiring(
        'knip.jsonc',
        '".": {\n  "entry": [\n    "cli/init.ts",\n    "cli/verify-generated.ts",\n    "cli/**/*.test.ts",\n    "create/bin/init-offense.js",\n    "create/**/*.test.ts",\n    "scenarios/*.ts",\n  ],\n},',
      ),
      expected: '".": {\n  "entry": [\n    "scenarios/*.ts",\n  ],\n},',
    });
  });
});

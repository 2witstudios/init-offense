/**
 * The file-system half of `new`: copy and rename the template, drop the
 * `--without` modules, write project.config.json and report leftovers.
 * Runs no external commands.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { renderAgentsDrive } from '../scripts/drive-bootstrap-render';
import { join, resolve } from 'node:path';
import type { Options } from './args';
import { copyTemplate, templateFiles } from './copy';
import {
  findReferences,
  loadModules,
  partitionFiles,
  pruneGeneratedPackageJsons,
  removedPackageNames,
  type Modules,
  type Reference,
} from './modules';
import { renamePath, renameText, type Names } from './rename';

/**
 * The repository string the template's fixtures and docs use for "this
 * project's repo"; the generator rewrites it to the new repo. It is not the
 * template's own repository (project.config.json names that, so the
 * template's CI and GitHub tooling act on 2witstudios/init-offense).
 */
const TEMPLATE_REPO_PLACEHOLDER = '2witstudios/acme';

export const TEMPLATE_ROOT = resolve(import.meta.dir, '..');

type Json = Record<string, unknown>;

const nullAll = (value: unknown): Json =>
  Object.fromEntries(
    Object.keys((value ?? {}) as Json).map((key) => [key, null]),
  );

/** The new project's config: identity replaced, every PageSpace id reset. */
export function newProjectConfig(template: Json, options: Options): Json {
  const pagespace = (template.pagespace ?? {}) as Json;
  return {
    ...template,
    name: options.slug,
    displayName: options.display,
    repo: options.repo,
    owner: options.owner,
    pagespace: {
      ...pagespace,
      driveName: options.display,
      driveId: null,
      pages: nullAll(pagespace.pages),
      channels: nullAll(pagespace.channels),
      agents: nullAll(pagespace.agents),
    },
  };
}

export type Generated = {
  readonly files: readonly string[];
  readonly removed: readonly string[];
  readonly dropped: readonly string[];
  readonly references: readonly Reference[];
};

/** Copies, renames, removes modules and writes project.config.json. */
export function generateTree(
  options: Options,
  templateRoot: string = TEMPLATE_ROOT,
  modules: Modules = loadModules(),
): Generated {
  const templateConfig = JSON.parse(
    readFileSync(join(templateRoot, 'project.config.json'), 'utf8'),
  ) as Json;
  const names: Names = {
    slug: options.slug,
    display: options.display,
    repo: options.repo,
    templateRepo: TEMPLATE_REPO_PLACEHOLDER,
  };
  const { kept, removed } = partitionFiles(
    templateFiles(templateRoot),
    modules,
    options.without,
  );
  const packages = removedPackageNames(templateRoot, removed).map((name) =>
    renameText(name, names),
  );
  copyTemplate(templateRoot, options.target, kept, names);
  writeFileSync(
    join(options.target, 'project.config.json'),
    `${JSON.stringify(newProjectConfig(templateConfig, options), null, 2)}\n`,
  );
  for (const file of ['package.json', 'knip.jsonc']) {
    const path = join(options.target, file);
    writeFileSync(path, stripTemplateWiring(file, readFileSync(path, 'utf8')));
  }
  // The template's own drive is not the new project's: AGENTS.md starts
  // unprovisioned until its own `bun drive:bootstrap` renders the line.
  const agents = join(options.target, 'AGENTS.md');
  if (existsSync(agents))
    writeFileSync(
      agents,
      renderAgentsDrive(readFileSync(agents, 'utf8'), {
        driveName: options.display,
        driveId: null,
        conventionsId: null,
      }).text,
    );
  const rename = (path: string) => renamePath(path, names);
  const files = kept.map(rename);
  const removedFiles = removed.map(rename);
  const specs = options.without.map((name) => modules[name]);
  const dropped = pruneGeneratedPackageJsons(
    options.target,
    files,
    removedFiles,
    specs.flatMap((spec) => spec?.packageJsonEdits ?? []),
  );
  const references =
    removed.length === 0
      ? []
      : findReferences({
          root: options.target,
          files,
          removed: removedFiles,
          removedPackages: packages,
          removedPatterns: specs.flatMap((spec) =>
            (spec?.paths ?? []).map(rename),
          ),
        });
  return { files, removed: removedFiles, dropped, references };
}

/**
 * The template wires its own `cli/` and `create/` into the test script and
 * knip; a generated project has neither, so those references are removed.
 */
export function stripTemplateWiring(file: string, text: string): string {
  if (file === 'package.json')
    return text.replace(' && bun test ./cli && bun test ./create', '');
  if (file === 'knip.jsonc')
    return text
      .replace(
        / {4}\/\/ The template's one-shot initializer[^\n]*\n {4}\/\/ cli\/ from every[^\n]*\n/,
        '',
      )
      .replace(/^\s*"(?:cli|create)\/[^"\n]*",\n/gm, '')
      .replace(/"(?:cli|create)\/[^"\n]*", /g, '');
  return text;
}

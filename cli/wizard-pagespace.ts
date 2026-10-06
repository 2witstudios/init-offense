/**
 * The temporary PageSpace key the drive bootstrap needs. Drive creation and
 * webhooks refuse drive-scoped keys, so the wizard mints an all-drives key,
 * holds it only in memory, hands it to the bootstrap through the
 * environment, and always revokes it afterwards, on success or failure.
 *
 * `pagespace keys create --show-token` prints exactly one stdout line,
 * `PAGESPACE_TOKEN=mcp_…`, and everything human-readable on stderr, so the
 * wizard captures stdout only and never displays it, and shows only the
 * stderr lines needed to approve the key, not the CLI's MCP-client tips.
 */
import { act, display, type WizardDeps } from './wizard-deps';
import type { Command } from './wizard-plan';

const TOKEN_LINE = /^PAGESPACE_TOKEN=(mcp_[A-Za-z0-9_-]{16,128})\r?$/gm;

/** The minted token, or null unless stdout holds exactly one token line. */
export function extractToken(stdout: string): string | null {
  const matches = [...stdout.matchAll(TOKEN_LINE)];
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

type KeyRow = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly createdAt?: unknown;
};

/** The id of the newest key called `name` in `pagespace keys list --json`. */
export function keyIdByName(json: string, name: string): string | null {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const matching = (rows as KeyRow[])
    .filter((row) => row.name === name && typeof row.id === 'string')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return (matching[0]?.id as string | undefined) ?? null;
}

const setupKeyName = (slug: string): string => `${slug}-setup`;

const mintCommand = (name: string): Command => [
  'pagespace',
  'keys',
  'create',
  '--all-drives',
  '--name',
  name,
  '--show-token',
  // The wizard already asked; this also replaces a stale local copy.
  '--yes',
];

async function mint(deps: WizardDeps, name: string): Promise<string> {
  const command = mintCommand(name);
  deps.log(`  ${display(command)}`);
  deps.log('  (approve the key in the browser window that opens)');
  const { code, stdout } = await deps.runner.consent(command);
  const token = code === 0 ? extractToken(stdout) : null;
  if (token === null)
    throw new Error(
      code === 0
        ? 'PageSpace created the key but did not hand back a token the wizard could read.'
        : `Creating the temporary PageSpace key failed (exit ${code}).`,
    );
  return token;
}

/** Revokes the key server-side, then forgets the CLI's local copy. */
function revokeKey(deps: WizardDeps, name: string, dryRun: boolean): boolean {
  deps.log(`\nRemoving the temporary PageSpace key "${name}"…`);
  const listCommand: Command = ['pagespace', 'keys', 'list', '--json'];
  deps.log(`  ${dryRun ? '[dry run] ' : ''}${display(listCommand)}`);
  const listed = dryRun
    ? { code: 0, stdout: '' }
    : deps.runner.probe(listCommand);
  // undefined: the list itself failed, so whether the key exists is unknown.
  const id = dryRun
    ? '<key id>'
    : listed.code === 0
      ? keyIdByName(listed.stdout, name)
      : undefined;
  let revoked = id === null;
  if (id === null)
    deps.log('  No key by that name exists on PageSpace; nothing to revoke.');
  else if (id !== undefined)
    revoked =
      act(deps, dryRun, ['pagespace', 'keys', 'revoke', id, '--yes']) === 0;
  act(deps, dryRun, ['pagespace', 'logout', `--key=${name}`]);
  if (!revoked)
    deps.log(
      `  Could not revoke it. Revoke "${name}" yourself: pagespace keys list, then pagespace keys revoke <id>.`,
    );
  return revoked;
}

/**
 * Mints the temporary key, runs `use` with it, and revokes it in a
 * `finally`, so a failed mint, a failed bootstrap or a thrown error all
 * still clean up. In a dry run `use` receives a placeholder.
 */
export async function withTemporaryKey<T>(
  deps: WizardDeps,
  slug: string,
  dryRun: boolean,
  use: (token: string) => Promise<T> | T,
): Promise<T> {
  const name = setupKeyName(slug);
  deps.log(
    `\nCreating a temporary PageSpace key "${name}" (removed again when setup finishes; approval 1 of 2, the drive's own key follows):`,
  );
  const release = deps.holdInterrupts();
  try {
    if (dryRun) {
      deps.log(`  [dry run] ${display(mintCommand(name))}`);
      return await use('<temporary key>');
    }
    return await use(await mint(deps, name));
  } finally {
    revokeKey(deps, name, dryRun);
    release();
  }
}

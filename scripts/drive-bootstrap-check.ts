/**
 * `bun drive:bootstrap --check`: verifies the live drive read-only with
 * whichever credential the project has. The temporary unscoped
 * PAGESPACE_BOOTSTRAP_TOKEN is revoked once setup finishes, so the check
 * normally runs with `.env`'s PAGESPACE_TOKEN, the drive's own Agent key:
 * pages, types, statuses and whether the key can edit are all readable
 * with it. Anything only an owner key can read is reported as not checked
 * rather than failing the check.
 */
import { inspectBootstrap } from './drive-bootstrap-access';
import {
  checkReport,
  HttpError,
  type Inspection,
  type Transport,
} from './drive-bootstrap-inspect';
import type { Manifest } from './drive-bootstrap-manifest';
import type { ProjectConfig } from './project-config';

export type CheckCredentials = {
  /** PAGESPACE_BOOTSTRAP_TOKEN, an unscoped key; read-only here. */
  readonly bootstrap: Transport | null;
  /** `.env`'s PAGESPACE_TOKEN, the drive's Agent key; read-only here. */
  readonly agentKey: Transport | null;
};

export type CheckResult = { readonly code: number; readonly report: string };

export const NO_CHECK_CREDENTIAL =
  "drive:bootstrap --check reads the live drive with .env's PAGESPACE_TOKEN (the drive key `bun drive:bootstrap` mints), " +
  'and neither it nor PAGESPACE_BOOTSTRAP_TOKEN is set. Mint the drive key with `bun drive:bootstrap` (see the header of scripts/drive-bootstrap.ts), ' +
  'or preview the plan offline with `bun drive:bootstrap --dry-run`.';

/**
 * PageSpace refused the key `--check` reads the drive with: name that
 * credential and how to replace it. Nothing was written, so there is
 * nothing to resume.
 */
function refusedCredential(
  credential: keyof CheckCredentials,
  error: HttpError,
): string {
  return credential === 'agentKey'
    ? `drive:bootstrap --check: PageSpace refused .env's PAGESPACE_TOKEN (${error.message}). ` +
        'Check PAGESPACE_TOKEN in .env, or rerun `bun drive:bootstrap` (with PAGESPACE_BOOTSTRAP_TOKEN set) to mint a new Agent key, ' +
        'then revoke the old one (`pagespace keys list`, `pagespace keys revoke`).'
    : `drive:bootstrap --check: PageSpace refused PAGESPACE_BOOTSTRAP_TOKEN (${error.message}). ` +
        'Set it to a live unscoped key (see the header of scripts/drive-bootstrap.ts), ' +
        "or unset it to check with .env's PAGESPACE_TOKEN.";
}

/**
 * What `bun drive:bootstrap` prints when it throws. Only a run that creates
 * things has saved ids to resume from; `--check` and `--dry-run` write
 * nothing, so they get no resume hint.
 */
export function failureLines(
  argv: readonly string[],
  error: unknown,
): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const writes = !argv.includes('--check') && !argv.includes('--dry-run');
  return [
    `drive:bootstrap failed: ${message}`,
    ...(writes
      ? [
          'Ids created so far are saved in project.config.json; rerun to resume.',
        ]
      : []),
  ];
}

export async function checkDrive(
  config: ProjectConfig,
  manifest: Manifest,
  envText: string,
  { bootstrap, agentKey }: CheckCredentials,
): Promise<CheckResult> {
  const transport = bootstrap ?? agentKey;
  if (transport === null) return { code: 2, report: NO_CHECK_CREDENTIAL };
  let inspected: Inspection;
  try {
    inspected = await inspectBootstrap(config, manifest, transport, {
      envText,
      withWorkflows: false,
      agentKey,
      roleReadOptional: bootstrap === null,
    });
  } catch (error) {
    // The Agent key's refusal on the Roadmap is reported as a problem
    // inside the inspection; a 401/403 that escapes it is the reading key's.
    if (error instanceof HttpError && [401, 403].includes(error.status))
      return {
        code: 2,
        report: refusedCredential(bootstrap ? 'bootstrap' : 'agentKey', error),
      };
    throw error;
  }
  return {
    code: inspected.problems.length === 0 ? 0 : 1,
    report: checkReport(inspected.problems, inspected.unchecked),
  };
}

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
import { checkReport, type Transport } from './drive-bootstrap-inspect';
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

export async function checkDrive(
  config: ProjectConfig,
  manifest: Manifest,
  envText: string,
  { bootstrap, agentKey }: CheckCredentials,
): Promise<CheckResult> {
  const transport = bootstrap ?? agentKey;
  if (transport === null) return { code: 2, report: NO_CHECK_CREDENTIAL };
  const { problems, unchecked } = await inspectBootstrap(
    config,
    manifest,
    transport,
    {
      envText,
      withWorkflows: false,
      agentKey,
      roleReadOptional: bootstrap === null,
    },
  );
  return {
    code: problems.length === 0 ? 0 : 1,
    report: checkReport(problems, unchecked),
  };
}

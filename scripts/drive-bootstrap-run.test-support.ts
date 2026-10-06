// One full bootstrap pass against the fake drive, as `main` runs it, shared
// by the executor and `--check` suites.
import { inspectBootstrap } from './drive-bootstrap-access';
import { executePlan } from './drive-bootstrap-exec';
import { readOnly } from './drive-bootstrap-inspect';
import { parseManifest } from './drive-bootstrap-manifest';
import { planBootstrap, type BootstrapOptions } from './drive-bootstrap-plan';
import { parseProjectConfig } from './project-config';
import {
  fakeDrive,
  manifestJson,
  paths,
  templateConfigText,
} from './drive-bootstrap-fake.test-support';

export const manifest = parseManifest(manifestJson());
const options: BootstrapOptions = {
  skipWebhooks: false,
  skipKey: false,
  github: true,
  docsWorkflows: true,
};
const AGENTS =
  '# Agents\n\n<!-- drive:start -->\nplaceholder\n<!-- drive:end -->\n';

export type Fake = ReturnType<typeof fakeDrive>;

export const configOf = (fake: Fake) =>
  parseProjectConfig(JSON.parse(fake.files.get(paths.config) ?? ''));

/** Inspects the fake drive as `main` does, the agent key read from .env. */
export const inspect = (fake: Fake, withWorkflows = true) => {
  const envText = fake.files.get(paths.env) ?? '';
  return inspectBootstrap(configOf(fake), manifest, readOnly(fake.transport), {
    envText,
    withWorkflows,
    agentKey: envText.includes('PAGESPACE_TOKEN=')
      ? readOnly(fake.transport)
      : null,
  });
};

/** One full bootstrap pass against the fake drive, as `main` runs it. */
export async function bootstrap(fake: Fake) {
  const config = configOf(fake);
  const { state, problems } = await inspect(fake);
  const actions = planBootstrap(config, manifest, state, options);
  await executePlan(actions, {
    manifest,
    transport: fake.transport,
    paths,
    state,
  });
  return { actions, problems };
}

export function seeded(failOnCall?: number) {
  const fake = fakeDrive({ failOnCall });
  fake.files.set(paths.config, templateConfigText());
  fake.files.set(paths.env, 'DATABASE_URL=postgres://local\n');
  fake.files.set(paths.agents, AGENTS);
  return fake;
}

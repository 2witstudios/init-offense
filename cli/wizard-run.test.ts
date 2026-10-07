import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { WizardStop } from './wizard-deps';
import { runLocally } from './wizard-run';
import { fakeDeps } from './wizard.test-support';

setupRitewayBun();

describe('runLocally when the app cannot start', () => {
  const target = '/work/widget';
  const accounts = {
    display: 'Widget',
    slug: 'widget',
    target,
    github: false,
    visibility: 'private' as const,
    plan: null,
    drive: false,
    run: true,
    owner: 'octo',
  };
  const files = { [`${target}/.env`]: 'PORT=3000\n' };
  const restart = `cd ${target} && bun slot:up && bun dev`;
  const runWith = async (options: Parameters<typeof fakeDeps>[0]) => {
    const fake = fakeDeps({ files, ...options });
    const outcome = await runLocally(
      fake.deps,
      { yes: true, dryRun: false },
      accounts,
      { drive: false, pushed: false, reviewGate: false },
    ).then(
      () => 'resolved',
      (error: unknown) =>
        error instanceof WizardStop
          ? { code: error.code, message: error.message }
          : error,
    );
    return { fake, outcome };
  };

  test('ports another dev server holds', async () => {
    const { fake, outcome } = await runWith({
      reachable: false,
      start: () => ({
        code: 1,
        output:
          '\u001b[31m⨯\u001b[39m Failed to start server. Is port \u001b[1m3000\u001b[22m in use?\n' +
          'realtime:dev: Failed to start server. Is port 3011 in use?\n' +
          'Is port 3000 in use?\n',
      }),
    });
    assert({
      given:
        'bun dev exiting before the app answered, saying ports 3000 and 3011 are in use',
      should:
        'stop with exit 1 naming both busy ports and the restart command, opening nothing',
      actual: [outcome, fake.opened],
      expected: [
        {
          code: 1,
          message:
            "\nThe app did not start: ports 3000 and 3011 are already in use, probably by another app's dev server. " +
            `Stop that app, then start this one again: ${restart}`,
        },
        [],
      ],
    });
  });

  test('any other early exit', async () => {
    const { outcome } = await runWith({
      reachable: false,
      start: () => ({ code: 1, output: 'error: Cannot find module "next"\n' }),
    });
    assert({
      given:
        'bun dev exiting with code 1 before the app answered, naming no port',
      should:
        'stop with exit 1 giving the code, the URL and the restart command',
      actual: outcome,
      expected: {
        code: 1,
        message:
          '\nThe app did not start: bun dev exited with code 1 before http://localhost:3000 answered. ' +
          `Fix the error above, then start it again: ${restart}`,
      },
    });
  });

  test('Ctrl-C before the app answered', async () => {
    const { fake, outcome } = await runWith({
      reachable: false,
      interrupted: true,
      start: () => ({ code: 130, output: '' }),
    });
    assert({
      given: 'the owner pressing Ctrl-C while the app was still starting',
      should: 'finish normally with the restart hint, not report a failure',
      actual: [outcome, fake.logs.at(-1)],
      expected: [
        'resolved',
        `\nThe app stopped. Start it again any time: ${restart}`,
      ],
    });
  });
});

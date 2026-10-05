import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { parseCli } from './args';

setupRitewayBun();

const noGh = () => null;

describe('parseCli', () => {
  test('defaults', () => {
    const result = parseCli(
      ['new', 'out', '--name', 'widget-app'],
      () => 'octo',
    );
    assert({
      given: 'only a dir and a slug',
      should: 'derive display, owner from gh and repo, with every step enabled',
      actual: 'options' in result ? { ...result.options, target: '' } : result,
      expected: {
        target: '',
        slug: 'widget-app',
        display: 'Widget App',
        owner: 'octo',
        repo: 'octo/widget-app',
        without: [],
        drive: true,
        github: true,
        visibility: 'private',
        install: true,
        yes: false,
      },
    });
  });

  test('flags', () => {
    const result = parseCli(
      [
        'new',
        'out',
        '--name',
        'w',
        '--display',
        'W Co',
        '--repo',
        'org/w-repo',
        '--without',
        'realtime, docs',
        '--no-drive',
        '--no-github',
        '--public',
        '--no-install',
        '--yes',
      ],
      noGh,
    );
    assert({
      given: 'every flag',
      should: 'take the owner from --repo and turn the steps off',
      actual: 'options' in result ? { ...result.options, target: '' } : result,
      expected: {
        target: '',
        slug: 'w',
        display: 'W Co',
        owner: 'org',
        repo: 'org/w-repo',
        without: ['realtime', 'docs'],
        drive: false,
        github: false,
        visibility: 'public',
        install: false,
        yes: true,
      },
    });
  });

  test('fallback owner', () => {
    const result = parseCli(['new', 'out', '--name', 'w'], noGh);
    assert({
      given: 'no --owner, no --repo and no gh login',
      should: 'fall back to 2witstudios',
      actual: 'options' in result ? result.options.repo : result,
      expected: '2witstudios/w',
    });
  });

  test('help', () => {
    assert({
      given: '--help',
      should: 'ask for the usage text',
      actual: parseCli(['--help'], noGh),
      expected: { help: true },
    });
  });

  test('errors', () => {
    const isError = (argv: string[]) => 'error' in parseCli(argv, noGh);
    assert({
      given:
        'a bad command, a missing dir, extra args, a bad slug, the placeholder slug, a bad display, a bad repo, an unknown flag and both visibilities',
      should: 'return an error for each',
      actual: [
        isError(['make', 'out', '--name', 'w']),
        isError(['new', '--name', 'w']),
        isError(['new', 'a', 'b', '--name', 'w']),
        isError(['new', 'out', '--name', 'Bad']),
        isError(['new', 'out', '--name', 'acme']),
        isError(['new', 'out', '--name', 'w', '--display', 'a"b']),
        isError(['new', 'out', '--name', 'w', '--repo', 'nope']),
        isError(['new', 'out', '--name', 'w', '--frobnicate']),
        isError(['new', 'out', '--name', 'w', '--public', '--private']),
      ],
      expected: [true, true, true, true, true, true, true, true, true],
    });
  });
});

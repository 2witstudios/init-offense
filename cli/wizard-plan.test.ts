import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { slugProblem } from './rename';
import {
  dockerState,
  installPlan,
  neededTools,
  shown,
  suggestSlug,
  type Host,
  type Tool,
} from './wizard-plan';

setupRitewayBun();

describe('suggestSlug', () => {
  const cases: [string, string][] = [
    ['Widget App', 'widget-app'],
    ['  Bob’s Bakery & Café!  ', 'bob-s-bakery-caf'],
    ['3D Printer Hub', 'app-3d-printer-hub'],
    ['Acme Rockets', 'rockets'],
    [
      'Northwind Logistics Portal for Everyone',
      'northwind-logistics-portal-for',
    ],
    ['!!!', 'my-app'],
  ];
  for (const [display, slug] of cases)
    test(display, () => {
      assert({
        given: `the display name "${display}"`,
        should: `suggest "${slug}", a slug cli/args accepts`,
        actual: [suggestSlug(display), slugProblem(suggestSlug(display))],
        expected: [slug, null],
      });
    });
});

describe('neededTools', () => {
  test('choices', () => {
    const tools = (github: boolean, drive: boolean, run: boolean) =>
      neededTools({ github, drive, run }).map((need) => need.tool);
    assert({
      given: 'every choice on, then every choice off',
      should:
        'need git always, docker to run, gh for GitHub, pagespace for the drive',
      actual: [tools(true, true, true), tools(false, false, false)],
      expected: [['git', 'docker', 'gh', 'pagespace'], ['git']],
    });
  });
});

describe('installPlan', () => {
  const host = (platform: string, extra: Partial<Host> = {}): Host => ({
    platform,
    hasBrew: false,
    packageManager: null,
    ...extra,
  });
  const summary = (tool: Tool, on: Host) => {
    const plan = installPlan(tool, on);
    return plan.kind === 'commands'
      ? plan.commands.map(shown).join(' && ')
      : `manual: ${plan.lines[0]}`;
  };
  const table: [Tool, Host, string][] = [
    ['gh', host('darwin', { hasBrew: true }), 'brew install gh'],
    [
      'docker',
      host('darwin', { hasBrew: true }),
      'brew install --cask orbstack',
    ],
    ['git', host('darwin'), 'xcode-select --install'],
    [
      'gh',
      host('darwin'),
      'manual: Install GitHub CLI (gh) from https://cli.github.com, then come back here.',
    ],
    [
      'gh',
      host('linux', { packageManager: 'apt' }),
      'sudo apt-get install -y gh',
    ],
    [
      'git',
      host('linux', { packageManager: 'dnf' }),
      'sudo dnf install -y git',
    ],
    [
      'docker',
      host('linux'),
      "sh -c 'curl -fsSL https://get.docker.com | sudo sh'",
    ],
    [
      'gh',
      host('win32'),
      'manual: On Windows this template runs inside WSL (a Linux environment built into Windows).',
    ],
    ['pagespace', host('win32'), 'bun add -g @pagespace/cli'],
    ['pagespace', host('linux'), 'bun add -g @pagespace/cli'],
  ];
  for (const [tool, on, expected] of table)
    test(`${tool} on ${on.platform}${on.hasBrew ? ' with brew' : ''}${on.packageManager ? ` with ${on.packageManager}` : ''}`, () => {
      assert({
        given: `${tool} missing on ${on.platform}`,
        should: 'plan the platform-appropriate install',
        actual: summary(tool, on),
        expected,
      });
    });
});

describe('dockerState', () => {
  test('docker', () => {
    assert({
      given: 'installed/info combinations',
      should: 'only call Docker running when docker info works',
      actual: [
        dockerState(false, false),
        dockerState(true, false),
        dockerState(true, true),
      ],
      expected: ['missing', 'stopped', 'running'],
    });
  });
});

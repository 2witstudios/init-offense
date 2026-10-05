import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { formatResults, parseVerifyArgs, STAGES } from './verify-generated';

setupRitewayBun();

describe('parseVerifyArgs', () => {
  test('defaults to every check stage but policy', () => {
    assert({
      given: 'only a slug',
      should:
        'title-case the display name, generate under the scratch dir and run all stages',
      actual: parseVerifyArgs(['widget-app'], '/scratch'),
      expected: {
        slug: 'widget-app',
        display: 'Widget App',
        dir: '/scratch/gen-widget-app',
        stages: [...STAGES],
        keepGoing: false,
      },
    });
  });

  test('takes a display name, a directory and a stage subset', () => {
    assert({
      given: '--display, --dir, --stages and --keep-going',
      should: 'use them as given',
      actual: parseVerifyArgs(
        [
          'zed',
          '--display',
          'Zed',
          '--dir',
          '/elsewhere/zed',
          '--stages',
          'lint, test',
          '--keep-going',
        ],
        '/scratch',
      ),
      expected: {
        slug: 'zed',
        display: 'Zed',
        dir: '/elsewhere/zed',
        stages: ['lint', 'test'],
        keepGoing: true,
      },
    });
  });

  test('refuses a missing slug and unknown stages', () => {
    assert({
      given: 'no slug, then a policy stage',
      should: 'return an error for each (policy needs a GitHub remote)',
      actual: [
        'error' in parseVerifyArgs([]),
        parseVerifyArgs(['zed', '--stages', 'policy']),
      ],
      expected: [true, { error: 'Unknown stage(s): policy' }],
    });
  });
});

describe('formatResults', () => {
  test('renders a Markdown table', () => {
    assert({
      given: 'stage results',
      should: 'render one row per stage under the slug',
      actual: formatResults('zed', [
        { stage: 'lint', status: 'pass' },
        { stage: 'test', status: 'FAIL' },
      ]),
      expected:
        '| zed | result |\n| --- | --- |\n| lint | pass |\n| test | FAIL |',
    });
  });
});

import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  defaultDisplay,
  displayProblem,
  isBinary,
  nameForms,
  renamePath,
  renameText,
  slugProblem,
} from './rename';
import { slotNaming } from '../scripts/slot-naming';

setupRitewayBun();

const names = {
  slug: 'widget-app',
  display: 'Widget App',
  repo: 'someone/widgets',
  templateRepo: '2witstudios/acme',
};

describe('slug and display validation', () => {
  test('accepts kebab slugs and refuses the placeholder', () => {
    assert({
      given: 'valid and invalid slugs',
      should: 'accept only lowercase kebab slugs without the placeholder',
      actual: [
        'widget-app',
        'w2',
        'Widget',
        '2w',
        'acme',
        'my-acme',
        'a--b',
        'ab-',
        '',
      ].map((slug) => slugProblem(slug) === null),
      expected: [true, true, false, false, false, false, false, false, false],
    });
  });

  test('the longest accepted slug still leaves room for worktree slots', () => {
    const longest = `w${'-x'.repeat(14)}y`;
    assert({
      given: 'a 30-character slug and a 31-character one',
      should:
        'accept the first, whose slot ids fit Postgres and REDIS_NAMESPACE, and refuse the second',
      actual: {
        length: longest.length,
        accepted: slugProblem(longest) === null,
        roomForIds: slotNaming(longest).maxIdLength > 8,
        refused: slugProblem(`${longest}z`) !== null,
      },
      expected: { length: 30, accepted: true, roomForIds: true, refused: true },
    });
  });

  test('display names stay safe inside quoted strings', () => {
    assert({
      given: 'display names with and without quote characters',
      should: 'refuse quotes, backticks and angle brackets',
      actual: ['Widget App', 'R&D Co.', "Bob's", 'a"b', '<b>', 'Acme Two'].map(
        (display) => displayProblem(display) === null,
      ),
      expected: [true, true, false, false, false, false],
    });
  });

  test('default display', () => {
    assert({
      given: 'a kebab slug',
      should: 'title-case its words',
      actual: defaultDisplay('widget-app'),
      expected: 'Widget App',
    });
  });
});

describe('nameForms', () => {
  test('derives every case form from the slug', () => {
    assert({
      given: 'the slug widget-app',
      should: 'derive kebab, snake, camel, Pascal and SCREAMING forms',
      actual: nameForms(names),
      expected: {
        kebab: 'widget-app',
        snake: 'widget_app',
        camel: 'widgetApp',
        pascal: 'WidgetApp',
        screaming: 'WIDGET_APP',
        display: 'Widget App',
      },
    });
  });
});

const cases: readonly (readonly [string, string, string])[] = [
  [
    'a workspace package',
    `import { x } from '@acme/web';`,
    `import { x } from '@widget-app/web';`,
  ],
  ['a subpath import', `'@acme/redis/testing'`, `'@widget-app/redis/testing'`],
  ['a Postgres role', 'grant acme_web to u', 'grant widget_app_web to u'],
  ['an env var', 'ACME_E2E_LOCK_DIR=/tmp', 'WIDGET_APP_E2E_LOCK_DIR=/tmp'],
  [
    'a component identifier',
    '<AcmeMark size={2} />',
    '<WidgetAppMark size={2} />',
  ],
  [
    'a kebab directory',
    'src/components/acme-mark/index.ts',
    'src/components/widget-app-mark/index.ts',
  ],
  [
    'a header',
    `headers.get('x-acme-client-ip')`,
    `headers.get('x-widget-app-client-ip')`,
  ],
  [
    'a test database URL',
    'postgres://u:p@localhost:5432/acme_test',
    'postgres://u:p@localhost:5432/widget_app_test',
  ],
  [
    'a bare database URL',
    'postgres://acme:pw@localhost:15432/acme',
    'postgres://widget_app:pw@localhost:15432/widget_app',
  ],
  ['a compose role', 'POSTGRES_USER: acme', 'POSTGRES_USER: widget_app'],
  [
    'pg_isready flags',
    `pg_isready -U acme -d acme_test`,
    `pg_isready -U widget_app -d widget_app_test`,
  ],
  ['SQL drop database', 'drop database acme;', 'drop database widget_app;'],
  [
    'the template repo',
    'repos/2witstudios/acme/rulesets',
    'repos/someone/widgets/rulesets',
  ],
  [
    'a JSON display name',
    `"displayName": "Acme"`,
    `"displayName": "Widget App"`,
  ],
  [
    'UI copy',
    `{ name: 'Sign in to Acme' }`,
    `{ name: 'Sign in to Widget App' }`,
  ],
  ['a title template', `template: '%s · Acme'`, `template: '%s · Widget App'`],
  [
    'a possessive',
    "through Acme's own route",
    "through Widget App's own route",
  ],
  ['a hyphenated prose word', 'an Acme-owned row', 'an Widget App-owned row'],
  ['end of sentence', 'built for Acme.', 'built for Widget App.'],
  [
    'a mixed-case email',
    'Player@Acme.example.com',
    'Player@Widget-app.example.com',
  ],
  [
    'a mixed-case host',
    'https://www.Acme.dev/x',
    'https://www.Widget-app.dev/x',
  ],
  ['a camelCase property', 'holder.acmeWebApp', 'holder.widgetAppWebApp'],
  [
    'a dunder global',
    'window.__acmeRealtimeHarness',
    'window.__widgetAppRealtimeHarness',
  ],
  ['an embedded Pascal', 'isAcmeDbRefusal()', 'isWidgetAppDbRefusal()'],
  [
    'a fly app',
    'fly deploy -a acme-staging',
    'fly deploy -a widget-app-staging',
  ],
  ['a redis namespace default', `.default('acme')`, `.default('widget-app')`],
  [
    'a cookie name',
    '__Secure-acme.session_token',
    '__Secure-widget-app.session_token',
  ],
  ['a screaming word', 'ACME', 'WIDGET_APP'],
];

describe('renameText', () => {
  for (const [given, input, expected] of cases) {
    test(given, () => {
      assert({
        given: `${given}: ${input}`,
        should: `rename to ${expected}`,
        actual: renameText(input, names),
        expected,
      });
    });
  }

  test('single-word slug collapses every form to the same word', () => {
    assert({
      given: 'the slug widget',
      should: 'use widget, Widget and WIDGET',
      actual: renameText('@acme/web acme_web AcmeMark ACME_X "Acme"', {
        slug: 'widget',
        display: 'Widget',
      }),
      expected: '@widget/web widget_web WidgetMark WIDGET_X "Widget"',
    });
  });

  test('without a repo the template repo is renamed mechanically', () => {
    assert({
      given: 'no --repo',
      should: 'rename the placeholder inside the repo string',
      actual: renameText('2witstudios/acme', {
        slug: 'widget-app',
        display: 'W',
      }),
      expected: '2witstudios/widget-app',
    });
  });
});

describe('renamePath', () => {
  test('renames every segment in identifier form', () => {
    assert({
      given: 'paths with the placeholder in directories and file names',
      should: 'use kebab, snake and Pascal forms, never the display name',
      actual: [
        'apps/web/src/components/acme-mark/AcmeMark.tsx',
        'docs/acme_notes.md',
        'plain/path.ts',
      ].map((path) => renamePath(path, names)),
      expected: [
        'apps/web/src/components/widget-app-mark/WidgetAppMark.tsx',
        'docs/widget_app_notes.md',
        'plain/path.ts',
      ],
    });
  });
});

describe('isBinary', () => {
  test('detects NUL bytes', () => {
    assert({
      given: 'text and binary buffers',
      should: 'flag only the one containing a NUL byte',
      actual: [
        isBinary(new TextEncoder().encode('acme')),
        isBinary(new Uint8Array([137, 80, 0, 1])),
      ],
      expected: [false, true],
    });
  });
});

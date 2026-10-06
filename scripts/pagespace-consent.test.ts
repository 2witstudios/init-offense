import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { consentFilter, isConsentLine } from './pagespace-consent';

setupRitewayBun();

// stderr of `pagespace keys create --all-drives --name app-setup --show-token
// --yes`, as @pagespace/cli prints it around a mint.
const OPENING =
  'Opening your browser to approve access for key "app-setup" on https://pagespace.ai...';
const NO_BROWSER = [
  'Could not open a browser automatically. Open this URL to continue:',
  'https://pagespace.ai/oauth/authorize?client_id=cli&state=abc',
];
const AFTER_MINT = [
  'Created key "app-setup" on https://pagespace.ai, scoped to: all drives.',
  '',
  'Credential: access key "app-setup"',
  "This token is shown once and never again. Anyone holding it gets this key's access.",
  'A key is a named credential in your OS keychain — agents on this machine reference it by name, never a raw token.',
  'Add this to your MCP client config (Claude Code, Claude Desktop, Cursor):',
  '      "PAGESPACE_API_URL": "https://pagespace.example"',
  'Installed globally and on your MCP client\'s PATH? "command": "pagespace", "args": ["mcp"] does the same thing.',
  'PAGESPACE_TOKEN=mcp_...   (shown once, at mint time only)',
  'Run "pagespace keys describe --key=app-setup" at any time to see this key\'s drives, role and effective permissions.',
];

const filtered = (chunks: readonly string[], code: number): string[] => {
  const shown: string[] = [];
  const filter = consentFilter((line) => shown.push(line));
  chunks.forEach(filter.push);
  filter.end(code);
  return shown;
};

describe('consentFilter', () => {
  test('a successful mint', () => {
    assert({
      given: 'the consent lines, then the post-mint summary and MCP tips',
      should: 'forward only the consent lines',
      actual: filtered(
        [[OPENING, ...NO_BROWSER, ...AFTER_MINT].join('\n') + '\n'],
        0,
      ),
      expected: [OPENING, ...NO_BROWSER],
    });
  });

  test('lines split across chunks', () => {
    const text = [OPENING, ...NO_BROWSER].join('\n');
    assert({
      given: 'stderr arriving in arbitrary pieces without a final newline',
      should: 'forward whole lines only',
      actual: filtered(
        [text.slice(0, 20), text.slice(20, 90), text.slice(90)],
        0,
      ),
      expected: [OPENING, ...NO_BROWSER],
    });
  });

  test('a failed mint', () => {
    assert({
      given: 'a failure the CLI reports after consent',
      should: 'show the failure reason as it arrives',
      actual: filtered(
        [`${OPENING}\nTimed out waiting for approval. Run "x" again.\n`],
        1,
      ),
      expected: [OPENING, 'Timed out waiting for approval. Run "x" again.'],
    });
    assert({
      given: 'a non-zero exit with lines that were held back',
      should: 'show the held lines too, so the reason is not lost',
      actual: filtered(['A stored credential already exists.\n'], 1),
      expected: ['A stored credential already exists.'],
    });
  });

  test('never a token', () => {
    assert({
      given: 'a token-shaped line, even on failure',
      should: 'never forward it',
      actual: [
        isConsentLine('error: PAGESPACE_TOKEN=mcp_abcdefghijklmnopqrstu'),
        filtered(['PAGESPACE_TOKEN=mcp_abcdefghijklmnopqrstu\n'], 1),
      ],
      expected: [false, []],
    });
  });
});

import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  PAGE_FIXTURE_TIMEOUT_MS,
  PAGE_START_LIMIT_MS,
  STEP_LIMIT_MS,
} from '../apps/web/e2e/support/bounded-step';

setupRitewayBun();

// The browser suite's step budgets (docs/development/testing.md, "Page
// creation and stall evidence"): only the test's own page, which includes a
// cold start, gets more than an ordinary step, and never a retry.
const STALL_CAPTURE_MS = 3_000;

describe('e2e step limits', () => {
  test('budgets', () => {
    assert({
      given: 'the bounded-step budgets',
      should:
        'keep 15 s for ordinary steps and give the cold-start page open 30 s',
      actual: { step: STEP_LIMIT_MS, pageStart: PAGE_START_LIMIT_MS },
      expected: { step: 15_000, pageStart: 30_000 },
    });
  });

  test('the page fixture fails by name', () => {
    assert({
      given: 'a page open that uses its whole budget',
      should:
        'leave its fixture time for the stall evidence, so it fails by name rather than at a bare timeout',
      actual: PAGE_FIXTURE_TIMEOUT_MS - PAGE_START_LIMIT_MS > STALL_CAPTURE_MS,
      expected: true,
    });
  });
});

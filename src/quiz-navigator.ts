import { Locator, Page } from '@playwright/test';

/**
 * Generic, shape-agnostic walker for the registration quiz.
 *
 * It does NOT know the quiz's steps, order, copy, or A/B variant — it only knows
 * a small set of interaction patterns that are expected to hold across variants
 * (an option to pick, a primary CTA to press, a text field to fill). This is the
 * layer that is meant to survive quiz redesigns without being rewritten; see
 * README "Known limitations" for where that assumption breaks down.
 */

export interface StepLog {
  index: number;
  url: string;
  strategy: string;
}

export interface WalkOptions {
  maxSteps?: number;
  actionTimeoutMs?: number;
  testEmail?: string;
  isDone?: (page: Page) => Promise<boolean>;
  onStep?: (log: StepLog) => void;
}

const PROBE_TIMEOUT_MS = 800;
const DEFAULT_MAX_STEPS = 25;
const DEFAULT_ACTION_TIMEOUT_MS = 5000;
const DEFAULT_TEST_EMAIL = `qa-automation+${Date.now()}@allright-test.example`;

const CLICK_STRATEGIES: { name: string; locate: (page: Page) => Locator }[] = [
  {
    name: 'testid-option',
    locate: (page) => page.locator('[data-testid$="-option"], [data-testid="quiz-option"]').first(),
  },
  {
    name: 'testid-next',
    locate: (page) =>
      page
        .locator(
          '[data-testid$="-next"], [data-testid="quiz-next"], [data-testid="quiz-cta"], [data-testid="quiz-submit"]'
        )
        .first(),
  },
  { name: 'role-radio', locate: (page) => page.getByRole('radio').first() },
  { name: 'role-checkbox', locate: (page) => page.getByRole('checkbox').first() },
  {
    name: 'role-primary-button',
    locate: (page) =>
      page
        .getByRole('button', { name: /продовж|далі|next|continue|готово|завершити|submit/i })
        .first(),
  },
  {
    name: 'any-visible-button-in-main',
    locate: (page) => page.locator('main button:visible, [role="main"] button:visible, button:visible').first(),
  },
];

/**
 * Walks the quiz from whatever page it's currently on until `isDone` reports
 * true or no known interaction pattern matches. Throws with a diagnostic
 * message (not a generic timeout) when it gets stuck — that failure is itself
 * a useful signal that the quiz changed shape beyond known patterns.
 */
export async function walkQuizToCompletion(page: Page, options: WalkOptions = {}): Promise<StepLog[]> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const testEmail = options.testEmail ?? DEFAULT_TEST_EMAIL;
  const history: StepLog[] = [];

  for (let index = 0; index < maxSteps; index += 1) {
    if (options.isDone && (await options.isDone(page))) {
      return history;
    }

    if (await tryFillTextInput(page, testEmail)) {
      history.push({ index, url: page.url(), strategy: 'fill-text-input' });
      options.onStep?.(history[history.length - 1]);
      continue; // re-probe next iteration: a submit control may now be enabled
    }

    const match = await findFirstAvailableStrategy(page);
    if (!match) {
      throw new Error(
        `Quiz navigator stuck at step ${index} (url=${page.url()}) — no known action pattern matched.\n` +
          `The quiz likely changed shape beyond the navigator's known selector strategies. ` +
          `See README "Known limitations" and consider adding a strategy rather than a one-off fix.`
      );
    }

    await match.locator.click({ timeout: actionTimeoutMs });
    history.push({ index, url: page.url(), strategy: match.name });
    options.onStep?.(history[history.length - 1]);
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  }

  throw new Error(
    `Quiz navigator exceeded maxSteps=${maxSteps} without reaching completion (last url=${page.url()}). ` +
      `Either the completion signal never fired or the quiz has more steps than expected.`
  );
}

async function findFirstAvailableStrategy(page: Page): Promise<{ name: string; locator: Locator } | null> {
  for (const strategy of CLICK_STRATEGIES) {
    const locator = strategy.locate(page);
    try {
      await locator.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
      return { name: strategy.name, locator };
    } catch {
      continue;
    }
  }
  return null;
}

async function tryFillTextInput(page: Page, testEmail: string): Promise<boolean> {
  const input = page.locator('main input:visible, [role="main"] input:visible, input:visible').first();
  try {
    await input.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
  } catch {
    return false;
  }

  const currentValue = await input.inputValue().catch(() => '');
  if (currentValue.length > 0) {
    return false; // already filled by a previous step; let click strategies take over
  }

  const inputType = (await input.getAttribute('type')) ?? 'text';
  await input.fill(pickSyntheticValue(inputType, testEmail));
  await input.press('Enter').catch(() => undefined);
  return true;
}

function pickSyntheticValue(inputType: string, testEmail: string): string {
  switch (inputType) {
    case 'email':
      return testEmail;
    case 'tel':
      return '+380000000000';
    case 'number':
      return '8';
    default:
      return 'QA Automation';
  }
}

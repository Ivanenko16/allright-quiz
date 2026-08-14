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
  /** Non-fatal issues (a retried action, a swallowed wait failure) — surfaced instead of silently ignored. */
  onWarning?: (message: string) => void;
}

const PROBE_TIMEOUT_MS = 800;
const OVERLAY_PROBE_TIMEOUT_MS = 500;
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
 * Known consent/promo overlay dismiss buttons. This list is inherently
 * incomplete (see README "Known limitations") — it exists so a cookie banner
 * or promo modal doesn't get mistaken for "the navigator is stuck," which was
 * a real blind spot in the first version of this file.
 */
const OVERLAY_DISMISS_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '[data-testid="cookie-accept"]',
  '[data-testid="consent-accept"]',
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
  const warn = options.onWarning ?? (() => undefined);
  const history: StepLog[] = [];

  // Cookie/consent banners overwhelmingly appear once, on load — pay this
  // cost up front rather than probing for it on every single step.
  await dismissKnownOverlays(page);

  for (let index = 0; index < maxSteps; index += 1) {
    if (options.isDone && (await options.isDone(page))) {
      return history;
    }

    if (await tryFillTextInput(page, testEmail, warn)) {
      history.push({ index, url: page.url(), strategy: 'fill-text-input' });
      options.onStep?.(history[history.length - 1]);
      continue; // re-probe next iteration: a submit control may now be enabled
    }

    let match = await findFirstAvailableStrategy(page);
    if (!match && (await dismissKnownOverlays(page))) {
      // Something (promo modal, secondary consent prompt) was blocking the
      // known patterns; now that it's dismissed, probe once more before
      // declaring the navigator stuck.
      warn(`step ${index}: dismissed an overlay that was blocking known action patterns, re-probing`);
      match = await findFirstAvailableStrategy(page);
    }
    if (!match) {
      throw new Error(
        `Quiz navigator stuck at step ${index} (url=${page.url()}) — no known action pattern matched.\n` +
          `The quiz likely changed shape beyond the navigator's known selector strategies. ` +
          `See README "Known limitations" and consider adding a strategy rather than a one-off fix.`
      );
    }

    try {
      await match.locator.click({ timeout: actionTimeoutMs });
    } catch (err) {
      if (!(await dismissKnownOverlays(page))) throw err;
      warn(`step ${index}: click was blocked, dismissed an overlay and retried once`);
      await match.locator.click({ timeout: actionTimeoutMs });
    }

    history.push({ index, url: page.url(), strategy: match.name });
    options.onStep?.(history[history.length - 1]);
    await page
      .waitForLoadState('domcontentloaded', { timeout: actionTimeoutMs })
      .catch((err) => warn(`step ${index}: waitForLoadState after click did not settle cleanly (${String(err)})`));
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

async function tryFillTextInput(page: Page, testEmail: string, warn: (message: string) => void): Promise<boolean> {
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
  await input.press('Enter').catch((err) => warn(`fill-text-input: pressing Enter after fill failed (${String(err)})`));
  return true;
}

/**
 * Best-effort dismissal of known consent/promo overlays. Returns whether it
 * dismissed something, so callers can decide whether re-probing is worth it.
 * Deliberately best-effort, not exhaustive — see README "Known limitations".
 */
async function dismissKnownOverlays(page: Page): Promise<boolean> {
  for (const selector of OVERLAY_DISMISS_SELECTORS) {
    if (await tryClick(page.locator(selector).first())) return true;
  }

  const genericConsentButton = page
    .locator('[role="dialog"], [class*="cookie" i], [id*="cookie" i], [id*="consent" i]')
    .getByRole('button', { name: /accept|allow|ok|дозволити|прийняти|погодж/i })
    .first();
  return tryClick(genericConsentButton);
}

async function tryClick(locator: Locator): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: OVERLAY_PROBE_TIMEOUT_MS });
    await locator.click({ timeout: OVERLAY_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

export function pickSyntheticValue(inputType: string, testEmail: string): string {
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

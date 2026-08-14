import { test, expect } from '@playwright/test';
import { walkQuizToCompletion } from '../src/quiz-navigator';
import { waitForCompletionSignal } from '../src/outcome-verifier';

/**
 * This test has real side effects on the target environment: it creates an
 * account and books a trial lesson. It is intentionally NOT part of the
 * default fast PR suite — see README "CI/CD" for where it's meant to run.
 */

const QUIZ_START_URL =
  process.env.QUIZ_START_URL ?? 'https://stage.allright.com/uk/app/sign-up/long/charlie/age-range';

const COMPLETION_NETWORK_PATTERN = new RegExp(
  process.env.QUIZ_COMPLETION_NETWORK_PATTERN ?? '/(sign-?up|registration|users|bookings?)\\b',
  'i'
);
const COMPLETION_URL_PATTERN = new RegExp(
  process.env.QUIZ_COMPLETION_URL_PATTERN ?? '/(welcome|thank-you|dashboard)\\b',
  'i'
);
const COMPLETION_TEST_ID = process.env.QUIZ_COMPLETION_TEST_ID ?? 'signup-success';
const REQUIRED_RESPONSE_KEYS = (process.env.QUIZ_REQUIRED_RESPONSE_KEYS ?? 'userId,lessonId')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);

test.describe('@live-side-effects registration quiz — business outcome', () => {
  test('completing the quiz creates an account and books a trial lesson', async ({ page }) => {
    const testEmail = `qa-automation+${Date.now()}@allright-test.example`;

    await page.goto(QUIZ_START_URL);

    // Arm the completion listener before walking — the response can fire on
    // the very last click, and Playwright only observes responses to
    // requests made after the listener is registered.
    const completionSignal = waitForCompletionSignal({
      page,
      networkPattern: COMPLETION_NETWORK_PATTERN,
      successUrlPattern: COMPLETION_URL_PATTERN,
      successTestId: COMPLETION_TEST_ID,
      requiredResponseKeys: REQUIRED_RESPONSE_KEYS,
      timeoutMs: 60_000,
    });

    const steps = await walkQuizToCompletion(page, {
      testEmail,
      onStep: (step) =>
        test.info().annotations.push({
          type: 'quiz-step',
          description: `#${step.index} [${step.strategy}] ${step.url}`,
        }),
    });

    const signal = await completionSignal;
    test.info().annotations.push({ type: 'completion-signal', description: `${signal.source}: ${signal.detail}` });

    expect(steps.length, 'navigator should have taken at least one step through the quiz').toBeGreaterThan(0);
    expect(['network', 'url', 'app-state']).toContain(signal.source);
  });
});

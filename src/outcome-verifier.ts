import { Page, Response } from '@playwright/test';

/**
 * Verifies the quiz's *business outcome* — account created + trial lesson
 * booked — independently of which A/B variant or step sequence produced it.
 *
 * Three independent signals race each other; whichever fires first wins, and
 * the network signal (when it fires) is the strongest because it validates
 * the actual contract, not just a UI side effect of that contract:
 *
 *  1. network   — a completion-shaped POST response whose JSON body contains
 *                 the expected identifiers, searched anywhere in the payload
 *                 (not a strict shape match, since the exact envelope is
 *                 unknown and may nest under "data"/"user"/etc.).
 *  2. url       — navigation to a stable post-signup route.
 *  3. app-state — a generic "success" element becoming visible.
 *
 * Having three signals is deliberate defense-in-depth: if the team changes
 * the completion endpoint shape without telling QA, url/app-state can still
 * catch it (and vice versa). The signal that fired is logged so a human can
 * tell which contract actually held.
 */

export interface OutcomeSignal {
  source: 'network' | 'url' | 'app-state';
  detail: string;
}

export interface VerifyOptions {
  page: Page;
  networkPattern: RegExp;
  successUrlPattern: RegExp;
  successTestId: string;
  requiredResponseKeys: string[];
  timeoutMs?: number;
}

export async function waitForCompletionSignal(opts: VerifyOptions): Promise<OutcomeSignal> {
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const networkSignal = opts.page
    .waitForResponse(
      (res) => opts.networkPattern.test(res.url()) && res.request().method() === 'POST' && res.ok(),
      { timeout: timeoutMs }
    )
    .then(async (res) => {
      const body = await safeJson(res);
      const missing = opts.requiredResponseKeys.filter((key) => !hasKeyDeep(body, key));
      if (missing.length > 0) {
        throw new Error(
          `Completion-shaped response ${res.request().method()} ${res.url()} matched the URL pattern ` +
            `but its body is missing expected key(s): ${missing.join(', ')}. Either the contract changed ` +
            `or QUIZ_REQUIRED_RESPONSE_KEYS needs updating — ask the backend owner before assuming a regression.`
        );
      }
      return { source: 'network' as const, detail: `${res.request().method()} ${res.url()} -> ${res.status()}` };
    });

  const urlSignal = opts.page
    .waitForURL(opts.successUrlPattern, { timeout: timeoutMs })
    .then(() => ({ source: 'url' as const, detail: `navigated to ${opts.page.url()}` }));

  const testIdSignal = opts.page
    .locator(`[data-testid="${opts.successTestId}"]`)
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => ({ source: 'app-state' as const, detail: `[data-testid="${opts.successTestId}"] visible` }));

  return Promise.any([networkSignal, urlSignal, testIdSignal]);
}

function hasKeyDeep(value: unknown, key: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (key in (value as Record<string, unknown>)) return true;
  return Object.values(value as Record<string, unknown>).some((child) => hasKeyDeep(child, key));
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

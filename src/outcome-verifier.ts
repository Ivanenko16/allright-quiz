import { Page, Response } from '@playwright/test';

/**
 * Verifies the quiz's *business outcome* — account created + trial lesson
 * booked — independently of which A/B variant or step sequence produced it.
 *
 * Three signals race each other via `Promise.race` (first to *settle* wins,
 * whether by resolving or rejecting):
 *
 *  1. network   — a completion-shaped POST response whose JSON body contains
 *                 the expected identifiers, searched anywhere in the payload
 *                 (not a strict shape match, since the exact envelope is
 *                 unknown and may nest under "data"/"user"/etc.). If such a
 *                 response arrives but is missing the expected keys, that is
 *                 treated as an AUTHORITATIVE failure — it must win the race
 *                 even if the UI has already moved to a "success" state.
 *  2. url       — navigation to a stable post-signup route.
 *  3. app-state — a generic "success" element becoming visible.
 *
 * A signal that simply times out (never fires) does not reject — it resolves
 * to a promise that never settles, so it drops out of the race instead of
 * spuriously winning it or masking a genuine failure from another signal.
 * An earlier version used `Promise.any`, which tolerates rejections from ALL
 * branches equally — that accidentally let a same-time UI "success" state
 * outrace an explicit network contract failure. This version fixes that: a
 * detected contract break always wins, regardless of what the UI is doing.
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

const DEFAULT_TIMEOUT_MS = 60_000;

export async function waitForCompletionSignal(opts: VerifyOptions): Promise<OutcomeSignal> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return Promise.race([
    observeNetworkSignal(opts, timeoutMs),
    observeUrlSignal(opts, timeoutMs),
    observeTestIdSignal(opts, timeoutMs),
    failAfter(
      timeoutMs,
      `No completion signal observed within ${timeoutMs}ms — neither a matching network response, ` +
        `nor the expected URL, nor the expected success element appeared. The quiz likely did not reach completion.`
    ),
  ]);
}

async function observeNetworkSignal(opts: VerifyOptions, timeoutMs: number): Promise<OutcomeSignal> {
  let res: Response;
  try {
    res = await opts.page.waitForResponse(
      (candidate) =>
        opts.networkPattern.test(candidate.url()) && candidate.request().method() === 'POST' && candidate.ok(),
      { timeout: timeoutMs }
    );
  } catch (err) {
    if (isTimeout(err)) return never(); // no matching call observed — not itself a failure, just no signal
    throw err;
  }

  const body = await safeJson(res);
  const missing = opts.requiredResponseKeys.filter((key) => !hasKeyDeep(body, key));
  if (missing.length > 0) {
    throw new Error(
      `Completion-shaped response ${res.request().method()} ${res.url()} matched the URL pattern ` +
        `but its body is missing expected key(s): ${missing.join(', ')}. Either the contract changed ` +
        `or QUIZ_REQUIRED_RESPONSE_KEYS needs updating — confirm with the backend owner before assuming a regression.`
    );
  }
  return { source: 'network', detail: `${res.request().method()} ${res.url()} -> ${res.status()}` };
}

async function observeUrlSignal(opts: VerifyOptions, timeoutMs: number): Promise<OutcomeSignal> {
  try {
    await opts.page.waitForURL(opts.successUrlPattern, { timeout: timeoutMs });
  } catch (err) {
    if (isTimeout(err)) return never();
    throw err;
  }
  return { source: 'url', detail: `navigated to ${opts.page.url()}` };
}

async function observeTestIdSignal(opts: VerifyOptions, timeoutMs: number): Promise<OutcomeSignal> {
  try {
    await opts.page
      .locator(`[data-testid="${opts.successTestId}"]`)
      .waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (err) {
    if (isTimeout(err)) return never();
    throw err;
  }
  return { source: 'app-state', detail: `[data-testid="${opts.successTestId}"] visible` };
}

/** A promise that never settles — drops a merely-timed-out signal out of the race without resolving or rejecting it. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

async function failAfter(ms: number, message: string): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  throw new Error(message);
}

export function hasKeyDeep(value: unknown, key: string): boolean {
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

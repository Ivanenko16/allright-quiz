import { test, expect } from '@playwright/test';
import { hasKeyDeep } from '../../src/outcome-verifier';

// Pure-logic tests — no browser involved, no page fixture requested, so
// Playwright never launches Chromium for this file.

test.describe('hasKeyDeep', () => {
  test('finds a top-level key', () => {
    expect(hasKeyDeep({ userId: '1' }, 'userId')).toBe(true);
  });

  test('finds a key nested under an arbitrary wrapper', () => {
    expect(hasKeyDeep({ data: { user: { userId: '1' } } }, 'userId')).toBe(true);
  });

  test('returns false when the key is absent anywhere in the payload', () => {
    expect(hasKeyDeep({ data: { user: { id: '1' } } }, 'userId')).toBe(false);
  });

  test('searches inside arrays too', () => {
    expect(hasKeyDeep({ bookings: [{ lessonId: 'l1' }] }, 'lessonId')).toBe(true);
  });

  test('does not throw on null, primitives, or empty objects', () => {
    expect(hasKeyDeep(null, 'userId')).toBe(false);
    expect(hasKeyDeep('userId', 'userId')).toBe(false);
    expect(hasKeyDeep(42, 'userId')).toBe(false);
    expect(hasKeyDeep({}, 'userId')).toBe(false);
  });
});

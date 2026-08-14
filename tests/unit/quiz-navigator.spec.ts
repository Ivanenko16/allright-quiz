import { test, expect } from '@playwright/test';
import { pickSyntheticValue } from '../../src/quiz-navigator';

test.describe('pickSyntheticValue', () => {
  test('uses the provided test email for an email input', () => {
    expect(pickSyntheticValue('email', 'qa@example.com')).toBe('qa@example.com');
  });

  test('uses a placeholder phone number for a tel input', () => {
    expect(pickSyntheticValue('tel', 'qa@example.com')).toBe('+380000000000');
  });

  test('uses a numeric placeholder for a number input', () => {
    expect(pickSyntheticValue('number', 'qa@example.com')).toBe('8');
  });

  test('falls back to a generic string for unrecognized input types', () => {
    expect(pickSyntheticValue('text', 'qa@example.com')).toBe('QA Automation');
    expect(pickSyntheticValue('search', 'qa@example.com')).toBe('QA Automation');
  });
});

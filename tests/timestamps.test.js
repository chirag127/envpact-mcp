/**
 * timestamps.js — UTC + IST dual-render helper. SHARED_SPEC §1.5.
 *
 * IST is computed without depending on the host's TZ data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatTimestamp, newerSide } = await import('../src/lib/timestamps.js');

test('formatTimestamp returns canonical UTC and IST', () => {
  const r = formatTimestamp('2026-06-19T07:30:00.000Z');
  assert.equal(r.utc, '2026-06-19T07:30:00.000Z');
  // 07:30 UTC + 5h30m = 13:00 IST same day.
  assert.equal(r.ist, '2026-06-19 13:00:00 IST');
});

test('formatTimestamp crosses midnight when converting to IST', () => {
  // 20:00 UTC + 5h30m = 01:30 IST next day.
  const r = formatTimestamp('2026-06-19T20:00:00.000Z');
  assert.equal(r.ist, '2026-06-20 01:30:00 IST');
});

test('formatTimestamp handles seconds and millis correctly', () => {
  const r = formatTimestamp('2026-01-01T00:00:45.123Z');
  // 00:00:45 UTC + 5h30m = 05:30:45 IST.
  assert.equal(r.ist, '2026-01-01 05:30:45 IST');
});

test('formatTimestamp returns ist=null on invalid date but keeps the original utc', () => {
  const r = formatTimestamp('not a date');
  assert.equal(r.utc, 'not a date');
  assert.equal(r.ist, null);
});

test('formatTimestamp throws on non-string input', () => {
  assert.throws(() => formatTimestamp(undefined), TypeError);
  assert.throws(() => formatTimestamp(null), TypeError);
  assert.throws(() => formatTimestamp(''), TypeError);
});

test('formatTimestamp does NOT depend on host local timezone', () => {
  // We can't change Node's TZ at runtime here, but we can confirm
  // that the Asia/Kolkata math is purely additive: pick a UTC
  // string and assert the IST is exactly +5:30. If the impl ever
  // reads from process.env.TZ this test would still pass on the
  // CI runner — but it locks the contract for code review.
  const r = formatTimestamp('2026-06-19T00:00:00.000Z');
  assert.equal(r.ist, '2026-06-19 05:30:00 IST');
});

test('newerSide picks the strictly newer ISO', () => {
  const a = '2026-06-19T07:30:00.000Z';
  const b = '2026-06-19T07:35:00.000Z';
  assert.equal(newerSide(a, b), 'b');
  assert.equal(newerSide(b, a), 'a');
});

test('newerSide returns tie when equal', () => {
  const t = '2026-06-19T07:30:00.000Z';
  assert.equal(newerSide(t, t), 'tie');
});

test('newerSide treats null/undefined as missing (loses to a present timestamp)', () => {
  const t = '2026-06-19T07:30:00.000Z';
  assert.equal(newerSide(t, null), 'a');
  assert.equal(newerSide(null, t), 'b');
  assert.equal(newerSide(t, undefined), 'a');
  assert.equal(newerSide(undefined, undefined), 'tie');
});

test('newerSide is robust to malformed strings', () => {
  const t = '2026-06-19T07:30:00.000Z';
  // garbage parses to NaN → counts as missing.
  assert.equal(newerSide(t, 'garbage'), 'a');
  assert.equal(newerSide('also-garbage', 'still-garbage'), 'tie');
});

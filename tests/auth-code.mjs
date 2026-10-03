import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAuthCode } from '../src/auth-code.mjs';

function withSamples(samples, check) {
  const original = crypto.getRandomValues;
  let draws = 0;
  crypto.getRandomValues = array => {
    assert.ok(array instanceof Uint32Array);
    assert.equal(array.length, 1);
    assert.ok(draws < samples.length, 'Unexpected additional random draw');
    array[0] = samples[draws++];
    return array;
  };
  try { check(() => draws); } finally { crypto.getRandomValues = original; }
}

test('auth code: incomplete uint32 interval is rejected before reducing to six digits', () => {
  withSamples([4_294_000_000, 0xffffffff, 4_294_123_456, 123_456], draws => {
    assert.equal(generateAuthCode(), '123456');
    assert.equal(draws(), 4);
  });
});

test('auth code: accepted interval boundaries preserve all six digits and leading zeroes', () => {
  withSamples([0, 9, 999_999, 1_000_000, 4_293_999_999], draws => {
    assert.deepEqual(Array.from({ length: 5 }, () => generateAuthCode()),
      ['000000', '000009', '999999', '000000', '999999']);
    assert.equal(draws(), 5);
  });
});

test('auth code: equal residues across accepted blocks have equal output', () => {
  const offsets = [0, 1, 42, 999_999];
  const blocks = [0, 1, 2147, 4293];
  withSamples(offsets.flatMap(offset => blocks.map(block => block * 1_000_000 + offset)), () => {
    for (const offset of offsets)
      assert.deepEqual(blocks.map(() => generateAuthCode()), blocks.map(() => String(offset).padStart(6, '0')));
  });
});

test('auth code: real Web Crypto produces six decimal digits', () => {
  assert.match(generateAuthCode(), /^\d{6}$/);
});

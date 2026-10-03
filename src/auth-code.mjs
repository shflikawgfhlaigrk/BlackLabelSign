const CODE_COUNT = 1_000_000;
// The largest multiple of CODE_COUNT below 2**32. Each accepted code has
// exactly 4,294 possible uint32 inputs; reject the incomplete final interval.
const UNBIASED_LIMIT = 4_294_000_000;

export function generateAuthCode() {
  const sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0] >= UNBIASED_LIMIT);
  return String(sample[0] % CODE_COUNT).padStart(6, '0');
}

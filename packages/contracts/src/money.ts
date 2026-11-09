/** Accept explicit yuan decimal strings only; no floating-point multiplication. */
export function yuanToFen(input: string): number {
  const trimmed=input.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    throw new Error('Enter an explicit nonnegative amount with at most two decimals');
  }
  const [whole='',fraction='']=trimmed.split('.');
  const amount=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if (amount>100_000_000n) throw new Error('Amount exceeds the supported limit');
  return Number(amount);
}

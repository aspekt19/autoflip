const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function vinValue(char: string): number | null {
  if (/[0-9]/.test(char)) return Number(char);
  return TRANSLIT[char] ?? null;
}

export function expectedCheckChar(vin: string): string | null {
  const upper = vin.toUpperCase();
  if (!VIN_RE.test(upper)) return null;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const value = vinValue(upper[i]!);
    if (value === null) return null;
    sum += value * WEIGHTS[i]!;
  }
  const check = sum % 11;
  return check === 10 ? "X" : String(check);
}

export function isValidVin(vin: string): boolean {
  const upper = vin.toUpperCase();
  const expected = expectedCheckChar(upper);
  return expected !== null && upper[8] === expected;
}

/** Pull a valid VIN out of a raw string or a listing URL. Does not fetch the URL. */
export function extractVin(input: string): string | null {
  const upper = input.toUpperCase();
  const matches = upper.match(/[A-HJ-NPR-Z0-9]{17}/g) ?? [];
  for (const candidate of matches) {
    if (isValidVin(candidate)) return candidate;
  }
  return null;
}

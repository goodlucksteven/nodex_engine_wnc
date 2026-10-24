/**
 * Shared USD valuation math for every wallet surface.
 *
 * TokenCare supplies a unit price (price_usd); this module multiplies it by
 * the asset quantity. Engine adapters may return raw integer base units or
 * an already-human-readable decimal string, so only integer strings are
 * converted using decimals. This matches the wallet's balance formatter and
 * avoids dividing normalized values a second time.
 */
export function humanAssetAmount(value: unknown, decimals?: number): number {
  const raw = String(value ?? "0").trim().replace(/,/g, "");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const isRawInteger = /^\d+$/.test(raw);
  return isRawInteger && Number.isInteger(decimals) && decimals! >= 0 && decimals! <= 255
    ? parsed / 10 ** decimals!
    : parsed;
}

export function usdValueFromBalance(
  balance: unknown,
  decimals: number | undefined,
  priceUsd: number | undefined,
): number | undefined {
  if (priceUsd === undefined || !Number.isFinite(priceUsd) || priceUsd < 0) return undefined;
  const amount = humanAssetAmount(balance, decimals);
  const value = amount * priceUsd;
  return Number.isFinite(value) ? value : undefined;
}

export function sumUsdValues(values: Array<number | undefined>): number {
  return values.reduce((total, value) => total + (value !== undefined && Number.isFinite(value) ? value : 0), 0);
}

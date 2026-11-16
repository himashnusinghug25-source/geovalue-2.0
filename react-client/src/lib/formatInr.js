/**
 * Indian Real Estate currency and land area formatting utilities (INR, Lakhs/Crores, Gaj).
 */

export function formatInr(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const formatted = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Math.abs(value));
  return `${sign}${formatted}`;
}

export function formatInrPerGaj(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${formatInr(value)}/Gaj`;
}

export function formatInrLakhCrore(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e7) {
    return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  }
  if (abs >= 1e5) {
    return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  }
  return formatInr(value);
}

export function gajToSqm(gaj) {
  if (typeof gaj !== "number" || Number.isNaN(gaj)) return 0;
  return Number((gaj * 0.836127).toFixed(2));
}

// Shared by send-sms-otp and verify-otp so both match a mobile number to the
// same account. profiles.phone is stored as typed by HR / the bulk importer,
// so live rows include "9876543210", "+91 98765 43210" and "98765 43210".

/** 10-digit Indian mobile (starts 6-9) from any common format, else null. */
export function normalizeIndianMobile(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/** Every stored spelling of a 10-digit mobile we accept as the same number. */
export function mobileVariants(mobile: string): string[] {
  const split = `${mobile.slice(0, 5)} ${mobile.slice(5)}`;
  return [
    mobile, `+91${mobile}`, `91${mobile}`, `0${mobile}`, `+91 ${mobile}`, `+91-${mobile}`,
    split, `+91 ${split}`, `0${split}`,
  ];
}

/** Ids of active profiles using this mobile (at most `limit`). */
export async function activeProfileIdsByMobile(
  // deno-lint-ignore no-explicit-any
  db: any,
  mobile: string,
  limit = 2,
): Promise<string[]> {
  const { data, error } = await db.from("profiles")
    .select("id").in("phone", mobileVariants(mobile)).eq("status", "Active").limit(limit);
  if (error) throw error;
  return (data ?? []).map((r: { id: string }) => r.id);
}

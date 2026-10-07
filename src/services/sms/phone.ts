/**
 * Strict E.164 normalization for sending SMS. Returns null for anything we can't
 * be sure is a real, dialable number (letters, extensions, short codes, bad NANP
 * area/exchange codes, bare non-US numbers without a "+" country code).
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || /[a-z]/i.test(s)) return null; // vanity numbers, "ext. 12", "x12"
  if (!/^[+\d\s().\-/]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  let e164: string;
  if (s.startsWith("+")) e164 = `+${digits}`;
  else if (s.startsWith("00")) e164 = `+${digits.slice(2)}`; // international prefix
  else if (digits.length === 10) e164 = `+1${digits}`; // bare 10-digit: assume North America
  else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else return null;

  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  if (e164.startsWith("+1")) {
    // NANP: +1 NPA NXX XXXX, NPA/NXX start 2-9, NPA not N11 (211, 411, 911…).
    if (e164.length !== 12) return null;
    const npa = e164.slice(2, 5);
    const nxx = e164.slice(5, 8);
    if (!/^[2-9]\d\d$/.test(npa) || /^[2-9]11$/.test(npa)) return null;
    if (!/^[2-9]\d\d$/.test(nxx)) return null;
  }
  return e164;
}

/** Mask a number for logs/UI confirmations: +1512•••0100. */
export function maskPhone(e164: string): string {
  return e164.length > 8 ? `${e164.slice(0, 5)}•••${e164.slice(-4)}` : e164;
}

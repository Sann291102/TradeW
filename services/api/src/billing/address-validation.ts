/**
 * Billing/shipping address validation, applied before anything is saved or
 * sent to Stripe. Stripe Tax needs an address it can place, so the checks are
 * strict where tax depends on them (US ZIP + state, Canada, India) and lenient
 * elsewhere, where postal formats vary too much to encode honestly.
 */

/** ISO 3166-1 alpha-2, officially assigned codes. */
const ISO_COUNTRIES = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO ' +
    'JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR ' +
    'MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO ' +
    'RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV ' +
    'TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
);

const US_STATES = new Set(
  (
    'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA ' +
    'RI SC SD TN TX UT VT VA WA WV WI WY DC AS GU MP PR VI AA AE AP'
  ).split(' '),
);

export interface AddressInput {
  name: string;
  phone?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postalCode: string;
  country: string;
}

export interface NormalizedAddress {
  name: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
}

export class AddressValidationError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super(Object.values(fields).join(' '));
  }
}

function clean(v: string | null | undefined, max: number): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function isIsoCountry(code: string): boolean {
  return ISO_COUNTRIES.has(code);
}

/** Validate and normalise. Throws AddressValidationError with per-field messages. */
export function normalizeAddress(input: AddressInput): NormalizedAddress {
  const errors: Record<string, string> = {};
  const country = clean(input.country, 2).toUpperCase();
  const out: NormalizedAddress = {
    name: clean(input.name, 120),
    phone: clean(input.phone, 20) || null,
    line1: clean(input.line1, 200),
    line2: clean(input.line2, 200) || null,
    city: clean(input.city, 100),
    state: clean(input.state, 100) || null,
    postalCode: clean(input.postalCode, 12).toUpperCase(),
    country,
  };

  if (!out.name) errors.name = 'Contact name is required.';
  if (!out.line1) errors.line1 = 'Address line 1 is required.';
  if (!out.city) errors.city = 'City is required.';
  if (!isIsoCountry(country)) errors.country = 'Country must be a two-letter ISO 3166-1 code, such as US or IN.';
  if (out.phone && !/^\+?[0-9 ()-]{7,20}$/.test(out.phone)) errors.phone = 'Phone must be digits, optionally starting with +.';

  if (country === 'US') {
    if (!out.state || !US_STATES.has(out.state.toUpperCase())) errors.state = 'Use the two-letter US state code, such as CA.';
    else out.state = out.state.toUpperCase();
    if (!/^\d{5}(-\d{4})?$/.test(out.postalCode)) errors.postalCode = 'US ZIP code must be 5 digits (or ZIP+4).';
  } else if (country === 'CA') {
    if (!out.state) errors.state = 'Province is required.';
    if (!/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(out.postalCode)) errors.postalCode = 'Canadian postal code looks like A1A 1A1.';
  } else if (country === 'IN') {
    if (!out.state) errors.state = 'State is required.';
    if (!/^\d{6}$/.test(out.postalCode)) errors.postalCode = 'Indian PIN code must be 6 digits.';
  } else if (out.postalCode && !/^[A-Z0-9][A-Z0-9 -]{1,10}$/.test(out.postalCode)) {
    errors.postalCode = 'Postal code may contain only letters, digits, spaces and dashes.';
  }
  if (!out.postalCode && ['US', 'CA', 'IN', 'GB', 'AU', 'DE', 'FR'].includes(country)) {
    errors.postalCode = errors.postalCode || 'Postal code is required.';
  }

  if (Object.keys(errors).length) throw new AddressValidationError(errors);
  return out;
}

/** One-line summary for emails and logs. */
export function summarizeAddress(a: NormalizedAddress): string {
  return [a.line1, a.line2, a.city, [a.state, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ');
}

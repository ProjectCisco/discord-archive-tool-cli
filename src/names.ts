// OneDrive and SharePoint rules: https://support.microsoft.com/office/64883a5d-228e-48f5-b3d2-eb39e07630fa
const INVALID = /["*:<>?/\\|\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|desktop\.ini|\.lock)$/i;
const MAX_LENGTH = 80;

function cut(text: string, length: number): string {
  return Array.from(text).slice(0, Math.max(length, 1)).join('');
}

function tidy(text: string): string {
  return text.trim().replace(/[. ]+$/, '');
}

function clean(raw: string, maxLength: number): string {
  let name = tidy(raw.normalize('NFC').replace(INVALID, '_').replace(/_vti_/gi, '_vti-'));
  name = tidy(cut(name, maxLength));
  if (name.startsWith('~')) name = `_${name.slice(1)}`;
  if (name === '') return '_';

  const stem = name.split('.')[0] ?? name;
  if (RESERVED.test(name) || RESERVED.test(stem)) name = `_${name}`;
  return name;
}

// Only a short run of letters, digits, _ or - counts as an extension. Anything else (a trailing dot,
// spaces, symbols) stays in the name, where clean() makes it safe.
const EXTENSION = /\.[\p{L}\p{N}_-]{1,15}$/u;

function splitExtension(name: string): { stem: string; extension: string } {
  const match = EXTENSION.exec(name);
  if (!match || match.index === 0) return { stem: name, extension: '' };
  return { stem: name.slice(0, match.index), extension: match[0] };
}

export function safeName(raw: string): string {
  return clean(raw, MAX_LENGTH);
}

// OneDrive is case-insensitive, so `taken` holds lower-cased names.
export function claimFolderName(raw: string, id: string, taken: Set<string>): string {
  let name = safeName(raw);
  if (taken.has(name.toLowerCase())) {
    const suffix = ` (${id.slice(-6)})`;
    name = `${clean(name, MAX_LENGTH - suffix.length)}${suffix}`;
  }
  if (taken.has(name.toLowerCase())) throw new Error(`Two folders would both be named "${name}"`);
  taken.add(name.toLowerCase());
  return name;
}

export function claimFileName(raw: string, taken: Set<string>): string {
  const { stem: rawStem, extension } = splitExtension(raw.normalize('NFC'));
  const stem = clean(rawStem, MAX_LENGTH - extension.length);

  let name = `${stem}${extension}`;
  for (let copy = 2; taken.has(name.toLowerCase()); copy += 1) {
    const suffix = ` (${copy})`;
    name = `${clean(stem, MAX_LENGTH - extension.length - suffix.length)}${suffix}${extension}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

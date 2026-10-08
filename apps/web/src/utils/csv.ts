export const requiredCsvColumns = [
  'store_id',
  'store_name',
  'address',
  'city',
  'state',
  'country',
] as const;

function readHeader(text: string): string[] | null {
  const fields: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(value.trim());
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      fields.push(value.trim());
      return fields;
    } else {
      value += character;
    }
  }
  if (quoted) return null;
  fields.push(value.trim());
  return fields;
}

export function validateCsvHeaderText(text: string): string[] {
  const clean = text.replace(/^\uFEFF/, '');
  if (!clean.trim()) return ['The selected CSV is empty.'];
  const headers = readHeader(clean);
  if (!headers) return ['The CSV header contains an unclosed quoted field.'];
  const duplicates = [
    ...new Set(headers.filter((header, index) => headers.indexOf(header) !== index)),
  ];
  const missing = requiredCsvColumns.filter((column) => !headers.includes(column));
  const errors: string[] = [];
  if (duplicates.length)
    errors.push(`Duplicate column${duplicates.length > 1 ? 's' : ''}: ${duplicates.join(', ')}.`);
  if (missing.length)
    errors.push(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
  return errors;
}

export async function validateCsvFile(file: File): Promise<string[]> {
  const nameLooksCsv = file.name.toLowerCase().endsWith('.csv');
  if (!nameLooksCsv) return ['Choose a CSV file with a .csv extension.'];
  return validateCsvHeaderText(await file.slice(0, 65_536).text());
}

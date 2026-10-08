import { describe, expect, it } from 'vitest';
import { parseStoreCsv } from '../src/services/csv-service.js';

const header = 'store_id,store_name,address,city,state,country';
const limits = { maxBytes: 10_485_760, maxRows: 10_000 };
const parse = (text: string, overrides = {}) =>
  parseStoreCsv(Buffer.from(text), { ...limits, ...overrides });

describe('CSV ingestion policies', () => {
  it('parses BOM, CRLF, quoted commas/quotes/newlines, Unicode, and surrounding whitespace', () => {
    const result = parse(
      '\uFEFF store_id ,store_name,address,city,state,country\r\n\r\n' +
        ' ST1 ," Café ""Central"" "," 12, Market\r\nStreet ", पुणे , MH , India \r\n \t\r\n',
    );
    expect(result.stores).toEqual([
      {
        store_id: 'ST1',
        store_name: 'Café "Central"',
        address: '12, Market\r\nStreet',
        city: 'पुणे',
        state: 'MH',
        country: 'India',
      },
    ]);
    expect(result.warnings).toEqual([]);
  });
  it.each(['\n', '\r\n', '\r'])('supports standard line endings %#', (ending) => {
    expect(
      parse(header + ending + 'ST1,Shop,Street,City,State,Country' + ending).stores,
    ).toHaveLength(1);
  });
  it('accepts any header order and ignores extra columns, including special object names', () => {
    const result = parse(
      'country,store_id,store_name,address,city,state,note,__proto__\n' +
        'India,ST1,Shop,Street,City,State,,ignored',
    );
    expect(result.stores[0]?.store_id).toBe('ST1');
    expect(result.stores[0]).not.toHaveProperty('note');
    expect(result.warnings).toEqual([
      {
        code: 'EXTRA_COLUMNS_IGNORED',
        message: 'Extra CSV columns were ignored.',
        columns: ['note', '__proto__'],
      },
    ]);
  });
  it.each([
    ['', 'EMPTY_CSV', 'No valid store records found'],
    [' \n\t\n', 'EMPTY_CSV', 'No valid store records found'],
    [header, 'EMPTY_CSV', 'No valid store records found'],
    [
      'store_name,address,city,state,country\nName,A,C,S,I',
      'MISSING_CSV_HEADER',
      'Missing required column: store_id',
    ],
    [
      header + ', store_id \nST1,N,A,C,S,I,ST2',
      'DUPLICATE_CSV_HEADER',
      'Duplicate CSV column: store_id',
    ],
    [
      header + ',extra, extra\nST1,N,A,C,S,I,x,y',
      'DUPLICATE_CSV_HEADER',
      'Duplicate CSV column: extra',
    ],
    [header + ',\nST1,N,A,C,S,I,x', 'INVALID_CSV_HEADERS', 'CSV column names must not be blank'],
    [
      header.replace('store_id', 'Store_ID') + '\nST1,N,A,C,S,I',
      'MISSING_CSV_HEADER',
      'Missing required column: store_id',
    ],
    [header + '\nST1,N,A,C,S,I\n ST1 ,N,A,C,S,I', 'INVALID_CSV_ROWS', 'Duplicate store ID: ST1'],
    [header + '\n,N,A,C,S,I', 'INVALID_CSV_ROWS', 'Invalid store_id at row 2'],
    [header + '\nST1,N,A,C, ,I', 'INVALID_CSV_ROWS', 'Invalid state at row 2'],
    [header + '\nST1,N,A,C,S', 'INVALID_CSV_STRUCTURE', 'Invalid CSV structure at row 2'],
    [header + '\nST1,N,A,C,S,I,extra', 'INVALID_CSV_STRUCTURE', 'Invalid CSV structure at row 2'],
    [header + '\nST1,"unclosed,A,C,S,I', 'INVALID_CSV_STRUCTURE', 'Invalid CSV structure'],
    [header + '\n,,,,,', 'INVALID_CSV_ROWS', 'Invalid store_id'],
    [
      header + '\n' + 's'.repeat(257) + ',N,A,C,S,I',
      'INVALID_CSV_ROWS',
      'Store ID must be at most 256',
    ],
  ])('rejects invalid CSV %#', (text, code, message) => {
    expect(() => parse(text)).toThrow(
      expect.objectContaining({ code, message: expect.stringContaining(message) }),
    );
  });
  it.each(['store_name', 'address', 'city', 'state', 'country'])(
    'requires nonblank %s',
    (field) => {
      const fields = ['ST1', 'Name', 'Address', 'City', 'State', 'Country'];
      fields[header.split(',').indexOf(field)] = '   '; // Test fixture construction only.
      expect(() => parse(header + '\n' + fields.join(','))).toThrow(
        expect.objectContaining({ code: 'INVALID_CSV_ROWS' }),
      );
    },
  );
  it('treats IDs as case-sensitive without numeric coercion', () => {
    expect(
      parse(header + '\n001,N,A,C,S,I\na,N,A,C,S,I\nA,N,A,C,S,I').stores.map(
        (store) => store.store_id,
      ),
    ).toEqual(['001', 'a', 'A']);
  });
  it('reports the physical CSV row, including skipped blank lines', () => {
    expect(() => parse(header + '\n\nST1,N,A,C,S,I\n\nST2,N,A')).toThrow(
      expect.objectContaining({ message: 'Invalid CSV structure at row 5' }),
    );
  });
  it('caps validation details while reporting the total error count', () => {
    try {
      parse(header + '\n' + Array.from({ length: 120 }, () => ',N,A,C,S,I').join('\n'));
      expect.fail('Expected invalid stores');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_CSV_ROWS',
        details: { totalErrors: 120, truncated: true },
      });
      expect(error).toHaveProperty('details.errors.length', 100);
    }
  });
  it('enforces byte and row limits without silently truncating records', () => {
    const text = header + '\nST1,N,A,C,S,I\nST2,N,A,C,S,I';
    expect(() => parse(text, { maxBytes: Buffer.byteLength(text) - 1 })).toThrow(
      expect.objectContaining({ status: 413 }),
    );
    expect(() => parse(text, { maxRows: 1 })).toThrow(
      expect.objectContaining({ code: 'CSV_TOO_MANY_ROWS' }),
    );
    expect(parse(text, { maxBytes: Buffer.byteLength(text), maxRows: 2 }).stores).toHaveLength(2);
  });
  it('bounds a single record even when the whole file fits', () => {
    expect(() => parse(header + '\nST1,' + 'n'.repeat(65_537) + ',A,C,S,I')).toThrow(
      expect.objectContaining({ status: 413, code: 'CSV_RECORD_TOO_LARGE' }),
    );
  });
  it('rejects invalid UTF-8 and NUL bytes', () => {
    expect(() => parseStoreCsv(Buffer.from([0xc3, 0x28]), limits)).toThrow(
      expect.objectContaining({ code: 'INVALID_CSV_ENCODING' }),
    );
    expect(() => parse(header + '\nST1,N,\0,C,S,I')).toThrow(
      expect.objectContaining({ code: 'INVALID_CSV_ENCODING' }),
    );
  });
});

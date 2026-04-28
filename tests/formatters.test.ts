import { describe, it, expect } from 'vitest';
import {
  formatObject,
  formatObjectList,
  formatOwner,
  formatProperty,
  truncate,
} from '../src/services/formatters.js';

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 100)).toBe('hello');
  });

  it('truncates long strings and adds an indicator', () => {
    const out = truncate('x'.repeat(200), 50);
    expect(out.length).toBeGreaterThan(50);
    expect(out).toMatch(/truncated/);
  });
});

describe('formatObject', () => {
  it('renders id, properties, and timestamps', () => {
    const md = formatObject({
      id: '42',
      properties: { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@example.com' },
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
    });
    expect(md).toContain('id**: 42');
    expect(md).toContain('firstname');
    expect(md).toContain('Ada');
    expect(md).toContain('createdAt');
  });

  it('uses provided title', () => {
    const md = formatObject(
      { id: '1', properties: { name: 'Acme' } },
      { title: 'Company: Acme' },
    );
    expect(md).toMatch(/^## Company: Acme/);
  });

  it('renders associations when present', () => {
    const md = formatObject({
      id: '1',
      properties: {},
      associations: { contacts: { results: [{ id: 'c1', type: 'task_to_contact' }] } },
    });
    expect(md).toContain('Associations');
    expect(md).toContain('contacts');
    expect(md).toContain('c1');
  });
});

describe('formatObjectList', () => {
  it('renders a markdown table', () => {
    const md = formatObjectList(
      [
        { id: '1', properties: { firstname: 'A', email: 'a@x.com' } },
        { id: '2', properties: { firstname: 'B', email: 'b@x.com' } },
      ],
      {
        title: 'Contacts',
        columns: [
          { property: 'firstname', label: 'first' },
          { property: 'email', label: 'email' },
        ],
        total: 2,
      },
    );
    expect(md).toContain('## Contacts');
    expect(md).toContain('| id | first | email |');
    expect(md).toContain('a@x.com');
  });

  it('renders empty result hint when none', () => {
    const md = formatObjectList([], { title: 'Empty', columns: [{ property: 'name' }] });
    expect(md).toContain('No results');
  });
});

describe('formatOwner', () => {
  it('renders id, email, name', () => {
    const md = formatOwner({ id: '1', email: 'paul@example.com', firstName: 'Paul', lastName: 'S' });
    expect(md).toContain('paul@example.com');
    expect(md).toContain('Paul S');
  });
});

describe('formatProperty', () => {
  it('renders name, label, type, and options', () => {
    const md = formatProperty({
      name: 'dealstage',
      label: 'Deal Stage',
      type: 'enumeration',
      fieldType: 'select',
      options: [
        { label: 'Closed Won', value: 'closedwon' },
        { label: 'Closed Lost', value: 'closedlost' },
      ],
    });
    expect(md).toContain('### `dealstage`');
    expect(md).toContain('Deal Stage');
    expect(md).toContain('closedwon');
  });
});

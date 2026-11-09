import { describe, expect, test } from 'vitest';
import indexHtml from '../../public/index.html?raw';
import aboutHtml from '../../public/about.html?raw';
import receiptHtml from '../../public/receipt.html?raw';

const forbidden = /(?:\u00e2\u20ac\u201d|\u00e2\u20ac\u201c|\u2014|\u2013|[\p{L}] - [\p{L}])/u;

function visibleHtmlText(html: string) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013');
}

function stringContents(source: string) {
  return source.replace(/\bstyle="[^"]*"/g, '').split('\n').flatMap(line =>
    [...line.matchAll(/'[^']*'|"[^"]*"|`[^`]*`/g)].map(match => match[0].slice(1, -1)),
  );
}

describe('visitor facing copy uses no dashes between words', () => {
  test('HTML text and JavaScript strings contain no em dash, en dash, or spaced hyphen', () => {
    const html = [['index.html', indexHtml], ['about.html', aboutHtml], ['receipt.html', receiptHtml]] as const;
    const js = Object.entries(import.meta.glob<string>('../../public/js/*.js', { eager: true, query: '?raw', import: 'default' }));
    const violations = [
      ...html.flatMap(([file, contents]) => forbidden.test(visibleHtmlText(contents)) ? [file] : []),
      ...js.flatMap(([file, contents]) => stringContents(contents).some(value => forbidden.test(value)) ? [file.replace(/^.*public\/js\//, 'public/js/')] : []),
    ];

    expect(violations).toEqual([]);
  });
});

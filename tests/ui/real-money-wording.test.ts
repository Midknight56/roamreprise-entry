import { describe, expect, test } from 'vitest';
import payJs from '../../public/js/pay.js?raw';
import appJs from '../../public/js/app.js?raw';
import receiptsJs from '../../public/js/receipts.js?raw';
import receiptHtml from '../../public/receipt.html?raw';
import indexHtml from '../../public/index.html?raw';

const forbidden = [
  'sandbox test card',
  'test money',
  '(sandbox login)',
  'captured in sandbox',
  'Sandbox payments',
];

function sanitize(content: string, isHtml: boolean): string {
  let cleaned = content;
  if (!isHtml) {
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    cleaned = cleaned.replace(/https?:\/\/www\.sandbox\.paypal\.com[^\s'"`]*/g, '');
    // Allow the one note inside the judge details
    cleaned = cleaned.replace(/<small>PayPal sandbox buyer\. Password in the README\.<\/small>/g, '');
  } else {
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');
  }
  return cleaned;
}

describe('money copy', () => {
  test('money labels on the trip and receipt screens do not say sandbox or test money', () => {
    const files = [
      { path: 'public/js/pay.js', content: sanitize(payJs, false) },
      { path: 'public/js/app.js', content: sanitize(appJs, false) },
      { path: 'public/js/receipts.js', content: sanitize(receiptsJs, false) },
      { path: 'public/receipt.html', content: sanitize(receiptHtml, true) },
      { path: 'public/index.html', content: sanitize(indexHtml, true) },
    ];

    const violations: { file: string; phrase: string }[] = [];
    for (const { path, content } of files) {
      for (const phrase of forbidden) {
        if (content.includes(phrase)) {
          violations.push({ file: path, phrase });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

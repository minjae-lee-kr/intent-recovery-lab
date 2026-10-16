import test from 'node:test';
import assert from 'node:assert/strict';
import { en, ko, events, issues, initialLanguage, LANGUAGE_KEY } from '../src/client/i18n.ts';
import type { StoragePort } from '../src/client/model.ts';

test('Korean browser defaults to Korean, explicit language choice survives reload', () => {
  const values = new Map<string, string>();
  const storage: StoragePort = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  assert.equal(initialLanguage(storage, 'ko-KR'), 'ko');
  assert.equal(initialLanguage(storage, 'en-US'), 'en');
  storage.setItem(LANGUAGE_KEY, 'en');
  assert.equal(initialLanguage(storage, 'ko-KR'), 'en');
  storage.setItem(LANGUAGE_KEY, 'ko');
  assert.equal(initialLanguage(storage, 'en-US'), 'ko');
  storage.setItem(LANGUAGE_KEY, '<script>');
  assert.equal(initialLanguage(storage, 'ko-KR'), 'ko');
});

test('blocked storage leaves browser-language fallback usable', () => {
  assert.equal(
    initialLanguage(
      {
        getItem() {
          throw new Error('denied');
        },
        setItem() {},
      },
      'ko',
    ),
    'ko',
  );
});

test('visible copy, errors and trace events have full bilingual coverage', () => {
  for (const [english, korean] of [
    [en, ko],
    [issues.en, issues.ko],
    [events.en, events.ko],
  ] as const) {
    assert.deepEqual(Object.keys(korean).sort(), Object.keys(english).sort());
    for (const text of Object.values(korean)) assert.ok(text.trim().length > 0);
    for (const text of Object.values(english)) assert.ok(text.trim().length > 0);
  }
});

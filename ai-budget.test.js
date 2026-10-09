const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { guideKey, createGuideCache, createUserCap } = require('./ai-budget');

test('a grow guide is the same request whatever the order, case or bullets', () => {
  assert.equal(guideKey('Tomato, carrot\nBASIL'), guideKey('- basil\n• carrot\n1. tomato'));
  assert.notEqual(guideKey('tomato'), guideKey('tomato, carrot'));
});

test('guides are cached on disk until they expire', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-budget-')), 'cache.json');
  let t = 0;
  const cache = createGuideCache(file, 1000, () => t);
  cache.set('tomato', 'Grow it warm.');
  assert.equal(createGuideCache(file, 1000, () => t).get('tomato'), 'Grow it warm.'); // survives a restart
  t = 1000;
  assert.equal(cache.get('tomato'), null);
});

test('each user gets the cap per UTC day, and it resets the next day', () => {
  let t = Date.parse('2026-10-09T23:00:00Z');
  const cap = createUserCap(2, () => t);
  assert.equal(cap.take('a'), true);
  assert.equal(cap.take('a'), true);
  assert.equal(cap.take('a'), false);
  assert.equal(cap.take('b'), true); // others aren't affected
  assert.equal(cap.used('a'), 2);
  t = Date.parse('2026-10-10T00:30:00Z');
  assert.equal(cap.take('a'), true);
  assert.equal(cap.used('a'), 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { en, ko } from '../src/client/i18n.ts';
import {
  compileApp,
  mountApp,
  emptyLedger,
  committedLedger,
  confirmedOutcome,
} from './helpers/mounted-app.ts';

test(
  'mounted diagnostic reads describe their own observation state',
  { timeout: 30_000 },
  async (t) => {
    const compiled = await compileApp();
    t.after(compiled.remove);
    for (const language of ['ko', 'en'] as const) {
      const copy = language === 'ko' ? ko : en;
      await t.test(`${language}: first read, failure, retry and completed snapshot`, async () => {
        const app = await mountApp(compiled.url, language);
        try {
          const status = () => app.query('.ledger-status');
          const metrics = () =>
            Array.from(app.document.querySelectorAll('.metrics dd'), (x) => x.textContent);
          assert.equal(status().textContent, copy.serverLoading);
          assert.deepEqual(metrics(), ['—', '—']);
          await app.failLedger(0);
          assert.equal(status().textContent, copy.serverUnavailable);
          assert.equal(status().classList.contains('failed'), true);
          assert.deepEqual(metrics(), ['—', '—']);
          await app.click('.refresh');
          assert.equal(status().textContent, copy.serverLoading);
          assert.equal(status().classList.contains('failed'), false);
          assert.ok(!app.query('.evidence-card').textContent?.includes(copy.serverUnavailable));
          await app.ledger(1, emptyLedger);
          assert.equal(status().textContent, copy.observedLedger);
          assert.deepEqual(metrics(), ['—', '12 / 12']);
        } finally {
          await app.close();
        }
      });
      await t.test(
        `${language}: confirmed product survives pending, stale and failed diagnostic reads`,
        async () => {
          const app = await mountApp(compiled.url, language);
          try {
            const status = () => app.query('.ledger-status');
            const metrics = () =>
              Array.from(app.document.querySelectorAll('.metrics dd'), (x) => x.textContent);
            await app.ledger(0, emptyLedger);
            await app.click('.primary');
            await app.click('.primary');
            await app.confirm();
            const outcome = app.client.getSnapshot().outcome;
            assert.deepEqual(outcome, confirmedOutcome);
            assert.equal(app.query('.outcome-state strong').textContent, copy.stateConfirmed);
            assert.equal(status().textContent, copy.refreshingLedger);
            assert.equal(status().classList.contains('failed'), false);
            assert.deepEqual(metrics(), ['0', '12 / 12']);
            assert.equal(app.query('.server-state p').textContent, copy.noRecord);
            const count = app.ledgerRequests.length;
            await app.click(`.language-switch button[lang="${language === 'ko' ? 'en' : 'ko'}"]`);
            assert.equal(status().textContent, (language === 'ko' ? en : ko).refreshingLedger);
            assert.equal(app.ledgerRequests.length, count, 'language does not refetch');
            assert.strictEqual(app.client.getSnapshot().outcome, outcome);
            await app.click(`.language-switch button[lang="${language}"]`);
            await app.ledger(count - 1, committedLedger);
            assert.equal(status().textContent, copy.observedLedger);
            assert.deepEqual(metrics(), ['1', '11 / 12']);
            assert.equal(app.query('.server-detail .mono').textContent, confirmedOutcome.receiptId);
            assert.ok(app.ledgerRequests[1]!.signal.aborted);
            await app.ledger(1, emptyLedger);
            await app.failLedger(2);
            assert.equal(status().textContent, copy.observedLedger);
            assert.deepEqual(metrics(), ['1', '11 / 12']);
            assert.equal(app.query('.server-detail .mono').textContent, confirmedOutcome.receiptId);

            await app.click('.refresh');
            await app.failLedger(app.ledgerRequests.length - 1);
            assert.equal(status().textContent, copy.staleLedger);
            assert.equal(status().classList.contains('failed'), true);
            assert.deepEqual(metrics(), ['1', '11 / 12']);
            assert.strictEqual(app.client.getSnapshot().outcome, outcome);
            assert.equal(app.query('.outcome-state strong').textContent, copy.stateConfirmed);
            await app.click('.refresh');
            assert.equal(status().textContent, copy.refreshingLedger);
            assert.equal(status().classList.contains('failed'), false);
            assert.ok(!app.query('.evidence-card').textContent?.includes(copy.staleLedger));
            assert.deepEqual(metrics(), ['1', '11 / 12']);
            await app.ledger(app.ledgerRequests.length - 1, committedLedger);
            assert.equal(status().textContent, copy.observedLedger);
            assert.strictEqual(app.client.getSnapshot().outcome, outcome);
          } finally {
            await app.close();
          }
        },
      );
    }
  },
);

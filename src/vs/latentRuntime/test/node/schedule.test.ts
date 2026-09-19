/* eslint-disable header/header */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { classifyLateness, computeNextRun, parseSchedule, ParsedSchedule } from '../../node/jobs/schedule.js';

function cronFields(schedule: ParsedSchedule): readonly (readonly number[])[] {
	return schedule.kind === 'cron' ? schedule.fields : [];
}

suite('Latent runtime schedules (P1-FR-082)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses the retained Hermes grammar', () => {
		assert.deepStrictEqual([
			parseSchedule('every 30m'),
			parseSchedule('every 2 hours'),
			parseSchedule('at 2026-09-19T08:00:00.000Z').kind,
			cronFields(parseSchedule('cron: */15 9-17 * * 1-5')).map(field => field.length),
			cronFields(parseSchedule('0 0 1 1 *'))[0],
		], [
			{ kind: 'interval', minutes: 30 },
			{ kind: 'interval', minutes: 120 },
			'at',
			[4, 9, 31, 12, 5],
			[0],
		]);
		assert.throws(() => parseSchedule('every 0m'));
		assert.throws(() => parseSchedule('* * *'));
		assert.throws(() => parseSchedule('61 * * * *'));
	});

	test('computes the next run and retires one-shot jobs', () => {
		const from = Date.UTC(2026, 8, 18, 10, 0, 0);
		assert.deepStrictEqual([
			computeNextRun(parseSchedule('every 1m'), from, from),
			computeNextRun(parseSchedule('at 2026-09-19T08:00:00.000Z'), from),
			computeNextRun(parseSchedule('at 2026-09-19T08:00:00.000Z'), from, Date.UTC(2026, 8, 19, 8, 0, 0)),
		], [from + 60_000, Date.UTC(2026, 8, 19, 8, 0, 0), undefined]);
		const next = computeNextRun(parseSchedule('cron: */15 * * * *'), from)!;
		assert.strictEqual(new Date(next).getMinutes() % 15, 0);
		assert.ok(next > from && next - from <= 15 * 60_000);
	});

	test('classifies lateness with a grace window', () => {
		const at = 1_000_000;
		assert.deepStrictEqual([
			classifyLateness(at, at + 30_000, 60, false),
			classifyLateness(at, at + 10 * 60_000, 60, false),
			classifyLateness(at, at + 10 * 60_000, 60, true),
			classifyLateness(at, at + 20 * 60_000, 3600, false),
		], ['onTime', 'late', 'catchUp', 'onTime']);
	});
});

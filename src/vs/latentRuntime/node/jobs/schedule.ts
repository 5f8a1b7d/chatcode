/* eslint-disable header/header */

export type ParsedSchedule =
	| { readonly kind: 'cron'; readonly fields: readonly (readonly number[])[]; readonly expression: string }
	| { readonly kind: 'interval'; readonly minutes: number }
	| { readonly kind: 'at'; readonly time: number };

const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;

function parseField(field: string, [min, max]: readonly [number, number]): number[] {
	const values = new Set<number>();
	for (const part of field.split(',')) {
		const [base, stepText] = part.split('/');
		const step = stepText ? Number(stepText) : 1;
		if (!Number.isInteger(step) || step <= 0) {
			throw new Error(`Invalid step in "${part}"`);
		}
		let start = min;
		let end = max;
		if (base !== '*') {
			const [lowText, highText] = base.split('-');
			start = Number(lowText);
			end = highText !== undefined ? Number(highText) : stepText ? max : start;
			if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
				throw new Error(`Invalid range "${part}"`);
			}
		}
		for (let value = start; value <= end; value += step) {
			values.add(value === 7 && max === 6 ? 0 : value);
		}
	}
	return [...values].sort((a, b) => a - b);
}

/**
 * Parses the schedule grammar retained from Hermes `cron/jobs.py`:
 * `cron: m h dom mon dow`, `every 30m|2h|1d`, or `at <ISO timestamp>`.
 */
export function parseSchedule(text: string): ParsedSchedule {
	const value = text.trim();
	const every = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i.exec(value);
	if (every) {
		const amount = Number(every[1]);
		const unit = every[2].toLowerCase();
		const minutes = unit.startsWith('h') ? amount * 60 : unit.startsWith('d') ? amount * 1440 : amount;
		if (minutes <= 0) {
			throw new Error('Interval must be positive.');
		}
		return { kind: 'interval', minutes };
	}
	const at = /^at\s+(.+)$/i.exec(value);
	if (at) {
		const time = Date.parse(at[1]);
		if (Number.isNaN(time)) {
			throw new Error(`Invalid timestamp "${at[1]}"`);
		}
		return { kind: 'at', time };
	}
	const expression = value.replace(/^cron:\s*/i, '');
	const fields = expression.split(/\s+/);
	if (fields.length !== 5) {
		throw new Error('A cron schedule needs five fields.');
	}
	return { kind: 'cron', expression, fields: fields.map((field, index) => parseField(field, ranges[index])) };
}

/** Next run strictly after `from` in local time; undefined for one-shot schedules that already fired. */
export function computeNextRun(schedule: ParsedSchedule, from: number, lastRunAt?: number): number | undefined {
	switch (schedule.kind) {
		case 'at':
			return lastRunAt !== undefined && lastRunAt >= schedule.time ? undefined : schedule.time;
		case 'interval': {
			const base = lastRunAt ?? from;
			const next = base + schedule.minutes * 60_000;
			return next > from ? next : from + schedule.minutes * 60_000;
		}
		case 'cron': {
			const [minutes, hours, days, months, weekdays] = schedule.fields;
			const cursor = new Date(from);
			cursor.setSeconds(0, 0);
			cursor.setMinutes(cursor.getMinutes() + 1);
			for (let i = 0; i < 366 * 24 * 60; i++) {
				if (months.includes(cursor.getMonth() + 1) && days.includes(cursor.getDate()) && weekdays.includes(cursor.getDay()) && hours.includes(cursor.getHours()) && minutes.includes(cursor.getMinutes())) {
					return cursor.getTime();
				}
				cursor.setMinutes(cursor.getMinutes() + 1);
			}
			return undefined;
		}
	}
}

/** Cadence in seconds used to size the lateness grace window. */
export function cadenceSeconds(schedule: ParsedSchedule): number | undefined {
	return schedule.kind === 'interval' ? schedule.minutes * 60 : schedule.kind === 'cron' ? 60 : undefined;
}

/** Hermes lateness classification: within grace is on time, beyond grace is late, and a run missed while the runtime was down is a catch-up. */
export function classifyLateness(scheduledAt: number, now: number, cadence: number | undefined, wasOffline: boolean): 'onTime' | 'late' | 'catchUp' {
	const grace = Math.max(60, Math.floor((cadence ?? 3600) / 2));
	const latenessSeconds = (now - scheduledAt) / 1000;
	if (latenessSeconds <= grace) {
		return 'onTime';
	}
	return wasOffline ? 'catchUp' : 'late';
}

import type {
	NotificationType,
	QuietHoursConfig,
} from "./types.ts";

function minutesSinceMidnight(value: string): number {
	const [hours, minutes] = value.split(":").map(Number);
	return hours * 60 + minutes;
}

export function isQuietHours(
	now: Date,
	config: QuietHoursConfig,
): boolean {
	if (!config.enabled) return false;
	const current = now.getHours() * 60 + now.getMinutes();
	const start = minutesSinceMidnight(config.start);
	const end = minutesSinceMidnight(config.end);
	if (start === end) return true;
	if (start < end) return current >= start && current < end;
	return current >= start || current < end;
}

export function isNotificationAllowedNow(
	type: NotificationType,
	config: QuietHoursConfig,
	now = new Date(),
): boolean {
	return !isQuietHours(now, config)
		|| config.allowDuringQuietHours.includes(type);
}

export function shouldIgnoreShortIdle(
	durationMs: number | undefined,
	ignoreShortTasksSeconds: number,
): boolean {
	return typeof durationMs === "number"
		&& durationMs < ignoreShortTasksSeconds * 1000;
}

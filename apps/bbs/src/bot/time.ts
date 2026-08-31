const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1_000;

/** Hong Kong has no daylight-saving transitions, so a fixed UTC+8 conversion is exact. */
export function hongKongDay(at: Date): string {
  return new Date(at.getTime() + HONG_KONG_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** The following Hong Kong day's 09:00, represented as a UTC instant. */
export function digestDueAt(assignmentDay: string): Date {
  return new Date(`${addDays(assignmentDay, 1)}T01:00:00.000Z`);
}

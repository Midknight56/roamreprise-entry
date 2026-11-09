export function toMinutes(time: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`Invalid time: ${time}`);
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}
export function fromMinutes(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) throw new Error('Time is outside this day');
  return `${Math.floor(minutes / 60)}`.padStart(2, '0') + ':' + `${minutes % 60}`.padStart(2, '0');
}
export const addMinutes = (time: string, minutes: number): string => fromMinutes(toMinutes(time) + minutes);
export const compare = (a: string, b: string): number => toMinutes(a) - toMinutes(b);

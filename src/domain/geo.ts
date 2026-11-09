import { place } from './places';
import type { Place, TravelMode } from './types';
type Location = Place | string;
const resolve = (p: Location): Place => typeof p === 'string' ? place(p) : p;
export const ceil5 = (minutes: number): number => Math.max(5, Math.ceil(minutes / 5) * 5);
export function haversineKm(a: Location, b: Location): number {
  const p = resolve(a), q = resolve(b), rad = Math.PI / 180;
  const h = Math.sin((q.lat - p.lat) * rad / 2) ** 2 + Math.cos(p.lat * rad) * Math.cos(q.lat * rad) * Math.sin((q.lon - p.lon) * rad / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function travelMode(a: Location, b: Location): TravelMode {
  const d = haversineKm(a, b);
  return d === 0 ? 'none' : d <= 1.2 ? 'walk' : d <= 4.5 ? 'metro' : 'taxi';
}
export function travelMinutes(a: Location, b: Location): number {
  const d = haversineKm(a, b);
  return d === 0 ? 0 : ceil5(d <= 1.2 ? d * 13 : d <= 4.5 ? 6 + d * 4 : 8 + d * 2.6);
}
export function travelCostCents(a: Location, b: Location): number {
  const d = haversineKm(a, b);
  return d <= 1.2 ? 0 : d <= 4.5 ? 200 : Math.round(400 + d * 160);
}

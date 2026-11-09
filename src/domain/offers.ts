import { haversineKm, travelMinutes } from './geo';
import { SUPPLIER, type Offer, type Day } from './types';
function hotel(id: string, name: string, placeId: string, priceCents: number, available = true): Offer {
  return { id, name, placeId, priceCents, available, kind: 'lodging', minutes: 20, opens: '15:00', closes: '11:00', days: [0, 1], tags: [], supplier: SUPPLIER };
}
export const hotels: Offer[] = [
  hotel('h-patio', 'Casa do Pátio rooms', 'alfama', 16800),
  hotel('h-lumen', 'Lumen Rooms', 'chiado', 21400),
  hotel('h-riocalmo', 'Rio Calmo Inn', 'maat', 14200),
  hotel('h-terraco', 'Terraço Hostel', 'graca', 9600, false),
  hotel('h-avenida', 'Avenida Grand', 'avenida', 39800),
];
function visit(id: string, kind: 'activity' | 'meal', name: string, placeId: string, priceCents: number, minutes: number, opens: string, closes: string, tags: string[], days: Day[] = [0, 1]): Offer {
  return { id, kind, name, placeId, priceCents, minutes, opens, closes, days, tags, available: true, supplier: SUPPLIER };
}
export const activitiesAndMeals: Offer[] = [
  visit('a-tileclass', 'activity', 'Tile painting class', 'tilemuseum', 5800, 120, '10:00', '17:00', ['tile art', 'history']),
  visit('a-tilemuseum', 'activity', 'National Tile Museum visit', 'tilemuseum', 800, 90, '10:00', '18:00', ['tile art', 'history']),
  visit('a-castle', 'activity', 'Castle hill walk', 'castle', 1500, 90, '09:00', '21:00', ['viewpoints', 'history']),
  visit('a-graca', 'activity', 'Senhora do Monte viewpoint walk', 'graca', 0, 60, '07:00', '23:00', ['viewpoints']),
  visit('a-streetart', 'activity', 'Alcântara street art walk', 'lxf', 2800, 120, '10:00', '18:00', ['street art', 'contemporary art']),
  visit('a-maat', 'activity', 'MAAT riverside galleries', 'maat', 1200, 90, '10:00', '19:00', ['contemporary art', 'river walks']),
  visit('a-jeronimos', 'activity', 'Jerónimos cloister tour', 'jeronimos', 1800, 75, '09:30', '18:00', ['history']),
  visit('a-tower', 'activity', 'Belém river walk', 'belemtower', 0, 60, '08:00', '20:00', ['river walks', 'viewpoints']),
  visit('a-gulbenkian', 'activity', 'Gulbenkian garden and collection', 'gulbenkian', 1500, 120, '10:00', '18:00', ['contemporary art', 'history'], [0]),
  visit('a-jazz', 'activity', 'Bairro Alto jazz cellar', 'bairroalto', 2200, 120, '21:00', '23:59', ['live music']),
  visit('m-ribeira', 'meal', 'Market hall lunch', 'ribeira', 2400, 75, '10:00', '23:00', ['food markets']),
  visit('m-coffee', 'meal', 'Roastery brunch', 'principe', 1900, 60, '08:00', '16:00', ['coffee']),
  visit('m-chiado', 'meal', 'Chiado bistro lunch', 'chiado', 3100, 75, '12:00', '15:30', ['food markets']),
  visit('m-fado', 'meal', 'Fado dinner in Alfama', 'alfama', 7400, 150, '19:30', '23:30', ['fado music', 'live music']),
  visit('m-riverside', 'meal', 'Riverside seafood dinner', 'comercio', 5600, 120, '19:00', '23:00', ['food markets']),
];
// Extra checked alternatives for traveler changes, without changing the initial proposal shortlist.
export const askAlternatives: Offer[] = [
  visit('a-roastery', 'activity', 'Coffee roastery tasting', 'principe', 1200, 60, '10:00', '20:00', ['coffee']),
];
export const offers = [...hotels, ...activitiesAndMeals, ...askAlternatives];
export const OFFERS = offers;
export function offer(id: string): Offer {
  const result = offers.find(o => o.id === id);
  if (!result) throw new Error(`Unknown offer: ${id}`);
  return result;
}
/** Airport cars always use the taxi fare, even for a short route. */
export function airportTransfer(id: 't-arrive' | 't-depart', hotelPlaceId: string): Offer {
  return {
    id, kind: 'transfer', name: id === 't-arrive' ? 'Airport arrival car' : 'Airport departure car',
    placeId: id === 't-arrive' ? hotelPlaceId : 'lis',
    priceCents: Math.round((Math.round(400 + haversineKm('lis', hotelPlaceId) * 160) + 1400) / 100) * 100,
    minutes: travelMinutes('lis', hotelPlaceId), opens: '00:00', closes: '23:59',
    days: id === 't-arrive' ? [0] : [1], tags: [], available: true, supplier: SUPPLIER,
  };
}

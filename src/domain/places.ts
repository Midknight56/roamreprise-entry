import type { Place } from './types';
export const places: Place[] = [
  { id: 'lis', name: 'Lisbon Airport (LIS)', lat: 38.7742, lon: -9.1342, area: 'Airport' },
  { id: 'alfama', name: 'Alfama, Largo de Santa Luzia', lat: 38.7116, lon: -9.1300, area: 'Alfama' },
  { id: 'castle', name: 'Castelo de São Jorge', lat: 38.7139, lon: -9.1335, area: 'Alfama' },
  { id: 'graca', name: 'Miradouro da Senhora do Monte', lat: 38.7193, lon: -9.1327, area: 'Graça' },
  { id: 'tilemuseum', name: 'National Tile Museum', lat: 38.7247, lon: -9.1135, area: 'Xabregas' },
  { id: 'ribeira', name: 'Mercado da Ribeira', lat: 38.7069, lon: -9.1459, area: 'Cais do Sodré' },
  { id: 'chiado', name: 'Chiado, Largo do Camões', lat: 38.7107, lon: -9.1436, area: 'Chiado' },
  { id: 'bairroalto', name: 'Bairro Alto', lat: 38.7135, lon: -9.1460, area: 'Bairro Alto' },
  { id: 'comercio', name: 'Praça do Comércio', lat: 38.7076, lon: -9.1365, area: 'Baixa' },
  { id: 'principe', name: 'Príncipe Real', lat: 38.7166, lon: -9.1488, area: 'Príncipe Real' },
  { id: 'lxf', name: 'LX Factory, Alcântara', lat: 38.7034, lon: -9.1784, area: 'Alcântara' },
  { id: 'maat', name: 'MAAT riverside', lat: 38.6957, lon: -9.1937, area: 'Belém' },
  { id: 'jeronimos', name: 'Jerónimos Monastery', lat: 38.6979, lon: -9.2068, area: 'Belém' },
  { id: 'belemtower', name: 'Belém Tower', lat: 38.6916, lon: -9.2160, area: 'Belém' },
  { id: 'gulbenkian', name: 'Gulbenkian Garden', lat: 38.7375, lon: -9.1545, area: 'Avenidas Novas' },
  { id: 'avenida', name: 'Avenida da Liberdade', lat: 38.7197, lon: -9.1452, area: 'Avenida' },
];
export const PLACES = places;
export function place(id: string): Place {
  const result = places.find(p => p.id === id);
  if (!result) throw new Error(`Unknown place: ${id}`);
  return result;
}

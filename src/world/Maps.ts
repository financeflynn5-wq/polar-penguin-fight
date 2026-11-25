// The maps, by id. buildMap(id) always builds the same map from the id alone, so a server and its clients agree.
import { MapDef, buildBayMap } from './MapDef';
import { buildConquestMap } from './ConquestMap';
import { buildBreakthroughMap } from './BreakthroughMap';

export type MapId = 'bay' | 'gap' | 'pass';
export type Mode = 'tdm' | 'conquest' | 'breakthrough';

export const MAP_NAMES: Record<MapId, string> = { bay: 'Frostbite Bay', gap: 'Glacier Gap', pass: 'Peppermint Pass' };

/** Each mode is played on the map that was built for it. */
export const mapForMode = (mode: Mode): MapId => (mode === 'conquest' ? 'gap' : mode === 'breakthrough' ? 'pass' : 'bay');

export function buildMap(id: MapId = 'bay'): MapDef {
  return id === 'gap' ? buildConquestMap() : id === 'pass' ? buildBreakthroughMap() : buildBayMap();
}

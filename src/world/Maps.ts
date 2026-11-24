// The maps, by id. buildMap(id) always builds the same map from the id alone, so a server and its clients agree.
import { MapDef, buildBayMap } from './MapDef';
import { buildConquestMap } from './ConquestMap';

export type MapId = 'bay' | 'gap';
export type Mode = 'tdm' | 'conquest';

export const MAP_NAMES: Record<MapId, string> = { bay: 'Frostbite Bay', gap: 'Glacier Gap' };

/** Each mode is played on the map that was built for it. */
export const mapForMode = (mode: Mode): MapId => (mode === 'conquest' ? 'gap' : 'bay');

export function buildMap(id: MapId = 'bay'): MapDef {
  return id === 'gap' ? buildConquestMap() : buildBayMap();
}

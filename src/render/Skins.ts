import { PenguinModel } from './PenguinModel';
import { ClassicPenguinModel } from './ClassicPenguinModel';
import type { Skin } from '../sim/World';

/** What the game needs from a penguin model, whichever skin it is. */
export type PenguinView = PenguinModel | ClassicPenguinModel;

/** Build the model for a penguin wearing this skin. */
export function makePenguinModel(skin: Skin, team: number, hat: string, name: string | null, showTag = true): PenguinView {
  return skin === 'classic' ? new ClassicPenguinModel(team, hat, name, showTag) : new PenguinModel(team, hat, name, showTag);
}

import { PenguinModel } from './PenguinModel';
import { ClassicPenguinModel } from './ClassicPenguinModel';
import type { Skin } from '../sim/World';
import type { ClassId } from '../sim/Classes';

/** What the game needs from a penguin model, whichever skin it is. */
export type PenguinView = PenguinModel | ClassicPenguinModel;

/** Build the model for a penguin wearing this skin. The classic skin is only for the penguin class: bears and yetis always use their own models. */
export function makePenguinModel(skin: Skin, team: number, hat: string, name: string | null, showTag = true, cls: ClassId = 'penguin'): PenguinView {
  return skin === 'classic' && cls === 'penguin' ? new ClassicPenguinModel(team, hat, name, showTag) : new PenguinModel(team, hat, name, showTag, cls);
}

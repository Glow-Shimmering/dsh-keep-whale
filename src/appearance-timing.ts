/** Timing is supplied by the locally installed pack, bounded for safe UI timers. */
export type InteractionAnimation = 'pet' | 'feed';
export type AppearanceDurations = Record<InteractionAnimation, number>;
export const DEFAULT_INTERACTION_MS: Readonly<AppearanceDurations> = {pet:2600,feed:3200};
export function validInteractionDuration(value:unknown): value is number {
  return typeof value==='number' && Number.isSafeInteger(value) && value>=600 && value<=6000;
}

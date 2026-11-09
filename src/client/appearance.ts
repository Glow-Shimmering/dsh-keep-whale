import { DEFAULT_INTERACTION_MS, validInteractionDuration, type InteractionAnimation, type AppearanceDurations } from '../appearance-timing.js';
/** Pure display selection: showing an expression must never mutate persisted mood. */
const MOODS: Readonly<Record<string,string>> = {
  平静: 'calm', 开心: 'happy', 期待: 'expectant', 担心: 'worried',
  沮丧: 'sad', 不满: 'annoyed', 害羞: 'shy', 释然: 'relieved',
};
export type { InteractionAnimation };
export type Appearance = {available:boolean;version:string|null;durations?:AppearanceDurations};
export type Position = {x:number; y:number};
/** Older snapshots and unbound skins retain the original playback timing. */
export function interactionDuration(type:InteractionAnimation,appearance?:Appearance|null):number {
  const duration=appearance?.available ? appearance.durations?.[type] : undefined;
  return validInteractionDuration(duration) ? duration : DEFAULT_INTERACTION_MS[type];
}
function versionQuery(appearance: Appearance): string { return `v=${encodeURIComponent(appearance.version || 'current')}`; }
export function moodPortrait(mood?: string | null, customSkin?: string | null, appearance?: Appearance | null): string {
  if (!appearance?.available) return customSkin || '/keep-whale/portrait.png';
  return `/keep-whale/art/${MOODS[mood || ''] || 'calm'}.png?${versionQuery(appearance)}`;
}
export function interactionPortrait(mood: string | null | undefined, customSkin: string | null | undefined, appearance: Appearance | null | undefined, interaction: InteractionAnimation | null, reducedMotion: boolean, visible: boolean, playbackId: string): string {
  if (!interaction || !appearance?.available) return moodPortrait(mood,customSkin,appearance);
  const base=`/keep-whale/art/${interaction}`;
  // A unique URL restarts the animation even when the browser shares GIF timers.
  return reducedMotion || !visible ? `${base}.png?${versionQuery(appearance)}` : `${base}.gif?${versionQuery(appearance)}&play=${encodeURIComponent(playbackId)}`;
}
export function overlaySize(collapsed: boolean, width: number, height: number) {
  return {width:Math.min(collapsed?56:156,Math.max(0,width)),height:Math.min(collapsed?56:210,Math.max(0,height))};
}
export function clampOverlay(pos:Position, collapsed:boolean, width:number, height:number):Position {
  const size=overlaySize(collapsed,width,height);
  return {x:Math.max(0,Math.min(pos.x,Math.max(0,width-size.width))),y:Math.max(0,Math.min(pos.y,Math.max(0,height-size.height)))};
}
/** Keep the bottom-right corner fixed when switching between two frame sizes. */
export function toggleOverlayPosition(pos:Position, wasCollapsed:boolean, width:number, height:number):Position {
  const oldSize=overlaySize(wasCollapsed,width,height), newSize=overlaySize(!wasCollapsed,width,height);
  return clampOverlay({x:pos.x+oldSize.width-newSize.width,y:pos.y+oldSize.height-newSize.height},!wasCollapsed,width,height);
}

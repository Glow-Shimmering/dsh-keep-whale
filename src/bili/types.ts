export interface BiliSettings {
  enabled: boolean;
  paused: boolean;
  pausedUntil: number | null;
  shareEnabled: boolean;
  allowLike: boolean;
  allowFavorite: boolean;
  maxVideoMinutes: number; // 0 means no product duration limit; processing is segmented.
}
export interface BiliAccount { loggedIn: boolean; name: string; mid: string | null; reason?: string }
export interface BiliVideo { bvid: string; aid: number; cid: number; title: string; owner: string; ownerId: string; duration: number; url: string; description?: string }
export interface BiliSubtitle { from: number; to: number; text: string }
export interface BiliFrame { at: number; data: Buffer; mediaType: 'image/jpeg' | 'image/png' }
export interface BiliMaterial { video: BiliVideo; subtitles: BiliSubtitle[]; frames: BiliFrame[]; subtitleLanguage: string; coverage: string; limitations: string[] }
export interface BiliRecord {
  id: string; video: BiliVideo; origin: 'autonomous' | 'recommended'; recommendedAt?: number;
  createdAt: number; summary: string; opinion: string; topics: string[];
  coverage: string; limitations: string[]; excerpts: BiliSubtitle[]; frameTimes: number[];
  liked: boolean; favorited: boolean; actionReason: string; actionError?: string;
  shareText: string; shareStatus: 'pending' | 'sent' | 'skipped' | 'expired'; sharedAt?: number;
  discussedAt?: number; version: number;
}
export interface BiliAttempt {
  id: string; bvid?: string; title?: string; origin: 'autonomous' | 'recommended';
  status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'skipped';
  stage: string; reason: string; createdAt: number; updatedAt: number; recordId?: string;
}
export interface BiliRecommendation { id: string; input: string; bvid: string | null; createdAt: number; status: 'pending' | 'started' | 'done' | 'failed'; reason: string }
export interface BiliBlock { kind: 'video' | 'owner'; id: string; label: string; createdAt: number }
export interface BiliStats { attempted: number; succeeded: number; failed: number; interrupted: number; skipped: number }
export interface BiliState {
  confirmedMid: string | null;
  settings: BiliSettings; account: BiliAccount; status: string; reason: string;
  current: BiliVideo | null; busy: boolean; checked: boolean; capabilityReason: string;
  stats: BiliStats; records: BiliRecord[]; attempts: BiliAttempt[]; recommendations: BiliRecommendation[];
  blocks: BiliBlock[]; interests: Array<{topic:string;recordIds:string[]}>;
  usage: { spent:number;reserved:number;estimated?:number;uncertain:boolean;limit:number;unit:string };
}
export interface BiliProvider {
  setExpectedMid(mid: string | null): void;
  available(): boolean;
  account(signal: AbortSignal): Promise<BiliAccount>;
  login(): Promise<void>;
  logout(): Promise<void>;
  resolve(input: string, signal: AbortSignal): Promise<string>;
  candidates(signal: AbortSignal): Promise<BiliVideo[]>;
  material(bvid: string, signal: AbortSignal, stage: (label: string)=>void, maxDurationSeconds?: number, acceptVideo?:(video:BiliVideo)=>boolean): Promise<BiliMaterial>;
  like(video: BiliVideo, signal: AbortSignal): Promise<void>;
  favorite(video: BiliVideo, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

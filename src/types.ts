export type Route = { provider: string; model: string };
export type Rates = { input: number; cached: number; output: number };
export interface Settings {
  model: Route | null; priceRoute: Route | null; prices: Rates | null;
  unit: string; pointsPerYuan: number | null; dailyLimit: number;
  observeEnabled: boolean; observeSince: number; excludedSessions: string[]; excludedWorkspaces: string[];
  backgroundEnabled: boolean; proactiveEnabled: boolean; quiet: boolean;
  skin: string | null;
}
export interface Companion { id: string; name: string; mood: string; createdAt: number }
export interface ImageRef { id: string; url: string; mediaType: string; name: string }
export interface Message {
  id: string; chatId: string; role: 'user' | 'assistant'; text: string; images: ImageRef[];
  status: 'streaming' | 'complete' | 'failed' | 'cancelled'; createdAt: number;
  origin: 'chat' | 'proactive'; requestId: string; error?: string;
}
export type SourceKind = 'user_fact' | 'shared_episode' | 'observed_dialogue' | 'interaction';
export interface Source {
  id: string; kind: SourceKind; text: string; context?: string; sessionId?: string; workspace?: string;
  occasion: string; createdAt: number; processed: boolean; revoked: boolean;
}
export type MemoryKind = 'user_fact' | 'shared_episode' | 'observed_dialogue' | 'tendency';
export interface Memory { id: string; kind: MemoryKind; text: string; sourceIds: string[]; createdAt: number; updatedAt: number }
export interface Job { id: string; kind: 'chat' | 'memory' | 'proactive'; status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'skipped'; stage: string; reason: string; createdAt: number; updatedAt: number; sourceIds: string[] }
export interface Ledger { unit?: string; id: string; day: string; jobId: string; background: boolean; reserved: number; actual: number | null; status: 'reserved' | 'settled' | 'uncertain'; createdAt: number }
export interface Usage { day: string; spent: number; reserved: number; uncertain: boolean; chatSpent: number; chatUncertain?: boolean; limit: number; unit: string }
export interface Interaction { id: string; type: 'pet' | 'feed'; text: string; createdAt: number }
export interface ModelInfo extends Route { name: string; vision: boolean }
export interface Presence { windowId: string; visible: boolean; typing: boolean; lastInputAt: number; panelOpen: boolean; at: number }
export interface Snapshot {
  token?: string; ledger?: Ledger[]; companion: Companion; settings: Settings; messages: Message[]; memories: Memory[]; sources: Source[];
  interactions: Interaction[]; jobs: Job[]; usage: Usage; models: ModelInfo[]; busy: boolean; unread: number;
  error: string | null; capability: { chat: boolean; images: boolean }; revision: number;
}
export interface HostContext { get(name: string): any; on(name: string, callback: (...args: any[]) => any): (()=>void); inject(names: string[], callback: (ctx: any)=>any): any; logger?: { warn(...args: any[]): void }; [key: string]: any }

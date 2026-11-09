export type Route = { provider: string; model: string };
export type Rates = { input: number; cached: number; output: number };
export interface Settings {
  model: Route | null; priceRoute: Route | null; prices: Rates | null;
  unit: string; pointsPerYuan: number | null; dailyLimit: number;
  observeEnabled: boolean; observeSince: number; excludedSessions: string[]; excludedWorkspaces: string[];
  backgroundEnabled: boolean; proactiveEnabled: boolean; quiet: boolean;
  skin: string | null;
  embedding?: EmbeddingSettings | null;
}
export interface EmbeddingSettings { enabled: boolean; endpoint: string; model: string; dimensions: number; inputPrice: number; unit: string; unitsPerYuan: number | null }
export interface EmbeddingStatus { configured: boolean; checked: boolean; reason: string; routeKey: string | null; indexed: number; total: number; pending: number }
export interface Companion { id: string; name: string; mood: string; createdAt: number; moodEvidence?: { at: number; reason: string; sourceIds: string[] } }
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
  parentId?: string; start?: number; end?: number;
  provenance?: 'user_statement' | 'exchange' | 'behavior' | 'observation' | 'ui_event';
}
export type MemoryKind = 'user_fact' | 'shared_episode' | 'observed_dialogue' | 'understanding' | 'tendency';
export interface Evidence { sourceId: string; quote: string; start?: number; end?: number }
export interface Memory { id: string; kind: MemoryKind; text: string; sourceIds: string[]; createdAt: number; updatedAt: number; version?: number; evidence?: Evidence[]; counterEvidence?: Evidence[]; parentMemoryIds?: string[]; status?: 'active' | 'uncertain' | 'superseded'; validFrom?: number; validTo?: number | null; reinforcedAt?: number; boundary?: boolean; topicKey?: string; recallState?: 'active' | 'uncertain' | 'dormant' | 'superseded' }
export interface MemoryInput { kind: MemoryKind; text: string; sourceIds: string[]; evidence?: Evidence[]; counterEvidence?: Evidence[]; parentMemoryIds?: string[]; status?: Memory['status']; validFrom?: number; validTo?: number | null; boundary?: boolean; topicKey?: string }
export interface MemoryRelation { id: string; fromId: string; toId: string; kind: 'related' | 'same_event' | 'supports' | 'contradicts' | 'updates' | 'derived_from'; evidence: Evidence[]; createdAt: number }
export interface RecallHit { memory: Memory; score: number; reasons: string[] }
export interface RecallResult { hits: RecallHit[]; mode: 'hybrid' | 'local'; reason?: string }
export interface MemoryQuery { query?: string; kind?: MemoryKind; state?: string; from?: number; to?: number; offset?: number; limit?: number }
export interface MemoryPage { items: Memory[]; total: number; offset: number; limit: number; mode: 'hybrid' | 'local'; reason?: string }
export interface MemoryDetail { memory: Memory; sources: Source[]; relations: MemoryRelation[]; related: Memory[]; history: Memory[] }
export interface DeletePreview { ids: string[]; memories: Memory[]; sourceIds: string[]; revision: number }
export interface PersonalityProfile { initial: string[]; tentative: Memory[]; tendencies: Memory[] }
export interface CostDetails { provider: string; model: string; rawUnit: string; conversionRate: number; priceVerified: boolean; rawReserved?: number; rawActual?: number | null; inputTokens?: number; outputTokens?: number; cachedTokens?: number }
export interface Job { id: string; kind: 'chat' | 'memory' | 'proactive' | 'embedding'; status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'skipped'; stage: string; reason: string; createdAt: number; updatedAt: number; sourceIds: string[] }
export interface Ledger { unit?: string; id: string; day: string; jobId: string; background: boolean; reserved: number; actual: number | null; status: 'reserved' | 'settled' | 'uncertain'; createdAt: number; details?: CostDetails; budgetAcknowledgedAt?: number; budgetScope?: 'bilibili' }
export interface Usage { day: string; spent: number; reserved: number; estimated?: number; uncertain: boolean; chatSpent: number; chatUncertain?: boolean; limit: number; unit: string }
export interface Interaction { id: string; type: 'pet' | 'feed'; text: string; createdAt: number }
export interface ModelInfo extends Route { name: string; vision: boolean }
export interface Presence { windowId: string; visible: boolean; typing: boolean; lastInputAt: number; panelOpen: boolean; at: number }
export interface Snapshot {
  token?: string; ledger?: Ledger[]; companion: Companion; settings: Settings; messages: Message[]; memories: Memory[]; sources: Source[];
  interactions: Interaction[]; jobs: Job[]; usage: Usage; models: ModelInfo[]; busy: boolean; unread: number;
  error: string | null; capability: { chat: boolean; images: boolean }; revision: number;
  embedding?: EmbeddingStatus;
  budgetBlockers?: Ledger[];
  budgetUsage?: Usage;
}
export interface HostContext { get(name: string): any; on(name: string, callback: (...args: any[]) => any): (()=>void); inject(names: string[], callback: (ctx: any)=>any): any; logger?: { warn(...args: any[]): void }; [key: string]: any }

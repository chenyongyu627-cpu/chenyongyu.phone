import Dexie from "dexie";

// ── Types ──────────────────────────────────────

export type DwellingPosition =
    | "top-left" | "top-center" | "top-right"
    | "center-left" | "center" | "center-right"
    | "bottom-left" | "bottom-center" | "bottom-right";

export type DwellingFurnitureItem = {
    id: string;
    name: string;
    preview: string;
};

export type DwellingMarker = { x: number; y: number };

export type DwellingFurniture = {
    id: string;
    icon: string;
    label: string;
    /** 英文名（大写，标注幽灵字），旧数据可能没有 */
    en?: string;
    position: DwellingPosition;
    /** 归一化标注点坐标 0~1，旧数据没有时按 position 兜底 */
    marker?: DwellingMarker;
    items: DwellingFurnitureItem[];
};

export type DwellingRoom = {
    id: string;
    name: string;
    /** 英文名（大写，页签副标），旧数据可能没有 */
    en?: string;
    description: string;
    /** 生图构图描述（与家具布局同源） */
    imagePrompt?: string;
    /** 已生成房间图的媒体引用 */
    imageAssetId?: string;
    furniture: DwellingFurniture[];
};

// ── 情绪系统 ──
export type DwellingMood = "happy" | "calm" | "sleepy" | "annoyed" | "shy" | "excited" | "melancholy";
export type DwellingMoodState = { mood: DwellingMood; intensity: number; updatedAt: number; recentInteractions: number; };

// ── 冰箱便签 ──
export type DwellingNote = { id: string; from: "user" | "char"; content: string; createdAt: string; charReply?: string; charRepliedAt?: string; };

// ── 季节 & 天气 ──
export type DwellingSeason = "spring" | "summer" | "autumn" | "winter";
export type DwellingWeather = "sunny" | "cloudy" | "rainy" | "snowy" | "stormy" | "foggy";
export function getCurrentSeason(): DwellingSeason { const m = new Date().getMonth(); if (m >= 2 && m <= 4) return "spring"; if (m >= 5 && m <= 7) return "summer"; if (m >= 8 && m <= 10) return "autumn"; return "winter"; }
const WEATHER_POOL: Record<DwellingSeason, DwellingWeather[]> = { spring: ["sunny","cloudy","rainy","foggy","sunny","cloudy"], summer: ["sunny","sunny","cloudy","rainy","stormy","sunny"], autumn: ["cloudy","sunny","rainy","foggy","cloudy","sunny"], winter: ["cloudy","snowy","sunny","foggy","snowy","cloudy"] };
export function getTodayWeather(): DwellingWeather { const d = new Date(); const seed = d.getFullYear() * 10000 + (d.getMonth()+1) * 100 + d.getDate(); const pool = WEATHER_POOL[getCurrentSeason()]; return pool[seed % pool.length]; }
export const SEASON_LABELS: Record<DwellingSeason, string> = { spring: "春", summer: "夏", autumn: "秋", winter: "冬" };
export const WEATHER_LABELS: Record<DwellingWeather, string> = { sunny: "☀ 晴", cloudy: "☁ 多云", rainy: "🌧 雨", snowy: "❄ 雪", stormy: "⛈ 暴雨", foggy: "🌫 雾" };

// ── 纪念日 ──
export function getCohabitDays(agreedAt?: string): number { if (!agreedAt) return 0; return Math.floor((Date.now() - new Date(agreedAt).getTime()) / 86400000); }
export const ANNIVERSARY_MILESTONES = [1, 7, 30, 50, 100, 200, 365] as const;
export function checkAnniversary(agreedAt?: string): number | null { const days = getCohabitDays(agreedAt); return ANNIVERSARY_MILESTONES.includes(days as any) ? days : null; }

// ── 随机事件池 ──
type TimeSlot = "dawn" | "morning" | "noon" | "afternoon" | "evening" | "night" | "latenight";
export type DwellingRandomEvent = { id: string; name: string; description: string; weight: number; minDays: number; timeSlots?: TimeSlot[]; weather?: DwellingWeather[]; season?: DwellingSeason[]; };
export const RANDOM_EVENT_POOL: DwellingRandomEvent[] = [
    { id: "candlelight_dinner", name: "烛光晚餐", description: "角色提议今晚来一顿烛光晚餐，亲手布置了餐桌", weight: 0.12, minDays: 3, timeSlots: ["evening","night"] },
    { id: "deep_talk", name: "深夜长谈", description: "夜深了，两人靠在沙发上聊起了心里话", weight: 0.15, minDays: 5, timeSlots: ["night","latenight"] },
    { id: "intimate", name: "亲密时刻", description: "气氛变得暧昧，你们之间的距离越来越近…", weight: 0.08, minDays: 14, timeSlots: ["night","latenight"] },
    { id: "rainy_cuddle", name: "雨天窝在一起", description: "外面下着雨，你们裹着毯子窝在沙发上", weight: 0.15, minDays: 2, weather: ["rainy","stormy"] },
    { id: "morning_surprise", name: "早安惊喜", description: "你醒来时发现角色已经准备好了早餐", weight: 0.12, minDays: 3, timeSlots: ["dawn","morning"] },
    { id: "snow_window", name: "窗边看雪", description: "窗外飘起了雪，角色喊你一起来看", weight: 0.18, minDays: 1, weather: ["snowy"] },
    { id: "sudden_hug", name: "突然的拥抱", description: "角色从背后抱住了你，没有说话", weight: 0.1, minDays: 7 },
    { id: "midnight_snack", name: "半夜觅食", description: "你们一起偷偷溜进厨房做了碗泡面", weight: 0.13, minDays: 3, timeSlots: ["latenight"] },
    { id: "photo_together", name: "一起自拍", description: "角色突然掏出手机说要拍一张合照", weight: 0.1, minDays: 2 },
    { id: "lazy_afternoon", name: "慵懒午后", description: "阳光从窗帘缝隙洒进来，你们都不想动", weight: 0.14, minDays: 1, timeSlots: ["afternoon"], weather: ["sunny"] },
    { id: "bath_together", name: "一起泡澡", description: "角色问你要不要一起泡个澡放松一下", weight: 0.07, minDays: 21, timeSlots: ["night"] },
    { id: "nightmare", name: "做了噩梦", description: "深夜角色被噩梦惊醒，靠近了你", weight: 0.08, minDays: 7, timeSlots: ["latenight"] },
    { id: "dance", name: "客厅尬舞", description: "音乐响起来，角色拉着你在客厅跳了起来", weight: 0.06, minDays: 10, timeSlots: ["evening","night"] },
    { id: "stargazing", name: "阳台看星星", description: "夜晚天空格外清澈，你们在阳台仰望星空", weight: 0.1, minDays: 5, timeSlots: ["night","latenight"], weather: ["sunny"] },
    { id: "jealous_moment", name: "小小吃醋", description: "角色看了眼你的手机，撇了撇嘴", weight: 0.08, minDays: 14 },
    { id: "fog_morning", name: "雾中散步", description: "清晨起了浓雾，角色想和你出门走走", weight: 0.1, minDays: 3, timeSlots: ["dawn","morning"], weather: ["foggy"] },
];

function getTimeSlot(): TimeSlot { const h = new Date().getHours(); if (h >= 5 && h < 7) return "dawn"; if (h >= 7 && h < 9) return "morning"; if (h >= 9 && h < 12) return "noon"; if (h >= 12 && h < 17) return "afternoon"; if (h >= 17 && h < 20) return "evening"; if (h >= 20 && h < 24) return "night"; return "latenight"; }

export function rollRandomEvent(cohabitDays: number, triggerChance: number = 0.3): DwellingRandomEvent | null {
    if (Math.random() > triggerChance) return null;
    const slot = getTimeSlot(); const weather = getTodayWeather(); const season = getCurrentSeason();
    const eligible = RANDOM_EVENT_POOL.filter(e => { if (cohabitDays < e.minDays) return false; if (e.timeSlots && !e.timeSlots.includes(slot)) return false; if (e.weather && !e.weather.includes(weather)) return false; if (e.season && !e.season.includes(season)) return false; return true; });
    if (!eligible.length) return null;
    const totalWeight = eligible.reduce((s, e) => s + e.weight, 0); let r = Math.random() * totalWeight;
    for (const e of eligible) { r -= e.weight; if (r <= 0) return e; }
    return eligible[eligible.length - 1];
}

// ── 同居状态 ──
export type DwellingCohabitation = { enabled: boolean; agreedAt?: string; currentRoomId?: string; currentActivity?: string; lastActivityUpdate?: number; mood?: DwellingMoodState; notes?: DwellingNote[]; todayEventIds?: string[]; todayEventDate?: string; };

export type DwellingLayout = { rooms: DwellingRoom[]; cohabitation?: DwellingCohabitation; };

// ── 角色作息轮转 ──
const ROOM_SCHEDULE: Record<string, Partial<Record<TimeSlot, string>>> = {
    "玄关": { morning: "在玄关整理出门的东西", evening: "刚回来，正在换鞋" },
    "厨房": { dawn: "在厨房烧水准备早餐", morning: "在收拾厨房", noon: "在准备午餐", evening: "在做晚饭" },
    "客厅": { afternoon: "窝在沙发上看手机", night: "靠在沙发上看电视" },
    "卧室": { latenight: "已经睡下了", dawn: "还没完全醒来" },
    "书房": { noon: "在书房安静地看书", afternoon: "在书桌前写着什么", night: "开着台灯翻书" },
    "阳台": { morning: "在阳台晒太阳", evening: "在阳台看日落" },
    "浴室": { night: "在洗澡", morning: "在洗漱" },
};
const WEATHER_ACTIVITY_MODIFIERS: Partial<Record<DwellingWeather, Record<string, string>>> = {
    rainy: { "客厅": "听着雨声窝在沙发上", "卧室": "听着窗外的雨声发呆", "阳台": "站在阳台看雨" },
    snowy: { "客厅": "裹着毯子窝在暖气旁", "阳台": "趴在窗边看雪" },
    stormy: { "客厅": "缩在沙发上有些不安", "卧室": "把自己裹进了被子里" },
};

export function refreshCharacterLocation(layout: DwellingLayout): boolean {
    if (!layout.cohabitation?.enabled) return false;
    const slot = getTimeSlot(); const weather = getTodayWeather(); const rooms = layout.rooms;
    if (!rooms.length) return false;
    let bestRoom: DwellingRoom | null = null; let bestActivity = "";
    const weatherMod = WEATHER_ACTIVITY_MODIFIERS[weather];
    if (weatherMod) { for (const room of rooms) { for (const [kw, act] of Object.entries(weatherMod)) { if (room.name.includes(kw)) { bestRoom = room; bestActivity = act; break; } } if (bestRoom) break; } }
    if (!bestRoom) { for (const room of rooms) { for (const [kw, schedule] of Object.entries(ROOM_SCHEDULE)) { if (room.name.includes(kw) && schedule[slot]) { bestRoom = room; bestActivity = schedule[slot]!; break; } } if (bestRoom) break; } }
    if (!bestRoom) { const idx = (new Date().getHours() * 7) % rooms.length; bestRoom = rooms[idx]; const g: Record<TimeSlot, string> = { dawn: "似乎还在半梦半醒", morning: "在发呆", noon: "安静待着", afternoon: "在做自己的事", evening: "正看着窗外", night: "安静待在这里", latenight: "还没有睡" }; bestActivity = g[slot]; }
    const mood = layout.cohabitation.mood;
    if (mood && mood.intensity > 0.5) { const ms: Partial<Record<DwellingMood, string>> = { happy: "，看起来心情不错", sleepy: "，有些犯困的样子", annoyed: "，表情有点不耐烦", shy: "，耳朵微微泛红", melancholy: "，望着远处出神", excited: "，眼里带着光" }; if (ms[mood.mood]) bestActivity += ms[mood.mood]; }
    const changed = layout.cohabitation.currentRoomId !== bestRoom.id || layout.cohabitation.currentActivity !== bestActivity;
    layout.cohabitation.currentRoomId = bestRoom.id; layout.cohabitation.currentActivity = bestActivity; layout.cohabitation.lastActivityUpdate = Date.now();
    return changed;
}

// ── 情绪计算 ──
export function computeMood(cohabitation: DwellingCohabitation): DwellingMoodState {
    const prev = cohabitation.mood; const interactions = prev?.recentInteractions ?? 0; const h = new Date().getHours();
    let mood: DwellingMood = "calm"; let intensity = 0.5;
    if (interactions >= 8) { mood = "happy"; intensity = 0.8; } else if (interactions >= 5) { mood = "happy"; intensity = 0.6; } else if (interactions >= 3) { mood = "calm"; intensity = 0.5; } else if (interactions <= 1 && h >= 20) { mood = "melancholy"; intensity = 0.6; } else if (interactions === 0) { mood = "sleepy"; intensity = 0.4; }
    if (h >= 23 || h < 5) { mood = "sleepy"; intensity = Math.max(intensity, 0.7); }
    return { mood, intensity, updatedAt: Date.now(), recentInteractions: interactions };
}
export function incrementInteractionCount(cohabitation: DwellingCohabitation): void {
    if (!cohabitation.mood) { cohabitation.mood = { mood: "calm", intensity: 0.5, updatedAt: Date.now(), recentInteractions: 1 }; } else { cohabitation.mood.recentInteractions += 1; }
    cohabitation.mood = computeMood(cohabitation);
}
export const MOOD_LABELS: Record<DwellingMood, string> = { happy: "😊 开心", calm: "😌 平静", sleepy: "😴 犯困", annoyed: "😤 不耐烦", shy: "☺️ 害羞", excited: "✨ 兴奋", melancholy: "🌙 惆怅" };

// ── IndexedDB (Dexie) ─────────────────────────

type DwellingLayoutRow = {
    characterId: string;
    data: DwellingLayout;
    updatedAt: string;
};

type DwellingItemHtmlRow = {
    id: string;           // `${characterId}_${roomId}_${itemId}`
    characterId: string;
    html: string;
};

class DwellingDatabase extends Dexie {
    layouts!: Dexie.Table<DwellingLayoutRow, string>;
    itemHtml!: Dexie.Table<DwellingItemHtmlRow, string>;

    constructor() {
        super("AiPhoneDwellingDB");
        this.version(3).stores({
            layouts: "characterId",
            itemHtml: "id, characterId",
        });
    }
}

const db = new DwellingDatabase();

// ── In-memory cache ───────────────────────────

type CachedLayout = { layout: DwellingLayout; updatedAt: string };
const _layoutCache: Map<string, CachedLayout> = new Map();
const _itemHtmlCache: Map<string, string> = new Map(); // key: `${charId}_${roomId}_${itemId}`

// ── Hydrate on app start ──────────────────────

let _hydrated = false;

export async function hydrateDwellingStorage(): Promise<void> {
    if (_hydrated || typeof window === "undefined") return;
    _hydrated = true;
    try {
        const [allLayouts, allHtml] = await Promise.all([
            db.layouts.toArray(),
            db.itemHtml.toArray(),
        ]);
        for (const row of allLayouts) _layoutCache.set(row.characterId, { layout: row.data, updatedAt: row.updatedAt });
        for (const row of allHtml) _itemHtmlCache.set(row.id, row.html);
    } catch (e) {
        console.warn("[DwellingStorage] hydrate error:", e);
    }
}

// ── Sync cache read (for prompt injection) ────

export function readDwellingLayoutCache(characterId: string): CachedLayout | null {
    return _layoutCache.get(characterId) ?? null;
}

// ── Layout CRUD ───────────────────────────────

export async function loadDwellingLayout(characterId: string): Promise<CachedLayout | null> {
    const cached = _layoutCache.get(characterId);
    if (cached) return cached;

    try {
        const row = await db.layouts.get(characterId);
        if (row) {
            const entry = { layout: row.data, updatedAt: row.updatedAt };
            _layoutCache.set(characterId, entry);
            return entry;
        }
    } catch (e) {
        console.warn("[DwellingStorage] loadLayout error:", e);
    }
    return null;
}

/** List every character's dwelling layout (for storage-space scanning/cleanup). */
export async function listDwellingLayouts(): Promise<Array<{ characterId: string; layout: DwellingLayout }>> {
    try {
        const rows = await db.layouts.toArray();
        return rows.map((row) => ({ characterId: row.characterId, layout: row.data }));
    } catch (e) {
        console.warn("[DwellingStorage] listLayouts error:", e);
        return [];
    }
}

export async function saveDwellingLayout(characterId: string, layout: DwellingLayout): Promise<void> {
    const updatedAt = new Date().toISOString();
    _layoutCache.set(characterId, { layout, updatedAt });
    try {
        await db.layouts.put({
            characterId,
            data: layout,
            updatedAt,
        });
    } catch (e) {
        console.warn("[DwellingStorage] saveLayout error:", e);
    }
}

// ── Clear data for a character ────────────────

export async function clearDwellingData(characterId: string): Promise<void> {
    _layoutCache.delete(characterId);
    // Clear item HTML cache for this character
    for (const key of _itemHtmlCache.keys()) {
        if (key.startsWith(characterId + "_")) _itemHtmlCache.delete(key);
    }
    try {
        await Promise.all([
            db.layouts.delete(characterId),
            db.itemHtml.where("characterId").equals(characterId).delete(),
        ]);
    } catch (e) {
        console.warn("[DwellingStorage] clearData error:", e);
    }
}

// ── Item HTML CRUD ────────────────────────────

function htmlKey(characterId: string, roomId: string, itemId: string) {
    return `${characterId}_${roomId}_${itemId}`;
}

export function readItemHtmlCache(characterId: string, roomId: string, itemId: string): string | null {
    return _itemHtmlCache.get(htmlKey(characterId, roomId, itemId)) ?? null;
}

export async function saveItemHtml(characterId: string, roomId: string, itemId: string, html: string): Promise<void> {
    const key = htmlKey(characterId, roomId, itemId);
    _itemHtmlCache.set(key, html);
    try {
        await db.itemHtml.put({ id: key, characterId, html });
    } catch (e) {
        console.warn("[DwellingStorage] saveItemHtml error:", e);
    }
}

/** Load all item HTML for a character into a map keyed by `${roomId}_${itemId}` */
export function loadAllItemHtmlForChar(characterId: string): Record<string, string> {
    const result: Record<string, string> = {};
    const prefix = characterId + "_";
    for (const [key, html] of _itemHtmlCache.entries()) {
        if (key.startsWith(prefix)) {
            // key is `${charId}_${roomId}_${itemId}`, strip charId prefix
            result[key.slice(prefix.length)] = html;
        }
    }
    return result;
}

// ── Dwelling image generation toggle ──────────

const DWELLING_IMAGE_TOGGLE_KEY = "dwelling_image_gen_enabled";

export function loadDwellingImageEnabled(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return localStorage.getItem(DWELLING_IMAGE_TOGGLE_KEY) !== "0";
    } catch {
        return true;
    }
}

export function saveDwellingImageEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(DWELLING_IMAGE_TOGGLE_KEY, enabled ? "1" : "0");
    } catch { /* ignore */ }
}

/** Collect all room image media refs in a layout (for cleanup before delete/rebuild) */
export function collectRoomImageRefs(layout: DwellingLayout | null | undefined): string[] {
    if (!layout) return [];
    return layout.rooms.map(r => r.imageAssetId).filter((v): v is string => Boolean(v));
}

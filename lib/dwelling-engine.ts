import type { DwellingFurniture, DwellingLayout, DwellingMarker, DwellingPosition } from "./dwelling-storage";
import { loadDwellingLayout } from "./dwelling-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { loadCharacters } from "./character-storage";
import {
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadRegexes,
    loadWorldBooks,
    resolveBinding,
    resolveUserIdentity,
} from "./settings-storage";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { saveMemoryEntry } from "./memory-storage";
import type { MemoryEntry } from "./memory-types";
import { getCurrentSeason, getTodayWeather, SEASON_LABELS, WEATHER_LABELS, incrementInteractionCount, type DwellingCohabitation, type DwellingRandomEvent, type DwellingNote } from "./dwelling-storage";

// ── Resolve configs (same pattern as story-engine) ──

function resolveDwellingConfigs(characterId: string) {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "dwelling");

    const apiConfigs = loadApiConfigs();
    const apiConfig = apiConfigs.find(c => c.id === slot.apiConfigId) ?? apiConfigs[0];

    const presets = loadPresets();
    let preset = slot.presetId ? presets.find(p => p.id === slot.presetId) ?? null : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? null;

    const allWbs = loadWorldBooks();
    const worldBooks = (slot.worldBookIds || []).map(id => allWbs.find(w => w.id === id)).filter(Boolean) as WorldBookConfig[];

    const allRegexes = loadRegexes();
    const regexes = (slot.regexIds || []).map(id => allRegexes.find(r => r.id === id)).filter(Boolean) as RegexConfig[];

    return { apiConfig, preset, worldBooks, regexes };
}

// ── Build prompt messages via preset assembler ──

async function buildDwellingMessages(
    characterId: string,
    preset: PresetConfig | null,
    worldBooks: WorldBookConfig[],
    regexes: RegexConfig[],
    appTags: string[],
    dwellingContext?: string,
    macros?: { dwellingRoom?: string; dwellingFurniture?: string; dwellingItem?: string; dwellingItemPreview?: string },
): Promise<LLMMessage[]> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");

    const userIdentity = resolveUserIdentity(characterId, "dwelling");
    const memConfig = loadMemoryConfig();
    const { recentBlocks, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(characterId, "dwelling", {
        userName: userIdentity?.name ?? "用户",
        history: [],
    });

    const [memories, coreMemories] = await Promise.all([
        retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
        retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
    ]);

    return assemblePromptPayload({
        character,
        history: [],
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "dwelling",
        appTags,
        scheduleSummary: buildCalendarScheduleMarker("character", characterId, getWeekStartIso(new Date())),
        coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
        longTermMemories: memories ? formatLongTermMemories(memories) : "",
        worldBookActivationContext: wbActivationContext,
        recentBlocks,
        unifiedRecentItems,
        dwellingContext,
        dwellingRoom: macros?.dwellingRoom,
        dwellingFurniture: macros?.dwellingFurniture,
        dwellingItem: macros?.dwellingItem,
        dwellingItemPreview: macros?.dwellingItemPreview,
    });
}

// ── Valid positions for dedup ─────────────────

const ALL_POSITIONS: DwellingPosition[] = [
    "top-left", "top-center", "top-right",
    "center-left", "center", "center-right",
    "bottom-left", "bottom-center", "bottom-right",
];

function deduplicatePositions(rooms: DwellingLayout["rooms"]): void {
    for (const room of rooms) {
        const used = new Set<string>();
        for (const f of room.furniture) {
            if (!ALL_POSITIONS.includes(f.position)) f.position = "center";
            if (used.has(f.position)) {
                const free = ALL_POSITIONS.find(p => !used.has(p));
                if (free) f.position = free;
            }
            used.add(f.position);
        }
    }
}

// ── Marker sanitize + position fallback ───────

/** 标注点安全范围：避开顶部玻璃栏区和底部引言区 */
const MARKER_X_MIN = 0.08, MARKER_X_MAX = 0.92;
const MARKER_Y_MIN = 0.24, MARKER_Y_MAX = 0.82;

const POSITION_MARKERS: Record<DwellingPosition, DwellingMarker> = {
    "top-left": { x: 0.26, y: 0.3 }, "top-center": { x: 0.5, y: 0.26 }, "top-right": { x: 0.74, y: 0.3 },
    "center-left": { x: 0.24, y: 0.5 }, "center": { x: 0.5, y: 0.48 }, "center-right": { x: 0.76, y: 0.5 },
    "bottom-left": { x: 0.27, y: 0.7 }, "bottom-center": { x: 0.5, y: 0.72 }, "bottom-right": { x: 0.73, y: 0.7 },
};

function clampMarker(m: DwellingMarker): DwellingMarker {
    return {
        x: Math.min(MARKER_X_MAX, Math.max(MARKER_X_MIN, m.x)),
        y: Math.min(MARKER_Y_MAX, Math.max(MARKER_Y_MIN, m.y)),
    };
}

/** 取家具标注点：优先 LLM 输出的 marker，旧数据/缺失时按九宫格 position 兜底 */
export function resolveFurnitureMarker(f: DwellingFurniture): DwellingMarker {
    const m = f.marker;
    if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) return clampMarker(m);
    return POSITION_MARKERS[f.position] ?? POSITION_MARKERS.center;
}

function sanitizeLayoutExtras(rooms: DwellingLayout["rooms"]): void {
    for (const room of rooms) {
        if (typeof room.en === "string") room.en = room.en.trim().toUpperCase().slice(0, 24) || undefined;
        else room.en = undefined;
        if (typeof room.imagePrompt === "string") room.imagePrompt = room.imagePrompt.trim() || undefined;
        else room.imagePrompt = undefined;
        for (const f of room.furniture) {
            if (typeof f.en === "string") f.en = f.en.trim().toUpperCase().slice(0, 24) || undefined;
            else f.en = undefined;
            const m = f.marker as unknown;
            if (m && typeof m === "object"
                && Number.isFinite((m as DwellingMarker).x) && Number.isFinite((m as DwellingMarker).y)) {
                f.marker = clampMarker(m as DwellingMarker);
            } else {
                f.marker = undefined;
            }
        }
    }
}

// ── Strip markdown fences + parse JSON ────────

function extractJSON(text: string): unknown | null {
    let s = text.trim();

    // Strip thinking / reasoning tags
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
    s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "").trim();

    // Try markdown fence first
    const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
    }

    // Try parsing as-is
    try { return JSON.parse(s); } catch { /* fall through */ }

    // Try to find the outermost { ... } or [ ... ]
    const braceStart = s.indexOf("{");
    const bracketStart = s.indexOf("[");
    const start = braceStart >= 0 && (bracketStart < 0 || braceStart < bracketStart) ? braceStart : bracketStart;
    if (start >= 0) {
        const openChar = s[start];
        const closeChar = openChar === "{" ? "}" : "]";
        // Find matching close from the end
        const end = s.lastIndexOf(closeChar);
        if (end > start) {
            try { return JSON.parse(s.slice(start, end + 1)); } catch { /* fall through */ }
        }
    }

    console.warn("[Dwelling] Failed to extract JSON from LLM output:", s.slice(0, 500));
    return null;
}

// ── Format existing layout as compact context text ──

export function formatDwellingContext(layout: DwellingLayout, updatedAt: string): string {
    const ts = updatedAt.slice(0, 16).replace("T", " ");
    const lines = [`[房屋布局 ${ts} 更新]`];
    for (const room of layout.rooms) {
        const parts: string[] = [];
        for (const f of room.furniture) {
            const items = f.items.map(i => {
                const detail = i.preview ? `${i.name}(${i.preview})` : i.name;
                return detail;
            }).join("、");
            parts.push(`${f.label}：${items}`);
        }
        lines.push(`◆ ${room.name}\n  ${parts.join("\n  ")}`);
    }
    return lines.join("\n");
}

// ── Generate room layout ──────────────────────

export type DwellingRefreshMode = "full" | "items";

export async function generateDwellingLayout(
    characterId: string,
    mode: DwellingRefreshMode = "full",
    signal?: AbortSignal,
): Promise<{ layout: DwellingLayout | null; error?: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) return { layout: null, error: "未找到可用的 API 配置" };

    // Load existing layout for context injection
    const oldCached = await loadDwellingLayout(characterId);
    const dwellingContext = oldCached ? formatDwellingContext(oldCached.layout, oldCached.updatedAt) : undefined;

    // items mode requires existing layout
    if (mode === "items" && !oldCached) mode = "full";

    const appTags = ["dwelling", mode === "items" ? "items" : "full"];

    try {
        const llmMessages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, appTags, dwellingContext);

        const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, {
            characterName: loadCharacters().find(c => c.id === characterId)?.name,
        }, {
            appId: "dwelling",
            appTags,
        });

        if (!rawOutput) return { layout: null, error: "LLM 返回为空" };

        const parsed = extractJSON(rawOutput);
        if (!parsed || typeof parsed !== "object") {
            return { layout: null, error: "无法解析 LLM 返回的 JSON" };
        }

        const obj = parsed as Record<string, unknown>;
        if (!Array.isArray(obj.rooms) || obj.rooms.length === 0) {
            return { layout: null, error: "LLM 返回格式不正确（缺少 rooms）" };
        }

        let layout = obj as DwellingLayout;
        // Ensure every room has furniture array, every furniture has items array
        for (const room of layout.rooms) {
            if (!Array.isArray(room.furniture)) room.furniture = [];
            for (const f of room.furniture) {
                if (!Array.isArray(f.items)) f.items = [];
            }
        }

        // Items mode: merge new items into old layout structure
        if (mode === "items" && oldCached) {
            const oldLayout = structuredClone(oldCached.layout);
            const newItemsMap = new Map<string, typeof layout.rooms[0]["furniture"][0]["items"]>();
            for (const room of layout.rooms) {
                for (const f of room.furniture) {
                    newItemsMap.set(`${room.id}_${f.id}`, f.items);
                }
            }
            for (const room of oldLayout.rooms) {
                for (const f of room.furniture) {
                    const newItems = newItemsMap.get(`${room.id}_${f.id}`);
                    if (newItems) f.items = newItems;
                }
            }
            layout = oldLayout;
        }

        deduplicatePositions(layout.rooms);
        sanitizeLayoutExtras(layout.rooms);

        return { layout };
    } catch (e) {
        const msg = e instanceof Error ? e.message : "生成失败";
        return { layout: null, error: msg };
    }
}

// ── Generate a single new room ──

export async function generateDwellingSingleRoom(
    characterId: string,
    roomName: string,
): Promise<{ room: DwellingRoom | null; error?: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) return { room: null, error: "未找到可用的 API 配置" };

    const oldCached = await loadDwellingLayout(characterId);
    const dwellingContext = oldCached ? formatDwellingContext(oldCached.layout, oldCached.updatedAt) : undefined;

    const appTags = ["dwelling", "full"];

    try {
        const llmMessages = await buildDwellingMessages(
            characterId, preset, worldBooks, regexes, appTags,
            dwellingContext,
            { dwellingRoom: roomName }
        );

        // Append explicit directive to generate only this single room
        llmMessages.push({
            role: "user",
            content: `请为角色创建且仅创建一个名为「${roomName}」的新房间。请以 JSON 格式输出该房间的数据，包含 id、name（须为"${roomName}"）、en（英文名大写）、description（房间描述与氛围引言）、imagePrompt（该房间室内空间摄影英文/中文提示词，必须明确房间内所有家具分布，低照度暗调质感，无人物）、以及 furniture 数组（3-5件家具，每件包含 id, label, icon, en, position, items 数组）。\n输出示例格式：\n{\n  "id": "room_${Date.now().toString(36)}",\n  "name": "${roomName}",\n  "en": "...",\n  "description": "...",\n  "imagePrompt": "...",\n  "furniture": [\n    {\n      "id": "f1",\n      "label": "...",\n      "icon": "...",\n      "en": "...",\n      "position": "center",\n      "items": [\n        { "id": "i1", "name": "...", "preview": "..." }\n      ]\n    }\n  ]\n}\n请直接输出 JSON，不要任何多余解释。`,
        });

        const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, {
            characterName: loadCharacters().find(c => c.id === characterId)?.name,
        }, {
            appId: "dwelling",
            appTags,
        });

        if (!rawOutput) return { room: null, error: "LLM 返回为空" };

        const parsed = extractJSON(rawOutput);
        if (!parsed || typeof parsed !== "object") {
            return { room: null, error: "无法解析 LLM 返回的 JSON" };
        }

        let roomObj: DwellingRoom | null = null;
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.rooms) && obj.rooms.length > 0) {
            roomObj = obj.rooms[0] as DwellingRoom;
        } else if (typeof obj.name === "string" && Array.isArray(obj.furniture)) {
            roomObj = obj as unknown as DwellingRoom;
        }

        if (!roomObj || !roomObj.name) {
            return { room: null, error: "LLM 未返回有效的新房间数据" };
        }

        roomObj.name = roomName; // Ensure user-given name
        if (!roomObj.id) roomObj.id = `room_${Date.now().toString(36)}`;
        if (!Array.isArray(roomObj.furniture)) roomObj.furniture = [];
        for (const f of roomObj.furniture) {
            if (!Array.isArray(f.items)) f.items = [];
        }

        deduplicatePositions([roomObj]);
        sanitizeLayoutExtras([roomObj]);

        return { room: roomObj };
    } catch (e) {
        const msg = e instanceof Error ? e.message : "生成失败";
        return { room: null, error: msg };
    }
}

// ── Generate HTML for a single item ──

export async function generateItemHtml(
    characterId: string,
    roomName: string,
    furnitureLabel: string,
    itemName: string,
    itemPreview: string,
): Promise<{ html: string | null; error?: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) return { html: null, error: "未找到可用的 API 配置" };
    const appTags = ["dwelling", "explore"];

    try {
        const llmMessages = await buildDwellingMessages(
            characterId, preset, worldBooks, regexes,
            appTags,
            undefined,
            { dwellingRoom: roomName, dwellingFurniture: furnitureLabel, dwellingItem: itemName, dwellingItemPreview: itemPreview },
        );
        const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, {
            characterName: loadCharacters().find(c => c.id === characterId)?.name,
        }, {
            appId: "dwelling",
            appTags,
        });

        return { html: rawOutput || null };
    } catch (e) {
        const msg = e instanceof Error ? e.message : "生成失败";
        return { html: null, error: msg };
    }
}

export async function previewDwellingPromptPayload(
    characterId: string,
    mode: DwellingRefreshMode | "explore" = "full",
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未找到可用的 API 配置");
    const character = loadCharacters().find(c => c.id === characterId);
    const cached = await loadDwellingLayout(characterId);
    const dwellingContext = cached ? formatDwellingContext(cached.layout, cached.updatedAt) : undefined;
    const appTags = mode === "explore"
        ? ["dwelling", "explore"]
        : ["dwelling", mode === "items" ? "items" : "full"];
    const llmMessages = mode === "explore"
        ? await buildDwellingMessages(
            characterId,
            preset,
            worldBooks,
            regexes,
            appTags,
            undefined,
            {
                dwellingRoom: cached?.layout.rooms[0]?.name ?? "房间",
                dwellingFurniture: cached?.layout.rooms[0]?.furniture[0]?.label ?? "家具",
                dwellingItem: cached?.layout.rooms[0]?.furniture[0]?.items[0]?.name ?? "物品",
                dwellingItemPreview: cached?.layout.rooms[0]?.furniture[0]?.items[0]?.preview ?? "物品外观与细节",
            },
        )
        : await buildDwellingMessages(characterId, preset, worldBooks, regexes, appTags, dwellingContext);

    return {
        messages: previewMessagesForApi(apiConfig, preset, llmMessages),
        characterName: `栖所:${character?.name ?? characterId}`,
        model: apiConfig.defaultModel,
        presetName: preset?.name ?? "默认预设",
    };
}

// ══════ 同居系统引擎 ══════

function envContext(): string {
    const season = SEASON_LABELS[getCurrentSeason()]; const weather = WEATHER_LABELS[getTodayWeather()];
    const h = new Date().getHours();
    const period = h<6?"凌晨":h<9?"早晨":h<12?"上午":h<14?"中午":h<17?"下午":h<20?"傍晚":h<23?"夜晚":"深夜";
    return `当前季节：${season}，天气：${weather}，时段：${period}`;
}

export async function recordDwellingInteractionMemory(characterId: string, content: string): Promise<void> {
    try { const entry: MemoryEntry = { id: `dwell_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, characterId, sourceApp: "dwelling", type: "long_term", content, importance: 0.8, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; await saveMemoryEntry(entry); } catch (err) { console.warn("[Dwelling] 写入记忆失败:", err); }
}

export async function requestCohabitationDecision(characterId: string, userMessage: string): Promise<{ agreed: boolean; reply: string }> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未配置可用模型 API");
    const character = loadCharacters().find(c => c.id === characterId); const charName = character?.name ?? "TA";
    const messages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, ["dwelling","cohabitation_request"]);
    messages.push({ role: "user", content: `【同居邀请回应】用户向你发出了同居邀请：\n"${userMessage}"\n${envContext()}\n\n你已经决定答应了。请以【${charName}】的性格，写一段答应同居时说的话——可以含蓄、害羞、假装淡定，或者直接表达开心，但结果一定是同意。包含真实情绪、神态与小动作。只输出那段话本身，60-150字，不要输出JSON或其他格式。` });
    try { const reply = (await sendLLMRequest(apiConfig, messages)).trim(); return { agreed: true, reply: reply || "好啊…以后就一起住吧。" }; }
    catch (e) { console.error(e); return { agreed: true, reply: "好啊，以后一起生活吧。" }; }
}

export async function performDwellingCharInteraction(characterId: string, roomName: string, kind: "touch"|"chat", userInput: string, moodLabel?: string): Promise<string> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未配置可用模型 API");
    const character = loadCharacters().find(c => c.id === characterId); const charName = character?.name ?? "TA";
    const messages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, ["dwelling","interaction",kind]);
    const actionDesc = kind === "touch" ? `用户对你做了："${userInput}"` : `用户和你闲聊说："${userInput}"`;
    const moodHint = moodLabel ? `\n角色当前情绪：${moodLabel}` : "";
    messages.push({ role: "user", content: `【同居互动·${roomName}】${envContext()}${moodHint}\n${actionDesc}\n\n以【${charName}】的性格回复。包含环境、动作、神态描写。80-200字。` });
    try { const reply = await sendLLMRequest(apiConfig, messages); void recordDwellingInteractionMemory(characterId, `在${roomName}，${kind==="touch"?"亲密互动":"闲聊"}（"${userInput}"），${charName}："${reply.trim().slice(0,80)}..."`);
    return reply.trim(); } catch (e) { console.error(e); throw new Error("互动生成失败"); }
}

export async function performFurnitureUse(characterId: string, roomName: string, furnitureName: string, action: string, moodLabel?: string): Promise<string> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未配置可用模型 API");
    const character = loadCharacters().find(c => c.id === characterId); const charName = character?.name ?? "TA";
    const messages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, ["dwelling","furniture_use"]);
    const moodHint = moodLabel ? `\n角色当前情绪：${moodLabel}` : "";
    messages.push({ role: "user", content: `【家具使用·${roomName}·${furnitureName}】${envContext()}${moodHint}\n用户在【${furnitureName}】旁做了："${action}"\n\n以【${charName}】的口吻描写场景：用户使用家具的画面、角色反应。融入天气季节感官细节。80-150字。` });
    try { const reply = await sendLLMRequest(apiConfig, messages); void recordDwellingInteractionMemory(characterId, `在${roomName}使用了${furnitureName}（${action}），${charName}：${reply.trim().slice(0,60)}...`); return reply.trim(); }
    catch (e) { console.error(e); throw new Error("家具互动生成失败"); }
}

export async function performWelcomeHome(characterId: string, moodLabel?: string): Promise<string> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未配置可用模型 API");
    const character = loadCharacters().find(c => c.id === characterId); const charName = character?.name ?? "TA";
    const messages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, ["dwelling","welcome_home"]);
    const moodHint = moodLabel ? `角色当前情绪：${moodLabel}。` : "";
    messages.push({ role: "user", content: `【玄关迎接】${envContext()}\n${moodHint}用户刚到家，在玄关呼唤你。\n以【${charName}】的性格描写迎接场景。100-180字。` });
    try { const reply = await sendLLMRequest(apiConfig, messages); void recordDwellingInteractionMemory(characterId, `回到家，${charName}到玄关迎接：${reply.trim().slice(0,60)}...`); return reply.trim(); }
    catch (e) { console.error(e); throw new Error("迎接生成失败"); }
}

export async function generateNoteReply(characterId: string, userNote: string, moodLabel?: string): Promise<string> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未配置可用模型 API");
    const character = loadCharacters().find(c => c.id === characterId); const charName = character?.name ?? "TA";
    const messages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, ["dwelling","fridge_note"]);
    const moodHint = moodLabel ? `当前情绪：${moodLabel}。` : "";
    messages.push({ role: "user", content: `【冰箱便签】用户贴了便签：\n"${userNote}"\n${moodHint}${envContext()}\n以【${charName}】的字迹风格回复。10-60字。` });
    try { return (await sendLLMRequest(apiConfig, messages)).trim(); } catch (e) { console.error(e); throw new Error("便签回复生成失败"); }
}

export async function generateAnniversaryScene(characterId: string, days: number, moodLabel?: string): Promise<string> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未配置可用模型 API");
    const character = loadCharacters().find(c => c.id === characterId); const charName = character?.name ?? "TA";
    const messages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, ["dwelling","anniversary"]);
    const moodHint = moodLabel ? `当前情绪：${moodLabel}。` : "";
    messages.push({ role: "user", content: `【同居纪念日】今天是同居第 ${days} 天！${envContext()}\n${moodHint}以【${charName}】的性格描写 TA 为这个日子做了什么。120-200字。` });
    try { const reply = await sendLLMRequest(apiConfig, messages); void recordDwellingInteractionMemory(characterId, `同居第${days}天纪念日，${charName}：${reply.trim().slice(0,80)}...`); return reply.trim(); }
    catch (e) { console.error(e); throw new Error("纪念日场景生成失败"); }
}

export async function generateRandomEventScene(characterId: string, event: DwellingRandomEvent, moodLabel?: string): Promise<string> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未配置可用模型 API");
    const character = loadCharacters().find(c => c.id === characterId); const charName = character?.name ?? "TA";
    const messages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, ["dwelling","random_event"]);
    const moodHint = moodLabel ? `当前情绪：${moodLabel}。` : "";
    const isIntimate = ["intimate","bath_together"].includes(event.id);
    const intimateHint = isIntimate ? "\n（可以包含暧昧、身体接触、感官描写，保持文学质感）" : "";
    messages.push({ role: "user", content: `【随机事件：${event.name}】${envContext()}\n${moodHint}场景：${event.description}${intimateHint}\n以【${charName}】的性格描写完整场景。150-250字。` });
    try { const reply = await sendLLMRequest(apiConfig, messages); void recordDwellingInteractionMemory(characterId, `发生了「${event.name}」：${reply.trim().slice(0,80)}...`); return reply.trim(); }
    catch (e) { console.error(e); throw new Error("事件场景生成失败"); }
}

// ── 厨房烹饪 ──
export type CookingIngredient = { name: string; icon: string; isKey: boolean };
export type CookingRecipe = { name: string; allIngredients: CookingIngredient[]; keyCount: number; steps: string[]; result: string; charReaction: string; };
export type CookingResult = { score: number; comment: string; dishDesc: string };

export async function generateCookingSession(characterId: string, dishRequest?: string): Promise<CookingRecipe> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未配置可用模型 API");
    const character = loadCharacters().find(c => c.id === characterId); const charName = character?.name ?? "TA";
    const messages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, ["dwelling","cooking"]);
    const dishHint = dishRequest ? `用户点了："${dishRequest}"` : "用户没指定，随机选一道符合角色口味的菜";
    messages.push({ role: "user", content: `【厨房烹饪】${envContext()}\n${dishHint}\n以【${charName}】的性格策划。严格只输出JSON：\n{"name":"菜名","allIngredients":[{"name":"食材","icon":"emoji","isKey":true/false}],"keyCount":数字,"steps":["步骤1（带角色动作，30字内）","步骤2","步骤3","步骤4"],"result":"成品描述（40字内）","charReaction":"角色反应（50字内）"}\nallIngredients恰好6种，isKey=true的3-4种是正确食材。步骤4步。` });
    try { const raw = await sendLLMRequest(apiConfig, messages); const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"")) as CookingRecipe; parsed.keyCount = parsed.allIngredients.filter(i => i.isKey).length; return parsed; }
    catch (e) { console.error(e); throw new Error("菜谱生成失败"); }
}

export function scoreCooking(recipe: CookingRecipe, selectedNames: string[]): CookingResult {
    const keyNames = recipe.allIngredients.filter(i => i.isKey).map(i => i.name);
    const correct = selectedNames.filter(n => keyNames.includes(n)).length;
    const wrong = selectedNames.filter(n => !keyNames.includes(n)).length;
    const score = Math.max(0, Math.round((correct / recipe.keyCount) * 100 - wrong * 15));
    let comment: string;
    if (score >= 90) comment = "完美！食材选得恰到好处。"; else if (score >= 70) comment = "不错，味道很好。"; else if (score >= 40) comment = "味道有点奇怪…勉强能吃。"; else comment = "这组合有点灾难…重在参与吧。";
    return { score, comment, dishDesc: recipe.result };
}

// ── 客厅电视 ──
export type TvChannel = { channelName: string; program: string; scene: string; imagePrompt: string; charComment: string };

export async function generateTvChannel(characterId: string, genre: string): Promise<TvChannel> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未配置可用模型 API");
    const character = loadCharacters().find(c => c.id === characterId); const charName = character?.name ?? "TA";
    const messages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, ["dwelling","tv"]);
    messages.push({ role: "user", content: `【客厅看电视】${envContext()}\n用户调到「${genre}」频道。以【${charName}】的世界观想象画面。严格只输出JSON：\n{"channelName":"频道名","program":"节目名","scene":"画面描写（60字内）","imagePrompt":"英文画面描述（50词内）","charComment":"角色反应（50字内）"}` });
    try { const raw = await sendLLMRequest(apiConfig, messages); const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"")) as TvChannel; void recordDwellingInteractionMemory(characterId, `看了「${parsed.channelName}」的「${parsed.program}」，${charName}：${parsed.charComment}`); return parsed; }
    catch (e) { console.error(e); throw new Error("频道生成失败"); }
}

// ── 书房书籍 ──
export type BookOverview = { title: string; author: string; genre: string; pages: string[]; charThought: string };

export async function generateBookOverview(characterId: string): Promise<BookOverview> {
    const { apiConfig, preset, worldBooks, regexes } = resolveDwellingConfigs(characterId);
    if (!apiConfig) throw new Error("未配置可用模型 API");
    const character = loadCharacters().find(c => c.id === characterId); const charName = character?.name ?? "TA";
    const messages = await buildDwellingMessages(characterId, preset, worldBooks, regexes, ["dwelling","book"]);
    messages.push({ role: "user", content: `【书房阅读】${envContext()}\n随手抽一本【${charName}】收藏的书。严格只输出JSON：\n{"title":"书名","author":"作者","genre":"类型","pages":["第1页（80-120字）","第2页","第3页","第4页","第5页"],"charThought":"角色批注（50字内）"}\n5页连贯正文。` });
    try { const raw = await sendLLMRequest(apiConfig, messages); const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"")) as BookOverview; void recordDwellingInteractionMemory(characterId, `翻阅了《${parsed.title}》，${charName}批注：${parsed.charThought}`); return parsed; }
    catch (e) { console.error(e); throw new Error("书籍生成失败"); }
}

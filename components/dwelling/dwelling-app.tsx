"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronLeft, RefreshCw, Trash2, Wand2, X, Plus, Heart, Home, StickyNote, Sparkles } from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import type { DwellingLayout, DwellingRoom, DwellingFurniture, DwellingFurnitureItem, DwellingNote, DwellingRandomEvent } from "@/lib/dwelling-storage";
import {
    loadDwellingLayout, saveDwellingLayout, clearDwellingData, saveItemHtml, loadAllItemHtmlForChar,
    loadDwellingImageEnabled, saveDwellingImageEnabled, collectRoomImageRefs,
    refreshCharacterLocation, incrementInteractionCount,
    getCurrentSeason, getTodayWeather, getCohabitDays, checkAnniversary, rollRandomEvent,
    SEASON_LABELS, WEATHER_LABELS, MOOD_LABELS, type DwellingMood,
} from "@/lib/dwelling-storage";
import {
    generateDwellingLayout, generateItemHtml, generateDwellingSingleRoom,
    requestCohabitationDecision, performDwellingCharInteraction, performFurnitureUse, performWelcomeHome,
    generateCookingSession, scoreCooking, generateTvChannel, generateBookOverview,
    generateNoteReply, generateAnniversaryScene, generateRandomEventScene, recordDwellingInteractionMemory,
    type CookingRecipe, type TvChannel, type BookOverview, type DwellingRefreshMode,
} from "@/lib/dwelling-engine";
import { pinyin } from "pinyin-pro";
import { getDwellingImageAvailability, generateDwellingRoomImage, cancelDwellingRoomImage } from "@/lib/dwelling-image";
import { deleteMediaRef, loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { RoomView, type DwellingRoomImageStatus } from "./room-view";
import { StoryHtmlRenderer } from "@/components/ui/story-html-renderer";

type DwellingAppProps = {
    onClose: () => void;
    visible?: boolean;
    onIdle?: () => void;
};

type CharState = {
    layout: DwellingLayout | null;
    isGenerating: boolean;
    error: string | null;
    loaded: boolean;
    itemHtmlCache: Record<string, string>;
    loadingItemKeys: Set<string>;
    lastItemError: string | null;
    /** roomId → 生图失败原因（存在时不再自动重试，需手动重试） */
    imageErrors: Record<string, string>;
    /** 正在生图的 roomId 集合 */
    generatingImageRooms: Set<string>;
};

type ItemDetail = {
    roomId: string;
    roomName: string;
    furnitureId: string;
    furnitureLabel: string;
    furnitureIcon: string;
    itemId: string;
    itemName: string;
    itemPreview: string;
    html: string;
};

const charStates = new Map<string, CharState>();

function getCharState(charId: string): CharState {
    let s = charStates.get(charId);
    if (!s) { s = { layout: null, isGenerating: false, error: null, loaded: false, itemHtmlCache: {}, loadingItemKeys: new Set(), lastItemError: null, imageErrors: {}, generatingImageRooms: new Set() }; charStates.set(charId, s); }
    return s;
}

function itemKey(roomId: string, itemId: string) { return `${roomId}_${itemId}`; }

/** mediaRef → object URL（会话级缓存，图不多，不主动 revoke） */
const roomImageUrls = new Map<string, string>();

/** 角色名 → 大写拼音（chip 下行幽灵字） */
const charEnCache = new Map<string, string>();
function charChipEn(name: string): string {
    let en = charEnCache.get(name);
    if (en === undefined) {
        try { en = pinyin(name, { toneType: "none" }).toUpperCase(); } catch { en = ""; }
        charEnCache.set(name, en);
    }
    return en;
}

export function DwellingApp({ onClose, visible, onIdle }: DwellingAppProps) {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [activeCharId, setActiveCharId] = useState<string | null>(null);
    const [activeRoomIdx, setActiveRoomIdx] = useState(0);
    const [, forceUpdate] = useState(0);
    const rerender = () => forceUpdate(n => n + 1);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
    const [itemDetail, setItemDetail] = useState<ItemDetail | null>(null);
    const [showAddRoomModal, setShowAddRoomModal] = useState(false);
    const [newRoomNameInput, setNewRoomNameInput] = useState("");
    const [isCreatingRoom, setIsCreatingRoom] = useState(false);
    const [imageEnabled, setImageEnabled] = useState(true);
    const [imageConfigured, setImageConfigured] = useState(false);
    const [showCohabitModal, setShowCohabitModal] = useState(false);
    const [cohabitMsgInput, setCohabitMsgInput] = useState("");
    const [isRequestingCohabit, setIsRequestingCohabit] = useState(false);
    const [cohabitReplyResult, setCohabitReplyResult] = useState<{ agreed: boolean; reply: string } | null>(null);
    const [showInteractModal, setShowInteractModal] = useState(false);
    const [interactTab, setInteractTab] = useState<"touch" | "chat">("touch");
    const [customTouchInput, setCustomTouchInput] = useState("");
    const [chatInput, setChatInput] = useState("");
    const [isInteracting, setIsInteracting] = useState(false);
    const [interactReply, setInteractReply] = useState<string | null>(null);
    const [interactError, setInteractError] = useState<string | null>(null);
    const [showFurnitureUseModal, setShowFurnitureUseModal] = useState(false);
    const [furnitureUseTarget, setFurnitureUseTarget] = useState<{ roomName: string; furnitureName: string } | null>(null);
    const [furnitureUseInput, setFurnitureUseInput] = useState("");
    const [furnitureUseReply, setFurnitureUseReply] = useState<string | null>(null);
    const [isFurnitureUsing, setIsFurnitureUsing] = useState(false);
    const [isWelcoming, setIsWelcoming] = useState(false);
    const [welcomeReply, setWelcomeReply] = useState<string | null>(null);
    const [showCookingModal, setShowCookingModal] = useState(false);
    const [cookingDishInput, setCookingDishInput] = useState("");
    const [cookingState, setCookingState] = useState<{ phase: "idle"|"generating"|"select"|"steps"|"done"; recipe: CookingRecipe | null; selected: string[]; stepIdx: number; score: number | null; scoreComment: string }>({ phase: "idle", recipe: null, selected: [], stepIdx: 0, score: null, scoreComment: "" });
    const [showTvModal, setShowTvModal] = useState(false);
    const [tvGenreInput, setTvGenreInput] = useState("");
    const [tvState, setTvState] = useState<{ phase: "idle"|"generating"|"done"; channel: TvChannel | null; error: string | null }>({ phase: "idle", channel: null, error: null });
    const [showBookModal, setShowBookModal] = useState(false);
    const [bookState, setBookState] = useState<{ phase: "idle"|"generating"|"reading"|"done"; book: BookOverview | null; pageIdx: number; error: string | null }>({ phase: "idle", book: null, pageIdx: 0, error: null });
    const [showNoteModal, setShowNoteModal] = useState(false);
    const [noteInput, setNoteInput] = useState("");
    const [isNoteReplying, setIsNoteReplying] = useState(false);
    const [activeEvent, setActiveEvent] = useState<{ kind: "event"|"anniversary"; event?: DwellingRandomEvent; days?: number } | null>(null);
    const [eventScene, setEventScene] = useState<string | null>(null);
    const [isEventLoading, setIsEventLoading] = useState(false);
    const eventCheckedRef = useRef(false);
    const activeCharIdRef = useRef<string | null>(null);
    const activeRoomIdxRef = useRef(0);

    useEffect(() => {
        setImageEnabled(loadDwellingImageEnabled());
        setImageConfigured(getDwellingImageAvailability().configured);
    }, []);

    useEffect(() => {
        // 用户可能中途去设置里配置了生图，回到栖所时重新判定
        if (visible) setImageConfigured(getDwellingImageAvailability().configured);
    }, [visible]);

    useEffect(() => {
        activeCharIdRef.current = activeCharId;
    }, [activeCharId]);

    useEffect(() => {
        activeRoomIdxRef.current = activeRoomIdx;
    }, [activeRoomIdx]);

    useEffect(() => {
        if (visible) {
            if (activeCharId) getCharState(activeCharId).error = null;
            rerender();
        }
    }, [visible, activeCharId]);

    useEffect(() => {
        if (!visible || !activeCharId) return;
        const cs = getCharState(activeCharId);
        if (cs.layout?.cohabitation?.enabled) { if (refreshCharacterLocation(cs.layout)) { void saveDwellingLayout(activeCharId, cs.layout); rerender(); } }
        const timer = setInterval(() => { const cid = activeCharIdRef.current; const csCur = cid ? getCharState(cid) : null; if (csCur?.layout?.cohabitation?.enabled && cid) { if (refreshCharacterLocation(csCur.layout)) { void saveDwellingLayout(cid, csCur.layout); rerender(); } } }, 5*60*1000);
        return () => clearInterval(timer);
    }, [visible, activeCharId]);

    useEffect(() => {
        if (!visible || !activeCharId || eventCheckedRef.current) return;
        const cs = getCharState(activeCharId); const cohab = cs.layout?.cohabitation;
        if (!cohab?.enabled) return; eventCheckedRef.current = true;
        const anniv = checkAnniversary(cohab.agreedAt);
        if (anniv) { setActiveEvent({ kind: "anniversary", days: anniv }); return; }
        const today = new Date().toISOString().slice(0,10); const days = getCohabitDays(cohab.agreedAt);
        const evt = rollRandomEvent(days, 0.35);
        if (evt) { const todayIds = cohab.todayEventDate === today ? (cohab.todayEventIds || []) : []; if (!todayIds.includes(evt.id)) { setActiveEvent({ kind: "event", event: evt }); cohab.todayEventIds = [...todayIds, evt.id]; cohab.todayEventDate = today; void saveDwellingLayout(activeCharId, cs.layout!); } }
    }, [visible, activeCharId]);
    useEffect(() => { eventCheckedRef.current = false; }, [activeCharId]);

    useEffect(() => {
        const chars = loadCharacters();
        setCharacters(chars);
        if (chars.length === 1) setActiveCharId(chars[0].id);
        // Pre-load all characters' cached layouts + item HTML so ✓ shows immediately
        (async () => {
            for (const c of chars) {
                const cs = getCharState(c.id);
                if (cs.loaded) continue;
                const cached = await loadDwellingLayout(c.id);
                cs.loaded = true;
                if (cached) {
                    cs.layout = cached.layout;
                    cs.itemHtmlCache = loadAllItemHtmlForChar(c.id);
                }
            }
            rerender();
        })();
    }, []);

    useEffect(() => {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        cs.error = null;
        if (cs.loaded) { rerender(); return; }
        let cancelled = false;
        (async () => {
            const cached = await loadDwellingLayout(activeCharId);
            if (cancelled) return;
            cs.loaded = true;
            if (cached) {
                cs.layout = cached.layout;
                cs.itemHtmlCache = loadAllItemHtmlForChar(activeCharId);
            }
            rerender();
        })();
        return () => { cancelled = true; };
    }, [activeCharId]);

    const doGenerate = useCallback(async (charId: string, mode: DwellingRefreshMode = "full") => {
        const cs = getCharState(charId);
        cs.isGenerating = true;
        cs.error = null;
        if (mode === "full") {
            cs.layout = null;
            cs.itemHtmlCache = {};
        }
        rerender();

        const { layout: newLayout, error: genError } = await generateDwellingLayout(charId, mode);
        cs.isGenerating = false;
        if (!newLayout) {
            cs.error = genError || "生成失败";
            rerender();
            if (!visible && onIdle) onIdle();
            return;
        }
        cs.layout = newLayout;
        cs.loaded = true;
        // Items mode: clear HTML cache for items with new IDs (changed items)
        if (mode === "items") {
            const newKeys = new Set<string>();
            for (const room of newLayout.rooms) {
                for (const f of room.furniture) {
                    for (const item of f.items) {
                        newKeys.add(itemKey(room.id, item.id));
                    }
                }
            }
            // Remove HTML cache entries that no longer exist (removed/changed items)
            for (const key of Object.keys(cs.itemHtmlCache)) {
                if (!newKeys.has(key)) delete cs.itemHtmlCache[key];
            }
        } else {
            cs.itemHtmlCache = {};
        }
        await saveDwellingLayout(charId, newLayout);
        rerender();
        if (!visible && onIdle) onIdle();
    }, [visible, onIdle]);

    async function handleRefresh(mode: DwellingRefreshMode) {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        if (cs.isGenerating) return;
        setItemDetail(null);
        if (mode === "full") {
            for (const ref of collectRoomImageRefs(cs.layout)) void deleteMediaRef(ref);
            cs.imageErrors = {};
            await clearDwellingData(activeCharId);
        }
        await doGenerate(activeCharId, mode);
    }

    async function handleDelete() {
        if (!activeCharId) return;
        const cs = getCharState(activeCharId);
        if (cs.isGenerating) return;
        for (const ref of collectRoomImageRefs(cs.layout)) void deleteMediaRef(ref);
        await clearDwellingData(activeCharId);
        cs.layout = null;
        cs.itemHtmlCache = {};
        cs.error = null;
        cs.imageErrors = {};
        setActiveRoomIdx(0);
        setItemDetail(null);
        rerender();
    }

    // ── 创建新房间（不清除已有房间） ──
    async function handleCreateRoom(roomName: string) {
        if (!activeCharId) return;
        const name = roomName.trim();
        if (!name) return;
        const cs = getCharState(activeCharId);
        if (cs.isGenerating || isCreatingRoom) return;

        setIsCreatingRoom(true);
        setShowAddRoomModal(false);
        setNewRoomNameInput("");
        cs.isGenerating = true;
        cs.error = null;
        rerender();

        const { room: newRoom, error } = await generateDwellingSingleRoom(activeCharId, name);
        setIsCreatingRoom(false);
        cs.isGenerating = false;

        if (!newRoom) {
            cs.error = error || "创建房间失败";
            rerender();
            return;
        }

        // Append new room without wiping existing layout
        const layout = cs.layout ? structuredClone(cs.layout) : { rooms: [] };
        layout.rooms.push(newRoom);
        cs.layout = layout;
        await saveDwellingLayout(activeCharId, layout);
        setActiveRoomIdx(layout.rooms.length - 1);
        setItemDetail(null);
        rerender();
    }

    function getMoodLabel(): string | undefined { const cohab = activeCharId ? getCharState(activeCharId)?.layout?.cohabitation : null; return cohab?.mood ? MOOD_LABELS[cohab.mood.mood] : undefined; }
    function bumpInteraction() { if (!activeCharId) return; const cs = getCharState(activeCharId); if (cs.layout?.cohabitation?.enabled) { incrementInteractionCount(cs.layout.cohabitation); refreshCharacterLocation(cs.layout); void saveDwellingLayout(activeCharId, cs.layout); rerender(); } }

    async function handleSendCohabitRequest() {
        if (!activeCharId || isRequestingCohabit || !cohabitMsgInput.trim()) return;
        setIsRequestingCohabit(true); setCohabitReplyResult(null);
        try { const res = await requestCohabitationDecision(activeCharId, cohabitMsgInput.trim()); setCohabitReplyResult(res);
            if (res.agreed) { const cs = getCharState(activeCharId); if (cs.layout) { let rooms = [...cs.layout.rooms]; if (!rooms.some(r => r.name.includes("玄关")||r.id==="entryway")) { rooms.unshift({ id: "entryway", name: "玄关", en: "ENTRYWAY", description: "推开门的第一道空间。", furniture: [{ id: "shoecabinet", icon: "DoorOpen", label: "鞋柜与挂衣钩", en: "CABINET", position: "bottom-left" as const, marker: { x: 0.25, y: 0.75 }, items: [{ id: "shoes", name: "成双的拖鞋", preview: "一双大一号，一双略小。" }] }] }); } cs.layout = { ...cs.layout, rooms, cohabitation: { enabled: true, agreedAt: new Date().toISOString() } }; refreshCharacterLocation(cs.layout); await saveDwellingLayout(activeCharId, cs.layout); } }
        } catch (err) { console.error(err); } finally { setIsRequestingCohabit(false); rerender(); }
    }
    async function handleEndCohabit() { if (!activeCharId) return; const cs = getCharState(activeCharId); if (cs.layout) { cs.layout = { ...cs.layout, cohabitation: { enabled: false } }; await saveDwellingLayout(activeCharId, cs.layout); rerender(); } setShowCohabitModal(false); }
    async function handleDoCharInteraction(roomName: string) {
        if (!activeCharId || isInteracting) return; const text = interactTab === "touch" ? customTouchInput.trim() : chatInput.trim(); if (!text) return;
        setIsInteracting(true); setInteractReply(null); setInteractError(null);
        try { const reply = await performDwellingCharInteraction(activeCharId, roomName, interactTab, text, getMoodLabel()); setInteractReply(reply); bumpInteraction(); } catch (e: any) { setInteractError(e?.message || "互动失败"); } finally { setIsInteracting(false); rerender(); }
    }
    async function handleFurnitureUse() {
        if (!activeCharId || isFurnitureUsing || !furnitureUseTarget || !furnitureUseInput.trim()) return;
        setIsFurnitureUsing(true); setFurnitureUseReply(null);
        try { const reply = await performFurnitureUse(activeCharId, furnitureUseTarget.roomName, furnitureUseTarget.furnitureName, furnitureUseInput.trim(), getMoodLabel()); setFurnitureUseReply(reply); bumpInteraction(); } catch (e: any) { setFurnitureUseReply(e?.message || "生成失败"); } finally { setIsFurnitureUsing(false); rerender(); }
    }
    async function handleWelcomeHome() {
        if (!activeCharId || isWelcoming) return; setIsWelcoming(true); setWelcomeReply(null);
        try { const reply = await performWelcomeHome(activeCharId, getMoodLabel()); setWelcomeReply(reply); bumpInteraction(); } catch (e: any) { setWelcomeReply(e?.message || "迎接失败"); } finally { setIsWelcoming(false); rerender(); }
    }
    async function handleSendNote() {
        if (!activeCharId || !noteInput.trim() || isNoteReplying) return; const cs = getCharState(activeCharId); if (!cs.layout?.cohabitation) return;
        setIsNoteReplying(true); const note: DwellingNote = { id: `note_${Date.now()}`, from: "user", content: noteInput.trim(), createdAt: new Date().toISOString() };
        if (!cs.layout.cohabitation.notes) cs.layout.cohabitation.notes = []; cs.layout.cohabitation.notes.push(note); setNoteInput(""); rerender();
        try { const reply = await generateNoteReply(activeCharId, note.content, getMoodLabel()); note.charReply = reply; note.charRepliedAt = new Date().toISOString(); await saveDwellingLayout(activeCharId, cs.layout); bumpInteraction(); } catch (e) { console.error(e); } finally { setIsNoteReplying(false); rerender(); }
    }
    async function handleStartCooking() { if (!activeCharId || cookingState.phase==="generating") return; setCookingState({ phase: "generating", recipe: null, selected: [], stepIdx: 0, score: null, scoreComment: "" }); try { const recipe = await generateCookingSession(activeCharId, cookingDishInput.trim()||undefined); setCookingState({ phase: "select", recipe, selected: [], stepIdx: 0, score: null, scoreComment: "" }); } catch { setCookingState(s => ({ ...s, phase: "idle" })); } }
    function handleToggleCookingIngredient(name: string) { setCookingState(s => ({ ...s, selected: s.selected.includes(name) ? s.selected.filter(n => n !== name) : [...s.selected, name] })); }
    function handleConfirmIngredients() { setCookingState(s => ({ ...s, phase: "steps", stepIdx: 0 })); }
    function handleFinishCooking() { if (!cookingState.recipe) return; const result = scoreCooking(cookingState.recipe, cookingState.selected); if (activeCharId) void recordDwellingInteractionMemory(activeCharId, `做了「${cookingState.recipe.name}」，${result.score}分。${result.comment}`); setCookingState(s => ({ ...s, phase: "done", score: result.score, scoreComment: result.comment })); bumpInteraction(); }
    async function handleSwitchTv() { if (!activeCharId || tvState.phase==="generating" || !tvGenreInput.trim()) return; setTvState({ phase: "generating", channel: null, error: null }); try { const ch = await generateTvChannel(activeCharId, tvGenreInput.trim()); setTvState({ phase: "done", channel: ch, error: null }); bumpInteraction(); } catch (e: any) { setTvState({ phase: "idle", channel: null, error: e?.message || "生成失败" }); } }
    async function handleOpenBook() { if (!activeCharId || bookState.phase==="generating") return; setBookState({ phase: "generating", book: null, pageIdx: 0, error: null }); try { const book = await generateBookOverview(activeCharId); setBookState({ phase: "reading", book, pageIdx: 0, error: null }); bumpInteraction(); } catch (e: any) { setBookState({ phase: "idle", book: null, pageIdx: 0, error: e?.message || "生成失败" }); } }
    function jumpToCharRoom() { if (!activeCharId || !cs?.layout?.cohabitation?.currentRoomId) return; const idx = cs.layout.rooms.findIndex(r => r.id === cs.layout!.cohabitation!.currentRoomId); if (idx >= 0) { setActiveRoomIdx(idx); setItemDetail(null); } }
    async function handleTriggerEvent() { if (!activeCharId || !activeEvent || isEventLoading) return; setIsEventLoading(true); setEventScene(null); try { let scene: string; if (activeEvent.kind==="anniversary"&&activeEvent.days) { scene = await generateAnniversaryScene(activeCharId, activeEvent.days, getMoodLabel()); } else if (activeEvent.event) { scene = await generateRandomEventScene(activeCharId, activeEvent.event, getMoodLabel()); } else return; setEventScene(scene); bumpInteraction(); } catch (e: any) { setEventScene(e?.message||"场景生成失败"); } finally { setIsEventLoading(false); } }

    // ── 房间生图 ──
    const handleGenerateRoomImage = useCallback(async (charId: string, roomId: string) => {
        const cs = getCharState(charId);
        const layout = cs.layout;
        if (!layout) return;
        const room = layout.rooms.find(r => r.id === roomId);
        if (!room) return;
        if (cs.generatingImageRooms.has(roomId)) return;

        cs.generatingImageRooms.add(roomId);
        delete cs.imageErrors[roomId];
        rerender();

        const { assetId, error } = await generateDwellingRoomImage(charId, room);
        cs.generatingImageRooms.delete(roomId);

        // 生成期间布局被重建/删除：丢弃这张图
        if (cs.layout !== layout) {
            if (assetId) void deleteMediaRef(assetId);
            rerender();
            return;
        }

        if (assetId) {
            const old = room.imageAssetId;
            room.imageAssetId = assetId;
            if (old && old !== assetId) void deleteMediaRef(old);
            const url = await loadMediaObjectUrl(assetId);
            if (url) roomImageUrls.set(assetId, url);
            await saveDwellingLayout(charId, layout);
        } else {
            cs.imageErrors[roomId] = error || "生成失败";
        }
        rerender();
    }, []);

    // 进入房间：已有图则解析 URL；没有图且生图可用则自动生成
    const csForImage = activeCharId ? getCharState(activeCharId) : null;
    const roomForImage = csForImage?.layout?.rooms[activeRoomIdx] ?? null;
    useEffect(() => {
        if (visible === false) return;
        if (!activeCharId || !csForImage?.layout || !roomForImage) return;
        const cs = csForImage;
        const room = roomForImage;

        if (room.imageAssetId) {
            const ref = room.imageAssetId;
            if (roomImageUrls.has(ref)) return;
            let cancelled = false;
            (async () => {
                const url = await loadMediaObjectUrl(ref);
                if (cancelled) return;
                if (url) {
                    roomImageUrls.set(ref, url);
                } else if (cs.layout && cs.layout.rooms.includes(room)) {
                    // 媒体已丢失：清掉引用，回氛围底并允许重新生成
                    room.imageAssetId = undefined;
                    void saveDwellingLayout(activeCharId, cs.layout);
                }
                rerender();
            })();
            return () => { cancelled = true; };
        }

        if (imageEnabled && imageConfigured && !cs.generatingImageRooms.has(room.id) && !cs.imageErrors[room.id]) {
            void handleGenerateRoomImage(activeCharId, room.id);
        }
    }, [activeCharId, activeRoomIdx, imageEnabled, imageConfigured, visible, csForImage, roomForImage, handleGenerateRoomImage]);

    function openItemDetail(room: DwellingRoom, furniture: DwellingFurniture, item: DwellingFurnitureItem, html: string) {
        setItemDetail({
            roomId: room.id,
            roomName: room.name,
            furnitureId: furniture.id,
            furnitureLabel: furniture.label,
            furnitureIcon: furniture.icon,
            itemId: item.id,
            itemName: item.name,
            itemPreview: item.preview,
            html,
        });
    }

    // ── Explore single item (called from RoomView) ──
    async function handleExploreItem(charId: string, roomId: string, furniture: DwellingFurniture, item: DwellingFurnitureItem) {
        const cs = getCharState(charId);
        const room = cs.layout?.rooms.find(r => r.id === roomId);
        if (!room) return;

        const key = itemKey(roomId, item.id);
        if (cs.loadingItemKeys.has(key)) return; // already loading
        cs.loadingItemKeys.add(key);
        cs.lastItemError = null;
        rerender();

        const { html, error } = await generateItemHtml(charId, room.name, furniture.label, item.name, item.preview);

        cs.loadingItemKeys.delete(key);
        if (html) {
            cs.itemHtmlCache[key] = html;
            void saveItemHtml(charId, roomId, item.id, html);
            const currentRoom = activeCharIdRef.current === charId ? cs.layout?.rooms[activeRoomIdxRef.current] : null;
            if (currentRoom?.id === roomId) openItemDetail(room, furniture, item, html);
        }
        cs.lastItemError = error || null;
        rerender();
    }

    const cs = activeCharId ? getCharState(activeCharId) : null;
    const activeRoom = cs?.layout?.rooms[activeRoomIdx] ?? null;

    return (
        <div className="dwelling-app" data-haspicker={characters.length > 1 ? "true" : undefined}>
            <div className="dwelling-header">
                <button className="dw-back" onClick={onClose}><ChevronLeft size={18} /></button>
                <h1>栖 所<span className="dw-title-en">DWELLING</span></h1>
            </div>

            {characters.length > 1 && (
                <div className="dwelling-char-picker">
                    {characters.map(c => {
                        const s = getCharState(c.id);
                        return (
                            <button key={c.id} className="dwelling-char-chip"
                                data-active={activeCharId === c.id ? "true" : undefined}
                                onClick={() => { setActiveCharId(c.id); setActiveRoomIdx(0); setItemDetail(null); }}>
                                <span className="dw-chip-zh">{c.name}{s.isGenerating ? " …" : s.layout ? " ✓" : ""}</span>
                                {charChipEn(c.name) && <span className="dw-chip-en">{charChipEn(c.name)}</span>}
                            </button>
                        );
                    })}
                </div>
            )}

            {!activeCharId && characters.length > 1 && (
                <div className="dwelling-empty"><span>选择一位角色，探索 ta 的栖所</span></div>
            )}
            {characters.length === 0 && (
                <div className="dwelling-empty"><span>还没有角色，去创建一个吧</span></div>
            )}
            {cs?.isGenerating && !cs.layout && (
                <div className="dwelling-loading"><div className="dwelling-spinner" /><span className="dwelling-loading-text">正在窥探房间…</span></div>
            )}
            {cs?.isGenerating && cs.layout && (
                <div className="dwelling-loading-bar"><span className="dwelling-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /><span>刷新中…</span></div>
            )}
            {cs && (cs.error || cs.lastItemError) && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => { cs.error = null; cs.lastItemError = null; rerender(); }} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">{cs.error ? "生成失败" : "探索失败"}</div>
                        <div className="dw-confirm-msg dw-error-msg">{cs.error || cs.lastItemError}</div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn" onClick={() => { cs.error = null; cs.lastItemError = null; rerender(); }}>知道了</button>
                        </div>
                    </div>
                </div>
            )}
            {activeCharId && cs?.loaded && !cs.layout && !cs.isGenerating && (
                <div className="dwelling-empty">
                    <span>还未生成 ta 的房间</span>
                    <button className="dwelling-generate-btn" onClick={() => doGenerate(activeCharId)}>
                        <Wand2 size={16} />生成房间
                    </button>
                </div>
            )}

            {cs?.layout && (
                <div className="dwelling-room-tabs">
                    {cs.layout.rooms.map((room, idx) => (
                        <button key={room.id} className="dwelling-room-tab"
                            data-active={activeRoomIdx === idx ? "true" : undefined}
                            onClick={() => { setActiveRoomIdx(idx); setItemDetail(null); }}>
                            {room.name}
                            {room.en && <span className="dw-tab-en">{room.en}</span>}
                        </button>
                    ))}
                    <div className="dw-tabs-actions">
                        <button className={`dw-tab-action ${cs.layout?.cohabitation?.enabled?"dw-tab-action-cohabit-active":""}`} onClick={() => { setCohabitMsgInput(""); setCohabitReplyResult(null); setShowCohabitModal(true); }} disabled={cs.isGenerating} title={cs.layout?.cohabitation?.enabled?"已同居":"申请同居"}><Heart size={13} fill={cs.layout?.cohabitation?.enabled?"currentColor":"none"} /></button>
                        {cs.layout?.cohabitation?.enabled && <button className="dw-tab-action" onClick={() => { setNoteInput(""); setShowNoteModal(true); }} title="冰箱便签"><StickyNote size={13} /></button>}
                        <button className="dw-tab-action" onClick={() => { setNewRoomNameInput(""); setShowAddRoomModal(true); }} disabled={cs.isGenerating} title="新建房间">
                            <Plus size={14} />
                        </button>
                        <button className="dw-tab-action" onClick={() => setShowRefreshConfirm(true)} disabled={cs.isGenerating} title="重新生成">
                            <RefreshCw size={13} />
                        </button>
                        <button className="dw-tab-action dw-tab-action-danger" onClick={() => setShowDeleteConfirm(true)} disabled={cs.isGenerating} title="删除布局">
                            <Trash2 size={13} />
                        </button>
                    </div>
                </div>
            )}

            {activeRoom && cs && (() => {
                const assetUrl = activeRoom.imageAssetId ? roomImageUrls.get(activeRoom.imageAssetId) ?? null : null;
                let imageStatus: DwellingRoomImageStatus = "ambient";
                if (cs.generatingImageRooms.has(activeRoom.id)) imageStatus = "generating";
                else if (imageEnabled && assetUrl) imageStatus = "ready";
                else if (imageEnabled && imageConfigured && cs.imageErrors[activeRoom.id]) imageStatus = "failed";
                return (
                    <RoomView
                        room={activeRoom}
                        itemHtmlCache={cs.itemHtmlCache}
                        loadingItemKeys={cs.loadingItemKeys}
                        lastItemError={cs.lastItemError}
                        onExploreItem={(furniture, item) => handleExploreItem(activeCharId!, activeRoom.id, furniture, item)}
                        onOpenItem={(furniture, item, html) => openItemDetail(activeRoom, furniture, item, html)}
                        onMoveMarker={(furnitureId, marker) => {
                            if (!activeCharId || !cs.layout) return;
                            const roomIdx = cs.layout.rooms.indexOf(activeRoom);
                            if (roomIdx < 0) return;
                            // 不可变更新：房间对象换新引用，RoomView 才会立即重算标注布局
                            cs.layout.rooms[roomIdx] = {
                                ...activeRoom,
                                furniture: activeRoom.furniture.map(f => f.id === furnitureId ? { ...f, marker } : f),
                            };
                            void saveDwellingLayout(activeCharId, cs.layout);
                            rerender();
                        }}
                        imageUrl={imageEnabled ? assetUrl : null}
                        imageStatus={imageStatus}
                        imageError={cs.imageErrors[activeRoom.id] ?? null}
                        imageEnabled={imageEnabled}
                        imageConfigured={imageConfigured}
                        onToggleImage={() => {
                            const next = !imageEnabled;
                            setImageEnabled(next);
                            saveDwellingImageEnabled(next);
                            // 重新打开开关视为想再试一次：清掉失败记录，让自动生成重新触发
                            if (next) cs.imageErrors = {};
                        }}
                        onRetryImage={() => { if (activeCharId) void handleGenerateRoomImage(activeCharId, activeRoom.id); }}
                        onCancelImage={() => { if (activeCharId) cancelDwellingRoomImage(activeCharId, activeRoom.id); }}
                        cohabitChar={cs.layout?.cohabitation?.enabled ? { id: activeCharId, name: characters.find(c => c.id === activeCharId)?.name ?? "TA", avatar: characters.find(c => c.id === activeCharId)?.avatar, activity: cs.layout.cohabitation.currentActivity, isHere: (cs.layout.cohabitation.currentRoomId || cs.layout.rooms[0]?.id) === activeRoom.id } : null}
                        onInteractChar={() => { setInteractReply(null); setInteractError(null); setShowInteractModal(true); }}
                        roomMinigame={cs.layout?.cohabitation?.enabled ? /厨房|kitchen/i.test(activeRoom.name)?"cooking":/客厅|living|起居/i.test(activeRoom.name)?"tv":/书房|study|书室/i.test(activeRoom.name)?"book":null : null}
                        onMinigame={() => { const rn = activeRoom.name; if (/厨房|kitchen/i.test(rn)) { setCookingDishInput(""); setCookingState({ phase:"idle",recipe:null,selected:[],stepIdx:0,score:null,scoreComment:"" }); setShowCookingModal(true); } else if (/客厅|living|起居/i.test(rn)) { setTvGenreInput(""); setTvState({ phase:"idle",channel:null,error:null }); setShowTvModal(true); } else if (/书房|study|书室/i.test(rn)) { setBookState({ phase:"idle",book:null,pageIdx:0,error:null }); setShowBookModal(true); } }}
                        cohabitEnabled={!!cs.layout?.cohabitation?.enabled}
                        onFurnitureUse={(fn) => { setFurnitureUseTarget({ roomName: activeRoom.name, furnitureName: fn }); setFurnitureUseInput(""); setFurnitureUseReply(null); setShowFurnitureUseModal(true); }}
                        moodLabel={cs.layout?.cohabitation?.mood ? MOOD_LABELS[cs.layout.cohabitation.mood.mood] : undefined}
                        weatherLabel={cs.layout?.cohabitation?.enabled ? WEATHER_LABELS[getTodayWeather()] : undefined}
                        seasonLabel={cs.layout?.cohabitation?.enabled ? SEASON_LABELS[getCurrentSeason()] : undefined}
                    />
                );
            })()}
            {itemDetail && (
                <div className="dwelling-detail-overlay" data-show="true">
                    <div className="dwelling-items-shade" onClick={() => setItemDetail(null)} />
                    <div className="dwelling-detail-card" role="dialog" aria-modal="true" aria-label={itemDetail.itemName}>
                        <div className="dwelling-items-header">
                            <div className="dwelling-detail-heading">
                                <div className="dwelling-detail-name">{itemDetail.itemName}</div>
                                <div className="dwelling-detail-location">{itemDetail.roomName} · {itemDetail.furnitureLabel}</div>
                            </div>
                            <button className="dwelling-items-close" onClick={() => setItemDetail(null)} aria-label="关闭">
                                <X size={13} />
                            </button>
                        </div>
                        <div className="dwelling-detail-preview">{itemDetail.itemPreview}</div>
                        <div className="dwelling-detail-html">
                            <StoryHtmlRenderer
                                content={itemDetail.html}
                                messageId={`dw-detail-${itemDetail.roomId}-${itemDetail.furnitureId}-${itemDetail.itemId}`}
                                htmlPageMode="contained"
                            />
                        </div>
                    </div>
                </div>
            )}
            {activeCharId && cs?.layout?.cohabitation?.enabled && (() => { const charName = characters.find(c => c.id === activeCharId)?.name ?? "TA"; const curRoom = cs.layout.rooms.find(r => r.id === cs.layout?.cohabitation?.currentRoomId) ?? cs.layout.rooms[0]; const isEntryway = /玄关|entryway/i.test(activeRoom?.name||""); const charNotHere = activeRoom && curRoom && curRoom.id !== activeRoom.id; return (<>
                <div className="dw-cohabit-status" onClick={jumpToCharRoom}><span className="dw-cohabit-dot" /><span>{charName} 在「{curRoom?.name||"某处"}」· {cs.layout.cohabitation.currentActivity||"发着呆"}</span></div>
                {isEntryway && charNotHere && !isWelcoming && !welcomeReply && <button className="dw-welcome-btn" onClick={() => void handleWelcomeHome()}><Home size={14} /> 呼唤 {charName} 来门口</button>}
                {isEntryway && isWelcoming && <div className="dw-mg-loading" style={{ padding: "12px 0" }}><span className="dwelling-spinner" style={{ width:14,height:14,borderWidth:2 }} /><span>脚步声越来越近…</span></div>}
                {isEntryway && welcomeReply && <div className="dw-welcome-scene"><div className="dw-welcome-text">{welcomeReply}</div><button className="dw-confirm-btn" style={{ marginTop:10,maxWidth:120 }} onClick={() => setWelcomeReply(null)}>好的</button></div>}
            </>); })()}

            {activeEvent && <div className="dw-confirm-overlay"><div className="dw-confirm-shade" onClick={() => { if (!isEventLoading) { setActiveEvent(null); setEventScene(null); }}} /><div className="dw-confirm-card dw-minigame-card"><div className="dw-confirm-title">{activeEvent.kind==="anniversary"?`🎉 同居第 ${activeEvent.days} 天`:`✦ ${activeEvent.event?.name}`}</div>
                {!eventScene && !isEventLoading && <div><div className="dw-confirm-msg" style={{ textAlign:"left" }}>{activeEvent.kind==="anniversary"?`今天是同居第 ${activeEvent.days} 天纪念日！`:activeEvent.event?.description}</div><div className="dw-confirm-actions" style={{ marginTop:14 }}><button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => { setActiveEvent(null); setEventScene(null); }}>跳过</button><button className="dw-confirm-btn" onClick={() => void handleTriggerEvent()}>看看发生了什么</button></div></div>}
                {isEventLoading && <div className="dw-mg-loading"><span className="dwelling-spinner" style={{ width:16,height:16,borderWidth:2 }} /><span>场景展开中…</span></div>}
                {eventScene && <div><div className="dw-mg-reply-box">{eventScene}</div><div style={{ fontSize:11,color:"var(--dw-dim)",marginTop:8 }}>✦ 已记录进角色记忆</div><div className="dw-confirm-actions" style={{ marginTop:12 }}><button className="dw-confirm-btn" onClick={() => { setActiveEvent(null); setEventScene(null); }}>好的</button></div></div>}
            </div></div>}

            {showCohabitModal && <div className="dw-confirm-overlay"><div className="dw-confirm-shade" onClick={() => { if (!isRequestingCohabit) setShowCohabitModal(false); }} /><div className="dw-confirm-card dw-minigame-card"><div className="dw-confirm-title" style={{ display:"flex",alignItems:"center",gap:6 }}><Heart size={16} /><span>{cs?.layout?.cohabitation?.enabled?"同居生活":"提出同居请求"}</span></div>
                {cs?.layout?.cohabitation?.enabled ? <div style={{ fontSize:13,color:"var(--dw-ink)",lineHeight:1.6 }}><p style={{ color:"var(--dw-dim)" }}>你们已经在同一个屋檐下了。</p>{cs.layout.cohabitation.agreedAt && <p style={{ fontSize:11,opacity:0.5 }}>始于 {new Date(cs.layout.cohabitation.agreedAt).toLocaleDateString()}（第 {getCohabitDays(cs.layout.cohabitation.agreedAt)} 天）</p>}{cs.layout.cohabitation.mood && <p style={{ fontSize:12 }}>情绪：{MOOD_LABELS[cs.layout.cohabitation.mood.mood]}</p>}<div className="dw-confirm-actions" style={{ marginTop:14 }}><button className="dw-confirm-btn dw-confirm-btn-danger" onClick={() => void handleEndCohabit()}>结束同居</button><button className="dw-confirm-btn" onClick={() => setShowCohabitModal(false)}>确认</button></div></div>
                : <div><div className="dw-confirm-msg" style={{ textAlign:"left" }}>给 TA 发送同居请求。</div>{!cohabitReplyResult ? <><textarea value={cohabitMsgInput} onChange={e => setCohabitMsgInput(e.target.value)} placeholder="搬来一起住吧…" disabled={isRequestingCohabit} rows={3} className="dw-mg-textarea" /><div className="dw-confirm-actions" style={{ marginTop:12 }}><button className="dw-confirm-btn dw-confirm-btn-cancel" disabled={isRequestingCohabit} onClick={() => setShowCohabitModal(false)}>取消</button><button className="dw-confirm-btn" disabled={!cohabitMsgInput.trim()||isRequestingCohabit} onClick={() => void handleSendCohabitRequest()}>{isRequestingCohabit?"等待答复…":"发送心意"}</button></div></> : <div style={{ margin:"10px 0" }}><div className="dw-mg-result-box"><div style={{ fontWeight:600,marginBottom:4 }}>{cohabitReplyResult.agreed?"✦ TA 同意了":"TA 暂时没准备好"}</div><div style={{ fontStyle:"italic",color:"var(--dw-dim)" }}>"{cohabitReplyResult.reply}"</div></div><div className="dw-confirm-actions" style={{ marginTop:14 }}><button className="dw-confirm-btn" onClick={() => { setShowCohabitModal(false); setCohabitReplyResult(null); }}>知道了</button></div></div>}</div>}
            </div></div>}

            {showInteractModal && activeCharId && <div className="dw-confirm-overlay"><div className="dw-confirm-shade" onClick={() => { if (!isInteracting) setShowInteractModal(false); }} /><div className="dw-confirm-card dw-minigame-card"><div className="dw-confirm-title">与 {characters.find(c => c.id === activeCharId)?.name ?? "TA"} 互动</div>
                <div style={{ display:"flex",gap:8,margin:"12px 0 10px" }}><button className="dw-confirm-btn" style={{ flex:1,background:interactTab==="touch"?"rgba(255,255,255,0.12)":"transparent",border:"1px solid var(--dw-line)",color:interactTab==="touch"?"var(--dw-ink)":"var(--dw-dim)" }} onClick={() => { setInteractTab("touch"); setInteractReply(null); setInteractError(null); }}>触摸</button><button className="dw-confirm-btn" style={{ flex:1,background:interactTab==="chat"?"rgba(255,255,255,0.12)":"transparent",border:"1px solid var(--dw-line)",color:interactTab==="chat"?"var(--dw-ink)":"var(--dw-dim)" }} onClick={() => { setInteractTab("chat"); setInteractReply(null); setInteractError(null); }}>闲聊</button></div>
                {interactError && <div className="dw-mg-error">{interactError}</div>}
                {!interactReply ? <div><textarea value={interactTab==="touch"?customTouchInput:chatInput} onChange={e => interactTab==="touch"?setCustomTouchInput(e.target.value):setChatInput(e.target.value)} placeholder={interactTab==="touch"?"轻轻从背后抱住TA…":"想聊什么？"} disabled={isInteracting} rows={3} className="dw-mg-textarea" /><div className="dw-confirm-actions" style={{ marginTop:12 }}><button className="dw-confirm-btn dw-confirm-btn-cancel" disabled={isInteracting} onClick={() => setShowInteractModal(false)}>取消</button><button className="dw-confirm-btn" disabled={isInteracting||!(interactTab==="touch"?customTouchInput.trim():chatInput.trim())} onClick={() => void handleDoCharInteraction(activeRoom?.name||"房间")}>{isInteracting?"回应中…":"确定"}</button></div></div>
                : <div><div className="dw-mg-reply-box">{interactReply}</div><div style={{ fontSize:11,color:"var(--dw-dim)",marginTop:8 }}>✦ 已记录进角色记忆</div><div className="dw-confirm-actions" style={{ marginTop:12 }}><button className="dw-confirm-btn" onClick={() => { setInteractReply(null); setShowInteractModal(false); }}>完成</button></div></div>}
            </div></div>}

            {showFurnitureUseModal && furnitureUseTarget && <div className="dw-confirm-overlay"><div className="dw-confirm-shade" onClick={() => { if (!isFurnitureUsing) setShowFurnitureUseModal(false); }} /><div className="dw-confirm-card dw-minigame-card"><div className="dw-confirm-title">✦ {furnitureUseTarget.furnitureName}</div>
                {!furnitureUseReply ? <div><div className="dw-confirm-msg" style={{ textAlign:"left" }}>你想在这里做什么？</div><textarea value={furnitureUseInput} onChange={e => setFurnitureUseInput(e.target.value)} placeholder="躺下休息、泡咖啡、一起泡澡…" disabled={isFurnitureUsing} rows={2} className="dw-mg-textarea" /><div className="dw-confirm-actions" style={{ marginTop:12 }}><button className="dw-confirm-btn dw-confirm-btn-cancel" disabled={isFurnitureUsing} onClick={() => setShowFurnitureUseModal(false)}>取消</button><button className="dw-confirm-btn" disabled={isFurnitureUsing||!furnitureUseInput.trim()} onClick={() => void handleFurnitureUse()}>{isFurnitureUsing?"生成中…":"开始"}</button></div></div>
                : <div><div className="dw-mg-reply-box">{furnitureUseReply}</div><div style={{ fontSize:11,color:"var(--dw-dim)",marginTop:8 }}>✦ 已记录进角色记忆</div><div className="dw-confirm-actions" style={{ marginTop:12 }}><button className="dw-confirm-btn" onClick={() => setShowFurnitureUseModal(false)}>好的</button></div></div>}
            </div></div>}

            {showNoteModal && activeCharId && cs?.layout?.cohabitation && <div className="dw-confirm-overlay"><div className="dw-confirm-shade" onClick={() => setShowNoteModal(false)} /><div className="dw-confirm-card dw-minigame-card" style={{ maxHeight:"70vh",display:"flex",flexDirection:"column" }}><div className="dw-confirm-title"><StickyNote size={16} /> 冰箱便签</div>
                <div className="dw-note-list">{(cs.layout.cohabitation.notes||[]).slice(-10).map(n => <div key={n.id} className="dw-note-item"><div className="dw-note-user">{n.content}</div>{n.charReply ? <div className="dw-note-char">{n.charReply}</div> : <div className="dw-note-pending">等待回复中…</div>}</div>)}{!(cs.layout.cohabitation.notes?.length) && <div style={{ color:"var(--dw-faint)",fontSize:12,textAlign:"center",padding:20 }}>还没有便签</div>}</div>
                <div style={{ display:"flex",gap:8,marginTop:10 }}><input type="text" value={noteInput} onChange={e => setNoteInput(e.target.value)} placeholder="写点什么贴在冰箱上…" className="dw-mg-input" style={{ flex:1,marginTop:0 }} onKeyDown={e => { if (e.key==="Enter") void handleSendNote(); }} /><button className="dw-confirm-btn" style={{ flex:"none",padding:"0 16px" }} disabled={!noteInput.trim()||isNoteReplying} onClick={() => void handleSendNote()}>{isNoteReplying?"…":"贴上"}</button></div>
            </div></div>}

            {showCookingModal && activeCharId && <div className="dw-confirm-overlay"><div className="dw-confirm-shade" onClick={() => { if (cookingState.phase!=="generating") setShowCookingModal(false); }} /><div className="dw-confirm-card dw-minigame-card"><div className="dw-confirm-title">🍳 厨房</div>
                {cookingState.phase==="idle" && <div><div className="dw-confirm-msg" style={{ textAlign:"left" }}>想做什么菜？留空由角色发挥。</div><input type="text" value={cookingDishInput} onChange={e => setCookingDishInput(e.target.value)} placeholder="红烧肉、意面…" className="dw-mg-input" onKeyDown={e => { if (e.key==="Enter") void handleStartCooking(); }} /><div className="dw-confirm-actions" style={{ marginTop:14 }}><button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setShowCookingModal(false)}>取消</button><button className="dw-confirm-btn" onClick={() => void handleStartCooking()}>开始</button></div></div>}
                {cookingState.phase==="generating" && <div className="dw-mg-loading"><span className="dwelling-spinner" style={{ width:16,height:16,borderWidth:2 }} /><span>准备食材…</span></div>}
                {cookingState.phase==="select" && cookingState.recipe && <div><div className="dw-mg-dish-name">{cookingState.recipe.name}</div><div className="dw-confirm-msg" style={{ textAlign:"center",marginBottom:10 }}>选出正确食材（{cookingState.recipe.keyCount}种）</div><div className="dw-mg-ingredients">{cookingState.recipe.allIngredients.map((ing,i) => <button key={i} className={`dw-mg-ing-tag ${cookingState.selected.includes(ing.name)?"dw-mg-ing-selected":""}`} onClick={() => handleToggleCookingIngredient(ing.name)}>{ing.icon} {ing.name}</button>)}</div><div className="dw-confirm-actions" style={{ marginTop:14 }}><button className="dw-confirm-btn" disabled={!cookingState.selected.length} onClick={handleConfirmIngredients}>开始烹饪</button></div></div>}
                {cookingState.phase==="steps" && cookingState.recipe && <div><div className="dw-mg-dish-name">{cookingState.recipe.name}</div><div className="dw-mg-step-area"><div className="dw-mg-step-label">步骤 {cookingState.stepIdx+1}/{cookingState.recipe.steps.length}</div><div className="dw-mg-step-text">{cookingState.recipe.steps[cookingState.stepIdx]}</div><div className="dw-mg-step-progress">{cookingState.recipe.steps.map((_,i) => <span key={i} className="dw-mg-step-dot" data-done={i<=cookingState.stepIdx?"true":undefined} />)}</div></div><div className="dw-confirm-actions" style={{ marginTop:14 }}>{cookingState.stepIdx<cookingState.recipe.steps.length-1 ? <button className="dw-confirm-btn" onClick={() => setCookingState(s => ({ ...s, stepIdx:s.stepIdx+1 }))}>下一步</button> : <button className="dw-confirm-btn" onClick={handleFinishCooking}>出锅！</button>}</div></div>}
                {cookingState.phase==="done" && cookingState.recipe && <div><div className="dw-mg-dish-name">{cookingState.recipe.name}</div><div className="dw-mg-score">🏆 {cookingState.score} 分</div><div className="dw-mg-result">{cookingState.scoreComment}</div><div className="dw-mg-char-reaction">{cookingState.recipe.charReaction}</div><div style={{ fontSize:11,color:"var(--dw-dim)",marginTop:10 }}>✦ 已记录</div><div className="dw-confirm-actions" style={{ marginTop:12 }}><button className="dw-confirm-btn" onClick={() => { setShowCookingModal(false); setCookingState({ phase:"idle",recipe:null,selected:[],stepIdx:0,score:null,scoreComment:"" }); }}>完成</button></div></div>}
            </div></div>}

            {showTvModal && activeCharId && <div className="dw-confirm-overlay"><div className="dw-confirm-shade" onClick={() => { if (tvState.phase!=="generating") setShowTvModal(false); }} /><div className="dw-confirm-card dw-minigame-card"><div className="dw-confirm-title">📺 电视</div>
                {tvState.error && <div className="dw-mg-error">{tvState.error}</div>}
                {tvState.phase==="idle" && <div><input type="text" value={tvGenreInput} onChange={e => setTvGenreInput(e.target.value)} placeholder="纪录片、恐怖电影…" className="dw-mg-input" onKeyDown={e => { if (e.key==="Enter") void handleSwitchTv(); }} /><div className="dw-confirm-actions" style={{ marginTop:14 }}><button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setShowTvModal(false)}>取消</button><button className="dw-confirm-btn" disabled={!tvGenreInput.trim()} onClick={() => void handleSwitchTv()}>换台</button></div></div>}
                {tvState.phase==="generating" && <div className="dw-mg-loading"><span className="dwelling-spinner" style={{ width:16,height:16,borderWidth:2 }} /><span>信号搜索中…</span></div>}
                {tvState.phase==="done" && tvState.channel && <div><div className="dw-mg-tv-channel">{tvState.channel.channelName}</div><div className="dw-mg-tv-program">{tvState.channel.program}</div><div className="dw-mg-tv-screen"><div className="dw-mg-tv-scene">{tvState.channel.scene}</div></div><div className="dw-mg-char-reaction">{tvState.channel.charComment}</div><div style={{ fontSize:11,color:"var(--dw-dim)",marginTop:10 }}>✦ 已记录</div><div className="dw-confirm-actions" style={{ marginTop:12 }}><button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setTvState({ phase:"idle",channel:null,error:null })}>换台</button><button className="dw-confirm-btn" onClick={() => setShowTvModal(false)}>关电视</button></div></div>}
            </div></div>}

            {showBookModal && activeCharId && <div className="dw-confirm-overlay"><div className="dw-confirm-shade" onClick={() => { if (bookState.phase!=="generating") setShowBookModal(false); }} /><div className="dw-confirm-card dw-minigame-card"><div className="dw-confirm-title">📖 书房</div>
                {bookState.error && <div className="dw-mg-error">{bookState.error}</div>}
                {bookState.phase==="idle" && !bookState.book && <div><div className="dw-confirm-msg" style={{ textAlign:"left" }}>从书架上随手抽一本 TA 的书。</div><div className="dw-confirm-actions" style={{ marginTop:14 }}><button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setShowBookModal(false)}>算了</button><button className="dw-confirm-btn" onClick={() => void handleOpenBook()}>随手拿一本</button></div></div>}
                {bookState.phase==="generating" && <div className="dw-mg-loading"><span className="dwelling-spinner" style={{ width:16,height:16,borderWidth:2 }} /><span>翻开书页…</span></div>}
                {bookState.phase==="reading" && bookState.book && (() => { const b=bookState.book; const pi=bookState.pageIdx; return <div><div className="dw-mg-book-title">《{b.title}》</div><div className="dw-mg-book-meta">{b.author} · {b.genre}</div><div className="dw-mg-book-page"><div className="dw-mg-book-page-num">— {pi+1}/{b.pages.length} —</div><div className="dw-mg-book-text">{b.pages[pi]}</div></div><div className="dw-confirm-actions" style={{ marginTop:12,gap:8 }}><button className="dw-confirm-btn" disabled={pi===0} style={{ opacity:pi>0?1:0.35 }} onClick={() => setBookState(s => ({ ...s, pageIdx:pi-1 }))}>上一页</button>{pi<b.pages.length-1 ? <button className="dw-confirm-btn" onClick={() => setBookState(s => ({ ...s, pageIdx:pi+1 }))}>下一页</button> : <button className="dw-confirm-btn" onClick={() => setBookState(s => ({ ...s, phase:"done" }))}>合上书</button>}</div></div>; })()}
                {bookState.phase==="done" && bookState.book && <div><div className="dw-mg-book-title">《{bookState.book.title}》</div><div className="dw-mg-char-reaction" style={{ marginTop:10 }}>{bookState.book.charThought}</div><div style={{ fontSize:11,color:"var(--dw-dim)",marginTop:10 }}>✦ 已记录</div><div className="dw-confirm-actions" style={{ marginTop:12 }}><button className="dw-confirm-btn" onClick={() => { setShowBookModal(false); setBookState({ phase:"idle",book:null,pageIdx:0,error:null }); }}>放回书架</button></div></div>}
            </div></div>}

            {/* Add Room Modal */}
            {showAddRoomModal && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setShowAddRoomModal(false)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">新建房间</div>
                        <div className="dw-confirm-msg">输入新房间的名字，AI 将自动构想对应家具与物品</div>
                        <div style={{ marginTop: 14 }}>
                            <input
                                type="text"
                                className="dw-input"
                                placeholder="例如：阳光书房、茶室、猫咪庭院"
                                value={newRoomNameInput}
                                onChange={e => setNewRoomNameInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === "Enter" && newRoomNameInput.trim()) {
                                        void handleCreateRoom(newRoomNameInput);
                                    }
                                }}
                                autoFocus
                                style={{
                                    width: "100%",
                                    boxSizing: "border-box",
                                    padding: "8px 12px",
                                    background: "rgba(255, 255, 255, 0.05)",
                                    border: "1px solid var(--dw-line)",
                                    color: "var(--dw-ink)",
                                    fontFamily: "var(--dw-serif)",
                                    fontSize: "13px",
                                    outline: "none",
                                }}
                            />
                        </div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setShowAddRoomModal(false)}>取消</button>
                            <button
                                className="dw-confirm-btn"
                                disabled={!newRoomNameInput.trim()}
                                style={{ opacity: newRoomNameInput.trim() ? 1 : 0.5 }}
                                onClick={() => void handleCreateRoom(newRoomNameInput)}
                            >
                                构想生成
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Refresh confirm dialog */}
            {showRefreshConfirm && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setShowRefreshConfirm(false)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">刷新房间</div>
                        <div className="dw-confirm-msg">选择刷新方式</div>
                        <div className="dw-confirm-actions-col">
                            <button className="dw-confirm-option" onClick={() => { setShowRefreshConfirm(false); handleRefresh("items"); }}>
                                <span className="dw-confirm-option-text">
                                    <strong>刷新物品</strong>
                                    <small>保留房间和家具，只更新物品</small>
                                </span>
                            </button>
                            <button className="dw-confirm-option" onClick={() => { setShowRefreshConfirm(false); handleRefresh("full"); }}>
                                <span className="dw-confirm-option-text">
                                    <strong>完全重建</strong>
                                    <small>重新生成所有房间、家具和物品</small>
                                </span>
                            </button>
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" style={{ marginTop: 4 }} onClick={() => setShowRefreshConfirm(false)}>取消</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete confirm dialog */}
            {showDeleteConfirm && (
                <div className="dw-confirm-overlay">
                    <div className="dw-confirm-shade" onClick={() => setShowDeleteConfirm(false)} />
                    <div className="dw-confirm-card">
                        <div className="dw-confirm-title">要离开这里吗？</div>
                        <div className="dw-confirm-msg">房间里的一切都会消失不见哦<br />包括已经探索过的物品</div>
                        <div className="dw-confirm-actions">
                            <button className="dw-confirm-btn dw-confirm-btn-cancel" onClick={() => setShowDeleteConfirm(false)}>再想想</button>
                            <button className="dw-confirm-btn dw-confirm-btn-danger" onClick={() => { setShowDeleteConfirm(false); handleDelete(); }}>挥手告别</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

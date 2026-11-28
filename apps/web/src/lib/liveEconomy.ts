import type {
  ColdStartAdminStatus,
  ColdStartSettingsUpdate,
  GiftSendResult,
  LiveConfigResponse,
  PaidGiftCode,
  SkinInventoryResponse,
  SkinListingItem,
  StreamerStatus,
} from '@mwar/shared';
import { apiFetch } from './api';

/** V1.2 C live economy (gifts, promo codes, skins, streamer rooms, cold-start admin). Amounts are always server-decided. */

export const getLiveConfig = () => apiFetch<LiveConfigResponse>('/api/game/live-config');
export const getViewerToken = () => apiFetch<{ viewerToken: string }>('/api/game/viewer-token');

export const sendPaidGift = (body: { giftCode: PaidGiftCode; roomId: string; receiverUserId: string; clientRequestId: string }) =>
  apiFetch<GiftSendResult>('/api/gifts/send', { method: 'POST', body: JSON.stringify(body) });
export const sendAmmoBox = (body: { roomId: string; receiverUserId?: string | null; adToken: string }) =>
  apiFetch<GiftSendResult>('/api/gifts/ammo-box', { method: 'POST', body: JSON.stringify(body) });

export const redeemPromo = (code: string, deviceFp: string) =>
  apiFetch<{ success: true; code: string; ticketMicroUsd: number; energyTickets: number }>('/api/promo/redeem', { method: 'POST', body: JSON.stringify({ code, deviceFp }) });

export const getSkinInventory = () => apiFetch<SkinInventoryResponse>('/api/skins/inventory');
export const openSkinCrate = () => apiFetch<{ success: true; skin: { id: string; slug: string; kind: string; rarity: string; tint: string } }>('/api/skins/crate/open', { method: 'POST' });
export const equipSkin = (skinId: string | null, kind: 'weapon_finish' | 'outfit') => apiFetch('/api/skins/equip', { method: 'POST', body: JSON.stringify({ skinId, kind }) });
export const listSkin = (skinId: string, priceMicroUsd: number) => apiFetch('/api/skins/list', { method: 'POST', body: JSON.stringify({ skinId, priceMicroUsd }) });
export const cancelSkinListing = (id: string) => apiFetch(`/api/skins/listings/${id}/cancel`, { method: 'POST' });
export const getSkinMarket = () => apiFetch<{ items: SkinListingItem[]; feePct: number }>('/api/skins/market');
export const buySkin = (id: string) => apiFetch<{ success: true; sellerMicroUsd: number; feeMicroUsd: number; balanceMicroUsd: number }>(`/api/skins/market/${id}/buy`, { method: 'POST' });

export const getStreamerStatus = () => apiFetch<StreamerStatus>('/api/streamer/me');
export const openStreamerRoom = (title: string, mode: 'skirmish' | 'fast_mini') =>
  apiFetch<StreamerStatus & { success: true }>('/api/streamer/rooms', { method: 'POST', body: JSON.stringify({ title, mode }) });
export const closeStreamerRoom = (code: string) => apiFetch<StreamerStatus>(`/api/streamer/rooms/${code}`, { method: 'DELETE' });

export const getColdStartAdmin = () => apiFetch<ColdStartAdminStatus>('/api/admin/cold-start');
export const saveColdStartSettings = (patch: ColdStartSettingsUpdate) => apiFetch<ColdStartAdminStatus>('/api/admin/cold-start/settings', { method: 'PUT', body: JSON.stringify(patch) });
export const depositMarketingPool = (amountMicroUsd: number, note?: string) =>
  apiFetch<ColdStartAdminStatus>('/api/admin/cold-start/marketing-deposit', { method: 'POST', body: JSON.stringify({ amountMicroUsd, note }) });
export const createPromoCode = (body: { code: string; backedMicroUsdPerTicket: number; maxRedemptions: number; expiresAt?: number | null; depositMicroUsd?: number }) =>
  apiFetch<ColdStartAdminStatus>('/api/admin/cold-start/promo-codes', { method: 'POST', body: JSON.stringify(body) });
export const setPromoCodeActive = (code: string, isActive: boolean) =>
  apiFetch<ColdStartAdminStatus>(`/api/admin/cold-start/promo-codes/${code}`, { method: 'PATCH', body: JSON.stringify({ isActive }) });

/** Idempotency key for a paid gift (one per click; a retry reuses it). */
export const newGiftRequestId = () => `g_${(crypto.randomUUID?.() || `${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 64);

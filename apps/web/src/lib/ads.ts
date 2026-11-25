'use client';

import { useEffect, useState } from 'react';
import type { AdNetworkConfig, AdNetworkConfigUpdate, AdStats, DirectLinkStart, PublicAdConfig, CheerStatus } from '@mwar/shared';
import { apiFetch } from './api';

/**
 * Public ad config (GET /api/ads/config, edge-cached 60 s): fetched at most once per 60 s per tab,
 * shared by every banner / modal through one module-level promise. No polling.
 */
const SS_KEY = 'mwar_ad_config_v1';
const TTL_MS = 60_000;
let memo: { at: number; value: PublicAdConfig } | null = null;
let inflight: Promise<PublicAdConfig | null> | null = null;

export function readCachedAdConfig(): PublicAdConfig | null {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.value;
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { at: number; value: PublicAdConfig };
      if (Date.now() - v.at < TTL_MS) {
        memo = v;
        return v.value;
      }
    }
  } catch {
    /* private mode */
  }
  return null;
}

export function loadAdConfig(force = false): Promise<PublicAdConfig | null> {
  const hit = !force && readCachedAdConfig();
  if (hit) return Promise.resolve(hit);
  if (inflight && !force) return inflight;
  inflight = apiFetch<PublicAdConfig>('/api/ads/config')
    .then((value) => {
      memo = { at: Date.now(), value };
      try {
        sessionStorage.setItem(SS_KEY, JSON.stringify(memo));
      } catch {
        /* ignore */
      }
      return value;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function clearAdConfigCache() {
  memo = null;
  try {
    sessionStorage.removeItem(SS_KEY);
  } catch {
    /* ignore */
  }
}

/** null while loading or on error (callers fall back to the test-mode UI). */
export function useAdConfig(): PublicAdConfig | null {
  const [cfg, setCfg] = useState<PublicAdConfig | null>(() => (typeof window === 'undefined' ? null : readCachedAdConfig()));
  useEffect(() => {
    let alive = true;
    loadAdConfig().then((v) => alive && v && setCfg(v));
    return () => {
      alive = false;
    };
  }, []);
  return cfg;
}

export const isLiveAds = (cfg: PublicAdConfig | null | undefined) => cfg?.adMode === 'live';

// ---- Direct link (Path A) ---------------------------------------------------------------------
export interface DirectLinkClaimResult {
  success: true;
  network: string;
  country: string;
  format: string;
  effectiveMicroUsd: number;
  ecProgressPct: number;
  ecProgressAddedPct: number;
  energyTickets?: number;
  maxEnergyTickets: number;
  energyProgressPct: number;
  ticketsAwarded: number;
  cheerCount: number | null;
  status: CheerStatus | null;
}

export function startDirectLink(body: { purpose: 'ec_recharge' | 'cheer'; seconds: 15 | 30; targetType?: string; targetId?: string | null }) {
  return apiFetch<DirectLinkStart>('/api/ads/direct-link/start', { method: 'POST', body: JSON.stringify(body) });
}

export function claimDirectLink(token: string) {
  return apiFetch<DirectLinkClaimResult>('/api/ads/direct-link/claim', { method: 'POST', body: JSON.stringify({ token }) });
}

// ---- Admin (super_admin) ----------------------------------------------------------------------
export function getAdminAdConfig() {
  return apiFetch<{ config: AdNetworkConfig; postbackSecretSet: boolean }>('/api/admin/ads/config');
}

export function saveAdminAdConfig(patch: AdNetworkConfigUpdate) {
  return apiFetch<{ success: true; config: AdNetworkConfig }>('/api/admin/ads/config', { method: 'PUT', body: JSON.stringify(patch) });
}

export function getAdminAdStats() {
  return apiFetch<AdStats>('/api/admin/ads/stats');
}

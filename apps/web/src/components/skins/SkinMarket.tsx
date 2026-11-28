'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { SKIN_MIN_PRICE_MICRO_USD, formatCoins2, splitSkinSale, type SkinInventoryResponse, type SkinListingItem, type UserSkinItem } from '@mwar/shared';
import { Card, Spinner, btn, inputCls } from '../ui/Card';
import { useTranslation } from '../../i18n/I18nProvider';
import { useSession } from '../../lib/session';
import { buySkin, cancelSkinListing, equipSkin, getSkinInventory, getSkinMarket, listSkin, openSkinCrate } from '../../lib/liveEconomy';

const RARITY_CLS: Record<string, string> = {
  common: 'bg-stone-100 text-stone-600',
  rare: 'bg-sky-100 text-sky-700',
  epic: 'bg-violet-100 text-violet-700',
  legendary: 'bg-amber-100 text-amber-700',
};

function Swatch({ tint, kind }: { tint: string; kind: string }) {
  return (
    <span className="w-10 h-10 rounded-xl border border-stone-200 flex items-center justify-center text-lg shrink-0" style={{ background: `linear-gradient(135deg, ${tint}, #ffffff 160%)` }}>
      {kind === 'outfit' ? '🥷' : '🔫'}
    </span>
  );
}

/**
 * V1.2 C P2P skin marketplace: my skins (from mission Loot Crates), equip (cosmetic tint in the arena), list for C
 * (min 50 C; the seller gets price − fee, fee 5–10 %), buy (one atomic Worker batch — never a double sale).
 */
export function SkinMarket() {
  const { t } = useTranslation();
  const { boot, refresh } = useSession();
  const [inv, setInv] = useState<SkinInventoryResponse | null>(null);
  const [market, setMarket] = useState<SkinListingItem[] | null>(null);
  const [feePct, setFeePct] = useState(10);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [price, setPrice] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [i, m] = await Promise.all([getSkinInventory(), getSkinMarket()]);
      setInv(i);
      setMarket(m.items);
      setFeePct(m.feePct);
    } catch (e: any) {
      setMsg(e?.message || t('skins.loadFailed'));
    }
  }, [t]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg('');
    try {
      const r: any = await fn();
      if (typeof r?.balanceMicroUsd === 'number') void refresh?.();
      setMsg(ok);
      await load();
    } catch (e: any) {
      setMsg(e?.code === 'INSUFFICIENT' ? t('skins.insufficient') : e?.code === 'SOLD' ? t('skins.sold') : e?.message || t('skins.failed'));
    } finally {
      setBusy(false);
    }
  };

  const name = (slug: string) => t(`skins.slug.${slug}`);
  const item = (s: UserSkinItem) => {
    const c = Math.round(Number(price[s.id] || '50') * 100);
    const net = splitSkinSale(c, feePct).sellerMicroUsd;
    return (
      <div key={s.id} className="flex items-center gap-2.5 py-2" data-skin={s.slug}>
        <Swatch tint={s.tint} kind={s.kind} />
        <div className="min-w-0 flex-1">
          <div className="font-bold text-sm text-stone-900 truncate">{name(s.slug)}</div>
          <span className={`text-[10px] font-extrabold rounded-full px-2 py-0.5 ${RARITY_CLS[s.rarity]}`}>{t(`skins.rarity.${s.rarity}`)}</span>
          {s.equipped && <span className="ml-1 text-[10px] font-extrabold text-emerald-600">✓ {t('skins.equipped')}</span>}
        </div>
        {s.isListed ? (
          <button className={btn.soft} disabled={busy || !s.listingId} onClick={() => act(() => cancelSkinListing(s.listingId!), t('skins.unlisted'))}>
            {t('skins.unlist')}
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <button className={btn.soft} disabled={busy} onClick={() => act(() => equipSkin(s.equipped ? null : s.id, s.kind), s.equipped ? t('skins.unequippedMsg') : t('skins.equippedMsg'))}>
              {s.equipped ? t('skins.unequip') : t('skins.equip')}
            </button>
            {s.isTradeable && (
              <>
                <input
                  className={`${inputCls} !w-20 !py-1.5 !px-2`}
                  inputMode="decimal"
                  value={price[s.id] ?? '50'}
                  onChange={(e) => setPrice((p) => ({ ...p, [s.id]: e.target.value }))}
                  aria-label={t('skins.priceC')}
                  title={t('skins.youGet', { v: formatCoins2(net) })}
                />
                <button className={btn.dark} disabled={busy || c < SKIN_MIN_PRICE_MICRO_USD} onClick={() => act(() => listSkin(s.id, c), t('skins.listedMsg'))}>
                  {t('skins.sell')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3" data-skin-market>
      <Card className="p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-extrabold text-stone-900">🎨 {t('skins.title')}</h2>
            <p className="text-xs text-stone-500">{t('skins.hint', { fee: feePct })}</p>
          </div>
          {inv && (
            <button className={btn.primary} disabled={busy || inv.fragments < inv.fragmentsPerCrate} onClick={() => act(() => openSkinCrate(), t('skins.crateOpened'))}>
              📦 {t('skins.openCrate', { have: inv.fragments, need: inv.fragmentsPerCrate })}
            </button>
          )}
        </div>
        {msg && <p className="rounded-2xl bg-[#FFFBEA] text-[#8A6A00] text-xs font-semibold px-3 py-2">{msg}</p>}
        {!inv ? (
          <Spinner size={20} />
        ) : inv.items.length === 0 ? (
          <p className="text-sm text-stone-400 py-3">{t('skins.noSkins')}</p>
        ) : (
          <div className="divide-y divide-stone-100">{inv.items.map(item)}</div>
        )}
      </Card>
      <Card className="p-4 space-y-2">
        <h3 className="font-extrabold text-stone-900">🛒 {t('skins.marketTitle')}</h3>
        {!market ? (
          <Spinner size={20} />
        ) : market.length === 0 ? (
          <p className="text-sm text-stone-400 py-3">{t('skins.marketEmpty')}</p>
        ) : (
          <div className="divide-y divide-stone-100">
            {market.map((l) => (
              <div key={l.id} className="flex items-center gap-2.5 py-2" data-skin-listing={l.id}>
                <Swatch tint={l.tint} kind={l.kind} />
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-sm text-stone-900 truncate">{name(l.slug)}</div>
                  <div className="text-[11px] text-stone-500">
                    <span className={`font-extrabold rounded-full px-2 py-0.5 ${RARITY_CLS[l.rarity]}`}>{t(`skins.rarity.${l.rarity}`)}</span> · {t('skins.by', { name: l.sellerUsername })}
                  </div>
                </div>
                <button className={btn.primary} disabled={busy || l.sellerId === boot?.user.id} onClick={() => act(() => buySkin(l.id), t('skins.bought'))}>
                  {t('skins.buyFor', { v: formatCoins2(l.priceMicroUsd) })}
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

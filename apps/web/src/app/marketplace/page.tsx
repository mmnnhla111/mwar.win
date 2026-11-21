'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { formatMicroUsd, formatCoins } from '@mwar/shared';
import { BountyChestIcon, GoldCoinIcon, UsdDollarIcon } from '../../components/icons';

export default function MarketplacePage() {
  const [listings, setListings] = useState<any[]>([]);
  const [downlines, setDownlines] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [listingPriceUsd, setListingPriceUsd] = useState('15.00');
  const [actionMsg, setActionMsg] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadMarketplace = async () => {
    setLoading(true);
    try {
      const [marketRes, downlineRes] = await Promise.all([
        apiFetch('/api/marketplace/listings'),
        apiFetch('/api/network/downline'),
      ]);
      setListings(marketRes.listings || []);
      // Filter direct Level 1 downlines for listing
      setDownlines((downlineRes.members || []).filter((m: any) => m.depth === 1));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMarketplace();
  }, []);

  const handleCreateListing = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionMsg('');
    setIsSubmitting(true);
    try {
      const priceMicroUsd = Math.round(parseFloat(listingPriceUsd) * 1_000_000);
      await apiFetch('/api/marketplace/listings', {
        method: 'POST',
        body: JSON.stringify({
          target_user_id: selectedTargetId,
          price_micro_usd: priceMicroUsd,
        }),
      });
      setShowCreateModal(false);
      setActionMsg('Downline squad member successfully listed on the marketplace!');
      await loadMarketplace();
    } catch (err: any) {
      setActionMsg(`Listing Error: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBuy = async (listingId: string, priceFormatted: string) => {
    if (!confirm(`Confirm purchase of this referral member for ${priceFormatted}? (Protected by 30-day warranty escrow)`)) {
      return;
    }
    setActionMsg('');
    try {
      const res = await apiFetch('/api/marketplace/buy', {
        method: 'POST',
        body: JSON.stringify({ listing_id: listingId }),
      });
      setActionMsg(`Purchase successful! ${res.message}`);
      await loadMarketplace();
    } catch (err: any) {
      setActionMsg(`Purchase Error: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* 1. Header Banner */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-5 sm:p-6 shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center space-x-3.5">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
            <BountyChestIcon size={28} />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight flex items-center space-x-2">
              <span>REFERRAL SQUAD MARKETPLACE</span>
              <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-black px-2 py-0.5 rounded-full">
                30-DAY ESCROW
              </span>
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Trade active Level 1 downline earners. Funds held in automated 30-day escrow warranty.
            </p>
          </div>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black px-4 py-2.5 rounded-2xl text-xs transition shadow-lg shadow-amber-500/20 active:scale-95 shrink-0"
        >
          + List Downline For Sale
        </button>
      </div>

      {actionMsg && (
        <div className="bg-slate-900 border border-amber-500/60 text-amber-200 text-xs p-3.5 rounded-2xl shadow-md">
          {actionMsg}
        </div>
      )}

      {/* 2. Listings Grid */}
      {loading ? (
        <div className="p-16 text-center text-sm text-slate-400 animate-pulse">Loading marketplace listings...</div>
      ) : listings.length === 0 ? (
        <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-12 text-center space-y-3 shadow-xl">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-800 flex items-center justify-center text-2xl">
            🛒
          </div>
          <h3 className="text-base font-black text-white">No Downline Listings Active</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            There are currently no downlines listed for sale. List one of your direct Level 1 referrals to monetize your squad!
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {listings.map((l) => (
            <div
              key={l.id}
              className="bg-slate-900/95 border border-slate-800 hover:border-slate-700 rounded-3xl p-5 shadow-xl space-y-4 transition flex flex-col justify-between"
            >
              <div className="space-y-3">
                <div className="flex justify-between items-start">
                  <div className="flex items-center space-x-2.5">
                    <div className="w-10 h-10 rounded-2xl bg-slate-800 border-2 border-amber-400/60 flex items-center justify-center font-black text-amber-300 text-sm">
                      {l.targetUsername?.substring(0, 2).toUpperCase() || 'SQ'}
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-white">{l.targetUsername}</h4>
                      <span className="text-[10px] text-slate-400">Seller: {l.sellerUsername}</span>
                    </div>
                  </div>
                  <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-black px-2 py-0.5 rounded-full">
                    30D WARRANTY
                  </span>
                </div>

                <div className="bg-slate-950/80 p-3 rounded-2xl border border-slate-800 grid grid-cols-2 gap-2 text-center">
                  <div>
                    <span className="text-[10px] text-slate-500 font-bold block uppercase">Lifetime Earned</span>
                    <span className="text-xs font-black text-emerald-400 font-mono">
                      {formatMicroUsd(l.targetTotalEarnedMicroUsd || 0)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 font-bold block uppercase">Squad Depth</span>
                    <span className="text-xs font-black text-amber-400">Direct (L1)</span>
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-slate-400 block font-bold">Asking Price:</span>
                  <div className="flex items-center space-x-1">
                    <span className="text-base font-black text-white font-mono">
                      {formatMicroUsd(l.priceMicroUsd)}
                    </span>
                    <span className="text-[11px] text-amber-400 font-mono font-bold">
                      ({formatCoins(l.priceMicroUsd)})
                    </span>
                  </div>
                </div>

                <button
                  onClick={() => handleBuy(l.id, formatMicroUsd(l.priceMicroUsd))}
                  className="bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-black text-xs px-4 py-2.5 rounded-xl shadow-lg shadow-rose-600/30 active:scale-95 transition"
                >
                  BUY MEMBER
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 3. Create Listing Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <h3 className="text-base font-black text-white">LIST DOWNLINE REFERRAL FOR SALE</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-white text-xl font-bold p-1"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateListing} className="space-y-4">
              <div>
                <label className="text-xs font-bold text-slate-300 block mb-1">
                  Select Direct Level 1 Downline:
                </label>
                {downlines.length === 0 ? (
                  <p className="text-xs text-rose-400 bg-rose-950/40 p-2.5 rounded-xl border border-rose-900/40">
                    You have no direct Level 1 downline members to sell. Enlist referrals first!
                  </p>
                ) : (
                  <select
                    value={selectedTargetId}
                    onChange={(e) => setSelectedTargetId(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white font-bold focus:border-amber-400 focus:outline-none"
                  >
                    <option value="">-- Choose Member --</option>
                    {downlines.map((d) => (
                      <option key={d.userId} value={d.userId}>
                        {d.username} (Earned: {formatMicroUsd(d.totalEarnedMicroUsd)})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="text-xs font-bold text-slate-300 block mb-1">
                  Listing Price (USD):
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-xs text-slate-400 font-bold">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    value={listingPriceUsd}
                    onChange={(e) => setListingPriceUsd(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-7 pr-3 py-2 text-xs text-white font-bold font-mono focus:border-amber-400 focus:outline-none"
                  />
                </div>
                <p className="text-[10px] text-slate-500 mt-1">
                  Equivalent to {(parseFloat(listingPriceUsd || '0') * 10000).toLocaleString()} Coins ($0.01 = 100 Coins).
                </p>
              </div>

              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-[11px] text-slate-400 space-y-1">
                <span className="text-amber-400 font-bold block">30-Day Escrow Warranty:</span>
                <p>
                  Upon purchase, the buyer receives this referral in their downline tree. Funds are released after 30 days of active member activity.
                </p>
              </div>

              <div className="flex space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-2.5 rounded-xl text-xs transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!selectedTargetId || isSubmitting}
                  className="flex-1 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black py-2.5 rounded-xl text-xs transition shadow-lg shadow-amber-500/20 disabled:opacity-50"
                >
                  {isSubmitting ? 'Listing...' : 'Confirm Listing'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

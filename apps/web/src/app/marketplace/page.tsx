'use client';

import React, { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';
import { formatMicroUsd } from '@mwar/shared';

export default function MarketplacePage() {
  const [listings, setListings] = useState<any[]>([]);
  const [downlines, setDownlines] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [listingPriceUsd, setListingPriceUsd] = useState('15.00');
  const [actionMsg, setActionMsg] = useState('');

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
      setActionMsg('Downline member successfully listed on the marketplace!');
      await loadMarketplace();
    } catch (err: any) {
      setActionMsg(`Listing Error: ${err.message}`);
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
    <div className="space-y-6 py-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-black text-white">REFERRAL MARKETPLACE</h1>
          <p className="text-xs text-gray-400 mt-1">
            Trade high-performing downline team members. All transactions protected with a 30-day escrow warranty.
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-red-600 hover:bg-red-500 text-white font-bold px-4 py-2 rounded-xl text-xs transition"
        >
          + List Downline for Sale
        </button>
      </div>

      {actionMsg && (
        <div className="bg-yellow-950/60 border border-yellow-700/60 text-yellow-300 text-xs p-3 rounded-xl">
          {actionMsg}
        </div>
      )}

      {/* Listings Grid */}
      {loading ? (
        <div className="p-12 text-center text-sm text-gray-400">Loading marketplace listings...</div>
      ) : listings.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-gray-800 p-12 text-center space-y-3">
          <span className="text-4xl block">🏪</span>
          <h3 className="text-base font-bold text-white">No Active Listings Available</h3>
          <p className="text-xs text-gray-400 max-w-md mx-auto">
            You can list your active Level 1 direct referrals for sale to earn instant cash, or wait for other commanders to post their downlines.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {listings.map((l) => (
            <div key={l.id} className="bg-surface rounded-2xl border border-gray-800 p-5 space-y-4 hover:border-gray-700 transition">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-[10px] font-bold bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded border border-yellow-500/30">
                    30-DAY ESCROW WARRANTY
                  </span>
                  <h4 className="text-base font-black text-white mt-1.5">{l.targetUsername}</h4>
                  <span className="text-xs text-gray-400">Seller: {l.sellerUsername}</span>
                </div>
                <div className="text-right">
                  <span className="text-xs text-gray-400 block">Price</span>
                  <span className="text-lg font-black text-emerald-400">{l.formattedPrice}</span>
                </div>
              </div>

              <div className="bg-surfaceLight/50 p-3 rounded-xl border border-gray-800 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-400">Lifetime Earnings:</span>
                  <span className="font-bold text-white">{l.formattedTargetEarned}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Joined Date:</span>
                  <span className="text-gray-300">{new Date(l.targetJoinedAt * 1000).toLocaleDateString()}</span>
                </div>
              </div>

              <button
                onClick={() => handleBuy(l.id, l.formattedPrice)}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black py-2 rounded-xl text-xs transition shadow-md"
              >
                BUY REFERRAL ({l.formattedPrice})
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Create Listing Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-surface border border-gray-700 w-full max-w-md rounded-2xl p-6 space-y-4 shadow-2xl">
            <div className="flex justify-between items-center border-b border-gray-800 pb-3">
              <h3 className="text-base font-black text-white">List Direct Downline for Sale</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-gray-400 hover:text-white text-xs bg-gray-800 px-2 py-1 rounded"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateListing} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-400 block mb-1">
                  Select Direct Downline (Level 1):
                </label>
                {downlines.length === 0 ? (
                  <p className="text-xs text-red-400">You do not have any Level 1 direct referrals to list.</p>
                ) : (
                  <select
                    value={selectedTargetId}
                    onChange={(e) => setSelectedTargetId(e.target.value)}
                    required
                    className="w-full bg-surfaceLight border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                  >
                    <option value="">-- Choose Downline Member --</option>
                    {downlines.map((d) => (
                      <option key={d.userId} value={d.userId}>
                        {d.username} (Earned: {d.formattedTotalEarned})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="text-xs font-semibold text-gray-400 block mb-1">
                  Asking Price in USD ($):
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="1.00"
                  value={listingPriceUsd}
                  onChange={(e) => setListingPriceUsd(e.target.value)}
                  required
                  className="w-full bg-surfaceLight border border-gray-700 rounded-lg px-3 py-2 text-xs text-white"
                />
                <span className="text-[11px] text-gray-500 block mt-1">
                  Funds released after 30-day warranty escrow period.
                </span>
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 font-semibold py-2 rounded-xl text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={downlines.length === 0 || !selectedTargetId}
                  className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold py-2 rounded-xl text-xs"
                >
                  Publish Listing
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

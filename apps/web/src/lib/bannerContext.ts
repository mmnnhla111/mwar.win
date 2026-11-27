/**
 * V1.1 Round 2 — where the player's banner impressions are being earned.
 * While a Fast & Mini seat is live, every verified banner ping carries `fastMiniEntryId` (= the pot id the
 * Worker opened at POST /api/game/enter): the Worker splits that banner's safe value once — 50 % into the
 * player's own Fast & Mini pot (what a killer can win, 90 / 10), 50 % EC backing. Pings are then sent one
 * by one (no batching) so the pot is funded before the next death. Amounts are always decided server-side.
 */
let fastMiniEntryId: string | null = null;

export function setFastMiniBannerPot(id: string | null) {
  fastMiniEntryId = id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export function bannerContextPayload(): { fastMiniEntryId?: string } {
  return fastMiniEntryId ? { fastMiniEntryId } : {};
}

/** Fast & Mini: credit every impression immediately (the pot must be funded before the next death). */
export function bannerBatchSize(normal: number): number {
  return fastMiniEntryId ? 1 : normal;
}

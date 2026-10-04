// functions/auctionSettle.js
// うーこオークション(ukoMarketListings)の期限切れ出品の精算をサーバー側で行う(2026-10-04)。
// 以前は 26_UkoAuction/script.js の settleExpiredListings で「一覧を開いている人のブラウザ」が
// 精算していたため、開いている人の数だけ同じ出品を精算しに行き、そのたびに出品・出品者・落札者の
// データを読んでいた(期限切れは1日数百件)。誰も開いていない時間は精算が止まる問題もあった。
// 中身は 26_UkoAuction/script.js の settleListing と同じ(落札 → 落札者にアイテム・出品者に落札額、
// 入札なし → 出品者にアイテムを返却)。キャンペーンのボーナスは ukoPointsLog に記録するだけで、
// 実際の付与はキャンペーン終了後の集計メール経由(従来どおり)。

const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

const FV = admin.firestore.FieldValue;
const AUCTION_WIN_MISSION_CLAIM_KEY = 'omikujiAuctionWin'; // 26_UkoAuction/script.js と同じ
const BATCH_LIMIT = 300; // 1回の実行で精算する上限(残りは次の回へ)

function logEntry(userId, amount, type, meta = {}) {
  return { userId, amount, type, meta, createdAt: FV.serverTimestamp() };
}

// キャンペーンが今有効か。adminOnly(テスト中)のキャンペーンは、ボーナスを受け取る人が
// 管理者ロールのときだけ効かせる(以前はブラウザで精算した人のロールで決まっていた)
function isActive(c, now, beneficiaryIsAdmin) {
  if (!c.enabled) return false;
  if (c.adminOnly && !beneficiaryIsAdmin) return false;
  return c.startsAt && c.endsAt && c.startsAt.toMillis() <= now && now <= c.endsAt.toMillis();
}
function best(campaigns, type, key, now, isAdmin) {
  const active = campaigns.filter((c) => c.type === type && isActive(c, now, isAdmin));
  if (!active.length) return null;
  return active.reduce((b, c) => ((c[key] || 0) > (b[key] || 0) ? c : b));
}

async function isAdminUser(db, cache, userId) {
  if (!userId) return false;
  if (!cache.has(userId)) {
    const snap = await db.collection('sharedUserRoles').doc(userId).get();
    cache.set(userId, snap.exists && snap.data().role === 'admin');
  }
  return cache.get(userId);
}

async function settleOne(db, ref, campaigns, roleCache) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const d = snap.data();
    if (d.status !== 'active') return;
    const now = Date.now();
    if (!d.endsAt || d.endsAt.toMillis() > now) return;
    const listingId = ref.id;

    if (d.currentBidderId) {
      const winnerRef = db.collection('omikujiUsers').doc(d.currentBidderId);
      const sellerRef = db.collection('omikujiUsers').doc(d.sellerId);
      const [winnerSnap, sellerSnap] = await Promise.all([tx.get(winnerRef), tx.get(sellerRef)]);
      const anyAdminOnly = campaigns.some((c) => c.adminOnly);
      const winnerAdmin = anyAdminOnly ? await isAdminUser(db, roleCache, d.currentBidderId) : false;
      const sellerAdmin = anyAdminOnly ? await isAdminUser(db, roleCache, d.sellerId) : false;
      if (winnerSnap.exists) {
        const bidderCampaign = best(campaigns, 'bidderBonus', 'rate', now, winnerAdmin);
        const cashback = bidderCampaign ? Math.round(d.currentBid * (bidderCampaign.rate || 0) / 100) : 0;
        if (cashback > 0) {
          tx.set(db.collection('ukoPointsLog').doc(), logEntry(
            d.currentBidderId, cashback, 'auctionCashback',
            { listingId, itemName: d.itemName, campaignId: bidderCampaign.id, campaignType: 'bidderBonus' },
          ));
        }
        tx.update(winnerRef, {
          [d.returnField]: FV.increment(1),
          [`missionsAchieved.${AUCTION_WIN_MISSION_CLAIM_KEY}`]: true,
        });
      }
      if (sellerSnap.exists) {
        const sellerCampaign = best(campaigns, 'sellerBonus', 'multiplier', now, sellerAdmin);
        const multiplier = sellerCampaign ? Math.max(1, sellerCampaign.multiplier || 1) : 1;
        const bonusPoints = Math.round(d.currentBid * multiplier);
        tx.update(sellerRef, { ukoPoints: FV.increment(d.currentBid) });
        tx.set(db.collection('ukoPointsLog').doc(), logEntry(
          d.sellerId, d.currentBid, 'auctionSale', { listingId, itemName: d.itemName, soldPrice: d.currentBid },
        ));
        const sellerBonusDelta = bonusPoints - d.currentBid;
        if (sellerBonusDelta > 0 && sellerCampaign) {
          tx.set(db.collection('ukoPointsLog').doc(), logEntry(
            d.sellerId, sellerBonusDelta, 'auctionSaleBonus',
            { listingId, itemName: d.itemName, campaignId: sellerCampaign.id, campaignType: 'sellerBonus' },
          ));
        }
      }
      tx.update(ref, { status: 'sold', soldVia: 'bid', soldPrice: d.currentBid, soldTo: d.currentBidderId, soldAt: FV.serverTimestamp() });
    } else {
      // 入札なしで終了 → 出品者に返却
      const sellerRef = db.collection('omikujiUsers').doc(d.sellerId);
      const sellerSnap = await tx.get(sellerRef);
      if (sellerSnap.exists && typeof d.returnField === 'string') {
        tx.update(sellerRef, { [d.returnField]: FV.increment(1) });
      }
      tx.update(ref, { status: 'unsold' });
    }
  });
}

exports.auctionSettleSweep = onSchedule({ schedule: 'every 5 minutes', region: 'asia-northeast1' }, async () => {
  const db = admin.firestore();
  const expired = await db.collection('ukoMarketListings')
    .where('status', '==', 'active')
    .where('endsAt', '<=', admin.firestore.Timestamp.now())
    .orderBy('endsAt', 'asc')
    .limit(BATCH_LIMIT)
    .get();
  if (expired.empty) return;
  const campaigns = (await db.collection('ukoAuctionCampaigns').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const roleCache = new Map();
  let ok = 0;
  for (const d of expired.docs) {
    try {
      await settleOne(db, d.ref, campaigns, roleCache);
      ok++;
    } catch (e) {
      console.error('[auctionSettleSweep] settle failed', d.id, e);
    }
  }
  console.log('[auctionSettleSweep] settled', ok, '/', expired.size);
});

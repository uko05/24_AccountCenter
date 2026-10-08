// functions/auctionLimit.js
// うーこオークション(ukoMarketListings)の同時出品数の上限を、サーバー側でも守らせる。
// 14_GenshinOmikuji v4.27(2026-10-02)で「1人50件まで」をブラウザ側に入れたが、上限を入れる前に
// 開いたタブ(古いプログラム)からは素通りで出品できてしまう。ルールで出品を拒否すると、古い
// おみくじは先に手持ちの裏面デザインを減らしてから出品するため、アイテムが消えてしまう。
// そこで出品はいったん受け付け、この関数が「上限超えの出品」をすぐ売れ残り扱いにして返却する。
//
// - 数えるのは、その出品者の出品中(status=='active')の件数。今作られた出品自身も含む。
// - 上限を超えた「新しい出品」だけを戻す。上限導入前から出ている出品はそのまま。
// - 返却は26_UkoAuctionの「入札なしで終了」と同じ形(returnField を +1、status='unsold')。

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

// 14_GenshinOmikuji/auction.js の MAX_ACTIVE_LISTINGS_PER_USER と同じ値にすること
const MAX_ACTIVE_LISTINGS_PER_USER = 30; // 2026-10-07に50→30

exports.enforceAuctionListingLimit = onDocumentCreated('ukoMarketListings/{listingId}', async (event) => {
  const listing = event.data && event.data.data();
  if (!listing || listing.status !== 'active' || !listing.sellerId) return;

  const db = admin.firestore();
  // スタレ裏面(itemIdがsr_***、2026-10-09追加)は出品できない。古い画面などから出品されたら
  // 件数に関係なく、すぐ売れ残り扱いにして本人に返す(14_GenshinOmikuji/gachaBacks.js参照)
  const notListable = listing.siteKey === 'omikuji' && typeof listing.itemId === 'string' && listing.itemId.startsWith('sr_');
  let activeCount = null;
  if (!notListable) {
    const countSnap = await db.collection('ukoMarketListings')
      .where('sellerId', '==', listing.sellerId)
      .where('status', '==', 'active')
      .count()
      .get();
    activeCount = countSnap.data().count;
    if (activeCount <= MAX_ACTIVE_LISTINGS_PER_USER) return;
  }

  const ref = event.data.ref;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data();
    // すでに精算された・入札が入った出品には触らない
    if (!d || d.status !== 'active' || (d.bidCount || 0) > 0) return;
    const sellerRef = db.collection('omikujiUsers').doc(d.sellerId);
    const sellerSnap = await tx.get(sellerRef);
    if (sellerSnap.exists && typeof d.returnField === 'string' && d.returnField.startsWith('cardBacks.')) {
      tx.update(sellerRef, { [d.returnField]: admin.firestore.FieldValue.increment(1) });
    }
    tx.update(ref, {
      status: 'unsold',
      cancelledReason: notListable ? 'notListable' : 'activeLimit',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  console.log('[enforceAuctionListingLimit] returned', notListable ? 'not-listable' : 'over-limit', 'listing', event.params.listingId, listing.sellerId, activeCount);
});

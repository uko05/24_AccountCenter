// functions/likeNotifCleanup.js
// 原神おみくじのいいね通知(omikujiLikeNotifications)を、作られてから24時間たったら消す(2026-10-07)。
// 未表示の通知がたまった人(多い人で1人200件以上、全体で約3万件)は、おみくじを開くたびに
// それを全部読み込んでいて、読み取り課金の原因になっていた。いいねから24時間たった通知は
// トーストにも出さない(14_GenshinOmikuji/feed.js 側も24時間以内だけを購読する)。
// Cloud Schedulerの無料枠(3つ)に収めるため、専用の定期実行は作らず、arcanaTrade.js の
// arcanaTradeSweep(1時間ごと)から呼んでいる。

const admin = require('firebase-admin');

const KEEP_MS = 24 * 60 * 60 * 1000;
const BATCH = 400;
const MAX_PER_RUN = 20000; // 1回の実行で消す上限(最初の大量の溜まり分は数回に分けて消える)

async function cleanupOldLikeNotifications() {
  const db = admin.firestore();
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - KEEP_MS);
  let deleted = 0;
  while (deleted < MAX_PER_RUN) {
    const snap = await db.collection('omikujiLikeNotifications')
      .where('createdAt', '<', cutoff)
      .orderBy('createdAt', 'asc')
      .limit(BATCH)
      .select()
      .get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.size;
    if (snap.size < BATCH) break;
  }
  console.log('[likeNotifCleanup] deleted', deleted);
}

module.exports = { cleanupOldLikeNotifications };

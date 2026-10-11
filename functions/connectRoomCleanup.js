// functions/connectRoomCleanup.js
// コネクトバトルの対戦部屋(connectRooms)のうち、作られてから2時間以上たったものを消す(2026-10-11)。
// 途中で閉じた対戦などの部屋が残ると、マッチングで「待っている部屋」を探す時に余計に読み取りが増えるため。
// 1試合は長くても数十分なので、2時間たった部屋は使われていない。
// レート計算(connectRateMatch)が終わっていない決着済みの部屋(bo3Final:true かつ rated:false)は念のため残す。
// Cloud Schedulerの無料枠(3つ)に収めるため、専用の定期実行は作らず、arcanaTrade.js の
// arcanaTradeSweep(1時間ごと)から呼んでいる。

const admin = require('firebase-admin');

const KEEP_MS = 2 * 60 * 60 * 1000;

function toMillis(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

async function cleanupOldConnectRooms() {
  const db = admin.firestore();
  // 部屋の数は少ない(同時に対戦している数だけ)ので、全件を見て古いものを消す。
  // createdAt が文字列の古い部屋もあるため、クエリではなくここで判定する
  const snap = await db.collection('connectRooms').get();
  const cutoff = Date.now() - KEEP_MS;
  const targets = snap.docs.filter((d) => {
    const data = d.data();
    if (data.bo3Final === true && data.rated !== true) return false;
    const created = toMillis(data.createdAt) ?? toMillis(data.player1_LastActive);
    return created === null || created < cutoff;
  });
  for (let i = 0; i < targets.length; i += 400) {
    const batch = db.batch();
    targets.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  console.log('[connectRoomCleanup] rooms', snap.size, 'deleted', targets.length);
  return targets.length;
}

module.exports = { cleanupOldConnectRooms };

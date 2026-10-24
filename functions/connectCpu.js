// functions/connectCpu.js
// 10_connect(コネバト)のレート戦で、相手が見つからない時に当てるCPU戦(2026-10-25)。
//
// 流れ:
//   1. connectCpuStart … CPUの名前・キャラ・レート・強さ・シード(乱数のもと)をサーバーが決め、
//      connectUsers/{uid}.cpuMatch に保存して返す(クライアントはこれで対局を進める)
//   2. connectCpuFinish … クライアントは「自分の操作の記録」だけを送る。サーバーは同じシードで
//      対局を最初から再現し(connectEngine.mjs)、本当にその結果になるか確かめてからレートを動かす。
//      CPUの手はシードから決まるので、クライアントがごまかせるのは自分の手だけ(=普通に打つのと同じ)
//   3. 途中で閉じた対局(cpuMatch が残ったまま)は「退出の負け」にする。次に connectCpuStart を
//      呼んだ時と、1時間ごとの掃除(settleAbandonedCpuMatches)で処理する
//
// connectEngine.mjs は 10_connect/public/scripts/engine/connectEngine.js の写し。
// あちらを直したら、こちらにも同じ内容をコピーすること(中身が違うと再現が合わず、レートが付かない)。
//
// 読み取り・書き込み(1試合): 開始 読み1・書き1 / 終了 読み1・書き2(ユーザー・試合記録)

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');

const INITIAL_RATING = 1500;
const RATING_FLOOR = 100;
const LEAVE_PENALTY_MULTIPLIER = 1.5;   // connect.js と同じ
const CPU_K_MULTIPLIER = 0.5;           // CPU戦のレート変動は対人戦の半分(2026-10-25 決定)
const CPU_RATING_SPREAD = 80;           // CPUのレート = プレイヤーのレート ±80
const ABANDON_MS = 30 * 60 * 1000;      // 30分たっても終わっていないCPU戦は途中で閉じたとみなす
const MAX_LOG = 600;

// 人間っぽい名前(2026-10-25: ゲームにちなんだ名前・ふざけた名前は使わない)
const NAMES = [
  'もちこ', 'ぽてと', 'みかん', 'ねむい', 'さくら', 'うに', 'こむぎ', 'しらす', 'あんず', 'ぷりん',
  'まめ', 'くるみ', 'ゆず', 'もなか', 'たまご', 'すず', 'ひなた', 'つむぎ', 'のどか', 'あおい',
  'ハル', 'ユキ', 'ソラ', 'ルナ', 'コハク', 'リン', 'ミオ', 'カイ', 'レン', 'ナギ',
  'シオン', 'アオ', 'トワ', 'ヒカリ', 'マシロ', 'ツバサ', 'クロ', 'ミント', 'ココ', 'ノア',
  'haru', 'mochi', 'yuki', 'sora', 'kuro', 'rinrin', 'nagi', 'mio', 'ren', 'kai',
  'momo', 'tsubasa', 'akane', 'hina', 'riku', 'yuu', 'sho', 'kei', 'taku', 'nao',
  'たなか', 'ゆう', 'けんと', 'あやか', 'しょう', 'だいき', 'みさき', 'りょう', 'まい', 'こうた',
  'ゆうき', 'はると', 'えみ', 'かな', 'そうた', 'ななみ', 'たくみ', 'あゆ', 'けい', 'ちひろ',
];
const DEFAULT_NAME = 'プレイヤー';

function randInt(n) { return crypto.randomInt(n); }
function cpuName() {
  if (randInt(12) === 0) return DEFAULT_NAME;
  let n = NAMES[randInt(NAMES.length)];
  // 英字の名前は後ろに数字が付くことが多い。かなの名前もたまに付ける
  const latin = /^[a-z]/.test(n);
  if (latin ? randInt(10) < 7 : randInt(10) < 2) {
    const style = randInt(3);
    const num = style === 0 ? String(randInt(100)).padStart(2, '0') : style === 1 ? String(randInt(10)) : String(1 + randInt(12)) + String(1 + randInt(28)).padStart(2, '0');
    n = latin && randInt(2) === 0 ? `${n}_${num}` : `${n}${num}`;
  }
  return n;
}
function kOf(matchCount) {
  if (matchCount < 10) return 48;
  if (matchCount < 50) return 32;
  return 16;
}
async function engine() { return import('./connectEngine.mjs'); }

// プレイヤー(rating, matchCount)の CPU戦の結果からレート変動を計算
function ratingAfter(rating, matchCount, cpuRating, result, resultType) {
  const e = 1 / (1 + Math.pow(10, (cpuRating - rating) / 400));
  const k = kOf(matchCount) * CPU_K_MULTIPLIER;
  const score = result === 'player' ? 1 : result === 'draw' ? 0.5 : 0;
  let delta = k * (score - e);
  if (score === 0 && (resultType === 'leave' || resultType === 'timeout')) delta *= LEAVE_PENALTY_MULTIPLIER;
  return Math.max(RATING_FLOOR, Math.round(rating + delta));
}

// ユーザー更新の中身(勝てば charaWins も増やす)。cpuMatch は消す
function userUpdate(u, m, result, newRating) {
  const won = result === 'player';
  const charaWins = { ...(u.charaWins || {}) };
  if (won) charaWins[m.playerCharaId] = (charaWins[m.playerCharaId] || 0) + 1;
  return {
    rating: newRating,
    matchCount: (u.matchCount || 0) + 1,
    winCount: (u.winCount || 0) + (won ? 1 : 0),
    charaWins,
    lastMatchAt: admin.firestore.FieldValue.serverTimestamp(),
    cpuMatch: admin.firestore.FieldValue.delete(),
  };
}
function matchRecord(uid, u, m, st, newRating, extra = {}) {
  return {
    cpu: true, rated: true, reason: null,
    resultType: st.resultType, result: st.result,
    winnerUid: st.result === 'player' ? uid : null,
    p1Uid: uid, p1CharaId: m.playerCharaId, p1Color: m.playerColor,
    p1RatingBefore: u.rating ?? INITIAL_RATING, p1RatingAfter: newRating,
    p1MatchCountBefore: u.matchCount || 0,
    cpuName: m.cpuName, cpuCharaId: m.cpuCharaId, cpuRating: m.cpuRating, cpuDepth: m.profile.depth,
    playerWins: st.wins?.player ?? 0, cpuWins: st.wins?.cpu ?? 0,
    p1UltCount: st.ultCount?.player ?? 0, cpuUltCount: st.ultCount?.cpu ?? 0,
    startedAt: m.startedAt || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    ...extra,
  };
}
// 途中で閉じた対局を「退出の負け」として処理する(トランザクションの中で呼ぶ)
function settleAbandoned(tx, db, uid, u) {
  const m = u.cpuMatch;
  const st = { result: 'cpu', resultType: 'leave', wins: null, ultCount: null };
  const newRating = ratingAfter(u.rating ?? INITIAL_RATING, u.matchCount || 0, m.cpuRating, 'cpu', 'leave');
  tx.set(db.collection('connectUsers').doc(uid), userUpdate(u, m, 'cpu', newRating), { merge: true });
  tx.set(db.collection('connectMatches').doc(m.matchId), matchRecord(uid, u, m, st, newRating, { abandoned: true }));
  return newRating;
}

exports.connectCpuStart = onCall({ region: 'asia-northeast1' }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'login required');
  const E = await engine();
  const playerCharaId = String(req.data?.charaId || '');
  if (!E.CHARA_RULES[playerCharaId]) throw new HttpsError('invalid-argument', 'bad chara');

  const db = admin.firestore();
  const userRef = db.collection('connectUsers').doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    let u = snap.exists ? snap.data() : { rating: INITIAL_RATING, matchCount: 0, winCount: 0, charaWins: {} };
    let rating = u.rating ?? INITIAL_RATING;
    let abandonedSettled = false;
    if (u.cpuMatch) { // 前のCPU戦を途中で閉じていた → 負けにしてから始める
      rating = settleAbandoned(tx, db, uid, u);
      u = { ...u, rating, matchCount: (u.matchCount || 0) + 1 };
      abandonedSettled = true;
    }
    const cpuRating = Math.max(RATING_FLOOR, rating + randInt(CPU_RATING_SPREAD * 2 + 1) - CPU_RATING_SPREAD);
    const ids = Object.keys(E.CHARA_RULES);
    const m = {
      matchId: 'cpu_' + crypto.randomBytes(10).toString('hex'),
      seed: crypto.randomBytes(16).toString('hex'),
      engineVersion: E.ENGINE_VERSION,
      playerCharaId,
      playerColor: randInt(2) === 0 ? 'red' : 'yellow',
      cpuCharaId: ids[randInt(ids.length)],
      cpuName: cpuName(),
      cpuRating,
      profile: E.profileForRating(cpuRating),
      startedAt: Date.now(),
    };
    tx.set(userRef, { cpuMatch: m }, { merge: true });
    return { ...m, playerRating: rating, abandonedSettled };
  });
});

exports.connectCpuFinish = onCall({ region: 'asia-northeast1', memory: '1GiB', timeoutSeconds: 120 }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'login required');
  const matchId = String(req.data?.matchId || '');
  const log = req.data?.log;
  if (!Array.isArray(log) || log.length > MAX_LOG) throw new HttpsError('invalid-argument', 'bad log');

  const db = admin.firestore();
  const userRef = db.collection('connectUsers').doc(uid);
  // 再現は重い(数秒かかることがある)ので、トランザクションの外で先に行う
  const first = await userRef.get();
  const m0 = first.data()?.cpuMatch;
  if (!m0 || m0.matchId !== matchId) throw new HttpsError('failed-precondition', 'no such match');
  const E = await engine();
  let st;
  try {
    const clean = log.map((o) => ({ a: String(o?.a || ''), c: Number.isInteger(o?.c) ? o.c : undefined }));
    st = E.replay({ seed: m0.seed, playerCharaID: m0.playerCharaId, cpuCharaID: m0.cpuCharaId, playerColor: m0.playerColor, profile: m0.profile }, clean);
  } catch (e) {
    console.warn('[connectCpuFinish] replay failed', uid, matchId, e.message);
    st = null;
  }
  // 再現できない記録・途中で終わっている記録は「退出の負け」
  if (!st || !st.over) st = { result: 'cpu', resultType: 'leave', wins: st?.wins || null, ultCount: st?.ultCount || null, invalid: !st };

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const u = snap.data() || {};
    const m = u.cpuMatch;
    if (!m || m.matchId !== matchId) throw new HttpsError('failed-precondition', 'already settled');
    const newRating = ratingAfter(u.rating ?? INITIAL_RATING, u.matchCount || 0, m.cpuRating, st.result, st.resultType);
    tx.set(userRef, userUpdate(u, m, st.result, newRating), { merge: true });
    tx.set(db.collection('connectMatches').doc(matchId), matchRecord(uid, u, m, st, newRating, st.invalid ? { invalidLog: true } : {}));
    return {
      result: st.result, resultType: st.resultType, straight: !!st.straight,
      ratingBefore: u.rating ?? INITIAL_RATING, ratingAfter: newRating,
      winCount: (u.winCount || 0) + (st.result === 'player' ? 1 : 0),
    };
  });
});

// 1時間ごとの掃除(arcanaTradeSweep から呼ぶ): 30分以上終わっていないCPU戦を退出の負けにする
async function settleAbandonedCpuMatches() {
  const db = admin.firestore();
  const snap = await db.collection('connectUsers').where('cpuMatch.startedAt', '<', Date.now() - ABANDON_MS).limit(200).get();
  let n = 0;
  for (const d of snap.docs) {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(d.ref);
      const u = s.data();
      if (!u?.cpuMatch || u.cpuMatch.startedAt >= Date.now() - ABANDON_MS) return;
      settleAbandoned(tx, db, d.id, u);
      n++;
    });
  }
  if (snap.size) console.log('[connectCpu] abandoned settled', n);
  return n;
}
exports.settleAbandonedCpuMatches = settleAbandonedCpuMatches;

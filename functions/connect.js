// functions/connect.js
// 10_connect(コネバト)のランク戦レート計算。以前はP1のブラウザが対戦相手のレートまで
// 書き込んでいたため、開発者ツールでレートを好きに書き換えられた。レート・戦績・キャラ統計の
// 書き込みはこの関数(管理者権限)だけが行い、クライアントからはルールで一切書けなくした。
//
// 流れ: クライアントが connectRooms/{roomId} に bo3Final:true / rated:false と勝者を書く
//   → この関数が起動 → 結果の整合性チェック → レート更新 + 試合記録(connectMatches) を1トランザクションで
//   → 部屋に rated:true と ratingResult を書く(両クライアントはこれを見て結果表示・自分の実績を記録する)
//
// Elo計算の数値(K値・切断ペナルティ・下限)は旧クライアント実装(10_connect/public/scripts/eloRating.js)と同じ。

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

const INITIAL_RATING = 1500;
const RATING_FLOOR = 100;
const LEAVE_PENALTY_MULTIPLIER = 1.5;
// 同じ2人のランク戦でレートが動くのは24時間でこの回数まで(別アカウント同士の勝ち譲り対策)。
// 超えた分も試合記録には残る(rated:false, reason:'pair_cap')。
const PAIR_DAILY_CAP = 3;
// 切断/時間切れ勝ちを認める条件の1つ: 負けた側の生存通知(LastActive)がこれより古い
const LOSER_STALE_MS = 8 * 1000;

// 10_connect/public/scripts/rankConfig.js と同じ閾値(集計でランク帯別に見るため記録する)
const RANK_TIERS = [
  [2500, 'Bakata Legend'], [2200, 'Legend'], [2000, 'Diamond'], [1800, 'Platinum'],
  [1600, 'Gold'], [1400, 'Silver'], [0, 'Bronze'],
];
function tierOf(rating) {
  for (const [min, name] of RANK_TIERS) if (rating >= min) return name;
  return 'Bronze';
}

function kOf(matchCount) {
  if (matchCount < 10) return 48;
  if (matchCount < 50) return 32;
  return 16;
}

function toMillis(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return null;
}

// クライアントが書いた決着内容が、部屋の状態と矛盾していないかを確認する。
// 戻り値: null(問題なし) または 理由の文字列
function validateResult(room, winnerUid, loserUid, nowMs) {
  const p1 = room.player1_ID;
  const p2 = room.player2_ID;
  if (!p1 || !p2 || p1 === p2) return 'bad_players';
  if (winnerUid !== p1 && winnerUid !== p2) return 'bad_winner';
  const colorOf = (uid) => (uid === p1 ? room.player1_Color : room.player2_Color);
  const winnerColor = colorOf(winnerUid);
  const redWin = room.red_Win || 0;
  const yellowWin = room.yellow_Win || 0;
  const loserIsP1 = loserUid === p1;
  const loserTimeouts = (loserIsP1 ? room.player1_TimeoutCount : room.player2_TimeoutCount) || 0;
  const loserLastActive = toMillis(loserIsP1 ? room.player1_LastActive : room.player2_LastActive);
  const loserStale = loserLastActive === null || nowMs - loserLastActive >= LOSER_STALE_MS;

  switch (room.resultType) {
    case 'normal':
      // 3本先取の勝者と申告された勝者が一致していること(3-3の引き分けはレート対象外)
      if (redWin === 3 && yellowWin === 3) return 'draw';
      return (winnerColor === 'red' ? redWin : yellowWin) === 3 ? null : 'score_mismatch';
    case 'timeout':
      return loserTimeouts >= 2 || loserStale ? null : 'loser_active';
    case 'leave':
      return room.status === 'leave' || loserStale ? null : 'loser_active';
    default:
      return 'bad_result_type';
  }
}

exports.connectRateMatch = onDocumentUpdated('connectRooms/{roomId}', async (event) => {
  const room = event.data.after.exists ? event.data.after.data() : null;
  if (!room || room.bo3Final !== true || room.rated !== false || room.matchType !== 'ranked') return;

  const db = admin.firestore();
  const roomId = event.params.roomId;
  const roomRef = db.collection('connectRooms').doc(roomId);
  const matchRef = db.collection('connectMatches').doc(roomId); // 部屋IDをキーにして二重計算を防ぐ
  const p1 = room.player1_ID;
  const p2 = room.player2_ID;
  const winnerUid = room.winnerUid;
  const loserUid = winnerUid === p1 ? p2 : p1;
  const nowMs = Date.now();
  const pairKey = [p1, p2].sort().join('__');

  let reason = validateResult(room, winnerUid, loserUid, nowMs);

  if (!reason) {
    const recent = await db.collection('connectMatches').where('pairKey', '==', pairKey).get();
    const ratedToday = recent.docs.filter((d) => {
      const m = d.data();
      return m.rated === true && (toMillis(m.createdAt) || 0) >= nowMs - 24 * 60 * 60 * 1000;
    }).length;
    if (ratedToday >= PAIR_DAILY_CAP) reason = 'pair_cap';
  }

  await db.runTransaction(async (tx) => {
    const matchSnap = await tx.get(matchRef);
    if (matchSnap.exists) return; // 既に処理済み

    const roomSnap = await tx.get(roomRef);
    const p1Ref = db.collection('connectUsers').doc(p1);
    const p2Ref = db.collection('connectUsers').doc(p2);
    const [p1Snap, p2Snap] = await Promise.all([tx.get(p1Ref), tx.get(p2Ref)]);
    const fresh = { rating: INITIAL_RATING, matchCount: 0, winCount: 0, charaWins: {} };
    const u1 = p1Snap.exists ? { ...fresh, ...p1Snap.data() } : fresh;
    const u2 = p2Snap.exists ? { ...fresh, ...p2Snap.data() } : fresh;

    // キャラIDはルールで試合中に変更できない player1_CharaID/player2_CharaID を使う
    const p1CharaId = room.player1_CharaID;
    const p2CharaId = room.player2_CharaID;
    const statRefs = [...new Set([p1CharaId, p2CharaId].filter(Boolean))]
      .map((id) => db.collection('connectCharaStats').doc(id));
    const statSnaps = await Promise.all(statRefs.map((r) => tx.get(r)));

    const rated = !reason;
    let p1After = u1.rating;
    let p2After = u2.rating;

    if (rated) {
      const winner = winnerUid === p1 ? u1 : u2;
      const loser = winnerUid === p1 ? u2 : u1;
      const eWinner = 1 / (1 + Math.pow(10, (loser.rating - winner.rating) / 400));
      let winnerNew = Math.round(winner.rating + kOf(winner.matchCount) * (1 - eWinner));
      let loserNew = Math.round(loser.rating + kOf(loser.matchCount) * (0 - (1 - eWinner)));
      if (room.resultType === 'leave' || room.resultType === 'timeout') {
        loserNew = loser.rating - Math.round((loser.rating - loserNew) * LEAVE_PENALTY_MULTIPLIER);
      }
      winnerNew = Math.max(RATING_FLOOR, winnerNew);
      loserNew = Math.max(RATING_FLOOR, loserNew);
      p1After = winnerUid === p1 ? winnerNew : loserNew;
      p2After = winnerUid === p1 ? loserNew : winnerNew;

      const winnerCharaId = winnerUid === p1 ? p1CharaId : p2CharaId;
      const serverNow = admin.firestore.FieldValue.serverTimestamp();
      const userUpdate = (u, uid, after) => ({
        rating: after,
        matchCount: (u.matchCount || 0) + 1,
        winCount: (u.winCount || 0) + (uid === winnerUid ? 1 : 0),
        charaWins: uid === winnerUid
          ? { ...(u.charaWins || {}), [winnerCharaId]: ((u.charaWins || {})[winnerCharaId] || 0) + 1 }
          : (u.charaWins || {}),
        lastMatchAt: serverNow,
      });
      tx.set(p1Ref, userUpdate(u1, p1, p1After), { merge: true });
      tx.set(p2Ref, userUpdate(u2, p2, p2After), { merge: true });

      statRefs.forEach((ref, i) => {
        const cur = statSnaps[i].exists ? statSnaps[i].data() : { pickCount: 0, winCount: 0 };
        const picks = (p1CharaId === ref.id ? 1 : 0) + (p2CharaId === ref.id ? 1 : 0);
        tx.set(ref, {
          pickCount: (cur.pickCount || 0) + picks,
          winCount: (cur.winCount || 0) + (winnerCharaId === ref.id ? 1 : 0),
        });
      });
    }

    // 試合記録(バランス調整用の集計元)。レート対象外の試合も理由付きで残す。
    tx.set(matchRef, {
      pairKey,
      rated,
      reason: reason || null,
      resultType: room.resultType || null,
      winnerUid: winnerUid || null,
      winnerSide: winnerUid === p1 ? 'P1' : 'P2',
      p1Uid: p1, p2Uid: p2,
      p1CharaId: p1CharaId || null, p2CharaId: p2CharaId || null,
      p1Color: room.player1_Color || null, p2Color: room.player2_Color || null,
      p1RatingBefore: u1.rating, p2RatingBefore: u2.rating,
      p1RatingAfter: p1After, p2RatingAfter: p2After,
      p1Tier: tierOf(u1.rating), p2Tier: tierOf(u2.rating),
      p1MatchCountBefore: u1.matchCount || 0, p2MatchCountBefore: u2.matchCount || 0,
      redWin: room.red_Win || 0, yellowWin: room.yellow_Win || 0,
      p1UltCount: room.player1_UltCount || 0, p2UltCount: room.player2_UltCount || 0,
      roomCreatedAt: room.createdAt || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 部屋がまだあれば結果を返す(先に削除されていても記録・レート更新は完了させる)
    if (roomSnap.exists) {
      tx.update(roomRef, {
        rated: true,
        ratingResult: { rated, reason: reason || null, p1NewRating: p1After, p2NewRating: p2After },
      });
    }
  });
});

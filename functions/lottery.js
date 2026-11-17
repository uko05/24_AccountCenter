// functions/lottery.js
// UP宝くじ(2026-11-17)。購入は 08_UPoint、結果は 14_GenshinOmikuji のフィードの「宝くじ」タブで見る。
//
// しくみ(抽選箱方式):
//  - 1口10UP。そのうち8UPが賞金に積み上がる(2UPは消える)。1人1回の抽選で200口まで。
//  - 賞金の合計 = 最低保証3,000UP(+前回に当たりが余った分) + 売れた口数×8UP
//  - 当たり: 1等1人(合計の60% + 願いの結晶2個) / 2等2人(15%ずつ + 結晶1個) / 3等5人(2%ずつ)
//    売れた口数に比例した確率で、1人1つまで(上の等から順に引く)。
//  - 抽選は毎月1日と16日。販売は21時まで、22時に抽選して結果を書き、当選者へメールを送る(受け取りボタンで加算)。
//  - 参加者が8人以下なら抽選せず、口数も賞金もそのまま次の回へ持ち越す(status 'carried'。2026-11-17)。
//
// データ:
//  ukoLottery/{drawId}          drawId = 'YYYY-MM-DD'(抽選日、日本時間)。closeAt / resultAt / seed / totalTickets /
//                               participants / pool / status('open'|'drawn') / winners / updatedAt
//  ukoLotteryEntries/{drawId}_{userId}   { drawId, userId, name, count, updatedAt }(1人1回分で1件。何回買っても同じ1件)
//  ukoLotteryConfig/main        { excludedUserIds: [] }(抽選から外すアカウント。サブ垢など。管理者が書く)
//
// 読み書きを増やさない工夫: 口数・賞金の表示は1時間に1回ここで集計して ukoLottery/{drawId} に書くだけ。
// 画面は宝くじの欄を開いた時にそのドキュメントを1件読む。

const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const crypto = require('crypto');

const FV = admin.firestore.FieldValue;
const TZ = 'Asia/Tokyo';
const SEED = 3000;
const PER_TICKET_POOL = 8;
const TIERS = [   // 上から順に引く
  { tier: 1, count: 1, share: 0.60, crystals: 2 },
  { tier: 2, count: 2, share: 0.15, crystals: 1 },
  { tier: 3, count: 5, share: 0.02, crystals: 0 },
];
const MAIL_DAYS = 30;
const MIN_PEOPLE = 9;   // 抽選する最低人数。8人以下(当たりの数以下)なら次の回へ持ち越す

// ── 日付(日本時間)
function jstParts(ms) {
  const d = new Date(ms + 9 * 3600e3);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours() };
}
const pad = (n) => String(n).padStart(2, '0');
const drawIdOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
// 日本時間の y/m/d h:00 のミリ秒
const jstMs = (y, m, d, h) => Date.UTC(y, m - 1, d, h - 9, 0, 0);

// ── 試しの期間(2026-11-17)。ukoLotteryConfig/main に testUntil(Timestamp) と testIntervalMin(分) があれば、
// その時刻まで「testIntervalMin 分ごと」に回を作る(回の名前は T + 発表時刻、締め切りは発表の5分前)。
// testBotIds(試し用アカウント)には、回を作るたびに自動でランダムな口数を買わせる(9人以上そろえるため)。
// 試しの回の持ち越し・余りは、本番の回には持ち込まない。
let CFG = {};
async function loadCfg(db) {
  const snap = await db.collection('ukoLotteryConfig').doc('main').get();
  CFG = snap.exists ? snap.data() : {};
  return CFG;
}
const testActive = (ms) => !!(CFG.testUntil && CFG.testUntil.toMillis() > ms && CFG.testIntervalMin > 0);
const isTestId = (id) => String(id).startsWith('T');

// 今受け付けている回(結果発表の時刻がまだ来ていない一番近い回)
function currentDraw(nowMs) {
  if (testActive(nowMs)) {
    const iv = CFG.testIntervalMin * 60e3;
    const res = Math.floor(nowMs / iv) * iv + iv;
    const j = new Date(res + 9 * 3600e3);
    const id = `T${j.getUTCFullYear()}${pad(j.getUTCMonth() + 1)}${pad(j.getUTCDate())}-${pad(j.getUTCHours())}${pad(j.getUTCMinutes())}`;
    return { drawId: id, closeMs: res - 5 * 60e3, resultMs: res };
  }
  let { y, m } = jstParts(nowMs);
  for (let k = 0; k < 3; k++) {
    for (const day of [1, 16]) {
      const res = jstMs(y, m, day, 22);
      if (res > nowMs) return { drawId: drawIdOf(y, m, day), closeMs: jstMs(y, m, day, 21), resultMs: res };
    }
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  throw new Error('no draw date');
}

async function ensureDraw(db, nowMs, carry = 0) {
  const cd = currentDraw(nowMs);
  const ref = db.collection('ukoLottery').doc(cd.drawId);
  const snap = await ref.get();
  if (snap.exists) {
    if (carry > 0) await ref.update({ seed: FV.increment(carry), pool: FV.increment(carry), updatedAt: FV.serverTimestamp() });
  } else {
    await ref.set({
      drawId: cd.drawId,
      closeAt: admin.firestore.Timestamp.fromMillis(cd.closeMs),
      resultAt: admin.firestore.Timestamp.fromMillis(cd.resultMs),
      seed: SEED + carry, totalTickets: 0, participants: 0, pool: SEED + carry,
      status: 'open', winners: [], createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
      ...(isTestId(cd.drawId) ? { test: true } : {}),
    });
    if (isTestId(cd.drawId)) await botsBuy(db, cd.drawId);
  }
  return { ref, ...cd };
}

// 試し用アカウントに、ランダムな口数(1〜60口)を買わせる。UPも減らして記録も残す(本物の購入と同じ形)
async function botsBuy(db, drawId) {
  const bots = CFG.testBotIds || [];
  if (!bots.length) return;
  const batch = db.batch();
  for (const uid of bots) {
    const n = crypto.randomInt(1, 61);
    batch.set(db.collection('omikujiUsers').doc(uid), { ukoPoints: FV.increment(-10 * n) }, { merge: true });
    batch.set(db.collection('ukoLotteryEntries').doc(`${drawId}_${uid}`), {
      drawId, userId: uid, name: `試し${uid.slice(-2)}`, count: FV.increment(n), updatedAt: FV.serverTimestamp(),
    }, { merge: true });
    batch.set(db.collection('ukoPointsLog').doc(), {
      userId: uid, amount: -10 * n, type: 'lotteryBuy', meta: { drawId, qty: n, test: true }, createdAt: FV.serverTimestamp(),
    });
  }
  await batch.commit();
}

// 口数と賞金の集計(集計クエリなので、読み取りは参加者の数ではなく 1000件ごとに1回分)
async function aggregate(db, drawId) {
  const q = db.collection('ukoLotteryEntries').where('drawId', '==', drawId);
  const agg = await q.aggregate({ total: admin.firestore.AggregateField.sum('count'), n: admin.firestore.AggregateField.count() }).get();
  return { total: agg.data().total || 0, n: agg.data().n || 0 };
}

// 重み付きで1人ずつ引く(1人1つまで)。乱数は crypto
function pickWeighted(pool) {
  const sum = pool.reduce((a, e) => a + e.count, 0);
  if (sum <= 0) return -1;
  let r = crypto.randomInt(0, sum);
  for (let i = 0; i < pool.length; i++) {
    r -= pool[i].count;
    if (r < 0) return i;
  }
  return pool.length - 1;
}

// 持ち越し: この回を 'carried' にし、次の回へ賞金(この回の賞金の合計がそのまま次の回の最低保証になる)と
// 各自の口数を引き継ぐ。参加した人には「持ち越しになった」メールを1通(報酬なし)
async function carryOver(db, ref, drawId, entries, totalTickets, pool, afterMs) {
  const nowMs = Date.now();
  if (isTestId(drawId) && !isTestId(currentDraw(afterMs).drawId)) {
    // 試しの期間の最後の回: 本番の回には持ち込まず、終わりにする
    await ref.update({ status: 'carried', carriedTo: '', totalTickets, participants: entries.length, pool, winners: [], drawnAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
    return { drawId, carried: true, to: null };
  }
  const next = await ensureDraw(db, afterMs, 0);   // この回の発表より後の回
  const nextSnap = await next.ref.get();
  const nextSeed = nextSnap.data().seed || SEED;
  const batch = db.batch();
  batch.update(ref, {
    status: 'carried', carriedTo: next.drawId, totalTickets, participants: entries.length, pool, winners: [],
    drawnAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
  });
  // 次の回の最低保証 = この回の賞金の合計(次の回にもともと上乗せされていた分があれば、それも足す)
  const seed = pool + (nextSeed - SEED);
  batch.update(next.ref, { seed, pool: FV.increment(seed - nextSeed), carriedFrom: drawId, updatedAt: FV.serverTimestamp() });
  for (const e of entries) {
    batch.set(db.collection('ukoLotteryEntries').doc(`${next.drawId}_${e.userId}`), {
      drawId: next.drawId, userId: e.userId, name: e.name || '', count: FV.increment(e.count), updatedAt: FV.serverTimestamp(),
    }, { merge: true });
  }
  if (entries.length) {
    batch.set(db.collection('omikujiMailBroadcasts').doc(), {
      title: 'UP宝くじ 持ち越しのお知らせ',
      message: `${drawId.replace(/-/g, '/')} のUP宝くじは参加者が${MIN_PEOPLE}人に届かなかったため、抽選を次の回（${next.drawId.replace(/-/g, '/')}）へ持ち越しました。\n買った口数と賞金はそのまま次の回に引き継がれます。`,
      rewards: [], target: { type: 'users', userIds: entries.map((e) => e.userId) },
      expiresAt: admin.firestore.Timestamp.fromMillis(nowMs + MAIL_DAYS * 86400e3), createdAt: FV.serverTimestamp(),
      kind: 'lottery', drawId,
    });
  }
  await batch.commit();
  return { drawId, carried: true, to: next.drawId, totalTickets, participants: entries.length, pool };
}

async function runDraw(db, drawId) {
  const ref = db.collection('ukoLottery').doc(drawId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const draw = snap.data();
  if (draw.status === 'drawn' || draw.status === 'carried') return null;

  const [entriesSnap, cfgSnap] = await Promise.all([
    db.collection('ukoLotteryEntries').where('drawId', '==', drawId).get(),
    db.collection('ukoLotteryConfig').doc('main').get(),
  ]);
  const excluded = new Set((cfgSnap.exists && cfgSnap.data().excludedUserIds) || []);
  const entries = entriesSnap.docs.map((d) => d.data()).filter((e) => e.count > 0);
  const totalTickets = entries.reduce((a, e) => a + e.count, 0);
  const pool = (draw.seed || SEED) + PER_TICKET_POOL * totalTickets;
  let box = entries.filter((e) => !excluded.has(e.userId)).map((e) => ({ ...e }));

  // 参加者が8人以下なら抽選しない(全員が何かに当たってしまうため)。口数も賞金もそのまま次の回へ持ち越す(2026-11-17)
  // 次の回は「この回の発表時刻より後」で決める(遅れて動いた時も、早く動いた時も同じ回を指すように)
  const afterMs = Math.max(Date.now(), draw.resultAt ? draw.resultAt.toMillis() : 0) + 60e3;
  if (box.length < MIN_PEOPLE) return carryOver(db, ref, drawId, entries, totalTickets, pool, afterMs);

  const winners = [];
  let leftover = 0;
  for (const t of TIERS) {
    const amount = Math.floor(pool * t.share);
    for (let k = 0; k < t.count; k++) {
      const i = pickWeighted(box);
      if (i < 0) { leftover += amount; continue; }   // 当たりが余った分は次の回の最低保証へ
      const e = box.splice(i, 1)[0];
      winners.push({ tier: t.tier, userId: e.userId, name: e.name || '', tickets: e.count, amount, crystals: t.crystals });
    }
  }

  const nowMs = Date.now();
  const batch = db.batch();
  batch.update(ref, {
    status: 'drawn', totalTickets, participants: entries.length, pool, winners, leftover,
    drawnAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
  });
  // 当選者へメール(受け取りボタンでUP・結晶が入る)。等ごとに中身が違うので1人1通
  const expiresAt = admin.firestore.Timestamp.fromMillis(nowMs + MAIL_DAYS * 86400e3);
  for (const w of winners) {
    const rewards = [{ field: 'ukoPoints', amount: w.amount }];
    if (w.crystals) rewards.push({ field: 'sitePerks.omikuji.wishCrystals', amount: w.crystals });
    batch.set(db.collection('omikujiMailBroadcasts').doc(), {
      title: `UP宝くじ ${w.tier}等 当選`,
      message: `${drawId.replace(/-/g, '/')} のUP宝くじで${w.tier}等に当選しました。\n賞金 ${w.amount.toLocaleString('ja-JP')}UP${w.crystals ? `・願いの結晶 ${w.crystals}個` : ''}\n（購入 ${w.tickets}口・全体 ${totalTickets}口）`,
      rewards, target: { type: 'users', userIds: [w.userId] }, expiresAt, createdAt: FV.serverTimestamp(),
      kind: 'lottery', drawId,
    });
    batch.set(db.collection('ukoPointsLog').doc(), {
      userId: w.userId, amount: w.amount, type: 'lotteryWin',
      meta: { drawId, tier: w.tier, tickets: w.tickets, crystals: w.crystals, viaMail: true },
      createdAt: FV.serverTimestamp(),
    });
  }
  // フィードの「結果」タブに、結果のまとめを1件投稿(2026-11-17)。公開前(ukoLotteryConfig/main の public が true でない間)は管理者だけに見える
  const w1 = winners.find((w) => w.tier === 1);
  batch.set(db.collection('omikujiFeed').doc(), {
    type: 'lottery', drawId, userId: 'system_lottery', name: 'UP宝くじ', likeCount: 0,
    first: w1 ? { name: w1.name || '', amount: w1.amount, crystals: w1.crystals } : null,
    seconds: winners.filter((w) => w.tier === 2).map((w) => w.name || ''),
    thirdCount: winners.filter((w) => w.tier === 3).length,
    totalTickets, participants: entries.length, adminOnly: CFG.public !== true,
    createdAt: FV.serverTimestamp(),
  });
  await batch.commit();
  // 次の回を作る(余った分を最低保証に上乗せ)
  // 余りは次の回の最低保証へ(試しの回の余りは本番の回には持ち込まない)
  const nextIsTest = isTestId(currentDraw(afterMs).drawId);
  await ensureDraw(db, afterMs, isTestId(drawId) && !nextIsTest ? 0 : leftover);
  return { drawId, totalTickets, participants: entries.length, pool, winners: winners.length, leftover };
}

// 毎月1日・16日の22時に抽選
exports.lotteryDraw = onSchedule({ schedule: '0 22 1,16 * *', timeZone: TZ, region: 'asia-northeast1', timeoutSeconds: 300 }, async () => {
  const db = admin.firestore();
  await loadCfg(db);
  const { y, m, d } = jstParts(Date.now());
  const res = await runDraw(db, drawIdOf(y, m, d));
  console.log('[lottery] draw', JSON.stringify(res));
});

// 1時間ごと: 今の回のドキュメントを用意し、口数と賞金を集計して書く。
// 抽選が走り損ねた回(結果発表を過ぎても open のまま)があれば、ここで抽選する
// 2026-11-17: 試しの期間(30分ごとの回)に合わせて5分ごとに動かす。試しの回の抽選も、ここ(発表時刻を過ぎた回)で行う
exports.lotteryTick = onSchedule({ schedule: '*/5 * * * *', timeZone: TZ, region: 'asia-northeast1', timeoutSeconds: 300 }, async () => {
  const db = admin.firestore();
  await loadCfg(db);
  const nowMs = Date.now();
  // 回の数は少ない(月2件)ので、status だけで絞って時刻はここで比べる(複合索引を作らない)
  const open = await db.collection('ukoLottery').where('status', '==', 'open').get();
  for (const s of open.docs) {
    if (s.data().resultAt.toMillis() > nowMs) continue;
    const res = await runDraw(db, s.id);
    console.log('[lottery] late draw', JSON.stringify(res));
  }
  const cur = await ensureDraw(db, nowMs);
  if (nowMs >= cur.closeMs + 5 * 60e3) return;   // 締め切り後は数字を動かさない(抽選で確定させる)
  const { total, n } = await aggregate(db, cur.drawId);
  const snap = await cur.ref.get();
  const seed = snap.data().seed || SEED;
  await cur.ref.update({ totalTickets: total, participants: n, pool: seed + PER_TICKET_POOL * total, updatedAt: FV.serverTimestamp() });
});


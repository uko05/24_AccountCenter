// functions/arcanaTrade.js
// 27_ArcanaTrade(原神アルカナ交換所)の交換処理。承認・交換完了・取り消しはクライアントからではなく
// ここ(管理者権限)で行う。同じカードに申請が重なったときに、出せる枚数を超えて承認されたり、
// 2人が同時に承認ボタンを押しておかしな状態になったりしないよう、トランザクションで確かめるため。
//
// 枚数のルール(27_ArcanaTrade/arcana.js と同じ):
//   交換に出せる枚数 = 所持数(counts) - 1(必ず手元に残す) - 交換予定(reservedOut: 承認済み・未完了で出す予定の枚数)
//
// 申請(arcanaTradeRequests)の項目:
//   ownerId(申請を受けた人) / applicantId(申請した人)
//   getCard: 申請者がもらう(=owner が出す)カード / giveCard: 申請者が出す(=owner がもらう)カード
//   status: pending → approved → completed、または declined / withdrawn / cancelled

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

const ARCANA_IDS = [
  'fool', 'magician', 'high_priestess', 'empress', 'emperor', 'hierophant', 'lovers', 'chariot',
  'strength', 'hermit', 'wheel_of_fortune', 'justice', 'hanged_man', 'death', 'temperance', 'devil',
  'tower', 'star', 'moon', 'sun', 'judgement', 'world',
];
const AUTO_COMPLETE_MS = 3 * 24 * 60 * 60 * 1000;   // 承認から3日で自動的に交換完了
const PENDING_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;  // 7日承認されない申請は取り下げ

const FV = admin.firestore.FieldValue;
const db = () => admin.firestore();
const profileRef = (id) => db().collection('arcanaTradeProfiles').doc(id);
const privateRef = (id) => db().collection('arcanaTradePrivate').doc(id);
const reqCol = () => db().collection('arcanaTradeRequests');

function tradeable(p, id) {
  return Math.max(0, ((p && p.counts && p.counts[id]) || 0) - 1 - ((p && p.reservedOut && p.reservedOut[id]) || 0));
}
function spareOf(p) {
  return ARCANA_IDS.filter((id) => tradeable(p, id) >= 1);
}
function fail(reason, code = 'failed-precondition') {
  throw new HttpsError(code, reason, { reason });
}

// ログイン中のFirebase Authユーザーの共有ID(accountLinks経由)
async function callerUserId(request) {
  if (!request.auth) fail('notLoggedIn', 'unauthenticated');
  const link = await db().collection('accountLinks').doc(request.auth.uid).get();
  const id = link.exists ? link.data().omikujiUserId : null;
  if (!id) fail('notLoggedIn', 'unauthenticated');
  return id;
}

// あるユーザーの片側の交換を確定する(出したカード -1・予定 -1、もらったカード +1)
function applySide(p, giveId, getId) {
  const counts = { ...(p.counts || {}) };
  const reservedOut = { ...(p.reservedOut || {}) };
  counts[giveId] = Math.max(0, (counts[giveId] || 0) - 1);
  if (!counts[giveId]) delete counts[giveId];
  reservedOut[giveId] = Math.max(0, (reservedOut[giveId] || 0) - 1);
  if (!reservedOut[giveId]) delete reservedOut[giveId];
  counts[getId] = (counts[getId] || 0) + 1;
  const next = { ...p, counts, reservedOut };
  return { counts, reservedOut, spare: spareOf(next) };
}
// 交換予定だけ戻す(取り消し時)
function releaseSide(p, giveId) {
  const reservedOut = { ...(p.reservedOut || {}) };
  reservedOut[giveId] = Math.max(0, (reservedOut[giveId] || 0) - 1);
  if (!reservedOut[giveId]) delete reservedOut[giveId];
  return { reservedOut, spare: spareOf({ ...p, reservedOut }) };
}

// 承認後の後片付け: 出せる枚数がなくなったカードの申請と、同じカードをもう手に入れた人の申請を取り下げる
async function withdrawConflicts(userIds, received) {
  const profiles = {};
  await Promise.all(userIds.map(async (id) => { profiles[id] = (await profileRef(id).get()).data() || {}; }));
  const snaps = await Promise.all(userIds.flatMap((id) => [
    reqCol().where('ownerId', '==', id).where('status', '==', 'pending').get(),
    reqCol().where('applicantId', '==', id).where('status', '==', 'pending').get(),
  ]));
  const seen = new Set();
  const updates = [];
  for (const snap of snaps) {
    for (const d of snap.docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const r = d.data();
      let reason = null;
      // owner が出すのは getCard、applicant が出すのは giveCard
      if (profiles[r.ownerId] && userIds.includes(r.ownerId) && tradeable(profiles[r.ownerId], r.getCard) < 1) reason = 'noSpare';
      if (profiles[r.applicantId] && userIds.includes(r.applicantId) && tradeable(profiles[r.applicantId], r.giveCard) < 1) reason = 'noSpare';
      // 今回の交換で手に入れたカードを、ほかの人にも申請していたら取り下げる
      for (const [uid, cardId] of received) {
        if (r.applicantId === uid && r.getCard === cardId) reason = 'gotElsewhere';
      }
      if (reason) updates.push(d.ref.update({ status: 'withdrawn', withdrawReason: reason, respondedAt: FV.serverTimestamp() }));
    }
  }
  await Promise.all(updates);
}

// ===== 承認(申請を受けた人だけ) =====
exports.arcanaApprove = onCall({ region: 'asia-northeast1' }, async (request) => {
  const me = await callerUserId(request);
  const ref = reqCol().doc(String(request.data?.requestId || ''));
  let r;
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail('notPending');
    r = snap.data();
    if (r.ownerId !== me) fail('notParticipant', 'permission-denied');
    if (r.status !== 'pending') fail('notPending');
    const [oSnap, aSnap, oPriv, aPriv] = await Promise.all([
      tx.get(profileRef(r.ownerId)), tx.get(profileRef(r.applicantId)),
      tx.get(privateRef(r.ownerId)), tx.get(privateRef(r.applicantId)),
    ]);
    const owner = oSnap.data() || {};
    const applicant = aSnap.data() || {};
    if (tradeable(owner, r.getCard) < 1) fail('noSpareOwner');
    if (tradeable(applicant, r.giveCard) < 1) fail('noSpareApplicant');

    const oRes = { ...(owner.reservedOut || {}) };
    oRes[r.getCard] = (oRes[r.getCard] || 0) + 1;
    const aRes = { ...(applicant.reservedOut || {}) };
    aRes[r.giveCard] = (aRes[r.giveCard] || 0) + 1;
    tx.update(profileRef(r.ownerId), { reservedOut: oRes, spare: spareOf({ ...owner, reservedOut: oRes }) });
    tx.update(profileRef(r.applicantId), { reservedOut: aRes, spare: spareOf({ ...applicant, reservedOut: aRes }) });
    tx.update(ref, {
      status: 'approved',
      approvedAt: FV.serverTimestamp(),
      respondedAt: FV.serverTimestamp(),
      revealed: {
        ownerUid: (oPriv.data() || {}).genshinUid || '',
        applicantUid: (aPriv.data() || {}).genshinUid || '',
      },
      ownerDone: false,
      applicantDone: false,
      ownerSeen: true,
      applicantSeen: false,
    });
  });
  // owner は giveCard を、applicant は getCard を手に入れる
  await withdrawConflicts([r.ownerId, r.applicantId], [[r.ownerId, r.giveCard], [r.applicantId, r.getCard]]);
  return { ok: true };
});

// 片側の交換完了(本人のボタン、または3日後の自動完了)
async function completeSide(ref, side) {
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const r = snap.data();
    if (r.status !== 'approved') return;
    const doneKey = side === 'owner' ? 'ownerDone' : 'applicantDone';
    if (r[doneKey]) return;
    const uid = side === 'owner' ? r.ownerId : r.applicantId;
    const give = side === 'owner' ? r.getCard : r.giveCard;
    const get = side === 'owner' ? r.giveCard : r.getCard;
    const pSnap = await tx.get(profileRef(uid));
    if (pSnap.exists) tx.update(profileRef(uid), { ...applySide(pSnap.data(), give, get), lastActiveAt: FV.serverTimestamp() });
    const otherDone = side === 'owner' ? r.applicantDone : r.ownerDone;
    const upd = { [doneKey]: true };
    if (otherDone) { upd.status = 'completed'; upd.completedAt = FV.serverTimestamp(); }
    tx.update(ref, upd);
  });
}

// ===== 交換完了(当事者どちらでも、自分の側だけ) =====
exports.arcanaComplete = onCall({ region: 'asia-northeast1' }, async (request) => {
  const me = await callerUserId(request);
  const ref = reqCol().doc(String(request.data?.requestId || ''));
  const snap = await ref.get();
  if (!snap.exists) fail('notPending');
  const r = snap.data();
  const side = r.ownerId === me ? 'owner' : r.applicantId === me ? 'applicant' : null;
  if (!side) fail('notParticipant', 'permission-denied');
  if (r.status !== 'approved') fail('notPending');
  if (r[side === 'owner' ? 'ownerDone' : 'applicantDone']) fail('alreadyDone');
  await completeSide(ref, side);
  return { ok: true };
});

// ===== 交換の取り消し(どちらもまだ交換完了を押していない時だけ) =====
exports.arcanaCancel = onCall({ region: 'asia-northeast1' }, async (request) => {
  const me = await callerUserId(request);
  const ref = reqCol().doc(String(request.data?.requestId || ''));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail('notPending');
    const r = snap.data();
    if (r.ownerId !== me && r.applicantId !== me) fail('notParticipant', 'permission-denied');
    if (r.status !== 'approved') fail('notPending');
    if (r.ownerDone || r.applicantDone) fail('cannotCancel');
    const [oSnap, aSnap] = await Promise.all([tx.get(profileRef(r.ownerId)), tx.get(profileRef(r.applicantId))]);
    if (oSnap.exists) tx.update(profileRef(r.ownerId), releaseSide(oSnap.data(), r.getCard));
    if (aSnap.exists) tx.update(profileRef(r.applicantId), releaseSide(aSnap.data(), r.giveCard));
    tx.update(ref, { status: 'cancelled', cancelledBy: me, respondedAt: FV.serverTimestamp() });
  });
  return { ok: true };
});

// ===== 定期処理: 承認から3日で自動的に交換完了 / 7日承認されない申請は取り下げ =====
exports.arcanaTradeSweep = onSchedule({ schedule: 'every 60 minutes', region: 'asia-northeast1' }, async () => {
  const now = Date.now();
  const due = await reqCol().where('status', '==', 'approved')
    .where('approvedAt', '<=', admin.firestore.Timestamp.fromMillis(now - AUTO_COMPLETE_MS)).get();
  for (const d of due.docs) {
    const r = d.data();
    if (!r.ownerDone) await completeSide(d.ref, 'owner');
    if (!r.applicantDone) await completeSide(d.ref, 'applicant');
    await d.ref.update({ autoCompleted: true }).catch(() => {});
  }
  const stale = await reqCol().where('status', '==', 'pending')
    .where('createdAt', '<=', admin.firestore.Timestamp.fromMillis(now - PENDING_EXPIRE_MS)).get();
  await Promise.all(stale.docs.map((d) => d.ref.update({
    status: 'withdrawn', withdrawReason: 'expired', respondedAt: FV.serverTimestamp(),
  })));
  console.log('[arcanaTradeSweep] auto-completed', due.size, 'expired', stale.size);
});

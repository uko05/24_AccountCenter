// functions/index.js
// 17_storage(画像保管庫)のアップロード画像に対するSafeSearchモデレーション。
// このサイト群で初めて使うCloud Functions。

const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const vision = require('@google-cloud/vision');

admin.initializeApp();
// Storageバケットがasia-northeast1にあるため、関数も同じリージョンにする
// (Storageトリガーはバケットと同リージョンの関数からしか張れない)。
setGlobalOptions({ region: 'asia-northeast1' });

const visionClient = new vision.ImageAnnotatorClient();

const IMAGES_COLLECTION = 'screenshotStorageImages';
const STORAGE_ROOT = 'screenshotStorage';
const FLAG_SWEEP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// 画像保管庫のパスのうち、判定対象になるのは表示用ファイル(view.webp/original.*)
// だけ。thumb.webpは同じ画像から生成された縮小版で判定結果は変わらないため、
// 二重にVision APIを呼ばないようスキップする。
const MAIN_FILE_PATH_RE = /^screenshotStorage\/([^/]+)\/([^/]+)\/(view\.webp|original\.[a-z0-9]+)$/;

const LIKELIHOODS = ['UNKNOWN', 'VERY_UNLIKELY', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'VERY_LIKELY'];
function likelihoodRank(value) {
  const i = LIKELIHOODS.indexOf(value || 'UNKNOWN');
  return i < 0 ? 0 : i;
}

async function deleteImageFiles(bucketName, uid, imageId) {
  await admin.storage().bucket(bucketName).deleteFiles({
    prefix: `${STORAGE_ROOT}/${uid}/${imageId}/`,
  });
}

exports.moderateStorageUpload = onObjectFinalized(async (event) => {
  const filePath = event.data.name;
  const bucketName = event.data.bucket;
  const match = filePath.match(MAIN_FILE_PATH_RE);
  if (!match) return; // thumb.webpや対象外のパスは無視

  const [, uid, imageId] = match;
  const gcsUri = `gs://${bucketName}/${filePath}`;
  const db = admin.firestore();
  const docRef = db.collection(IMAGES_COLLECTION).doc(imageId);

  let safeSearch;
  try {
    const [result] = await visionClient.safeSearchDetection(gcsUri);
    safeSearch = result.safeSearchAnnotation || {};
  } catch (e) {
    console.error('[moderateStorageUpload] SafeSearch detection failed', imageId, e);
    // 判定に失敗した場合は安全側に倒し、'flagged'にして手動確認に回す
    // (無条件で'approved'にはしない)。
    await docRef.set({
      moderationStatus: 'flagged',
      shareEnabled: false,
      flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
      flaggedReason: 'safesearch_error',
    }, { merge: true });
    return;
  }

  const adultRank    = likelihoodRank(safeSearch.adult);
  const violenceRank = likelihoodRank(safeSearch.violence);
  const racyRank     = likelihoodRank(safeSearch.racy);
  const VERY_LIKELY = likelihoodRank('VERY_LIKELY');
  const POSSIBLE    = likelihoodRank('POSSIBLE');

  // 診断用に判定結果を毎回ログへ残す(2026-09-09追加)。以前はスコアを一切
  // 記録しておらず、なぜ保留になったのか後から追えなかったため。
  console.log('[moderateStorageUpload] safeSearch result', imageId, {
    adult: safeSearch.adult, violence: safeSearch.violence, racy: safeSearch.racy,
  });

  // VERY_LIKELYはどのカテゴリでも即削除(ここは緩めない)。racyも含める
  // (万一の完全に露骨なケースの保険として)。
  const isRemoved = adultRank >= VERY_LIKELY || violenceRank >= VERY_LIKELY || racyRank >= VERY_LIKELY;

  // 保留(flagged)の判定材料からracy(際どさ)は完全に外した(2026-09-09)。
  // ソシャゲ系キャラは肩出し・デコルテの衣装がデザインとして標準的で、
  // racyはLIKELY緩和後もそうした健全なイラストを大量に誤検知することが
  // 確認されたため。adult/violenceはより深刻なので引き続きPOSSIBLEの時点で
  // 人の目を通す。racyは上のVERY_LIKELY即削除にのみ関与する。
  const isFlagged = !isRemoved && (adultRank >= POSSIBLE || violenceRank >= POSSIBLE);

  // 判定スコアはFirestore側にも残しておく(Cloud Functionsのログは日数が
  // 経つと見えなくなるため、後から管理画面で「なぜ保留/削除になったか」を
  // 確認できるように)。
  const safeSearchScores = {
    adult: safeSearch.adult || 'UNKNOWN',
    violence: safeSearch.violence || 'UNKNOWN',
    racy: safeSearch.racy || 'UNKNOWN',
  };

  if (isRemoved) {
    // ファイルの実削除はcleanupRemovedImage(Firestoreのmoderationstatus更新
    // トリガー)に一本化している。ここではステータスを変えるだけでよい。
    await docRef.set({
      moderationStatus: 'removed',
      shareEnabled: false,
      moderatedAt: admin.firestore.FieldValue.serverTimestamp(),
      safeSearchScores,
    }, { merge: true });
  } else if (isFlagged) {
    await docRef.set({
      moderationStatus: 'flagged',
      shareEnabled: false,
      flaggedAt: admin.firestore.FieldValue.serverTimestamp(),
      safeSearchScores,
    }, { merge: true });
  } else {
    await docRef.set({
      moderationStatus: 'approved',
      safeSearchScores,
      moderatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
});

// 'flagged'のまま7日間確認されなかった画像を自動削除するフェイルセーフ。
// 管理者が見忘れて放置され続けるのを防ぐ(CLAUDE.md参照)。
exports.sweepFlaggedImages = onSchedule('every 24 hours', async () => {
  const db = admin.firestore();
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - FLAG_SWEEP_AFTER_MS);
  const snap = await db.collection(IMAGES_COLLECTION)
    .where('moderationStatus', '==', 'flagged')
    .where('flaggedAt', '<=', cutoff)
    .get();

  for (const docSnap of snap.docs) {
    await docSnap.ref.set({
      moderationStatus: 'removed',
      shareEnabled: false,
      moderatedAt: admin.firestore.FieldValue.serverTimestamp(),
      autoRemovedReason: 'flagged_7day_sweep',
    }, { merge: true });
  }
});

// moderationStatusが'removed'になった瞬間(SafeSearchの自動判定、7日一括削除、
// 管理者の手動却下、いずれの経路でも)、実際のStorageファイルを削除する。
// 削除処理をここに一本化することで、'removed'にする側は理由を問わず
// Firestoreの更新だけすればよくなる。
exports.cleanupRemovedImage = onDocumentUpdated(`${IMAGES_COLLECTION}/{imageId}`, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (after.moderationStatus !== 'removed' || before.moderationStatus === 'removed') return;
  if (!after.ownerUid) return;
  await deleteImageFiles(admin.storage().bucket().name, after.ownerUid, event.params.imageId);
});

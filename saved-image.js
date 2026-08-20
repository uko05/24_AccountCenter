/**
 * うーこの部屋 共通「保存画像クラウド保存」モジュール
 *
 * 使い方（各サイトのscript.jsから）:
 *   import { onAccountAuthState, saveProfileImage, getSavedProfileImage, formatSavedAt }
 *     from "https://uko05.github.io/24_AccountCenter/saved-image.js";
 *   let loggedIn = false;
 *   onAccountAuthState((user) => { loggedIn = !!user; });
 *   // 画像のBlobが手に入ったところで:
 *   if (loggedIn) saveProfileImage('genshinRanking', blob); // await不要、失敗は無視してよい
 *   // 「前回保存した画像を確認」用:
 *   const entry = await getSavedProfileImage('genshinRanking'); // { url, updatedAt } | null
 *   if (entry) formatSavedAt(entry.updatedAt); // "2026/08/19 12:34" 形式の文字列
 *
 * ログイン検知の仕組み(重要): Firebase Authの永続化キーは apiKey に加えて
 * Appのインスタンス名(既定Appなら'[DEFAULT]')ごとに分かれる。24_AccountCenterでの
 * ログインは各サイトの「既定(無名)App」で行われる想定なので、呼び出し元サイトの既定Appが
 * 既に genshin-bakatare01 を指している場合(01_TiersList/06_GenshinCheck等)は、
 * その既定Appをそのまま使い回すことでログインセッションを正しく共有できる。
 * 一方、呼び出し元サイトの既定Appが別プロジェクト(例: 02/03_TiersList・07_StarRailCheckの
 * starrail-bakatare02)の場合は、名前付きApp('ukoSavedImage')でgenshin-bakatare01へ
 * 接続するしかなく、この場合は既定Appのログインセッションを自動では共有できない
 * (＝これらのサイトでは今のところ本機能がログイン状態を検知できない制約が残る)。
 *
 * ログイン判定・共有匿名IDは他サイトと同じ仕組みを踏襲する:
 *   - ログイン = 24_AccountCenterでID/パスワード登録済み(Firebase Authのemailログイン)
 *   - 共有匿名ID = localStorage['genshinOmikuji_userId'](14_GenshinOmikuji/25_FriendBoard等と同じキー)
 *
 * 保存先:
 *   Storage:   savedImages/{siteId}/{sharedUserId}/image.jpg
 *   Firestore: savedProfileImages/{sharedUserId} = { [siteId]: { url, updatedAt } }
 * ルールは userAvatars/{sharedUserId} と同型（accountLinks経由で本人のみ書き込み可）。
 * オブジェクト名は上記の通りimage.jpg固定(上書き保存)だが、ブラウザの「名前を付けて
 * 画像を保存」で提案されるファイル名はcontentDispositionでImage_yyyyMMddHHmmss.jpgに
 * している(表示(<img>)には影響しない)。
 */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCP4QfMGDDBSI8VDERnESBOlHpUhy7wGPk",
  authDomain: "genshin-bakatare01.firebaseapp.com",
  projectId: "genshin-bakatare01",
  storageBucket: "genshin-bakatare01.firebasestorage.app",
  messagingSenderId: "658089418604",
  appId: "1:658089418604:web:288c06b331da8c4f789d49",
};

const APP_NAME = 'ukoSavedImage';
const hasDefaultApp = getApps().some((a) => a.name === '[DEFAULT]');
const defaultAppIsGenshinBakatare01 = hasDefaultApp && getApp().options.projectId === 'genshin-bakatare01';

let app;
if (defaultAppIsGenshinBakatare01) {
  // 呼び出し元サイトの既定Appが既にgenshin-bakatare01 → それを使い回してログイン共有
  app = getApp();
} else {
  const hasApp = getApps().some((a) => a.name === APP_NAME);
  app = hasApp ? getApp(APP_NAME) : initializeApp(firebaseConfig, APP_NAME);
}
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const LS_SHARED_UID = 'genshinOmikuji_userId';

// 保存先のオブジェクト名自体はimage.jpgで固定(=保存し直すたびに上書きし、
// Storage容量を増やさない)。一方、右クリック「名前を付けて画像を保存」時に
// ブラウザが提案するファイル名はcontentDispositionで別途指定できるため、
// そちらだけタイムスタンプ付きにして、複数サイトの画像をローカル保存した際に
// 全部「image.jpg」で衝突・上書きされてしまうのを防ぐ。
function timestampedFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `Image_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

function getSharedUserId() {
  let id = localStorage.getItem(LS_SHARED_UID);
  if (!id) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = 'u_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(LS_SHARED_UID, id);
  }
  return id;
}

// callback(user | null)。userはFirebase Authのemailログイン済みユーザーのときのみ渡す
// (匿名Authや未ログインはnull扱い＝アカウント登録者限定機能のため)。
export function onAccountAuthState(callback) {
  return onAuthStateChanged(auth, (user) => {
    callback(user && user.email ? user : null);
  });
}

// siteId: 'genshinRanking' | 'starrailRankingPath' | 'starrailRankingElement' | 'genshinCheck' | 'starrailCheck'
// blob: image/jpeg のBlob(html2canvas → canvas.toBlob('image/jpeg', quality)の結果)
// 未ログイン、失敗時はどちらも静かに諦める(呼び出し元のローカル保存/共有フローは絶対に壊さない)。
export async function saveProfileImage(siteId, blob) {
  const user = auth.currentUser;
  if (!user || !blob) return;

  try {
    const sharedUserId = getSharedUserId();
    const storageRef = ref(storage, `savedImages/${siteId}/${sharedUserId}/image.jpg`);
    await uploadBytes(storageRef, blob, {
      contentType: 'image/jpeg',
      contentDisposition: `attachment; filename="${timestampedFilename()}"`,
    });
    const url = await getDownloadURL(storageRef);
    await setDoc(doc(db, 'savedProfileImages', sharedUserId), {
      [siteId]: { url, updatedAt: serverTimestamp() },
    }, { merge: true });
  } catch (e) {
    console.error('[saved-image] upload failed', e);
  }
}

// siteId向けに前回保存した画像を取得する。未ログイン/未保存/失敗時はnull。
export async function getSavedProfileImage(siteId) {
  const user = auth.currentUser;
  if (!user) return null;

  try {
    const sharedUserId = getSharedUserId();
    const snap = await getDoc(doc(db, 'savedProfileImages', sharedUserId));
    if (snap.exists()) {
      const entry = snap.data()[siteId];
      if (entry && entry.url) return entry;
    }
  } catch (e) {
    console.error('[saved-image] fetch failed', e);
  }
  return null;
}

// 任意のsharedUserId向けに保存画像を取得する(閲覧側がログインしているかは問わない、
// Firestoreルールがsavedプロフィール画像を公開読み取り可としているため)。
// 25_FriendBoardなどで「他人の投稿カードに保存画像を出す」用途に使う。
export async function getSavedProfileImageFor(siteId, sharedUserId) {
  if (!sharedUserId) return null;
  try {
    const snap = await getDoc(doc(db, 'savedProfileImages', sharedUserId));
    if (snap.exists()) {
      const entry = snap.data()[siteId];
      if (entry && entry.url) return entry;
    }
  } catch (e) {
    console.error('[saved-image] fetch (for) failed', e);
  }
  return null;
}

// FirestoreのTimestampを "yyyy/MM/dd HH:mm" 形式の文字列にする。
export function formatSavedAt(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== 'function') return '';
  const d = timestamp.toDate();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

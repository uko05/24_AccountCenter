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
 * 呼び出し元サイトの既定Firebaseプロジェクトが genshin-bakatare01 でも別プロジェクト
 * (例: starrail-bakatare02)でも同じように動くよう、このモジュール専用の名前付きApp
 * ('ukoSavedImage')で常に genshin-bakatare01 に接続する(10_connectの'connect10'と同じ技法)。
 *
 * ログイン判定・共有匿名IDは他サイトと同じ仕組みを踏襲する:
 *   - ログイン = 24_AccountCenterでID/パスワード登録済み(Firebase Authのemailログイン)
 *   - 共有匿名ID = localStorage['genshinOmikuji_userId'](14_GenshinOmikuji/25_FriendBoard等と同じキー)
 *
 * 保存先:
 *   Storage:   savedImages/{siteId}/{sharedUserId}/image.png
 *   Firestore: savedProfileImages/{sharedUserId} = { [siteId]: { url, updatedAt } }
 * ルールは userAvatars/{sharedUserId} と同型（accountLinks経由で本人のみ書き込み可）。
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
const hasApp = getApps().some((a) => a.name === APP_NAME);
const app = hasApp ? getApp(APP_NAME) : initializeApp(firebaseConfig, APP_NAME);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const LS_SHARED_UID = 'genshinOmikuji_userId';

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
// blob: image/png のBlob(html2canvas → canvas.toBlob('image/png')の結果)
// 未ログイン、失敗時はどちらも静かに諦める(呼び出し元のローカル保存/共有フローは絶対に壊さない)。
export async function saveProfileImage(siteId, blob) {
  const user = auth.currentUser;
  if (!user || !blob) return;

  try {
    const sharedUserId = getSharedUserId();
    const storageRef = ref(storage, `savedImages/${siteId}/${sharedUserId}/image.png`);
    await uploadBytes(storageRef, blob, { contentType: 'image/png' });
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

// FirestoreのTimestampを "yyyy/MM/dd HH:mm" 形式の文字列にする。
export function formatSavedAt(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== 'function') return '';
  const d = timestamp.toDate();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

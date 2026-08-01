// script.js
import { app, db } from './firebaseConfig.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, setDoc, getDoc, collection, addDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const LS_OMIKUJI_UID = 'genshinOmikuji_userId';
const AUTH_EMAIL_SUFFIX = '@uko05.internal';

const auth = getAuth(app);

function getCurrentOmikujiUid() {
  return localStorage.getItem(LS_OMIKUJI_UID) || '';
}

function toAuthEmail(loginId) {
  return `${loginId.trim()}${AUTH_EMAIL_SUFFIX}`;
}

function showMsg(el, text, isError) {
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  el.classList.toggle('ok', !isError);
}

function authErrorMessage(e) {
  switch (e.code) {
    case 'auth/email-already-in-use': return 'そのIDは既に使われています。別のIDを選んでください。';
    case 'auth/weak-password':        return 'パスワードは6文字以上にしてください。';
    case 'auth/invalid-email':        return 'IDに使えない文字が含まれています。';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':       return 'IDまたはパスワードが違います。';
    default:                          return `エラーが発生しました（${e.code || e.message}）`;
  }
}

// ===== UID表示 =====
const uidBox = document.getElementById('current-uid');
const currentUid = getCurrentOmikujiUid();
uidBox.textContent = currentUid || 'この端末ではまだ発行されていません（おみくじサイトを一度開くと発行されます）';

// ===== 登録 =====
const registerBtn = document.getElementById('register-btn');
const registerMsg = document.getElementById('register-msg');

registerBtn.addEventListener('click', async () => {
  const id = document.getElementById('reg-id').value.trim();
  const pw = document.getElementById('reg-pw').value;

  if (!id || !pw) { showMsg(registerMsg, 'IDとパスワードを入力してください。', true); return; }

  const uidNow = getCurrentOmikujiUid();
  if (!uidNow) {
    showMsg(registerMsg, '先におみくじサイトを一度使ってから登録してください。', true);
    return;
  }

  registerBtn.disabled = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, toAuthEmail(id), pw);
    await setDoc(doc(db, 'accountLinks', cred.user.uid), {
      omikujiUserId: uidNow,
      loginId: id,
      createdAt: serverTimestamp(),
    });
    showMsg(registerMsg, '登録が完了しました。この端末には今まで通りのデータが残っています。', false);
  } catch (e) {
    showMsg(registerMsg, authErrorMessage(e), true);
  } finally {
    registerBtn.disabled = false;
  }
});

// ===== ログイン =====
const loginBtn = document.getElementById('login-btn');
const loginMsg = document.getElementById('login-msg');
const loginSuccessLinks = document.getElementById('login-success-links');

loginBtn.addEventListener('click', async () => {
  const id = document.getElementById('login-id').value.trim();
  const pw = document.getElementById('login-pw').value;

  if (!id || !pw) { showMsg(loginMsg, 'IDとパスワードを入力してください。', true); return; }

  loginBtn.disabled = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, toAuthEmail(id), pw);
    const linkSnap = await getDoc(doc(db, 'accountLinks', cred.user.uid));

    if (linkSnap.exists() && linkSnap.data().omikujiUserId) {
      localStorage.setItem(LS_OMIKUJI_UID, linkSnap.data().omikujiUserId);
      uidBox.textContent = linkSnap.data().omikujiUserId;
      showMsg(loginMsg, 'ログインしました。この端末に今までのデータを引き継ぎました。', false);
      loginSuccessLinks.classList.remove('hidden');
    } else {
      showMsg(loginMsg, 'ログインは成功しましたが、紐づくデータが見つかりませんでした。お手数ですが連絡してください。', true);
    }
  } catch (e) {
    showMsg(loginMsg, authErrorMessage(e), true);
  } finally {
    loginBtn.disabled = false;
  }
});

// ===== 機種変申請 =====
const mergeBtn = document.getElementById('merge-btn');
const mergeMsg = document.getElementById('merge-msg');

mergeBtn.addEventListener('click', async () => {
  const name = document.getElementById('merge-name').value.trim();
  const birthday = document.getElementById('merge-birthday').value;

  if (!name || !birthday) { showMsg(mergeMsg, '名前と誕生日を入力してください。', true); return; }

  const uidNow = getCurrentOmikujiUid();
  if (!uidNow) {
    showMsg(mergeMsg, '先にこの端末でおみくじサイトを一度開いてから申請してください。', true);
    return;
  }

  mergeBtn.disabled = true;
  try {
    await addDoc(collection(db, 'mergeRequests'), {
      name, birthday,
      newUserId: uidNow,
      status: 'pending',
      createdAt: serverTimestamp(),
    });
    showMsg(mergeMsg, '申請を受け付けました。管理者が確認後、データを引き継ぎます。', false);
    document.getElementById('merge-name').value = '';
    document.getElementById('merge-birthday').value = '';
  } catch (e) {
    showMsg(mergeMsg, `送信に失敗しました（${e.code || e.message}）`, true);
  } finally {
    mergeBtn.disabled = false;
  }
});

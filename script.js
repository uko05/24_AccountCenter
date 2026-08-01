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

// ===== i18n =====
const i18n = {
  ja: {
    pageTitle: 'アカウント管理',
    headerSub: 'おみくじ等の記録の確認・引き継ぎはこちらから',
    introTitle: 'このページについて（登録は任意です）',
    introDesc: 'おみくじサイトなどは、これまで通り登録しなくてもすべての機能を使えます。このページが必要になるのは、①機種変・端末変更をしても今までのデータを引き継ぎたいとき、②今の状態(UID)を確認したいとき、③次回から自動でデータを引き継げるようにしておきたいとき、の3つです。',
    uidTitle: '現在のUID',
    uidDesc: 'この端末でおみくじサイトなどを使うと自動的に発行されるIDです。通常はこの値を覚えておく必要はありません。',
    uidLoading: '読み込み中…',
    uidNone: 'この端末ではまだ発行されていません（おみくじサイトを一度開くと発行されます）',
    registerTitle: 'アカウント登録（任意）',
    registerDesc: 'ID・パスワードを設定すると、機種変した際もログインするだけで今までのデータを引き継げます。登録しなくても今まで通り使えます。',
    labelId: 'ID',
    labelPassword: 'パスワード',
    idPlaceholder: '半角英数字など',
    pwPlaceholder: '6文字以上',
    registerBtn: '登録する',
    loginTitle: 'ログイン',
    loginDesc: '登録済みの方はこちら。ログインすると、この端末に今までのデータが引き継がれます。',
    loginBtn: 'ログインする',
    openOmikuji: '原神おみくじを開く',
    mergeTitle: '機種変した方はこちら',
    mergeDesc: '登録せずに占っていた方向けの引き継ぎ申請です。おみくじを引いた際に入力した「名前」「誕生日」を入力してください。管理者が確認のうえ、この端末に今までのデータを引き継ぎます（すぐには反映されません）。',
    labelMergeName: 'おみくじ時に入力した名前',
    labelBirthday: '誕生日',
    mergeBtn: '申請する',
    mergeContactDesc: '名前を入力せずに占っていた方・上記が当てはまらない方は、下のリンクから直接連絡してください。',
    sadLabel: '＜友達ください…',

    msgFillIdPw: 'IDとパスワードを入力してください。',
    msgNeedOmikujiFirst: '先におみくじサイトを一度使ってから登録してください。',
    msgRegisterOk: '登録が完了しました。この端末には今まで通りのデータが残っています。',
    msgLoginOk: 'ログインしました。この端末に今までのデータを引き継ぎました。',
    msgLoginNoLink: 'ログインは成功しましたが、紐づくデータが見つかりませんでした。お手数ですが連絡してください。',
    msgFillMerge: '名前と誕生日を入力してください。',
    msgNeedOmikujiFirstMerge: '先にこの端末でおみくじサイトを一度開いてから申請してください。',
    msgMergeOk: '申請を受け付けました。管理者が確認後、データを引き継ぎます。',
    msgMergeFail: '送信に失敗しました',
    errUsedId: 'そのIDは既に使われています。別のIDを選んでください。',
    errWeakPw: 'パスワードは6文字以上にしてください。',
    errInvalidId: 'IDに使えない文字が含まれています。',
    errWrongLogin: 'IDまたはパスワードが違います。',
    errGeneric: 'エラーが発生しました',
  },
  en: {
    pageTitle: 'Account Center',
    headerSub: 'Check and transfer your omikuji records here',
    introTitle: 'About this page (registration is optional)',
    introDesc: 'Sites like the omikuji still work fully without registering, just like before. This page is only needed when: 1) you switch devices and want to carry over your data, 2) you want to check your current status (UID), or 3) you want to set things up so future device changes carry over automatically.',
    uidTitle: 'Your current UID',
    uidDesc: 'This ID is issued automatically on this device when you use a site like the omikuji. You usually do not need to remember it.',
    uidLoading: 'Loading…',
    uidNone: 'Not issued on this device yet (visit the omikuji site once to get one).',
    registerTitle: 'Register an account (optional)',
    registerDesc: 'Set an ID and password to keep your data even after switching devices — just log in on the new device. Everything still works fine without registering.',
    labelId: 'ID',
    labelPassword: 'Password',
    idPlaceholder: 'letters/numbers, etc.',
    pwPlaceholder: '6+ characters',
    registerBtn: 'Register',
    loginTitle: 'Log in',
    loginDesc: 'Already registered? Log in here to bring your data to this device.',
    loginBtn: 'Log in',
    openOmikuji: 'Open Genshin Omikuji',
    mergeTitle: 'Switched devices without registering?',
    mergeDesc: 'This is a data-transfer request for people who used the omikuji without registering. Enter the name and birthday you used when drawing fortunes. The admin will verify and transfer your old data to this device (not instant).',
    labelMergeName: 'Name used on the omikuji site',
    labelBirthday: 'Birthday',
    mergeBtn: 'Submit request',
    mergeContactDesc: 'If you drew fortunes without entering a name, or none of the above applies, please contact us directly using the links below.',
    sadLabel: '< Follow me on X!',

    msgFillIdPw: 'Please enter an ID and password.',
    msgNeedOmikujiFirst: 'Please use the omikuji site once before registering.',
    msgRegisterOk: 'Registration complete. Your data on this device is unchanged.',
    msgLoginOk: 'Logged in. Your data has been transferred to this device.',
    msgLoginNoLink: 'Login succeeded, but no linked data was found. Please contact us.',
    msgFillMerge: 'Please enter your name and birthday.',
    msgNeedOmikujiFirstMerge: 'Please open the omikuji site on this device once before submitting.',
    msgMergeOk: 'Request received. The admin will transfer your data after verifying.',
    msgMergeFail: 'Failed to send',
    errUsedId: 'That ID is already taken. Please choose another.',
    errWeakPw: 'Password must be at least 6 characters.',
    errInvalidId: 'That ID contains characters that cannot be used.',
    errWrongLogin: 'Incorrect ID or password.',
    errGeneric: 'An error occurred',
  },
};

let currentLang = 'ja';
function t(key) { return i18n[currentLang][key] ?? key; }

function applyLang(lang) {
  currentLang = (lang === 'en') ? 'en' : 'ja';
  document.documentElement.lang = currentLang;
  localStorage.setItem('lang', currentLang);

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (i18n[currentLang][key] !== undefined) el.textContent = i18n[currentLang][key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    if (i18n[currentLang][key] !== undefined) el.placeholder = i18n[currentLang][key];
  });

  uidBox.textContent = getCurrentOmikujiUid() || t('uidNone');
}

function initLangSwitch() {
  const saved = localStorage.getItem('lang') || 'ja';
  const radio = document.querySelector(`input[name="lang"][value="${saved}"]`);
  if (radio) radio.checked = true;

  document.querySelectorAll('input[name="lang"]').forEach((r) => {
    r.addEventListener('change', (e) => applyLang(e.target.value));
  });

  applyLang(saved);
}

// ===== 共通ヘルパー =====
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

// ブラウザのパスワード保存プロンプトを明示的に呼び出す(対応ブラウザのみ)
async function offerSaveCredential(id, pw) {
  if (!('PasswordCredential' in window)) return;
  try {
    await navigator.credentials.store(new PasswordCredential({ id, password: pw, name: id }));
  } catch { /* 対応していない・拒否された場合は無視 */ }
}

function authErrorMessage(e) {
  switch (e.code) {
    case 'auth/email-already-in-use': return t('errUsedId');
    case 'auth/weak-password':        return t('errWeakPw');
    case 'auth/invalid-email':        return t('errInvalidId');
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':       return t('errWrongLogin');
    default:                          return `${t('errGeneric')}（${e.code || e.message}）`;
  }
}

// ===== UID表示 =====
const uidBox = document.getElementById('current-uid');

// ===== 登録 =====
const registerForm = document.getElementById('register-form');
const registerBtn = document.getElementById('register-btn');
const registerMsg = document.getElementById('register-msg');

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('reg-id').value.trim();
  const pw = document.getElementById('reg-pw').value;

  if (!id || !pw) { showMsg(registerMsg, t('msgFillIdPw'), true); return; }

  const uidNow = getCurrentOmikujiUid();
  if (!uidNow) {
    showMsg(registerMsg, t('msgNeedOmikujiFirst'), true);
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
    showMsg(registerMsg, t('msgRegisterOk'), false);
    await offerSaveCredential(id, pw);
  } catch (e) {
    showMsg(registerMsg, authErrorMessage(e), true);
  } finally {
    registerBtn.disabled = false;
  }
});

// ===== ログイン =====
const loginForm = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const loginMsg = document.getElementById('login-msg');
const loginSuccessLinks = document.getElementById('login-success-links');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('login-id').value.trim();
  const pw = document.getElementById('login-pw').value;

  if (!id || !pw) { showMsg(loginMsg, t('msgFillIdPw'), true); return; }

  loginBtn.disabled = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, toAuthEmail(id), pw);
    const linkSnap = await getDoc(doc(db, 'accountLinks', cred.user.uid));

    if (linkSnap.exists() && linkSnap.data().omikujiUserId) {
      localStorage.setItem(LS_OMIKUJI_UID, linkSnap.data().omikujiUserId);
      uidBox.textContent = linkSnap.data().omikujiUserId;
      showMsg(loginMsg, t('msgLoginOk'), false);
      loginSuccessLinks.classList.remove('hidden');
      await offerSaveCredential(id, pw);
    } else {
      showMsg(loginMsg, t('msgLoginNoLink'), true);
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

  if (!name || !birthday) { showMsg(mergeMsg, t('msgFillMerge'), true); return; }

  const uidNow = getCurrentOmikujiUid();
  if (!uidNow) {
    showMsg(mergeMsg, t('msgNeedOmikujiFirstMerge'), true);
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
    showMsg(mergeMsg, t('msgMergeOk'), false);
    document.getElementById('merge-name').value = '';
    document.getElementById('merge-birthday').value = '';
  } catch (e) {
    showMsg(mergeMsg, `${t('msgMergeFail')}（${e.code || e.message}）`, true);
  } finally {
    mergeBtn.disabled = false;
  }
});

initLangSwitch();

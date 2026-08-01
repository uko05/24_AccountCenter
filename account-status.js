/**
 * うーこの部屋 共通ログイン状態バッジ
 *
 * 使い方: 各ページの </body> 直前に下記1行を追加するだけ（type="module" 必須）
 *   <script type="module" src="https://uko05.github.io/24_AccountCenter/account-status.js"></script>
 *
 * ヘッダーの言語切替の左に置きたいので、ページ側に
 *   <span id="uko-account-status-slot"></span>
 * を .lang-switch の直前に置いておくと、そこに描画される。無ければ .lang-switch の直前に
 * 自動挿入し、それも無ければ何もしない（無理に浮かせて表示しない）。
 *
 * AccountCenterでID+パスワード登録/ログインすると、同一オリジン(uko05.github.io)内の
 * どのページでもFirebase Authのログイン状態を共有できるため、それを検知してバッジ表示する。
 * 登録していない人には何も表示しない（登録必須に見えないようにするため）。
 */
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCP4QfMGDDBSI8VDERnESBOlHpUhy7wGPk",
  authDomain: "genshin-bakatare01.firebaseapp.com",
  projectId: "genshin-bakatare01",
  storageBucket: "genshin-bakatare01.firebasestorage.app",
  messagingSenderId: "658089418604",
  appId: "1:658089418604:web:288c06b331da8c4f789d49",
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const text = {
  ja: { loggedInAs: (id) => `ログイン中: ${id}`, logout: 'ログアウト' },
  en: { loggedInAs: (id) => `Logged in: ${id}`, logout: 'Log out' },
};

function currentLang() {
  return (document.documentElement.lang === 'en') ? 'en' : 'ja';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const css = `
  #uko-account-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: inherit;
    opacity: 0.85;
    white-space: nowrap;
  }
  #uko-account-status button {
    background: none;
    border: none;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    opacity: 0.8;
  }
  #uko-account-status button:hover { opacity: 1; }
`;

function ensureStyle() {
  if (document.getElementById('uko-account-status-style')) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'uko-account-status-style';
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
}

function findOrCreateSlot() {
  let slot = document.getElementById('uko-account-status-slot');
  if (slot) return slot;

  const langSwitch = document.querySelector('.lang-switch');
  if (!langSwitch || !langSwitch.parentNode) return null;

  slot = document.createElement('span');
  slot.id = 'uko-account-status-slot';
  langSwitch.parentNode.insertBefore(slot, langSwitch);
  return slot;
}

function removeBadge() {
  const slot = document.getElementById('uko-account-status-slot');
  if (slot) slot.innerHTML = '';
}

function renderBadge(loginId) {
  const slot = findOrCreateSlot();
  if (!slot) return;
  ensureStyle();

  const t = text[currentLang()];
  slot.innerHTML = `<span id="uko-account-status"><span>${escapeHtml(t.loggedInAs(loginId))}</span><button type="button">${escapeHtml(t.logout)}</button></span>`;
  slot.querySelector('button').addEventListener('click', () => signOut(auth));
}

onAuthStateChanged(auth, (user) => {
  if (!user || !user.email) { removeBadge(); return; }
  renderBadge(user.email.split('@')[0]);
});

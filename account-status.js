/**
 * うーこの部屋 共通ログイン状態バッジ
 *
 * 使い方: 各ページの </body> 直前に下記1行を追加するだけ（type="module" 必須）
 *   <script type="module" src="https://uko05.github.io/24_AccountCenter/account-status.js"></script>
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
    position: fixed;
    top: 56px;
    left: 12px;
    z-index: 997;
    background: rgba(255,255,255,0.92);
    border: 1px solid #dddddd;
    border-radius: 20px;
    padding: 5px 10px;
    font-size: 12px;
    color: #333;
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 2px 6px rgba(0,0,0,0.12);
  }
  #uko-account-status button {
    background: none;
    border: none;
    color: #888;
    text-decoration: underline;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
  }
  #uko-account-status button:hover { color: #333; }
`;

function ensureStyle() {
  if (document.getElementById('uko-account-status-style')) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'uko-account-status-style';
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
}

function removeBadge() {
  document.getElementById('uko-account-status')?.remove();
}

function renderBadge(loginId) {
  removeBadge();
  ensureStyle();
  const t = text[currentLang()];
  const el = document.createElement('div');
  el.id = 'uko-account-status';
  el.innerHTML = `<span>${escapeHtml(t.loggedInAs(loginId))}</span><button type="button">${escapeHtml(t.logout)}</button>`;
  el.querySelector('button').addEventListener('click', () => signOut(auth));
  document.body.appendChild(el);
}

onAuthStateChanged(auth, (user) => {
  if (!user || !user.email) { removeBadge(); return; }
  renderBadge(user.email.split('@')[0]);
});

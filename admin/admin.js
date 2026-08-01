// admin.js
import { app, db } from '../firebaseConfig.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, collection, query, where, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { ACHIEVEMENT_GROUPS } from "https://uko05.github.io/14_GenshinOmikuji/achievements.js";

const ADMIN_UID = 'UPInlRxp2eM8OI3p18UU1d3OzNc2';
const AUTH_EMAIL_SUFFIX = '@uko05.internal';

const auth = getAuth(app);

const gateEl    = document.getElementById('admin-gate');
const contentEl = document.getElementById('admin-content');
const whoamiEl  = document.getElementById('admin-whoami');

onAuthStateChanged(auth, (user) => {
  const isAdmin = !!user && user.uid === ADMIN_UID;
  gateEl.classList.toggle('hidden', isAdmin);
  contentEl.classList.toggle('hidden', !isAdmin);
  if (isAdmin) {
    whoamiEl.textContent = user.email;
    loadRequests();
  }
});

document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('admin-email').value.trim();
  const pw = document.getElementById('admin-pw').value;
  const msgEl = document.getElementById('admin-login-msg');
  try {
    await signInWithEmailAndPassword(auth, `${id}${AUTH_EMAIL_SUFFIX}`, pw);
    msgEl.textContent = '';
    if ('PasswordCredential' in window) {
      try { await navigator.credentials.store(new PasswordCredential({ id, password: pw, name: id })); } catch { /* noop */ }
    }
  } catch (err) {
    msgEl.textContent = `ログインに失敗しました（${err.code || err.message}）`;
    msgEl.classList.add('error');
  }
});

document.getElementById('admin-logout-btn').addEventListener('click', () => signOut(auth));

// ===== 日付表示 =====
function fmtTimestamp(ts) {
  if (!ts) return '-';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('ja-JP');
}

// ===== 機種変申請キュー =====
const requestsListEl = document.getElementById('requests-list');

document.getElementById('reload-requests-btn').addEventListener('click', loadRequests);

async function loadRequests() {
  requestsListEl.textContent = '読み込み中…';
  const snap = await getDocs(query(collection(db, 'mergeRequests'), where('status', '==', 'pending')));

  if (snap.empty) {
    requestsListEl.textContent = '未処理の申請はありません。';
    return;
  }

  requestsListEl.innerHTML = '';
  for (const reqDoc of snap.docs) {
    const req = reqDoc.data();
    const card = document.createElement('div');
    card.className = 'request-card';
    card.innerHTML = `
      <h4>${escapeHtml(req.name)}（${escapeHtml(req.birthday)}）</h4>
      <div style="font-size:0.78rem; color:var(--muted);">
        申請日時: ${fmtTimestamp(req.createdAt)}／申請元の現在UID: ${escapeHtml(req.newUserId)}
      </div>
      <div class="candidate-list" data-role="candidates">検索中…</div>
      <div class="btn-row">
        <button class="danger-btn" data-action="reject">この申請を却下</button>
      </div>
    `;
    card.querySelector('[data-action="reject"]').addEventListener('click', async () => {
      if (!confirm('この申請を却下しますか？')) return;
      await setDoc(doc(db, 'mergeRequests', reqDoc.id), { status: 'rejected', resolvedAt: serverTimestamp() }, { merge: true });
      loadRequests();
    });
    requestsListEl.appendChild(card);

    const candidatesEl = card.querySelector('[data-role="candidates"]');
    renderCandidates(candidatesEl, req, reqDoc.id);
  }
}

async function renderCandidates(container, req, requestId) {
  const snap = await getDocs(query(collection(db, 'omikujiUsers'), where('name', '==', req.name)));

  if (snap.empty) {
    container.textContent = '同じ名前のデータが見つかりませんでした。無記名の可能性があります。';
    return;
  }

  container.innerHTML = '';
  snap.forEach((userDoc) => {
    const u = userDoc.data();
    const birthdayMatch = u.birthday === req.birthday;
    const item = document.createElement('div');
    item.className = 'candidate-item';
    item.innerHTML = `
      <div class="candidate-info">
        <div><b>UID:</b> ${escapeHtml(userDoc.id)}</div>
        <div><b>誕生日:</b> ${escapeHtml(u.birthday || '-')} ${birthdayMatch ? '✅一致' : ''}</div>
        <div><b>累計回数:</b> ${u.achStats?.totalCount ?? '-'}／<b>最大連続:</b> ${u.achStats?.maxStreak ?? '-'}／<b>アチーブ数:</b> ${(u.achievements || []).length}</div>
        <div><b>最終更新:</b> ${fmtTimestamp(u.updatedAt)}</div>
      </div>
      <button class="primary-btn" style="width:auto; padding:8px 16px;" data-action="merge">このデータで引き継ぐ</button>
    `;
    item.querySelector('[data-action="merge"]').addEventListener('click', async () => {
      if (!confirm(`UID ${userDoc.id} のデータを ${req.newUserId} に引き継ぎます。よろしいですか？`)) return;
      await setDoc(doc(db, 'omikujiUsers', req.newUserId), { ...u, updatedAt: serverTimestamp() });
      await setDoc(doc(db, 'mergeRequests', requestId), {
        status: 'done', resolvedAt: serverTimestamp(), mergedFrom: userDoc.id,
      }, { merge: true });
      loadRequests();
    });
    container.appendChild(item);
  });
}

// ===== ユーザー検索 =====
const searchResultsEl = document.getElementById('search-results');

document.getElementById('search-btn').addEventListener('click', async () => {
  const value = document.getElementById('search-input').value.trim();
  if (!value) return;
  searchResultsEl.innerHTML = '検索中…';

  const results = new Map();

  const byIdSnap = await getDoc(doc(db, 'omikujiUsers', value));
  if (byIdSnap.exists()) results.set(byIdSnap.id, byIdSnap.data());

  const byNameSnap = await getDocs(query(collection(db, 'omikujiUsers'), where('name', '==', value)));
  byNameSnap.forEach((d) => results.set(d.id, d.data()));

  if (results.size === 0) {
    searchResultsEl.innerHTML = '該当するユーザーが見つかりませんでした。';
    return;
  }

  searchResultsEl.innerHTML = '';
  results.forEach((u, id) => {
    const item = document.createElement('div');
    item.className = 'candidate-item';
    item.innerHTML = `
      <div class="candidate-info">
        <div><b>UID:</b> ${escapeHtml(id)}</div>
        <div><b>名前:</b> ${escapeHtml(u.name || '(無記名)')}／<b>誕生日:</b> ${escapeHtml(u.birthday || '-')}</div>
        <div><b>アチーブ数:</b> ${(u.achievements || []).length}</div>
      </div>
      <button class="primary-btn" style="width:auto; padding:8px 16px;" data-action="edit">編集</button>
    `;
    item.querySelector('[data-action="edit"]').addEventListener('click', () => openEditor(id, u));
    searchResultsEl.appendChild(item);
  });
});

// ===== 編集フォーム =====
const editSection   = document.getElementById('edit-section');
let currentEditUid   = null;
let currentEditData  = null;

function openEditor(uid, data) {
  currentEditUid = uid;
  currentEditData = data;

  document.getElementById('edit-uid').textContent = uid;
  document.getElementById('edit-name').value = data.name || '';
  document.getElementById('edit-birthday').value = data.birthday || '';
  document.getElementById('edit-gender').value = data.gender || '';
  document.getElementById('edit-lang').value = data.lang || 'ja';
  document.getElementById('edit-total-count').value = data.achStats?.totalCount ?? 0;
  document.getElementById('edit-max-streak').value = data.achStats?.maxStreak ?? 0;
  document.getElementById('edit-collection').value = (data.collection || []).join('\n');

  renderAchievementCheckboxes(new Set(data.achievements || []));

  editSection.classList.remove('hidden');
  editSection.scrollIntoView({ behavior: 'smooth' });
}

function renderAchievementCheckboxes(achievedSet) {
  const container = document.getElementById('edit-achievements');
  container.innerHTML = '';
  ACHIEVEMENT_GROUPS.forEach((group) => {
    const groupEl = document.createElement('div');
    groupEl.className = 'ach-group';
    const rows = group.items.map((item) => `
      <label class="ach-check-row">
        <input type="checkbox" value="${escapeHtml(item.id)}" ${achievedSet.has(item.id) ? 'checked' : ''}>
        <span>${escapeHtml(item.name)}<span class="ach-cond"> — ${escapeHtml(item.condition)}</span></span>
      </label>
    `).join('');
    groupEl.innerHTML = `<h5>${escapeHtml(group.name)}</h5>${rows}`;
    container.appendChild(groupEl);
  });
}

document.getElementById('cancel-edit-btn').addEventListener('click', () => {
  editSection.classList.add('hidden');
  currentEditUid = null;
  currentEditData = null;
});

document.getElementById('save-edit-btn').addEventListener('click', async () => {
  if (!currentEditUid) return;
  const msgEl = document.getElementById('edit-msg');

  const achievements = Array.from(
    document.querySelectorAll('#edit-achievements input[type="checkbox"]:checked'),
  ).map((el) => el.value);

  const collectionIds = document.getElementById('edit-collection').value
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const payload = {
    name: document.getElementById('edit-name').value.trim(),
    birthday: document.getElementById('edit-birthday').value,
    gender: document.getElementById('edit-gender').value,
    lang: document.getElementById('edit-lang').value,
    collection: collectionIds,
    achievements,
    achStats: {
      ...(currentEditData.achStats || {}),
      totalCount: Number(document.getElementById('edit-total-count').value) || 0,
      maxStreak: Number(document.getElementById('edit-max-streak').value) || 0,
    },
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'omikujiUsers', currentEditUid), payload, { merge: true });
    msgEl.textContent = '保存しました。';
    msgEl.classList.remove('error');
    msgEl.classList.add('ok');
  } catch (e) {
    msgEl.textContent = `保存に失敗しました（${e.code || e.message}）`;
    msgEl.classList.add('error');
  }
});

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

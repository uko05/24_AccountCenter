// admin.js
import { app, db } from '../firebaseConfig.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, deleteDoc, collection, query, where, orderBy, limit, getDocs, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const ACCOUNTS_LOAD_LIMIT = 100;
import { ACHIEVEMENT_GROUPS, ALL_ACHIEVEMENTS } from "https://uko05.github.io/14_GenshinOmikuji/achievements.js";

const RARITY_BY_ID = new Map(ALL_ACHIEVEMENTS.map((a) => [a.id, a.rarity]));

function countByRarity(achievementIds) {
  const counts = { bronze: 0, silver: 0, gold: 0, legend: 0 };
  (achievementIds || []).forEach((id) => {
    const rarity = RARITY_BY_ID.get(id);
    if (rarity && rarity in counts) counts[rarity]++;
  });
  return counts;
}

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
    loadAccounts();
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

// ===== ユーザー一覧（最終更新順、登録・未登録どちらも） =====
const accountsListEl = document.getElementById('accounts-list');
const accountsCountEl = document.getElementById('accounts-count');
const accountsFilterEl = document.getElementById('accounts-filter');
const accountsFilterRegisteredEl = document.getElementById('accounts-filter-registered');
const accountsFilterUnregisteredEl = document.getElementById('accounts-filter-unregistered');
let allAccounts = [];

document.getElementById('reload-accounts-btn').addEventListener('click', loadAccounts);
accountsFilterEl.addEventListener('input', () => renderAccounts(accountsFilterEl.value));
accountsFilterRegisteredEl.addEventListener('change', () => renderAccounts(accountsFilterEl.value));
accountsFilterUnregisteredEl.addEventListener('change', () => renderAccounts(accountsFilterEl.value));

async function loadAccounts() {
  accountsListEl.innerHTML = '読み込み中…';

  const [usersSnap, linkSnap] = await Promise.all([
    getDocs(query(collection(db, 'omikujiUsers'), orderBy('updatedAt', 'desc'), limit(ACCOUNTS_LOAD_LIMIT))),
    getDocs(collection(db, 'accountLinks')),
  ]);

  const linkByOmikujiId = new Map();
  linkSnap.docs.forEach((linkDoc) => {
    const link = linkDoc.data();
    if (link.omikujiUserId) linkByOmikujiId.set(link.omikujiUserId, { ...link, authUid: linkDoc.id });
  });

  allAccounts = usersSnap.docs.map((userDoc) => {
    const link = linkByOmikujiId.get(userDoc.id);
    return {
      omikujiUserId: userDoc.id,
      authUid: link?.authUid || null,
      loginId: link?.loginId || '',
      isRegistered: !!link,
      omikujiData: userDoc.data(),
    };
  });

  renderAccounts(accountsFilterEl.value);
}

function renderAccounts(filterText) {
  const needle = (filterText || '').trim().toLowerCase();
  const showRegistered = accountsFilterRegisteredEl.checked;
  const showUnregistered = accountsFilterUnregisteredEl.checked;

  const filtered = allAccounts.filter((a) => {
    if (a.isRegistered && !showRegistered) return false;
    if (!a.isRegistered && !showUnregistered) return false;
    if (!needle) return true;
    return a.loginId.toLowerCase().includes(needle) || (a.omikujiData?.name || '').toLowerCase().includes(needle);
  });

  accountsCountEl.textContent = `${filtered.length} / ${allAccounts.length} 件（最終更新が新しい順に最大${ACCOUNTS_LOAD_LIMIT}件を読み込み）`;

  if (filtered.length === 0) {
    accountsListEl.innerHTML = '該当するユーザーがいません。';
    return;
  }

  const table = document.createElement('table');
  table.className = 'user-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width:auto;">名前</th>
        <th style="width:30%; white-space:nowrap;">登録ID</th>
        <th style="width:1%; white-space:nowrap;">最終更新日時</th>
        <th style="width:1%; white-space:nowrap;">銅</th>
        <th style="width:1%; white-space:nowrap;">銀</th>
        <th style="width:1%; white-space:nowrap;">金</th>
        <th style="width:1%; white-space:nowrap;">虹</th>
        <th style="width:1%; white-space:nowrap;"></th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  filtered.forEach((a) => {
    const u = a.omikujiData;
    const counts = countByRarity(u.achievements);
    const tr = document.createElement('tr');
    const actionBtnStyle = 'width:auto; display:inline-block; box-sizing:border-box; padding:6px 14px; font-size:0.8rem; font-weight:normal; line-height:1.4; border-radius:20px;';
    const actionsCell = `
      <td style="white-space:nowrap;">
        <div style="display:flex; gap:6px; flex-wrap:nowrap;">
          <button class="primary-btn" style="${actionBtnStyle}" data-action="edit">編集</button>
          ${a.isRegistered ? `<button class="danger-btn" style="${actionBtnStyle}" data-action="delete">登録解除</button>` : ''}
        </div>
      </td>
    `;
    tr.innerHTML = `
      <td>${escapeHtml(u.name || '(無記名)')}</td>
      <td style="white-space:nowrap;">${escapeHtml(a.loginId || '-')}</td>
      <td style="white-space:nowrap;">${fmtTimestamp(u.updatedAt)}</td>
      <td style="white-space:nowrap;">${counts.bronze}</td>
      <td style="white-space:nowrap;">${counts.silver}</td>
      <td style="white-space:nowrap;">${counts.gold}</td>
      <td style="white-space:nowrap;">${counts.legend}</td>
      ${actionsCell}
    `;
    tr.querySelector('[data-action="edit"]').addEventListener('click', () => openEditor(a.omikujiUserId, u));
    tr.querySelector('[data-action="delete"]')?.addEventListener('click', () => deleteAccountLink(a));
    tbody.appendChild(tr);
  });

  accountsListEl.innerHTML = '';
  accountsListEl.appendChild(table);
}

async function deleteAccountLink(a) {
  if (!confirm(`登録ID「${a.loginId}」の登録を解除します。\n\n※ Firebase Authのアカウントやomikujiのデータ自体は消えません。この登録情報(accountLinks)だけを削除します。\n\nよろしいですか？`)) return;
  await deleteDoc(doc(db, 'accountLinks', a.authUid));
  a.authUid = null;
  a.loginId = '';
  a.isRegistered = false;
  renderAccounts(accountsFilterEl.value);
}

// ===== ユーザー検索 =====
const searchResultsEl = document.getElementById('search-results');

document.getElementById('search-btn').addEventListener('click', async () => {
  const value = document.getElementById('search-input').value.trim();
  if (!value) return;
  searchResultsEl.innerHTML = '検索中…';

  // uid -> { data, viaLoginId }
  const results = new Map();

  const byIdSnap = await getDoc(doc(db, 'omikujiUsers', value));
  if (byIdSnap.exists()) results.set(byIdSnap.id, { data: byIdSnap.data(), viaLoginId: null });

  const byNameSnap = await getDocs(query(collection(db, 'omikujiUsers'), where('name', '==', value)));
  byNameSnap.forEach((d) => {
    if (!results.has(d.id)) results.set(d.id, { data: d.data(), viaLoginId: null });
  });

  // 登録済みアカウントのID(accountLinks.loginId)からの検索
  const byLoginIdSnap = await getDocs(query(collection(db, 'accountLinks'), where('loginId', '==', value)));
  for (const linkDoc of byLoginIdSnap.docs) {
    const omikujiUserId = linkDoc.data().omikujiUserId;
    if (!omikujiUserId) continue;
    if (results.has(omikujiUserId)) {
      results.get(omikujiUserId).viaLoginId = value;
      continue;
    }
    const userSnap = await getDoc(doc(db, 'omikujiUsers', omikujiUserId));
    if (userSnap.exists()) results.set(userSnap.id, { data: userSnap.data(), viaLoginId: value });
  }

  if (results.size === 0) {
    searchResultsEl.innerHTML = '該当するユーザーが見つかりませんでした。';
    return;
  }

  searchResultsEl.innerHTML = '';
  results.forEach(({ data: u, viaLoginId }, id) => {
    const item = document.createElement('div');
    item.className = 'candidate-item';
    item.innerHTML = `
      <div class="candidate-info">
        <div><b>UID:</b> ${escapeHtml(id)}</div>
        <div><b>名前:</b> ${escapeHtml(u.name || '(無記名)')}／<b>誕生日:</b> ${escapeHtml(u.birthday || '-')}</div>
        <div><b>アチーブ数:</b> ${(u.achievements || []).length}</div>
        ${viaLoginId ? `<div><b>登録ID:</b> ${escapeHtml(viaLoginId)} で一致</div>` : ''}
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

async function openEditor(uid, data) {
  currentEditUid = uid;
  currentEditData = data;

  document.getElementById('edit-uid').textContent = uid;
  document.getElementById('edit-name').value = data.name || '';
  document.getElementById('edit-birthday').value = data.birthday || '';
  setRadioValue('edit-gender', data.gender || '');
  setRadioValue('edit-lang', data.lang || 'ja');
  document.getElementById('edit-total-count').value = data.achStats?.totalCount ?? 0;
  document.getElementById('edit-max-streak').value = data.achStats?.maxStreak ?? 0;
  document.getElementById('edit-collection').value = (data.collection || []).join('\n');

  renderAchievementCheckboxes(new Set(data.achievements || []));

  const roleSnap = await getDoc(doc(db, 'sharedUserRoles', uid));
  const roleData = roleSnap.exists() ? roleSnap.data() : {};
  setRadioValue('edit-role', roleData.role || 'general');
  document.getElementById('edit-debug-connect').checked = !!roleData.debugConnect;
  document.getElementById('edit-debug-omikuji').checked = !!roleData.debugOmikuji;
  updateRoleDebugOptionsVisibility();

  editSection.classList.remove('hidden');
  editSection.scrollIntoView({ behavior: 'smooth' });
}

function updateRoleDebugOptionsVisibility() {
  const isDebugger = getRadioValue('edit-role') === 'debugger';
  document.getElementById('edit-role-debug-options').classList.toggle('hidden', !isDebugger);
}

document.querySelectorAll('input[name="edit-role"]').forEach((r) => {
  r.addEventListener('change', updateRoleDebugOptionsVisibility);
});

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
    gender: getRadioValue('edit-gender'),
    lang: getRadioValue('edit-lang') || 'ja',
    collection: collectionIds,
    achievements,
    achStats: {
      ...(currentEditData.achStats || {}),
      totalCount: Number(document.getElementById('edit-total-count').value) || 0,
      maxStreak: Number(document.getElementById('edit-max-streak').value) || 0,
    },
    updatedAt: serverTimestamp(),
  };

  const role = getRadioValue('edit-role') || 'general';
  const debugConnect = document.getElementById('edit-debug-connect').checked;
  const debugOmikuji = document.getElementById('edit-debug-omikuji').checked;

  try {
    await setDoc(doc(db, 'omikujiUsers', currentEditUid), payload, { merge: true });
    await setDoc(doc(db, 'sharedUserRoles', currentEditUid), {
      role,
      debugConnect: role === 'debugger' && debugConnect,
      debugOmikuji: role === 'debugger' && debugOmikuji,
      updatedAt: serverTimestamp(),
    });
    if (role === 'debugger' && debugConnect) {
      await grantConnectDebugAchievement(currentEditUid);
    }
    msgEl.textContent = '保存しました。';
    msgEl.classList.remove('error');
    msgEl.classList.add('ok');
  } catch (e) {
    msgEl.textContent = `保存に失敗しました（${e.code || e.message}）`;
    msgEl.classList.add('error');
  }
});

// コネクトバトルのデバッグ権限を付与した相手に「デバッグ担当」実績を付与する。
// 一度付いたら、後でデバッガーを解除しても実績は消さない(ここでは追加しかしない)。
async function grantConnectDebugAchievement(sharedUserId) {
  const snap = await getDocs(query(collection(db, 'connectUsers'), where('sharedUserId', '==', sharedUserId)));
  for (const connectDoc of snap.docs) {
    const achievements = connectDoc.data().achievements || [];
    if (achievements.includes('debug_test')) continue;
    await setDoc(doc(db, 'connectUsers', connectDoc.id), {
      achievements: [...achievements, 'debug_test'],
    }, { merge: true });
  }
}

function setRadioValue(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((r) => { r.checked = r.value === value; });
}

function getRadioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value ?? '';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

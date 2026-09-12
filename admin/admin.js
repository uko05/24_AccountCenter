// admin.js
import { app, db } from '../firebaseConfig.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, updatePassword,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, addDoc, deleteDoc, deleteField, collection, query, where, orderBy, limit, getDocs, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const ACCOUNTS_LOAD_LIMIT = 100;
const ACCOUNTS_FETCH_LIMIT = 300;
import { ACHIEVEMENT_GROUPS, ALL_ACHIEVEMENTS } from "https://uko05.github.io/14_GenshinOmikuji/achievements.js";
import { ACHIEVEMENT_GROUPS as CONNECT10_ACHIEVEMENT_GROUPS } from "https://uko05.github.io/10_connect/public/scripts/achievements.js";
import { GACHA_DESIGNS } from "https://uko05.github.io/14_GenshinOmikuji/gachaBacks.js";
import { formatSavedAt } from '../saved-image.js';

const RARITY_BY_ID = new Map(ALL_ACHIEVEMENTS.map((a) => [a.id, a.rarity]));
const GACHA_DESIGN_BY_ID = new Map(GACHA_DESIGNS.map((d) => [d.id, d]));

// saved-image.js を使って画像を保存している「画像メーカー系」サイト一覧。
// savedProfileImages/{sharedUserId} は { [siteId]: {url, updatedAt} } という
// 1ドキュメントにまとまっているので、ここでは一覧表示するだけでよい。
const SAVED_IMAGE_SITES = [
  { id: 'genshinRanking', label: '推しキャラランキング【原神】' },
  { id: 'starrailRankingPath', label: '推しキャラランキング【スタレ・運命】' },
  { id: 'starrailRankingElement', label: '推しキャラランキング【スタレ・属性】' },
  { id: 'genshinCheck', label: '#原神チェックシート' },
  { id: 'starrailCheck', label: '#スタレチェックシート' },
  { id: 'genshinFreeFormat', label: '#原神フリーフォーマット' },
  { id: 'starrailFreeFormat', label: '#スタレフリーフォーマット' },
  { id: 'soukanzu', label: '相関図メーカー' },
  { id: 'bunpuzu', label: '分布図メーカー' },
  { id: 'randomSelect', label: 'ランダムピックシート' },
  { id: 'playMakerGenshin', label: '画面メーカー【原神】' },
  { id: 'playMakerStarrail', label: '画面メーカー【スタレ】' },
  { id: 'playMakerMajokai', label: '画面メーカー【魔女会】' },
];

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

// 固定UID、または sharedUserRoles で管理者ロールが付与されたアカウントを管理者として扱う（firestore.rulesと合わせること）
async function isEffectiveAdmin(user) {
  if (!user) return false;
  if (user.uid === ADMIN_UID) return true;
  try {
    const linkSnap = await getDoc(doc(db, 'accountLinks', user.uid));
    if (!linkSnap.exists() || !linkSnap.data().omikujiUserId) return false;
    const roleSnap = await getDoc(doc(db, 'sharedUserRoles', linkSnap.data().omikujiUserId));
    return roleSnap.exists() && roleSnap.data().role === 'admin';
  } catch {
    return false;
  }
}

onAuthStateChanged(auth, async (user) => {
  const isAdmin = await isEffectiveAdmin(user);
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

// ===== パスワード変更 =====
document.getElementById('change-pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newPw = document.getElementById('change-pw-new').value;
  const newPwConfirm = document.getElementById('change-pw-confirm').value;
  const msgEl = document.getElementById('change-pw-msg');
  msgEl.classList.remove('ok', 'error');

  if (newPw !== newPwConfirm) {
    msgEl.textContent = '確認用パスワードが一致しません。';
    msgEl.classList.add('error');
    return;
  }
  if (newPw.length < 6) {
    msgEl.textContent = 'パスワードは6文字以上にしてください。';
    msgEl.classList.add('error');
    return;
  }

  try {
    await updatePassword(auth.currentUser, newPw);
    msgEl.textContent = 'パスワードを変更しました。';
    msgEl.classList.add('ok');
    document.getElementById('change-pw-form').reset();
  } catch (err) {
    if (err.code === 'auth/requires-recent-login') {
      msgEl.textContent = 'セッションが古いため変更できません。一度ログアウトしてから、現在のパスワードで再ログインした直後にもう一度お試しください。';
    } else {
      msgEl.textContent = `変更に失敗しました（${err.code || err.message}）`;
    }
    msgEl.classList.add('error');
  }
});

// ===== メール配信（原神おみくじ・プレゼントボックス） =====
const MAIL_TARGET_LABELS = { all: '全員', role: '特定ロール', users: '特定の個人' };

function updateMailTargetVisibility() {
  const type = getRadioValue('mail-target-type') || 'all';
  document.getElementById('mail-target-role-group').classList.toggle('hidden', type !== 'role');
  document.getElementById('mail-target-users-group').classList.toggle('hidden', type !== 'users');
}
document.querySelectorAll('input[name="mail-target-type"]').forEach((r) => {
  r.addEventListener('change', updateMailTargetVisibility);
});
updateMailTargetVisibility();

// ===== メールの受け取り期限（デフォルト1か月後、無期限も選べる） =====
function setDefaultMailExpireDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  document.getElementById('mail-expire-date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function updateMailExpireVisibility() {
  const type = getRadioValue('mail-expire-type') || 'date';
  document.getElementById('mail-expire-date').disabled = type !== 'date';
}
document.querySelectorAll('input[name="mail-expire-type"]').forEach((r) => {
  r.addEventListener('change', updateMailExpireVisibility);
});
setDefaultMailExpireDate();
updateMailExpireVisibility();

document.getElementById('mail-broadcast-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const titleEl   = document.getElementById('mail-title');
  const messageEl = document.getElementById('mail-message');
  const ticketsEl = document.getElementById('mail-gacha-tickets');
  const usersEl   = document.getElementById('mail-target-users');
  const msgEl     = document.getElementById('mail-broadcast-msg');
  msgEl.classList.remove('ok', 'error');

  const title = titleEl.value.trim();
  const message = messageEl.value.trim();
  const gachaTickets = Math.max(0, Math.floor(Number(ticketsEl.value) || 0));
  const targetType = getRadioValue('mail-target-type') || 'all';
  const expireType = getRadioValue('mail-expire-type') || 'date';

  if (!title) {
    msgEl.textContent = 'タイトルを入力してください。';
    msgEl.classList.add('error');
    return;
  }

  let expiresAt = null;
  if (expireType === 'date') {
    const expireDateEl = document.getElementById('mail-expire-date');
    if (!expireDateEl.value) {
      msgEl.textContent = '受け取り期限の日付を入力してください（無期限にする場合は「無期限」を選んでください）。';
      msgEl.classList.add('error');
      return;
    }
    // その日の終わり(23:59:59)まで受け取り可能にする
    const [y, m, d] = expireDateEl.value.split('-').map(Number);
    expiresAt = Timestamp.fromDate(new Date(y, m - 1, d, 23, 59, 59));
  }

  let target = { type: 'all' };
  if (targetType === 'role') {
    target = { type: 'role', role: getRadioValue('mail-target-role') || 'general' };
  } else if (targetType === 'users') {
    const userIds = usersEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (userIds.length === 0) {
      msgEl.textContent = '対象UIDを1件以上入力してください。';
      msgEl.classList.add('error');
      return;
    }
    target = { type: 'users', userIds };
  }

  const targetDesc = target.type === 'all'
    ? '全員'
    : target.type === 'role'
      ? `ロール「${ROLE_LABELS[target.role] || target.role}」`
      : `指定した${target.userIds.length}人`;
  const expireDesc = expiresAt ? `${fmtTimestamp(expiresAt)}まで` : '無期限';
  if (!confirm(`「${title}」を${targetDesc}のメールボックスに配信します（受け取り期限：${expireDesc}）。よろしいですか？`)) return;

  // rewards は claimMail(feed.js)がドット区切りのフィールドパスへそのままincrementするための
  // 汎用形式。今はガチャ券のみだが、他の付与内容が増えても項目を足すだけで対応できる。
  const rewards = gachaTickets > 0
    ? [{ field: 'sitePerks.omikuji.gachaTickets', amount: gachaTickets }]
    : [];

  try {
    await addDoc(collection(db, 'omikujiMailBroadcasts'), {
      title, message, rewards, target, expiresAt, createdAt: serverTimestamp(),
    });
    msgEl.textContent = '配信しました。';
    msgEl.classList.add('ok');
    document.getElementById('mail-broadcast-form').reset();
    setDefaultMailExpireDate();
    updateMailTargetVisibility();
    updateMailExpireVisibility();
  } catch (err) {
    msgEl.textContent = `配信に失敗しました（${err.code || err.message}）`;
    msgEl.classList.add('error');
  }
});

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
let accountsSortKey = null;
let accountsSortDir = 1; // 1=昇順, -1=降順

const ROLE_LABELS = { general: '一般', debugger: 'デバッガー', admin: '管理者' };

// 列ごとに「ソート用の値(get)」と「セルの表示HTML(render)」を持たせる。
// renderを省略した列はgetの値をそのままエスケープして表示する。
const ACCOUNTS_SORT_COLUMNS = {
  name:      { label: '名前',         width: '20%',  get: (r) => r.u.name || '', render: (r) => escapeHtml(r.u.name || '(無記名)') },
  loginId:   { label: '登録ID',       width: '18%',  get: (r) => r.a.loginId || '', render: (r) => escapeHtml(r.a.loginId || '-') },
  role:      { label: 'ロール',       width: '1%',   get: (r) => r.a.role || 'general', render: (r) => escapeHtml(ROLE_LABELS[r.a.role] || r.a.role) },
  birthday:  { label: '誕生日',       width: '20%',  get: (r) => r.u.birthday || '', render: (r) => escapeHtml(r.u.birthday || '-') },
  updatedAt: { label: '最終更新日時', width: '1%',   get: (r) => r.u.updatedAt?.toMillis?.() ?? 0, render: (r) => fmtTimestamp(r.u.updatedAt) },
  bronze:    { label: '銅',           width: '1%',   get: (r) => r.counts.bronze },
  silver:    { label: '銀',           width: '1%',   get: (r) => r.counts.silver },
  gold:      { label: '金',           width: '1%',   get: (r) => r.counts.gold },
  legend:    { label: '虹',           width: '1%',   get: (r) => r.counts.legend },
  given:     { label: 'アゲ',         width: '1%',   get: (r) => r.u.totalLikesGiven ?? 0 },
  received:  { label: 'モラ',         width: '1%',   get: (r) => r.u.totalLikesReceived ?? 0 },
  savedImages: {
    label: '画像保存', width: '1%',
    get: (r) => (r.hasSavedImages ? 1 : 0),
    render: (r) => (r.hasSavedImages ? '✅' : ''),
  },
};

// 表示する列の選択状態(この管理画面を開いているブラウザだけのローカル設定)。
// 列が増えて表が窮屈になってきたため、使わない列を個別に隠せるようにしてある。
const ACCOUNTS_VISIBLE_COLS_KEY = 'adminAccountsVisibleColumns';
function loadVisibleColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNTS_VISIBLE_COLS_KEY) || '{}');
    const result = {};
    Object.keys(ACCOUNTS_SORT_COLUMNS).forEach((key) => { result[key] = saved[key] !== false; });
    return result;
  } catch (e) {
    const result = {};
    Object.keys(ACCOUNTS_SORT_COLUMNS).forEach((key) => { result[key] = true; });
    return result;
  }
}
function saveVisibleColumns(cols) {
  try { localStorage.setItem(ACCOUNTS_VISIBLE_COLS_KEY, JSON.stringify(cols)); } catch (e) {}
}
let accountsVisibleColumns = loadVisibleColumns();

const columnTogglesEl = document.getElementById('accounts-column-toggles');
function renderColumnToggles() {
  columnTogglesEl.innerHTML = Object.entries(ACCOUNTS_SORT_COLUMNS).map(([key, col]) => `
    <label style="display:inline-flex; align-items:center; gap:4px; font-size:0.82rem;">
      <input type="checkbox" data-col-key="${key}" ${accountsVisibleColumns[key] ? 'checked' : ''}>
      ${escapeHtml(col.label)}
    </label>
  `).join('');
  columnTogglesEl.querySelectorAll('input[data-col-key]').forEach((cb) => {
    cb.addEventListener('change', () => {
      accountsVisibleColumns[cb.dataset.colKey] = cb.checked;
      saveVisibleColumns(accountsVisibleColumns);
      renderAccounts(accountsFilterEl.value);
    });
  });
}
renderColumnToggles();

document.getElementById('reload-accounts-btn').addEventListener('click', loadAccounts);
accountsFilterEl.addEventListener('input', () => renderAccounts(accountsFilterEl.value));
accountsFilterRegisteredEl.addEventListener('change', () => renderAccounts(accountsFilterEl.value));
accountsFilterUnregisteredEl.addEventListener('change', () => renderAccounts(accountsFilterEl.value));

async function loadAccounts() {
  accountsListEl.innerHTML = '読み込み中…';

  // 1度もおみくじを引いたことがない(achStats.totalCountが0)人を除外した上で100件にしたいので、
  // 多めに取得してからフィルタ・切り詰める(除外分を考慮した複合インデックス作成を避けるため)。
  const [usersSnap, linkSnap, roleSnap, savedImagesSnap] = await Promise.all([
    getDocs(query(collection(db, 'omikujiUsers'), orderBy('updatedAt', 'desc'), limit(ACCOUNTS_FETCH_LIMIT))),
    getDocs(collection(db, 'accountLinks')),
    getDocs(collection(db, 'sharedUserRoles')),
    getDocs(collection(db, 'savedProfileImages')),
  ]);

  const linkByOmikujiId = new Map();
  linkSnap.docs.forEach((linkDoc) => {
    const link = linkDoc.data();
    if (link.omikujiUserId) linkByOmikujiId.set(link.omikujiUserId, { ...link, authUid: linkDoc.id });
  });

  const roleByOmikujiId = new Map();
  roleSnap.docs.forEach((roleDoc) => roleByOmikujiId.set(roleDoc.id, roleDoc.data().role || 'general'));

  // savedProfileImages/{omikujiUserId}は{ [siteId]: {url, updatedAt} }なので、
  // 一覧では「1つでも画像メーカー系サイトに保存しているか」だけ列で見せる
  // (サイトごとの内訳は個別編集画面の「画像メーカー」タブで見られるため)。
  const hasSavedImagesSet = new Set();
  savedImagesSnap.docs.forEach((d) => {
    if (Object.keys(d.data() || {}).length > 0) hasSavedImagesSet.add(d.id);
  });

  allAccounts = usersSnap.docs
    .filter((userDoc) => (userDoc.data().achStats?.totalCount || 0) > 0)
    .slice(0, ACCOUNTS_LOAD_LIMIT)
    .map((userDoc) => {
      const link = linkByOmikujiId.get(userDoc.id);
      return {
        omikujiUserId: userDoc.id,
        authUid: link?.authUid || null,
        loginId: link?.loginId || '',
        isRegistered: !!link,
        role: roleByOmikujiId.get(userDoc.id) || 'general',
        omikujiData: userDoc.data(),
        hasSavedImages: hasSavedImagesSet.has(userDoc.id),
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

  let rows = filtered.map((a) => ({
    a, u: a.omikujiData, counts: countByRarity(a.omikujiData.achievements), hasSavedImages: a.hasSavedImages,
  }));

  if (accountsSortKey) {
    const getter = ACCOUNTS_SORT_COLUMNS[accountsSortKey].get;
    rows = rows.slice().sort((x, y) => {
      const vx = getter(x), vy = getter(y);
      if (vx < vy) return -1 * accountsSortDir;
      if (vx > vy) return 1 * accountsSortDir;
      return 0;
    });
  }

  const sortArrow = (key) => (accountsSortKey === key ? (accountsSortDir === 1 ? ' ▲' : ' ▼') : '');
  const visibleColumnEntries = Object.entries(ACCOUNTS_SORT_COLUMNS).filter(([key]) => accountsVisibleColumns[key]);
  const headerCells = visibleColumnEntries.map(([key, col]) => `
    <th data-sort-key="${key}" style="width:${col.width}; white-space:nowrap; cursor:pointer; user-select:none;">${col.label}${sortArrow(key)}</th>
  `).join('');

  const table = document.createElement('table');
  table.className = 'user-table';
  table.innerHTML = `
    <thead>
      <tr>
        ${headerCells}
        <th style="width:1%; white-space:nowrap;"></th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  rows.forEach((row) => {
    const { a, u } = row;
    const tr = document.createElement('tr');
    const actionBtnStyle = 'width:auto; display:inline-block; box-sizing:border-box; padding:4px 12px; font-size:0.74rem; font-weight:normal; line-height:1.4; border-radius:20px;';
    const dataCells = visibleColumnEntries.map(([key, col]) => `
      <td style="white-space:nowrap;">${col.render ? col.render(row) : escapeHtml(String(col.get(row)))}</td>
    `).join('');
    const actionsCell = `
      <td style="white-space:nowrap;">
        <button class="primary-btn" style="${actionBtnStyle}" data-action="edit">編集</button>
      </td>
    `;
    tr.innerHTML = dataCells + actionsCell;
    tr.querySelector('[data-action="edit"]').addEventListener('click', () => openEditor(a.omikujiUserId, u, a));
    tbody.appendChild(tr);
  });

  table.querySelectorAll('th[data-sort-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (accountsSortKey === key) {
        accountsSortDir *= -1;
      } else {
        accountsSortKey = key;
        accountsSortDir = 1;
      }
      renderAccounts(accountsFilterEl.value);
    });
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
let currentEditUid     = null;
let currentEditData    = null;
let currentEditAccount = null;
let currentConnect10DocId = null;

// ===== 編集フォームのタブ切り替え =====
function switchEditTab(tabKey) {
  document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabKey);
  });
  document.querySelectorAll('.admin-tab-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.tabPanel !== tabKey);
  });
}
document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchEditTab(btn.dataset.tab));
});

async function openEditor(uid, data, account = null) {
  currentEditUid = uid;
  currentEditData = data;
  currentEditAccount = account;
  currentConnect10DocId = null;
  switchEditTab('basic');

  document.getElementById('unregister-btn').classList.toggle('hidden', !account?.isRegistered);

  document.getElementById('edit-uid').textContent = uid;
  document.getElementById('edit-name').value = data.name || '';
  document.getElementById('edit-birthday').value = data.birthday || '';
  setRadioValue('edit-gender', data.gender || '');
  setRadioValue('edit-lang', data.lang || 'ja');
  document.getElementById('edit-total-count').value = data.achStats?.totalCount ?? 0;
  document.getElementById('edit-max-streak').value = data.achStats?.maxStreak ?? 0;
  document.getElementById('edit-likes-received').value = data.totalLikesReceived ?? 0;
  document.getElementById('edit-likes-given').value = data.totalLikesGiven ?? 0;
  document.getElementById('edit-collection').value = (data.collection || []).join('\n');
  renderEquippedCardBack(data.equippedCardBackId);

  document.getElementById('edit-uko-points').value = data.ukoPoints ?? 0;
  const perks = data.sitePerks || {};
  document.getElementById('edit-perk-chat-bonus').value = perks.friendBoard?.permanentExtraChat ?? 0;
  document.getElementById('perk-ach-setting').checked = !!perks.accountCenter?.achievementSettingUnlocked;
  document.getElementById('perk-title-regular').checked = !!perks.accountCenter?.titleRegularUnlocked;
  document.getElementById('perk-title-up-champion').checked = !!perks.accountCenter?.titleUpChampionUnlocked;
  document.getElementById('perk-ach-display').checked = !!perks.omikuji?.achievementDisplayUnlocked;
  document.getElementById('perk-title-fate-observer').checked = !!perks.omikuji?.titleFateObserverUnlocked;

  const badge = data.equippedBadge;
  document.getElementById('edit-equipped-badge-display').textContent = badge
    ? `${badge.name}（${badge.rarity || 'bronze'} / ${badge.site}）`
    : '未設定';
  document.getElementById('edit-clear-badge').checked = false;

  renderAchievementCheckboxesInto('edit-achievements', ACHIEVEMENT_GROUPS, new Set(data.achievements || []));

  const notFoundMsg = document.getElementById('connect10-not-found-msg');
  const connect10Snap = await getDocs(query(collection(db, 'connectUsers'), where('sharedUserId', '==', uid)));
  if (!connect10Snap.empty) {
    currentConnect10DocId = connect10Snap.docs[0].id;
    notFoundMsg.classList.add('hidden');
    renderAchievementCheckboxesInto('edit-connect10-achievements', CONNECT10_ACHIEVEMENT_GROUPS, new Set(connect10Snap.docs[0].data().achievements || []));
  } else {
    notFoundMsg.classList.remove('hidden');
    document.getElementById('edit-connect10-achievements').innerHTML = '';
  }

  const savedImagesSnap = await getDoc(doc(db, 'savedProfileImages', uid));
  renderSavedImages(savedImagesSnap.exists() ? savedImagesSnap.data() : {});

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

// 原神おみくじ・コネクトバトルどちらの実績一覧も同じ形(groups[].items[].{id,name,condition})
// なので、対象のコンテナと実績グループを渡すだけで両方に使い回せるようにしている。
function renderAchievementCheckboxesInto(containerId, groups, achievedSet) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  groups.forEach((group) => {
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

// 現在使用中の裏面デザイン(gachaBacks.jsのGACHA_DESIGNSと突き合わせてサムネ表示)。
// equippedCardBackIdが未設定(null)なら通常のback.png扱いなので、その旨を表示するだけでよい。
function renderEquippedCardBack(equippedCardBackId) {
  const container = document.getElementById('edit-equipped-cardback-display');
  if (!container) return;
  if (!equippedCardBackId) {
    container.innerHTML = '通常（未設定）';
    return;
  }
  const design = GACHA_DESIGN_BY_ID.get(equippedCardBackId);
  if (!design) {
    container.innerHTML = escapeHtml(`不明なID: ${equippedCardBackId}`);
    return;
  }
  container.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px;">
      <img src="${escapeHtml(design.url)}" alt="${escapeHtml(design.name)}" style="width:60px; border-radius:8px; border:1px solid var(--border); display:block;">
      <span>${escapeHtml(design.name)}</span>
    </div>
  `;
}

// savedProfileImages/{uid} は { [siteId]: {url, updatedAt} } という1ドキュメントに
// 全サイト分まとまっているので、SAVED_IMAGE_SITES一覧に沿って並べるだけでよい
// (削除機能は無し。閲覧専用)。
function renderSavedImages(savedImagesData) {
  const container = document.getElementById('edit-saved-images');
  const emptyMsg = document.getElementById('saved-images-empty-msg');
  container.innerHTML = '';

  const entries = SAVED_IMAGE_SITES
    .map((site) => ({ site, entry: savedImagesData[site.id] }))
    .filter(({ entry }) => entry && entry.url);

  emptyMsg.classList.toggle('hidden', entries.length > 0);

  entries.forEach(({ site, entry }) => {
    const card = document.createElement('div');
    card.style.cssText = 'width:160px;';
    card.innerHTML = `
      <img src="${escapeHtml(entry.url)}" alt="${escapeHtml(site.label)}" style="width:100%; border-radius:8px; border:1px solid var(--border); display:block;">
      <p style="font-size:0.78rem; font-weight:bold; margin-top:6px;">${escapeHtml(site.label)}</p>
      <p style="font-size:0.72rem; color:var(--muted);">${escapeHtml(formatSavedAt(entry.updatedAt))}</p>
    `;
    container.appendChild(card);
  });
}

document.getElementById('cancel-edit-btn').addEventListener('click', () => {
  editSection.classList.add('hidden');
  currentEditUid = null;
  currentEditData = null;
  currentEditAccount = null;
  currentConnect10DocId = null;
});

document.getElementById('unregister-btn').addEventListener('click', async () => {
  if (!currentEditAccount) return;
  await deleteAccountLink(currentEditAccount);
  editSection.classList.add('hidden');
  currentEditUid = null;
  currentEditData = null;
  currentEditAccount = null;
  currentConnect10DocId = null;
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
    totalLikesReceived: Number(document.getElementById('edit-likes-received').value) || 0,
    totalLikesGiven: Number(document.getElementById('edit-likes-given').value) || 0,
    ukoPoints: Number(document.getElementById('edit-uko-points').value) || 0,
    // sitePerksは他にも今後増えていくフィールドなので、ここに無いキーを
    // うっかり消さないようドット区切りのフィールドパスで1つずつ更新する
    // (nested objectをまるごと渡すとsitePerks全体を上書きしてしまうため)。
    'sitePerks.friendBoard.permanentExtraChat': Number(document.getElementById('edit-perk-chat-bonus').value) || 0,
    'sitePerks.accountCenter.achievementSettingUnlocked': document.getElementById('perk-ach-setting').checked,
    'sitePerks.accountCenter.titleRegularUnlocked': document.getElementById('perk-title-regular').checked,
    'sitePerks.accountCenter.titleUpChampionUnlocked': document.getElementById('perk-title-up-champion').checked,
    'sitePerks.omikuji.achievementDisplayUnlocked': document.getElementById('perk-ach-display').checked,
    'sitePerks.omikuji.titleFateObserverUnlocked': document.getElementById('perk-title-fate-observer').checked,
    updatedAt: serverTimestamp(),
  };

  if (document.getElementById('edit-clear-badge').checked) {
    payload.equippedBadge = deleteField();
  }

  const role = getRadioValue('edit-role') || 'general';
  const debugConnect = document.getElementById('edit-debug-connect').checked;
  const debugOmikuji = document.getElementById('edit-debug-omikuji').checked;

  const connect10Achievements = Array.from(
    document.querySelectorAll('#edit-connect10-achievements input[type="checkbox"]:checked'),
  ).map((el) => el.value);

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
    if (currentConnect10DocId) {
      await setDoc(doc(db, 'connectUsers', currentConnect10DocId), { achievements: connect10Achievements }, { merge: true });
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

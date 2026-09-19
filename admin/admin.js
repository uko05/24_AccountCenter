// admin.js
import { app, db } from '../firebaseConfig.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, updatePassword,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, deleteField, collection, collectionGroup, query, where, orderBy, limit, getDocs, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// 一覧は件数無制限で全件取得し、表示だけこの件数単位でページ分割する
// (1ページに全件出すと縦に長くなりすぎるため)。
const ACCOUNTS_PAGE_SIZE = 100;
import { ACHIEVEMENT_GROUPS, ALL_ACHIEVEMENTS } from "https://uko05.github.io/14_GenshinOmikuji/achievements.js";
import { ACHIEVEMENT_GROUPS as CONNECT10_ACHIEVEMENT_GROUPS } from "https://uko05.github.io/10_connect/public/scripts/achievements.js";
import { GACHA_DESIGNS } from "https://uko05.github.io/14_GenshinOmikuji/gachaBacks.js";
import { VISIBILITY_FIELDS, fieldLabel, formatFieldValue } from "https://uko05.github.io/25_FriendBoard/fields.js";
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

// cardBacksは新形式{デザインID: 所持数}だが、omikuji側のuserData.jsと同様、
// 旧形式(所持デザインIDの配列)がまだ残っている場合に備えて正規化する。
function normalizeCardBacks(cardBacks) {
  if (!cardBacks) return {};
  if (Array.isArray(cardBacks)) {
    const result = {};
    cardBacks.forEach((id) => { result[id] = 1; });
    return result;
  }
  return cardBacks;
}

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
    loadAuctionHistory();
    loadLikeUpHistory();
    loadUpLogHistory();
    loadCampaigns();
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

// ===== オークション履歴（落札成立分のみ。流札(unsold)は対象外） =====
const auctionHistoryListEl = document.getElementById('auction-history-list');
const auctionHistoryCountEl = document.getElementById('auction-history-count');
const auctionHistoryFilterEl = document.getElementById('auction-history-filter');
const auctionHistoryFilterBidEl = document.getElementById('auction-history-filter-bid');
const auctionHistoryFilterBuyNowEl = document.getElementById('auction-history-filter-buynow');
const AUCTION_HISTORY_FETCH_LIMIT = 200;
const AUCTION_SOLD_VIA_LABELS = { bid: '入札', buyNow: '即決購入' };
// 取得済みの履歴をここに保持し、絞り込みはこの配列をその場でフィルターするだけ
// (通信は発生しない。ユーザー一覧セクションと同じ方式)。
let latestAuctionHistory = [];
// 列名クリックでのソート状態(ユーザー一覧セクションのaccountsSortKey/Dirと同じ方式)。
let auctionHistorySortKey = null;
let auctionHistorySortDir = 1; // 1=昇順, -1=降順
// 列定義: key(データ属性・ソートキーに使う)/label(見出し)/get(row)(ソート用の比較値)。
// rowはitem本体に加え、解決済みのsellerName/buyerName/soldViaLabelを持たせたもの
// (毎回lookupOmikujiNameを呼び直さずソート・表示の両方で使い回すため)。
const AUCTION_HISTORY_SORT_COLUMNS = {
  itemName: { label: 'アイテム', get: (r) => (r.item.itemName || r.item.itemId || '').toLowerCase() },
  sellerName: { label: '出品者', get: (r) => r.sellerName.toLowerCase() },
  buyerName: { label: '落札者', get: (r) => r.buyerName.toLowerCase() },
  soldPrice: { label: '価格', get: (r) => r.item.soldPrice ?? 0 },
  soldVia: { label: '方式', get: (r) => r.soldViaLabel },
  soldAt: { label: '落札日時', get: (r) => r.item.soldAt?.toMillis?.() ?? 0 },
};

document.getElementById('reload-auction-history-btn')?.addEventListener('click', loadAuctionHistory);
auctionHistoryFilterEl?.addEventListener('input', renderAuctionHistory);
auctionHistoryFilterBidEl?.addEventListener('change', renderAuctionHistory);
auctionHistoryFilterBuyNowEl?.addEventListener('change', renderAuctionHistory);

async function loadAuctionHistory() {
  if (!auctionHistoryListEl) return;
  auctionHistoryListEl.innerHTML = '読み込み中…';
  try {
    const snap = await getDocs(query(
      collection(db, 'ukoMarketListings'),
      where('status', '==', 'sold'),
      orderBy('soldAt', 'desc'),
      limit(AUCTION_HISTORY_FETCH_LIMIT),
    ));
    latestAuctionHistory = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAuctionHistory();
  } catch (e) {
    console.error('[admin] auction history load failed', e);
    auctionHistoryListEl.innerHTML = '読み込みに失敗しました。';
  }
}

// 落札者(soldTo)はomikuji IDしか出品ドキュメントに残っていないため、既に読み込み済みの
// allAccounts(ユーザー一覧)から名前を逆引きする(未取得なら諦めてIDをそのまま出す)。
function lookupOmikujiName(omikujiUserId) {
  const account = allAccounts.find((a) => a.omikujiUserId === omikujiUserId);
  return account?.omikujiData?.name || omikujiUserId || '';
}

// オークション履歴の出品者/落札者名クリック用: 下のユーザー一覧セクションと同じ
// openEditor()を呼んで詳細を開く(scrollIntoViewも既存の挙動のまま活きる)。
// allAccountsはachStats.totalCount>0のユーザーだけなので(loadAccounts参照)、
// 実績0件のユーザーがオークションに関わっているレアケースに備えてFirestoreへの
// 直接フォールバックも用意しておく。
async function openEditorByOmikujiId(omikujiUserId) {
  if (!omikujiUserId) return;
  const account = allAccounts.find((a) => a.omikujiUserId === omikujiUserId);
  if (account) {
    openEditor(account.omikujiUserId, account.omikujiData, account);
    return;
  }
  const snap = await getDoc(doc(db, 'omikujiUsers', omikujiUserId));
  if (snap.exists()) {
    openEditor(snap.id, snap.data());
  } else {
    alert('ユーザー情報が見つかりませんでした。');
  }
}

// アイテム名・出品者名・落札者名の部分一致(大文字小文字区別なし)と、方式
// (入札/即決購入)のチェックボックスを組み合わせてlatestAuctionHistoryを絞り込む。
// 列名クリックでのソートにも対応(AUCTION_HISTORY_SORT_COLUMNS参照)。
function renderAuctionHistory() {
  const keyword = (auctionHistoryFilterEl?.value || '').trim().toLowerCase();
  const showBid = auctionHistoryFilterBidEl ? auctionHistoryFilterBidEl.checked : true;
  const showBuyNow = auctionHistoryFilterBuyNowEl ? auctionHistoryFilterBuyNowEl.checked : true;

  // sellerName/buyerNameはlookupOmikujiNameの呼び直しを避けるため、フィルター・
  // ソート・表示のどの段階でも使い回せるようここで1回だけ解決しておく。
  let rows = latestAuctionHistory.map((item) => ({
    item,
    sellerName: item.sellerName || lookupOmikujiName(item.sellerId),
    buyerName: lookupOmikujiName(item.soldTo),
    soldViaLabel: AUCTION_SOLD_VIA_LABELS[item.soldVia] || item.soldVia || '',
  })).filter((r) => {
    if (r.item.soldVia === 'bid' && !showBid) return false;
    if (r.item.soldVia === 'buyNow' && !showBuyNow) return false;
    if (!keyword) return true;
    const haystack = `${r.item.itemName || r.item.itemId || ''} ${r.sellerName} ${r.buyerName}`.toLowerCase();
    return haystack.includes(keyword);
  });

  if (auctionHistorySortKey) {
    const getter = AUCTION_HISTORY_SORT_COLUMNS[auctionHistorySortKey].get;
    rows = rows.slice().sort((x, y) => {
      const vx = getter(x), vy = getter(y);
      if (vx < vy) return -1 * auctionHistorySortDir;
      if (vx > vy) return 1 * auctionHistorySortDir;
      return 0;
    });
  }

  if (auctionHistoryCountEl) {
    const totalLabel = latestAuctionHistory.length >= AUCTION_HISTORY_FETCH_LIMIT
      ? `直近${AUCTION_HISTORY_FETCH_LIMIT}件中`
      : `${latestAuctionHistory.length}件中`;
    auctionHistoryCountEl.textContent = `${totalLabel}${rows.length}件を表示`;
  }

  if (!auctionHistoryListEl) return;
  if (rows.length === 0) {
    auctionHistoryListEl.innerHTML = latestAuctionHistory.length === 0
      ? '落札履歴はまだありません。'
      : '条件に一致する履歴がありません。';
    return;
  }

  const sortArrow = (key) => (auctionHistorySortKey === key ? (auctionHistorySortDir === 1 ? ' ▲' : ' ▼') : '');
  const headerCells = Object.entries(AUCTION_HISTORY_SORT_COLUMNS).map(([key, col]) => `
    <th data-sort-key="${key}" style="white-space:nowrap; cursor:pointer; user-select:none;">${col.label}${sortArrow(key)}</th>
  `).join('');

  const table = document.createElement('table');
  table.className = 'user-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width:1%;"></th>
        ${headerCells}
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  // 出品者/落札者は名前が長いと方式・日時列を押し出して見えなくなるため、
  // 最大幅+省略記号で切り詰める(フルネームはtitle属性でホバー時に確認できる)。
  const nameCellStyle = 'white-space:nowrap; max-width:90px; overflow:hidden; text-overflow:ellipsis;';

  // 出品者/落札者名はクリックで下のユーザー一覧セクションの詳細編集を開けるように
  // リンク風にする(openEditorByOmikujiId)。IDが無い(古いデータ等)場合はただのテキスト。
  const userLinkStyle = 'cursor:pointer; color:#2a6fdb; text-decoration:underline;';
  const userLinkCell = (name, omikujiId) => (omikujiId
    ? `<span class="admin-user-link" data-omikuji-id="${escapeHtml(omikujiId)}" style="${userLinkStyle}">${escapeHtml(name)}</span>`
    : escapeHtml(name));

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.item.itemImageUrl ? `<img src="${escapeHtml(r.item.itemImageUrl)}" alt="" data-zoomable="${escapeHtml(r.item.itemImageUrl)}" style="width:36px; height:36px; object-fit:cover; border-radius:4px; display:block;">` : ''}</td>
      <td style="white-space:nowrap;">${escapeHtml(r.item.itemName || r.item.itemId || '')}</td>
      <td style="${nameCellStyle}" title="${escapeHtml(r.sellerName)}">${userLinkCell(r.sellerName, r.item.sellerId)}</td>
      <td style="${nameCellStyle}" title="${escapeHtml(r.buyerName)}">${userLinkCell(r.buyerName, r.item.soldTo)}</td>
      <td style="white-space:nowrap;">${r.item.soldPrice ?? ''}UP</td>
      <td style="white-space:nowrap;">${escapeHtml(r.soldViaLabel)}</td>
      <td style="white-space:nowrap;">${escapeHtml(formatSavedAt(r.item.soldAt))}</td>
    `;
    tbody.appendChild(tr);
  });

  table.querySelectorAll('[data-omikuji-id]').forEach((el) => {
    el.addEventListener('click', () => openEditorByOmikujiId(el.dataset.omikujiId));
  });

  table.querySelectorAll('th[data-sort-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (auctionHistorySortKey === key) {
        auctionHistorySortDir *= -1;
      } else {
        auctionHistorySortKey = key;
        auctionHistorySortDir = 1;
      }
      renderAuctionHistory();
    });
  });

  auctionHistoryListEl.innerHTML = '';
  auctionHistoryListEl.appendChild(table);
  enableThumbnailZoom(auctionHistoryListEl);
}

// ===== UP取得履歴（いいね、2026-09-19追加） =====
// omikujiFeed/{feedId}/likes/{likerUserId}をcollectionGroupで横断取得する。1件=1いいねの
// 生ログのままだと量が多く見づらいので、「誰が・どちら方向(あげた/もらった)で・何日に」
// 何件、合計何UP動いたかにまとめてから表示する(自演いいね連発やいつもと違う相手からの
// 集中いいねのような不自然な偏りを見つけやすくする狙い。買い切り即決の自演発覚と同じ
// 動機、[[project_uko_auction]]参照)。
const LIKE_UP_HISTORY_FETCH_LIMIT = 500;
const likeUpHistoryListEl = document.getElementById('like-up-history-list');
const likeUpHistoryCountEl = document.getElementById('like-up-history-count');
const likeUpHistoryFilterEl = document.getElementById('like-up-history-filter');
const likeUpHistoryFilterGivenEl = document.getElementById('like-up-history-filter-given');
const likeUpHistoryFilterReceivedEl = document.getElementById('like-up-history-filter-received');
const LIKE_UP_DIRECTION_LABELS = { given: 'あげた（アゲ）', received: 'もらった（モラ）' };
let latestLikeDocs = [];
let likeUpHistorySortKey = 'latestAt';
let likeUpHistorySortDir = -1; // 1=昇順, -1=降順
const LIKE_UP_HISTORY_SORT_COLUMNS = {
  userName:  { label: '名前',   get: (r) => r.userName.toLowerCase() },
  direction: { label: '方向',   get: (r) => LIKE_UP_DIRECTION_LABELS[r.direction] },
  count:     { label: '件数',   get: (r) => r.count },
  totalUp:   { label: '合計UP', get: (r) => r.totalUp },
  day:       { label: '日付',   get: (r) => r.day },
  latestAt:  { label: '最新',   get: (r) => r.latestAtMs },
};

document.getElementById('reload-like-up-history-btn')?.addEventListener('click', loadLikeUpHistory);
likeUpHistoryFilterEl?.addEventListener('input', renderLikeUpHistory);
likeUpHistoryFilterGivenEl?.addEventListener('change', renderLikeUpHistory);
likeUpHistoryFilterReceivedEl?.addEventListener('change', renderLikeUpHistory);

async function loadLikeUpHistory() {
  if (!likeUpHistoryListEl) return;
  likeUpHistoryListEl.innerHTML = '読み込み中…';
  try {
    const snap = await getDocs(query(
      collectionGroup(db, 'likes'),
      orderBy('likedAt', 'desc'),
      limit(LIKE_UP_HISTORY_FETCH_LIMIT),
    ));
    latestLikeDocs = snap.docs.map((d) => d.data());
    renderLikeUpHistory();
  } catch (e) {
    console.error('[admin] like history load failed', e);
    likeUpHistoryListEl.innerHTML = '読み込みに失敗しました。';
  }
}

// ローカル日付(YYYY-MM-DD)・ユーザー・方向ごとに集計する。giveAmount/receiveAmountは
// 2026-09-19の時限ブースト機能追加時に付けたフィールドなので、それより前のいいねには
// 無い(その場合は基準値の1/2とみなす)。receiverUserIdも同時期の追加なので、それより前の
// いいねはreceiver側の集計に出てこない(集計不能。件数として無視する)。
function aggregateLikeUpHistory() {
  const groups = new Map();
  latestLikeDocs.forEach((d) => {
    const likedAtMs = d.likedAt?.toMillis?.() || 0;
    if (!likedAtMs) return;
    const dayStr = new Date(likedAtMs).toLocaleDateString('sv-SE'); // YYYY-MM-DD
    [
      { userId: d.likerUserId, direction: 'given', amount: d.giveAmount ?? 1 },
      { userId: d.receiverUserId, direction: 'received', amount: d.receiveAmount ?? 2 },
    ].forEach(({ userId, direction, amount }) => {
      if (!userId) return;
      const key = `${userId}_${direction}_${dayStr}`;
      const g = groups.get(key) || { userId, direction, day: dayStr, count: 0, totalUp: 0, latestAtMs: 0 };
      g.count += 1;
      g.totalUp += amount;
      g.latestAtMs = Math.max(g.latestAtMs, likedAtMs);
      groups.set(key, g);
    });
  });
  return [...groups.values()];
}

function renderLikeUpHistory() {
  const keyword = (likeUpHistoryFilterEl?.value || '').trim().toLowerCase();
  const showGiven = likeUpHistoryFilterGivenEl ? likeUpHistoryFilterGivenEl.checked : true;
  const showReceived = likeUpHistoryFilterReceivedEl ? likeUpHistoryFilterReceivedEl.checked : true;

  const grouped = aggregateLikeUpHistory();
  let rows = grouped.map((g) => ({ ...g, userName: lookupOmikujiName(g.userId) })).filter((r) => {
    if (r.direction === 'given' && !showGiven) return false;
    if (r.direction === 'received' && !showReceived) return false;
    if (!keyword) return true;
    return r.userName.toLowerCase().includes(keyword);
  });

  const getter = LIKE_UP_HISTORY_SORT_COLUMNS[likeUpHistorySortKey].get;
  rows = rows.slice().sort((x, y) => {
    const vx = getter(x), vy = getter(y);
    if (vx < vy) return -1 * likeUpHistorySortDir;
    if (vx > vy) return 1 * likeUpHistorySortDir;
    return 0;
  });

  if (likeUpHistoryCountEl) {
    const totalLabel = latestLikeDocs.length >= LIKE_UP_HISTORY_FETCH_LIMIT
      ? `直近${LIKE_UP_HISTORY_FETCH_LIMIT}件のいいねを`
      : `${latestLikeDocs.length}件のいいねを`;
    likeUpHistoryCountEl.textContent = `${totalLabel}${grouped.length}行に集計、うち${rows.length}行を表示`;
  }

  if (!likeUpHistoryListEl) return;
  if (rows.length === 0) {
    likeUpHistoryListEl.innerHTML = latestLikeDocs.length === 0
      ? 'いいねの履歴はまだありません。'
      : '条件に一致する履歴がありません。';
    return;
  }

  const sortArrow = (key) => (likeUpHistorySortKey === key ? (likeUpHistorySortDir === 1 ? ' ▲' : ' ▼') : '');
  const headerCells = Object.entries(LIKE_UP_HISTORY_SORT_COLUMNS).map(([key, col]) => `
    <th data-sort-key="${key}" style="white-space:nowrap; cursor:pointer; user-select:none;">${col.label}${sortArrow(key)}</th>
  `).join('');

  const table = document.createElement('table');
  table.className = 'user-table';
  table.innerHTML = `<thead><tr>${headerCells}</tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  const nameCellStyle = 'white-space:nowrap; max-width:120px; overflow:hidden; text-overflow:ellipsis;';

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="${nameCellStyle}" title="${escapeHtml(r.userName)}">
        <span class="admin-user-link" data-omikuji-id="${escapeHtml(r.userId)}" style="cursor:pointer; color:#2a6fdb; text-decoration:underline;">${escapeHtml(r.userName)}</span>
      </td>
      <td style="white-space:nowrap;">${escapeHtml(LIKE_UP_DIRECTION_LABELS[r.direction] || r.direction)}</td>
      <td style="white-space:nowrap;">${r.count}件</td>
      <td style="white-space:nowrap;">${r.totalUp}UP</td>
      <td style="white-space:nowrap;">${escapeHtml(r.day)}</td>
      <td style="white-space:nowrap;">${escapeHtml(fmtTimestamp(r.latestAtMs))}</td>
    `;
    tbody.appendChild(tr);
  });

  table.querySelectorAll('[data-omikuji-id]').forEach((el) => {
    el.addEventListener('click', () => openEditorByOmikujiId(el.dataset.omikujiId));
  });

  table.querySelectorAll('th[data-sort-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (likeUpHistorySortKey === key) {
        likeUpHistorySortDir *= -1;
      } else {
        likeUpHistorySortKey = key;
        likeUpHistorySortDir = 1;
      }
      renderLikeUpHistory();
    });
  });

  likeUpHistoryListEl.innerHTML = '';
  likeUpHistoryListEl.appendChild(table);
}

// ===== UP取得履歴（オークション・ミッション、2026-09-19追加） =====
// ukoPointsLog(26_UkoAuction/14_GenshinOmikuji/08_UPointがukoPointsを増やす
// トランザクションと同時に書き込む監査ログ)をそのまま一覧表示する。いいねと違って
// 件数がそこまで多くないので、集計せず1件=1行のまま出す(UP取得履歴（いいね）とは対照的)。
const UP_LOG_HISTORY_FETCH_LIMIT = 300;
const upLogHistoryListEl = document.getElementById('up-log-history-list');
const upLogHistoryCountEl = document.getElementById('up-log-history-count');
const upLogHistoryFilterEl = document.getElementById('up-log-history-filter');
const UP_LOG_TYPE_LABELS = {
  auctionSale: 'オークション売上',
  auctionCashback: '落札キャッシュバック',
  auctionListingBonus: '出品ボーナス',
  missionClaim: 'ミッション報酬',
};
const upLogTypeFilterEls = Object.fromEntries(
  Object.keys(UP_LOG_TYPE_LABELS).map((type) => [type, document.getElementById(`up-log-history-filter-${type}`)])
);
let latestUpLogDocs = [];
let upLogHistorySortKey = 'createdAt';
let upLogHistorySortDir = -1; // 1=昇順, -1=降順
const UP_LOG_HISTORY_SORT_COLUMNS = {
  userName:  { label: '名前',   get: (r) => r.userName.toLowerCase() },
  type:      { label: '種類',   get: (r) => UP_LOG_TYPE_LABELS[r.type] || r.type },
  amount:    { label: '金額',   get: (r) => r.amount },
  detail:    { label: '詳細',   get: (r) => r.detail },
  createdAt: { label: '日時',   get: (r) => r.createdAtMs },
};

document.getElementById('reload-up-log-history-btn')?.addEventListener('click', loadUpLogHistory);
upLogHistoryFilterEl?.addEventListener('input', renderUpLogHistory);
Object.values(upLogTypeFilterEls).forEach((el) => el?.addEventListener('change', renderUpLogHistory));

async function loadUpLogHistory() {
  if (!upLogHistoryListEl) return;
  upLogHistoryListEl.innerHTML = '読み込み中…';
  try {
    const snap = await getDocs(query(
      collection(db, 'ukoPointsLog'),
      orderBy('createdAt', 'desc'),
      limit(UP_LOG_HISTORY_FETCH_LIMIT),
    ));
    latestUpLogDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderUpLogHistory();
  } catch (e) {
    console.error('[admin] up log history load failed', e);
    upLogHistoryListEl.innerHTML = '読み込みに失敗しました。';
  }
}

// meta(種類ごとに形が違う)から表示用の一言を作る。オークション系はアイテム名、
// ミッションは達成キー(mission.claimKeyそのまま。MISSION_GROUPSをこの画面に
// importしていないため文言化はせず、キー名をそのまま出す)。
function upLogDetailText(d) {
  const meta = d.meta || {};
  if (d.type === 'missionClaim') return meta.claimKey || '';
  return meta.itemName || meta.itemId || '';
}

function renderUpLogHistory() {
  const keyword = (upLogHistoryFilterEl?.value || '').trim().toLowerCase();

  let rows = latestUpLogDocs.map((d) => ({
    userId: d.userId,
    userName: lookupOmikujiName(d.userId),
    type: d.type,
    amount: d.amount || 0,
    detail: upLogDetailText(d),
    createdAtMs: d.createdAt?.toMillis?.() ?? 0,
  })).filter((r) => {
    const typeEl = upLogTypeFilterEls[r.type];
    if (typeEl && !typeEl.checked) return false;
    if (!keyword) return true;
    return r.userName.toLowerCase().includes(keyword);
  });

  const getter = UP_LOG_HISTORY_SORT_COLUMNS[upLogHistorySortKey].get;
  rows = rows.slice().sort((x, y) => {
    const vx = getter(x), vy = getter(y);
    if (vx < vy) return -1 * upLogHistorySortDir;
    if (vx > vy) return 1 * upLogHistorySortDir;
    return 0;
  });

  if (upLogHistoryCountEl) {
    const totalLabel = latestUpLogDocs.length >= UP_LOG_HISTORY_FETCH_LIMIT
      ? `直近${UP_LOG_HISTORY_FETCH_LIMIT}件中`
      : `${latestUpLogDocs.length}件中`;
    upLogHistoryCountEl.textContent = `${totalLabel}${rows.length}件を表示`;
  }

  if (!upLogHistoryListEl) return;
  if (rows.length === 0) {
    upLogHistoryListEl.innerHTML = latestUpLogDocs.length === 0
      ? 'UP取得履歴はまだありません。'
      : '条件に一致する履歴がありません。';
    return;
  }

  const sortArrow = (key) => (upLogHistorySortKey === key ? (upLogHistorySortDir === 1 ? ' ▲' : ' ▼') : '');
  const headerCells = Object.entries(UP_LOG_HISTORY_SORT_COLUMNS).map(([key, col]) => `
    <th data-sort-key="${key}" style="white-space:nowrap; cursor:pointer; user-select:none;">${col.label}${sortArrow(key)}</th>
  `).join('');

  const table = document.createElement('table');
  table.className = 'user-table';
  table.innerHTML = `<thead><tr>${headerCells}</tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  const nameCellStyle = 'white-space:nowrap; max-width:120px; overflow:hidden; text-overflow:ellipsis;';
  const detailCellStyle = 'white-space:nowrap; max-width:160px; overflow:hidden; text-overflow:ellipsis;';

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="${nameCellStyle}" title="${escapeHtml(r.userName)}">
        <span class="admin-user-link" data-omikuji-id="${escapeHtml(r.userId)}" style="cursor:pointer; color:#2a6fdb; text-decoration:underline;">${escapeHtml(r.userName)}</span>
      </td>
      <td style="white-space:nowrap;">${escapeHtml(UP_LOG_TYPE_LABELS[r.type] || r.type)}</td>
      <td style="white-space:nowrap;">${r.amount}UP</td>
      <td style="${detailCellStyle}" title="${escapeHtml(r.detail)}">${escapeHtml(r.detail)}</td>
      <td style="white-space:nowrap;">${escapeHtml(fmtTimestamp(r.createdAtMs))}</td>
    `;
    tbody.appendChild(tr);
  });

  table.querySelectorAll('[data-omikuji-id]').forEach((el) => {
    el.addEventListener('click', () => openEditorByOmikujiId(el.dataset.omikujiId));
  });

  table.querySelectorAll('th[data-sort-key]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (upLogHistorySortKey === key) {
        upLogHistorySortDir *= -1;
      } else {
        upLogHistorySortKey = key;
        upLogHistorySortDir = 1;
      }
      renderUpLogHistory();
    });
  });

  upLogHistoryListEl.innerHTML = '';
  upLogHistoryListEl.appendChild(table);
}

// ===== うーこオークション キャンペーン管理(2026-09-18追加) =====
// ukoAuctionCampaignsコレクションを直接CRUDする。26_UkoAuction(落札/即決時の
// sellerBonus/bidderBonus)・14_GenshinOmikuji/auction.js(出品時のlistingBonus/
// listingCountBonus)の両方がこのコレクションを読んで自動適用するので、ここでの
// 作成・停止・削除がそのまま両サイトの挙動に反映される(即時反映、両サイトとも
// onSnapshotで購読しているため)。
const CAMPAIGN_TYPE_LABELS = {
  sellerBonus: '出品者ボーナス(落札額×倍率)',
  listingBonus: '出品即時ボーナス(定額)',
  listingCountBonus: '出品数ボーナス(段階制)',
  bidderBonus: '落札者キャッシュバック(落札額の%還元)',
};
const campaignListEl = document.getElementById('campaign-list');
let latestCampaignsAdmin = [];

function updateCampaignFieldVisibility() {
  const type = document.getElementById('campaign-type')?.value;
  Object.keys(CAMPAIGN_TYPE_LABELS).forEach((t) => {
    document.getElementById(`campaign-field-${t}`)?.classList.toggle('hidden', t !== type);
  });
}
document.getElementById('campaign-type')?.addEventListener('change', updateCampaignFieldVisibility);
updateCampaignFieldVisibility();

document.getElementById('reload-campaigns-btn')?.addEventListener('click', loadCampaigns);

async function loadCampaigns() {
  if (!campaignListEl) return;
  campaignListEl.textContent = '読み込み中…';
  try {
    const snap = await getDocs(query(collection(db, 'ukoAuctionCampaigns'), orderBy('createdAt', 'desc')));
    latestCampaignsAdmin = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCampaigns();
  } catch (e) {
    console.error('[admin] campaigns load failed', e);
    campaignListEl.textContent = '読み込みに失敗しました。';
  }
}

function campaignDetailText(c) {
  if (c.type === 'sellerBonus') return `×${c.multiplier}`;
  if (c.type === 'listingBonus') return `+${c.bonusAmount}UP`;
  if (c.type === 'listingCountBonus') return (c.tiers || []).map((t) => `${t.count}件→+${t.bonus}UP`).join(' / ');
  if (c.type === 'bidderBonus') return `${c.rate}%還元`;
  return '';
}

function isCampaignCurrentlyActive(c) {
  if (!c.enabled) return false;
  const now = Date.now();
  return c.startsAt?.toMillis() <= now && now <= c.endsAt?.toMillis();
}

function renderCampaigns() {
  if (!campaignListEl) return;
  if (latestCampaignsAdmin.length === 0) {
    campaignListEl.textContent = 'まだキャンペーンはありません。';
    return;
  }
  campaignListEl.innerHTML = '';
  latestCampaignsAdmin.forEach((c) => {
    const active = isCampaignCurrentlyActive(c);
    const card = document.createElement('div');
    card.className = 'request-card';
    if (!c.enabled) card.style.opacity = '0.55';
    card.innerHTML = `
      <h4>${escapeHtml(c.label || '')}${active ? '（開催中）' : ''}</h4>
      <div style="font-size:0.78rem; color:var(--muted);">
        ${escapeHtml(CAMPAIGN_TYPE_LABELS[c.type] || c.type)} ／ ${escapeHtml(campaignDetailText(c))}<br>
        ${fmtTimestamp(c.startsAt)} 〜 ${fmtTimestamp(c.endsAt)}
      </div>
      <div class="btn-row">
        <button class="secondary-btn" data-action="toggle">${c.enabled ? '停止する' : '有効化する'}</button>
        <button class="danger-btn" data-action="delete">削除</button>
      </div>
    `;
    card.querySelector('[data-action="toggle"]').addEventListener('click', async () => {
      try {
        await updateDoc(doc(db, 'ukoAuctionCampaigns', c.id), { enabled: !c.enabled });
        loadCampaigns();
      } catch (e) {
        console.error('[admin] campaign toggle failed', e);
        alert('操作に失敗しました。');
      }
    });
    card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm(`キャンペーン「${c.label || ''}」を削除しますか？（元に戻せません）`)) return;
      try {
        await deleteDoc(doc(db, 'ukoAuctionCampaigns', c.id));
        loadCampaigns();
      } catch (e) {
        console.error('[admin] campaign delete failed', e);
        alert('削除に失敗しました。');
      }
    });
    campaignListEl.appendChild(card);
  });
}

document.getElementById('campaign-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msgEl = document.getElementById('campaign-create-msg');
  msgEl.classList.remove('ok', 'error');

  const type = document.getElementById('campaign-type').value;
  const label = document.getElementById('campaign-label').value.trim();
  const startsRaw = document.getElementById('campaign-starts').value;
  const days = Number(document.getElementById('campaign-days').value);
  const startsAtMs = startsRaw ? new Date(startsRaw).getTime() : NaN;

  if (!label || !Number.isFinite(startsAtMs) || !Number.isFinite(days) || days < 1) {
    msgEl.textContent = '名前・開始日時・開催日数を入力してください。';
    msgEl.classList.add('error');
    return;
  }
  const endsAtMs = startsAtMs + days * 24 * 60 * 60 * 1000;

  const campaignData = {
    type, label, enabled: true,
    startsAt: Timestamp.fromMillis(startsAtMs),
    endsAt: Timestamp.fromMillis(endsAtMs),
    createdAt: serverTimestamp(),
  };

  if (type === 'sellerBonus') {
    const multiplier = Number(document.getElementById('campaign-multiplier').value);
    if (!Number.isFinite(multiplier) || multiplier <= 1) {
      msgEl.textContent = '倍率は1より大きい数値を入力してください。';
      msgEl.classList.add('error');
      return;
    }
    campaignData.multiplier = multiplier;
  } else if (type === 'listingBonus') {
    const bonusAmount = Number(document.getElementById('campaign-bonusAmount').value);
    if (!Number.isInteger(bonusAmount) || bonusAmount < 1) {
      msgEl.textContent = '出品時にもらえるUPを入力してください。';
      msgEl.classList.add('error');
      return;
    }
    campaignData.bonusAmount = bonusAmount;
  } else if (type === 'listingCountBonus') {
    const tiers = [];
    for (let i = 1; i <= 5; i++) {
      const count = Number(document.getElementById(`campaign-tier-count-${i}`).value);
      const bonus = Number(document.getElementById(`campaign-tier-bonus-${i}`).value);
      if (Number.isInteger(count) && count > 0 && Number.isInteger(bonus) && bonus > 0) tiers.push({ count, bonus });
    }
    if (!tiers.length) {
      msgEl.textContent = '段階設定を1つ以上入力してください。';
      msgEl.classList.add('error');
      return;
    }
    tiers.sort((a, b) => a.count - b.count);
    campaignData.tiers = tiers;
  } else if (type === 'bidderBonus') {
    const rate = Number(document.getElementById('campaign-rate').value);
    if (!Number.isFinite(rate) || rate <= 0) {
      msgEl.textContent = '還元率を入力してください。';
      msgEl.classList.add('error');
      return;
    }
    campaignData.rate = rate;
  }

  try {
    await addDoc(collection(db, 'ukoAuctionCampaigns'), campaignData);
    msgEl.textContent = 'キャンペーンを作成しました！';
    msgEl.classList.add('ok');
    document.getElementById('campaign-create-form').reset();
    updateCampaignFieldVisibility();
    loadCampaigns();
  } catch (err) {
    console.error('[admin] campaign create failed', err);
    msgEl.textContent = `作成に失敗しました（${err.code || err.message}）`;
    msgEl.classList.add('error');
  }
});

// ===== ユーザー一覧（最終更新順、登録・未登録どちらも） =====
const accountsListEl = document.getElementById('accounts-list');
const accountsCountEl = document.getElementById('accounts-count');
const accountsFilterEl = document.getElementById('accounts-filter');
const accountsFilterRegisteredEl = document.getElementById('accounts-filter-registered');
const accountsFilterUnregisteredEl = document.getElementById('accounts-filter-unregistered');
const accountsFilterCardBackEl = document.getElementById('accounts-filter-cardback');
const accountsFilterStorageEl = document.getElementById('accounts-filter-storage');
const accountsFilterSavedAnyEl = document.getElementById('accounts-filter-savedimage-any');
const accountsFilterFbRegisteredEl = document.getElementById('accounts-filter-fb-registered');
const accountsFilterFbMatchedEl = document.getElementById('accounts-filter-fb-matched');
const accountsFilterFbWantPartnerEl = document.getElementById('accounts-filter-fb-want-partner');
let allAccounts = [];
let accountsSortKey = null;
let accountsSortDir = 1; // 1=昇順, -1=降順
let accountsCurrentPage = 1;

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
  cardBackCount: {
    label: '裏面所持数', width: '1%',
    get: (r) => Object.values(normalizeCardBacks(r.u.cardBacks)).reduce((sum, n) => sum + (n || 0), 0),
  },
  cardBackEquipped: {
    label: '裏面設定中', width: '1%',
    get: (r) => (r.u.equippedCardBackId ? 1 : 0),
    render: (r) => (r.u.equippedCardBackId ? '✅' : ''),
  },
  savedImages: {
    label: '画像保存', width: '1%',
    get: (r) => (r.hasSavedImages ? 1 : 0),
    render: (r) => (r.hasSavedImages ? '✅' : ''),
  },
  storageImageCount: {
    label: '画像保管庫', width: '1%',
    get: (r) => r.storageImageCount || 0,
  },
  friendBoardPost: {
    label: 'FB登録', width: '1%',
    get: (r) => (r.hasFriendBoardPost ? 1 : 0),
    render: (r) => (r.hasFriendBoardPost ? '✅' : ''),
  },
  friendBoardName: {
    label: 'FB名前', width: '14%',
    get: (r) => r.friendBoardName || '',
    render: (r) => escapeHtml(r.friendBoardName || '-'),
  },
  friendBoardMatchCount: {
    label: 'マッチング数', width: '1%',
    get: (r) => r.friendBoardMatchCount || 0,
  },
  friendBoardWantPartner: {
    label: '恋人希望', width: '1%',
    get: (r) => (r.friendBoardWantPartner ? 1 : 0),
    render: (r) => (r.friendBoardWantPartner ? '✅' : ''),
  },
  friendBoardGender: {
    label: 'FB性別', width: '1%',
    get: (r) => r.friendBoardGender || '',
    render: (r) => escapeHtml(r.friendBoardGender ? formatFieldValue('gender', r.friendBoardGender, 'ja') : '-'),
  },
};

// 表示する列の選択状態(この管理画面を開いているブラウザだけのローカル設定)。
// 列が増えて表が窮屈になってきたため、使わない列を個別に隠せるようにしてある。
const ACCOUNTS_VISIBLE_COLS_KEY = 'adminAccountsVisibleColumns';
// 追加時点では表が窮屈にならないよう、初期状態は非表示にしておきたい列。
// (ローカル設定で明示的にON/OFFされれば以後はそちらが優先される)
const ACCOUNTS_DEFAULT_HIDDEN_COLUMNS = new Set(['cardBackEquipped']);
function loadVisibleColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNTS_VISIBLE_COLS_KEY) || '{}');
    const result = {};
    Object.keys(ACCOUNTS_SORT_COLUMNS).forEach((key) => {
      if (key in saved) { result[key] = saved[key] !== false; return; }
      result[key] = !ACCOUNTS_DEFAULT_HIDDEN_COLUMNS.has(key);
    });
    return result;
  } catch (e) {
    const result = {};
    Object.keys(ACCOUNTS_SORT_COLUMNS).forEach((key) => { result[key] = !ACCOUNTS_DEFAULT_HIDDEN_COLUMNS.has(key); });
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

// ===== 詳細フィルター: ロール・画像メーカー系(個別) =====
// どちらも「未選択(空)=絞り込みなし」を基本にしたいが、ロールだけは
// 3種とも触っていない初期状態で「全ロール表示」にしたいので、初期値は全チェック済みにする。
let accountsFilterRoleSet = new Set(Object.keys(ROLE_LABELS));
let accountsFilterSavedSiteSet = new Set();

// フィルターのチェックボックスでは画面メーカー(原神/スタレ/魔女会)を1つにまとめる
// (編集画面の内訳表示(renderSavedImages)ではSAVED_IMAGE_SITESをそのまま使うので、
// そちらは3サイトのまま個別表示される)。
const PLAY_MAKER_SITE_IDS = ['playMakerGenshin', 'playMakerStarrail', 'playMakerMajokai'];
const SAVED_IMAGE_FILTER_OPTIONS = [
  ...SAVED_IMAGE_SITES.filter((site) => !PLAY_MAKER_SITE_IDS.includes(site.id))
    .map((site) => ({ id: site.id, label: site.label, siteIds: [site.id] })),
  { id: 'playMaker', label: '画面メーカー', siteIds: PLAY_MAKER_SITE_IDS },
];
const SAVED_IMAGE_FILTER_OPTION_BY_ID = new Map(SAVED_IMAGE_FILTER_OPTIONS.map((o) => [o.id, o]));

const filterRolesEl = document.getElementById('accounts-filter-roles');
function renderFilterRoleToggles() {
  filterRolesEl.innerHTML = Object.entries(ROLE_LABELS).map(([key, label]) => `
    <label style="display:inline-flex; align-items:center; gap:4px; font-size:0.82rem;">
      <input type="checkbox" data-role-key="${key}" ${accountsFilterRoleSet.has(key) ? 'checked' : ''}>
      ${escapeHtml(label)}
    </label>
  `).join('');
  filterRolesEl.querySelectorAll('input[data-role-key]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) accountsFilterRoleSet.add(cb.dataset.roleKey);
      else accountsFilterRoleSet.delete(cb.dataset.roleKey);
      accountsCurrentPage = 1;
      renderAccounts(accountsFilterEl.value);
    });
  });
}
renderFilterRoleToggles();

const filterSavedSitesEl = document.getElementById('accounts-filter-savedimage-sites');
function renderFilterSavedSiteToggles() {
  filterSavedSitesEl.innerHTML = SAVED_IMAGE_FILTER_OPTIONS.map((opt) => `
    <label style="display:inline-flex; align-items:center; gap:4px; font-size:0.82rem;">
      <input type="checkbox" data-site-key="${opt.id}" ${accountsFilterSavedSiteSet.has(opt.id) ? 'checked' : ''}>
      ${escapeHtml(opt.label)}
    </label>
  `).join('');
  filterSavedSitesEl.querySelectorAll('input[data-site-key]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) accountsFilterSavedSiteSet.add(cb.dataset.siteKey);
      else accountsFilterSavedSiteSet.delete(cb.dataset.siteKey);
      accountsCurrentPage = 1;
      renderAccounts(accountsFilterEl.value);
    });
  });
}
renderFilterSavedSiteToggles();

// フレンド承認板の性別フィルター(未選択=絞り込みなし、savedImageサイトと同じ考え方)。
// 選択肢のラベルはfields.jsのformatFieldValueをそのまま使い、'male'/'female'という
// キー自体はfields.js側のOPTION_LABELSを直接importせず、値渡しで文言だけ借りる。
const FB_GENDER_FILTER_OPTIONS = ['male', 'female'].map((key) => ({ id: key, label: formatFieldValue('gender', key, 'ja') }));
let accountsFilterFbGenderSet = new Set();
const filterFbGendersEl = document.getElementById('accounts-filter-fb-genders');
function renderFilterFbGenderToggles() {
  filterFbGendersEl.innerHTML = FB_GENDER_FILTER_OPTIONS.map((opt) => `
    <label style="display:inline-flex; align-items:center; gap:4px; font-size:0.82rem;">
      <input type="checkbox" data-fb-gender-key="${opt.id}" ${accountsFilterFbGenderSet.has(opt.id) ? 'checked' : ''}>
      ${escapeHtml(opt.label)}（FB）
    </label>
  `).join('');
  filterFbGendersEl.querySelectorAll('input[data-fb-gender-key]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) accountsFilterFbGenderSet.add(cb.dataset.fbGenderKey);
      else accountsFilterFbGenderSet.delete(cb.dataset.fbGenderKey);
      accountsCurrentPage = 1;
      renderAccounts(accountsFilterEl.value);
    });
  });
}
renderFilterFbGenderToggles();

[accountsFilterFbRegisteredEl, accountsFilterFbMatchedEl, accountsFilterFbWantPartnerEl].forEach((el) => {
  el.addEventListener('change', () => { accountsCurrentPage = 1; renderAccounts(accountsFilterEl.value); });
});

document.getElementById('reload-accounts-btn').addEventListener('click', loadAccounts);
accountsFilterEl.addEventListener('input', () => { accountsCurrentPage = 1; renderAccounts(accountsFilterEl.value); });
accountsFilterRegisteredEl.addEventListener('change', () => { accountsCurrentPage = 1; renderAccounts(accountsFilterEl.value); });
accountsFilterUnregisteredEl.addEventListener('change', () => { accountsCurrentPage = 1; renderAccounts(accountsFilterEl.value); });
accountsFilterCardBackEl.addEventListener('change', () => { accountsCurrentPage = 1; renderAccounts(accountsFilterEl.value); });
accountsFilterStorageEl.addEventListener('change', () => { accountsCurrentPage = 1; renderAccounts(accountsFilterEl.value); });
accountsFilterSavedAnyEl.addEventListener('change', () => { accountsCurrentPage = 1; renderAccounts(accountsFilterEl.value); });

async function loadAccounts() {
  accountsListEl.innerHTML = '読み込み中…';
  accountsCurrentPage = 1;

  const [usersSnap, linkSnap, roleSnap, savedImagesSnap, storageImagesSnap, friendBoardPostsSnap, friendBoardProfilesSnap, friendBoardApplicationsSnap] = await Promise.all([
    getDocs(query(collection(db, 'omikujiUsers'), orderBy('updatedAt', 'desc'))),
    getDocs(collection(db, 'accountLinks')),
    getDocs(collection(db, 'sharedUserRoles')),
    getDocs(collection(db, 'savedProfileImages')),
    getDocs(collection(db, 'screenshotStorageImages')),
    getDocs(collection(db, 'friendBoardPosts')),
    getDocs(collection(db, 'friendBoardProfiles')),
    getDocs(collection(db, 'friendBoardApplications')),
  ]);

  const linkByOmikujiId = new Map();
  linkSnap.docs.forEach((linkDoc) => {
    const link = linkDoc.data();
    if (link.omikujiUserId) linkByOmikujiId.set(link.omikujiUserId, { ...link, authUid: linkDoc.id });
  });

  const roleByOmikujiId = new Map();
  roleSnap.docs.forEach((roleDoc) => roleByOmikujiId.set(roleDoc.id, roleDoc.data().role || 'general'));

  // 原神フレンド承認板(25_FriendBoard)。friendBoardPosts/{userId}はomikujiUsersと同じ
  // 共有匿名ID(genshinOmikuji_userId)をドキュメントIDにしているので、そのまま存在確認
  // だけで「登録あり」列を出せる(詳細な中身は編集画面を開いた時に個別取得する)。
  const hasFriendBoardPostSet = new Set(friendBoardPostsSnap.docs.map((d) => d.id));

  // friendBoardProfiles/{userId}(可視性設定に関係ない生データ)からニックネーム・性別・
  // 「恋人がほしい」希望の有無を拾う。いずれも編集画面の「フレンド承認板」タブと
  // 同じデータソース(生のgender/friendPreference配列, wantPartnerキー)。
  const friendBoardNameByOmikujiId = new Map();
  const friendBoardGenderByOmikujiId = new Map();
  const friendBoardWantPartnerSet = new Set();
  friendBoardProfilesSnap.docs.forEach((d) => {
    const data = d.data() || {};
    if (data.displayName) friendBoardNameByOmikujiId.set(d.id, data.displayName);
    if (data.gender) friendBoardGenderByOmikujiId.set(d.id, data.gender);
    if (Array.isArray(data.friendPreference) && data.friendPreference.includes('wantPartner')) {
      friendBoardWantPartnerSet.add(d.id);
    }
  });

  // マッチング数 = 承認済み(accepted)の申請に、出品者・申請者どちらかとして関わった件数
  // (25_FriendBoardの「やり取り」タブに出てくる相手の数と同じ数え方)。
  const friendBoardMatchCountByOmikujiId = new Map();
  friendBoardApplicationsSnap.docs.forEach((d) => {
    const app = d.data() || {};
    if (app.status !== 'accepted') return;
    [app.postOwnerUserId, app.applicantUserId].forEach((uid) => {
      if (!uid) return;
      friendBoardMatchCountByOmikujiId.set(uid, (friendBoardMatchCountByOmikujiId.get(uid) || 0) + 1);
    });
  });

  // savedProfileImages/{omikujiUserId}は{ [siteId]: {url, updatedAt} }なので、
  // 一覧の列自体は「1つでも画像メーカー系サイトに保存しているか」だけ見せる
  // (サイトごとの内訳は個別編集画面の「画像メーカー」タブで見られるため)。
  // フィルターではサイト個別の絞り込みも使いたいので、サイトIDのSetも持っておく。
  const hasSavedImagesSet = new Set();
  const savedImageSitesByOmikujiId = new Map();
  savedImagesSnap.docs.forEach((d) => {
    const data = d.data() || {};
    if (Object.keys(data).length > 0) hasSavedImagesSet.add(d.id);
    const siteIds = new Set(
      SAVED_IMAGE_SITES.map((site) => site.id).filter((id) => data[id] && data[id].url)
    );
    if (siteIds.size > 0) savedImageSitesByOmikujiId.set(d.id, siteIds);
  });

  // 17_storage(画像保管庫)。screenshotStorageImages/{imageId}はownerUid(=Firebase Authのuid)
  // 単位のドキュメントなので、accountLinksのauthUidをキーに件数を集計する。
  const storageImageCountByAuthUid = new Map();
  storageImagesSnap.docs.forEach((d) => {
    const ownerUid = d.data()?.ownerUid;
    if (!ownerUid) return;
    storageImageCountByAuthUid.set(ownerUid, (storageImageCountByAuthUid.get(ownerUid) || 0) + 1);
  });

  allAccounts = usersSnap.docs
    .filter((userDoc) => (userDoc.data().achStats?.totalCount || 0) > 0)
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
        savedImageSiteIds: savedImageSitesByOmikujiId.get(userDoc.id) || new Set(),
        storageImageCount: link?.authUid ? (storageImageCountByAuthUid.get(link.authUid) || 0) : 0,
        hasFriendBoardPost: hasFriendBoardPostSet.has(userDoc.id),
        friendBoardName: friendBoardNameByOmikujiId.get(userDoc.id) || '',
        friendBoardGender: friendBoardGenderByOmikujiId.get(userDoc.id) || '',
        friendBoardMatchCount: friendBoardMatchCountByOmikujiId.get(userDoc.id) || 0,
        friendBoardWantPartner: friendBoardWantPartnerSet.has(userDoc.id),
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
    if (!accountsFilterRoleSet.has(a.role)) return false;
    if (accountsFilterCardBackEl.checked && !a.omikujiData?.equippedCardBackId) return false;
    if (accountsFilterStorageEl.checked && !(a.storageImageCount > 0)) return false;
    if (accountsFilterSavedAnyEl.checked && !a.hasSavedImages) return false;
    if (accountsFilterSavedSiteSet.size > 0) {
      const hasAnySelectedSite = [...accountsFilterSavedSiteSet].some((optionId) => {
        const opt = SAVED_IMAGE_FILTER_OPTION_BY_ID.get(optionId);
        return opt && opt.siteIds.some((siteId) => a.savedImageSiteIds.has(siteId));
      });
      if (!hasAnySelectedSite) return false;
    }
    if (accountsFilterFbRegisteredEl.checked && !a.hasFriendBoardPost) return false;
    if (accountsFilterFbMatchedEl.checked && !(a.friendBoardMatchCount > 0)) return false;
    if (accountsFilterFbWantPartnerEl.checked && !a.friendBoardWantPartner) return false;
    if (accountsFilterFbGenderSet.size > 0 && !accountsFilterFbGenderSet.has(a.friendBoardGender)) return false;
    if (!needle) return true;
    return a.loginId.toLowerCase().includes(needle)
      || (a.omikujiData?.name || '').toLowerCase().includes(needle)
      || (a.friendBoardName || '').toLowerCase().includes(needle);
  });

  if (filtered.length === 0) {
    accountsCountEl.textContent = `0 / ${allAccounts.length} 件（最終更新が新しい順）`;
    accountsListEl.innerHTML = '該当するユーザーがいません。';
    return;
  }

  let rows = filtered.map((a) => ({
    a, u: a.omikujiData, counts: countByRarity(a.omikujiData.achievements), hasSavedImages: a.hasSavedImages,
    storageImageCount: a.storageImageCount, hasFriendBoardPost: a.hasFriendBoardPost,
    friendBoardName: a.friendBoardName, friendBoardMatchCount: a.friendBoardMatchCount,
    friendBoardWantPartner: a.friendBoardWantPartner, friendBoardGender: a.friendBoardGender,
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

  // 全件無制限で読み込んでいるので、表示だけACCOUNTS_PAGE_SIZE単位でページ分割する
  const totalPages = Math.max(1, Math.ceil(rows.length / ACCOUNTS_PAGE_SIZE));
  accountsCurrentPage = Math.min(Math.max(1, accountsCurrentPage), totalPages);
  const pageStart = (accountsCurrentPage - 1) * ACCOUNTS_PAGE_SIZE;
  const pageRows = rows.slice(pageStart, pageStart + ACCOUNTS_PAGE_SIZE);

  accountsCountEl.textContent = `${filtered.length} / ${allAccounts.length} 件（最終更新が新しい順、${pageStart + 1}〜${pageStart + pageRows.length}件目を表示、${accountsCurrentPage}/${totalPages}ページ）`;

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

  pageRows.forEach((row) => {
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
      accountsCurrentPage = 1;
      renderAccounts(accountsFilterEl.value);
    });
  });

  accountsListEl.innerHTML = '';
  accountsListEl.appendChild(table);

  if (totalPages > 1) {
    const pager = document.createElement('div');
    pager.style.cssText = 'display:flex; align-items:center; justify-content:center; gap:12px; margin-top:10px;';
    const prevBtn = document.createElement('button');
    prevBtn.className = 'secondary-btn';
    prevBtn.style.cssText = 'width:auto; padding:6px 16px;';
    prevBtn.textContent = '前のページ';
    prevBtn.disabled = accountsCurrentPage <= 1;
    prevBtn.addEventListener('click', () => {
      accountsCurrentPage -= 1;
      renderAccounts(accountsFilterEl.value);
    });

    const pageLabel = document.createElement('span');
    pageLabel.style.cssText = 'font-size:0.82rem;';
    pageLabel.textContent = `${accountsCurrentPage} / ${totalPages}`;

    const nextBtn = document.createElement('button');
    nextBtn.className = 'secondary-btn';
    nextBtn.style.cssText = 'width:auto; padding:6px 16px;';
    nextBtn.textContent = '次のページ';
    nextBtn.disabled = accountsCurrentPage >= totalPages;
    nextBtn.addEventListener('click', () => {
      accountsCurrentPage += 1;
      renderAccounts(accountsFilterEl.value);
    });

    pager.appendChild(prevBtn);
    pager.appendChild(pageLabel);
    pager.appendChild(nextBtn);
    accountsListEl.appendChild(pager);
  }
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

  // 完全一致だけでなく部分一致・前方一致でも見つけられるように、既に読み込み済みの
  // allAccounts(ユーザー一覧)に対しても大文字小文字を区別しない部分一致でヒットさせる
  // (Firestoreのwhere('==')は完全一致にしか使えないため、こちらはクライアント側で判定)。
  // allAccountsはachStats.totalCount>0のユーザーのみを含む(loadAccounts参照)ので、
  // 実績0件のユーザーを完全一致で見つける経路は上のFirestore直接クエリのままにしてある。
  const needle = value.toLowerCase();
  allAccounts.forEach((a) => {
    if (results.has(a.omikujiUserId)) return;
    const name = (a.omikujiData?.name || '').toLowerCase();
    const loginId = (a.loginId || '').toLowerCase();
    const uid = a.omikujiUserId.toLowerCase();
    if (name.includes(needle) || loginId.includes(needle) || uid.includes(needle)) {
      results.set(a.omikujiUserId, { data: a.omikujiData, viaLoginId: loginId.includes(needle) ? a.loginId : null });
    }
  });

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

// 一覧側でどの詳細フィルターを使っているかによって、編集画面を開いた時の
// デフォルトタブを変える(画面メーカー系→画像メーカー、裏面設定中→おみくじ、
// 画像保管庫→画像保管庫)。複数該当する場合はこの並び(後勝ち)で優先度をつける。
function defaultEditTabForCurrentFilter() {
  let tab = 'basic';
  if (accountsFilterSavedAnyEl.checked || accountsFilterSavedSiteSet.size > 0) tab = 'images';
  if (accountsFilterCardBackEl.checked) tab = 'omikuji';
  if (accountsFilterStorageEl.checked) tab = 'storage17';
  if (accountsFilterFbRegisteredEl.checked || accountsFilterFbMatchedEl.checked
    || accountsFilterFbWantPartnerEl.checked || accountsFilterFbGenderSet.size > 0) tab = 'friendboard';
  return tab;
}

async function openEditor(uid, data, account = null) {
  currentEditUid = uid;
  currentEditData = data;
  currentEditAccount = account;
  currentConnect10DocId = null;
  switchEditTab(defaultEditTabForCurrentFilter());

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
  renderOwnedCardBacks(data.cardBacks);

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

  // 原神フレンド承認板(25_FriendBoard)。friendBoardPosts/{uid}が「現在掲載中のプロフィール」、
  // friendBoardProfiles/{uid}が可視性設定に関係なく全項目そのままの生データ(25_FriendBoard
  // 自身の管理者フィルターと同じデータソース)。両方揃わないと表示に必要な情報が欠けるため、
  // 並行取得してrenderFriendBoardTabにまとめて渡す。
  const [fbPostSnap, fbProfileSnap] = await Promise.all([
    getDoc(doc(db, 'friendBoardPosts', uid)),
    getDoc(doc(db, 'friendBoardProfiles', uid)),
  ]);
  renderFriendBoardTab(
    fbPostSnap.exists() ? fbPostSnap.data() : null,
    fbProfileSnap.exists() ? fbProfileSnap.data() : null,
  );

  const savedImagesSnap = await getDoc(doc(db, 'savedProfileImages', uid));
  renderSavedImages(savedImagesSnap.exists() ? savedImagesSnap.data() : {});

  // 17_storage(画像保管庫)。ownerUid(=Firebase Authのuid)単位のコレクションなので、
  // AccountCenter未登録(authUid無し)のユーザーはそもそも利用できない。
  const storage17NotRegisteredMsg = document.getElementById('storage17-not-registered-msg');
  if (account?.authUid) {
    storage17NotRegisteredMsg.classList.add('hidden');
    const storage17Snap = await getDocs(query(collection(db, 'screenshotStorageImages'), where('ownerUid', '==', account.authUid)));
    renderStorageImages(storage17Snap.docs.map((d) => d.data()));
  } else {
    storage17NotRegisteredMsg.classList.remove('hidden');
    renderStorageImages([]);
  }

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
      <img src="${escapeHtml(design.url)}" alt="${escapeHtml(design.name)}" data-zoomable="${escapeHtml(design.url)}" style="width:60px; border-radius:8px; border:1px solid var(--border); display:block;">
      <span>${escapeHtml(design.name)}</span>
    </div>
  `;
  enableThumbnailZoom(container);
}

// cardBacksは{ デザインID: 所持数 }。gachaBacks.jsのGACHA_DESIGNSと突き合わせて
// サムネ＋所持数を一覧表示する(所持数が多い順)。
function renderOwnedCardBacks(cardBacks) {
  const container = document.getElementById('edit-owned-cardbacks');
  const emptyMsg = document.getElementById('owned-cardbacks-empty-msg');
  container.innerHTML = '';

  const entries = Object.entries(normalizeCardBacks(cardBacks))
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ design: GACHA_DESIGN_BY_ID.get(id), id, count }))
    .sort((x, y) => y.count - x.count);

  emptyMsg.classList.toggle('hidden', entries.length > 0);

  entries.forEach(({ design, id, count }) => {
    const card = document.createElement('div');
    card.style.cssText = 'width:100px;';
    card.innerHTML = design
      ? `
        <img src="${escapeHtml(design.url)}" alt="${escapeHtml(design.name)}" data-zoomable="${escapeHtml(design.url)}" style="width:100%; border-radius:8px; border:1px solid var(--border); display:block;">
        <p style="font-size:0.72rem; margin-top:4px;">${escapeHtml(design.name)} ×${count}</p>
      `
      : `<p style="font-size:0.72rem;">不明なID: ${escapeHtml(id)} ×${count}</p>`;
    container.appendChild(card);
  });
  enableThumbnailZoom(container);
}

// 原神フレンド承認板(25_FriendBoard)。読み取り専用の情報表示のみ(このタブに編集項目は
// 無いので、「保存」ボタンを押しても他タブの内容だけが反映され、ここは変わらない)。
// ラベル・値の文言は25_FriendBoard/fields.jsをそのままimportして使う(このタブ独自に
// 選択肢の文言を複製すると、向こうで選択肢が増減した時にズレるため)。値は可視性設定
// (公開/承認後に公開/非公開)に関係なくfriendBoardProfilesの生データをそのまま出す
// (25_FriendBoard自身の管理者用フィルターも同じ生データを見ているのと同じ考え方)。
function renderFriendBoardTab(postData, profileData) {
  const notFoundMsg = document.getElementById('friendboard-not-found-msg');
  const container = document.getElementById('edit-friendboard');
  container.innerHTML = '';

  if (!postData) {
    notFoundMsg.classList.remove('hidden');
    return;
  }
  notFoundMsg.classList.add('hidden');

  const addRow = (label, value) => {
    const row = document.createElement('div');
    row.className = 'input-group';
    row.innerHTML = `<label>${escapeHtml(label)}</label><div class="uid-box">${escapeHtml(value)}</div>`;
    container.appendChild(row);
  };

  addRow('掲載状況', '掲載中（friendBoardPostsにドキュメントあり）');
  addRow('なんでも一言', postData.comment || '（未記入）');
  addRow('承認制の項目あり', postData.requiresApproval ? 'あり（一部項目は承認後にだけ公開）' : 'なし');
  addRow('最終更新日時', fmtTimestamp(postData.lastActiveAt));

  if (profileData) {
    VISIBILITY_FIELDS.forEach((key) => {
      const text = formatFieldValue(key, profileData[key], 'ja');
      if (!text) return;
      addRow(fieldLabel(key, 'ja'), text);
    });
  }
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
      <img src="${escapeHtml(entry.url)}" alt="${escapeHtml(site.label)}" data-zoomable="${escapeHtml(entry.url)}" style="width:100%; border-radius:8px; border:1px solid var(--border); display:block;">
      <p style="font-size:0.78rem; font-weight:bold; margin-top:6px;">${escapeHtml(site.label)}</p>
      <p style="font-size:0.72rem; color:var(--muted);">${escapeHtml(formatSavedAt(entry.updatedAt))}</p>
    `;
    container.appendChild(card);
  });
  enableThumbnailZoom(container);
}

// 17_storage(画像保管庫)。screenshotStorageImages/{imageId}を1人分まとめて渡す想定
// (呼び出し側でownerUidフィルタ済み)。新しい順に並べ、モデレーション状況も添える。
const STORAGE17_STATUS_LABELS = { pending: '審査中', approved: '承認済み', removed: '削除済み' };
function renderStorageImages(images) {
  const container = document.getElementById('edit-storage17-images');
  const emptyMsg = document.getElementById('storage17-empty-msg');
  container.innerHTML = '';

  const sorted = images
    .filter((img) => img.thumbUrl)
    .slice()
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

  emptyMsg.classList.toggle('hidden', sorted.length > 0);

  sorted.forEach((img) => {
    const card = document.createElement('div');
    card.style.cssText = 'width:160px;';
    const statusLabel = STORAGE17_STATUS_LABELS[img.moderationStatus] || img.moderationStatus || '';
    const zoomUrl = img.viewUrl || img.thumbUrl;
    card.innerHTML = `
      <img src="${escapeHtml(img.thumbUrl)}" alt="" data-zoomable="${escapeHtml(zoomUrl)}" style="width:100%; border-radius:8px; border:1px solid var(--border); display:block;">
      <p style="font-size:0.72rem; color:var(--muted);">${escapeHtml(formatSavedAt(img.createdAt))}</p>
      <p style="font-size:0.72rem;">${escapeHtml(statusLabel)}${img.shareEnabled ? ' / 共有ON' : ''}</p>
    `;
    container.appendChild(card);
  });
  enableThumbnailZoom(container);
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

// ===== サムネイル拡大表示(ユーザー編集画面の各種画像サムネ共通) =====
const adminLightboxEl = document.getElementById('admin-lightbox');
const adminLightboxImgEl = document.getElementById('admin-lightbox-img');
function openAdminLightbox(url) {
  if (!url || !adminLightboxEl || !adminLightboxImgEl) return;
  adminLightboxImgEl.src = url;
  adminLightboxEl.style.display = 'flex';
}
function closeAdminLightbox() {
  if (!adminLightboxEl) return;
  adminLightboxEl.style.display = 'none';
  adminLightboxImgEl.src = '';
}
adminLightboxEl?.addEventListener('click', closeAdminLightbox);

// 上記renderXxx系はimg要素をinnerHTMLで生成するため、生成後にこれで一括して
// クリック→拡大を仕込む(サムネのstyleにcursor:zoom-inを付けた要素だけが対象)。
function enableThumbnailZoom(container) {
  if (!container) return;
  container.querySelectorAll('img[data-zoomable]').forEach((img) => {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => openAdminLightbox(img.dataset.zoomable));
  });
}

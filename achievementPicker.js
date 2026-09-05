// achievementPicker.js
// アカウント管理画面の「アチーブメント設定」。
// 08_UPointで「アチーブメント設定を解放」(50UP)、または称号そのもの
// (「うーこの部屋常連」「UP覇者」等)を購入するまでは非活性。
// 解放後は、原神おみくじ・コネクトバトルで獲得済みの実績、または直接購入した
// 称号の中から1つ選んで、omikujiUsers/{userId}.equippedBadge として設定できる。
// 実際に他サイトの画面へ表示されるかどうかは別の話(例: 14_GenshinOmikujiは
// 別途「アチーブメント表示を解放」(50UP)している人だけ表示する)。

import { db } from './firebaseConfig.js';
import {
  doc, onSnapshot, setDoc, deleteField, collection, query, where, getDocs,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { ALL_ACHIEVEMENTS as OMIKUJI_ACHIEVEMENTS } from 'https://uko05.github.io/14_GenshinOmikuji/achievements.js';
import { ALL_ACHIEVEMENTS as CONNECT10_ACHIEVEMENTS } from 'https://uko05.github.io/10_connect/public/scripts/achievements.js';

const LS_SHARED_UID = 'genshinOmikuji_userId';
function getSharedUserId() {
  return localStorage.getItem(LS_SHARED_UID) || '';
}

// 実績経由ではなく、08_UPointで直接購入できる称号。equippedBadge.siteには
// 'uko05room' を入れて、他の2サイトの実績と同じ形式で選べるようにする。
// perkFieldはsitePerks.accountCenter.{perkField}が立っているかどうかで所持判定する。
const PURCHASED_TITLES = [
  { id: 'title_regular', perkField: 'titleRegularUnlocked', rarity: 'gold', name: 'うーこの部屋常連', nameEn: 'Room Regular' },
  { id: 'title_up_champion', perkField: 'titleUpChampionUnlocked', rarity: 'legend', name: 'UP覇者', nameEn: 'UP Champion' },
];

const i18n = {
  ja: {
    achTitle: 'アチーブメント設定',
    achDesc: '原神おみくじ・コネクトバトルで獲得した実績や、うーこポイントで購入した称号の中から1つ選んで設定できます。',
    achLockedText: 'この機能は「うーこポイント交換所」で「アチーブメント設定を解放」(50UP)、または称号そのものを購入すると使えるようになります。',
    achLockedLinkBtn: 'ポイント交換所を開く',
    achEquippedLabel: '現在の称号：',
    achEquippedNone: '未設定',
    achClearBtn: '解除する',
    achEmpty: 'まだ選べる称号がありません。原神おみくじやコネクトバトルで実績を獲得するか、うーこポイント交換所で称号を購入すると、ここから選べるようになります。',
    achFromOmikuji: '原神おみくじ',
    achFromConnect10: 'コネクトバトル',
    achFromPurchased: '購入した称号',
    achSetOk: '称号を設定しました。',
    achClearOk: '称号を解除しました。',
    achSaveFail: '保存に失敗しました。時間をおいて再度お試しください。',
  },
  en: {
    achTitle: 'Achievement Title',
    achDesc: 'Pick one earned achievement from Genshin Omikuji or Connect Battle, or a title purchased with Uko Points, to display as your title.',
    achLockedText: 'Unlock this by redeeming "Unlock Achievement Setting" (50UP), or by purchasing a title outright, on the Uko Point Exchange.',
    achLockedLinkBtn: 'Open Point Exchange',
    achEquippedLabel: 'Current title:',
    achEquippedNone: 'Not set',
    achClearBtn: 'Clear',
    achEmpty: "No titles available yet. Earn achievements on Genshin Omikuji or Connect Battle, or purchase a title on the Uko Point Exchange, to pick from here.",
    achFromOmikuji: 'Genshin Omikuji',
    achFromConnect10: 'Connect Battle',
    achFromPurchased: 'Purchased Titles',
    achSetOk: 'Title set.',
    achClearOk: 'Title cleared.',
    achSaveFail: 'Failed to save. Please try again later.',
  },
};
function currentLang() {
  return document.documentElement.lang === 'en' ? 'en' : 'ja';
}
function t(key) { return i18n[currentLang()][key] ?? key; }

const RARITY_ORDER = { legend: 0, gold: 1, silver: 2, bronze: 3 };

let unlocked = false;
let equippedBadge = null;
let myOmikujiAchIds = [];
let myConnect10AchIds = [];
let myPurchasedTitleIds = [];
let connect10Loaded = false;
// 08_UPointはまだ一般公開していないので、管理者/デバッガー以外にはリンクを見せない。
let hasPointExchangeAccess = false;

function els() {
  return {
    lockedNotice: document.getElementById('achievement-locked-notice'),
    lockedLink: document.getElementById('achievement-locked-link'),
    picker: document.getElementById('achievement-picker'),
    equippedDisplay: document.getElementById('ach-equipped-display'),
    clearBtn: document.getElementById('ach-clear-btn'),
    list: document.getElementById('ach-list'),
    msg: document.getElementById('ach-msg'),
  };
}

function applyAchLang() {
  document.querySelectorAll('#achievement-section [data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (i18n[currentLang()][key] !== undefined) el.textContent = i18n[currentLang()][key];
  });
  renderPicker();
}

function badgeLabel(badge) {
  if (!badge) return t('achEquippedNone');
  return (currentLang() === 'en' && badge.nameEn) ? badge.nameEn : badge.name;
}

// バッジは幅固定(ach-badge)なので、名前が長くてはみ出す場合は
// コネクトバトルのfitChipText(achievementManager.js)と同じやり方で、
// 収まるまでフォントサイズを少しずつ縮めて全文が見えるようにする。
function fitBadgeText(chip) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    chip.style.fontSize = '';
    let size = parseFloat(getComputedStyle(chip).fontSize);
    const minSize = 8;
    while (chip.scrollWidth > chip.clientWidth && size > minSize) {
      size -= 0.5;
      chip.style.fontSize = size + 'px';
    }
  }));
}

function renderPicker() {
  const { lockedNotice, lockedLink, picker, equippedDisplay, list } = els();
  if (!lockedNotice || !picker) return;

  lockedNotice.classList.toggle('hidden', unlocked);
  picker.classList.toggle('ach-disabled', !unlocked);
  if (lockedLink) lockedLink.classList.toggle('hidden', !hasPointExchangeAccess);

  if (equippedDisplay) {
    equippedDisplay.textContent = badgeLabel(equippedBadge);
    equippedDisplay.className = 'ach-badge ach-badge-current' + (equippedBadge ? ` rarity-${equippedBadge.rarity || 'bronze'}` : ' empty');
    equippedDisplay.title = equippedDisplay.textContent;
    fitBadgeText(equippedDisplay);
  }

  if (!list) return;
  list.innerHTML = '';

  const groups = [
    { site: 'omikuji', labelKey: 'achFromOmikuji', total: OMIKUJI_ACHIEVEMENTS.length,
      earned: myOmikujiAchIds.map((id) => OMIKUJI_ACHIEVEMENTS.find((a) => a.id === id)).filter(Boolean) },
    { site: 'connect10', labelKey: 'achFromConnect10', total: CONNECT10_ACHIEVEMENTS.length,
      earned: myConnect10AchIds.map((id) => CONNECT10_ACHIEVEMENTS.find((a) => a.id === id)).filter(Boolean) },
    { site: 'uko05room', labelKey: 'achFromPurchased', total: PURCHASED_TITLES.length,
      earned: myPurchasedTitleIds.map((id) => PURCHASED_TITLES.find((a) => a.id === id)).filter(Boolean) },
  ];

  if (!groups.some((g) => g.earned.length)) {
    const p = document.createElement('p');
    p.className = 'section-desc';
    p.textContent = t('achEmpty');
    list.appendChild(p);
    return;
  }

  groups.filter((g) => g.earned.length).forEach(({ site, labelKey, total, earned }) => {
    const achs = [...earned].sort((a, b) => (RARITY_ORDER[a.rarity] ?? 9) - (RARITY_ORDER[b.rarity] ?? 9));

    const label = document.createElement('p');
    label.className = 'ach-group-label';
    label.innerHTML = `<span class="ach-group-name">${t(labelKey)}</span><span class="ach-group-count">${earned.length} / ${total}</span>`;
    list.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'ach-badge-grid';

    achs.forEach((ach) => {
      const isEquipped = !!equippedBadge && equippedBadge.site === site && equippedBadge.achievementId === ach.id;
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = `ach-badge rarity-${ach.rarity || 'bronze'}${isEquipped ? ' active' : ''}`;
      const text = (currentLang() === 'en' && ach.nameEn) ? ach.nameEn : ach.name;
      badge.textContent = text;
      badge.title = text;
      badge.addEventListener('click', () => (isEquipped ? clearBadge() : equip(site, ach)));
      grid.appendChild(badge);
      fitBadgeText(badge);
    });

    list.appendChild(grid);
  });
}

async function equip(site, ach) {
  if (!unlocked) return;
  const sharedId = getSharedUserId();
  if (!sharedId) return;
  const { msg } = els();
  try {
    await setDoc(doc(db, 'omikujiUsers', sharedId), {
      equippedBadge: {
        site,
        achievementId: ach.id,
        name: ach.name,
        nameEn: ach.nameEn || ach.name,
        rarity: ach.rarity || 'bronze',
      },
    }, { merge: true });
    if (msg) { msg.textContent = t('achSetOk'); msg.classList.remove('error'); msg.classList.add('ok'); }
  } catch (e) {
    console.error('[achievementPicker] equip failed', e);
    if (msg) { msg.textContent = t('achSaveFail'); msg.classList.add('error'); msg.classList.remove('ok'); }
  }
}

async function clearBadge() {
  if (!unlocked) return;
  const sharedId = getSharedUserId();
  if (!sharedId) return;
  const { msg } = els();
  try {
    await setDoc(doc(db, 'omikujiUsers', sharedId), { equippedBadge: deleteField() }, { merge: true });
    if (msg) { msg.textContent = t('achClearOk'); msg.classList.remove('error'); msg.classList.add('ok'); }
  } catch (e) {
    console.error('[achievementPicker] clear failed', e);
    if (msg) { msg.textContent = t('achSaveFail'); msg.classList.add('error'); msg.classList.remove('ok'); }
  }
}

// コネクトバトルの実績は共通ID経由の一度きりの検索でよい(頻繁に変わらないため、
// おみくじ側のようなリアルタイム購読はしない)。
async function loadConnect10Achievements(sharedId) {
  if (connect10Loaded) return;
  connect10Loaded = true;
  try {
    const q = query(collection(db, 'connectUsers'), where('sharedUserId', '==', sharedId));
    const snap = await getDocs(q);
    if (!snap.empty) {
      myConnect10AchIds = snap.docs[0].data().achievements || [];
      renderPicker();
    }
  } catch (e) {
    console.error('[achievementPicker] connect10 achievements fetch failed', e);
  }
}

function initAchievementPicker() {
  const sharedId = getSharedUserId();
  if (!sharedId) return;

  const { clearBtn } = els();
  if (clearBtn) clearBtn.addEventListener('click', clearBadge);

  document.querySelectorAll('input[name="lang"]').forEach((r) => {
    r.addEventListener('change', () => setTimeout(applyAchLang, 0));
  });

  onSnapshot(doc(db, 'omikujiUsers', sharedId), (snap) => {
    const data = snap.exists() ? snap.data() : {};
    const perks = data.sitePerks?.accountCenter || {};
    // 「アチーブメント設定を解放」を買った場合に加えて、称号を1つでも直接
    // 購入していれば、それも設定できるよう同様に解放扱いにする。
    myPurchasedTitleIds = PURCHASED_TITLES.filter((pt) => perks[pt.perkField]).map((pt) => pt.id);
    unlocked = !!perks.achievementSettingUnlocked || myPurchasedTitleIds.length > 0;
    equippedBadge = data.equippedBadge || null;
    myOmikujiAchIds = data.achievements || [];
    renderPicker();
  }, (e) => console.error('[achievementPicker] listen failed', e));

  onSnapshot(doc(db, 'sharedUserRoles', sharedId), (snap) => {
    const role = snap.exists() ? snap.data().role : null;
    hasPointExchangeAccess = role === 'admin' || role === 'debugger';
    renderPicker();
  }, (e) => console.error('[achievementPicker] role listen failed', e));

  loadConnect10Achievements(sharedId);
  applyAchLang();
}

initAchievementPicker();

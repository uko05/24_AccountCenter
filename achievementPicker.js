// achievementPicker.js
// アカウント管理画面の「アチーブメント設定」。
// 08_UPointで「アチーブメント設定を解放」(50UP)と交換するまでは非活性。
// 解放後は、原神おみくじ・コネクトバトル両方で獲得済みの実績から1つ選んで、
// omikujiUsers/{userId}.equippedBadge として称号を設定できる。
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

const i18n = {
  ja: {
    achTitle: 'アチーブメント設定',
    achDesc: '原神おみくじ・コネクトバトルで獲得した実績の中から1つ選んで、称号として設定できます。',
    achLockedText: 'この機能は「うーこポイント交換所」で「アチーブメント設定を解放」(50UP)と交換すると使えるようになります。',
    achLockedLinkBtn: 'ポイント交換所を開く',
    achEquippedLabel: '現在の称号：',
    achEquippedNone: '未設定',
    achClearBtn: '解除する',
    achSetBtn: '設定',
    achSetDone: '設定済み',
    achEmpty: 'まだ実績を獲得していません。原神おみくじやコネクトバトルで実績を獲得すると、ここから選べるようになります。',
    achFromOmikuji: '原神おみくじ',
    achFromConnect10: 'コネクトバトル',
    achSetOk: '称号を設定しました。',
    achClearOk: '称号を解除しました。',
    achSaveFail: '保存に失敗しました。時間をおいて再度お試しください。',
  },
  en: {
    achTitle: 'Achievement Title',
    achDesc: 'Pick one earned achievement from Genshin Omikuji or Connect Battle to display as your title.',
    achLockedText: 'Unlock this by redeeming "Unlock Achievement Setting" (50UP) on the Uko Point Exchange.',
    achLockedLinkBtn: 'Open Point Exchange',
    achEquippedLabel: 'Current title:',
    achEquippedNone: 'Not set',
    achClearBtn: 'Clear',
    achSetBtn: 'Equip',
    achSetDone: 'Equipped',
    achEmpty: "You haven't earned any achievements yet. Earn some on Genshin Omikuji or Connect Battle to pick from here.",
    achFromOmikuji: 'Genshin Omikuji',
    achFromConnect10: 'Connect Battle',
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
let connect10Loaded = false;

function els() {
  return {
    lockedNotice: document.getElementById('achievement-locked-notice'),
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

function renderPicker() {
  const { lockedNotice, picker, equippedDisplay, list } = els();
  if (!lockedNotice || !picker) return;

  lockedNotice.classList.toggle('hidden', unlocked);
  picker.classList.toggle('ach-disabled', !unlocked);

  if (equippedDisplay) {
    equippedDisplay.textContent = badgeLabel(equippedBadge);
    equippedDisplay.className = 'ach-equipped-badge' + (equippedBadge ? ` rarity-${equippedBadge.rarity || 'bronze'}` : '');
  }

  if (!list) return;
  list.innerHTML = '';

  const groups = [
    { site: 'omikuji', labelKey: 'achFromOmikuji', total: OMIKUJI_ACHIEVEMENTS.length,
      earned: myOmikujiAchIds.map((id) => OMIKUJI_ACHIEVEMENTS.find((a) => a.id === id)).filter(Boolean) },
    { site: 'connect10', labelKey: 'achFromConnect10', total: CONNECT10_ACHIEVEMENTS.length,
      earned: myConnect10AchIds.map((id) => CONNECT10_ACHIEVEMENTS.find((a) => a.id === id)).filter(Boolean) },
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

    const details = document.createElement('details');
    details.className = 'ach-group';
    details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'ach-group-header';
    summary.innerHTML = `<span class="ach-group-name">${t(labelKey)}</span><span class="ach-group-count">${earned.length} / ${total}</span>`;
    details.appendChild(summary);

    const itemsEl = document.createElement('div');
    itemsEl.className = 'ach-group-items';

    achs.forEach((ach) => {
      const isEquipped = !!equippedBadge && equippedBadge.site === site && equippedBadge.achievementId === ach.id;

      const item = document.createElement('div');
      item.className = 'ach-item';

      const textEl = document.createElement('div');
      textEl.className = 'ach-item-text';
      const nameEl = document.createElement('span');
      nameEl.className = 'ach-item-name';
      nameEl.textContent = (currentLang() === 'en' && ach.nameEn) ? ach.nameEn : ach.name;
      const rarityEl = document.createElement('span');
      rarityEl.className = `rarity-badge rarity-${ach.rarity || 'bronze'}`;
      rarityEl.textContent = ach.rarity || 'bronze';
      nameEl.appendChild(rarityEl);
      textEl.appendChild(nameEl);
      item.appendChild(textEl);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ach-set-btn${isEquipped ? ' set' : ''}`;
      btn.textContent = isEquipped ? t('achSetDone') : t('achSetBtn');
      btn.addEventListener('click', () => (isEquipped ? clearBadge() : equip(site, ach)));
      item.appendChild(btn);

      itemsEl.appendChild(item);
    });

    details.appendChild(itemsEl);
    list.appendChild(details);
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
    unlocked = !!data.sitePerks?.accountCenter?.achievementSettingUnlocked;
    equippedBadge = data.equippedBadge || null;
    myOmikujiAchIds = data.achievements || [];
    renderPicker();
  }, (e) => console.error('[achievementPicker] listen failed', e));

  loadConnect10Achievements(sharedId);
  applyAchLang();
}

initAchievementPicker();

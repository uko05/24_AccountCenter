// connectEngine.js — コネクトバトルの「ゲームの中身」だけを集めた部品(2026-10-25)
//
// 画面(DOM)・音・Firebase には一切触らない。盤面の計算、必殺技、CPUの考え方、勝敗判定だけ。
// 同じシード(乱数のもと)と同じ「プレイヤーの操作の記録」を与えれば、どこで動かしても必ず同じ結果になる。
//   - ブラウザ: レート戦でCPUと当たった時の対局(cpuMatch.js)がこれで進める
//   - サーバー: 24_AccountCenter/functions に同じファイルの写しを置き、対局を最初から再現して結果を確かめる
//     (このファイルを直したら、functions/connectEngine.mjs にも同じ内容をコピーすること)
//
// 決まりは CPU戦(soloLogic.js)と同じ。soloLogic.js の必殺技を直した時は、ここも同じように直すこと。
// ランダムはすべて state.rng から取る(Math.random は使わない)。
//
// 盤面: stones["列_行"] = 'red' | 'yellow'(行0が一番上)。側(side)は 'player' | 'cpu'。

export const ENGINE_VERSION = 1;
export const ROWS = 6;
export const COLS = 7;
export const ULT_COST = 150;
export const CHARGE_MAX = 200;
export const BOMB_TURNS = 2;
export const CASTORICE_REFUND = 5;
const ALHAITHAM_COLS = [2, 3, 4];
const CASTORICE_COLS = [0, 1, 5, 6];

// キャラの決まり(characterData.js と同じ値。サーバーはクライアントの申告ではなくこの表を使う)
export const CHARA_RULES = {
    '001': { charge: 14, turn: 10 }, '002': { charge: 15, turn: 6 }, '003': { charge: 11, turn: 10 },
    '004': { charge: 9, turn: 1 }, '005': { charge: 9, turn: 1 }, '006': { charge: 10, turn: 1 },
    '007': { charge: 15, turn: 6 }, '008': { charge: 13, turn: 6 }, '009': { charge: 16, turn: 5 },
    '010': { charge: 9, turn: 18 }, '011': { charge: 8, turn: 10 }, '012': { charge: 15, turn: 5 },
    '013': { charge: 14, turn: 1 }, '014': { charge: 15, turn: 8 }, '015': { charge: 16, turn: 1 },
    '016': { charge: 8, turn: 1 }, '017': { charge: 18, turn: 1 }, '018': { charge: 16, turn: 6 },
    '019': { charge: 12, turn: 6 }, '020': { charge: 15, turn: 8 },
};

// ---------------------------------------------------------------------------------------------
// 乱数(シードから決まる)。state.rng に [a,b,c,d] を持つので、state ごと保存・再開できる
function hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    const out = [];
    for (let i = 0; i < 4; i++) {
        h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
        out.push(h >>> 0);
    }
    return out;
}
function rand(st) { // sfc32 → [0,1)
    let [a, b, c, d] = st.rng;
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0; a = b ^ (b >>> 9); b = c + (c << 3) | 0; c = (c << 21) | (c >>> 11); c = c + t | 0;
    st.rng = [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
    return (t >>> 0) / 4294967296;
}
const rInt = (st, n) => Math.floor(rand(st) * n);
// abilities.js の getRandomElements と同じ選び方(数が足りなければ全部)
function pickN(st, arr, n) {
    if (arr.length < n) return arr.slice();
    const tmp = arr.slice(), out = [];
    while (out.length < n) out.push(tmp.splice(rInt(st, tmp.length), 1)[0]);
    return out;
}

// ---------------------------------------------------------------------------------------------
// 盤面の基本
export const otherColor = (c) => (c === 'red' ? 'yellow' : 'red');
const otherSide = (s) => (s === 'player' ? 'cpu' : 'player');
const key = (c, r) => `${c}_${r}`;
const parseKey = (k) => k.split('_').map(Number);

function dropRowOf(stones, col) { for (let r = ROWS - 1; r >= 0; r--) if (!stones[key(col, r)]) return r; return -1; }
function validCols(stones) { const v = []; for (let c = 0; c < COLS; c++) if (dropRowOf(stones, c) >= 0) v.push(c); return v; }
function boardOf(stones) {
    const b = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    for (const k in stones) { const [c, r] = parseKey(k); b[r][c] = stones[k]; }
    return b;
}
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
function runLen(b, r, c, dr, dc, color) { let n = 1; while (true) { const rr = r + n * dr, cc = c + n * dc; if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || b[rr][cc] !== color) break; n++; } return n; }
function firstLineColor(b) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const v = b[r][c]; if (!v) continue; for (const [dr, dc] of DIRS) if (runLen(b, r, c, dr, dc, v) >= 4) return v; }
    return null;
}
function hasLineOf(b, color) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { if (b[r][c] !== color) continue; for (const [dr, dc] of DIRS) if (runLen(b, r, c, dr, dc, color) >= 4) return true; }
    return false;
}
// 4つ並びに含まれるマス(勝利のハイライト用)。winCheck.js の collectWinPositions と同じ
export function winPositions(stones) {
    const b = boardOf(stones);
    const found = { red: new Set(), yellow: new Set() };
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const color = b[r][c]; if (!color) continue;
        for (const [dr, dc] of DIRS) {
            const back = runLen(b, r, c, -dr, -dc, color), fwd = runLen(b, r, c, dr, dc, color);
            if (back + fwd - 1 < 4) continue;
            for (let i = back - 1; i >= -(fwd - 1); i--) found[color].add(`${r - i * dr},${c - i * dc}`);
        }
    }
    const toList = (s) => (s.size >= 4 ? [...s].map((p) => p.split(',').map(Number)) : null);
    return { red: toList(found.red), yellow: toList(found.yellow) };
}
function gravityAll(stones) {
    const out = {};
    for (let c = 0; c < COLS; c++) {
        const col = []; for (let r = ROWS - 1; r >= 0; r--) if (stones[key(c, r)]) col.push(stones[key(c, r)]);
        col.forEach((v, i) => { out[key(c, ROWS - 1 - i)] = v; });
    }
    return out;
}
function threatIn(stones, color) { // color が次の1手で並べられるか
    for (const c of validCols(stones)) { const r = dropRowOf(stones, c); const s2 = { ...stones, [key(c, r)]: color }; if (hasLineOf(boardOf(s2), color)) return true; }
    return false;
}
function wouldWinCol(stones, col, color) { const r = dropRowOf(stones, col); if (r < 0) return false; const s2 = { ...stones, [key(col, r)]: color }; return firstLineColor(boardOf(s2)) === color; }
function colCounts(stones, c, enemy) { let op = 0, me = 0; for (let r = 0; r < ROWS; r++) { const v = stones[key(c, r)]; if (!v) continue; if (v === enemy) op++; else me++; } return { op, me }; }
function pickMaxEnemyColumn(stones, enemy) {
    let best = -1, bk = -Infinity;
    for (let c = 0; c < COLS; c++) { const { op, me } = colCounts(stones, c, enemy); if (!op) continue; const k = op * 100 + (op - me); if (k > bk) { bk = k; best = c; } }
    return best;
}
function pickMaxEnemyRow(stones, enemy) {
    let best = -1, bk = -Infinity;
    for (let r = 0; r < ROWS; r++) { let op = 0, me = 0; for (let c = 0; c < COLS; c++) { const v = stones[key(c, r)]; if (!v) continue; if (v === enemy) op++; else me++; } if (!op) continue; const k = op * 100 + (op - me); if (k > bk) { bk = k; best = r; } }
    return best;
}
function pickTopEnemyColumns(stones, cands, k, enemy) {
    return cands.map((c) => { const { op, me } = colCounts(stones, c, enemy); return { c, op, key: op * 100 + (op - me) }; })
        .filter((x) => x.op > 0).sort((a, b) => b.key - a.key).slice(0, k).map((x) => x.c);
}
function gravityFlipStones(stones) {
    const out = {}, moved = {};
    for (let c = 0; c < COLS; c++) {
        const ks = []; for (let r = 0; r < ROWS; r++) if (stones[key(c, r)]) ks.push(key(c, r));
        ks.forEach((k, i) => { const to = key(c, ROWS - 1 - i); out[to] = stones[k]; moved[k] = to; });
    }
    return { stones: out, moved };
}
function flipNeighbors(col, row) { const ks = []; if (col - 1 >= 0) ks.push(key(col - 1, row)); if (col + 1 < COLS) ks.push(key(col + 1, row)); return ks; }
function bombValue(S, t, op) { let x = 0; for (const k of bombBlast(t)) { if (S[k] === op) x++; else if (S[k]) x--; } return x; }
function bestBombTargets(S, op) {
    let best = -Infinity, out = [];
    for (const t of Object.keys(S)) { if (S[t] !== op) continue; const x = bombValue(S, t, op); if (x > best) { best = x; out = [t]; } else if (x === best) out.push(t); }
    return out;
}
function bombBlast(k) {
    const [c, r] = parseKey(k); const out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS) out.push(key(cc, rr)); }
    return out;
}

// ---------------------------------------------------------------------------------------------
// 対局の状態
// opts: { seed, playerCharaID, cpuCharaID, playerColor?, firstSide? }
export function createMatch(opts) {
    const st = {
        v: ENGINE_VERSION,
        rng: hashSeed(String(opts.seed)),
        chara: { player: opts.playerCharaID, cpu: opts.cpuCharaID },
        color: { player: opts.playerColor || 'red', cpu: otherColor(opts.playerColor || 'red') },
        stones: {}, turn: 'player', turnCount: 1, changeStone: 0,
        charge: { player: 0, cpu: 0 }, ultCount: { player: 0, cpu: 0 }, wins: { player: 0, cpu: 0 }, timeouts: { player: 0, cpu: 0 },
        startingSide: 'player', round: 1,
        zhongli: { blocked: [], reblock: 0, caster: null },
        durin: { pending: false, caster: null },
        cerydra: { active: false, caster: null },
        bomb: null, flipTouchPending: null,
        over: false, result: null, // result: 'player' | 'cpu' | 'draw'
        resultType: null,          // 'normal' | 'timeout' | 'leave'
        straight: false,
    };
    for (const s of ['player', 'cpu']) if (!CHARA_RULES[st.chara[s]]) throw new Error('unknown chara ' + st.chara[s]);
    // 対人戦と同じく、最初のラウンドは赤が先手(色はサーバーがランダムに決める)。2ラウンド目からは負けた側が先手
    st.startingSide = opts.firstSide || (st.color.player === 'red' ? 'player' : 'cpu');
    st.turn = st.startingSide;
    return st;
}
const colorOf = (st, side) => st.color[side];
const dropColor = (st, side) => (st.changeStone > 0 ? otherColor(st.color[side]) : st.color[side]);

// 石を壊す(+必要なら重力)。爆弾の位置も一緒に追いかける
function destroy(st, keys, gravity, ev) {
    keys = [...new Set(keys)].filter((k) => st.stones[k]);
    if (!keys.length) return;
    let bomb = st.bomb;
    if (bomb && keys.includes(bomb.key)) bomb = st.bomb = null;
    const [bc, br] = bomb ? parseKey(bomb.key) : [-1, -1];
    const below = bomb ? keys.filter((k) => { const [c, r] = parseKey(k); return c === bc && r > br; }).length : 0;
    for (const k of keys) delete st.stones[k];
    ev.push({ t: 'destroy', keys, gravity: !!gravity });
    if (gravity) {
        st.stones = gravityAll(st.stones);
        if (bomb && below) bomb.key = key(bc, br + below);
    }
}
function addCharge(st, side, v) { st.charge[side] = Math.min(CHARGE_MAX, st.charge[side] + v); }

export function ultAvailable(st, side) {
    if (st.over || st.turn !== side) return false;
    if (st.charge[side] < ULT_COST) return false;
    if (st.turnCount < CHARA_RULES[st.chara[side]].turn) return false;
    if (st.chara[side] === '005' && st.changeStone > 0) return false;
    return true;
}
export function blockedFor(st, side) { // side がこのターン置けない列(鍾離)
    return st.zhongli.caster && st.zhongli.caster !== side ? st.zhongli.blocked : [];
}
export function playableCols(st, side) {
    const bl = blockedFor(st, side);
    const v = validCols(st.stones).filter((c) => !bl.includes(c));
    return v.length ? v : validCols(st.stones);
}

// ---------------------------------------------------------------------------------------------
// 必殺技の中身(soloLogic.js の executeAbility と同じ)
function applyUltEffect(st, side, charaID, ev) {
    const me = colorOf(st, side), op = otherColor(me);
    const S = st.stones;
    switch (charaID) {
        case '001': case '002': { // 放浪者: ランダム4列の上から2個 / シトラリ: ランダム3列の一番上
            const [n, depth] = charaID === '001' ? [4, 2] : [3, 1];
            const colsWith = [...new Set(Object.keys(S).map((k) => k.split('_')[0]))];
            const chosen = pickN(st, colsWith, Math.min(n, colsWith.length));
            const keys = [];
            for (const cs of chosen) {
                const c = Number(cs); let top = ROWS;
                for (let r = 0; r < ROWS; r++) if (S[key(c, r)]) { top = r; break; }
                for (let i = 0; i < depth && top + i < ROWS; i++) if (S[key(c, top + i)]) keys.push(key(c, top + i));
            }
            destroy(st, keys, false, ev);
            break;
        }
        case '003': case '007': {
            const picked = charaID === '003' ? pickTopEnemyColumns(S, ALHAITHAM_COLS, 2, op) : pickTopEnemyColumns(S, CASTORICE_COLS, 3, op);
            const keys = Object.keys(S).filter((k) => picked.includes(parseKey(k)[0]));
            const own = keys.filter((k) => S[k] === me).length;
            destroy(st, keys, false, ev);
            if (charaID === '007' && own > 0) { addCharge(st, side, own * CASTORICE_REFUND); ev.push({ t: 'charge' }); }
            break;
        }
        case '004': { const keys = []; for (let c = 0; c < COLS; c++) for (let r = 0; r <= 2; r++) keys.push(key(c, r)); destroy(st, keys, false, ev); break; }
        case '005': st.changeStone = st.changeStone === 0 ? 2 : 3; ev.push({ t: 'colorSwap' }); break;
        case '006': { const r = pickMaxEnemyRow(S, op); if (r >= 0) destroy(st, Object.keys(S).filter((k) => parseKey(k)[1] === r), true, ev); break; }
        case '008': { const c = pickMaxEnemyColumn(S, op); if (c >= 0) destroy(st, Object.keys(S).filter((k) => parseKey(k)[0] === c), false, ev); break; }
        case '009': { // ホタル: ランダムな空き列に自分の石(打つ石なので色反転の影響を受ける)
            const v = validCols(S);
            if (v.length) { const c = v[rInt(st, v.length)]; const r = dropRowOf(S, c); S[key(c, r)] = dropColor(st, side); ev.push({ t: 'drop', col: c, row: r, color: S[key(c, r)], extra: true }); st.turnCount++; }
            break;
        }
        case '010': { // ルアン・メェイ: 相手3個を自分の色に → 並ばなければ自分の石6個を破壊(重力)
            const conv = pickN(st, Object.keys(S).filter((k) => S[k] === op), 3);
            if (conv.length) { for (const k of conv) S[k] = me; ev.push({ t: 'convert', keys: conv, color: me }); }
            if (firstLineColor(boardOf(S))) break;
            destroy(st, pickN(st, Object.keys(S).filter((k) => S[k] === me), 6), true, ev);
            break;
        }
        case '011': destroy(st, Object.keys(S).filter((k) => k.endsWith('_4') && S[k] === op), true, ev); break;
        case '012': {
            const v = validCols(S);
            st.zhongli = { blocked: pickN(st, v, Math.min(2, v.length)), reblock: 2, caster: side };
            ev.push({ t: 'block', cols: st.zhongli.blocked });
            break;
        }
        case '013': { // サフェル: 相手の必殺技をコピー(相手もサフェルなら不発)
            const oc = st.chara[otherSide(side)];
            if (oc !== '013') applyUltEffect(st, side, oc, ev);
            break;
        }
        case '014': { // ドゥリン: 相手の石を1個破壊。次の自分の番の開始時にも相手の石を1個(2026-10-30)
            const pool = Object.keys(S).filter((k) => S[k] === op);
            destroy(st, pickN(st, pool, Math.min(1, pool.length)), true, ev); st.durin = { pending: true, caster: side }; break;
        }
        case '015': st.cerydra = { active: true, caster: side }; break;
        case '016': st.wins[side]++; ev.push({ t: 'point', side }); if (st.wins[side] >= 3) finishMatch(st, side, 'normal', ev); break;
        case '017': { // アベンチュリン: ダイスロール
            const n = 1 + rInt(st, 6);
            ev.push({ t: 'dice', n });
            const keysOf = (color) => Object.keys(st.stones).filter((k) => st.stones[k] === color);
            if (n === 1) destroy(st, pickN(st, keysOf(me), 2), true, ev);
            else if (n === 2) addCharge(st, otherSide(side), 50);
            else if (n === 3) destroy(st, pickN(st, keysOf(op), 1), true, ev);
            else if (n === 4) { const ks = pickN(st, keysOf(op), 1); if (ks.length) { for (const k of ks) st.stones[k] = me; ev.push({ t: 'convert', keys: ks, color: me }); } }
            else if (n === 5) {
                const v = validCols(st.stones);
                if (v.length) { const c = v[rInt(st, v.length)]; const r = dropRowOf(st.stones, c); st.stones[key(c, r)] = dropColor(st, side); ev.push({ t: 'drop', col: c, row: r, color: st.stones[key(c, r)], extra: true }); st.turnCount++; }
                addCharge(st, side, 50);
            } else destroy(st, pickN(st, keysOf(op), 3), true, ev);
            ev.push({ t: 'charge' });
            break;
        }
        case '018': { // クレー: 一番多く相手の石を巻き込める相手の石を爆弾に(次の自分の番の開始時に周り8マスを破壊)
            const tgt = pickN(st, bestBombTargets(S, op), 1)[0];
            if (tgt) { st.bomb = { key: tgt, turnsLeft: BOMB_TURNS, caster: side }; ev.push({ t: 'bomb', key: tgt }); }
            break;
        }
        case '019': st.flipTouchPending = side; break;
        case '020': { // 星神★アッハ: 重力反転
            const { stones, moved } = gravityFlipStones(S);
            st.stones = stones;
            if (st.bomb) st.bomb.key = moved[st.bomb.key] || st.bomb.key;
            ev.push({ t: 'gravityFlip' });
            break;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// 進行
function finishMatch(st, winner, resultType, ev) {
    st.over = true; st.result = winner; st.resultType = resultType;
    if (winner !== 'draw') st.straight = st.wins[otherSide(winner)] === 0;
    ev.push({ t: 'matchEnd', result: winner, resultType });
}
function newRound(st, ev) {
    st.stones = {}; st.turnCount = 1; st.changeStone = 0; st.round++;
    st.zhongli = { blocked: [], reblock: 0, caster: null };
    st.durin = { pending: false, caster: null };
    st.cerydra = { active: false, caster: null };
    st.bomb = null; st.flipTouchPending = null;
    st.turn = st.startingSide;
    ev.push({ t: 'newRound', round: st.round, first: st.turn });
}
// soloLogic.js の checkGameEnd と同じ。決着(ラウンド/試合)したら true
function checkEnd(st, ev) {
    if (st.over) return true;
    const w = winPositions(st.stones);
    const pc = st.color.player, cc = st.color.cpu;
    if (w[pc] && w[cc]) {
        st.wins.player++; st.wins.cpu++;
        ev.push({ t: 'roundEnd', winner: 'draw', positions: [...w[pc], ...w[cc]] });
        if (st.wins.player >= 3 && st.wins.cpu >= 3) finishMatch(st, 'draw', 'normal', ev);
        else if (st.wins.player >= 3 || st.wins.cpu >= 3) finishMatch(st, st.wins.player >= 3 ? 'player' : 'cpu', 'normal', ev);
        else { st.startingSide = rand(st) < 0.5 ? 'player' : 'cpu'; newRound(st, ev); }
        return true;
    }
    const line = w[pc] ? 'player' : w[cc] ? 'cpu' : null;
    if (line) {
        st.wins[line]++;
        ev.push({ t: 'roundEnd', winner: line, positions: w[colorOf(st, line)] });
        if (st.wins[line] >= 3) finishMatch(st, line, 'normal', ev);
        else { st.startingSide = otherSide(line); newRound(st, ev); }
        return true;
    }
    if (!validCols(st.stones).length) { // 満杯: ランダムな縦1列を全部消して続ける
        const colsWith = [...new Set(Object.keys(st.stones).map((k) => k.split('_')[0]))];
        const c = Number(colsWith[rInt(st, colsWith.length)]);
        destroy(st, Object.keys(st.stones).filter((k) => parseKey(k)[0] === c), false, ev);
    }
    return false;
}
// 番の開始時の効果(鍾離の再封鎖・ドゥリンの自動破壊・爆弾)。決着したら true
function preTurn(st, side, ev) {
    if (st.zhongli.reblock > 0 && st.zhongli.caster === side) {
        st.zhongli.reblock--;
        const v = validCols(st.stones);
        st.zhongli.blocked = pickN(st, v, Math.min(2, v.length));
        ev.push({ t: 'block', cols: st.zhongli.blocked });
    }
    if (st.durin.pending && st.durin.caster === side) {
        st.durin = { pending: false, caster: null };
        const vc = otherColor(colorOf(st, side));
        const all = Object.keys(st.stones).filter((k) => st.stones[k] === vc);
        destroy(st, pickN(st, all, Math.min(1, all.length)), true, ev);
    }
    if (st.bomb) {
        st.bomb.turnsLeft--;
        if (st.bomb.turnsLeft <= 0) {
            const blast = bombBlast(st.bomb.key).filter((k) => st.stones[k]);
            st.bomb = null;
            ev.push({ t: 'bombExplode' });
            destroy(st, blast, true, ev);
        }
    }
    return checkEnd(st, ev);
}
// side の番を始める(番の開始時の効果も処理する)。効果で決着して新しいラウンドに入った場合は
// st.turn がそのラウンドの先攻になる(新しいラウンドは効果がリセット済みなので、もう一度は処理しない)
function startTurn(st, side, ev) {
    st.turn = side;
    if (!st.over) preTurn(st, side, ev);
    if (!st.over) ev.push({ t: 'turn', side: st.turn });
}

// 必殺技を使う
export function doUlt(st, side) {
    const ev = [];
    if (!ultAvailable(st, side)) throw new Error('ult not available');
    st.charge[side] -= ULT_COST; st.ultCount[side]++;
    ev.push({ t: 'ult', side, chara: st.chara[side] });
    applyUltEffect(st, side, st.chara[side], ev);
    const roundBefore = st.round;
    if (checkEnd(st, ev) && !st.over && st.round !== roundBefore) ev.push({ t: 'turn', side: st.turn });
    return ev;
}

// 石を落とす(番の終わりまで進め、相手の番の開始時効果まで処理する)
export function doDrop(st, side, col) {
    const ev = [];
    if (st.over || st.turn !== side) throw new Error('not your turn');
    if (!playableCols(st, side).includes(col)) throw new Error('column not playable ' + col);
    const row = dropRowOf(st.stones, col);
    st.stones[key(col, row)] = dropColor(st, side);
    ev.push({ t: 'drop', col, row, color: st.stones[key(col, row)] });
    // 反転の一手
    if (st.flipTouchPending === side) {
        st.flipTouchPending = null;
        const ks = flipNeighbors(col, row).filter((k) => st.stones[k]);
        for (const k of ks) st.stones[k] = otherColor(st.stones[k]);
        st.stones[key(col, row)] = otherColor(st.stones[key(col, row)]);
        ev.push({ t: 'flip', keys: [...ks, key(col, row)] });
    }
    // ケリュドラ(2026-10-30 改): 使った側の相手が置いた後、空いている全部の列に相手の本来の色の石を1つずつ落とし、
    // その落とした石のうちランダムな1つを使った側の色に変える
    if (st.cerydra.active && st.cerydra.caster !== side) {
        st.cerydra = { active: false, caster: null };
        const vc = colorOf(st, side);
        const dropped = [];
        for (const c of validCols(st.stones)) {
            const r = dropRowOf(st.stones, c);
            st.stones[key(c, r)] = vc; dropped.push(key(c, r));
            ev.push({ t: 'drop', col: c, row: r, color: vc, extra: true });
        }
        if (dropped.length) {
            const k = dropped[rInt(st, dropped.length)];
            st.stones[k] = otherColor(vc);
            ev.push({ t: 'convert', keys: [k], color: otherColor(vc) });
        }
    }
    addCharge(st, side, CHARA_RULES[st.chara[side]].charge);
    if (st.changeStone > 0) st.changeStone--;
    st.turnCount++;
    // 鍾離: 封鎖された側が置き終えたら封鎖を外す(残り回数があれば使った側の番の開始時にまた封鎖)
    if (st.zhongli.caster && st.zhongli.caster !== side) {
        st.zhongli.blocked = [];
        if (st.zhongli.reblock <= 0) st.zhongli.caster = null;
        ev.push({ t: 'block', cols: [] });
    }
    const roundBefore = st.round;
    if (checkEnd(st, ev)) {
        if (!st.over && st.round !== roundBefore) startTurn(st, st.turn, ev);
        return ev;
    }
    startTurn(st, otherSide(side), ev);
    return ev;
}

// 時間切れ: 2回目で負け。1回目はランダムな列に落とす
export function doTimeout(st, side) {
    if (st.over || st.turn !== side) throw new Error('not your turn');
    st.timeouts[side]++;
    if (st.timeouts[side] >= 2) { const ev = []; finishMatch(st, otherSide(side), 'timeout', ev); return ev; }
    const v = playableCols(st, side);
    return doDrop(st, side, v[rInt(st, v.length)]);
}
// 退出: 退出した側の負け
export function doLeave(st, side) {
    const ev = [];
    if (!st.over) finishMatch(st, otherSide(side), 'leave', ev);
    return ev;
}

// ---------------------------------------------------------------------------------------------
// CPUの考え方(soloLogic.js の minimax・発動条件と同じ)
function scoreWindow(a, b, c, d, me) {
    let m = 0, t = 0, e = 0;
    for (const v of [a, b, c, d]) { if (v === null) e++; else if (v === me) m++; else t++; }
    if (m === 4) return 100000; if (t === 4) return -100000;
    if (m === 3 && e === 1) return 5; if (m === 2 && e === 2) return 2;
    if (t === 3 && e === 1) return -4; if (t === 2 && e === 2) return -1;
    return 0;
}
function topStonesBonus(b, me, depth, w) {
    let x = 0;
    for (let c = 0; c < COLS; c++) { let seen = 0; for (let r = 0; r < ROWS && seen < depth; r++) { if (!b[r][c]) continue; x += b[r][c] === me ? -w : w; seen++; } }
    return x;
}
function characterBonus(b, me, charaID, oppCharaID) {
    if (charaID === '013') return (!oppCharaID || oppCharaID === '013') ? 0 : characterBonus(b, me, oppCharaID, null);
    const op = otherColor(me);
    let x = 0;
    switch (charaID) {
        case '001': return topStonesBonus(b, me, 2, 2);
        case '002': return topStonesBonus(b, me, 1, 2);
        case '004': for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { if (b[r][c] === me) x += r >= 3 ? 4 : -2; else if (b[r][c] === op) x -= r >= 3 ? 1 : 0; } return x;
        case '003': for (let r = 0; r < ROWS; r++) for (const c of ALHAITHAM_COLS) { if (b[r][c] === me) x -= 3; else if (b[r][c] === op) x += 3; } return x;
        case '007': for (let r = 0; r < ROWS; r++) for (const c of CASTORICE_COLS) { if (b[r][c] === me) x -= 3; else if (b[r][c] === op) x += 3; } return x;
        case '011': for (let c = 0; c < COLS; c++) if (b[4][c] === op) x += 5; return x;
    }
    return 0;
}
function evaluate(b, me, charaID, oppCharaID) {
    let s = 0;
    for (let r = 0; r < ROWS; r++) { if (b[r][3] === me) s += 3; else if (b[r][3]) s -= 3; }
    for (let r = 0; r < ROWS; r++) for (let c = 0; c <= COLS - 4; c++) s += scoreWindow(b[r][c], b[r][c + 1], b[r][c + 2], b[r][c + 3], me);
    for (let c = 0; c < COLS; c++) for (let r = 0; r <= ROWS - 4; r++) s += scoreWindow(b[r][c], b[r + 1][c], b[r + 2][c], b[r + 3][c], me);
    for (let r = 0; r <= ROWS - 4; r++) for (let c = 0; c <= COLS - 4; c++) s += scoreWindow(b[r][c], b[r + 1][c + 1], b[r + 2][c + 2], b[r + 3][c + 3], me);
    for (let r = 0; r <= ROWS - 4; r++) for (let c = 3; c < COLS; c++) s += scoreWindow(b[r][c], b[r + 1][c - 1], b[r + 2][c - 2], b[r + 3][c - 3], me);
    return s + characterBonus(b, me, charaID, oppCharaID);
}
const ORDER = [3, 2, 4, 1, 5, 0, 6];
function minimax(b, depth, al, be, maxi, me, ctx) {
    ctx.nodes++;
    const w = firstLineColor(b);
    if (w === me) return { s: 1000000 + depth };
    if (w) return { s: -1000000 - depth };
    const v = ORDER.filter((c) => !b[0][c]);
    if (!v.length) return { s: 0 };
    if (depth === 0) return { s: evaluate(b, me, ctx.chara, ctx.oppChara) };
    let best = v[0];
    const drop = (c) => { for (let r = ROWS - 1; r >= 0; r--) if (!b[r][c]) return r; return -1; };
    if (maxi) {
        let val = -Infinity;
        for (const c of v) { const r = drop(c); b[r][c] = me; const x = minimax(b, depth - 1, al, be, false, me, ctx).s; b[r][c] = null; if (x > val) { val = x; best = c; } al = Math.max(al, val); if (al >= be) break; }
        return { s: val, c: best };
    }
    let val = Infinity;
    const op = otherColor(me);
    for (const c of v) { const r = drop(c); b[r][c] = op; const x = minimax(b, depth - 1, al, be, true, me, ctx).s; b[r][c] = null; if (x < val) { val = x; best = c; } be = Math.min(be, val); if (al >= be) break; }
    return { s: val, c: best };
}

// 必殺技を使うと即勝ちになるか(相手は並ばない)
function ultWinsNow(st, side, charaID) {
    const me = colorOf(st, side), op = otherColor(me), S = st.stones;
    const wins = (sim) => { const b = boardOf(sim); return hasLineOf(b, me); };
    switch (charaID) {
        case '004': { const s = { ...S }; for (let c = 0; c < COLS; c++) for (let r = 0; r < 3; r++) delete s[key(c, r)]; return wins(s); }
        case '006': { const r = pickMaxEnemyRow(S, op); if (r < 0) return false; const s = { ...S }; for (let c = 0; c < COLS; c++) delete s[key(c, r)]; return wins(gravityAll(s)); }
        case '003': case '007': {
            const picked = charaID === '003' ? pickTopEnemyColumns(S, ALHAITHAM_COLS, 2, op) : pickTopEnemyColumns(S, CASTORICE_COLS, 3, op);
            const s = { ...S }; for (const c of picked) for (let r = 0; r < ROWS; r++) delete s[key(c, r)];
            const b = boardOf(s); return hasLineOf(b, me) && !hasLineOf(b, op);
        }
        case '011': { const s = { ...S }; for (let c = 0; c < COLS; c++) if (s[key(c, 4)] === op) delete s[key(c, 4)]; return wins(gravityAll(s)); }
        case '002': {
            const cs = []; for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (S[key(c, r)]) { cs.push(c); break; }
            if (cs.length < 3) return false;
            for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) for (let k = j + 1; k < cs.length; k++) {
                const s = { ...S };
                for (const c of [cs[i], cs[j], cs[k]]) for (let r = 0; r < ROWS; r++) if (s[key(c, r)]) { delete s[key(c, r)]; break; }
                if (wins(s)) return true;
            }
            return false;
        }
    }
    return false;
}
// ult の発動条件(soloLogic.js の cpuAbilityConditionByID)。plan に hanabiCol / flipCol を書く
function ultCondition(st, side, charaID, plan) {
    const me = colorOf(st, side), op = otherColor(me), S = st.stones;
    const opThreat = () => threatIn(S, op);
    switch (charaID) {
        case '020': { const sim = gravityFlipStones(S).stones; const b = boardOf(sim); if (hasLineOf(b, op)) return false; if (hasLineOf(b, me)) return true; return opThreat() && !threatIn(sim, op); }
        case '018': {
            const t = bestBombTargets(S, op)[0]; if (!t) return false;
            return bombValue(S, t, op) >= 3;
        }
        case '019': {
            const dc = dropColor(st, side);
            for (const c of validCols(S)) {
                const r = dropRowOf(S, c); const sim = { ...S, [key(c, r)]: dc };
                for (const k of flipNeighbors(c, r)) if (sim[k]) sim[k] = otherColor(sim[k]);
                sim[key(c, r)] = otherColor(sim[key(c, r)]);
                const b = boardOf(sim);
                if (hasLineOf(b, me) && !hasLineOf(b, op)) { plan.flipCol = c; return true; }
            }
            return false;
        }
        // ケリュドラ: 「この列にもう1つ積まれれば、その上に置いて勝てる」列があるときだけ使う
        case '015': return validCols(S).some((c) => { const r = dropRowOf(S, c); if (r <= 0) return false; return wouldWinCol({ ...S, [key(c, r)]: op }, c, me); });
        case '009': case '016': case '017': return true;
        case '011': { let n = 0; for (let c = 0; c < COLS; c++) if (S[key(c, 4)] === op) n++; return n >= 2 || opThreat(); }
        case '006': {
            const r = pickMaxEnemyRow(S, op); if (r < 0) return false;
            let nOp = 0, nMe = 0; for (let c = 0; c < COLS; c++) { const v = S[key(c, r)]; if (v === op) nOp++; else if (v) nMe++; }
            if (nOp - nMe >= 2) return true;
            const s = { ...S }; for (let c = 0; c < COLS; c++) delete s[key(c, r)];
            return opThreat() && !threatIn(gravityAll(s), op);
        }
        case '008': {
            const c = pickMaxEnemyColumn(S, op); if (c < 0) return false;
            const { op: nOp, me: nMe } = colCounts(S, c, op);
            if (nOp - nMe >= 2) return true;
            const s = { ...S }; for (let r = 0; r < ROWS; r++) delete s[key(c, r)];
            return opThreat() && !threatIn(s, op);
        }
        case '003': case '007': {
            const picked = charaID === '003' ? pickTopEnemyColumns(S, ALHAITHAM_COLS, 2, op) : pickTopEnemyColumns(S, CASTORICE_COLS, 3, op);
            if (!picked.length) return false;
            let nOp = 0, nMe = 0; for (const c of picked) { const x = colCounts(S, c, op); nOp += x.op; nMe += x.me; }
            if (nOp - nMe >= 2) return true;
            const s = { ...S }; for (const c of picked) for (let r = 0; r < ROWS; r++) delete s[key(c, r)];
            return opThreat() && !threatIn(s, op);
        }
        case '005': { // 花火: セットアップ石(相手色で記録される)の上に次の手で勝てる列
            for (let c = 0; c < COLS; c++) if (wouldWinCol(S, c, me)) return false;
            for (let c = 0; c < COLS; c++) {
                const r = dropRowOf(S, c); if (r <= 0) continue;
                const s = { ...S, [key(c, r)]: op };
                if (wouldWinCol(s, c, me) && firstLineColor(boardOf(s)) !== op) { plan.hanabiCol = c; return true; }
            }
            return false;
        }
        case '002': {
            let opTop = 0, occ = 0;
            for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (S[key(c, r)]) { occ++; if (S[key(c, r)] === op) opTop++; break; }
            return occ >= 3 && opTop > occ / 2;
        }
        case '012': return !validCols(S).some((c) => wouldWinCol(S, c, me));
        case '010': { const o = Object.values(S).filter((v) => v === op).length, m = Object.values(S).filter((v) => v === me).length; return o >= 3 && m >= 6; }
        case '001': return Object.values(S).filter((v) => v === op).length >= 6;
        case '004': { let n = 0; for (const k in S) if (parseKey(k)[1] <= 2 && S[k] === op) n++; return n >= 2; }
    }
    return opThreat() || st.charge[otherSide(side)] > st.charge[side] + 30;
}

// profile: { depth, mistake(0〜1) }。戻り値 { ult: bool, hanabiCol, flipCol }
export function cpuWantsUlt(st, side) {
    const plan = { ult: false, hanabiCol: -1, flipCol: -1 };
    if (!ultAvailable(st, side)) return plan;
    const ch = st.chara[side];
    if (ultWinsNow(st, side, ch)) { plan.ult = true; return plan; }
    if (ch === '013') {
        const oc = st.chara[otherSide(side)];
        if (oc === '013') return plan;
        plan.ult = ultCondition(st, side, oc, plan);
        return plan;
    }
    plan.ult = ultCondition(st, side, ch, plan);
    return plan;
}
// 落とす列を決める。plan は cpuWantsUlt の結果(必殺技を使った後に呼ぶ)
export function cpuChooseCol(st, side, profile, plan = {}) {
    const me = colorOf(st, side), op = otherColor(me);
    const playable = playableCols(st, side);
    if (plan.hanabiCol >= 0 && playable.includes(plan.hanabiCol)) return plan.hanabiCol;
    if (plan.flipCol >= 0 && playable.includes(plan.flipCol)) return plan.flipCol;
    // 読み間違い(人間らしい凡ミス): すぐ勝てる時は見逃さない。相手にすぐ勝たせる手はなるべく避ける
    if (profile.mistake > 0 && rand(st) < profile.mistake && !playable.some((c) => wouldWinCol(st.stones, c, me))) {
        const safe = playable.filter((c) => { const r = dropRowOf(st.stones, c); const s = { ...st.stones, [key(c, r)]: me }; return !threatIn(s, op); });
        const pool = safe.length ? safe : playable;
        return pool[rInt(st, pool.length)];
    }
    const ctx = { nodes: 0, chara: st.chara[side], oppChara: st.chara[otherSide(side)] };
    const res = minimax(boardOf(st.stones), profile.depth, -Infinity, Infinity, true, me, ctx);
    if (res.c !== undefined && playable.includes(res.c)) return res.c;
    return playable[0];
}
// CPUの1手分(必殺技の判断 → 使う → 列を決めて落とす)。cpuMatch.js は演出のために段階ごとに呼ぶが、
// サーバーの再現とシミュレーションはこれで進める
export function cpuStep(st, side, profile) {
    const ev = [];
    const plan = cpuWantsUlt(st, side);
    if (plan.ult) {
        ev.push(...doUlt(st, side));
        if (st.over || st.turn !== side) return ev; // 銀狼の決着など
    }
    ev.push(...doDrop(st, side, cpuChooseCol(st, side, profile, plan)));
    return ev;
}

// ---------------------------------------------------------------------------------------------
// 再現(サーバーで使う)。log はプレイヤーの操作の配列: { a: 'u' }(必殺技) / { a: 'd', c: 列 } / { a: 't' }(時間切れ) / { a: 'l' }(退出)
// CPU の手はシードから決まるので記録しない。戻り値は最後の state(不正な操作があれば例外)
export function replay({ seed, playerCharaID, cpuCharaID, playerColor, profile }, log) {
    const st = createMatch({ seed, playerCharaID, cpuCharaID, playerColor });
    let i = 0, guard = 0;
    while (!st.over) {
        if (++guard > 5000) throw new Error('too long');
        if (st.turn === 'cpu') { cpuStep(st, 'cpu', profile); continue; }
        const op = log[i++];
        if (!op) break; // 記録が途中で終わっている(未決着)
        if (op.a === 'u') doUlt(st, 'player');
        else if (op.a === 'd') doDrop(st, 'player', op.c);
        else if (op.a === 't') doTimeout(st, 'player');
        else if (op.a === 'l') doLeave(st, 'player');
        else throw new Error('bad op');
    }
    if (i < log.length && !(log[i]?.a === 'l')) { /* 決着後の余分な操作は無視 */ }
    return st;
}

// CPUのレートから強さを決める(2026-10-25 決定)
export function profileForRating(rating) {
    if (rating >= 2000) return { depth: 8, mistake: 0 };
    if (rating >= 1800) return { depth: 6, mistake: 0 };
    if (rating >= 1600) return { depth: 5, mistake: 0 };
    if (rating >= 1450) return { depth: 4, mistake: 0.03 };
    if (rating >= 1300) return { depth: 3, mistake: 0.08 };
    return { depth: 2, mistake: 0.15 };
}

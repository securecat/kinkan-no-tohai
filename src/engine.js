"use strict";
/* ==========================================================
   麻雀ルールエンジン(UI非依存)
   牌種 kind: 0-8 萬子, 9-17 筒子, 18-26 索子, 27-33 字牌(東南西北白發中)
   ========================================================== */

const KIND_NAMES = (() => {
  const nums = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const names = [];
  for (const suit of ["萬", "筒", "索"]) {
    for (const n of nums) names.push(n + suit);
  }
  names.push("東", "南", "西", "北", "白", "發", "中");
  return names;
})();

const EAST = 27, SOUTH = 28, WEST = 29, NORTH = 30;
const HAKU = 31, HATSU = 32, CHUN = 33;

const suitOf = (k) => (k < 9 ? 0 : k < 18 ? 1 : k < 27 ? 2 : 3);
const numOf = (k) => (k < 27 ? (k % 9) + 1 : 0);
const isHonor = (k) => k >= 27;
const isTerminal = (k) => !isHonor(k) && (numOf(k) === 1 || numOf(k) === 9);
const isYaochuu = (k) => isHonor(k) || isTerminal(k);

function toCounts(kinds) {
  const c = new Array(34).fill(0);
  for (const k of kinds) c[k]++;
  return c;
}

function doraNext(ind) {
  if (ind < 27) {
    const n = numOf(ind);
    return n === 9 ? ind - 8 : ind + 1;
  }
  if (ind <= NORTH) return ind === NORTH ? EAST : ind + 1;
  return ind === CHUN ? HAKU : ind + 1;
}

/* ---------- シャンテン数 ---------- */

function shantenRegular(counts, fixedMelds) {
  const cnt = counts.slice();
  let best = 8;
  function evalNow(m, p, pair) {
    const pts = Math.min(p, 4 - m);
    const sh = 8 - 2 * m - pts - (pair ? 1 : 0);
    if (sh < best) best = sh;
  }
  function partials(i, m, p, pair) {
    while (i < 34 && cnt[i] === 0) i++;
    if (i >= 34 || (m + p >= 4 && pair)) { evalNow(m, p, pair); return; }
    if (cnt[i] >= 2) {
      if (!pair) { cnt[i] -= 2; partials(i, m, p, true); cnt[i] += 2; }
      if (m + p < 4) { cnt[i] -= 2; partials(i, m, p + 1, pair); cnt[i] += 2; }
    }
    const s = suitOf(i), n = numOf(i);
    if (m + p < 4 && s < 3) {
      if (n <= 8 && cnt[i + 1] > 0) {
        cnt[i]--; cnt[i + 1]--;
        partials(i, m, p + 1, pair);
        cnt[i]++; cnt[i + 1]++;
      }
      if (n <= 7 && cnt[i + 2] > 0) {
        cnt[i]--; cnt[i + 2]--;
        partials(i, m, p + 1, pair);
        cnt[i]++; cnt[i + 2]++;
      }
    }
    partials(i + 1, m, p, pair);
  }
  function sets(i, m) {
    while (i < 34 && cnt[i] === 0) i++;
    if (i >= 34 || m === 4) { partials(0, m, 0, false); return; }
    if (cnt[i] >= 3) { cnt[i] -= 3; sets(i, m + 1); cnt[i] += 3; }
    const s = suitOf(i), n = numOf(i);
    if (s < 3 && n <= 7 && cnt[i + 1] > 0 && cnt[i + 2] > 0) {
      cnt[i]--; cnt[i + 1]--; cnt[i + 2]--;
      sets(i, m + 1);
      cnt[i]++; cnt[i + 1]++; cnt[i + 2]++;
    }
    sets(i + 1, m);
  }
  sets(0, fixedMelds);
  return best;
}

function shantenChiitoi(counts) {
  let pairs = 0, kinds = 0;
  for (const c of counts) {
    if (c >= 1) kinds++;
    if (c >= 2) pairs++;
  }
  return 6 - pairs + Math.max(0, 7 - kinds);
}

function shantenKokushi(counts) {
  let kinds = 0, pair = 0;
  for (let k = 0; k < 34; k++) {
    if (!isYaochuu(k)) continue;
    if (counts[k] >= 1) kinds++;
    if (counts[k] >= 2) pair = 1;
  }
  return 13 - kinds - pair;
}

/** counts: 手牌(副露除く)。fixedMelds: 副露(暗槓含む)数 */
function shanten(counts, fixedMelds) {
  let s = shantenRegular(counts, fixedMelds);
  if (fixedMelds === 0) {
    s = Math.min(s, shantenChiitoi(counts), shantenKokushi(counts));
  }
  return s;
}

/** 13枚(相当)の手牌の待ち牌一覧 */
function waitsOf(counts13, fixedMelds) {
  const waits = [];
  const c = counts13.slice();
  for (let k = 0; k < 34; k++) {
    if (c[k] >= 4) continue;
    c[k]++;
    if (shanten(c, fixedMelds) === -1) waits.push(k);
    c[k]--;
  }
  return waits;
}

/* ---------- 和了形の分解(4面子+雀頭) ---------- */

function decompose(counts) {
  const res = [];
  const seen = new Set();
  for (let pk = 0; pk < 34; pk++) {
    if (counts[pk] < 2) continue;
    const cnt = counts.slice();
    cnt[pk] -= 2;
    const sets = [];
    (function rec(i) {
      while (i < 34 && cnt[i] === 0) i++;
      if (i >= 34) {
        const key = pk + "|" + sets.map((s) => s.k + (s.run ? "r" : "t")).sort().join(",");
        if (!seen.has(key)) {
          seen.add(key);
          res.push({ pair: pk, sets: sets.map((s) => ({ ...s })) });
        }
        return;
      }
      if (cnt[i] >= 3) {
        cnt[i] -= 3; sets.push({ k: i, run: false });
        rec(i);
        sets.pop(); cnt[i] += 3;
      }
      if (suitOf(i) < 3 && numOf(i) <= 7 && cnt[i + 1] > 0 && cnt[i + 2] > 0) {
        cnt[i]--; cnt[i + 1]--; cnt[i + 2]--; sets.push({ k: i, run: true });
        rec(i);
        sets.pop(); cnt[i]++; cnt[i + 1]++; cnt[i + 2]++;
      }
    })(0);
  }
  return res;
}

/* ---------- 点数計算 ---------- */

function basePoints(han, fu, yakumanCount) {
  if (yakumanCount > 0) return { base: 8000 * yakumanCount, limit: yakumanCount > 1 ? `${yakumanCount}倍役満` : "役満" };
  if (han >= 13) return { base: 8000, limit: "数え役満" };
  if (han >= 11) return { base: 6000, limit: "三倍満" };
  if (han >= 8) return { base: 4000, limit: "倍満" };
  if (han >= 6) return { base: 3000, limit: "跳満" };
  if (han >= 5) return { base: 2000, limit: "満貫" };
  const b = fu * Math.pow(2, 2 + han);
  if (b > 2000) return { base: 2000, limit: "満貫" };
  return { base: b, limit: "" };
}

const ceil100 = (x) => Math.ceil(x / 100) * 100;

/** 支払い額の計算(積み棒・供託は含まない素点) */
function payments(base, isDealer, tsumo) {
  if (tsumo) {
    if (isDealer) return { tsumoAll: ceil100(base * 2) };
    return { tsumoDealer: ceil100(base * 2), tsumoOther: ceil100(base) };
  }
  return { ron: ceil100(base * (isDealer ? 6 : 4)) };
}

/* ---------- 役判定 ----------
ctx = {
  closedCounts: 副露以外の全牌(和了牌込み)のcounts,
  melds: [{type:'chi'|'pon'|'minkan'|'kakan'|'ankan', k}],  // chiのkは最小牌
  winTile, tsumo,
  riichi, doubleRiichi, ippatsu, rinshan, chankan, haitei, houtei,
  tenhou, chiihou,
  seatWind, roundWind,
  doraInds: [], uraInds: [], akaCount: 0,
}
返り値: null(役なし) or { yaku:[{name,han}], han, fu, yakumanCount, base, limit }
*/
function scoreHand(ctx) {
  const menzen = ctx.melds.every((m) => m.type === "ankan");
  const kanCount = ctx.melds.filter((m) => m.type.includes("kan")).length;

  // 全牌(枚数ベース: 槓は4枚)
  const allCounts = ctx.closedCounts.slice();
  const kindsUsed = new Set();
  for (let k = 0; k < 34; k++) if (allCounts[k] > 0) kindsUsed.add(k);
  for (const m of ctx.melds) {
    if (m.type === "chi") {
      allCounts[m.k]++; allCounts[m.k + 1]++; allCounts[m.k + 2]++;
      kindsUsed.add(m.k); kindsUsed.add(m.k + 1); kindsUsed.add(m.k + 2);
    } else {
      allCounts[m.k] += m.type === "pon" ? 3 : 4;
      kindsUsed.add(m.k);
    }
  }
  const allKindsArr = [...kindsUsed];
  const suitsUsed = new Set(allKindsArr.map((k) => suitOf(k)));
  const numberSuits = [...suitsUsed].filter((s) => s < 3);
  const hasHonorTiles = suitsUsed.has(3);
  const allYaochuu = allKindsArr.every(isYaochuu);
  const allTerminals = allKindsArr.every(isTerminal);
  const allHonors = allKindsArr.every(isHonor);
  const anyYaochuu = allKindsArr.some(isYaochuu);
  const GREEN = new Set([19, 20, 21, 23, 25, HATSU]); // 2,3,4,6,8索+發
  const allGreen = allKindsArr.every((k) => GREEN.has(k));

  const doraCount = () => {
    let d = 0;
    for (const ind of ctx.doraInds) d += allCounts[doraNext(ind)] || 0;
    return d;
  };
  const uraCount = () => {
    if (!ctx.riichi && !ctx.doubleRiichi) return 0;
    let d = 0;
    for (const ind of ctx.uraInds) d += allCounts[doraNext(ind)] || 0;
    return d;
  };

  const results = [];

  const situational = (add) => {
    if (ctx.doubleRiichi) add("ダブル立直", 2);
    else if (ctx.riichi) add("立直", 1);
    if (ctx.ippatsu) add("一発", 1);
    if (menzen && ctx.tsumo) add("門前清自摸和", 1);
    if (ctx.rinshan) add("嶺上開花", 1);
    if (ctx.chankan) add("槍槓", 1);
    if (ctx.haitei) add("海底摸月", 1);
    if (ctx.houtei) add("河底撈魚", 1);
  };

  const finalize = (yaku, fu) => {
    const yakumanList = yaku.filter((y) => y.yakuman);
    let han = 0, yakumanCount = 0;
    if (yakumanList.length > 0) {
      yaku = yakumanList;
      yakumanCount = yakumanList.reduce((a, y) => a + y.yakuman, 0);
    } else {
      if (yaku.length === 0) return null; // 役なし
      const d = doraCount(), u = uraCount(), a = ctx.akaCount;
      if (d) yaku.push({ name: "ドラ", han: d });
      if (u) yaku.push({ name: "裏ドラ", han: u });
      if (a) yaku.push({ name: "赤ドラ", han: a });
      han = yaku.reduce((s, y) => s + y.han, 0);
    }
    const { base, limit } = basePoints(han, fu, yakumanCount);
    return { yaku, han, fu, yakumanCount, base, limit };
  };

  const better = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    if (a.base !== b.base) return a.base > b.base ? a : b;
    if (a.han !== b.han) return a.han > b.han ? a : b;
    return a.fu >= b.fu ? a : b;
  };

  /* --- 国士無双 --- */
  if (menzen && ctx.melds.length === 0 && shantenKokushi(ctx.closedCounts) === -1) {
    const yaku = [{ name: "国士無双", han: 13, yakuman: 1 }];
    if (ctx.tenhou) yaku.push({ name: "天和", han: 13, yakuman: 1 });
    if (ctx.chiihou) yaku.push({ name: "地和", han: 13, yakuman: 1 });
    return finalize(yaku, 30);
  }

  /* --- 七対子 --- */
  let bestResult = null;
  if (menzen && ctx.melds.length === 0 && shantenChiitoi(ctx.closedCounts) === -1) {
    const yaku = [];
    const add = (name, han, yakuman) => yaku.push({ name, han, yakuman });
    if (ctx.tenhou) add("天和", 13, 1);
    if (ctx.chiihou) add("地和", 13, 1);
    if (allHonors) add("字一色", 13, 1);
    situational(add);
    add("七対子", 2);
    if (!anyYaochuu) add("断么九", 1);
    if (allYaochuu && !allHonors) add("混老頭", 2);
    if (numberSuits.length === 1) {
      if (hasHonorTiles) add("混一色", 3);
      else add("清一色", 6);
    }
    bestResult = better(bestResult, finalize(yaku, 25));
  }

  /* --- 通常形 --- */
  const decomps = decompose(ctx.closedCounts);
  for (const d of decomps) {
    // 和了牌の所在ごとの解釈
    const interps = [];
    if (d.pair === ctx.winTile) interps.push({ where: "pair", idx: -1, wait: "tanki" });
    d.sets.forEach((s, idx) => {
      if (s.run) {
        if (ctx.winTile >= s.k && ctx.winTile <= s.k + 2) {
          let wait = "ryanmen";
          if (ctx.winTile === s.k + 1) wait = "kanchan";
          else if (ctx.winTile === s.k + 2 && numOf(s.k) === 1) wait = "penchan";
          else if (ctx.winTile === s.k && numOf(s.k) === 7) wait = "penchan";
          interps.push({ where: "set", idx, wait });
        }
      } else if (s.k === ctx.winTile) {
        interps.push({ where: "set", idx, wait: "shanpon" });
      }
    });
    for (const it of interps) {
      // 全面子リストの構築
      const sets = [];
      for (const m of ctx.melds) {
        if (m.type === "chi") sets.push({ k: m.k, run: true, open: true, kan: false, concealed: false });
        else if (m.type === "pon") sets.push({ k: m.k, run: false, open: true, kan: false, concealed: false });
        else if (m.type === "ankan") sets.push({ k: m.k, run: false, open: false, kan: true, concealed: true });
        else sets.push({ k: m.k, run: false, open: true, kan: true, concealed: false });
      }
      d.sets.forEach((s, idx) => {
        const ronCompleted = !ctx.tsumo && it.where === "set" && it.idx === idx && !s.run;
        sets.push({ k: s.k, run: s.run, open: false, kan: false, concealed: !ronCompleted });
      });

      const yaku = [];
      const add = (name, han, yakuman) => yaku.push({ name, han, yakuman });

      if (ctx.tenhou) add("天和", 13, 1);
      if (ctx.chiihou) add("地和", 13, 1);

      const triplets = sets.filter((s) => !s.run);
      const runs = sets.filter((s) => s.run);
      const ankoCount = triplets.filter((s) => s.concealed).length;

      // 役満系
      if (menzen && ankoCount === 4) add("四暗刻", 13, 1);
      if (triplets.filter((s) => s.k >= HAKU).length === 3) add("大三元", 13, 1);
      const windTris = triplets.filter((s) => s.k >= EAST && s.k <= NORTH).length;
      if (windTris === 4) add("大四喜", 13, 1);
      else if (windTris === 3 && d.pair >= EAST && d.pair <= NORTH) add("小四喜", 13, 1);
      if (allHonors) add("字一色", 13, 1);
      if (allTerminals) add("清老頭", 13, 1);
      if (allGreen) add("緑一色", 13, 1);
      if (kanCount === 4) add("四槓子", 13, 1);
      if (menzen && ctx.melds.length === 0 && numberSuits.length === 1 && !hasHonorTiles) {
        const s0 = numberSuits[0] * 9;
        const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
        if (need.every((n, i) => ctx.closedCounts[s0 + i] >= n)) add("九蓮宝燈", 13, 1);
      }

      situational(add);

      // 平和
      const pairIsYakuhai = d.pair >= HAKU || d.pair === ctx.seatWind || d.pair === ctx.roundWind;
      const isPinfu = menzen && runs.length === 4 && !pairIsYakuhai && it.wait === "ryanmen";
      if (isPinfu) add("平和", 1);

      if (!anyYaochuu) add("断么九", 1);

      if (menzen) {
        const runKeys = {};
        for (const r of runs) runKeys[r.k] = (runKeys[r.k] || 0) + 1;
        const dupPairs = Object.values(runKeys).reduce((a, c) => a + Math.floor(c / 2), 0);
        if (dupPairs >= 2) add("二盃口", 3);
        else if (dupPairs === 1) add("一盃口", 1);
      }

      for (const t of triplets) {
        if (t.k === HAKU) add("翻牌 白", 1);
        if (t.k === HATSU) add("翻牌 發", 1);
        if (t.k === CHUN) add("翻牌 中", 1);
        if (t.k === ctx.seatWind) add("自風 " + KIND_NAMES[t.k], 1);
        if (t.k === ctx.roundWind) add("場風 " + KIND_NAMES[t.k], 1);
      }

      // 三色同順・三色同刻
      for (let n = 0; n < 7; n++) {
        if ([0, 1, 2].every((su) => runs.some((r) => r.k === su * 9 + n))) {
          add("三色同順", menzen ? 2 : 1); break;
        }
      }
      for (let n = 0; n < 9; n++) {
        if ([0, 1, 2].every((su) => triplets.some((t) => t.k === su * 9 + n))) {
          add("三色同刻", 2); break;
        }
      }
      // 一気通貫
      for (let su = 0; su < 3; su++) {
        if ([0, 3, 6].every((n) => runs.some((r) => r.k === su * 9 + n))) {
          add("一気通貫", menzen ? 2 : 1); break;
        }
      }
      // 混全帯么九・純全帯么九(順子が1つ以上必要)
      const setHasYaochuu = (s) => (s.run ? numOf(s.k) === 1 || numOf(s.k) === 7 : isYaochuu(s.k));
      if (runs.length >= 1 && isYaochuu(d.pair) && sets.every(setHasYaochuu)) {
        if (hasHonorTiles) add("混全帯么九", menzen ? 2 : 1);
        else add("純全帯么九", menzen ? 3 : 2);
      }
      if (triplets.length === 4 && !yaku.some((y) => y.yakuman)) add("対々和", 2);
      if (ankoCount === 3) add("三暗刻", 2);
      if (kanCount === 3) add("三槓子", 2);
      if (triplets.filter((s) => s.k >= HAKU).length === 2 && d.pair >= HAKU) add("小三元", 2);
      if (allYaochuu && !allHonors && !allTerminals) add("混老頭", 2);
      if (numberSuits.length === 1) {
        if (hasHonorTiles) add("混一色", menzen ? 3 : 2);
        else if (!yaku.some((y) => y.name === "九蓮宝燈")) add("清一色", menzen ? 6 : 5);
      }

      /* --- 符計算 --- */
      let fu = 20;
      let fuDetail = [];
      if (menzen && !ctx.tsumo) { fu += 10; fuDetail.push("門前加符10"); }
      if (ctx.tsumo && !isPinfu) { fu += 2; fuDetail.push("自摸2"); }
      if (it.wait === "tanki" || it.wait === "kanchan" || it.wait === "penchan") {
        fu += 2; fuDetail.push("待ち2");
      }
      if (d.pair >= HAKU) { fu += 2; fuDetail.push("雀頭(三元牌)2"); }
      if (d.pair === ctx.seatWind) { fu += 2; fuDetail.push("雀頭(自風)2"); }
      if (d.pair === ctx.roundWind && d.pair !== ctx.seatWind) { fu += 2; fuDetail.push("雀頭(場風)2"); }
      else if (d.pair === ctx.roundWind && d.pair === ctx.seatWind) { fu += 2; fuDetail.push("雀頭(連風)2"); }
      for (const t of triplets) {
        let f = 2;
        if (t.concealed) f *= 2;
        if (t.kan) f *= 4;
        if (isYaochuu(t.k)) f *= 2;
        fu += f;
      }
      if (isPinfu) fu = ctx.tsumo ? 20 : 30;
      if (fu === 20 && !ctx.tsumo && !menzen) fu = 30; // 喰い平和形
      fu = Math.ceil(fu / 10) * 10;
      if (isPinfu && ctx.tsumo) fu = 20;

      bestResult = better(bestResult, finalize(yaku, fu));
    }
  }
  return bestResult;
}

/* ---------- Node テスト用エクスポート ---------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    KIND_NAMES, EAST, SOUTH, WEST, NORTH, HAKU, HATSU, CHUN,
    suitOf, numOf, isHonor, isTerminal, isYaochuu,
    toCounts, doraNext, shanten, shantenRegular, shantenChiitoi, shantenKokushi,
    waitsOf, decompose, basePoints, payments, ceil100, scoreHand,
  };
}

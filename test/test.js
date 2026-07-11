"use strict";
const E = require("../src/engine.js");

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; }
  else { fail++; console.log(`NG ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}

// 表記→kind配列("123m45p6s1z" 形式, z: 1東..7中)
function parse(str) {
  const kinds = [];
  let buf = [];
  for (const ch of str) {
    if (/[0-9]/.test(ch)) buf.push(+ch);
    else {
      const base = { m: 0, p: 9, s: 18, z: 27 }[ch];
      for (const n of buf) kinds.push(base + n - 1);
      buf = [];
    }
  }
  return kinds;
}
const C = (s) => E.toCounts(parse(s));

/* ---- シャンテン ---- */
eq("和了形", E.shanten(C("123456789m123p11s"), 0), -1);
eq("テンパイ(単騎)", E.shanten(C("123456789m123p1s"), 0), 0);
eq("テンパイ(両面)", E.shanten(C("23456m234p55p678s"), 0), 0);
eq("1シャンテン", E.shanten(C("111222333m44p19s"), 0), 1);
eq("七対子テンパイ", E.shanten(C("1122m3344p5566s7z"), 0), 0);
eq("国士13面テンパイ", E.shanten(C("19m19p19s1234567z"), 0), 0);
eq("国士和了", E.shanten(C("19m19p19s12345677z"), 0), -1);
eq("配牌級", E.shanten(C("147m258p369s1234z"), 0), 6);
eq("副露込みテンパイ", E.shanten(C("23m44p"), 3), 0); // 3副露+23m+44p
eq("九蓮テンパイ(13枚)", E.shanten(C("1112345678999m"), 0), 0);
eq("ブロック過多補正", E.shanten(C("123m456m789m12p34s"), 0), 1);

/* ---- 待ち ---- */
eq("両面待ち", E.waitsOf(C("23456m234p55p678s"), 0).map(k=>E.KIND_NAMES[k]), ["一萬","四萬","七萬"]);
eq("単騎待ち", E.waitsOf(C("123456789m123p5s"), 0).map(k=>E.KIND_NAMES[k]), ["五索"]);

/* ---- 点数基礎 ---- */
eq("30符4翻", E.basePoints(4, 30, 0).base, 1920);
eq("満貫キャップ", E.basePoints(4, 40, 0), { base: 2000, limit: "満貫" });
eq("跳満", E.basePoints(6, 30, 0), { base: 3000, limit: "跳満" });
eq("数え役満", E.basePoints(13, 30, 0), { base: 8000, limit: "数え役満" });
eq("支払い:子ロン30符4翻", E.payments(1920, false, false), { ron: 7700 });
eq("支払い:親ロン30符4翻", E.payments(1920, true, false), { ron: 11600 });

/* ---- 役・符 ---- */
function ctx(closed, over = {}) {
  return {
    closedCounts: C(closed),
    melds: [], winTile: 0, tsumo: false,
    riichi: false, doubleRiichi: false, ippatsu: false,
    rinshan: false, chankan: false, haitei: false, houtei: false,
    tenhou: false, chiihou: false,
    seatWind: E.SOUTH, roundWind: E.EAST,
    doraInds: [], uraInds: [], akaCount: 0,
    ...over,
  };
}
const names = (r) => r.yaku.map((y) => y.name).sort();

// 平和ツモ 20符2翻 (子: 400/700)
{
  const r = E.scoreHand(ctx("234m567m234p55p678s", { winTile: parse("8s")[0], tsumo: true }));
  eq("平和ツモ役", names(r), ["平和", "断么九", "門前清自摸和"]);
  eq("平和ツモ符", [r.fu, r.han], [20, 3]);
  eq("平和ツモ支払", E.payments(r.base, false, true), { tsumoDealer: 1300, tsumoOther: 700 });
}
// 七対子ロン 25符2翻 (子: 1600)
{
  const r = E.scoreHand(ctx("1122m334455p66s77z", { winTile: parse("3p")[0] }));
  eq("七対子", names(r), ["七対子"]);
  eq("七対子符", [r.fu, r.han], [25, 2]);
  eq("七対子支払", E.payments(r.base, false, false), { ron: 1600 });
}
// 喰いタンのみ 30符1翻ロン (子: 1000)
{
  const r = E.scoreHand(ctx("234p678p88s34s2s", {
    winTile: parse("2s")[0],
    melds: [{ type: "pon", k: parse("5m")[0] }],
  }));
  eq("喰い断", names(r), ["断么九"]);
  eq("喰い断符", [r.fu, r.han], [30, 1]);
  eq("喰い断支払", E.payments(r.base, false, false), { ron: 1000 });
}
// 役なしロン → null
{
  // シンプルな役なし: チー123m, 手 456p 789p 88s 45s ロン6s → 役なし
  const r = E.scoreHand(ctx("456789p88s456s", {
    winTile: parse("6s")[0],
    melds: [{ type: "chi", k: parse("1m")[0] }],
  }));
  eq("役なしはnull", r, null);
}
// 三暗刻(ロンで完成した刻子は暗刻に数えない)
{
  const r = E.scoreHand(ctx("111m222m444p55s66s5s", { winTile: parse("5s")[0] }));
  eq("三暗刻+対々(ロン)", names(r), ["三暗刻", "対々和"]);
}
// 同手ツモ → 四暗刻
{
  const r = E.scoreHand(ctx("111m222m444p55s66s5s", { winTile: parse("5s")[0], tsumo: true }));
  eq("四暗刻(ツモ)", names(r), ["四暗刻"]);
  eq("四暗刻base", r.base, 8000);
}
// 大三元
{
  const r = E.scoreHand(ctx("555z666z777z123m44p", {
    closedCounts: C("555666777z123m44p"),
    winTile: parse("3m")[0],
  }));
  eq("大三元", names(r).includes("大三元"), true);
}
// 国士無双
{
  const r = E.scoreHand(ctx("19m19p19s12345677z", { winTile: parse("7z")[0] }));
  eq("国士無双", names(r), ["国士無双"]);
}
// 立直+一発+ツモ+裏
{
  const r = E.scoreHand(ctx("234m567m234p55p678s", {
    winTile: parse("8s")[0], tsumo: true, riichi: true, ippatsu: true,
    uraInds: [parse("4p")[0]], // 裏ドラ=5p → 55p で2枚
  }));
  eq("リーチ一発ツモ平和+裏2", [r.han, names(r).includes("裏ドラ")], [7, true]);
}
// 役牌+場風・自風の複合、符
{
  // 南家・東場: 南の刻子=自風のみ / 中の刻子
  const r = E.scoreHand(ctx("222z777z234m567p99s", {
    closedCounts: C("222777z234m567p99s"),
    winTile: parse("4m")[0],
  }));
  eq("自風+中", names(r), ["翻牌 中", "自風 南"]);
  // 符: 20 + 門前ロン10 + 暗刻(么九)8×2 = 46 → 50
  eq("役牌手の符", r.fu, 50);
}
// 清一色+一気通貫(門前ロン)
{
  const r = E.scoreHand(ctx("123456789m234m55m", {
    winTile: parse("5m")[0],
  }));
  eq("清一+一通など", names(r).includes("清一色") && names(r).includes("一気通貫"), true);
}
// 混全帯么九
{
  const r = E.scoreHand(ctx("123m789p123s111z33z", {
    winTile: parse("3s")[0],
  }));
  eq("混全", names(r).includes("混全帯么九"), true);
}
// 純全帯么九
{
  const r = E.scoreHand(ctx("123m789m123p789s99s", { winTile: parse("9s")[0] }));
  eq("純全", names(r).includes("純全帯么九"), true);
}
// ダブ東(親・東場)の符
{
  const r = E.scoreHand(ctx("111z234m567p22s333s", {
    closedCounts: C("111z234m567p22333s"),
    winTile: parse("3s")[0],
    seatWind: E.EAST, roundWind: E.EAST, tsumo: true,
  }));
  eq("ダブ東", names(r).filter(n=>n.includes("東")).length, 2);
}
// 緑一色
{
  const r = E.scoreHand(ctx("223344s666s888s66z", { winTile: parse("6z")[0] }));
  eq("緑一色", names(r).includes("緑一色"), true);
}
// 九蓮宝燈
{
  const r = E.scoreHand(ctx("11123456789999m", {
    closedCounts: C("1112345678999m9m"),
    winTile: parse("9m")[0], tsumo: true,
  }));
  eq("九蓮", names(r).includes("九蓮宝燈"), true);
}
// 槓の符: 暗槓(么九)32
{
  const r = E.scoreHand(ctx("234m567p22s333s", {
    closedCounts: C("234m567p22s333s"),
    winTile: parse("3s")[0], tsumo: true,
    melds: [{ type: "ankan", k: parse("1z")[0] }],
    seatWind: E.WEST,
  }));
  // 20 + ツモ2 + 暗槓么九32 + 暗刻(333s ツモなので暗刻)4 = 58 → 60
  eq("暗槓符", r === null ? null : r.fu, r === null ? null : 60);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

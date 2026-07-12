"use strict";
/* ==========================================================
   UI層(ブラウザ専用)
   ========================================================== */

const NAMES = ["あなた", "CPU・松", "CPU・竹", "CPU・梅"];
const WIND_CHAR = { [EAST]: "東", [SOUTH]: "南", [WEST]: "西", [NORTH]: "北" };
const $ = (id) => document.getElementById(id);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

let game = null;
let pending = null; // 人間への入力待ち {kind, view, opts, resolve, stage}
let speed = "normal";
const SPEED_MS = {
  normal: { draw: 240, discard: 330, call: 620, riichi: 680 },
  fast: { draw: 50, discard: 100, call: 240, riichi: 280 },
};

/* ----------------------------------------------------------
   牌の描画
   ★Yuさん作の牌SVGに差し替える場合は tileFaceHTML() を編集して
     <img src="..."> や inline SVG を返すようにするだけでOKです。
     aria-label は tileLabel() が付けるので画像は alt="" 相当で構いません。
   ---------------------------------------------------------- */
const NUM_KANJI = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const NUM_CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];
function tileLabel(k, red) {
  return (red ? "赤" : "") + KIND_NAMES[k];
}
function tileFaceHTML(k, red) {
  if (k >= 27) {
    const cls = k === HATSU ? "h-hatsu" : k === CHUN ? "h-chun" : "";
    return `<span class="tf-h ${cls}" aria-hidden="true">${KIND_NAMES[k]}</span>`;
  }
  const suit = suitOf(k), n = numOf(k);
  const numTxt = suit === 0 ? NUM_KANJI[n - 1] : suit === 1 ? NUM_CIRCLED[n - 1] : String(n);
  const suitTxt = ["萬", "筒", "索"][suit];
  const suitCls = ["man", "pin", "sou"][suit];
  return `<span class="tf-n ${suitCls} ${red ? "red" : ""}" aria-hidden="true">${numTxt}</span>` +
    `<span class="tf-s ${suitCls}" aria-hidden="true">${suitTxt}</span>`;
}
function tileNode(tile, o = {}) {
  const el = document.createElement(o.button ? "button" : "span");
  if (o.button) el.type = "button";
  el.className = "tile" +
    (o.small ? " small" : "") + (o.rotated ? " rot" : "") +
    (o.faded ? " faded" : "") + (o.marked ? " marked" : "");
  el.innerHTML = tileFaceHTML(tile.k, tile.red);
  let label = tileLabel(tile.k, tile.red);
  if (o.rotated) label += "(リーチ宣言牌)";
  if (o.faded) label += "(鳴かれた牌)";
  if (o.button) {
    el.setAttribute("aria-label", label);
    el.dataset.tid = String(tile.id);
  } else {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", label);
  }
  return el;
}
function backNode(small) {
  const el = document.createElement("span");
  el.className = "tile back" + (small ? " small" : "");
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "裏向きの牌");
  return el;
}

/* ---------- 通知・ログ ---------- */
function log(msg) {
  const li = document.createElement("li");
  li.textContent = msg;
  $("log-list").appendChild(li);
}
function announce(msg) {
  $("announcer").textContent = msg;
  log(msg);
}

/* ---------- 人間エージェント ---------- */
function promptHuman(p) {
  return new Promise((resolve) => {
    pending = { stage: "main", ...p, resolve };
    render();
    focusPrompt();
  });
}
function finishPrompt(action) {
  const res = pending.resolve;
  pending = null;
  render();
  res(action);
}
function humanAgent() {
  return {
    async turnAction(view, opts) {
      const drawn = view.hand.find((t) => t.id === view.drawnId);
      if (drawn) announce("ツモ: " + tileLabel(drawn.k, drawn.red));
      if (view.riichi) {
        if (opts.tsumo) {
          await sleepMs(500);
          return { type: "tsumo" }; // リーチ中は自動ツモ
        }
        if (opts.ankan.length) {
          return promptHuman({ kind: "turn", view, opts, stage: "riichi-kan" });
        }
        await sleepMs(600);
        return { type: "discard", tileId: view.drawnId }; // リーチ中はツモ切り
      }
      return promptHuman({ kind: "turn", view, opts });
    },
    async claimAction(view, opts) {
      return promptHuman({ kind: "claim", view, opts });
    },
    async discardAfterCall(view, opts) {
      return promptHuman({ kind: "aftercall", view, opts });
    },
  };
}

/* ---------- レンダリング ---------- */
function render() {
  if (!game || !game.fairness) return; // 局の初期化前
  $("head-kyoku").textContent = game.kyokuLabel();
  document.title = `金緘の透牌 ${game.kyokuLabel()}`;
  renderCenter();
  for (let s = 0; s < 4; s++) renderSeat(s);
  renderActions();
}

function renderCenter() {
  $("c-kyoku").textContent = game.kyokuLabel();
  $("c-sub").textContent = `供託 ${game.kyotaku}本 / ${game.honba}本場`;
  $("c-wall").textContent = `山 残り${game.liveRemaining()}枚`;
  const dora = $("c-dora");
  dora.innerHTML = "";
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = "ドラ表示";
  dora.appendChild(lbl);
  const inds = game.doraIndicators();
  for (const t of inds) dora.appendChild(tileNode(t, { small: true }));
  for (let i = inds.length; i < 5; i++) dora.appendChild(backNode(true));
  const seal = $("btn-seal");
  const f = game.fairness;
  seal.innerHTML =
    `<span class="seal-mark">${f.revealed ? "開封済" : "封"}</span><br>` +
    `山ハッシュ <code>${f.hash.slice(0, 12)}…</code>`;
  seal.setAttribute("aria-label",
    (f.revealed ? "牌山は開封済みです。" : "牌山は封緘中です。") + "クリックで検証パネルを開きます");
}

function renderSeat(s) {
  const p = game.players[s];
  const info = $("info-" + s);
  info.innerHTML = "";
  const wind = document.createElement("span");
  wind.className = "p-wind" + (s === game.dealer ? " dealer" : "");
  wind.textContent = WIND_CHAR[game.seatWind(s)];
  const name = document.createElement("span");
  name.className = "p-name";
  name.textContent = p.name;
  const score = document.createElement("span");
  score.textContent = `${p.score}点`;
  info.append(wind, name, score);
  if (p.riichi) {
    const b = document.createElement("span");
    b.className = "badge riichi";
    b.textContent = p.doubleRiichi ? "ダブル立直" : "立直";
    info.appendChild(b);
  }
  if (s === 0) {
    if (game.isFuriten(p)) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "フリテン";
      info.appendChild(b);
    }
    if (p.waits && p.waits.length && shanten(game.closedCounts(p, false), game.meldCount(p)) === 0) {
      const w = document.createElement("span");
      w.className = "p-waits";
      w.textContent = "待ち: " + p.waits.map((k) => KIND_NAMES[k]).join("・");
      info.appendChild(w);
    }
  }

  // 相手の手牌(裏向き)
  if (s !== 0) {
    const backs = $("backs-" + s);
    backs.innerHTML = "";
    const n = p.hand.length + (p.drawn ? 1 : 0);
    backs.setAttribute("aria-label", `${p.name}の手牌 ${n}枚(裏向き)`);
    for (let i = 0; i < n; i++) backs.appendChild(backNode(true));
  }

  // 副露
  const melds = $("melds-" + s);
  melds.innerHTML = "";
  for (const m of p.melds) {
    const g = document.createElement("span");
    g.className = "meld-group";
    const kindName = { chi: "チー", pon: "ポン", minkan: "明槓", kakan: "加槓", ankan: "暗槓" }[m.type];
    g.setAttribute("role", "img");
    g.setAttribute("aria-label", `${kindName}: ${m.tiles.map((t) => tileLabel(t.k, t.red)).join("・")}`);
    if (m.type === "ankan") {
      g.appendChild(backNode(true));
      g.appendChild(tileNode(m.tiles[1], { small: true }));
      g.appendChild(tileNode(m.tiles[2], { small: true }));
      g.appendChild(backNode(true));
    } else {
      for (const t of m.tiles) g.appendChild(tileNode(t, { small: true }));
    }
    melds.appendChild(g);
  }

  // 河
  const river = $("river-" + s);
  river.innerHTML = "";
  for (const r of p.river) {
    river.appendChild(tileNode(r.tile, { small: true, rotated: r.riichi, faded: r.called }));
  }

  if (s === 0) renderHand(p);
}

function enabledTileIds() {
  if (!pending) return new Set();
  if (pending.kind === "turn" && pending.stage === "main") {
    return new Set(pending.view.hand.map((t) => t.id));
  }
  if (pending.kind === "turn" && pending.stage === "riichi") {
    return new Set(pending.opts.riichiTiles);
  }
  if (pending.kind === "aftercall") {
    return new Set(pending.opts.legalIds);
  }
  return new Set();
}

function renderHand(p) {
  const hand = $("hand");
  hand.innerHTML = "";
  const enabled = enabledTileIds();
  const mk = (t) => {
    const b = tileNode(t, { button: true });
    b.disabled = !enabled.has(t.id);
    return b;
  };
  for (const t of p.hand) hand.appendChild(mk(t));
  if (p.drawn) {
    const gap = document.createElement("span");
    gap.className = "drawn-gap";
    hand.appendChild(gap);
    hand.appendChild(mk(p.drawn));
  }
}

function renderActions() {
  const label = $("prompt-label");
  const box = $("action-buttons");
  box.innerHTML = "";
  if (!pending) {
    label.textContent = game && !game.finished ? "他家の番です…" : "";
    return;
  }
  const addBtn = (text, cls, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn " + cls;
    b.textContent = text;
    b.addEventListener("click", fn);
    box.appendChild(b);
    return b;
  };
  const o = pending.opts;

  if (pending.kind === "turn") {
    if (pending.stage === "main") {
      label.textContent = "あなたの番です。捨てる牌を選んでください。";
      if (o.tsumo) addBtn("ツモ(あがる)", "primary", () => finishPrompt({ type: "tsumo" }));
      if (o.riichiTiles.length) addBtn("リーチ", "danger", () => { pending.stage = "riichi"; render(); focusPrompt(); });
      if (o.ankan.length || o.kakan.length) addBtn("カン", "", () => { pending.stage = "kan"; render(); focusPrompt(); });
    } else if (pending.stage === "riichi") {
      label.textContent = "リーチ宣言: 捨てる牌を選んでください(光っている牌だけ選べます)。";
      addBtn("キャンセル", "", () => { pending.stage = "main"; render(); focusPrompt(); });
    } else if (pending.stage === "kan") {
      label.textContent = "カンする牌を選んでください。";
      for (const k of o.ankan) addBtn(`暗槓 ${KIND_NAMES[k]}`, "primary", () => finishPrompt({ type: "ankan", k }));
      for (const k of o.kakan) addBtn(`加槓 ${KIND_NAMES[k]}`, "primary", () => finishPrompt({ type: "kakan", k }));
      addBtn("キャンセル", "", () => { pending.stage = "main"; render(); focusPrompt(); });
    } else if (pending.stage === "riichi-kan") {
      label.textContent = "リーチ中です。カンしますか?";
      for (const k of o.ankan) addBtn(`暗槓 ${KIND_NAMES[k]}`, "primary", () => finishPrompt({ type: "ankan", k }));
      addBtn("ツモ切り", "", () => finishPrompt({ type: "discard", tileId: pending.view.drawnId }));
    }
    return;
  }

  if (pending.kind === "claim") {
    const t = o.tile;
    const fromName = game.players[o.from].name;
    if (pending.stage === "main") {
      if (o.ron) {
        label.textContent = `${fromName}の${tileLabel(t.k, t.red)}でロンできます。見逃すとフリテンになります。`;
        addBtn("ロン", "primary", () => finishPrompt({ type: "ron" }));
      } else {
        label.textContent = `${fromName}が${tileLabel(t.k, t.red)}を捨てました。鳴きますか?`;
      }
      if (o.minkan) addBtn("カン", "", () => finishPrompt({ type: "minkan" }));
      if (o.pon) addBtn("ポン", "", () => finishPrompt({ type: "pon" }));
      if (o.chi.length === 1) addBtn("チー", "", () => finishPrompt({ type: "chi", k: o.chi[0] }));
      if (o.chi.length > 1) addBtn("チー", "", () => { pending.stage = "chi"; render(); focusPrompt(); });
      addBtn("スルー", "", () => finishPrompt({ type: "pass" }));
    } else if (pending.stage === "chi") {
      label.textContent = "チーの組み合わせを選んでください。";
      for (const k of o.chi) {
        const used = [k, k + 1, k + 2].filter((x) => x !== t.k);
        addBtn(`${used.map((x) => KIND_NAMES[x]).join("・")}でチー`, "primary",
          () => finishPrompt({ type: "chi", k }));
      }
      addBtn("もどる", "", () => { pending.stage = "main"; render(); focusPrompt(); });
    }
    return;
  }

  if (pending.kind === "aftercall") {
    label.textContent = "鳴いたあとの捨て牌を選んでください(喰い替えになる牌は選べません)。";
  }
}

function focusPrompt() {
  setTimeout(() => {
    const btn = $("action-buttons").querySelector("button");
    if (btn) { btn.focus(); return; }
    const tiles = [...$("hand").querySelectorAll("button:not(:disabled)")];
    if (tiles.length) tiles[tiles.length - 1].focus();
  }, 0);
}

/* 手牌クリック */
$("hand").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-tid]");
  if (!btn || btn.disabled || !pending) return;
  const id = Number(btn.dataset.tid);
  if (pending.kind === "turn") {
    if (pending.stage === "main") finishPrompt({ type: "discard", tileId: id });
    else if (pending.stage === "riichi" && pending.opts.riichiTiles.includes(id)) {
      finishPrompt({ type: "riichi", tileId: id });
    }
  } else if (pending.kind === "aftercall" && pending.opts.legalIds.includes(id)) {
    finishPrompt(id);
  }
});
/* 手牌の左右キー移動 */
$("hand").addEventListener("keydown", (ev) => {
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
  const tiles = [...$("hand").querySelectorAll("button:not(:disabled)")];
  const i = tiles.indexOf(document.activeElement);
  if (i < 0 || tiles.length === 0) return;
  ev.preventDefault();
  const j = ev.key === "ArrowLeft" ? Math.max(0, i - 1) : Math.min(tiles.length - 1, i + 1);
  tiles[j].focus();
});

/* ---------- イベント → 実況 ---------- */
function onEvent(e) {
  const name = (s) => game.players[s].name;
  switch (e.type) {
    case "roundStart":
      announce(`${e.label} 開始。山ハッシュ(封緘): ${e.hash.slice(0, 12)}…`);
      break;
    case "discard":
      log(`${name(e.seat)}: ${tileLabel(e.tile.k, e.tile.red)} 打`);
      break;
    case "call": {
      const kindName = { chi: "チー", pon: "ポン", minkan: "カン", kakan: "加カン", ankan: "暗カン" }[e.call];
      announce(`${name(e.seat)}が${kindName}(${KIND_NAMES[e.k]})`);
      break;
    }
    case "riichi":
      announce(`${name(e.seat)}が${e.double ? "ダブル" : ""}リーチ!`);
      break;
    case "win":
      announce(`${name(e.seat)}が${e.tsumo ? "ツモ" : `${name(e.from)}からロン`}和了`);
      break;
    case "ryuukyoku":
      announce("流局");
      break;
    case "gameEnd":
      announce("対局終了");
      break;
  }
}

/* ---------- 結果ダイアログ ---------- */
function scoreChangeLines(container, delta, extraForWinner) {
  for (let s = 0; s < 4; s++) {
    let d = delta[s];
    if (extraForWinner && s === extraForWinner.seat) d += extraForWinner.amount;
    if (d === 0) continue;
    const line = document.createElement("div");
    line.className = "score-line";
    const nm = document.createElement("span");
    nm.textContent = game.players[s].name;
    const val = document.createElement("span");
    val.className = d > 0 ? "plus" : "minus";
    val.textContent = (d > 0 ? "+" : "") + d;
    line.append(nm, val);
    container.appendChild(line);
  }
}

function buildResultBody(rr) {
  const body = $("result-body");
  body.innerHTML = "";
  if (rr.type === "win") {
    const p = game.players[rr.seat];
    // 手牌
    const handRow = document.createElement("div");
    handRow.className = "result-hand";
    for (const t of rr.hand) handRow.appendChild(tileNode(t, {}));
    const gap = document.createElement("span");
    gap.className = "gap";
    handRow.appendChild(gap);
    handRow.appendChild(tileNode(rr.tile, { marked: true }));
    for (const m of rr.melds) {
      const g = document.createElement("span");
      g.className = "meld-group";
      for (const t of m.tiles) g.appendChild(tileNode(t, { small: true }));
      handRow.appendChild(g);
    }
    body.appendChild(handRow);
    // ドラ
    const doraRow = document.createElement("div");
    doraRow.className = "result-hand";
    const dl = document.createElement("span");
    dl.textContent = "ドラ表示:";
    doraRow.appendChild(dl);
    for (const t of rr.doraShown) doraRow.appendChild(tileNode(t, { small: true }));
    if (rr.uraShown.length) {
      const ul = document.createElement("span");
      ul.textContent = " 裏ドラ表示:";
      doraRow.appendChild(ul);
      for (const t of rr.uraShown) doraRow.appendChild(tileNode(t, { small: true }));
    }
    body.appendChild(doraRow);
    // 役
    const table = document.createElement("table");
    table.className = "yaku-table";
    for (const y of rr.win.yaku) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = y.name;
      const td2 = document.createElement("td");
      td2.textContent = y.yakuman ? "役満" : `${y.han}翻`;
      tr.append(td1, td2);
      table.appendChild(tr);
    }
    body.appendChild(table);
    // 点数
    const total = rr.delta[rr.seat];
    const head = document.createElement("p");
    head.className = "points-headline";
    head.textContent = rr.win.yakumanCount > 0
      ? `${rr.win.limit} ${total}点`
      : `${rr.win.fu}符${rr.win.han}翻${rr.win.limit ? " " + rr.win.limit : ""} ${total}点`;
    body.appendChild(head);
    scoreChangeLines(body, rr.delta, rr.kyotakuWon ? { seat: rr.seat, amount: rr.kyotakuWon * 1000 } : null);
  } else {
    const list = document.createElement("div");
    for (let s = 0; s < 4; s++) {
      const line = document.createElement("div");
      line.className = "score-line";
      const nm = document.createElement("span");
      nm.textContent = `${game.players[s].name}: ${rr.tenpai[s] ? "テンパイ" : "ノーテン"}`;
      const val = document.createElement("span");
      const d = rr.delta[s];
      val.className = d > 0 ? "plus" : d < 0 ? "minus" : "";
      val.textContent = d === 0 ? "±0" : (d > 0 ? "+" : "") + d;
      line.append(nm, val);
      list.appendChild(line);
      if (rr.hands[s]) {
        const hr = document.createElement("div");
        hr.className = "result-hand";
        for (const t of rr.hands[s]) hr.appendChild(tileNode(t, { small: true }));
        list.appendChild(hr);
      }
    }
    body.appendChild(list);
  }
}

function showRoundResult(rr) {
  return new Promise((resolve) => {
    $("result-title").textContent = rr.type === "win"
      ? `${rr.label} ${game.players[rr.seat].name}の和了(${rr.tsumo ? "ツモ" : "ロン"})`
      : `${rr.label} 流局`;
    buildResultBody(rr);
    const dlg = $("dlg-result");
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    $("btn-next").onclick = () => dlg.close();
    dlg.onclose = finish;
    dlg.showModal();
  });
}

function showEndDialog(result) {
  const body = $("end-body");
  body.innerHTML = "";
  if (result.reason === "tobi") {
    const p = document.createElement("p");
    p.textContent = "トビ(持ち点マイナス)により終了しました。";
    body.appendChild(p);
  }
  const table = document.createElement("table");
  table.className = "rank-table";
  table.innerHTML = "<tr><th>順位</th><th>プレイヤー</th><th>点数</th></tr>";
  result.ranking.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i + 1}位</td><td></td><td>${r.score}点</td>`;
    tr.children[1].textContent = r.name;
    table.appendChild(tr);
  });
  body.appendChild(table);
  $("dlg-end").showModal();
}

/* ---------- 公正性(封緘)ダイアログ ---------- */
async function openFairDialog() {
  const f = game.fairness;
  const body = $("fair-body");
  body.innerHTML = "";
  const p1 = document.createElement("p");
  p1.textContent = "この局の牌山136枚は配牌前に確定し、その並び順のハッシュを封緘として先に公開しています。局が終わると並び順とソルトを開封します。";
  body.appendChild(p1);
  const h1 = document.createElement("h3");
  h1.textContent = "封緘(局開始時に公開されたSHA-256)";
  body.appendChild(h1);
  const hb = document.createElement("div");
  hb.className = "hash-box";
  hb.textContent = f.hash;
  body.appendChild(hb);
  if (!f.revealed) {
    const p2 = document.createElement("p");
    p2.textContent = "牌山の中身は局が終了すると開封されます(いま開けたらイカサマし放題になってしまうので…)。";
    body.appendChild(p2);
  } else {
    const h2 = document.createElement("h3");
    h2.textContent = "開封: ソルトと山の並び順";
    body.appendChild(h2);
    const sb = document.createElement("div");
    sb.className = "hash-box";
    sb.textContent = "ソルト: " + f.salt;
    body.appendChild(sb);
    const ta = document.createElement("textarea");
    ta.className = "wall-order";
    ta.readOnly = true;
    ta.value = f.order;
    ta.setAttribute("aria-label", "牌山の並び順(牌種番号、rは赤5)");
    body.appendChild(ta);
    const note = document.createElement("p");
    note.textContent = "検証式: SHA-256(ソルト + \"|\" + 並び順)。数字は牌種(0〜8=萬子、9〜17=筒子、18〜26=索子、27〜33=東南西北白發中)、末尾rは赤5です。";
    body.appendChild(note);
    const res = document.createElement("p");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small";
    btn.textContent = "このページで再計算して照合する";
    btn.addEventListener("click", async () => {
      const h = await sha256Hex(f.salt + "|" + f.order);
      if (h === f.hash) {
        res.className = "verify-ok";
        res.textContent = "一致しました。牌山は配牌前の封緘どおりです。";
      } else {
        res.className = "verify-ng";
        res.textContent = "一致しません(これが出たらバグです。ご報告ください…)";
      }
    });
    body.appendChild(btn);
    body.appendChild(res);
  }
  $("dlg-fair").showModal();
}

/* ---------- 対局開始 ---------- */
function makeHooks() {
  return {
    event(e) { onEvent(e); render(); },
    delay: (kind) => sleepMs(SPEED_MS[speed][kind] ?? 200),
    roundEnd: (rr) => showRoundResult(rr),
  };
}

async function startGame() {
  $("log-list").innerHTML = "";
  $("start-screen").hidden = true;
  $("table").hidden = false;
  game = new Game({
    agents: [humanAgent(), makeAI(), makeAI(), makeAI()],
    names: NAMES,
    hooks: makeHooks(),
  });
  render();
  const result = await game.run();
  await showRoundResult(game.roundResult); // 最終局の結果
  showEndDialog(result);
}

/* ---------- 画面イベント ---------- */
$("btn-start").addEventListener("click", startGame);
$("btn-new").addEventListener("click", () => {
  if (!game || game.finished || window.confirm("進行中の対局を破棄して、新しい対局を始めますか?")) {
    location.reload();
  }
});
$("btn-again").addEventListener("click", () => location.reload());
$("btn-seal").addEventListener("click", openFairDialog);
$("btn-result-fair").addEventListener("click", openFairDialog);
$("btn-help").addEventListener("click", () => $("dlg-help").showModal());
$("btn-help-close").addEventListener("click", () => $("dlg-help").close());
$("btn-fair-close").addEventListener("click", () => $("dlg-fair").close());
$("speed").addEventListener("change", (ev) => { speed = ev.target.value; });

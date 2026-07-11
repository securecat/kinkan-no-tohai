"use strict";
/* ==========================================================
   対局進行(DOM非依存)+ CPU思考
   公正性の設計:
   - 山は crypto.getRandomValues による Fisher-Yates で生成
   - 配牌前に山全体を確定し、ソルト付きSHA-256を先に公開(コミットメント)
   - CPUの思考ルーチンには viewFor() が返す公開情報+自分の手牌のみを渡す
     (山・他家の手牌には構造上アクセスできない)
   ========================================================== */

/* ---------- 乱数・ハッシュ ---------- */
function secureInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  let x;
  do { crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % n;
}
function secureShuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function randomSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function wallSerialize(tiles) {
  return tiles.map((t) => t.k + (t.red ? "r" : "")).join(",");
}

/* ---------- ルール設定 ---------- */
const DEFAULT_RULES = {
  aka: true,          // 赤5(各色1枚)
  startScore: 25000,
  returnScore: 30000, // 終局・西入の判定基準
  tobi: true,
};

class Game {
  constructor({ rules = {}, agents, names, hooks }) {
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.agents = agents;
    this.hooks = hooks || { event() {}, delay: () => Promise.resolve() };
    this.players = [0, 1, 2, 3].map((seat) => ({
      seat, name: names[seat], score: this.rules.startScore,
    }));
    this.roundWind = EAST;
    this.kyoku = 1;
    this.dealer = secureInt(4);
    this.honba = 0;
    this.kyotaku = 0;
    this.finished = false;
    this.result = null;
    this.roundResult = null;
    this.fairness = null;
    this.roundsPlayed = 0;
  }

  emit(e) { this.hooks.event(e); }

  /* ----- 山 ----- */
  async buildWall() {
    const tiles = [];
    let id = 0;
    for (let k = 0; k < 34; k++) {
      for (let i = 0; i < 4; i++) {
        const red = this.rules.aka && i === 0 && (k === 4 || k === 13 || k === 22);
        tiles.push({ id: id++, k, red });
      }
    }
    secureShuffle(tiles);
    const salt = randomSalt();
    const order = wallSerialize(tiles);
    const hash = await sha256Hex(salt + "|" + order);
    this.fairness = { hash, salt, order, revealed: false };
    this.wallTiles = tiles;
    this.liveStart = 0;
    this.liveEnd = 122;
    this.dead = tiles.slice(122);
    this.rinshanUsed = 0;
    this.doraRevealed = 1;
    this.pendingDora = 0;
  }
  liveRemaining() { return this.liveEnd - this.liveStart; }
  draw() { return this.wallTiles[this.liveStart++]; }
  drawRinshan() {
    const t = this.dead[this.rinshanUsed++];
    this.liveEnd--;
    return t;
  }
  doraIndicators() {
    const a = [];
    for (let i = 0; i < this.doraRevealed; i++) a.push(this.dead[4 + i * 2]);
    return a;
  }
  uraIndicators() {
    const a = [];
    for (let i = 0; i < this.doraRevealed; i++) a.push(this.dead[5 + i * 2]);
    return a;
  }

  seatWind(seat) { return EAST + ((seat - this.dealer + 4) % 4); }
  kyokuLabel() {
    const w = { [EAST]: "東", [SOUTH]: "南", [WEST]: "西" }[this.roundWind];
    return `${w}${this.kyoku}局` + (this.honba ? ` ${this.honba}本場` : "");
  }

  async startRound() {
    await this.buildWall();
    for (const p of this.players) {
      p.hand = []; p.drawn = null; p.melds = []; p.river = [];
      p.riichi = false; p.doubleRiichi = false; p.ippatsu = false;
      p.furitenTemp = false; p.missedRiichiRon = false;
      p.waits = []; p.hasDrawn = false;
    }
    for (let r = 0; r < 13; r++) {
      for (let i = 0; i < 4; i++) this.players[(this.dealer + i) % 4].hand.push(this.draw());
    }
    for (const p of this.players) { this.sortHand(p); this.updateWaits(p); }
    this.callsHappened = false;
    this.passedSince = [new Set(), new Set(), new Set(), new Set()];
    this.roundsPlayed++;
    this.emit({ type: "roundStart", label: this.kyokuLabel(), hash: this.fairness.hash });
  }

  /* ----- 手牌ヘルパー ----- */
  closedTiles(p, withDrawn) {
    const a = p.hand.slice();
    if (withDrawn && p.drawn) a.push(p.drawn);
    return a;
  }
  closedCounts(p, withDrawn) { return toCounts(this.closedTiles(p, withDrawn).map((t) => t.k)); }
  meldCount(p) { return p.melds.length; }
  isMenzen(p) { return p.melds.every((m) => m.type === "ankan"); }
  sortHand(p) {
    p.hand.sort((a, b) => a.k - b.k || (a.red === b.red ? a.id - b.id : a.red ? 1 : -1));
  }
  updateWaits(p) { p.waits = waitsOf(this.closedCounts(p, false), this.meldCount(p)); }
  isFuriten(p) {
    if (p.furitenTemp || p.missedRiichiRon) return true;
    const rk = new Set(p.river.map((r) => r.tile.k));
    return p.waits.some((k) => rk.has(k));
  }

  buildCtx(p, winTile, tsumo, flags) {
    const counts = this.closedCounts(p, false);
    counts[winTile.k]++;
    const closedRed = this.closedTiles(p, false).filter((t) => t.red).length + (winTile.red ? 1 : 0);
    const meldRed = p.melds.reduce((s, m) => s + m.tiles.filter((t) => t.red).length, 0);
    return {
      closedCounts: counts,
      melds: p.melds.map((m) => ({ type: m.type, k: m.k })),
      winTile: winTile.k, tsumo,
      riichi: p.riichi && !p.doubleRiichi,
      doubleRiichi: p.doubleRiichi,
      ippatsu: p.ippatsu,
      rinshan: !!flags.rinshan, chankan: !!flags.chankan,
      haitei: !!flags.haitei, houtei: !!flags.houtei,
      tenhou: !!flags.tenhou, chiihou: !!flags.chiihou,
      seatWind: this.seatWind(p.seat), roundWind: this.roundWind,
      doraInds: this.doraIndicators().map((t) => t.k),
      uraInds: this.uraIndicators().map((t) => t.k),
      akaCount: closedRed + meldRed,
    };
  }

  canWin(p, tile, tsumo, flags) {
    const c = this.closedCounts(p, false);
    c[tile.k]++;
    if (shanten(c, this.meldCount(p)) !== -1) return null;
    return scoreHand(this.buildCtx(p, tile, tsumo, flags));
  }

  /* ----- 公開情報ビュー(CPUに渡す唯一の情報) ----- */
  viewFor(p) {
    return {
      seat: p.seat,
      hand: this.closedTiles(p, true).map((t) => ({ ...t })),
      drawnId: p.drawn ? p.drawn.id : null,
      meldCount: this.meldCount(p),
      menzen: this.isMenzen(p),
      riichi: p.riichi,
      myWaits: p.waits.slice(),
      furiten: this.isFuriten(p),
      seatWind: this.seatWind(p.seat),
      roundWind: this.roundWind,
      remaining: this.liveRemaining(),
      doraInds: this.doraIndicators().map((t) => t.k),
      score: p.score,
      players: this.players.map((q) => ({
        seat: q.seat, riichi: q.riichi,
        meldTiles: q.melds.flatMap((m) => m.tiles.map((t) => t.k)),
        river: q.river.map((r) => r.tile.k),
        score: q.score,
      })),
      passedSince: this.passedSince.map((s) => new Set(s)),
    };
  }

  /* ----- 行動オプション ----- */
  turnOptions(p, flags) {
    const opts = { tsumo: false, riichiTiles: [], ankan: [], kakan: [], riichi: p.riichi };
    const win = this.canWin(p, p.drawn, true, flags);
    if (win) opts.tsumo = win;
    const cAll = this.closedCounts(p, true);
    if (this.liveRemaining() >= 1) {
      for (let k = 0; k < 34; k++) {
        if (cAll[k] !== 4) continue;
        if (p.riichi) {
          if (p.drawn.k !== k) continue;
          const before = p.waits.slice().sort((a, b) => a - b).join(",");
          const c2 = cAll.slice(); c2[k] = 0;
          const after = waitsOf(c2, this.meldCount(p) + 1).sort((a, b) => a - b).join(",");
          if (before !== after) continue;
        }
        opts.ankan.push(k);
      }
      if (!p.riichi) {
        for (const m of p.melds) {
          if (m.type === "pon" && cAll[m.k] >= 1) opts.kakan.push(m.k);
        }
      }
    }
    if (!p.riichi && this.isMenzen(p) && p.score >= 1000 && this.liveRemaining() >= 4) {
      const tiles = this.closedTiles(p, true);
      const seen = new Set();
      for (const t of tiles) {
        if (seen.has(t.k)) continue;
        seen.add(t.k);
        const c = toCounts(tiles.filter((x) => x.id !== t.id).map((x) => x.k));
        if (shanten(c, this.meldCount(p)) === 0) {
          opts.riichiTiles.push(...tiles.filter((x) => x.k === t.k).map((x) => x.id));
        }
      }
    }
    return opts;
  }

  removeFromHand(p, tileId) {
    if (p.drawn && p.drawn.id === tileId) {
      const t = p.drawn; p.drawn = null; return t;
    }
    const i = p.hand.findIndex((t) => t.id === tileId);
    if (i < 0) throw new Error("illegal tileId " + tileId);
    const t = p.hand[i];
    p.hand.splice(i, 1);
    if (p.drawn) { p.hand.push(p.drawn); p.drawn = null; }
    return t;
  }

  /* ----- 局のメインループ ----- */
  async playRound() {
    await this.startRound();
    let cur = this.dealer;
    let rinshan = false;

    while (true) {
      const p = this.players[cur];
      if (!rinshan && this.liveRemaining() === 0) return this.ryuukyoku();

      p.drawn = rinshan ? this.drawRinshan() : this.draw();
      p.furitenTemp = false;
      const firstDraw = !p.hasDrawn && !this.callsHappened && !rinshan;
      p.hasDrawn = true;
      this.emit({ type: "draw", seat: cur });
      await this.hooks.delay("draw");

      let flags = {
        rinshan,
        haitei: this.liveRemaining() === 0 && !rinshan,
        tenhou: firstDraw && cur === this.dealer,
        chiihou: firstDraw && cur !== this.dealer,
      };
      let opts = this.turnOptions(p, flags);
      let act = await this.agents[cur].turnAction(this.viewFor(p), opts);

      /* --- カン(連鎖しうる) --- */
      while (act.type === "ankan" || act.type === "kakan") {
        if (act.type === "kakan") {
          const kakanTile = this.closedTiles(p, true).find((t) => t.k === act.k);
          const robbed = await this.checkRons(cur, kakanTile, { chankan: true });
          if (robbed != null) return this.winByRon(robbed, cur, kakanTile, { chankan: true });
          this.removeFromHand(p, kakanTile.id);
          const m = p.melds.find((x) => x.type === "pon" && x.k === act.k);
          m.type = "kakan";
          m.tiles.push(kakanTile);
          this.pendingDora++;
          this.emit({ type: "call", call: "kakan", seat: cur, k: act.k, from: cur });
        } else {
          const tiles = this.closedTiles(p, true).filter((t) => t.k === act.k);
          for (const t of tiles) this.removeFromHand(p, t.id);
          p.melds.push({ type: "ankan", k: act.k, tiles, from: -1 });
          this.doraRevealed = Math.min(5, this.doraRevealed + 1);
          this.emit({ type: "call", call: "ankan", seat: cur, k: act.k, from: cur });
        }
        this.callsHappened = true;
        for (const q of this.players) q.ippatsu = false;
        this.updateWaits(p);
        await this.hooks.delay("call");
        if (this.liveRemaining() === 0) return this.ryuukyoku();
        p.drawn = this.drawRinshan();
        this.emit({ type: "draw", seat: cur });
        await this.hooks.delay("draw");
        flags = { rinshan: true, haitei: false };
        opts = this.turnOptions(p, flags);
        act = await this.agents[cur].turnAction(this.viewFor(p), opts);
      }

      if (act.type === "tsumo") return this.winByTsumo(cur, flags);

      /* --- 打牌 → 照会ループ --- */
      const res = await this.discardAndClaims(cur, act);
      if (res.end) return;
      cur = res.nextCur;
      rinshan = res.rinshan;
    }
  }

  /* 打牌1回+それに対するロン/鳴き照会。鳴き連鎖もここでループ処理 */
  async discardAndClaims(cur, act) {
    let p = this.players[cur];
    const declaringRiichi = act.type === "riichi";
    let tile = this.removeFromHand(p, act.tileId);
    this.sortHand(p);
    let riverItem = { tile, riichi: declaringRiichi, called: false };
    p.river.push(riverItem);
    this.updateWaits(p);
    this.emit({ type: "discard", seat: cur, tile, riichi: declaringRiichi });
    await this.hooks.delay("discard");

    let riichiPending = declaringRiichi;
    let from = cur;

    while (true) {
      const houtei = this.liveRemaining() === 0;
      const ronSeat = await this.checkRons(from, tile, { houtei });
      if (ronSeat != null) {
        await this.winByRon(ronSeat, from, tile, { houtei });
        return { end: true };
      }
      // 通過: 見逃しフリテン
      for (let i = 1; i < 4; i++) {
        const q = this.players[(from + i) % 4];
        if (q.waits.includes(tile.k)) {
          if (q.riichi) q.missedRiichiRon = true;
          else q.furitenTemp = true;
        }
      }
      // リーチ成立(宣言牌が通ったとき)
      if (riichiPending) {
        const rp = this.players[from];
        rp.riichi = true;
        rp.doubleRiichi = rp.river.length === 1 && !this.callsHappened;
        rp.ippatsu = true;
        rp.score -= 1000;
        this.kyotaku++;
        this.emit({ type: "riichi", seat: from, double: rp.doubleRiichi });
        await this.hooks.delay("riichi");
        riichiPending = false;
      } else if (this.players[from].ippatsu) {
        this.players[from].ippatsu = false; // リーチ後、次の打牌が通ったら一発消滅
      }
      for (let s = 0; s < 4; s++) {
        if (this.players[s].riichi && s !== from) this.passedSince[s].add(tile.k);
      }
      while (this.pendingDora > 0 && this.doraRevealed < 5) {
        this.doraRevealed++; this.pendingDora--;
      }
      this.pendingDora = 0;

      if (houtei) { await this.ryuukyoku(); return { end: true }; }

      const call = await this.checkCalls(from, tile);
      if (!call) return { end: false, nextCur: (from + 1) % 4, rinshan: false };

      riverItem.called = true;
      this.callsHappened = true;
      for (const q of this.players) q.ippatsu = false;
      const caller = this.players[call.seat];
      this.emit({ type: "call", call: call.type, seat: call.seat, k: call.k, from });
      await this.hooks.delay("call");

      if (call.type === "minkan") {
        const tiles = caller.hand.filter((t) => t.k === tile.k).slice(0, 3);
        for (const t of tiles) this.removeFromHand(caller, t.id);
        caller.melds.push({ type: "minkan", k: tile.k, tiles: [...tiles, tile], from });
        this.pendingDora++;
        this.updateWaits(caller);
        return { end: false, nextCur: call.seat, rinshan: true };
      }
      if (call.type === "pon") {
        // 赤でない方を優先して晒す(赤は手に残す方が自然だが、2枚しかなければ赤も)
        const cand = caller.hand.filter((t) => t.k === tile.k);
        cand.sort((a, b) => (a.red === b.red ? 0 : a.red ? 1 : -1));
        const tiles = cand.slice(0, 2);
        for (const t of tiles) this.removeFromHand(caller, t.id);
        caller.melds.push({ type: "pon", k: tile.k, tiles: [...tiles, tile], from });
      } else { // chi
        const need = [call.k, call.k + 1, call.k + 2].filter((k) => k !== tile.k);
        const tiles = [];
        for (const k of need) {
          const cand = caller.hand.filter((t) => t.k === k && !tiles.includes(t));
          cand.sort((a, b) => (a.red === b.red ? 0 : a.red ? 1 : -1));
          tiles.push(cand[0]);
        }
        for (const t of tiles) this.removeFromHand(caller, t.id);
        caller.melds.push({
          type: "chi", k: call.k,
          tiles: [...tiles, tile].sort((a, b) => a.k - b.k), from,
        });
      }
      this.updateWaits(caller);

      // 鳴いた人の打牌(喰い替え禁止)
      const forbidden = new Set([tile.k]);
      if (call.type === "chi") {
        if (tile.k === call.k && numOf(call.k) <= 6) forbidden.add(call.k + 3);
        if (tile.k === call.k + 2 && numOf(call.k) >= 2) forbidden.add(call.k - 1);
      }
      const legal = caller.hand.filter((t) => !forbidden.has(t.k));
      const pool = legal.length ? legal : caller.hand;
      const tid = await this.agents[call.seat].discardAfterCall(
        this.viewFor(caller),
        { forbiddenKinds: [...forbidden], legalIds: pool.map((t) => t.id) }
      );
      const out = this.removeFromHand(caller, tid);
      this.sortHand(caller);
      riverItem = { tile: out, riichi: false, called: false };
      caller.river.push(riverItem);
      this.updateWaits(caller);
      this.emit({ type: "discard", seat: call.seat, tile: out, riichi: false });
      await this.hooks.delay("discard");

      from = call.seat;
      tile = out;
      // ループ先頭に戻り、この打牌へのロン/鳴きを照会
    }
  }

  /* ロン照会: 頭ハネで最初の1人 */
  async checkRons(from, tile, flags) {
    for (let i = 1; i < 4; i++) {
      const s = (from + i) % 4;
      const q = this.players[s];
      if (!q.waits.includes(tile.k)) continue;
      if (this.isFuriten(q)) continue;
      const win = this.canWin(q, tile, false, flags);
      if (!win) continue;
      const act = await this.agents[s].claimAction(this.viewFor(q), {
        ron: win, tile: { ...tile }, from, pon: false, minkan: false, chi: [],
      });
      if (act.type === "ron") return s;
      if (q.riichi) q.missedRiichiRon = true;
      else q.furitenTemp = true;
    }
    return null;
  }

  /* ポン/明槓/チーの照会(ポン候補は高々1人) */
  async checkCalls(from, tile) {
    if (this.liveRemaining() === 0) return null;
    let ponAskedSeat = -1;
    for (let i = 1; i < 4; i++) {
      const s = (from + i) % 4;
      const q = this.players[s];
      if (q.riichi) continue;
      const cnt = q.hand.filter((t) => t.k === tile.k).length;
      if (cnt < 2) continue;
      const chi = s === (from + 1) % 4 && !isHonor(tile.k) ? this.chiPatterns(q, tile) : [];
      const act = await this.agents[s].claimAction(this.viewFor(q), {
        ron: null, tile: { ...tile }, from, pon: true, minkan: cnt >= 3, chi,
      });
      if (act.type === "pon") return { type: "pon", seat: s, k: tile.k };
      if (act.type === "minkan" && cnt >= 3) return { type: "minkan", seat: s, k: tile.k };
      if (act.type === "chi" && chi.includes(act.k)) return { type: "chi", seat: s, k: act.k };
      ponAskedSeat = s;
      break;
    }
    const s = (from + 1) % 4;
    const q = this.players[s];
    if (s !== ponAskedSeat && !q.riichi && !isHonor(tile.k)) {
      const pats = this.chiPatterns(q, tile);
      if (pats.length) {
        const act = await this.agents[s].claimAction(this.viewFor(q), {
          ron: null, tile: { ...tile }, from, pon: false, minkan: false, chi: pats,
        });
        if (act.type === "chi" && pats.includes(act.k)) return { type: "chi", seat: s, k: act.k };
      }
    }
    return null;
  }

  chiPatterns(q, tile) {
    const pats = [];
    const sameSuit = (k) => k >= 0 && k < 27 && suitOf(k) === suitOf(tile.k);
    const has = (k) => sameSuit(k) && q.hand.some((t) => t.k === k);
    const n = numOf(tile.k);
    if (n >= 3 && has(tile.k - 2) && has(tile.k - 1)) pats.push(tile.k - 2);
    if (n >= 2 && n <= 8 && has(tile.k - 1) && has(tile.k + 1)) pats.push(tile.k - 1);
    if (n <= 7 && has(tile.k + 1) && has(tile.k + 2)) pats.push(tile.k);
    // 喰い替えで打てる牌が残らないパターンは除外
    return pats.filter((k) => {
      const c = toCounts(q.hand.map((t) => t.k));
      for (const x of [k, k + 1, k + 2]) if (x !== tile.k) c[x]--;
      const forbidden = new Set([tile.k]);
      if (tile.k === k && numOf(k) <= 6) forbidden.add(k + 3);
      if (tile.k === k + 2 && numOf(k) >= 2) forbidden.add(k - 1);
      let rest = 0;
      for (let x = 0; x < 34; x++) if (!forbidden.has(x)) rest += c[x];
      return rest > 0;
    });
  }

  /* ----- 和了・流局 ----- */
  async winByTsumo(seat, flags) {
    const p = this.players[seat];
    const win = this.canWin(p, p.drawn, true, flags);
    const isDealer = seat === this.dealer;
    const pay = payments(win.base, isDealer, true);
    const delta = [0, 0, 0, 0];
    for (let i = 1; i < 4; i++) {
      const s = (seat + i) % 4;
      const amount = isDealer ? pay.tsumoAll : (s === this.dealer ? pay.tsumoDealer : pay.tsumoOther);
      delta[s] = -(amount + this.honba * 100);
    }
    delta[seat] = -(delta.reduce((a, b) => a + b, 0));
    const tile = p.drawn;
    p.hand.push(p.drawn); p.drawn = null;
    this.sortHand(p);
    // 和了牌を手牌から除いた形で記録
    const idx = p.hand.findIndex((t) => t.id === tile.id);
    p.hand.splice(idx, 1);
    await this.settleWin(seat, null, win, delta, tile, true);
  }

  async winByRon(seat, from, tile, flags) {
    const p = this.players[seat];
    const win = this.canWin(p, tile, false, flags);
    const isDealer = seat === this.dealer;
    const pay = payments(win.base, isDealer, false);
    const delta = [0, 0, 0, 0];
    delta[from] = -(pay.ron + this.honba * 300);
    delta[seat] = pay.ron + this.honba * 300;
    await this.settleWin(seat, from, win, delta, tile, false);
  }

  async settleWin(seat, from, win, delta, tile, tsumo) {
    for (let s = 0; s < 4; s++) this.players[s].score += delta[s];
    const p = this.players[seat];
    p.score += this.kyotaku * 1000;
    const kyotakuWon = this.kyotaku;
    this.kyotaku = 0;
    this.fairness.revealed = true;
    this.roundResult = {
      type: "win", seat, from, tsumo, win, delta, kyotakuWon,
      honba: this.honba,
      tile: { ...tile },
      hand: this.closedTiles(p, false).map((t) => ({ ...t })),
      melds: p.melds.map((m) => ({ type: m.type, k: m.k, tiles: m.tiles.map((t) => ({ ...t })), from: m.from })),
      uraShown: (p.riichi || p.doubleRiichi) ? this.uraIndicators().map((t) => ({ ...t })) : [],
      doraShown: this.doraIndicators().map((t) => ({ ...t })),
      label: this.kyokuLabel(),
      scores: this.players.map((q) => q.score),
    };
    this.emit({ type: "win", ...this.roundResult });
    this.advanceRound(seat === this.dealer, seat);
  }

  async ryuukyoku() {
    const tenpai = this.players.map(
      (p) => shanten(this.closedCounts(p, false), this.meldCount(p)) === 0
    );
    const n = tenpai.filter(Boolean).length;
    const delta = [0, 0, 0, 0];
    if (n > 0 && n < 4) {
      const get = 3000 / n, pay = 3000 / (4 - n);
      for (let s = 0; s < 4; s++) delta[s] = tenpai[s] ? get : -pay;
      for (let s = 0; s < 4; s++) this.players[s].score += delta[s];
    }
    this.fairness.revealed = true;
    this.roundResult = {
      type: "ryuukyoku", tenpai, delta, label: this.kyokuLabel(),
      hands: this.players.map((p, s) => (tenpai[s] ? this.closedTiles(p, false).map((t) => ({ ...t })) : null)),
      scores: this.players.map((q) => q.score),
    };
    this.emit({ type: "ryuukyoku", ...this.roundResult });
    this.advanceRound(tenpai[this.dealer], null);
  }

  advanceRound(dealerKeeps, winnerSeat) {
    if (this.finished) return;
    if (this.rules.tobi && this.players.some((p) => p.score < 0)) return this.finishGame("tobi");
    if (this.roundsPlayed >= 200) return this.finishGame("end");
    const isOorasu = this.roundWind === SOUTH && this.kyoku === 4;
    if (this.roundWind === WEST) {
      if (this.topScore() >= this.rules.returnScore || this.kyoku === 4) return this.finishGame("end");
    }
    if (dealerKeeps) {
      this.honba++;
      if (isOorasu && winnerSeat === this.dealer && this.topScore() >= this.rules.returnScore) {
        return this.finishGame("end");
      }
      return;
    }
    this.honba = winnerSeat != null && winnerSeat !== this.dealer ? 0 : this.honba + 1;
    this.kyoku++;
    this.dealer = (this.dealer + 1) % 4;
    if (this.kyoku > 4) {
      this.kyoku = 1;
      if (this.roundWind === EAST) this.roundWind = SOUTH;
      else if (this.roundWind === SOUTH) {
        if (this.topScore() >= this.rules.returnScore) return this.finishGame("end");
        this.roundWind = WEST;
      }
    }
  }

  topScore() { return Math.max(...this.players.map((p) => p.score)); }

  finishGame(reason) {
    this.finished = true;
    if (this.kyotaku > 0) {
      const top = this.players.reduce((a, b) => (b.score > a.score ? b : a));
      top.score += this.kyotaku * 1000;
      this.kyotaku = 0;
    }
    const order = this.players.slice().sort((a, b) => b.score - a.score || a.seat - b.seat);
    this.result = {
      reason,
      ranking: order.map((p) => ({ seat: p.seat, name: p.name, score: p.score })),
    };
    this.emit({ type: "gameEnd", ...this.result });
  }

  async run() {
    while (!this.finished) {
      await this.playRound();
      if (!this.finished && this.hooks.roundEnd) await this.hooks.roundEnd(this.roundResult);
    }
    return this.result;
  }
}

/* ==========================================================
   CPU思考(viewのみ参照 = 構造上イカサマ不可能)
   ========================================================== */
function makeAI() {
  const countVisible = (view) => {
    const c = new Array(34).fill(0);
    for (const t of view.hand) c[t.k]++;
    for (const k of view.doraInds) c[k]++;
    for (const q of view.players) {
      for (const k of q.river) c[k]++;
      for (const k of q.meldTiles) c[k]++;
    }
    return c;
  };

  function evalDiscards(view) {
    const vis = countVisible(view);
    const rep = new Map();
    for (const t of view.hand) {
      const prev = rep.get(t.k);
      if (!prev || (prev.red && !t.red)) rep.set(t.k, t);
    }
    const results = [];
    for (const t of rep.values()) {
      const c = toCounts(view.hand.filter((x) => x.id !== t.id).map((x) => x.k));
      const sh = shanten(c, view.meldCount);
      let ukeire = 0;
      if (sh >= 0) {
        for (let k = 0; k < 34; k++) {
          if (c[k] >= 4) continue;
          c[k]++;
          if (shanten(c, view.meldCount) < sh) ukeire += Math.max(0, 4 - vis[k]);
          c[k]--;
        }
      }
      results.push({ tile: t, sh, ukeire });
    }
    results.sort((a, b) => a.sh - b.sh || b.ukeire - a.ukeire);
    return results;
  }

  const threatSeats = (view) =>
    view.players.filter((q) => q.seat !== view.seat && q.riichi).map((q) => q.seat);

  function safestTile(view, threats, pool) {
    const vis = countVisible(view);
    let best = null, bestRank = Infinity;
    for (const t of pool) {
      let rank;
      const genbutsu = threats.every(
        (s) => view.passedSince[s].has(t.k) ||
          view.players.find((q) => q.seat === s).river.includes(t.k)
      );
      if (genbutsu) rank = 0;
      else if (isHonor(t.k)) rank = vis[t.k] >= 3 ? 1 : 5 - vis[t.k];
      else if (isTerminal(t.k)) rank = 6;
      else rank = 8 + (4 - Math.abs(numOf(t.k) - 5));
      if (rank < bestRank) { bestRank = rank; best = t; }
    }
    return best;
  }

  function hasYakuProspect(view, c) {
    let yao = 0;
    for (let k = 0; k < 34; k++) if (isYaochuu(k)) yao += c[k];
    if (yao <= 2) return true;
    const yakuhai = [HAKU, HATSU, CHUN, view.seatWind, view.roundWind];
    if (yakuhai.some((k) => c[k] >= 2)) return true;
    const suits = new Set();
    for (let k = 0; k < 27; k++) if (c[k] > 0) suits.add(suitOf(k));
    if (suits.size <= 1) return true;
    const myMelds = view.players.find((q) => q.seat === view.seat).meldTiles;
    return myMelds.some((k) => yakuhai.includes(k));
  }

  return {
    async turnAction(view, opts) {
      if (opts.tsumo) return { type: "tsumo" };
      for (const k of opts.ankan) {
        const c = toCounts(view.hand.map((t) => t.k));
        const before = shanten(c, view.meldCount);
        const c2 = c.slice(); c2[k] = 0;
        if (view.riichi || shanten(c2, view.meldCount + 1) <= before) return { type: "ankan", k };
      }
      if (view.riichi) return { type: "discard", tileId: view.drawnId };

      const evals = evalDiscards(view);
      const threats = threatSeats(view);
      if (opts.riichiTiles.length && !view.furiten && !(threats.length && evals[0].sh > 0)) {
        let best = null;
        for (const id of opts.riichiTiles) {
          const t = view.hand.find((x) => x.id === id);
          const e = evals.find((x) => x.tile.k === t.k);
          const uk = e ? e.ukeire : 0;
          if (!best || uk > best.uk) best = { id, uk };
        }
        return { type: "riichi", tileId: best.id };
      }
      const mySh = evals[0].sh;
      if (threats.length && mySh >= 2) {
        const t = safestTile(view, threats, view.hand);
        if (t) return { type: "discard", tileId: t.id };
      }
      return { type: "discard", tileId: evals[0].tile.id };
    },

    async claimAction(view, opts) {
      if (opts.ron) return { type: "ron" };
      if (view.riichi) return { type: "pass" };
      const c = toCounts(view.hand.map((t) => t.k));
      const before = shanten(c, view.meldCount);
      const yakuhai = [HAKU, HATSU, CHUN, view.seatWind, view.roundWind];
      if (opts.pon && yakuhai.includes(opts.tile.k)) return { type: "pon" };
      if (threatSeats(view).length) return { type: "pass" };
      if (opts.pon && view.meldCount > 0 && hasYakuProspect(view, c)) {
        const c2 = c.slice(); c2[opts.tile.k] -= 2;
        if (shanten(c2, view.meldCount + 1) < before) return { type: "pon" };
      }
      if (opts.chi.length && before <= 2 && before >= 1 && hasYakuProspect(view, c)) {
        for (const k of opts.chi) {
          const c2 = c.slice();
          for (const x of [k, k + 1, k + 2]) if (x !== opts.tile.k) c2[x]--;
          if (shanten(c2, view.meldCount + 1) < before) return { type: "chi", k };
        }
      }
      return { type: "pass" };
    },

    async discardAfterCall(view, opts) {
      const legal = new Set(opts.legalIds);
      const threats = threatSeats(view);
      if (threats.length) {
        const pool = view.hand.filter((t) => legal.has(t.id));
        const c = toCounts(view.hand.map((t) => t.k));
        if (shanten(c, view.meldCount) >= 2) {
          const t = safestTile(view, threats, pool);
          if (t) return t.id;
        }
      }
      const evals = evalDiscards(view).filter((e) => legal.has(e.tile.id));
      if (evals.length) return evals[0].tile.id;
      return opts.legalIds[0];
    },
  };
}

/* ---------- Node テスト用エクスポート ---------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { Game, makeAI, sha256Hex, wallSerialize, secureShuffle, DEFAULT_RULES };
}

"use strict";
const E = require("../src/engine.js");
Object.assign(globalThis, E);
const { Game, makeAI, sha256Hex } = require("../src/game.js");

const N = Number(process.argv[2] || 30);

(async () => {
  const stats = { games: 0, rounds: 0, wins: 0, tsumo: 0, ron: 0, ryuukyoku: 0, riichi: 0, calls: 0, yaku: {}, maxHan: 0 };
  for (let g = 0; g < N; g++) {
    const agents = [makeAI(), makeAI(), makeAI(), makeAI()];
    const game = new Game({
      agents,
      names: ["A", "B", "C", "D"],
      hooks: {
        event(e) {
          const sum = game.players.reduce((a, p) => a + p.score, 0) + game.kyotaku * 1000;
          if (sum !== 100000) {
            console.log("INVARIANT BROKEN", sum, JSON.stringify(e).slice(0, 200));
            process.exit(1);
          }
          if (e.type === "roundStart") stats.rounds++;
          if (e.type === "riichi") stats.riichi++;
          if (e.type === "call") stats.calls++;
          if (e.type === "win") {
            stats.wins++;
            e.tsumo ? stats.tsumo++ : stats.ron++;
            for (const y of e.win.yaku) stats.yaku[y.name] = (stats.yaku[y.name] || 0) + 1;
            stats.maxHan = Math.max(stats.maxHan, e.win.han);
          }
          if (e.type === "ryuukyoku") stats.ryuukyoku++;
        },
        delay: () => Promise.resolve(),
      },
    });
    const result = await game.run();
    // コミットメント検証
    const h = await sha256Hex(game.fairness.salt + "|" + game.fairness.order);
    if (h !== game.fairness.hash) { console.log("HASH MISMATCH"); process.exit(1); }
    if (!result || !result.ranking) { console.log("NO RESULT"); process.exit(1); }
    stats.games++;
  }
  console.log(`games=${stats.games} rounds=${stats.rounds} win=${stats.wins} (tsumo=${stats.tsumo} ron=${stats.ron}) ryuukyoku=${stats.ryuukyoku}`);
  console.log(`riichi=${stats.riichi} calls=${stats.calls} maxHan=${stats.maxHan}`);
  const top = Object.entries(stats.yaku).sort((a, b) => b[1] - a[1]).slice(0, 14);
  console.log("yaku:", top.map(([n, c]) => `${n}:${c}`).join(" "));
})().catch((err) => { console.error("CRASH:", err); process.exit(1); });

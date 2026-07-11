"use strict";
const fs = require("fs");
const { JSDOM } = require("jsdom");

let html = fs.readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8");
const m = html.match(/<script type="module">([\s\S]*)<\/script>/);
let script = m[1];
html = html.replace(m[0], "");

// テスト用: 演出ディレイをゼロに
script = script.replace(/normal: \{[^}]*\},/, "normal: {draw:0,discard:0,call:0,riichi:0},");
script = script.replace(/fast: \{[^}]*\},/, "fast: {draw:0,discard:0,call:0,riichi:0},");
script = script.replace(/await sleepMs\(\d+\);/g, "await sleepMs(0);");

const dom = new JSDOM(html, { pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
  process.exit(1);
});

// jsdom は showModal 未実装なのでテスト用ポリフィル
const dlgProto = window.HTMLDialogElement.prototype;
dlgProto.showModal = function () { this.setAttribute("open", ""); };
dlgProto.close = function () {
  this.removeAttribute("open");
  const ev = new window.Event("close");
  if (typeof this.onclose === "function") this.onclose(ev);
  this.dispatchEvent(ev);
};

const fn = new Function("window", "document", "location", script);
try {
  fn(window, document, { reload() {} });
} catch (err) {
  console.error("SCRIPT INIT ERROR:", err);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  document.getElementById("btn-start").click();
  const t0 = Date.now();
  let clicks = 0, rounds = 0;
  let lastKyoku = "";
  while (Date.now() - t0 < 150000) {
    await sleep(2);
    const k = document.getElementById("c-kyoku").textContent;
    if (k !== lastKyoku) { lastKyoku = k; rounds++; }
    const dlgEnd = document.getElementById("dlg-end");
    if (dlgEnd.open) {
      console.log(`GAME COMPLETED: ${clicks} clicks, kyoku changes=${rounds}`);
      console.log("end body:", document.getElementById("end-body").textContent.replace(/\s+/g, " ").slice(0, 200));
      process.exit(0);
    }
    const dlgResult = document.getElementById("dlg-result");
    if (dlgResult.open) {
      document.getElementById("btn-next").click();
      continue;
    }
    const actions = [...document.querySelectorAll("#action-buttons button")];
    const winBtn = actions.find((b) => /ツモ\(|^ロン$/.test(b.textContent));
    if (winBtn) { winBtn.click(); clicks++; continue; }
    const pass = actions.find((b) => b.textContent === "スルー");
    if (pass && Math.random() < 0.6) { pass.click(); clicks++; continue; }
    const tiles = [...document.querySelectorAll("#hand button")].filter((b) => !b.disabled);
    if (tiles.length && (!actions.length || Math.random() < 0.85)) {
      tiles[Math.floor(Math.random() * tiles.length)].click();
      clicks++;
      continue;
    }
    if (actions.length) {
      actions[Math.floor(Math.random() * actions.length)].click();
      clicks++;
    }
  }
  console.error("TIMEOUT: game did not finish. label=", document.getElementById("prompt-label").textContent);
  process.exit(1);
})();

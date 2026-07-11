"use strict";
/* src/ の3層+テンプレートを結合して index.html を生成する */
const fs = require("fs");
const path = require("path");
const src = (f) => fs.readFileSync(path.join(__dirname, "src", f), "utf8");
const version = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
const out = src("template.html")
  .replace("@@VERSION@@", version)
  .replace("//@@ENGINE@@", src("engine.js"))
  .replace("//@@GAME@@", src("game.js"))
  .replace("//@@UI@@", src("ui.js"));
fs.writeFileSync(path.join(__dirname, "index.html"), out);
console.log("index.html generated (" + out.length + " bytes)");

// パレット一元化の機械検証（Issue #59）。
//
// なぜ要るか: 描画色は styles.css の CSS 変数と waveform.js の THEME_COLORS の
// 「2箇所」にある。waveform.js は canvas 性能予算のため getComputedStyle を使わない
// canvas 性能予算のため getComputedStyle を避ける設計上、この二重管理は意図的に残る。
// 代償として片方だけ直すとサイレントにズレる。実際 #59 の着手前は 7 組がズレていた
// （A.peak / B.peak が別色、clip・overlap の α 違いなど）。
// このテストが「2箇所同時に直す」を強制する。
//
// styles.css は正規表現でパースする（CSS パーサを足すほどの構造は読まない）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cssPath = path.join(repoRoot, "src", "podcast_prep", "static", "styles.css");
const wavePath = path.join(repoRoot, "src", "podcast_prep", "static", "js", "waveform.js");

// 色文字列の正規化: 大小・空白の揺れを吸収して比較する
// （"#FFF" と "#ffffff"、"rgba(1,2,3,0.1)" と "rgba(1, 2, 3, 0.1)" を同一視）。
function normalizeColor(raw) {
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, "");
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return s;
}

// styles.css から :root ブロックとダーク上書きブロックの変数を取り出す。
// light = トップレベル（@media 外）の `:root {...}` を全部、出現順に後勝ちで畳む
// dark  = light の上に `@media (prefers-color-scheme: dark)` 内の `:root {...}` を重ねる
//
// 「全部の :root を畳む」のが要点。最初の1ブロックだけ読むと、ダークブロックより後に
// 置かれた `:root` 上書き（ブラウザのカスケードでは勝つ）がテストから見えず、
// 実際の描画色とズレたまま全通過する穴になる。
function parseCssVars(rawCss) {
  // コメントは宣言ではない。剥がさずにパースすると、コメント内に書き残した旧値が
  // 実値を上書きして見え（後勝ちのため）、実値を変えてもテストが気づかなくなる。
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

  // `:root { ... }` を本文つきで列挙する。トップレベルか @media 内かは、
  // ブロック開始位置までに現れた「ダーク @media の開き括弧」との前後で判定する。
  const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
  assert.ok(darkStart >= 0, "styles.css にダークの @media ブロックが見つからない");
  // ダーク @media の本文範囲を、括弧の対応を数えて求める（@media は入れ子になりうる）
  const braceOpen = css.indexOf("{", darkStart);
  let depth = 0;
  let darkEnd = css.length;
  for (let i = braceOpen; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        darkEnd = i;
        break;
      }
    }
  }

  const light = {};
  const dark = {};
  let sawLight = false;
  let sawDark = false;

  for (const m of css.matchAll(/(^|[\s}])(:root)\s*\{([^{}]*)\}/g)) {
    const at = m.index + m[0].indexOf(":root");
    const inDark = at > braceOpen && at < darkEnd;
    if (inDark) sawDark = true;
    else sawLight = true;
    mergeDeclarations(inDark ? dark : light, m[3], inDark ? "dark" : "light");
  }

  assert.ok(sawLight, "styles.css に :root ブロックが見つからない");
  assert.ok(sawDark, "ダーク @media 内に :root ブロックが見つからない");

  // ダークは light の上書きなので、未指定の変数は light から継承する
  return { light, dark: { ...light, ...dark } };
}

// 1ブロック分の宣言を out に足す。同じ変数が同一テーマ内で2回宣言されていたら落とす。
// 後勝ちで黙って上書きされると「直したつもりが効いていない」を見逃すため。
function mergeDeclarations(out, body, themeLabel) {
  const seen = new Set();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const name = m[1].toLowerCase();
    assert.ok(
      !seen.has(name),
      `${themeLabel}: ${name} が同一 :root ブロックで重複宣言されている`,
    );
    seen.add(name);
    assert.ok(
      !(name in out),
      `${themeLabel}: ${name} が複数の :root ブロックで宣言されている` +
        "（後勝ちでカスケードが読みにくい。1箇所に集約すること）",
    );
    out[name] = normalizeColor(m[2]);
  }
}

const css = parseCssVars(await readFile(cssPath, "utf8"));
const { THEME_COLORS } = await import(path.join(wavePath));

// waveform.js のキー → 対応する CSS 変数の対応表。
// ここに載っているものは「完全一致」が契約。値を変えるときは両方直す。
const EXACT_MATCH = [
  ["A.clip", "--spk-a-soft"],
  ["A.text", "--spk-a"],
  ["B.clip", "--spk-b-soft"],
  ["B.text", "--spk-b"],
  ["overlap", "--seam-soft"],
  ["cursor", "--seam"],          // #playhead も var(--seam)
  ["selection", "--accent"],
  ["rulerBg", "--content-bg-2"],
  ["rulerText", "--secondary-label"],
  ["loadingText", "--secondary-label"],
];

// 対応する CSS 変数を持たないキー（canvas 専用）。CSS 側に同名の概念は無い。
const CANVAS_ONLY = [
  "A.peak",   // --spk-a より意図的に1段明るい（clip→peak→text の3層分離）
  "B.peak",
  "previewGap",
  "previewGapBase",
  "previewOverlap",
  "previewOverlapBase",
  "flash",
  "rulerLine",  // --separator-strong の実色版（α を潰しているので近似）
  "hairline",   // --separator の実色版
];

function pick(theme, dotted) {
  return dotted.split(".").reduce((acc, k) => acc?.[k], THEME_COLORS[theme]);
}

for (const theme of ["light", "dark"]) {
  test(`パレット一致: waveform.js THEME_COLORS.${theme} と styles.css の変数が同値`, () => {
    for (const [key, cssVar] of EXACT_MATCH) {
      const js = pick(theme, key);
      assert.ok(js !== undefined, `THEME_COLORS.${theme}.${key} が存在しない`);
      const cssValue = css[theme][cssVar];
      assert.ok(cssValue !== undefined, `styles.css (${theme}) に ${cssVar} が無い`);
      assert.equal(
        normalizeColor(js),
        cssValue,
        `${theme}: THEME_COLORS.${key} (${js}) と ${cssVar} (${cssValue}) がズレている。` +
          " 色は2箇所にあるので片方だけ直さないこと（このファイルの EXACT_MATCH が対応表）",
      );
    }
  });
}

test("パレット一致: --seam と --alert-soft / --seam-soft の関係（意味は別・値は現状同じ）", () => {
  // --alert（危険）と --seam（継ぎ目）は意味が違うので変数を分けているが、
  // 現状は同値。片方だけ調整したくなったらこのテストを外して意図を記録すること。
  for (const theme of ["light", "dark"]) {
    assert.equal(css[theme]["--seam"], css[theme]["--alert"], `${theme}: --seam と --alert`);
    assert.equal(
      css[theme]["--seam-soft"],
      css[theme]["--alert-soft"],
      `${theme}: --seam-soft と --alert-soft`,
    );
  }
});

test("パレット一致: --voice-*-edge は --spk-* と同値（用途を名前で固定しただけ）", () => {
  for (const theme of ["light", "dark"]) {
    assert.equal(css[theme]["--voice-a-edge"], css[theme]["--spk-a"], `${theme}: voice-a-edge`);
    assert.equal(css[theme]["--voice-b-edge"], css[theme]["--spk-b"], `${theme}: voice-b-edge`);
  }
});

test("パレット一致: ダークの --on-accent が上書きされている（primary の文字が飛ばない）", () => {
  // ダークの --accent は明色（Ink=#e8e6e1）なので、--on-accent が白のままだと
  // primary ボタンの文字が読めなくなる。ダークブロックでの上書きは必須。
  assert.equal(css.light["--on-accent"], "#ffffff");
  assert.notEqual(
    css.dark["--on-accent"],
    css.light["--on-accent"],
    "ダークで --on-accent が上書きされていない（primary ボタンの文字が白飛びする）",
  );
  assert.equal(css.dark["--on-accent"], "#14161a");
});

test("パレット一致: 対応表の網羅性（THEME_COLORS のキーに漏れが無い）", () => {
  // 新しい色を足したのに対応表へ登録し忘れる、を防ぐ。
  const covered = new Set([...EXACT_MATCH.map(([k]) => k), ...CANVAS_ONLY]);
  const actual = [];
  for (const [key, value] of Object.entries(THEME_COLORS.light)) {
    if (value && typeof value === "object") {
      for (const sub of Object.keys(value)) actual.push(`${key}.${sub}`);
    } else {
      actual.push(key);
    }
  }
  const missing = actual.filter((k) => !covered.has(k));
  assert.deepEqual(
    missing,
    [],
    `THEME_COLORS に対応表未登録のキーがある: ${missing.join(", ")}。` +
      " EXACT_MATCH（CSS変数と一致）か CANVAS_ONLY（canvas専用）に分類すること",
  );

  // light と dark のキー集合が一致していること（片テーマだけ足す事故を防ぐ）
  assert.deepEqual(
    Object.keys(THEME_COLORS.dark).sort(),
    Object.keys(THEME_COLORS.light).sort(),
  );
});

test("パレット一致: styles.css にハードコードされた青が残っていない（#59 の目的）", () => {
  // --accent を Ink にしても、リテラルの青（旧 .app-mark の #4da2ff 等）は残る。
  // 「Ink の隣に青いタイルが1枚」という一番みっともない結果を機械的に防ぐ。
  return readFile(cssPath, "utf8").then((raw) => {
    // コメントは除外して宣言だけを見る（旧値を由来として書き残すのは許す）
    const declarations = raw.toLowerCase().replace(/\/\*[\s\S]*?\*\//g, "");
    const stale = ["#4da2ff", "#007aff", "#0a84ff", "#0071e8", "#2492ff"];
    for (const hex of stale) {
      assert.ok(
        !declarations.includes(hex),
        `styles.css に旧アクセントの青 ${hex} が残っている`,
      );
    }
  });
});

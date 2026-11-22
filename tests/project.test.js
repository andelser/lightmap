import assert from "node:assert/strict";
import {access, readFile} from "node:fs/promises";
import {test} from "node:test";

test("Firebase Hosting publishes only the public directory", async () => {
  const firebase = JSON.parse(await readFile("firebase.json", "utf8"));

  assert.equal(firebase.hosting.public, "public");
  assert.equal(firebase.database.rules, "database.rules.json");
});

test("the public entry point references pinned external assets", async () => {
  const html = await readFile("public/index.html", "utf8");

  assert.match(html, /d3@7\.9\.2/);
  assert.match(html, /topojson-client@3\.1\.0/);
  assert.doesNotMatch(html, /user-scalable=no/);
});

test("every local asset the page references is actually published", async () => {
  const html = await readFile("public/index.html", "utf8");
  const referenced = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => !/^(?:[a-z]+:)?\/\//i.test(value) && !/^(?:data:|#|mailto:)/i.test(value));

  assert.ok(referenced.length > 0, "expected the page to reference local assets");
  for (const asset of referenced) {
    // Hosting serves public/ only, so a root-level copy does not count.
    await assert.doesNotReject(
      access(`public/${asset}`),
      `public/${asset} is referenced by index.html but is not in public/`,
    );
  }
});

test("the loading splash clears even if the app module never runs", async () => {
  const theme = await readFile("public/theme.js", "utf8");
  const html = await readFile("public/index.html", "utf8");

  // The splash covers the whole page, so a failure that stops main.js from
  // loading would hide a working site behind it. theme.js is a classic script
  // that runs first and independently, which is the only place a fallback
  // still fires; the CSP rules out an inline script.
  assert.match(theme, /initialLoading[\s\S]*initial-loading--hidden/);
  assert.match(theme, /setTimeout\(/);
  assert.match(html, /<script src="theme\.js"><\/script>/);

  // Any modal raised during startup must not be trapped under the splash.
  const main = await readFile("public/main.js", "utf8");
  const showModal = main.slice(main.indexOf("function showModal"));
  assert.match(showModal.slice(0, 400), /hideAppLoading\(\)/);
});

test("the map re-renders on resize", async () => {
  const main = await readFile("public/main.js", "utf8");

  // The projection is sized from window.innerWidth/innerHeight, so without
  // this listener the map stays at its first-paint size after a rotate.
  assert.match(
    main,
    /window\.addEventListener\("resize", debounce\(setupAndRenderMap, CONFIG\.RESIZE_DEBOUNCE\)\)/,
  );
});

test("the header controls share one size and vertical inset", async () => {
  const css = await readFile("public/style.css", "utf8");
  const sharedRule = css.match(/\.hamburger,\s*#toggleTheme\s*\{([^}]*)\}/)?.[1];

  assert.ok(sharedRule, "expected a shared hamburger/theme-toggle rule");
  assert.match(sharedRule, /top:\s*max\(10px, env\(safe-area-inset-top\)\)/);
  assert.match(sharedRule, /width:\s*40px/);
  assert.match(sharedRule, /height:\s*40px/);
});

test("the config template includes the optional App Check hook", async () => {
  const template = await readFile("public/config.template.js", "utf8");

  assert.match(template, /export const appCheckSiteKey/);
});

test("counted client writes use one stable, correlated message ID", async () => {
  const main = await readFile("public/main.js", "utf8");
  const start = main.indexOf("async function sendCountedMessage");
  const end = main.indexOf("// --- D3 Map Setup ---", start);
  const sendCountedMessage = main.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(main, /function buildCounterWrite\(messageId, messagePath\)/);
  assert.equal(
    [...sendCountedMessage.matchAll(/push\(ref\(db, path\)\)/g)].length,
    1,
    "a retry must not allocate another message ID",
  );
  assert.match(sendCountedMessage, /buildCounterWrite\(messageId, path\)/);
  assert.match(sendCountedMessage, /error\?\.code !== 'PERMISSION_DENIED'/);
});

test("the CSP permits every external origin the client contacts", async () => {
  const firebase = JSON.parse(await readFile("firebase.json", "utf8"));
  const csp = firebase.hosting.headers[0].headers
    .find((header) => header.key === "Content-Security-Policy").value;
  const directives = csp.split(";").map((directive) => directive.trim());
  const connectSrc = directives.find((directive) => directive.startsWith("connect-src"));
  const scriptSrc = directives.find((directive) => directive.startsWith("script-src"));
  const frameSrc = directives.find((directive) => directive.startsWith("frame-src"));

  // The world atlas is fetched (not script-loaded) from jsDelivr, so it needs
  // connect-src as well; a miss here blanks the whole map. Realtime Database
  // falls back to script-and-iframe long polling when WebSockets are
  // unavailable, which is common enough on mobile networks that both paths
  // must be allowed alongside the Firebase Auth helper iframe.
  assert.match(connectSrc, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(connectSrc, /wss:\/\/\*\.firebaseio\.com/);
  assert.match(connectSrc, /https:\/\/\*\.googleapis\.com/);
  assert.match(scriptSrc, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(scriptSrc, /https:\/\/www\.gstatic\.com/);
  assert.match(scriptSrc, /https:\/\/apis\.google\.com/);
  assert.match(scriptSrc, /https:\/\/\*\.firebaseio\.com/);
  assert.match(scriptSrc, /https:\/\/\*\.firebasedatabase\.app/);
  assert.match(frameSrc, /https:\/\/lightmap-8f19d\.firebaseapp\.com/);
  assert.match(frameSrc, /https:\/\/\*\.firebaseio\.com/);
  assert.match(frameSrc, /https:\/\/\*\.firebasedatabase\.app/);
});

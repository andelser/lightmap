import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {test} from "node:test";
import vm from "node:vm";

process.env.TZ = "America/New_York";

const source = (await readFile("public/main.js", "utf8"))
  .replace(/^import .*;\r?\n/gm, "");
const COUNTS_KEY = "ephemeralButtonCounts";
const PRESSED_KEY = "ephemeralhereForYouPressed";

function createApp({stored = {}, now = "2026-10-13T12:00:00", failWrites = false} = {}) {
  let time = new Date(now).getTime();
  const timers = [];
  const writes = [];
  const locations = [];
  const values = new Map(Object.entries(stored).map(([key, value]) => [key, JSON.stringify(value)]));
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };

  function element(text = "") {
    const listeners = new Map();
    const classes = new Set();
    const buttonText = {textContent: text};
    return {
      disabled: true,
      hidden: false,
      textContent: text,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle(name, force = !classes.has(name)) {
          if (force) classes.add(name);
          else classes.delete(name);
          return force;
        },
      },
      addEventListener(name, callback) {
        const callbacks = listeners.get(name) ?? [];
        callbacks.push(callback);
        listeners.set(name, callbacks);
      },
      emit(name, event = {}) {
        for (const callback of listeners.get(name) ?? []) callback({currentTarget: this, ...event});
      },
      querySelector: () => buttonText,
      setAttribute() {},
      getAttribute: () => null,
      focus() {},
      blur() {},
      contains: () => false,
    };
  }

  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const mainButtons = Array.from({length: 4}, (_, index) => getElement(`msg-${index}`));
  const hereButton = getElement("hereForYouButton");
  const hereContainer = getElement("hereForYouContainer");
  hereContainer.classList.add("hidden");
  const document = Object.assign(element(), {
    documentElement: element(),
    getElementById: getElement,
    querySelector: getElement,
    querySelectorAll: (selector) => selector === ".button-group button"
      ? mainButtons : [...mainButtons, hereButton],
  });
  const window = Object.assign(element(), {requestAnimationFrame() {}});
  const selection = {};
  for (const name of ["append", "attr", "style", "selectAll", "data", "join", "each", "remove", "datum"]) {
    selection[name] = () => selection;
  }
  selection.empty = () => true;
  const projection = () => [0, 0];
  projection.fitSize = () => projection;
  let authenticate;
  let resolveMap;
  const mapPromise = new Promise((resolve) => { resolveMap = resolve; });
  const sandbox = {
    document, window, localStorage,
    navigator: {geolocation: {getCurrentPosition(success, failure) { locations.push({success, failure}); }}},
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [time])); }
      static now() { return time; }
    },
    setTimeout(callback, delay) { const timer = {callback, at: time + delay}; timers.push(timer); return timer; },
    clearTimeout(timer) { const index = timers.indexOf(timer); if (index !== -1) timers.splice(index, 1); },
    console: {error() {}},
    getComputedStyle: () => ({getPropertyValue: () => ""}),
    clientConfig: {firebaseConfig: {}},
    initializeApp() {}, getDatabase() {}, getAuth() {},
    ref: (_, path) => path,
    onValue() {}, onChildAdded() {},
    onAuthStateChanged(_, callback) { authenticate = callback; },
    signInAnonymously: () => Promise.resolve(),
    push: () => ({key: `message-${writes.length}`}),
    serverTimestamp: () => time,
    increment: (count) => count,
    async update(_, data) {
      if (typeof failWrites === "function" ? failWrites(data) : failWrites) throw new Error("Write failed");
      writes.push(data);
    },
    query() {}, orderByChild() {}, startAt() {}, limitToLast() {},
    encodeGeohash: () => "dr5r",
    d3: {
      select: () => selection,
      geoNaturalEarth1: () => projection,
      geoPath: () => ({projection() { return this; }}),
      json: () => mapPromise,
    },
    topojson: {feature: () => ({features: []})},
  };
  vm.runInNewContext(source, sandbox);
  document.emit("DOMContentLoaded");
  authenticate({uid: "test-user"});

  async function flush() { await new Promise((resolve) => setImmediate(resolve)); }
  async function advance(ms, {runTimers = true} = {}) {
    await flush();
    const target = time + ms;
    if (runTimers) {
      while (true) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > target) break;
        const timer = timers.shift();
        time = timer.at;
        timer.callback();
        await flush();
      }
    }
    time = target;
  }
  async function click(button) {
    const before = locations.length;
    button.emit("click");
    if (locations.length > before) {
      locations.at(-1).success({coords: {latitude: 40.7, longitude: -74}});
    }
    await flush();
    await advance(2100);
  }

  return {
    mainButtons, hereButton, document, window, writes, locations, click, advance,
    writeStored: (key, value) => localStorage.setItem(key, JSON.stringify(value)),
    visible: () => !hereContainer.classList.contains("hidden"),
    stored: () => Object.fromEntries([...values]
      .filter(([key]) => key !== "theme")
      .map(([key, value]) => [key, JSON.parse(value)])),
    loadMap: async () => { resolveMap({objects: {countries: {}}}); await flush(); },
  };
}

test("undated legacy counts cannot unlock Here for you on a later visit", async () => {
  const app = createApp({stored: {[COUNTS_KEY]: [1, 1, 1, 1]}});
  assert.equal(app.visible(), false, "auth must not reveal an old unlock while the map is loading");
  await app.loadMap();
  assert.equal(app.visible(), false);
  assert.equal(app.hereButton.disabled, true);
});

test("legacy partial progress cannot combine with today's messages", async () => {
  const app = createApp({stored: {[COUNTS_KEY]: [1, 1, 1, 0]}});
  await app.click(app.mainButtons[3]);
  assert.equal(app.visible(), false);
});

test("all four distinct messages unlock it, and same-day reload preserves the unlock", async () => {
  const app = createApp();
  for (let index = 0; index < 4; index++) {
    await app.click(app.mainButtons[index]);
    assert.equal(app.visible(), index === 3);
  }
  assert.equal(app.hereButton.disabled, false);
  const reloaded = createApp({stored: app.stored()});
  assert.equal(reloaded.visible(), true);
  assert.equal(reloaded.hereButton.disabled, false);
});

test("repeated presses of one message do not unlock it", async () => {
  const app = createApp();
  for (let index = 0; index < 4; index++) await app.click(app.mainButtons[0]);
  assert.equal(app.visible(), false);
});

test("next-day visits reset full and partial progress without a Here for you press", async () => {
  for (const count of [3, 4]) {
    const yesterday = createApp({now: "2026-10-12T12:00:00"});
    for (let index = 0; index < count; index++) await yesterday.click(yesterday.mainButtons[index]);
    const today = createApp({stored: yesterday.stored()});
    assert.equal(today.visible(), false);
    await today.click(today.mainButtons[3]);
    assert.equal(today.visible(), false);
  }
});

test("Here for you remains consumed through reload and can be earned again tomorrow", async () => {
  const app = createApp();
  for (const button of app.mainButtons) await app.click(button);
  await app.click(app.hereButton);
  assert.equal(app.visible(), false);
  assert.equal(app.hereButton.disabled, true);
  const reloaded = createApp({stored: app.stored()});
  assert.equal(reloaded.visible(), false);
  const tomorrow = createApp({stored: app.stored(), now: "2026-10-14T12:00:00"});
  assert.equal(tomorrow.visible(), false);
  for (const button of tomorrow.mainButtons) await tomorrow.click(button);
  assert.equal(tomorrow.visible(), true);
});

test("a same-day legacy Here for you press stays consumed after migration", async () => {
  const app = createApp({stored: {
    [COUNTS_KEY]: [1, 1, 1, 1],
    [PRESSED_KEY]: {timestamp: new Date("2026-10-13T09:00:00").getTime()},
  }});
  for (const button of app.mainButtons) await app.click(button);
  assert.equal(app.visible(), false);
});

test("an open page resets at local midnight rather than UTC midnight", async () => {
  const app = createApp({now: "2026-10-13T19:59:00"});
  for (const button of app.mainButtons) await app.click(button);
  await app.advance(60_000);
  assert.equal(app.visible(), true, "00:00 UTC is still the same local day");
  await app.advance(4 * 60 * 60 * 1000);
  assert.equal(app.visible(), false);
  assert.equal(app.hereButton.disabled, true);
});

test("returning to a suspended page resets stale progress before another click", async () => {
  for (const event of ["focus", "pageshow", "visibilitychange"]) {
    const app = createApp();
    for (const button of app.mainButtons) await app.click(button);
    await app.advance(24 * 60 * 60 * 1000, {runTimers: false});
    if (event === "visibilitychange") app.document.emit(event);
    else app.window.emit(event);
    assert.equal(app.visible(), false, event);
    assert.equal(app.hereButton.disabled, true, event);
  }
});

test("a stale or locked Here for you click cannot send a message", async () => {
  const app = createApp();
  await app.click(app.hereButton);
  assert.equal(app.locations.length, 0);
  for (const button of app.mainButtons) await app.click(button);
  await app.advance(24 * 60 * 60 * 1000, {runTimers: false});
  await app.click(app.hereButton);
  assert.equal(app.writes.length, 4);
  assert.equal(app.visible(), false);
});

test("failed main message writes do not contribute toward the unlock", async () => {
  const app = createApp({failWrites: true});
  for (const button of app.mainButtons) await app.click(button);
  assert.equal(app.visible(), false);
  assert.equal(app.writes.length, 0);
});

test("malformed stored progress does not crash or unlock the button", async () => {
  const day = new Date("2026-10-13T00:00:00").getTime();
  for (const counts of [null, "bad", [1, 1, 1], [1, 1, 1, "1"],
    {day, counts: [1, 1, 1, "1"]}, {day, counts: [-1, 1, 1, 1]}]) {
    const app = createApp({stored: {[COUNTS_KEY]: counts}});
    for (let index = 0; index < 3; index++) await app.click(app.mainButtons[index]);
    assert.equal(app.visible(), false);
    await app.click(app.mainButtons[3]);
    assert.equal(app.visible(), true);
  }
});

test("local midnight resets follow both 23-hour and 25-hour daylight saving days", async () => {
  const spring = createApp({now: "2026-03-08T00:01:00"});
  for (const button of spring.mainButtons) await spring.click(button);
  await spring.advance(23 * 60 * 60 * 1000);
  assert.equal(spring.visible(), false);

  const fall = createApp({now: "2026-11-01T00:01:00"});
  for (const button of fall.mainButtons) await fall.click(button);
  await fall.advance(24 * 60 * 60 * 1000);
  assert.equal(fall.visible(), true);
  await fall.advance(60 * 60 * 1000);
  assert.equal(fall.visible(), false);
});

test("another tab's Here for you press immediately hides and disables the button", async () => {
  const app = createApp();
  for (const button of app.mainButtons) await app.click(button);
  app.writeStored(PRESSED_KEY, {timestamp: new Date("2026-10-13T12:00:00").getTime()});
  app.window.emit("storage", {key: PRESSED_KEY});
  assert.equal(app.visible(), false);
  assert.equal(app.hereButton.disabled, true);
});

test("eligibility is rechecked if geolocation completes on a new day", async () => {
  const app = createApp();
  for (const button of app.mainButtons) await app.click(button);
  app.hereButton.emit("click");
  await app.advance(24 * 60 * 60 * 1000, {runTimers: false});
  app.locations.at(-1).success({coords: {latitude: 40.7, longitude: -74}});
  await app.advance(1);
  assert.equal(app.writes.length, 4);
  assert.equal(app.visible(), false);
  assert.equal(app.hereButton.disabled, true);
});

test("UI refreshes cannot enable or resend an in-flight Here for you message", async () => {
  const app = createApp();
  for (const button of app.mainButtons) await app.click(button);
  app.hereButton.emit("click");
  app.window.emit("focus");
  assert.equal(app.hereButton.disabled, true);
  app.hereButton.emit("click");
  assert.equal(app.locations.length, 5);
  app.locations.at(-1).success({coords: {latitude: 40.7, longitude: -74}});
  await app.advance(2100);
  assert.equal(app.writes.length, 5);
  assert.equal(app.visible(), false);
});

test("failed Here for you writes keep the current day's unlock available for retry", async () => {
  const app = createApp({failWrites: (data) => data["stats/daily"].messagePath === "permanent_messages"});
  for (const button of app.mainButtons) await app.click(button);
  await app.click(app.hereButton);
  assert.equal(app.visible(), true);
  assert.equal(app.hereButton.disabled, false);
  assert.equal(app.writes.length, 4);
  assert.equal(app.stored()[PRESSED_KEY], undefined);
});

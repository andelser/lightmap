import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app-check.js";
import { getDatabase, ref, push, onChildAdded, query, orderByChild, limitToLast, serverTimestamp, onValue, startAt, update, get, increment } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

import * as clientConfig from "./config.js";
import { decodeGeohash, encodeGeohash } from "./geohash.js";

const { firebaseConfig, appCheckSiteKey } = clientConfig;

// --- Wrap all logic in a DOMContentLoaded listener ---
document.addEventListener('DOMContentLoaded', () => {

  const modal = document.getElementById('modal');
  const modalClose = document.getElementById('modalClose');
  const buttonsContainer = document.querySelector('.buttons');
  const capNotice = document.getElementById('capNotice');
  const toggleThemeButton = document.getElementById('toggleTheme');
  const hamburger = document.getElementById('hamburgerMenu');
  const menuDropdown = document.getElementById('menuDropdown');
  const aboutMenu = document.getElementById('aboutMenu');
  const status = document.getElementById('status');
  let elementBeforeModal = null;

  // --- Initial loading splash ---
  // The splash covers the UI until sign-in and the map data have both settled,
  // because the buttons stay disabled until then. Every failure path also
  // uncovers the page, and theme.js holds a last-resort timer for the case
  // where this module never runs at all.
  const initialLoading = document.getElementById('initialLoading');
  let authReady = false;
  let mapLoaded = false;

  function hideAppLoading() {
    initialLoading?.classList.add('initial-loading--hidden');
  }

  function updateAppReady() {
    if (authReady && mapLoaded) {
      hideAppLoading();
    }
  }

  // --- Configuration Constants ---
  const CONFIG = {
    DOT_LIFESPAN: 10000,
    FADE_IN_DURATION: 2000,
    FADE_OUT_DURATION: 5000,
    MESSAGE_COOLDOWN: 1000, // Universal cooldown for all messages
    GEOLOCATION_TIMEOUT: 10000,
    RESIZE_DEBOUNCE: 150,
    UNLOCK_COUNT: 1, // How many clicks per button to unlock
    PERMANENT_DOT_WINDOW_MS: 24 * 60 * 60 * 1000, // 24 hours
    PERMANENT_DOT_MAX: 2000, // Bounds what one visitor downloads, whatever the day held
    DAILY_GLOBAL_CAP: 25000, // Must match the stats/daily count limit in database.rules.json
  };

  // --- Local Storage Keys ---
  const KEYS = {
    BUTTON_COUNTS: 'ephemeralButtonCounts',
    HERE_FOR_YOU_PRESSED: 'ephemeralhereForYouPressed',
  };

  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  function readStoredJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value ?? fallback;
    } catch {
      localStorage.removeItem(key);
      return fallback;
    }
  }

  // --- App Initialization ---
  if (!firebaseConfig) {
    showModal('Error', 'Firebase configuration is missing or invalid in config.js.');
    throw new Error("Firebase config not found.");
  }

  const app = initializeApp(firebaseConfig);
  if (appCheckSiteKey) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
  const db = getDatabase(app);
  const auth = getAuth(app);
  let currentUser = null; // To hold the authenticated user

  let serverTimeOffset = 0;
  onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
    serverTimeOffset = snap.val() || 0;
  });

  // --- Global Daily Write Cap ---
  // Mirrors the counter that database.rules.json enforces at stats/daily.
  // Every press writes its message and a counter increment in one atomic
  // update; once the counter reaches DAILY_GLOBAL_CAP the rules reject new
  // messages until the next UTC day. The map stays readable throughout.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const statsRef = ref(db, 'stats/daily');
  let latestDailyStats = null;
  let capWasReached = false;

  function serverNow() {
    return Date.now() + serverTimeOffset;
  }

  function utcDayStart(ms) {
    return ms - (ms % DAY_MS);
  }

  function isCapReached() {
    return latestDailyStats !== null
      && latestDailyStats.day === utcDayStart(serverNow())
      && latestDailyStats.count >= CONFIG.DAILY_GLOBAL_CAP;
  }

  function updateCapUi() {
    const capped = isCapReached();
    buttonsContainer.hidden = capped;
    capNotice.hidden = !capped;
    if (capped && !capWasReached) {
      announceStatus(capNotice.textContent);
    }
    capWasReached = capped;
  }

  function scheduleCapRefreshAtUtcMidnight() {
    const msUntilNextUtcDay = utcDayStart(serverNow()) + DAY_MS - serverNow();
    setTimeout(() => {
      updateCapUi();
      scheduleCapRefreshAtUtcMidnight();
    }, msUntilNextUtcDay + 1000);
  }

  function showCapModal() {
    showModal('Resting', "Today's messages have all been shared. The map will accept new ones after midnight UTC.");
  }

  function buildCounterWrite(messageId, messagePath) {
    const todayMs = utcDayStart(serverNow());
    if (latestDailyStats && latestDailyStats.day === todayMs) {
      return { day: todayMs, count: increment(1), messageId, messagePath };
    }
    return { day: todayMs, count: 1, messageId, messagePath };
  }

  // Writes the message and the counter in a single atomic multi-path update,
  // so a press is still one network round trip. The message key is allocated
  // once so a retry cannot create a duplicate. A permission denial is retried
  // only when a fresh read shows that our cached counter was stale.
  async function sendCountedMessage(path, messageData) {
    const messageId = push(ref(db, path)).key;
    const attemptedDay = latestDailyStats?.day;
    const attemptedCount = latestDailyStats?.count;
    const write = () => update(ref(db), {
      [`${path}/${messageId}`]: messageData,
      'stats/daily': buildCounterWrite(messageId, path),
    });

    try {
      await write();
    } catch (error) {
      if (error?.code !== 'PERMISSION_DENIED') {
        throw error;
      }

      const refreshedStats = (await get(statsRef)).val();
      latestDailyStats = refreshedStats;
      updateCapUi();

      // If the server committed the first attempt but its acknowledgement was
      // lost, the correlation fields make that success detectable.
      if (refreshedStats?.messageId === messageId && refreshedStats?.messagePath === path) {
        return;
      }
      if (isCapReached()) {
        const capError = new Error('The daily message cap has been reached.');
        capError.code = 'daily-cap';
        throw capError;
      }
      if (refreshedStats?.day === attemptedDay && refreshedStats?.count === attemptedCount) {
        throw error;
      }
      await write();
    }
  }

  // --- D3 Map Setup ---
  const svg = d3.select("#map");
  const mapLayer = svg.append("g").attr("id", "map-layer");
  const permanentDotLayer = svg.append("g").attr("id", "permanent-dot-layer");
  const dotLayer = svg.append("g").attr("id", "dot-layer");
  const projection = d3.geoNaturalEarth1();
  const path = d3.geoPath().projection(projection);
  let worldData;
  let activeDots = [];
  let animationFrameId = null;

  // --- Map Rendering ---
  function setupAndRenderMap() {
    if (!worldData) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    svg.attr("width", width).attr("height", height);
    projection.fitSize([width, height], worldData);
    path.projection(projection);

    mapLayer.style("background-color", getComputedStyle(document.documentElement).getPropertyValue('--sea'));
    mapLayer.selectAll("path").data(worldData.features)
      .join("path")
      .attr("fill", getComputedStyle(document.documentElement).getPropertyValue('--land'))
      .attr("stroke", getComputedStyle(document.documentElement).getPropertyValue('--border'))
      .attr("d", path);
    
    activeDots.forEach(dot => {
      const [x, y] = projection([dot.lng, dot.lat]);
      d3.select(`#dot-${dot.id}`).attr("cx", x).attr("cy", y);
    });
    permanentDotLayer.selectAll("circle").each(function(d) {
        const [x, y] = projection([d.lng, d.lat]);
        d3.select(this).attr("cx", x).attr("cy", y);
    });
  }

  // --- Core Application Logic ---
  const colors = ["#AA4499", "#EEAA77", "#44AA99", "#332288"];
  let lastMessageTime = 0;
  let messagePending = false;

  function sendMessage(colorIndex, button) {
    checkIfUnlocked();
    if (!currentUser) {
        showModal('Error', 'Not connected. Please wait a moment and try again.');
        return;
    }

    if (isCapReached()) {
      updateCapUi();
      showCapModal();
      return;
    }

    // Simplified cooldown logic
    if (Date.now() - lastMessageTime < CONFIG.MESSAGE_COOLDOWN) {
      const timeLeft = Math.ceil((CONFIG.MESSAGE_COOLDOWN - (Date.now() - lastMessageTime)) / 1000);
      const unit = timeLeft === 1 ? "second" : "seconds";
      showModal('Cooldown', `Please wait ${timeLeft > 0 ? timeLeft : 1} ${unit}.`);
      return;
    }

    if (!navigator.geolocation) {
      showModal('Error', "Geolocation is not supported by your browser.");
      return;
    }
    const buttons = document.querySelectorAll('.buttons button');
    messagePending = true;
    buttons.forEach(btn => btn.disabled = true);
    
    const buttonText = button.querySelector('.button-text');
    const originalButtonText = buttonText.textContent;
    button.classList.add('loading');

    navigator.geolocation.getCurrentPosition(position => {
      const { latitude, longitude } = position.coords;
      const hash = encodeGeohash(latitude, longitude);
      
      const messageData = {
        geohash: hash,
        color: colors[colorIndex],
        timestamp: serverTimestamp(),
      };

      sendCountedMessage('messages', messageData)
        .then(() => {
            lastMessageTime = Date.now();
            button.classList.remove('loading');
            buttonText.textContent = "Displayed!";
            announceStatus(`${originalButtonText} displayed on the map.`);
            incrementButtonClick(colorIndex);
            setTimeout(() => {
              buttonText.textContent = originalButtonText;
              messagePending = false;
              buttons.forEach(btn => btn.disabled = !currentUser);
              checkIfUnlocked();
              button.blur();
            }, 2000);
        })
        .catch(error => {
            if (error && error.code === 'daily-cap') {
              showCapModal();
            } else {
              showFirebaseError(error, "writing ephemeral message");
            }
            button.classList.remove('loading');
            buttonText.textContent = originalButtonText;
            messagePending = false;
            buttons.forEach(btn => btn.disabled = !currentUser);
            checkIfUnlocked();
        });
    }, error => {
      handleGeolocationError(error);
      button.classList.remove('loading');
      buttonText.textContent = originalButtonText;
      messagePending = false;
      buttons.forEach(btn => btn.disabled = !currentUser);
      checkIfUnlocked();
    }, { enableHighAccuracy: false, timeout: CONFIG.GEOLOCATION_TIMEOUT, maximumAge: 300000 });
  }

  // --- Animation Render Loop for temporary dots ---
  function renderLoop() {
    const now = Date.now() + serverTimeOffset;
    const dotsToRemove = [];

    activeDots.forEach(dot => {
      const age = now - dot.timestamp; 
      const localAnimationAge = now - dot.localAnimationStartTime;

      const dotElement = d3.select(`#dot-${dot.id}`);
      if (age > CONFIG.DOT_LIFESPAN) {
        dotsToRemove.push(dot.id);
        dotElement.remove();
        return;
      }

      let opacity = 0.95;
      let radius = 4;

      if (localAnimationAge < CONFIG.FADE_IN_DURATION) {
        opacity = d3.easeCubicOut(localAnimationAge / CONFIG.FADE_IN_DURATION) * 0.95;
        radius = d3.easeCubicOut(localAnimationAge / CONFIG.FADE_IN_DURATION) * 4;
      }

      const fadeOutStartTime = CONFIG.DOT_LIFESPAN - CONFIG.FADE_OUT_DURATION;
      if (age > fadeOutStartTime) {
        const fadeOutProgress = (age - fadeOutStartTime) / CONFIG.FADE_OUT_DURATION;
        opacity = (1 - d3.easeCubicIn(fadeOutProgress)) * 0.95;
        radius = (1 - d3.easeCubicIn(fadeOutProgress)) * 4;
      }

      dotElement.attr("r", radius).attr("fill-opacity", opacity);
    });

    if (dotsToRemove.length > 0) {
      activeDots = activeDots.filter(d => !dotsToRemove.includes(d.id));
    }

    if (activeDots.length > 0) {
      animationFrameId = requestAnimationFrame(renderLoop);
    } else {
      animationFrameId = null;
    }
  }

  function startRenderLoop() {
    if (animationFrameId === null) {
      animationFrameId = requestAnimationFrame(renderLoop);
    }
  }

  function addNewDot(snapshot) {
    const { geohash: hash, color, timestamp, type } = snapshot.val();
    if (type === 'permanent') return;

    const id = snapshot.key;
    if (!hash || !color || !timestamp || !id || typeof timestamp !== 'number') {
      return;
    }
    if (Date.now() + serverTimeOffset - timestamp > CONFIG.DOT_LIFESPAN + 1000) {
      return;
    }
    if (activeDots.some(d => d.id === id)) {
      return;
    }
    const coords = decodeGeohash(hash);
    if (!coords) {
      return;
    }
    const [x, y] = projection([coords.lng, coords.lat]);
    if (isNaN(x) || isNaN(y)) {
      return;
    }
    const newDot = {
      id,
      lat: coords.lat,
      lng: coords.lng,
      timestamp,
      localAnimationStartTime: Date.now() + serverTimeOffset
    };
    activeDots.push(newDot);
    dotLayer.append("circle")
      .attr("id", `dot-${id}`)
      .attr("cx", x)
      .attr("cy", y)
      .attr("fill", color)
      .attr("r", 0)
      .attr("fill-opacity", 0);
    startRenderLoop();
  }

  // --- "Here For You" Feature Logic ---
  const hereForYouContainer = document.getElementById('hereForYouContainer');
  const hereForYouButton = document.getElementById('hereForYouButton');
  let hereForYouPending = false;

  function getStartOfTodayLocal() {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now.getTime();
  }

  function checkAndResetDailyData() {
    const todayLocalStart = getStartOfTodayLocal();
    let progress = readStoredJson(KEYS.BUTTON_COUNTS, null);
    // Legacy arrays have no date, so none of their presses can be attributed
    // to today. Reset them, as well as expired or malformed dated progress.
    if (progress?.day !== todayLocalStart || !Array.isArray(progress.counts) ||
        progress.counts.length !== colors.length ||
        !progress.counts.every(count => Number.isSafeInteger(count) && count >= 0)) {
      progress = { day: todayLocalStart, counts: colors.map(() => 0) };
      localStorage.setItem(KEYS.BUTTON_COUNTS, JSON.stringify(progress));
    }

    const lastPressedData = readStoredJson(KEYS.HERE_FOR_YOU_PRESSED, null);
    const tomorrowLocal = new Date(todayLocalStart);
    tomorrowLocal.setDate(tomorrowLocal.getDate() + 1);
    if (lastPressedData && (!Number.isFinite(lastPressedData.timestamp) ||
        lastPressedData.timestamp < todayLocalStart ||
        lastPressedData.timestamp >= tomorrowLocal.getTime())) {
      localStorage.removeItem(KEYS.HERE_FOR_YOU_PRESSED);
    }
    return progress;
  }
  
  function incrementButtonClick(index) {
    const progress = checkAndResetDailyData();
    progress.counts[index]++;
    localStorage.setItem(KEYS.BUTTON_COUNTS, JSON.stringify(progress));
    checkIfUnlocked();
  }

  function checkIfUnlocked() {
    const { counts } = checkAndResetDailyData();
    const lastPressedData = readStoredJson(KEYS.HERE_FOR_YOU_PRESSED, null);
    const unlocked = !lastPressedData && counts.every(count => count >= CONFIG.UNLOCK_COUNT);

    hereForYouContainer.classList.toggle('hidden', !unlocked);
    hereForYouButton.disabled = !unlocked || !currentUser || messagePending || hereForYouPending;
    return unlocked;
  }

  function scheduleDailyProgressReset() {
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 0);
    setTimeout(() => {
      checkIfUnlocked();
      scheduleDailyProgressReset();
    }, nextMidnight.getTime() - Date.now() + 50);
  }

  hereForYouButton.addEventListener('click', () => {
    if (!checkIfUnlocked() || messagePending || hereForYouPending) return;
    if (!currentUser) {
        showModal('Error', 'Not connected. Please wait a moment and try again.');
      return;
    }
    if (isCapReached()) {
      updateCapUi();
      showCapModal();
      return;
    }
    if (!navigator.geolocation) {
      showModal('Error', "Geolocation is not supported by your browser.");
      return;
    }
    
    hereForYouPending = true;
    hereForYouButton.disabled = true;
    const buttonText = hereForYouButton.querySelector('.button-text');
    const originalButtonText = buttonText.textContent;
    hereForYouButton.classList.add('loading');

    navigator.geolocation.getCurrentPosition(position => {
      // Geolocation can finish after midnight or after another tab consumes
      // today's unlock. Recheck before creating the map message.
      if (!checkIfUnlocked()) {
        hereForYouPending = false;
        hereForYouButton.classList.remove('loading');
        checkIfUnlocked();
        return;
      }
      const { latitude, longitude } = position.coords;
      const hash = encodeGeohash(latitude, longitude);
      
      const messageData = {
        geohash: hash,
        timestamp: serverTimestamp(),
        type: "permanent",
      };

      sendCountedMessage('permanent_messages', messageData)
        .then(() => {
            const pressData = { timestamp: new Date().getTime() };
            localStorage.setItem(KEYS.HERE_FOR_YOU_PRESSED, JSON.stringify(pressData));

            hereForYouButton.classList.remove('loading');
            buttonText.textContent = "Displayed!";
            announceStatus("Here for you displayed on the map.");

            setTimeout(() => {
              buttonText.textContent = originalButtonText;
              hereForYouPending = false;
              checkIfUnlocked();
            }, 2000);
        })
        .catch(error => {
            if (error && error.code === 'daily-cap') {
              showCapModal();
            } else {
              showFirebaseError(error, "writing permanent message");
            }
            hereForYouButton.classList.remove('loading');
            buttonText.textContent = originalButtonText;
            hereForYouPending = false;
            checkIfUnlocked();
        });
    }, error => {
      handleGeolocationError(error);
      hereForYouButton.classList.remove('loading');
      buttonText.textContent = originalButtonText;
      hereForYouPending = false;
      checkIfUnlocked();
    }, { enableHighAccuracy: false, timeout: CONFIG.GEOLOCATION_TIMEOUT, maximumAge: 300000 });
  });

  function listenForPermanentDots() {
    permanentDotLayer.selectAll("*").remove();
    const permanentMessagesRef = ref(db, 'permanent_messages');
    const cutoff = (Date.now() + serverTimeOffset) - CONFIG.PERMANENT_DOT_WINDOW_MS;
    
    const queryConstraints = [orderByChild('timestamp'), startAt(cutoff), limitToLast(CONFIG.PERMANENT_DOT_MAX)];
    onChildAdded(query(permanentMessagesRef, ...queryConstraints), (snapshot) => {
        if (!snapshot.exists()) return;
        
        const data = snapshot.val();
        if (!data || !data.geohash) return;

        const dotId = `permanent-${snapshot.key}`;
        if (d3.select(`#${dotId}`).empty()) {
            const coords = decodeGeohash(data.geohash);
            if (!coords) return;
            const [x, y] = projection([coords.lng, coords.lat]);
            if (!isNaN(x) && !isNaN(y)) {
                permanentDotLayer.append("circle")
                    .attr("id", dotId)
                    .datum({lng: coords.lng, lat: coords.lat})
                    .attr("class", "dot-permanent")
                    .attr("cx", x)
                    .attr("cy", y)
                    .attr("r", 1.5);
            }
        }
    });
  }

  // --- Realtime listeners ---
  // Reads require auth, so listeners are attached only after sign-in
  // completes; a listener attached earlier would be cancelled by the server
  // and never retried.
  let realtimeListenersStarted = false;
  function startRealtimeListeners() {
    if (realtimeListenersStarted) return;
    realtimeListenersStarted = true;

    onValue(statsRef, (snapshot) => {
      latestDailyStats = snapshot.val();
      updateCapUi();
    });

    // Only dots young enough to display are worth downloading; without the
    // startAt bound a new visitor would sync up to 300 already-expired
    // messages just to discard them.
    const liveCutoff = serverNow() - (CONFIG.DOT_LIFESPAN + 1000);
    const recentMessagesQuery = query(ref(db, 'messages'), orderByChild('timestamp'), startAt(liveCutoff), limitToLast(300));
    onChildAdded(recentMessagesQuery, addNewDot);

    listenForPermanentDots();
  }

  // --- Authentication ---
  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentUser = user;
      startRealtimeListeners();
      document.querySelectorAll('.button-group button').forEach(button => {
        button.disabled = false;
      });
      checkIfUnlocked();
      if (!authReady) {
        authReady = true;
        updateAppReady();
      }
    } else {
      currentUser = null;
      document.querySelectorAll('.buttons button').forEach(button => {
        button.disabled = true;
      });
    }
  });

  signInAnonymously(auth).catch((error) => {
    console.error("Anonymous sign-in failed:", error);
    showModal('Connection Error', 'Could not connect to the service. Please refresh the page.');
    authReady = true;
  });


  // --- Event Listeners and Initializers ---
  document.getElementById('msg-0').addEventListener('click', (event) => sendMessage(0, event.currentTarget));
  document.getElementById('msg-1').addEventListener('click', (event) => sendMessage(1, event.currentTarget));
  document.getElementById('msg-2').addEventListener('click', (event) => sendMessage(2, event.currentTarget));
  document.getElementById('msg-3').addEventListener('click', (event) => sendMessage(3, event.currentTarget));

  scheduleCapRefreshAtUtcMidnight();
  checkIfUnlocked();
  scheduleDailyProgressReset();

  window.addEventListener('focus', checkIfUnlocked);
  window.addEventListener('pageshow', checkIfUnlocked);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkIfUnlocked();
  });
  window.addEventListener('storage', (event) => {
    if (event.key === null || Object.values(KEYS).includes(event.key)) checkIfUnlocked();
  });

  d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json").then(geoData => {
    worldData = topojson.feature(geoData, geoData.objects.countries);
    setupAndRenderMap();
    mapLoaded = true;
    checkIfUnlocked();
    updateAppReady();
  }).catch(err => {
    console.error("Could not load map data:", err);
    showModal('Error', "Could not load map data. Please refresh the page.");
  });

  window.addEventListener("resize", debounce(setupAndRenderMap, CONFIG.RESIZE_DEBOUNCE));

  // --- UI Elements (Modal, Theme, Menu) ---
  function announceStatus(message) {
    status.textContent = "";
    window.requestAnimationFrame(() => {
      status.textContent = message;
    });
  }

  function hideModal() {
    modal.classList.remove('visible');
    modal.setAttribute('aria-hidden', 'true');
    elementBeforeModal?.focus();
    elementBeforeModal = null;
  }
  modalClose.addEventListener('click', hideModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) hideModal();
  });

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // The theme still applies when storage is unavailable.
    }
    toggleThemeButton.setAttribute(
      "aria-label",
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
    );
    setTimeout(setupAndRenderMap, 50); 
  }
  toggleThemeButton.addEventListener('click', () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    applyTheme(current === "dark" ? "light" : "dark");
  });

  function closeMenuDropdown() {
    menuDropdown.hidden = true;
    hamburger.setAttribute('aria-expanded', 'false');
    hamburger.setAttribute('aria-label', 'Open menu');
  }
  hamburger.addEventListener('click', () => {
    const isExpanded = hamburger.getAttribute('aria-expanded') === 'true';
    if (isExpanded) {
      closeMenuDropdown();
    } else {
      menuDropdown.hidden = false;
      hamburger.setAttribute('aria-expanded', 'true');
      hamburger.setAttribute('aria-label', 'Close menu');
      (menuDropdown.querySelector('.menu-item')).focus();
    }
  });

  function handleMenuKeydown(e) {
    if (e.key === 'Escape') return closeMenuDropdown();
    if (e.key === 'Tab' && document.activeElement === aboutMenu) {
        hamburger.focus();
        e.preventDefault();
    }
  }
  menuDropdown.addEventListener('keydown', handleMenuKeydown);
  document.addEventListener('click', e => {
    if (!menuDropdown.contains(e.target) && e.target !== hamburger) closeMenuDropdown();
  });
  
  aboutMenu.addEventListener('click', () => {
    closeMenuDropdown();
    showModal(
      'About',
      "Inspired by Ho'oponopono & The Pitt.\n\nPress a button to display a dot on the map. " +
      "Location is converted to an approximate 4-character geohash. " +
      "Map records contain no account or device identifier.",
    );
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('visible')) hideModal();
  });

  function showModal(title, message) {
    const modalTitle = document.getElementById('modalTitle');
    const modalMessage = document.getElementById('modalMessage');
    // The splash stacks above the modal, so a startup failure would otherwise
    // report itself behind an opaque "Loading…" panel.
    hideAppLoading();
    if (modal && modalTitle && modalMessage) {
      elementBeforeModal = document.activeElement;
      modalTitle.textContent = title;
      modalMessage.textContent = message;
      modal.classList.add('visible');
      modal.setAttribute('aria-hidden', 'false');
      announceStatus(`${title}: ${message}`);
      window.requestAnimationFrame(() => modalClose.focus());
    }
  }

  function handleGeolocationError(error) {
    switch(error.code) {
      case error.PERMISSION_DENIED:
        showModal('Location Blocked', "Your browser has blocked location access.\n\nTo display your dot on the map, please enable location in your browser or system settings.");
        break;
      case error.POSITION_UNAVAILABLE:
        showModal('Location Unavailable', "Your location could not be determined. Please ensure location services are enabled and you have a clear signal.");
        break;
      case error.TIMEOUT:
        showModal('Location Timeout', "Could not get your location in time. Please check your connection and try again.");
        break;
      default:
        showModal('Location Error', "An unknown error occurred while trying to get your location.");
        break;
    }
  }

  function showFirebaseError(error, context) {
    const userMessage = "The message could not be sent. Please wait a moment and try again.";
    showModal('Error', userMessage);
    console.error(`Firebase Error (${context}):`, error);
  }

  applyTheme(document.documentElement.getAttribute("data-theme") || "light");

});

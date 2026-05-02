#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn, execSync } = require("child_process");
const puppeteer = require("puppeteer");

const TELEGRAM_WEB_URL = "https://web.telegram.org/a/";
const USER_DATA_DIR = path.join(__dirname, "..", ".telegram-session");
const CHAT_CONFIG_PATH = path.join(USER_DATA_DIR, "chat-config.json");
const POLL_INTERVAL_MS = 1200;
const HEADLESS_OVERRIDE = process.env.HEADLESS;

let seenIds = new Set();
let sessionArmed = false;
let waitingBotReply = false;
let lastBotResponse = "Aun sin respuesta.";
let lastAudioEvent = "Sin audio reciente.";
let currentInputPreview = "";
let currentChatName = "Sin chat seleccionado";
let forceVisibleNextRun = false;

function detectPlayer() {
  const candidates = [
    { bin: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "error"] },
    { bin: "mpv", args: ["--no-video", "--really-quiet"] },
    { bin: "paplay", args: [] },
  ];
  for (const c of candidates) {
    try {
      execSync(`command -v ${c.bin}`, { stdio: "ignore" });
      return c;
    } catch (_) {
      // try next
    }
  }
  return null;
}

const SYSTEM_PLAYER = detectPlayer();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadChatConfig() {
  try {
    const raw = fs.readFileSync(CHAT_CONFIG_PATH, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data.url === "string" && data.url.length > 0) return data;
  } catch (_) {
    // sin config
  }
  return null;
}

function saveChatConfig(cfg) {
  fs.mkdirSync(path.dirname(CHAT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CHAT_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

async function clearAllSession() {
  await fs.promises.rm(USER_DATA_DIR, { recursive: true, force: true });
}

function getTerminalWidth() {
  const cols = process.stdout.columns || 80;
  return Math.max(50, Math.min(cols, 140));
}

function getTerminalHeight() {
  return Math.max(15, process.stdout.rows || 24);
}

function wrapText(text, width) {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line.length) {
      line = word;
      continue;
    }
    if ((line + " " + word).length <= width) {
      line += " " + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [""];
}

function buildBox(title, content, width, minRows = 4, maxRows = 8) {
  const innerWidth = Math.max(10, width - 4);
  const titleLabel = ` ${title} `.slice(0, innerWidth);
  const titlePad = Math.max(0, innerWidth - titleLabel.length);
  const top = `╔═${titleLabel}${"═".repeat(titlePad)}╗`;
  const bottom = `╚${"═".repeat(width - 2)}╝`;

  const textLines = wrapText(content, innerWidth).slice(0, maxRows);
  while (textLines.length < minRows) textLines.push("");
  const body = textLines.map((line) => `║ ${line.padEnd(innerWidth)} ║`);
  return [top, ...body, bottom];
}

function centerText(text, width) {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

const IL_TITLE_ART = [
  "██╗██╗         █████╗ ███████╗███████╗██╗███████╗████████╗ █████╗ ███╗   ██╗████████╗",
  "██║██║        ██╔══██╗██╔════╝██╔════╝██║██╔════╝╚══██╔══╝██╔══██╗████╗  ██║╚══██╔══╝",
  "██║██║        ███████║███████╗███████╗██║███████╗   ██║   ███████║██╔██╗ ██║   ██║   ",
  "██║██║        ██╔══██║╚════██║╚════██║██║╚════██║   ██║   ██╔══██║██║╚██╗██║   ██║   ",
  "██║███████╗   ██║  ██║███████║███████║██║███████║   ██║   ██║  ██║██║ ╚████║   ██║   ",
  "╚═╝╚══════╝   ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ",
];

const IL_TITLE_COMPACT = ["━━━━[  iL  ASSISTANT  ]━━━━"];

const IL_BOT_ICON = [
  "█████████████████████████",
  "█████████████████████████",
  "██████   ███████   ██████",
  "██████   ███████   ██████",
  "█████████████████████████",
  "█████████████████████████",
  "███   ███     ███    ███ ",
  "███   ███     ███    ███ ",
];

function renderCliShell(inputValue = "", spinnerText = "") {
  const width = getTerminalWidth();
  const height = getTerminalHeight();
  const showFullBanner = width >= 90;
  const showBotIcon = width >= 60 && height >= 32;

  const now = new Date().toLocaleString("es-CO", {
    hour12: true,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const panelTop = "┌" + "─".repeat(width - 2) + "┐";
  const panelBottom = "└" + "─".repeat(width - 2) + "┘";

  const titleLines = showFullBanner ? IL_TITLE_ART : IL_TITLE_COMPACT;
  const banner = [
    panelTop,
    ...titleLines.map((line) => `│${centerText(line, width - 2)}│`),
    panelBottom,
  ];

  if (showBotIcon) {
    banner.push("");
    banner.push(...IL_BOT_ICON.map((line) => centerText(line, width)));
  }

  banner.push("");
  banner.push(centerText(`Chat: ${currentChatName}`, width));
  banner.push(centerText(`Timestamp: ${now}`, width));
  banner.push("");

  const responseBox = buildBox("✦ RESPUESTA // IL ASSISTANT", lastBotResponse, width, 4);
  const audioBox = buildBox("♪ AUDIO", lastAudioEvent, width, 1, 2);
  const statusText = waitingBotReply
    ? spinnerText || "Procesando respuesta del bot..."
    : "Listo. Enter para enviar. /visible reabrir browser. /logout cerrar sesion. /salir terminar.";
  const inputBox = buildBox("⌨ COMANDO", inputValue || " ", width, 1, 3);
  const statusLine = `● Estado: ${statusText}`.slice(0, width);

  process.stdout.write("\x1Bc");
  [
    ...banner,
    ...responseBox,
    "",
    ...audioBox,
    "",
    ...inputBox,
    "",
    statusLine,
  ].forEach((line) => console.log(line));
}

async function ensureSessionDir() {
  await fs.promises.mkdir(USER_DATA_DIR, { recursive: true });
}

async function isChatOpen(page) {
  return page.evaluate(() => {
    return !!document.querySelector(
      "div[contenteditable='true'][role='textbox'], .input-message-input, .composer_rich_textarea"
    );
  });
}

async function waitForChatOpen(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isChatOpen(page)) return true;
    await wait(300);
  }
  return false;
}

async function waitForChatList(page) {
  await page.waitForFunction(
    () =>
      !!document.querySelector(
        ".ChatList, .chat-list, #LeftColumn-main .ChatFolders, [data-test='chat-list']"
      ),
    { timeout: 0 }
  );
}

async function listAvailableChats(page) {
  return page.evaluate(() => {
    document
      .querySelectorAll("[data-il-idx]")
      .forEach((el) => el.removeAttribute("data-il-idx"));

    const candidates = Array.from(
      document.querySelectorAll(
        ".ChatList .Chat, .ChatList .ListItem, .chat-list .ListItem, .chat-list-item, .chatlist-chat, [role='listitem']"
      )
    );

    const chats = [];
    const seen = new Set();
    let idx = 0;

    for (const node of candidates) {
      const titleEl = node.querySelector(
        ".title, .fullName, .user-title, .chat-title, .peer-title, .ListItem-button .fullName, h3"
      );
      let title =
        (titleEl?.textContent || node.getAttribute("aria-label") || "").trim();
      title = title.replace(/\s+/g, " ").slice(0, 60);
      if (!title) continue;
      if (seen.has(title)) continue;
      seen.add(title);

      node.setAttribute("data-il-idx", String(idx));
      chats.push({ idx, title });
      idx += 1;
      if (chats.length >= 50) break;
    }
    return chats;
  });
}

async function clickChatByIndex(page, idx) {
  return page.evaluate((i) => {
    const node = document.querySelector(`[data-il-idx="${i}"]`);
    if (!node) return false;
    node.scrollIntoView?.({ block: "center", behavior: "auto" });
    node.click();
    return true;
  }, idx);
}

function askLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function askChoice(prompt, min, max) {
  while (true) {
    const ans = await askLine(prompt);
    const n = parseInt(ans, 10);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    console.log(`Valor invalido. Debe estar entre ${min} y ${max}.`);
  }
}

async function onboardChat(page) {
  process.stdout.write("\x1Bc");
  console.log("=== PRIMER ARRANQUE / SELECCION DE CHAT ===\n");
  console.log("Abriendo Telegram Web. Inicia sesion escaneando el QR si hace falta.");
  await page.goto(TELEGRAM_WEB_URL, { waitUntil: "domcontentloaded" });
  console.log("Esperando que cargue tu lista de chats...");
  await waitForChatList(page);
  await wait(1500);

  const chats = await listAvailableChats(page);
  if (!chats.length) {
    throw new Error(
      "No encontre ningun chat en la lista. Asegurate de tener chats en Telegram y vuelve a intentarlo."
    );
  }

  console.log("\n=== CHATS DISPONIBLES ===");
  chats.forEach((c) => console.log(`  ${String(c.idx + 1).padStart(2)}. ${c.title}`));
  console.log("");

  const choice = await askChoice(`Elige un chat (1-${chats.length}): `, 1, chats.length);
  const selected = chats[choice - 1];
  console.log(`\nAbriendo: ${selected.title}...`);

  const ok = await clickChatByIndex(page, selected.idx);
  if (!ok) throw new Error("No pude hacer click en el chat seleccionado.");

  const opened = await waitForChatOpen(page, 15000);
  if (!opened) throw new Error("Hice click pero el chat no se abrio.");

  await wait(800);
  const url = page.url();
  saveChatConfig({ url, name: selected.title });
  console.log(`Chat "${selected.title}" guardado para futuras sesiones.\n`);
  return { url, name: selected.title };
}

async function openSavedChat(page, chatConfig) {
  await page.goto(chatConfig.url, { waitUntil: "domcontentloaded" });
  const opened = await waitForChatOpen(page, 15000);
  if (!opened) throw new Error("No pude abrir el chat guardado.");
}

async function sendMessage(page, text) {
  const inputSelectors = [
    "div[contenteditable='true'][role='textbox']",
    ".input-message-input",
    ".composer_rich_textarea",
  ];
  let selector = null;
  for (const s of inputSelectors) {
    if (await page.$(s)) {
      selector = s;
      break;
    }
  }
  if (!selector) throw new Error("No encontre el campo de mensaje.");
  await page.focus(selector);
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press("Enter");
}

async function readNewMessages(page) {
  const payload = await page.evaluate(() => {
    const list = [];
    const nodes = document.querySelectorAll("[data-message-id], .message");
    nodes.forEach((node, idx) => {
      const dataMessageId =
        node.getAttribute("data-message-id") || node.getAttribute("data-mid") || "";
      const id =
        dataMessageId ||
        node.id ||
        `fallback-${idx}-${(node.textContent || "").slice(0, 30)}`;

      const own =
        node.classList.contains("own") ||
        node.classList.contains("is-out") ||
        node.matches(".message-out, .is-outgoing");

      const text =
        node.querySelector(".message-text, .text-content, .translatable-message")
          ?.textContent?.trim() || "";

      const hasVoice =
        !!node.querySelector("audio") ||
        !!node.querySelector(
          ".voice-message, .media-inner audio, .is-voice, .Audio, .MediaVoice"
        );

      list.push({ id, own, text, hasVoice, dataMessageId });
    });
    return list;
  });
  return payload.filter((m) => !m.own);
}

async function seedSeenMessages(page) {
  const current = await readNewMessages(page);
  for (const msg of current) {
    seenIds.add(msg.id);
  }
}

async function installAutoplayObserver(page) {
  // Solo detectamos voice messages nuevos y los encolamos. El click real lo
  // hace Node con page.click() para producir eventos isTrusted=true; los
  // eventos sinteticos (dispatchEvent) en headless no disparan los listeners
  // de Telegram que requieren user gesture confiable.
  await page.evaluate(() => {
    if (window.__tgAutoplayInstalled) return;
    window.__tgAutoplayInstalled = true;
    window.__tgPlayedIds = new Set();
    window.__tgVoicePending = window.__tgVoicePending || [];
    let __tgIdCounter = 0;

    function isIncomingVoiceMessage(messageNode) {
      if (!messageNode) return false;
      const isOwn =
        messageNode.classList.contains("own") ||
        messageNode.classList.contains("is-out") ||
        messageNode.matches?.(".message-out, .is-outgoing");
      if (isOwn) return false;
      return !!messageNode.querySelector(
        ".voice-message, .is-voice, .Audio, .MediaVoice, audio"
      );
    }

    function getMessageKey(messageNode) {
      const id =
        messageNode.getAttribute("data-message-id") ||
        messageNode.getAttribute("data-mid") ||
        messageNode.id ||
        "";
      if (id) return "id:" + id;
      // Como fallback, asignamos un id sintetico estable al nodo.
      if (!messageNode.__tgKey) {
        messageNode.__tgKey = "syn:" + (++__tgIdCounter);
      }
      return messageNode.__tgKey;
    }

    function enqueue(messageNode) {
      const key = getMessageKey(messageNode);
      if (window.__tgPlayedIds.has(key)) return;
      window.__tgPlayedIds.add(key);
      messageNode.setAttribute("data-tg-pending", key);
      window.__tgVoicePending.push(key);
    }

    // Marcar historico como visto para no auto-reproducirlo al arrancar.
    document.querySelectorAll("[data-message-id], .message").forEach((m) => {
      if (!isIncomingVoiceMessage(m)) return;
      window.__tgPlayedIds.add(getMessageKey(m));
    });

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (!m.addedNodes || !m.addedNodes.length) continue;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const msg = n.closest?.("[data-message-id], .message") || n;
          if (isIncomingVoiceMessage(msg)) {
            enqueue(msg);
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
}

async function readVoiceState(page, key) {
  return page
    .evaluate((k) => {
      const node = document.querySelector(`[data-tg-pending="${k}"]`);
      if (!node) return { state: "missing" };
      const wrapper = node.querySelector(
        ".toogle-play-wrapper, .toggle-play-wrapper, [class*='toogle-play'], [class*='toggle-play']"
      );
      if (!wrapper) return { state: "no-wrapper" };
      const cls = (wrapper.className || "").toString().toLowerCase();
      let state = "unknown";
      if (/\bpause\b/.test(cls)) state = "pause";
      else if (/\b(loading|download|progress)\b/.test(cls)) state = "download";
      else if (/\bplay\b/.test(cls)) state = "play";
      // Asignar id estable al boton para click trusted.
      const btn = wrapper.querySelector("button, [role='button']");
      if (btn && !btn.getAttribute("data-tg-btn")) {
        btn.setAttribute("data-tg-btn", k);
      }
      return { state };
    }, key)
    .catch(() => ({ state: "error" }));
}

async function clickVoiceButton(page, key) {
  try {
    await page.click(`[data-tg-btn="${key}"]`, { delay: 30 });
    return true;
  } catch (_) {
    return false;
  }
}

async function playVoice(page, key) {
  const keyShort = key.length > 30 ? key.slice(0, 30) + "..." : key;

  // Asegurar que el boton esta visible para que page.click pueda hacerlo.
  await page
    .evaluate((k) => {
      const node = document.querySelector(`[data-tg-pending="${k}"]`);
      node?.scrollIntoView?.({ block: "center", behavior: "auto" });
    }, key)
    .catch(() => {});

  let info = await readVoiceState(page, key);

  if (info.state === "pause") {
    lastAudioEvent = `Audio ${keyShort}: ya estaba reproduciendose, no toco.`;
    renderCliShell(currentInputPreview);
    return;
  }
  if (info.state === "missing") {
    lastAudioEvent = `Audio ${keyShort}: nodo no encontrado en DOM.`;
    renderCliShell(currentInputPreview);
    return;
  }
  if (info.state === "error") {
    lastAudioEvent = `Audio ${keyShort}: error al leer estado.`;
    renderCliShell(currentInputPreview);
    return;
  }
  if (info.state === "no-wrapper") {
    lastAudioEvent = `Audio ${keyShort}: sin wrapper. Click ciego.`;
    renderCliShell(currentInputPreview);
  }

  const tsBefore = Date.now();

  if (info.state === "play") {
    await clickVoiceButton(page, key);
  } else if (info.state === "download") {
    await clickVoiceButton(page, key);
    // Esperar a que la descarga termine y el estado pase a play.
    for (let i = 0; i < 12; i += 1) {
      await wait(800);
      info = await readVoiceState(page, key);
      if (info.state === "pause") break;
      if (info.state === "play") {
        await clickVoiceButton(page, key);
        break;
      }
      if (info.state !== "download") break;
    }
  } else {
    await clickVoiceButton(page, key);
  }

  // En headless el navegador no produce audio audible, asi que ademas leemos
  // el blob capturado por los hooks (fetch/XHR/MSE/MediaRecorder) y lo
  // pasamos a ffplay/mpv.
  if (SYSTEM_PLAYER) {
    const audio = await pollForNewAudio(page, tsBefore, 60000);
    if (audio && audio.buf && audio.buf.length >= 200) {
      playAudioBuffer(audio.buf);
      lastAudioEvent = `Reproduciendo (${SYSTEM_PLAYER.bin}, ${(audio.buf.length / 1024).toFixed(0)} KB).`;
    } else {
      const debug = await page
        .evaluate(() => (window.__tgAudioDebug || []).slice(-5).join(" | "))
        .catch(() => "");
      lastAudioEvent = `Audio: timeout. Hooks: [${debug}]`;
    }
    renderCliShell(currentInputPreview);
  }
}

async function processVoicePending(page) {
  const pending = await page
    .evaluate(() => {
      if (!window.__tgVoicePending) window.__tgVoicePending = [];
      if (!window.__tgPlayedIds) window.__tgPlayedIds = new Set();

      const queue = window.__tgVoicePending.splice(0);

      // Adicional: escanear DOM por voice messages no marcados aun.
      // Cubre los casos donde el MutationObserver perdio el evento (por
      // ejemplo, mensaje insertado antes de instalar el observer, o cambiado
      // por mutacion de attributes que el observer no escucha).
      let counter = 0;
      document.querySelectorAll("[data-message-id], .message").forEach((m) => {
        const isOwn =
          m.classList.contains("own") ||
          m.classList.contains("is-out") ||
          (m.matches && m.matches(".message-out, .is-outgoing"));
        if (isOwn) return;
        const hasVoice = !!m.querySelector(
          ".voice-message, .is-voice, .Audio, .MediaVoice, audio"
        );
        if (!hasVoice) return;

        const rawId =
          m.getAttribute("data-message-id") ||
          m.getAttribute("data-mid") ||
          m.id ||
          "";
        let key = rawId ? "id:" + rawId : "";
        if (!key) {
          if (m.__tgKey) key = m.__tgKey;
          else {
            counter += 1;
            m.__tgKey = "syn:" + counter + "_" + Date.now();
            key = m.__tgKey;
          }
        }

        if (window.__tgPlayedIds.has(key)) return;
        window.__tgPlayedIds.add(key);
        m.setAttribute("data-tg-pending", key);
        queue.push(key);
      });

      return queue;
    })
    .catch(() => []);

  for (const key of pending) {
    // Un voice por vez para que ffplay no se solape entre dos audios.
    await playVoice(page, key).catch(() => {});
  }
}

// Telegram Web "/a/" sirve audios desde un Service Worker que los lee de
// IndexedDB. Las URLs son internas (ej. /a/progressive/documentXXX) y solo
// el HTMLMediaElement las puede resolver. Para capturar el blob real
// hookeamos fetch + XHR + MediaSource desde page.evaluateOnNewDocument
// ANTES de que cargue Telegram.
const AUDIO_HOOK_FN = function () {
  if (window.__tgAudioHooked) return;
  window.__tgAudioHooked = true;
  window.__tgAudioBuffers = window.__tgAudioBuffers || {};
  window.__tgAudioDebug = window.__tgAudioDebug || [];

  function log(msg) {
    window.__tgAudioDebug.push(`${Date.now()} ${msg}`);
    if (window.__tgAudioDebug.length > 100) window.__tgAudioDebug.shift();
  }

  function isAudioLike(url, ct) {
    return (
      (ct && (ct.includes("audio") || ct.includes("opus"))) ||
      /\.(ogg|oga|opus|mp3|m4a|wav)/i.test(url || "") ||
      /progressive\/document/i.test(url || "")
    );
  }

  function publishBlob(url, blob) {
    if (!blob || blob.size < 200) return;
    const reader = new FileReader();
    reader.onload = () => {
      window.__tgAudioBuffers[url || `auto-${Date.now()}`] = {
        dataUrl: reader.result,
        ts: Date.now(),
        size: blob.size,
        type: blob.type || "",
      };
      log(`buf ${blob.size}B from ${url ? url.slice(0, 60) : "?"}`);
    };
    reader.readAsDataURL(blob);
  }

  // 1. window.fetch
  try {
    const origFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const resp = await origFetch(input, init);
      try {
        if (resp && resp.ok) {
          const ct = (resp.headers.get("content-type") || "").toLowerCase();
          if (isAudioLike(url, ct)) {
            resp.clone().blob().then((blob) => publishBlob(url, blob)).catch(() => {});
          }
        }
      } catch (_) {}
      return resp;
    };
    log("fetch hooked");
  } catch (e) {
    log(`fetch hook err: ${e && e.message}`);
  }

  // 2. XMLHttpRequest
  try {
    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    XHR.prototype.open = function (method, url) {
      this.__tgUrl = url || "";
      return origOpen.apply(this, arguments);
    };
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function () {
      this.addEventListener("load", function () {
        try {
          const url = this.__tgUrl || "";
          const ct = (
            (this.getResponseHeader && this.getResponseHeader("content-type")) ||
            ""
          ).toLowerCase();
          if (!isAudioLike(url, ct)) return;
          let blob = null;
          if (this.response instanceof Blob) blob = this.response;
          else if (this.response instanceof ArrayBuffer)
            blob = new Blob([this.response], { type: ct || "audio/ogg" });
          if (blob) publishBlob(url, blob);
        } catch (_) {}
      });
      return origSend.apply(this, arguments);
    };
    log("xhr hooked");
  } catch (e) {
    log(`xhr hook err: ${e && e.message}`);
  }

  // 3. MediaSource.appendBuffer (audios servidos via MSE / streaming)
  try {
    if (window.MediaSource && window.SourceBuffer) {
      const origAdd = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime) {
        const sb = origAdd.apply(this, arguments);
        const lc = (mime || "").toLowerCase();
        if (lc.includes("audio")) {
          sb.__tgChunks = [];
          sb.__tgMime = mime;
          let endTimer = null;
          const flush = () => {
            try {
              if (!sb.__tgChunks || !sb.__tgChunks.length) return;
              const total = sb.__tgChunks.reduce((s, c) => s + c.length, 0);
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of sb.__tgChunks) { merged.set(c, off); off += c.length; }
              sb.__tgChunks = [];
              const blob = new Blob([merged], { type: sb.__tgMime || "audio/ogg" });
              publishBlob(`mse-${Date.now()}`, blob);
            } catch (_) {}
          };
          const origAppend = sb.appendBuffer;
          sb.appendBuffer = function (data) {
            try {
              let bytes = null;
              if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
              else if (ArrayBuffer.isView(data))
                bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
              if (bytes) sb.__tgChunks.push(bytes.slice());
            } catch (_) {}
            if (endTimer) clearTimeout(endTimer);
            endTimer = setTimeout(flush, 2500);
            return origAppend.apply(this, arguments);
          };
        }
        return sb;
      };
      log("mediasource hooked");
    }
  } catch (e) {
    log(`mse hook err: ${e && e.message}`);
  }

  // 4. Grabar el output del HTMLMediaElement con MediaRecorder. Cubre el caso
  // donde el <audio src="..."> pide el archivo directamente al SW y nada
  // pasa por fetch/XHR/MSE.
  function attachRecorder(audio) {
    if (!audio || audio.__tgRecAttached) return;
    audio.__tgRecAttached = true;
    audio.addEventListener("play", function () {
      if (audio.__tgRecording) return;
      audio.__tgRecording = true;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!window.__tgAudioCtx) window.__tgAudioCtx = new Ctx();
        const ctx = window.__tgAudioCtx;
        const source = ctx.createMediaElementSource(audio);
        const dest = ctx.createMediaStreamDestination();
        source.connect(dest);
        source.connect(ctx.destination);

        let mime = "audio/webm;codecs=opus";
        if (typeof MediaRecorder !== "undefined" && !MediaRecorder.isTypeSupported(mime)) {
          mime = "audio/webm";
        }
        const recorder = new MediaRecorder(dest.stream, { mimeType: mime });
        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        recorder.onstop = () => {
          if (!chunks.length) return;
          const blob = new Blob(chunks, { type: mime });
          publishBlob(audio.src || `rec-${Date.now()}`, blob);
        };
        const stopIfEnded = () => {
          if (recorder.state === "recording") recorder.stop();
        };
        audio.addEventListener("ended", stopIfEnded);
        audio.addEventListener("pause", () => {
          if (audio.duration && audio.currentTime >= audio.duration - 0.3) stopIfEnded();
        });
        recorder.start(1000);
        log(`rec started for ${audio.src ? audio.src.slice(0, 60) : "?"}`);
      } catch (e) {
        log(`rec err: ${e && e.message}`);
      }
    });
  }

  try {
    document.querySelectorAll("audio").forEach(attachRecorder);
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (!m.addedNodes) continue;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === "AUDIO") attachRecorder(n);
          if (n.querySelectorAll) n.querySelectorAll("audio").forEach(attachRecorder);
        }
      }
    });
    obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
    log("recorder observer installed");
  } catch (e) {
    log(`rec observer err: ${e && e.message}`);
  }
};

async function installFetchHook(page) {
  await page.evaluateOnNewDocument(AUDIO_HOOK_FN).catch(() => {});
  await page.evaluate(AUDIO_HOOK_FN).catch(() => {});
}

let currentAudioChild = null;

function playAudioBuffer(buf) {
  if (!SYSTEM_PLAYER || !buf) return false;
  const file = path.join(os.tmpdir(), `tg-voice-${Date.now()}.ogg`);
  fs.writeFileSync(file, buf);

  if (currentAudioChild && !currentAudioChild.killed) {
    try {
      currentAudioChild.kill("SIGTERM");
    } catch (_) {}
  }

  const child = spawn(SYSTEM_PLAYER.bin, [...SYSTEM_PLAYER.args, file], {
    stdio: "ignore",
    detached: true,
  });
  currentAudioChild = child;
  child.unref();

  setTimeout(() => fs.unlink(file, () => {}), 5 * 60 * 1000);
  return true;
}

async function pollForNewAudio(page, sinceTs, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await page
      .evaluate((since) => {
        const buffers = window.__tgAudioBuffers || {};
        let latest = null;
        for (const url in buffers) {
          const entry = buffers[url];
          if (entry.ts > since) {
            if (!latest || entry.ts > latest.ts) {
              latest = { url, dataUrl: entry.dataUrl, ts: entry.ts, size: entry.size };
            }
          }
        }
        if (latest) delete buffers[latest.url];
        return latest;
      }, sinceTs)
      .catch(() => null);

    if (result && result.dataUrl) {
      const idx = result.dataUrl.indexOf(",");
      if (idx >= 0) {
        return {
          buf: Buffer.from(result.dataUrl.slice(idx + 1), "base64"),
          url: result.url,
          size: result.size,
        };
      }
    }
    await wait(500);
  }
  return null;
}

function createSpinner() {
  return {
    start(text) {
      renderCliShell(currentInputPreview, `● ${text}`);
    },
    stop() {
      renderCliShell(currentInputPreview);
    },
  };
}

async function runSession() {
  seenIds = new Set();
  sessionArmed = false;
  waitingBotReply = false;
  lastBotResponse = "Aun sin respuesta.";
  lastAudioEvent = "Sin audio reciente.";
  currentInputPreview = "";
  currentChatName = "Sin chat seleccionado";

  await ensureSessionDir();

  let chatConfig = loadChatConfig();
  const isFirstTime = !chatConfig;

  let headless;
  if (forceVisibleNextRun) {
    headless = false;
    forceVisibleNextRun = false;
  } else if (HEADLESS_OVERRIDE === "0") headless = false;
  else if (HEADLESS_OVERRIDE === "1") headless = true;
  else headless = !isFirstTime;

  if (SYSTEM_PLAYER && headless) {
    console.log(`Reproductor de audio detectado: ${SYSTEM_PLAYER.bin}. Audio local activado.`);
  } else if (!SYSTEM_PLAYER && headless) {
    console.log(
      "Aviso: estas en headless y no se detecto ffplay/mpv/paplay. Los audios solo sonarian desde el navegador (no audible)."
    );
  }

  const browser = await puppeteer.launch({
    headless,
    userDataDir: USER_DATA_DIR,
    defaultViewport: null,
    args: [
      "--start-maximized",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=AutoplayIgnoreWebAudio",
    ],
  });

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());

  try {
    // Hook de fetch debe instalarse ANTES de cualquier navegacion para que
    // capture los responses del Service Worker (audios) desde el inicio.
    await installFetchHook(page);

    if (chatConfig) {
      console.log(`Abriendo chat guardado: ${chatConfig.name}`);
      try {
        await openSavedChat(page, chatConfig);
      } catch (err) {
        console.log(`No pude abrir el chat guardado (${err.message}).`);
        console.log("Pasando a seleccion manual...");
        chatConfig = null;
      }
    }

    if (!chatConfig) {
      chatConfig = await onboardChat(page);
    }

    currentChatName = chatConfig.name;
    if (!headless) {
      try {
        await page.bringToFront();
      } catch (_) {}
    }

    await installAutoplayObserver(page);
    page.on("framenavigated", () => installAutoplayObserver(page).catch(() => {}));
    await seedSeenMessages(page);

    lastBotResponse = "Sistema listo. Te escucho.";
    lastAudioEvent = headless
      ? "Modo headless. Audio por reproductor local."
      : "Modo visible. Audio desde Telegram Web.";
    renderCliShell();

    return await new Promise((resolve) => {
      let pollHandle = null;
      let resolved = false;

      const onResize = () => {
        if (!resolved) renderCliShell(currentInputPreview);
      };
      process.stdout.on("resize", onResize);

      const cleanup = async () => {
        if (pollHandle) clearInterval(pollHandle);
        process.stdout.removeListener("resize", onResize);
        try {
          await browser.close();
        } catch (_) {}
      };

      const spinner = createSpinner();

      const submitMessage = async (text) => {
        if (!text || waitingBotReply) return;
        sessionArmed = true;
        waitingBotReply = true;
        rl.pause();
        lastBotResponse = "Enviando mensaje...";
        renderCliShell(currentInputPreview);
        spinner.start("Esperando respuesta del bot...");
        try {
          await sendMessage(page, text);
        } catch (err) {
          waitingBotReply = false;
          lastBotResponse = `Error al enviar: ${err.message}`;
          spinner.stop();
          rl.resume();
          rl.prompt();
        }
      };

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "mensaje > ",
      });
      rl.prompt();

      rl.on("line", async (line) => {
        const text = line.trim();
        if (!text) return rl.prompt();

        if (text === "/salir") {
          rl.close();
          resolved = true;
          await cleanup();
          console.log("Hasta luego.");
          return resolve("exit");
        }

        if (text === "/logout") {
          rl.close();
          resolved = true;
          console.log("\nCerrando sesion y limpiando datos...");
          await cleanup();
          await clearAllSession();
          console.log("Listo. Vamos a iniciar sesion de nuevo y elegir chat.\n");
          return resolve("logout");
        }

        if (text === "/visible") {
          rl.close();
          resolved = true;
          console.log("\nReiniciando en modo visible (sin borrar sesion)...");
          await cleanup();
          forceVisibleNextRun = true;
          return resolve("restart-visible");
        }

        currentInputPreview = text;
        renderCliShell(currentInputPreview);
        await submitMessage(text);
        if (!waitingBotReply) rl.prompt();
      });

      rl.on("close", async () => {
        if (resolved) return;
        resolved = true;
        await cleanup();
        resolve("exit");
      });

      pollHandle = setInterval(async () => {
        if (resolved) return;
        try {
          await installAutoplayObserver(page);
          // Disparar clicks trusted (page.click) en voice messages encolados
          // por el observer. No bloquea el polling.
          processVoicePending(page).catch(() => {});
          const incoming = await readNewMessages(page);
          let printedAny = false;
          for (const msg of incoming) {
            if (seenIds.has(msg.id)) continue;
            seenIds.add(msg.id);
            if (!sessionArmed) continue;

            if (waitingBotReply) {
              waitingBotReply = false;
              spinner.stop();
              rl.resume();
            }

            if (msg.text) {
              lastBotResponse = msg.text;
            } else if (msg.hasVoice) {
              lastAudioEvent = "Mensaje de voz recibido.";
            }
            currentInputPreview = "";
            renderCliShell(currentInputPreview);
            printedAny = true;
          }
          if (printedAny) rl.prompt();
        } catch (_) {
          // silencioso
        }
      }, POLL_INTERVAL_MS);
    });
  } catch (err) {
    try {
      await browser.close();
    } catch (_) {}
    throw err;
  }
}

async function main() {
  while (true) {
    let result;
    try {
      result = await runSession();
    } catch (err) {
      console.error("Fallo:", err.message);
      process.exit(1);
    }
    if (result === "exit") {
      process.exit(0);
    }
    if (result !== "logout" && result !== "restart-visible") {
      process.exit(0);
    }
    // logout o restart-visible -> volver a iniciar el flujo
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

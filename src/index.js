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
const ENABLE_SYSTEM_AUDIO_FALLBACK_ENV = process.env.ENABLE_SYSTEM_AUDIO_FALLBACK;

let seenIds = new Set();
let playedAudioUrls = new Set();
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
  await page.evaluate(() => {
    if (window.__tgAutoplayInstalled) return;
    window.__tgAutoplayInstalled = true;
    window.__tgPlayedIds = new Set();

    function fireClick(el) {
      try {
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
        };
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));
      } catch (_) {
        try {
          el.click();
        } catch (__) {}
      }
    }

    function isPauseLabel(el) {
      const label = (
        el.getAttribute?.("aria-label") ||
        el.getAttribute?.("title") ||
        el.textContent ||
        ""
      ).toLowerCase();
      return label.includes("pause") || label.includes("pausar") || label.includes("pausa");
    }

    function findClickable(node) {
      const selectors = [
        "button[aria-label*='Play' i]",
        "button[aria-label*='Reproducir' i]",
        "button[aria-label*='Voice' i]",
        "button[aria-label*='Download' i]",
        "button[aria-label*='Descargar' i]",
        "button.toggle-play",
        ".AudioPlayer-playButton",
        ".play-pause-button",
        ".Audio-playPauseButton",
        ".audio-toggle",
        ".play-btn",
        ".MediaVoice button",
        ".Audio button",
        ".voice-message button",
        ".media-inner button",
        "[class*='download' i] button",
        "[class*='Download' i]",
        ".tgico-download",
        ".icon-download",
        ".message-media-progress",
        ".media-photo-progress button",
      ];
      for (const sel of selectors) {
        const els = node.querySelectorAll(sel);
        for (const el of els) {
          if (isPauseLabel(el)) continue;
          return el;
        }
      }
      const container =
        node.matches?.(".Audio, .voice-message, .is-voice, .media-inner, .MediaVoice")
          ? node
          : node.querySelector?.(".Audio, .voice-message, .is-voice, .media-inner, .MediaVoice");
      if (container) {
        const btns = container.querySelectorAll("button, [role='button']");
        for (const btn of btns) {
          if (isPauseLabel(btn)) continue;
          return btn;
        }
      }
      return null;
    }

    function hasPauseButton(node) {
      const btns = node.querySelectorAll("button, [role='button']");
      for (const b of btns) if (isPauseLabel(b)) return true;
      return false;
    }

    function isIncomingVoiceMessage(messageNode) {
      if (!messageNode) return false;
      const isOwn =
        messageNode.classList.contains("own") ||
        messageNode.classList.contains("is-out") ||
        messageNode.matches(".message-out, .is-outgoing");
      if (isOwn) return false;
      return !!messageNode.querySelector(
        ".voice-message, .is-voice, .Audio, .MediaVoice, audio"
      );
    }

    function attachStartedListener(messageNode, audio) {
      if (!audio || audio.__tgListenerAttached) return;
      audio.__tgListenerAttached = true;
      const markStarted = () => { messageNode.__tgStarted = true; };
      audio.addEventListener("playing", markStarted);
      audio.addEventListener("timeupdate", () => {
        if (audio.currentTime > 0.15) markStarted();
      });
    }

    function describeEl(el) {
      if (!el) return { label: "", cls: "" };
      const label = (
        el.getAttribute?.("aria-label") ||
        el.getAttribute?.("title") ||
        el.textContent ||
        ""
      ).toLowerCase();
      const cls = ((el.className && el.className.toString()) || "").toLowerCase();
      return { label, cls };
    }

    // Detecta el estado del boton del mensaje de voz: "download", "play", "pause" o "unknown".
    // Esto evita clickear ciegamente: si ya descargo, un solo click; si esta descargando, dos.
    function getButtonState(node) {
      const buttons = Array.from(node.querySelectorAll("button, [role='button']"));

      for (const el of buttons) {
        const { label, cls } = describeEl(el);
        if (label.includes("pause") || label.includes("pausar") || label.includes("pausa")) {
          return { state: "pause", el };
        }
        if (label.includes("download") || label.includes("descargar")) {
          return { state: "download", el };
        }
      }
      for (const el of buttons) {
        const { label } = describeEl(el);
        if (
          label.includes("play") ||
          label.includes("reproducir") ||
          label.includes("voice")
        ) {
          return { state: "play", el };
        }
      }
      for (const el of buttons) {
        const { cls } = describeEl(el);
        if (cls.includes("pause")) return { state: "pause", el };
        if (cls.includes("download")) return { state: "download", el };
      }
      // Iconos descarga sueltos
      const downloadIcon = node.querySelector(
        ".tgico-download, .icon-download, [class*='download' i]"
      );
      if (downloadIcon) {
        const btn = downloadIcon.closest?.("button, [role='button']") || downloadIcon;
        return { state: "download", el: btn };
      }
      // Si llegamos aqui y existe un boton dentro del audio, su estado no se puede inferir.
      const fallback =
        node.querySelector(".Audio button, .voice-message button, .MediaVoice button, .media-inner button") ||
        buttons[0] ||
        null;
      return { state: "unknown", el: fallback };
    }

    function audioAlreadyStarted(messageNode) {
      if (messageNode.__tgStarted) return true;
      // Si hay un boton "Pause" visible, ya esta reproduciendose. No tocar.
      if (hasPauseButton(messageNode)) {
        messageNode.__tgStarted = true;
        return true;
      }
      const audio = messageNode.querySelector("audio");
      if (audio && (audio.currentTime > 0 || (audio.duration > 0 && !audio.paused))) {
        messageNode.__tgStarted = true;
        return true;
      }
      return false;
    }

    function forceAudioPlay(messageNode) {
      const audio = messageNode.querySelector("audio");
      if (!audio) return;
      try {
        audio.muted = false;
        audio.volume = 1;
        audio.play().catch(() => {});
      } catch (_) {}
    }

    function tryPlay(messageNode, attempt) {
      attempt = attempt || 0;
      const id =
        messageNode.getAttribute("data-message-id") ||
        messageNode.getAttribute("data-mid") ||
        messageNode.id ||
        "";

      if (attempt === 0) {
        if (messageNode.dataset && messageNode.dataset.tgPlayedVoice === "1") return false;
        if (id && window.__tgPlayedIds.has(id)) return false;
        if (id) window.__tgPlayedIds.add(id);
        if (messageNode.dataset) messageNode.dataset.tgPlayedVoice = "1";
        messageNode.scrollIntoView?.({ block: "center", behavior: "auto" });
      }

      if (audioAlreadyStarted(messageNode)) return true;

      const audio = messageNode.querySelector("audio");
      attachStartedListener(messageNode, audio);

      const { state, el } = getButtonState(messageNode);

      if (state === "pause") {
        // ya esta reproduciendose
        messageNode.__tgStarted = true;
        return true;
      }

      if (state === "play") {
        // Audio ya descargado (auto-download). Un solo click.
        if (el) fireClick(el);
        forceAudioPlay(messageNode);
        return true;
      }

      if (state === "download") {
        // Click descarga. Esperar y re-evaluar para clickear play una vez listo.
        if (el) fireClick(el);
        const waitAndPress = (delay, retries) => {
          setTimeout(() => {
            if (audioAlreadyStarted(messageNode)) return;
            const next = getButtonState(messageNode);
            if (next.state === "pause") {
              messageNode.__tgStarted = true;
              return;
            }
            if (next.state === "play" && next.el) {
              fireClick(next.el);
              forceAudioPlay(messageNode);
              return;
            }
            if (next.state === "download" && retries > 0) {
              // Descarga aun en curso, esperar mas.
              waitAndPress(1500, retries - 1);
              return;
            }
            // unknown: clickear lo que haya como fallback (un solo intento).
            if (next.el && retries > 0) {
              fireClick(next.el);
              forceAudioPlay(messageNode);
            }
          }, delay);
        };
        waitAndPress(1200, 2);
        return true;
      }

      // state === "unknown": no podemos inferir el estado del boton.
      // Mantenemos el comportamiento previo: click + 1 retry a 1500ms.
      if (el) fireClick(el);
      forceAudioPlay(messageNode);
      if (attempt < 1) {
        setTimeout(() => tryPlay(messageNode, attempt + 1), 1500);
      }
      return true;
    }

    const initialMsgs = document.querySelectorAll("[data-message-id], .message");
    initialMsgs.forEach((m) => {
      if (!isIncomingVoiceMessage(m)) return;
      const id = m.getAttribute("data-message-id") || m.getAttribute("data-mid") || m.id || "";
      if (id) window.__tgPlayedIds.add(id);
      if (m.dataset) m.dataset.tgPlayedVoice = "1";
    });

    const observer = new MutationObserver((mutations) => {
      let latestIncomingVoice = null;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            const msg = n.closest?.("[data-message-id], .message") || n;
            if (isIncomingVoiceMessage(msg)) {
              latestIncomingVoice = msg;
            }
          }
        }
      }
      if (latestIncomingVoice) {
        setTimeout(() => tryPlay(latestIncomingVoice), 40);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  });
}

async function fetchFullAudioFromPage(page, url) {
  // Re-descarga el archivo completo desde la pagina (con cookies/auth ya
  // cargadas) para esquivar respuestas Range parciales del CDN. Puede fallar
  // si la URL signed expiro o es cross-origin sin permisos.
  const dataUrl = await page
    .evaluate(async (u) => {
      try {
        const res = await fetch(u, { credentials: "include" });
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return null;
      }
    }, url)
    .catch(() => null);

  if (!dataUrl || typeof dataUrl !== "string") return null;
  const idx = dataUrl.indexOf(",");
  if (idx < 0) return null;
  return Buffer.from(dataUrl.slice(idx + 1), "base64");
}

async function installAudioInterceptor(page) {
  if (!SYSTEM_PLAYER) return;

  const client = await page.target().createCDPSession();
  await client.send("Network.enable");

  let currentAudioChild = null;

  client.on("Network.responseReceived", async (event) => {
    try {
      const { response } = event;
      const url = response.url || "";
      const headers = response.headers || {};
      const ct = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
      const cr = headers["content-range"] || headers["Content-Range"] || "";

      const looksAudio =
        ct.includes("audio/") ||
        ct.includes("opus") ||
        /\.(ogg|oga|opus|mp3|m4a|wav)(\?|$)/i.test(url);

      const looksTelegramCDN =
        /telegram|cdn|web\.telegram\.org|t\.me/i.test(url) || url.startsWith("blob:");

      if (!looksAudio || !looksTelegramCDN) return;

      // Skip respuestas parciales (Range): solo procesamos cuando podamos
      // obtener el archivo completo via refetch.
      if (cr) {
        lastAudioEvent = `Audio parcial detectado (Range: ${cr}). Esperando respuesta completa.`;
        renderCliShell(currentInputPreview);
        return;
      }

      if (playedAudioUrls.has(url)) return;
      playedAudioUrls.add(url);

      const buf = await fetchFullAudioFromPage(page, url);

      if (!buf || buf.length < 200) {
        lastAudioEvent = "No pude obtener el audio completo (refetch fallo o vacio).";
        renderCliShell(currentInputPreview);
        return;
      }

      const file = path.join(os.tmpdir(), `tg-voice-${Date.now()}.ogg`);
      fs.writeFileSync(file, buf);

      // Detener cualquier audio previo para evitar solapamiento.
      if (currentAudioChild && !currentAudioChild.killed) {
        try {
          currentAudioChild.kill("SIGTERM");
        } catch (_) {}
      }

      lastAudioEvent = `Reproduciendo (${SYSTEM_PLAYER.bin}, ${(buf.length / 1024).toFixed(0)} KB).`;
      renderCliShell(currentInputPreview);

      const child = spawn(SYSTEM_PLAYER.bin, [...SYSTEM_PLAYER.args, file], {
        stdio: "ignore",
        detached: true,
      });
      currentAudioChild = child;
      child.unref();

      setTimeout(() => {
        fs.unlink(file, () => {});
      }, 5 * 60 * 1000);
    } catch (err) {
      lastAudioEvent = `Error de audio: ${err.message}`;
      renderCliShell(currentInputPreview);
    }
  });
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
  playedAudioUrls = new Set();
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

  const enableAudioFallback =
    ENABLE_SYSTEM_AUDIO_FALLBACK_ENV === "1" ||
    (ENABLE_SYSTEM_AUDIO_FALLBACK_ENV !== "0" && headless);

  if (SYSTEM_PLAYER && enableAudioFallback) {
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
    if (enableAudioFallback) await installAudioInterceptor(page);

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

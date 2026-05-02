#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn, execSync } = require("child_process");
const puppeteer = require("puppeteer");

const TELEGRAM_WEB_URL = "https://web.telegram.org/a/";
const TELEGRAM_CHAT_URL =
  process.env.TELEGRAM_CHAT_URL || "https://web.telegram.org/a/#8489015629";
const USER_DATA_DIR = path.join(__dirname, "..", ".telegram-session");
const POLL_INTERVAL_MS = 1200;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "IL_assistantbot";
const HEADLESS = process.env.HEADLESS !== "0";
const ENABLE_SYSTEM_AUDIO_FALLBACK =
  process.env.ENABLE_SYSTEM_AUDIO_FALLBACK === "1" ||
  (process.env.ENABLE_SYSTEM_AUDIO_FALLBACK !== "0" && HEADLESS);
const VOICE_WAKE_ENABLED = false;
const AUDIO_INPUT_DEVICE = process.env.AUDIO_INPUT_DEVICE || "default";
const VOICE_CHUNK_SECONDS = Number(process.env.VOICE_CHUNK_SECONDS || 3);
const VOICE_SILENCE_CHUNKS_TO_SEND = Number(process.env.VOICE_SILENCE_CHUNKS_TO_SEND || 2);

const seenIds = new Set();
const playedAudioUrls = new Set();

let sessionArmed = false;
let waitingBotReply = false;
let lastBotResponse = "Aun sin respuesta.";
let lastVoiceEvent = "Sin audio reciente.";
let currentInputPreview = "";

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

function normalizeForMatch(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactForMatch(text) {
  return normalizeForMatch(text).replace(/\s+/g, "");
}

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} finalizo con codigo ${code}`));
    });
  });
}

function findWakeWordInTranscript(transcript) {
  const normalized = normalizeForMatch(transcript);
  const compact = compactForMatch(transcript);
  for (const wake of WAKE_WORD_KEYS) {
    if (!wake) continue;
    if (normalized.includes(wake) || compact.includes(compactForMatch(wake))) {
      return wake;
    }
  }
  return "";
}

async function recordVoiceChunk(outputPath, seconds) {
  await runCommand("ffmpeg", [
    "-y",
    "-f",
    "pulse",
    "-i",
    AUDIO_INPUT_DEVICE,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-t",
    String(seconds),
    "-loglevel",
    "error",
    outputPath,
  ]);
}

async function transcribeWithGroq(audioPath) {
  if (!GROQ_API_KEY) return "";
  const audioBuffer = await fs.promises.readFile(audioPath);
  const form = new FormData();
  form.append("model", GROQ_WHISPER_MODEL);
  form.append("language", "es");
  form.append("response_format", "text");
  form.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "voice.wav");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "sin detalle");
    throw new Error(`Transcripcion fallo (${response.status}): ${errText}`);
  }
  const raw = await response.text();
  const ct = (response.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const data = JSON.parse(raw);
      return (data.text || "").trim();
    } catch (_) {
      return raw.trim();
    }
  }
  return raw.trim();
}

function createSpinner() {
  let active = false;
  let text = "";

  return {
    start(nextText) {
      text = nextText;
      active = true;
      renderCliShell(currentInputPreview, `● ${text}`);
    },
    stop(finalText = "") {
      active = false;
      if (finalText) {
        lastVoiceEvent = finalText;
      }
      renderCliShell(currentInputPreview);
    },
    active() {
      return active;
    },
  };
}

function clearTerminalLine() {
  process.stdout.write("\r");
  process.stdout.write(" ".repeat(120));
  process.stdout.write("\r");
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

function buildBox(title, content, width = 76, minRows = 4) {
  const innerWidth = width - 4;
  const titleLabel = ` ${title} `;
  const titlePad = Math.max(0, innerWidth - titleLabel.length);
  const top = `╔═${titleLabel}${"═".repeat(titlePad)}╗`;
  const bottom = `╚${"═".repeat(width - 2)}╝`;

  const textLines = wrapText(content, innerWidth).slice(0, 8);
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

function normalizeAsciiBlock(lines) {
  const cleaned = lines.map((line) => line.replace(/\s+$/g, ""));
  const nonEmpty = cleaned.filter((line) => line.trim().length > 0);
  if (!nonEmpty.length) return cleaned;

  const minIndent = Math.min(
    ...nonEmpty.map((line) => {
      const match = line.match(/^(\s*)/);
      return match ? match[1].length : 0;
    })
  );

  return cleaned.map((line) => line.slice(minIndent));
}

const IL_TITLE_ART = [
  "██╗██╗         █████╗ ███████╗███████╗██╗███████╗████████╗ █████╗ ███╗   ██╗████████╗",
  "██║██║        ██╔══██╗██╔════╝██╔════╝██║██╔════╝╚══██╔══╝██╔══██╗████╗  ██║╚══██╔══╝",
  "██║██║        ███████║███████╗███████╗██║███████╗   ██║   ███████║██╔██╗ ██║   ██║   ",
  "██║██║        ██╔══██║╚════██║╚════██║██║╚════██║   ██║   ██╔══██║██║╚██╗██║   ██║   ",
  "██║███████╗   ██║  ██║███████║███████║██║███████║   ██║   ██║  ██║██║ ╚████║   ██║   ",
  "╚═╝╚══════╝   ╚═╝  ╚═╝╚══════╝╚══════╝╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═══╝   ╚═╝   ",
];

const IL_BOT_ICON = [
  "                    █████████████████████████                    ",
  "                    █████████████████████████                    ",
  "                    ██████   ███████   ██████                    ",
  "                    ██████   ███████   ██████                    ",
  "          ███████████████████████████████████████████          ",
  "          ███████████████████████████████████████████          ",
  "                    █████████████████████████                    ",
  "                    █████████████████████████                    ",
  "                    ███   ███      ███    ███                    ",
  "                    ███   ███      ███    ███                    ",
];

function renderCliShell(inputValue = "", spinnerText = "") {
  const width = 100;
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
  const banner = [
    panelTop,
    ...IL_TITLE_ART.map((line) => `│${centerText(line, width - 2)}│`),
    panelBottom,
    "",
    ...IL_BOT_ICON,
    "",
    centerText(`Timestamp: ${now}`, width),
    "",
  ];

  const responseBox = buildBox("✦ RESPUESTA // IL ASSISTANT", lastBotResponse, width, 5);
  const statusText = waitingBotReply
    ? spinnerText || "Procesando respuesta del bot..."
    : "En espera. Escribe tu mensaje y presiona Enter.";
  const inputBox = buildBox("⌨ COMANDO", inputValue || " ", width, 3);
  const statusLine = `● Estado del nucleo: ${statusText}`;

  process.stdout.write("\x1Bc");
  [...banner, "", ...responseBox, "", ...inputBox, "", statusLine].forEach(
    (line) => console.log(line)
  );
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

async function tryOpenByDirectUrl(page) {
  await page.goto(TELEGRAM_CHAT_URL, { waitUntil: "networkidle2" });
  await page.waitForSelector("body");

  for (let i = 0; i < 12; i += 1) {
    if (await isChatOpen(page)) return true;
    await wait(500);
  }
  return false;
}

async function openBotChat(page, botUsername) {
  console.log("Abriendo chat directamente por URL:", TELEGRAM_CHAT_URL);
  const openedByUrl = await tryOpenByDirectUrl(page);
  if (openedByUrl) {
    console.log(`Chat abierto (via URL directa).`);
    return;
  }

  console.log("No se abrio el chat por URL. Intentando por buscador...");
  await page.goto(TELEGRAM_WEB_URL, { waitUntil: "networkidle2" });
  await page.waitForSelector("body");

  await page.waitForFunction(
    () => !!document.querySelector(".ChatList") || !!document.querySelector(".chat-list"),
    { timeout: 0 }
  );

  const searchSelectors = [
    'input[placeholder*="Search"]',
    'input[placeholder*="Buscar"]',
    ".SearchInput input",
    ".search-input-container input",
    "[contenteditable='true'][role='searchbox']",
  ];

  let foundSelector = null;
  for (const selector of searchSelectors) {
    if (await page.$(selector)) {
      foundSelector = selector;
      break;
    }
  }

  if (!foundSelector) {
    throw new Error("No se encontro el buscador de chats en Telegram Web.");
  }

  await page.click(foundSelector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(foundSelector, `@${botUsername.replace(/^@/, "")}`, { delay: 40 });
  await wait(1200);

  const opened = await page.evaluate((username) => {
    const normalized = username.replace(/^@/, "").toLowerCase();
    const rows = Array.from(document.querySelectorAll("[role='row'], .chatlist-chat"));
    for (const row of rows) {
      const text = (row.textContent || "").toLowerCase();
      if (text.includes(normalized)) {
        row.click();
        return true;
      }
    }
    return false;
  }, botUsername);

  if (!opened) {
    throw new Error(`No pude abrir el chat con ${botUsername}.`);
  }

  for (let i = 0; i < 6; i += 1) {
    if (await isChatOpen(page)) break;
    await wait(400);
  }

  if (!(await isChatOpen(page))) {
    throw new Error(`Se encontro ${botUsername}, pero no quedo abierto el chat.`);
  }
  console.log(`Chat abierto con ${botUsername}.`);
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
        dataMessageId || node.id || `fallback-${idx}-${(node.textContent || "").slice(0, 30)}`;

      const own =
        node.classList.contains("own") ||
        node.classList.contains("is-out") ||
        node.matches(".message-out, .is-outgoing");

      const text =
        node.querySelector(".message-text, .text-content, .translatable-message")
          ?.textContent?.trim() || "";

      const hasVoice =
        !!node.querySelector("audio") ||
        !!node.querySelector(".voice-message, .media-inner audio, .is-voice, .Audio, .MediaVoice");

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

    function findPlayTarget(node) {
      const selectors = [
        "button[aria-label*='Play' i]",
        "button[aria-label*='Reproducir' i]",
        "button[aria-label*='Voice' i]",
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
      ];
      for (const sel of selectors) {
        const el = node.querySelector(sel);
        if (el) return el;
      }
      const container =
        node.matches?.(".Audio, .voice-message, .is-voice, .media-inner, .MediaVoice")
          ? node
          : node.querySelector?.(".Audio, .voice-message, .is-voice, .media-inner, .MediaVoice");
      if (container) {
        const btn = container.querySelector("button, [role='button']");
        if (btn) return btn;
      }
      return null;
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

    function tryPlay(messageNode) {
      if (messageNode.dataset && messageNode.dataset.tgPlayedVoice === "1") return false;
      const id =
        messageNode.getAttribute("data-message-id") ||
        messageNode.getAttribute("data-mid") ||
        messageNode.id ||
        "";
      if (id && window.__tgPlayedIds.has(id)) return false;

      const target = findPlayTarget(messageNode);
      if (!target) return false;

      messageNode.scrollIntoView?.({ block: "center", behavior: "auto" });
      fireClick(target);

      const audio = messageNode.querySelector("audio");
      if (audio) {
        try {
          audio.muted = false;
          audio.volume = 1;
          audio.play().catch(() => {});
        } catch (_) {}
      }

      if (id) window.__tgPlayedIds.add(id);
      if (messageNode.dataset) messageNode.dataset.tgPlayedVoice = "1";
      return true;
    }

    // Marca historico como procesado para no reproducir audios antiguos al arrancar.
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

async function installAudioInterceptor(page) {
  if (!SYSTEM_PLAYER) return;

  const client = await page.target().createCDPSession();
  await client.send("Network.enable");

  client.on("Network.responseReceived", async (event) => {
    try {
      const { requestId, response } = event;
      const url = response.url || "";
      const headers = response.headers || {};
      const ct = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();

      const looksAudio =
        ct.includes("audio/") ||
        ct.includes("opus") ||
        /\.(ogg|oga|opus|mp3|m4a|wav)(\?|$)/i.test(url);

      const looksTelegramCDN =
        /telegram|cdn|web\.telegram\.org|t\.me/i.test(url) || url.startsWith("blob:");

      if (!looksAudio || !looksTelegramCDN) return;
      if (playedAudioUrls.has(url)) return;
      playedAudioUrls.add(url);

      const body = await client
        .send("Network.getResponseBody", { requestId })
        .catch(() => null);
      if (!body || !body.body) return;

      const buf = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
      const file = path.join(os.tmpdir(), `tg-voice-${Date.now()}.ogg`);
      fs.writeFileSync(file, buf);

      console.log(`Reproduciendo audio en tu PC (${SYSTEM_PLAYER.bin})...`);
      const child = spawn(SYSTEM_PLAYER.bin, [...SYSTEM_PLAYER.args, file], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();

      setTimeout(() => {
        fs.unlink(file, () => {});
      }, 5 * 60 * 1000);
    } catch (_) {
      // ignore
    }
  });
}

function startVoiceWakeLoop({ submitMessage, spinner }) {
  if (!VOICE_WAKE_ENABLED) return () => {};
  if (!GROQ_API_KEY) {
    lastVoiceEvent = "VOICE_WAKE activo pero falta GROQ_API_KEY.";
    renderCliShell(currentInputPreview);
    return () => {};
  }

  let stopRequested = false;
  let wakeDetected = false;
  let activeWakeWord = "";
  let silenceCounter = 0;
  let collectedChunks = [];

  lastVoiceEvent = `Voz activa. Wake words: ${WAKE_WORDS.join(", ")}`;
  renderCliShell(currentInputPreview);

  (async () => {
    while (!stopRequested) {
      const tmpFile = path.join(os.tmpdir(), `il-voice-${Date.now()}.wav`);
      try {
        await recordVoiceChunk(tmpFile, VOICE_CHUNK_SECONDS);
        const transcriptRaw = await transcribeWithGroq(tmpFile);
        const transcript = normalizeForMatch(transcriptRaw);
        if (!wakeDetected) {
          lastVoiceEvent = transcriptRaw
            ? `Oyendo (esperando wake): ${transcriptRaw}`
            : "Oyendo (esperando wake): ...";
          renderCliShell(currentInputPreview);
        }

        if (!wakeDetected) {
          const matchedWake = findWakeWordInTranscript(transcript);
          if (matchedWake) {
            wakeDetected = true;
            activeWakeWord = matchedWake;
            silenceCounter = 0;
            collectedChunks = [];
            lastVoiceEvent = `Wake detectado (${matchedWake}). Te escucho...`;
            renderCliShell(currentInputPreview);

            const wakeIndex = transcript.indexOf(matchedWake);
            const afterWake =
              wakeIndex >= 0 ? transcript.slice(wakeIndex + matchedWake.length).trim() : "";
            if (afterWake) {
              collectedChunks.push(afterWake);
            }
          }
          continue;
        }

        if (waitingBotReply) continue;

        if (transcript.length > 0) {
          silenceCounter = 0;
          collectedChunks.push(transcript);
          lastVoiceEvent = `Escuchando: ${transcriptRaw}`;
          renderCliShell(currentInputPreview);
        } else {
          silenceCounter += 1;
        }

        if (silenceCounter >= VOICE_SILENCE_CHUNKS_TO_SEND) {
          const finalMessage = collectedChunks.join(" ").trim();
          wakeDetected = false;
          silenceCounter = 0;
          collectedChunks = [];

          if (finalMessage) {
            lastVoiceEvent = `Enviando voz: ${finalMessage}`;
            renderCliShell(currentInputPreview);
            await submitMessage(finalMessage, { source: "voice", spinner });
            lastVoiceEvent = `Voz activa. Wake words: ${WAKE_WORDS.join(", ")}`;
            renderCliShell(currentInputPreview);
          } else {
            lastVoiceEvent = `No detecte texto tras "${activeWakeWord || "wake word"}".`;
            renderCliShell(currentInputPreview);
          }
          activeWakeWord = "";
        }
      } catch (err) {
        lastVoiceEvent = `Error voz: ${err.message}`;
        renderCliShell(currentInputPreview);
        await wait(1000);
      } finally {
        fs.unlink(tmpFile, () => {});
      }
    }
  })().catch(() => {});

  return () => {
    stopRequested = true;
  };
}

function startCli(onMessage) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "mensaje > ",
  });
  rl.prompt();
  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    if (text === "/salir") return rl.close();
    currentInputPreview = text;
    renderCliShell(currentInputPreview);
    try {
      await onMessage(text);
    } catch (err) {
      console.error("Error al enviar:", err.message);
    }
    if (!waitingBotReply) rl.prompt();
  });
  rl.on("close", () => {
    console.log("Cerrando CLI...");
    process.exit(0);
  });
  return rl;
}

async function main() {
  await ensureSessionDir();
  const spinner = createSpinner();

  if (SYSTEM_PLAYER && ENABLE_SYSTEM_AUDIO_FALLBACK) {
    console.log(`Reproductor de audio de sistema detectado: ${SYSTEM_PLAYER.bin}`);
    console.log("Audio local ACTIVADO (ffplay/mpv/paplay).");
    if (HEADLESS) {
      console.log("Modo headless: la reproduccion se hara por audio local.");
    } else {
      console.log("Modo visible: puede duplicar si Telegram tambien reproduce.");
    }
  } else if (SYSTEM_PLAYER) {
    console.log("Fallback de audio local desactivado. Solo se reproducira desde Telegram Web.");
  } else {
    console.log(
      "No se detecto ffplay/mpv/paplay. Solo se intentara reproducir en el navegador."
    );
  }

  const browser = await puppeteer.launch({
    headless: HEADLESS,
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
    if (ENABLE_SYSTEM_AUDIO_FALLBACK) {
      await installAudioInterceptor(page);
    }
    await openBotChat(page, BOT_USERNAME);
    if (!HEADLESS) await page.bringToFront();

    await installAutoplayObserver(page);
    page.on("framenavigated", () => installAutoplayObserver(page).catch(() => {}));
    await seedSeenMessages(page);

    lastBotResponse = "Sistema listo. Te escucho.";
    lastVoiceEvent = HEADLESS
      ? "Modo headless activo. Audio por reproductor local."
      : "Modo visible activo. Audio desde Telegram Web.";
    renderCliShell(currentInputPreview);

    const submitMessage = async (text, { source = "cli", spinner: localSpinner } = {}) => {
      if (!text || waitingBotReply) return;
      sessionArmed = true;
      waitingBotReply = true;
      if (source === "cli") rl.pause();
      lastBotResponse = "Enviando mensaje...";
      renderCliShell(currentInputPreview);
      localSpinner.start("Esperando respuesta del bot...");
      try {
        await sendMessage(page, text);
      } catch (err) {
        waitingBotReply = false;
        lastBotResponse = "Error al enviar mensaje.";
        localSpinner.stop();
        if (source === "cli") {
          rl.resume();
          rl.prompt();
        }
        throw err;
      }
    };

    const rl = startCli(async (text) => {
      await submitMessage(text, { source: "cli", spinner });
    });

    setInterval(async () => {
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
            lastBotResponse = "[mensaje de voz]";
            lastVoiceEvent = "Mensaje de voz recibido y procesado.";
          }
          currentInputPreview = "";
          renderCliShell(currentInputPreview);
          printedAny = true;
        }
        if (printedAny) rl.prompt();
      } catch (err) {
        // silencioso para no spamear
      }
    }, POLL_INTERVAL_MS);

  } catch (err) {
    spinner.stop();
    console.error("Fallo:", err.message);
    await browser.close();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

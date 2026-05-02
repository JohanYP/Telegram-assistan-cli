# Telegram CLI Bot (Puppeteer)

Proyecto base para hablar con un bot de Telegram desde terminal, usando Telegram Web automatizado con Puppeteer.

## Que hace este MVP

- Abre Telegram Web en Chromium.
- Te deja escribir mensajes en la terminal y los envia al bot.
- Muestra en terminal las respuestas de texto del bot.
- Detecta mensajes de voz entrantes e intenta reproducirlos automaticamente en el navegador.

## Requisitos

- Node.js 18+
- Linux con audio habilitado

## Instalacion

```bash
npm install
```

## Uso

Por defecto abre directamente este chat:

```bash
https://web.telegram.org/a/#8489015629
```

Y usa como username por defecto: `IL_assistantbot`.

Ejecucion minima:

```bash
npm start
```

Opcional (sobrescribir chat/url):

```bash
TELEGRAM_CHAT_URL="https://web.telegram.org/a/#8489015629" TELEGRAM_BOT_USERNAME=IL_assistantbot npm start
```

## Flujo de primer arranque

1. Se abrira Telegram Web.
2. Inicia sesion con QR si hace falta.
3. El script buscara y abrira el chat del bot.
4. Escribe en terminal: `Tu mensaje > hola`.
5. Para salir: `/salir`.

## Notas importantes

- La sesion se guarda en `.telegram-session`, para no loguearte cada vez.
- La reproduccion de voz depende de cambios UI de Telegram Web. Si Telegram cambia clases internas, puede requerir ajuste.
- Este MVP reproduce audios en el navegador controlado por Puppeteer (no descarga ni convierte archivos de voz localmente).
- Para mejorar autoplay, Chromium se lanza con `--autoplay-policy=no-user-gesture-required`.

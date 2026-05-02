# Telegram CLI Bot (Puppeteer)

CLI para hablar con cualquier chat o bot de Telegram desde la terminal, automatizando Telegram Web con Puppeteer.

## Que hace

- En el primer arranque abre Chromium **visible** para que escanees el QR de Telegram Web.
- Lista tus chats en la terminal y te deja elegir uno por numero.
- Guarda esa eleccion para que en arranques siguientes el chat se abra automaticamente.
- Te deja escribir mensajes en la terminal y los envia al chat seleccionado.
- Muestra en terminal las respuestas de texto.
- Detecta mensajes de voz entrantes y los reproduce automaticamente (en el navegador o, si estas en headless, vuelca el audio a `ffplay`/`mpv`/`paplay`).
- Comandos especiales:
  - `/logout` — cierra sesion, borra cookies + chat guardado y reinicia el flujo (login + seleccion de chat).
  - `/salir` — cierra el CLI.
- Interfaz responsiva al tamano del terminal (banner compacto y panel de bot opcional segun ancho/alto).

## Requisitos

- Node.js 18+
- Linux con audio habilitado
- (Opcional, para audio en modo headless) `ffplay`, `mpv` o `paplay` instalado.

## Instalacion

```bash
npm install
```

## Uso

```bash
npm start
```

Primer arranque:

1. Se abrira Chromium con Telegram Web.
2. Escanea el QR para iniciar sesion.
3. Espera a que aparezca tu lista de chats.
4. En la terminal veras los chats numerados. Escribe el numero del chat que quieras abrir.
5. La eleccion se guarda en `.telegram-session/chat-config.json`.

Arranques siguientes:

1. Se restaura la sesion guardada y se abre directamente el chat elegido (en headless por defecto).
2. Escribe en terminal: `mensaje > hola` y presiona Enter.

Para cambiar de chat o de cuenta:

```
/logout
```

Esto borra `.telegram-session/` (cookies + chat guardado) y vuelve a empezar con el QR + seleccion de chat.

## Variables de entorno opcionales

- `HEADLESS=0` — fuerza Chromium visible siempre.
- `HEADLESS=1` — fuerza headless siempre (incluso en el primer arranque, no recomendado).
- `ENABLE_SYSTEM_AUDIO_FALLBACK=1` — fuerza el reproductor local aunque estes en modo visible.
- `ENABLE_SYSTEM_AUDIO_FALLBACK=0` — desactiva el reproductor local incluso en headless.

## Notas

- La sesion se guarda en `.telegram-session/`, junto con el chat seleccionado en `.telegram-session/chat-config.json`.
- La reproduccion automatica de voz depende de selectores internos de Telegram Web. Si Telegram cambia clases, puede requerir ajuste.
- Chromium se lanza con `--autoplay-policy=no-user-gesture-required` para mejorar el autoplay de audios.

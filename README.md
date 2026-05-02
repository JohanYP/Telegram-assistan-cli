# tgvoice

Cliente CLI para Linux que te deja hablar con tu propio bot de Telegram desde la terminal:
- Escribes texto en el prompt y se envía al bot.
- Cuando el bot responde con texto, aparece en el chat. Si responde con audio, se reproduce solo en tus altavoces.
- Si dices la **wake word** (por defecto `hey jarvis`), graba lo que dices y se lo manda al bot como voice message.

> **Nota técnica:** los bots de Telegram no pueden hablarse a sí mismos, así que este cliente se conecta como **tu cuenta de usuario** (vía MTProto), no como bot.

## 1. Pre-requisitos

Python **3.10 – 3.12** (en 3.13 todavía no hay wheels de `tflite-runtime`, dep transitiva de `openwakeword`).

Debian/Ubuntu:
```bash
sudo apt update
sudo apt install -y ffmpeg portaudio19-dev python3.12-venv
```

Arch (PipeWire ya viene compatible con PortAudio):
```bash
sudo pacman -Syu --needed ffmpeg portaudio git base-devel
# Si tu `python` es 3.13, instala 3.12 desde AUR (`yay -S python312`)
# o usa `uv` (https://astral.sh/uv) para gestionar la versión.
```

Sacar credenciales de Telegram (una vez):
1. Entra en https://my.telegram.org con tu número.
2. Ve a **API development tools**.
3. Crea una app cualquiera (el nombre da igual). Apunta `api_id` y `api_hash`.

## 2. Instalación

```bash
cd Telegram-assistan-cli
python3 -m venv .venv      # o: uv venv --python 3.12 .venv
source .venv/bin/activate
pip install -e .
pip install --no-deps openwakeword
```

> El segundo paso (`--no-deps`) es necesario porque `openwakeword` declara `tflite-runtime` como dep, y este último no tiene wheels para Python ≥ 3.12. Como en este proyecto fijamos `inference_framework="onnx"`, `tflite-runtime` no se usa en runtime; las demás deps de openwakeword (`onnxruntime`, `scipy`, `scikit-learn`, `tqdm`, `requests`) ya se instalan vía nuestro `pyproject.toml`.

## 3. Configuración

```bash
cp .env.example .env
$EDITOR .env
```

Completa:
- `API_ID` y `API_HASH` (paso 1).
- `BOT_USERNAME` con el `@username` de tu bot.
- `WAKE_BACKEND` y `WAKE_WORD`:
  - `WAKE_BACKEND=openwakeword` (default) — rápido y preciso, pero solo frases pre-entrenadas: `alexa`, `hey_jarvis`, `hey_mycroft`, `hey_rhasspy`.
  - `WAKE_BACKEND=vosk` — reconoce **cualquier frase** que pongas en `WAKE_WORD` (p. ej. `hey il`, `oye lasis`). Descarga un modelo de ~40 MB la primera vez. `VOSK_LANG=es` o `en`.

## 4. Uso

Con el venv activado:
```bash
tgvoice
# o equivalente:
python -m tgvoice
```

Para ejecutarlo desde cualquier directorio sin activar el venv, haz un symlink al binario que generó pip:
```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/.venv/bin/tgvoice" ~/.local/bin/tgvoice
# Asegúrate de tener ~/.local/bin en PATH (en Arch suele estarlo).
```
A partir de ahí, `tgvoice` funciona desde donde sea — el shebang del script apunta al Python del venv, así que arrastra todas las dependencias correctas.

La primera vez te pedirá tu número de teléfono y un código que te llega por Telegram. Se guarda una sesión en `tgvoice.session` para que los siguientes arranques sean instantáneos.

A partir de ahí:
- Escribe en el prompt `›` para enviar texto.
- Di la wake word para grabar y enviar audio.
- Las respuestas del bot aparecen automáticamente; las de audio se reproducen solas.
- `Esc` cancela la grabación en curso.
- `Ctrl+C` para salir, `Ctrl+L` limpia el chat.

### Cancelar grabación con la ventana en background

Si tienes la ventana minimizada o sin foco, `Esc` no llega al proceso. Para esto se incluye el comando `tgvoice-cancel`, que manda `SIGUSR1` al `tgvoice` corriendo y aborta la grabación. Bindéalo en tu DE como atajo global:

- **Hyprland** (`~/.config/hypr/hyprland.conf`):
  ```
  bind = ALT, X, exec, tgvoice-cancel
  ```
- **KDE**: System Settings → Shortcuts → Custom Shortcuts → Edit → New → Global Shortcut → Command/URL → `tgvoice-cancel`.
- **GNOME**: Settings → Keyboard → Custom Shortcuts → `+` → Command: `tgvoice-cancel`, asigna la tecla.
- **i3/sway** (`~/.config/i3/config` o `~/.config/sway/config`):
  ```
  bindsym Mod1+x exec tgvoice-cancel
  ```

Si `tgvoice-cancel` no aparece en `PATH`, usa la ruta absoluta del binario (típicamente `~/.local/bin/tgvoice-cancel` si hiciste el symlink, o `~/proyecto/.venv/bin/tgvoice-cancel` si no).

## 5. Solución de problemas

- **No se oye nada / `ffplay: command not found`**: instala `ffmpeg`.
- **`PortAudioError`**: instala `portaudio19-dev` y reinstala `pip install --force-reinstall sounddevice`.
- **No detecta el micrófono correcto**: lista dispositivos con `python -c "import sounddevice; print(sounddevice.query_devices())"` y pon el índice en `INPUT_DEVICE` del `.env`.
- **La wake word casi no se activa**: baja `WAKE_THRESHOLD` (por ejemplo a `0.3`).
- **Se activa con cualquier ruido**: súbelo (`0.6`–`0.7`).
- **Logs**: están en `.cache/tgvoice.log`.

## 6. Estructura

```
tgvoice/
├── pyproject.toml
├── .env.example
├── README.md
└── src/tgvoice/
    ├── __main__.py       # entry point + orquestación
    ├── config.py         # carga .env
    ├── telegram.py       # Telethon (login, envío, listener)
    ├── wake_word.py      # openWakeWord
    ├── recorder.py       # captura mic con VAD
    ├── encoder.py        # WAV -> OGG/Opus (ffmpeg)
    ├── player.py         # cola de reproducción (ffplay)
    └── tui.py            # rich + prompt_toolkit
```

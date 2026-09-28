# 🎙️ Meeting Recorder

Graba tus reuniones **desde cualquier aplicación** (Google Meet, Microsoft Teams,
Zoom, TeamViewer, Discord, Slack, una llamada de WhatsApp Desktop…), las
**transcribe en tu PC** y genera con IA (Claude) un **resumen con lo más
importante, las decisiones y los puntos pendientes**.

## ¿Cómo funciona?

```
 Audio del sistema (lo que oyes) ─┐
                                  ├─► reunion.flac ─► Whisper (local) ─► transcripcion.txt ─► Claude ─► resumen.md
 Tu micrófono (lo que dices) ─────┘
```

1. **Grabación independiente de la app**: en lugar de integrarse con cada
   plataforma, captura la salida de audio del sistema (*loopback*) junto con tu
   micrófono. Todo lo que oyes y dices queda grabado, sin bots en la llamada.
2. **Transcripción local** con [faster-whisper](https://github.com/SYSTRAN/faster-whisper):
   el audio nunca sale de tu ordenador. Detecta el idioma automáticamente.
3. **Resumen con Claude**: solo se envía el *texto* de la transcripción a la API
   de Anthropic, que devuelve un informe en Markdown con:
   - Resumen ejecutivo
   - Temas tratados
   - Decisiones tomadas
   - **Tabla de tareas pendientes** (tarea, responsable, fecha límite, minuto)
   - Preguntas abiertas y riesgos
   - Próximos pasos

Cada reunión se guarda en su propia carpeta (por defecto `~/Reuniones`):

```
Reuniones/
└── 2026-09-28_10-00_sprint-review/
    ├── reunion.flac        # audio mezclado (sistema + micrófono)
    ├── transcripcion.txt   # [00:01:23] texto…
    └── resumen.md          # informe final
```

## Instalación

Requisitos: **Python 3.10+**.

```bash
git clone https://github.com/carlosalean/recorder-meeting.git
cd recorder-meeting
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS / Linux:
source .venv/bin/activate

pip install -e .
```

### Clave de la API de Claude

Crea una clave en <https://console.anthropic.com/> y guárdala como variable de
entorno:

```powershell
# Windows (PowerShell) – permanente; abre una terminal nueva después
setx ANTHROPIC_API_KEY "sk-ant-..."
```

```bash
# macOS / Linux – añádelo a ~/.bashrc o ~/.zshrc
export ANTHROPIC_API_KEY="sk-ant-..."
```

> Si al resumir aparece el error *"This API key is not scoped to a workspace"*,
> o bien crea la clave dentro de un workspace (Console → Workspaces → tu
> workspace → API keys), o bien indica el workspace con otra variable:
>
> ```powershell
> setx ANTHROPIC_WORKSPACE_ID "wrkspc_..."
> ```

### Notas por sistema operativo

| Sistema | Captura del audio del sistema |
|---|---|
| **Windows 10/11** | Funciona directamente (WASAPI loopback). |
| **Linux** | Funciona con PulseAudio o PipeWire (usa el *monitor* de la salida). |
| **macOS** | macOS no permite loopback nativo: instala [BlackHole](https://github.com/ExistentialAudio/BlackHole), crea un *dispositivo de salida múltiple* (altavoces + BlackHole) en «Configuración de Audio MIDI» y usa `--altavoz BlackHole`. |

## Uso

### Acceso directo en Windows (recomendado)

Después de instalar, haz **doble clic en `crear-acceso-directo.bat`** (en la
carpeta del proyecto). Se crea el icono **«Grabador de reuniones»** en el
Escritorio y en el menú Inicio; ábrelo como cualquier otro programa (sin
ventana de consola). Para tenerlo siempre a mano: clic derecho en el icono →
*Anclar a la barra de tareas*.

Si algo falla estando abierto desde el acceso directo, los mensajes se guardan
en `~/Reuniones/meeting-recorder.log`.

### Interfaz gráfica (lo más sencillo)

```bash
meeting-recorder          # o: meeting-recorder gui
```

Escribe un título (opcional), pulsa **● Empezar a grabar** al comenzar la
reunión y **■ Detener y resumir** al terminar. Al acabar verás el resumen en la
ventana y el botón **Abrir carpeta** te lleva a los archivos.

### Línea de comandos

```bash
# Grabar (Ctrl+C para terminar); al parar transcribe y resume automáticamente
meeting-recorder grabar -t "Sprint review"

# Solo el audio del sistema (sin tu micrófono)
meeting-recorder grabar --sin-microfono

# Ver dispositivos disponibles y elegir uno concreto
meeting-recorder dispositivos
meeting-recorder grabar --mic "Headset" --altavoz "Auriculares"

# Procesar un audio que ya tengas (mp3, m4a, mp4, wav…) o reintentar una carpeta
meeting-recorder procesar grabacion.mp4
meeting-recorder procesar ~/Reuniones/2026-09-28_10-00_sprint-review

# Volver a resumir una transcripción existente
meeting-recorder resumir ~/Reuniones/.../transcripcion.txt
```

Opciones de procesamiento (en `grabar`, `procesar` y `resumir`):

| Opción | Descripción | Defecto |
|---|---|---|
| `--modelo-whisper` | `tiny`, `base`, `small`, `medium`, `large-v3`, `turbo` | `small` |
| `--idioma-audio` | Idioma hablado (`es`, `en`…) | autodetección |
| `--idioma-resumen` | Idioma del informe | `español` |
| `--modelo-ia` | Modelo de Claude | `claude-opus-5` |

**¿Qué modelo de Whisper elegir?** `small` va bien en cualquier portátil. Si
tienes GPU NVIDIA (con CUDA) o un PC potente, `turbo` o `large-v3` dan una
transcripción notablemente mejor. El modelo se descarga automáticamente la
primera vez.

Variables de entorno opcionales:

- `MEETING_RECORDER_DIR`: carpeta donde guardar las reuniones.
- `MEETING_RECORDER_MODEL`: modelo de Claude por defecto.

## Consejos

- **Usa auriculares**: si usas altavoces, el micrófono vuelve a captar la voz de
  los demás y se oye con eco en la grabación.
- Si el resumen falla (sin conexión, sin clave…), el audio y la transcripción se
  conservan: ejecuta `meeting-recorder procesar <carpeta>` para reintentar sin
  volver a transcribir.
- Una hora de reunión ocupa unos 50-70 MB en FLAC.

## ⚖️ Aviso legal

Grabar conversaciones puede requerir el **consentimiento de los participantes**
según tu país y las políticas de tu empresa. Informa siempre de que la reunión
se está grabando.

## Desarrollo

```bash
pip install -e ".[dev]"
pytest
```

Estructura:

| Archivo | Responsabilidad |
|---|---|
| `meeting_recorder/audio.py` | Captura loopback + micrófono en hilos, alineación y mezcla |
| `meeting_recorder/transcribe.py` | Transcripción local con faster-whisper |
| `meeting_recorder/summarize.py` | Prompt y llamada a Claude |
| `meeting_recorder/pipeline.py` | Orquesta transcripción → resumen y gestiona carpetas |
| `meeting_recorder/cli.py` / `gui.py` | Interfaces de línea de comandos y gráfica |

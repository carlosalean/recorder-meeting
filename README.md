# 🎙️ Meeting Recorder

Graba tus reuniones **desde cualquier aplicación** (Google Meet, Microsoft Teams,
Zoom, TeamViewer, Discord, Slack, una llamada de WhatsApp Desktop…), las
**transcribe en tu PC** y genera con IA (Claude) un **resumen con lo más
importante, las decisiones y los puntos pendientes**.

El repositorio tiene dos partes que funcionan juntas:

| Parte | Qué hace | Tecnología |
|---|---|---|
| **Grabadora** (`meeting_recorder/`) | Graba, transcribe y resume cada reunión en tu PC | Python |
| **Panel de seguimiento** (`web/`) | Clientes → proyectos → temas → tareas, actualizados automáticamente con cada reunión | Next.js + PostgreSQL en Docker |

➡️ Para el panel, ve directamente a [Panel de seguimiento de proyectos](#-panel-de-seguimiento-de-proyectos-docker).

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

---

## 📋 Panel de seguimiento de proyectos (Docker)

Aplicación web para llevar el control de **clientes, proyectos, temas y tareas**
alimentada por las transcripciones de las reuniones. Cada vez que asignas una
reunión a un proyecto, Claude compara la transcripción con el estado actual del
proyecto y:

- crea los **temas** y **tareas** nuevos (con responsable y fecha límite),
- **actualiza el estado** de las tareas existentes (en progreso, bloqueada,
  completada, cancelada) y los cambios de responsable o fecha,
- **cierra** (o reabre) los temas que se dan por resueltos,
- guarda un **historial** de cada cambio con la cita de la transcripción que lo justifica,
- mantiene una descripción de **de qué va cada proyecto**,
- identifica a las **personas** (stakeholders): quiénes son, para qué empresa trabajan,
  su cargo y datos de contacto si se mencionan, su papel en cada proyecto y las
  acciones que tienen asignadas.

En una sola pantalla (**Panel**) ves todos los proyectos con sus temas y las
tareas de cada tema, sus responsables, fechas y pendientes, con filtros por
cliente, proyecto y responsable. Todo se puede corregir a mano.

```
 Grabadora ──► C:\Users\<tú>\Reuniones\<reunión>\transcripcion.txt
                        │  (carpeta montada en Docker, solo lectura)
                        ▼
 Panel web ── «Asignar a proyecto» ──► Claude analiza ──► temas / tareas / estados actualizados
```

### Puesta en marcha

Requisitos: [Docker Desktop](https://www.docker.com/products/docker-desktop/).

1. En la carpeta del proyecto, copia el archivo de configuración:
   ```powershell
   cd C:\TRABAJO\RECORDER-MEETING
   copy .env.example .env
   notepad .env
   ```
2. Rellena en `.env`:
   - `ANTHROPIC_API_KEY`: tu clave de Claude.
   - `REUNIONES_DIR`: la carpeta de la grabadora, con barras `/`
     (p. ej. `C:/Users/carlo/Reuniones`).
   - `OWNER_NAME` / `OWNER_ROLE`: tu nombre y perfil, para que la IA sepa quién graba.
   - `TZ`: tu zona horaria (p. ej. `Europe/Madrid`, `America/Bogota`, `America/Mexico_City`).
3. Arranca todo:
   ```powershell
   docker compose up -d --build
   ```
4. Abre **http://localhost:3000**.

La base de datos se guarda en un volumen de Docker (`pgdata`), así que los datos
se conservan aunque pares o actualices los contenedores.

### Uso

1. **Clientes** → crea el cliente.
2. **Proyectos** → crea el proyecto (la descripción ayuda a la IA a entender el contexto).
3. Asigna reuniones al proyecto:
   - **Grabaciones**: lista las reuniones de la grabadora; elige el proyecto y pulsa *Asignar*.
   - En la página del proyecto: *Desde la grabadora*, o *Pegar o subir una
     transcripción* (para reuniones grabadas con otra herramienta).
   Opcionalmente, despliega **Participantes** para marcar quién estuvo en la reunión
   o escribir personas nuevas (`Nombre, empresa, cargo`, una por línea). Si no lo
   indicas, la IA las deduce de la conversación.
4. En unos segundos (según la longitud) verás los temas y tareas actualizados.
   Asigna las reuniones **en orden cronológico** para que los estados evolucionen bien.
5. **Personas**: listado lateral agrupado por empresa, con buscador. Al pulsar en
   una persona ves quién es, sus datos de contacto, en qué proyectos participa (de
   qué va cada uno y cuál es su papel), sus acciones y las reuniones en las que
   estuvo. En cada ficha puedes completar el contexto: departamento, **nivel
   jerárquico**, **influencia en las decisiones** (decisor, influyente…), **a quién
   reporta** (con su equipo en el organigrama), LinkedIn y **notas importantes**.
   Todo esto también lo recibe la IA al analizar las reuniones.
   - **Unificar duplicados**: la app detecta fichas que parecen la misma persona
     (mismo nombre, «Ana» / «Ana García», errores de transcripción, mismo email).
     Eliges las fichas, comparas sus datos, decides qué conservar y añades
     contexto. Los demás nombres quedan como **alias**, para que la IA la reconozca
     en próximas reuniones y no vuelva a duplicarla.
6. **Panel**: la vista general. Puedes cambiar el estado de una tarea directamente
   desde el desplegable; en la página del proyecto (✎) puedes editar o borrar
   temas y tareas y añadirlos a mano.

Si el análisis falla (sin conexión, clave incorrecta…), la reunión queda marcada
con **Error** y un botón **Reintentar**.

### Comandos útiles

```powershell
docker compose ps                 # estado de los contenedores
docker compose logs -f web        # ver el log de la aplicación
docker compose down               # parar (los datos se conservan)
git pull; docker compose up -d --build   # actualizar a la última versión
```

La base de datos también es accesible desde tu PC (DBeaver, pgAdmin…) en
`localhost:5433`, base de datos `meetings`, usuario `meetings`, contraseña la de
`POSTGRES_PASSWORD` (por defecto `meetings`).

### Si algo falla

- **La página muestra un error o no carga**: comprueba `docker compose ps` (el
  servicio `db` debe estar *healthy*) y mira `docker compose logs web`. La app
  reintenta la conexión con la base de datos sola; basta con recargar.
- **Error de contraseña en el log** (`password authentication failed`): cambiaste
  `POSTGRES_PASSWORD` después de crear la base de datos. Vuelve a la contraseña
  anterior o, si no te importa perder los datos, bórrala con
  `docker compose down -v` y arranca de nuevo.
- **La página Grabaciones no encuentra la carpeta**: revisa `REUNIONES_DIR` en
  `.env` (con barras `/`) y ejecuta `docker compose up -d` para aplicarlo.

### Desarrollo del panel

```bash
cd web
npm install
docker compose up -d db                     # solo la base de datos
DATABASE_URL=postgres://meetings:meetings@localhost:5433/meetings REUNIONES_DIR=~/Reuniones npm run dev
TEST_DATABASE_URL=postgres://...  npm test  # los tests usan (y vacían) esa base de datos
```

| Archivo | Responsabilidad |
|---|---|
| `web/src/lib/migrations.ts` | Esquema de PostgreSQL (se aplica solo al arrancar) |
| `web/src/lib/analysis.ts` | Prompt y llamada a Claude con salida estructurada |
| `web/src/lib/tracking.ts` | Aplica el resultado de la IA a temas/tareas y registra el historial |
| `web/src/lib/people.ts` | Alta, actualización y resolución de personas (responsables, participantes) |
| `web/src/lib/recordings.ts` | Lee las carpetas de la grabadora |
| `web/src/app/actions.ts` | Acciones del servidor (crear, editar, asignar reuniones…) |
| `web/src/app/**/page.tsx` | Pantallas: panel, proyectos, clientes, grabaciones, reunión |

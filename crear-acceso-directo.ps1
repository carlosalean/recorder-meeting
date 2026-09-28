# Crea accesos directos a "Grabador de reuniones" en el Escritorio y en el menú Inicio.
# Uso: doble clic en crear-acceso-directo.bat (o ejecutar este script en PowerShell).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonw = Join-Path $root ".venv\Scripts\pythonw.exe"
$icon = Join-Path $root "meeting_recorder\assets\icon.ico"

if (-not (Test-Path $pythonw)) {
    Write-Host "No se encuentra el entorno virtual en $root\.venv" -ForegroundColor Red
    Write-Host "Primero instala la app:  python -m venv .venv ; .venv\Scripts\pip install -e ."
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$targets = @(
    [Environment]::GetFolderPath("Desktop"),
    (Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs")
)

foreach ($dir in $targets) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "Grabador de reuniones.lnk"))
    $lnk.TargetPath = $pythonw
    $lnk.Arguments = "-m meeting_recorder.gui"
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = $icon
    $lnk.Description = "Graba, transcribe y resume tus reuniones"
    $lnk.Save()
    Write-Host "Acceso directo creado en: $dir" -ForegroundColor Green
}

Write-Host ""
Write-Host "Listo. Abre 'Grabador de reuniones' desde el Escritorio o el menu Inicio."
Write-Host "Para anclarlo a la barra de tareas: clic derecho en el icono > 'Anclar a la barra de tareas'."

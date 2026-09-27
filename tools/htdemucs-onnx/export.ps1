# Export htdemucs.onnx, the model Stem Separation installs, into the folder
# named, on Windows (PowerShell):
#
#     powershell -ExecutionPolicy Bypass -File tools\htdemucs-onnx\export.ps1              # into the repo's model\
#     powershell -ExecutionPolicy Bypass -File tools\htdemucs-onnx\export.ps1 $HOME\Models # anywhere else
#
# Makes a Python venv beside this script (.venv, ~1 GB), installs
# requirements.txt into it, downloads Meta's htdemucs weights (~80 MB, into
# PyTorch's cache, %USERPROFILE%\.cache\torch) and writes
# <folder>\htdemucs.onnx (~300 MB). Running it again reuses the venv and the
# weights. The weights are for research and personal use only: see README.md.
param(
  # The repo's model\ if none, where the Desktop App and `pnpm dev` look first.
  [string]$Out = (Join-Path $PSScriptRoot "..\..\model")
)
$ErrorActionPreference = "Stop"
# `~` and a relative folder as PowerShell means them: -File passes them
# through unexpanded, so a bare `~\Models` would otherwise be a folder named ~.
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)

$here = $PSScriptRoot
$venv = Join-Path $here ".venv"
$python = Join-Path $venv "Scripts\python.exe"

# Stops if a native command fails, which $ErrorActionPreference doesn't.
function Check($what) {
  if ($LASTEXITCODE -ne 0) { Write-Error "$what failed (exit code $LASTEXITCODE)." }
}

if (-not (Test-Path $python)) {
  Write-Host "Making a Python venv in $venv..."
  # The py launcher, which python.org's installer adds; else python on the PATH.
  if (Get-Command py -ErrorAction SilentlyContinue) { py -3 -m venv $venv } else { python -m venv $venv }
  Check "Making a venv (it needs Python 3.11 to 3.14, from python.org)"
}
Write-Host "Installing what the export needs..."
& $python -m pip install --quiet --upgrade pip; Check "Updating pip"
& $python -m pip install --quiet -r (Join-Path $here "requirements.txt"); Check "Installing requirements.txt"

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$model = Join-Path $Out "htdemucs.onnx"
Write-Host "Exporting htdemucs to $model..."
$pythonPath = $env:PYTHONPATH
$env:PYTHONPATH = $here
try {
  & $python (Join-Path $here "scripts\convert-pth-to-onnx.py") $Out; Check "The export"
} finally {
  $env:PYTHONPATH = $pythonPath
}
& $python (Join-Path $here "check_model.py") $model; Check "Checking the model"
Write-Host "Done. Install $model from Soundcheck the first time you separate Stems."

Set-Location -LiteralPath $PSScriptRoot
Write-Host "Starting demo app at http://127.0.0.1:5000"
Write-Host "Keep this window open while the app is running."
python .\demo_backend.py

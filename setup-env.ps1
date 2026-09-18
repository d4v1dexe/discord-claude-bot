# Writes .env with hidden prompts, so tokens never appear on screen,
# in a command line, or in a chat transcript.
# Run it yourself:  powershell -NoProfile -ExecutionPolicy Bypass -File setup-env.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $repo '.env'

function Read-Secret($label, $required) {
    $secure = Read-Host -Prompt $label -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    if ($required -and [string]::IsNullOrWhiteSpace($plain)) {
        Write-Host "That one is required. Nothing written." -ForegroundColor Red
        exit 1
    }
    return $plain
}

Write-Host ""
Write-Host "discord-claude-bot environment setup" -ForegroundColor Cyan
Write-Host "Input is hidden. Press Enter to skip an optional value."
Write-Host ""

$discord = Read-Secret "Discord bot token (required)" $true
$github  = Read-Secret "GitHub token (optional, Enter to skip)" $false

if ($discord.Split('.').Count -ne 3) {
    Write-Host "Warning: that does not look like a Discord bot token (expected 3 dot-separated parts)." -ForegroundColor Yellow
    $go = Read-Host "Continue anyway? (y/N)"
    if ($go -ne 'y') { Write-Host "Aborted. Nothing written."; exit 1 }
}
if ($github -and -not $github.StartsWith('github_pat_') -and -not $github.StartsWith('ghp_')) {
    Write-Host "Warning: that does not look like a GitHub token." -ForegroundColor Yellow
}

if (Test-Path $envPath) {
    $backup = "$envPath.bak-" + (Get-Date -Format 'yyyy-MM-ddTHH-mm-ss')
    Copy-Item $envPath $backup
    Write-Host "Backed up existing .env to $backup"
}

$lines = @(
    '# Written by setup-env.ps1. Never commit this file.',
    "DISCORD_TOKEN=$discord"
)
if ($github) { $lines += "GITHUB_TOKEN=$github" } else { $lines += 'GITHUB_TOKEN=' }
$lines += '# Leave blank to run on your Claude plan via your `claude` login.'
$lines += 'ANTHROPIC_API_KEY='

# UTF-8 without BOM: dotenv chokes on a BOM before the first key.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($envPath, $lines, $utf8NoBom)

$discord = $null; $github = $null; [GC]::Collect()

Write-Host ""
Write-Host "Wrote $envPath" -ForegroundColor Green
Write-Host "Keys set: DISCORD_TOKEN, GITHUB_TOKEN, ANTHROPIC_API_KEY (blank)."
Write-Host ""

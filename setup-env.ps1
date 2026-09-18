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
Write-Host ""
Write-Host "Claude auth: skip this if you ran 'claude auth login' on this machine." -ForegroundColor DarkGray
Write-Host "Paste a token from 'claude setup-token' only if the bot runs unattended." -ForegroundColor DarkGray
$claude  = Read-Secret "Claude OAuth token (optional, Enter to skip)" $false

if ($discord.Split('.').Count -ne 3) {
    Write-Host "Warning: that does not look like a Discord bot token (expected 3 dot-separated parts)." -ForegroundColor Yellow
    $go = Read-Host "Continue anyway? (y/N)"
    if ($go -ne 'y') { Write-Host "Aborted. Nothing written."; exit 1 }
}
if ($github -and -not $github.StartsWith('github_pat_') -and -not $github.StartsWith('ghp_')) {
    Write-Host "Warning: that does not look like a GitHub token." -ForegroundColor Yellow
}

if (Test-Path $envPath) {
    # Backup goes OUTSIDE the repo: a .env.bak inside it can be committed by
    # accident, and it holds the old secrets.
    $backupDir = Join-Path $env:LOCALAPPDATA 'discord-claude-bot-backups'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $backup = Join-Path $backupDir ("env.bak-" + (Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'))
    Copy-Item $envPath $backup
    Write-Host "Backed up existing .env to $backup (outside the repo)"
}

$lines = @(
    '# Written by setup-env.ps1. Never commit this file.',
    "DISCORD_TOKEN=$discord"
)
if ($github) { $lines += "GITHUB_TOKEN=$github" } else { $lines += 'GITHUB_TOKEN=' }
$lines += '# Long-lived token from `claude setup-token`, for unattended runs on your plan.'
if ($claude) { $lines += "CLAUDE_CODE_OAUTH_TOKEN=$claude" } else { $lines += 'CLAUDE_CODE_OAUTH_TOKEN=' }
$lines += '# Setting this switches to pay-as-you-go API billing. Leave blank to use your plan.'
$lines += 'ANTHROPIC_API_KEY='

# UTF-8 without BOM: dotenv chokes on a BOM before the first key.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($envPath, $lines, $utf8NoBom)

$discord = $null; $github = $null; $claude = $null; [GC]::Collect()

Write-Host ""
Write-Host "Wrote $envPath" -ForegroundColor Green
Write-Host "Keys written: DISCORD_TOKEN, GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY."
Write-Host ""

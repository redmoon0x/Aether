# Aether MCP - Windows GUI Dashboard
# Double-click the desktop shortcut, or run:
#   powershell -ExecutionPolicy Bypass -File aether-gui.ps1
# Requires: Node.js, cloudflared (optional, for tunnel)

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$script:ServerProcess = $null
$script:TunnelProcess = $null
$script:FoundTunnelUrl = $null
$script:ServerPort = 3456
$script:ServerDir = Split-Path -Parent $PSScriptRoot

# Startup checks
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    [System.Windows.MessageBox]::Show(
        "Node.js is not installed or not in PATH. Install it from https://nodejs.org",
        "Aether MCP - Error", "OK", "Error")
    exit 1
}

$distIndex = Join-Path $script:ServerDir "dist\index.js"
if (-not (Test-Path $distIndex)) {
    [System.Windows.MessageBox]::Show(
        "Server not built. Please run:  cd '$script:ServerDir'  then  npm run build",
        "Aether MCP - Error", "OK", "Error")
    exit 1
}

# XAML UI - ASCII only for PowerShell 5.1 compatibility
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Aether MCP" Width="520" Height="480"
        WindowStartupLocation="CenterScreen"
        Background="#0d1117" ResizeMode="CanMinimize"
        FontFamily="Segoe UI">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Padding" Value="16,8"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="BorderThickness" Value="0"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border Background="{TemplateBinding Background}" CornerRadius="6"
                    Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="TextBox">
      <Setter Property="Background" Value="#161b22"/>
      <Setter Property="Foreground" Value="#58a6ff"/>
      <Setter Property="BorderBrush" Value="#30363d"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="FontFamily" Value="Consolas"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="IsReadOnly" Value="True"/>
    </Style>
  </Window.Resources>

  <Grid Margin="20">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
    </Grid.RowDefinitions>

    <!-- Title -->
    <StackPanel Grid.Row="0" Margin="0,0,0,16">
      <TextBlock Text="Aether MCP" FontSize="22" FontWeight="Bold" Foreground="#e6edf3"/>
      <TextBlock Text="Browser Automation Server" FontSize="12" Foreground="#8b949e" Margin="0,2,0,0"/>
    </StackPanel>

    <!-- Server Controls -->
    <Border Grid.Row="1" Background="#161b22" CornerRadius="8" Padding="16" Margin="0,0,0,10"
            BorderBrush="#30363d" BorderThickness="1">
      <StackPanel>
        <StackPanel Orientation="Horizontal" Margin="0,0,0,10">
          <Ellipse x:Name="ServerDot" Width="10" Height="10" Fill="#f85149" Margin="0,0,8,0"/>
          <TextBlock x:Name="ServerStatusText" Text="Server Stopped" FontSize="14" FontWeight="SemiBold"
                     Foreground="#8b949e" VerticalAlignment="Center"/>
        </StackPanel>
        <StackPanel Orientation="Horizontal">
          <Button x:Name="BtnStart" Content="Start Server" Background="#238636"
                  Foreground="#ffffff" Width="140" Margin="0,0,10,0"/>
          <Button x:Name="BtnStop" Content="Stop Server" Background="#da3633"
                  Foreground="#ffffff" Width="140" IsEnabled="False"/>
        </StackPanel>
      </StackPanel>
    </Border>

    <!-- URLs -->
    <Border Grid.Row="2" Background="#161b22" CornerRadius="8" Padding="16" Margin="0,0,0,10"
            BorderBrush="#30363d" BorderThickness="1">
      <StackPanel>
        <TextBlock Text="Local MCP Endpoint" FontSize="11" Foreground="#8b949e" Margin="0,0,0,4"/>
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <TextBox x:Name="LocalUrl" Text="Not running" Grid.Column="0"/>
          <Button x:Name="BtnCopyLocal" Content="Copy" Background="#21262d" Foreground="#c9d1d9"
                  Width="40" Height="28" Grid.Column="1" Margin="6,0,0,0" Padding="4,2"
                  FontSize="12" ToolTip="Copy local URL"/>
        </Grid>
        <TextBlock Text="Public Tunnel URL" FontSize="11" Foreground="#8b949e" Margin="0,10,0,4"/>
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <TextBox x:Name="TunnelUrl" Text="Not active" Grid.Column="0"/>
          <Button x:Name="BtnCopyTunnel" Content="Copy" Background="#21262d" Foreground="#c9d1d9"
                  Width="40" Height="28" Grid.Column="1" Margin="6,0,0,0" Padding="4,2"
                  FontSize="12" ToolTip="Copy tunnel URL"/>
        </Grid>
      </StackPanel>
    </Border>

    <!-- Tunnel Controls -->
    <Border Grid.Row="3" Background="#161b22" CornerRadius="8" Padding="16" Margin="0,0,0,10"
            BorderBrush="#30363d" BorderThickness="1">
      <StackPanel>
        <StackPanel Orientation="Horizontal" Margin="0,0,0,10">
          <Ellipse x:Name="TunnelDot" Width="10" Height="10" Fill="#f85149" Margin="0,0,8,0"/>
          <TextBlock x:Name="TunnelStatusText" Text="Tunnel Inactive" FontSize="14" FontWeight="SemiBold"
                     Foreground="#8b949e" VerticalAlignment="Center"/>
        </StackPanel>
        <StackPanel Orientation="Horizontal">
          <Button x:Name="BtnTunnelStart" Content="Start Tunnel" Background="#7c3aed"
                  Foreground="#ffffff" Width="140" Margin="0,0,10,0"/>
          <Button x:Name="BtnTunnelStop" Content="Stop Tunnel" Background="#da3633"
                  Foreground="#ffffff" Width="140"/>
        </StackPanel>
        <TextBlock Text="Requires cloudflared: winget install Cloudflare.cloudflared"
                   FontSize="10" Foreground="#484f58" Margin="0,6,0,0"/>
      </StackPanel>
    </Border>

    <!-- Log -->
    <Border Grid.Row="4" Background="#161b22" CornerRadius="8" Padding="16"
            BorderBrush="#30363d" BorderThickness="1">
      <StackPanel>
        <TextBlock Text="Log" FontSize="11" Foreground="#8b949e" Margin="0,0,0,4"/>
        <TextBox x:Name="LogBox" Height="70" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto"
                 IsReadOnly="True" Background="#0d1117" BorderThickness="0"/>
      </StackPanel>
    </Border>
  </Grid>
</Window>
"@

$reader = [System.Xml.XmlNodeReader]::new($xaml)
$Window = [Windows.Markup.XamlReader]::Load($reader)

# Get control references
$ServerDot   = $Window.FindName("ServerDot")
$ServerStatusText = $Window.FindName("ServerStatusText")
$BtnStart    = $Window.FindName("BtnStart")
$BtnStop     = $Window.FindName("BtnStop")
$LocalUrl    = $Window.FindName("LocalUrl")
$BtnCopyLocal = $Window.FindName("BtnCopyLocal")
$TunnelUrl   = $Window.FindName("TunnelUrl")
$BtnCopyTunnel = $Window.FindName("BtnCopyTunnel")
$TunnelDot   = $Window.FindName("TunnelDot")
$TunnelStatusText = $Window.FindName("TunnelStatusText")
$BtnTunnelStart = $Window.FindName("BtnTunnelStart")
$BtnTunnelStop  = $Window.FindName("BtnTunnelStop")
$LogBox      = $Window.FindName("LogBox")

# Logging
function Write-Log($msg) {
    $time = Get-Date -Format "HH:mm:ss"
    $LogBox.Text = "[$time] $msg`n" + $LogBox.Text
    if ($LogBox.LineCount -gt 50) {
        $lines = $LogBox.Text -split "`n"
        $LogBox.Text = ($lines[0..49] -join "`n")
    }
}

# Copy to clipboard
function Copy-Url($url) {
    if ($url -and $url -ne "Not running" -and $url -ne "Not active") {
        Set-Clipboard -Value $url
        Write-Log "Copied to clipboard: $url"
    }
}

# Helper: check if server is actually listening on the port
function Test-ServerRunning {
    try {
        $tcp = [System.Net.Sockets.TcpClient]::new()
        $conn = $tcp.BeginConnect("127.0.0.1", $script:ServerPort, $null, $null)
        $done = $conn.AsyncWaitHandle.WaitOne(1500, $false)
        if ($done) {
            $tcp.EndConnect($conn)
            $tcp.Close()
            return $true
        }
        $tcp.Close()
        return $false
    } catch {
        return $false
    }
}

# Server management
function Start-Server {
    if ($script:ServerProcess -and !$script:ServerProcess.HasExited) {
        Write-Log "Server is already running"
        return
    }

    Write-Log "Starting server..."

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "node"
    $psi.Arguments = "dist/index.js"
    $psi.WorkingDirectory = $script:ServerDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.Environment["MCP_TRANSPORT"] = "http"
    $psi.Environment["MCP_HTTP_PORT"] = "$script:ServerPort"

    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $proc.Start() | Out-Null
    $script:ServerProcess = $proc

    if ($ServerDot) { $ServerDot.Fill = "#3fb950" }
    if ($ServerStatusText) { $ServerStatusText.Text = "Server Running"; $ServerStatusText.Foreground = "#e6edf3" }
    if ($BtnStart) { $BtnStart.IsEnabled = $false }
    if ($BtnStop) { $BtnStop.IsEnabled = $true }
    if ($LocalUrl) { $LocalUrl.Text = "http://localhost:$script:ServerPort/mcp" }

    Write-Log "Server launched on port $script:ServerPort. Wait 2-3 seconds before starting tunnel."
}

function Stop-Server {
    if ($script:ServerProcess -and !$script:ServerProcess.HasExited) {
        Write-Log "Stopping server..."
        $script:ServerProcess.Kill()
        $script:ServerProcess = $null
    }

    Stop-Tunnel

    if ($ServerDot) { $ServerDot.Fill = "#f85149" }
    if ($ServerStatusText) { $ServerStatusText.Text = "Server Stopped"; $ServerStatusText.Foreground = "#8b949e" }
    if ($BtnStart) { $BtnStart.IsEnabled = $true }
    if ($BtnStop) { $BtnStop.IsEnabled = $false }
    if ($LocalUrl) { $LocalUrl.Text = "Not running" }

    Write-Log "Server stopped"
}

# Tunnel management
$script:TunnelLogFile = "$env:TEMP\aether-mcp-tunnel.log"
$script:TunnelStdoutFile = "$env:TEMP\aether-tunnel-stdout.log"
$script:TunnelStderrFile = "$env:TEMP\aether-tunnel-stderr.log"

function Watch-TunnelUrl {
    $script:WatchTimer = [System.Windows.Threading.DispatcherTimer]::new()
    $script:WatchTimer.Interval = [TimeSpan]::FromSeconds(2)
    $script:WatchTimer.Add_Tick({
        if ($script:FoundTunnelUrl) { $script:WatchTimer.Stop(); return }
        if ($script:TunnelProcess -and $script:TunnelProcess.HasExited) {
            if (-not $script:FoundTunnelUrl) {
                if ($TunnelUrl) { $TunnelUrl.Text = "Failed to connect" }
                Write-Log "Tunnel process exited without URL"
            }
            $script:WatchTimer.Stop()
            return
        }
        # Check both stdout and stderr files
        $content = ""
        foreach ($f in @($script:TunnelStdoutFile, $script:TunnelStderrFile)) {
            if (Test-Path $f) {
                $content += (Get-Content $f -Raw -ErrorAction SilentlyContinue)
            }
        }
        if ($content -match '(https://[a-zA-Z0-9.-]+\.trycloudflare\.com)') {
            $script:FoundTunnelUrl = $matches[1]
            if ($TunnelUrl) { $TunnelUrl.Text = "$script:FoundTunnelUrl/mcp" }
            if ($TunnelDot) { $TunnelDot.Fill = "#3fb950" }
            if ($TunnelStatusText) { $TunnelStatusText.Text = "Tunnel Active"; $TunnelStatusText.Foreground = "#e6edf3" }
            Write-Log "Tunnel ready: $script:FoundTunnelUrl/mcp"
            $script:WatchTimer.Stop()
        }
    })
    $script:WatchTimer.Start()
}

function Start-Tunnel {
    # Check server is actually listening on the port
    if (-not (Test-ServerRunning)) {
        Write-Log "ERROR: Server is not listening on port $script:ServerPort. Start the server first."
        [System.Windows.MessageBox]::Show("Please click Start Server first and wait a moment for it to start.", "Server not running", "OK", "Warning")
        return
    }

    if ($script:WatchTimer) { $script:WatchTimer.Stop(); $script:WatchTimer = $null }
    if ($script:TunnelProcess -and !$script:TunnelProcess.HasExited) {
        Write-Log "Tunnel is already active"
        return
    }

    $cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
    if (-not $cloudflared) {
        $local = "$env:USERPROFILE\cloudflared.exe"
        if (Test-Path $local) { $cloudflared = $local }
    }
    if (-not $cloudflared) {
        Write-Log "ERROR: cloudflared not found."
        [System.Windows.MessageBox]::Show(
            "cloudflared is not installed. It was downloaded to:`n$env:USERPROFILE\cloudflared.exe`n`nIf missing, reinstall it.",
            "Missing cloudflared", "OK", "Warning")
        return
    }

    $cfPath = if ($cloudflared -is [string]) { $cloudflared } else { $cloudflared.Source }
    Write-Log "Using cloudflared: $cfPath"

    $script:FoundTunnelUrl = $null
    if ($TunnelUrl) { $TunnelUrl.Text = "Connecting..." }

    Write-Log "Starting Cloudflare Tunnel..."

    # Use Start-Process with redirects to avoid cmd quoting issues with spaces in paths
    $stdoutFile = "$env:TEMP\aether-tunnel-stdout.log"
    $stderrFile = "$env:TEMP\aether-tunnel-stderr.log"
    Remove-Item $stdoutFile, $stderrFile -ErrorAction SilentlyContinue

    $proc = Start-Process -FilePath $cfPath `
        -ArgumentList "tunnel", "--url", "http://localhost:$script:ServerPort", "--no-autoupdate" `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput $stdoutFile `
        -RedirectStandardError $stderrFile

    try {
        $script:TunnelProcess = $proc
        $TunnelDot.Fill = "#d2991d"
        $TunnelStatusText.Text = "Tunnel Connecting..."
        $TunnelStatusText.Foreground = "#d2991d"
        Watch-TunnelUrl
        Write-Log "Tunnel connecting... (may take 10-15s)"
    } catch {
        Write-Log "ERROR: Failed to start tunnel: $_"
        [System.Windows.MessageBox]::Show("Failed to start cloudflared: $_", "Tunnel Error", "OK", "Error")
    }
}

function Stop-Tunnel {
    if ($script:WatchTimer) { $script:WatchTimer.Stop(); $script:WatchTimer = $null }
    if ($script:TunnelProcess -and !$script:TunnelProcess.HasExited) {
        Write-Log "Stopping tunnel..."
        $script:TunnelProcess.Kill()
        $script:TunnelProcess = $null
    }

    $script:FoundTunnelUrl = $null
    Remove-Item $script:TunnelStdoutFile, $script:TunnelStderrFile -ErrorAction SilentlyContinue
    if ($TunnelUrl) { $TunnelUrl.Text = "Not active" }
    if ($TunnelDot) { $TunnelDot.Fill = "#f85149" }
    if ($TunnelStatusText) { $TunnelStatusText.Text = "Tunnel Inactive"; $TunnelStatusText.Foreground = "#8b949e" }

    Write-Log "Tunnel stopped"
}

# Button events
$BtnStart.Add_Click({ Start-Server })
$BtnStop.Add_Click({ Stop-Server })
$BtnTunnelStart.Add_Click({ Start-Tunnel })
$BtnTunnelStop.Add_Click({ Stop-Tunnel })
$BtnCopyLocal.Add_Click({ Copy-Url $LocalUrl.Text })
$BtnCopyTunnel.Add_Click({ Copy-Url $TunnelUrl.Text })

# Window close = cleanup
$Window.Add_Closing({
    if ($script:WatchTimer) { $script:WatchTimer.Stop(); $script:WatchTimer = $null }
    Stop-Tunnel
    if ($script:ServerProcess -and !$script:ServerProcess.HasExited) {
        $script:ServerProcess.Kill()
    }
})

# Show
Write-Log "Aether MCP GUI ready. Click Start Server to begin."
$Window.ShowDialog() | Out-Null


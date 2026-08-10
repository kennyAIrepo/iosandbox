# Launch Blender 4.4 with the BlenderMCP socket server already running
# (skips the N-panel > BlenderMCP > "Connect to Claude" click).
# The server listens on localhost:9876; Claude Code's `blender` MCP server
# (uvx blender-mcp, see ../../.mcp.json) connects to it.
#
# Usage:  .\tools\blender-mcp\start-blender.ps1 [optional .blend file]

param([string]$BlendFile)

$blender = "C:\Program Files\Blender Foundation\Blender 4.4\blender.exe"
$expr = "import bpy; bpy.app.timers.register(lambda: (bpy.ops.blendermcp.start_server(), None)[1], first_interval=0.5)"

if ($BlendFile) {
    Start-Process $blender -ArgumentList @("`"$BlendFile`"", "--python-expr", "`"$expr`"")
} else {
    Start-Process $blender -ArgumentList @("--python-expr", "`"$expr`"")
}
Write-Host "Blender launching with MCP server auto-start (port 9876)."
Write-Host "Then start a Claude Code session in this repo - the 'blender' MCP server is in .mcp.json."

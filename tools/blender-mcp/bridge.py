#!/usr/bin/env python3
"""
bridge.py - talk to the BlenderMCP addon socket (localhost:9876) directly,
no MCP server in between. The protocol is one JSON object per request,
{"type": <command>, "params": {...}}, one JSON object back.

Useful when the uvx blender-mcp bridge is down but Blender's socket is up.

USAGE
  py -3 bridge.py get_scene_info
  py -3 bridge.py get_viewport_screenshot "{\"max_size\": 800, \"filepath\": \"C:/tmp/shot.png\"}"
  py -3 bridge.py execute_code "{\"code\": \"import bpy; print(bpy.data.filepath)\"}"
  py -3 bridge.py execute_code @script.py        # read code from a file
"""

import json
import socket
import sys


def send(cmd_type, params=None, host="localhost", port=9876, timeout=60):
    s = socket.create_connection((host, port), timeout=timeout)
    try:
        s.sendall(json.dumps({"type": cmd_type, "params": params or {}}).encode())
        chunks = []
        while True:
            b = s.recv(65536)
            if not b:
                break
            chunks.append(b)
            try:                       # addon sends one JSON doc; stop when it parses
                return json.loads(b"".join(chunks).decode())
            except json.JSONDecodeError:
                continue
        return json.loads(b"".join(chunks).decode())
    finally:
        s.close()


if __name__ == "__main__":
    cmd = sys.argv[1]
    params = {}
    if len(sys.argv) > 2:
        arg = sys.argv[2]
        if arg.startswith("@"):        # execute_code with code from a file
            with open(arg[1:], encoding="utf-8") as fh:
                params = {"code": fh.read()}
        else:
            params = json.loads(arg)
    r = send(cmd, params)
    out = json.dumps(r, indent=1)
    print(out if len(out) < 8000 else out[:8000] + "\n…truncated")

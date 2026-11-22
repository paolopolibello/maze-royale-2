@echo off
title Maze Royale - Dark Labyrinth
cd /d "%~dp0"
echo Avvio server locale (no-cache dev) su http://localhost:8088 ...
start "" http://localhost:8088/?v=16
python -c "import http.server, socketserver; H=http.server.SimpleHTTPRequestHandler; H2=type('NoCacheH',(H,),{'end_headers':lambda s:(s.send_header('Cache-Control','no-store, no-cache, must-revalidate, max-age=0'), H.end_headers(s))}); socketserver.TCPServer.allow_reuse_address=True; httpd=http.server.ThreadingHTTPServer(('127.0.0.1',8088),H2); print('Server attivo su http://localhost:8088/'); httpd.serve_forever()"
pause

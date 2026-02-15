#!/bin/bash
# Start recording bot with xvfb virtual framebuffer
# This enables proper video capture in headful Chrome mode

cd "$(dirname "$0")"
exec xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24 -ac' node server.js

#!/bin/sh
# Builds the Mac sensor helper (universal). Other platforms don't need it.
set -e
[ "$(uname)" = "Darwin" ] || exit 0
mkdir -p build
clang -O2 -Wall -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 \
  -o build/photosphere-sensors native/main.c native/sensors.c \
  -F/System/Library/PrivateFrameworks -framework MultitouchSupport -framework IOKit -framework CoreFoundation

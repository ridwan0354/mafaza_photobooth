#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
OUTPUT_APK="$PROJECT_ROOT/public/Mafaza-Photobooth-Kiosk.apk"

ANDROID_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD_TOOLS="$ANDROID_SDK/build-tools/34.0.0"
PLATFORM_JAR="$ANDROID_SDK/platforms/android-34/android.jar"

if [ -d "/Users/ikhwan_rid1/Library/Java/JavaVirtualMachines/jbr-17.0.14/Contents/Home" ]; then
  export JAVA_HOME="/Users/ikhwan_rid1/Library/Java/JavaVirtualMachines/jbr-17.0.14/Contents/Home"
fi
JAVAC="$JAVA_HOME/bin/javac"
KEYTOOL="$JAVA_HOME/bin/keytool"

cd "$SCRIPT_DIR"

echo "=== Building Mafaza Photobooth Kiosk APK for Redmi Pad 2 ==="
echo "Using JAVA_HOME: $JAVA_HOME"
echo "Using Android SDK: $ANDROID_SDK"

rm -rf build
mkdir -p build/compiled_res build/gen build/classes build/dex

echo "[1/6] Compiling Android resources with aapt2..."
"$BUILD_TOOLS/aapt2" compile --dir res -o build/compiled_res/resources.zip

echo "[2/6] Linking AndroidManifest.xml and resources..."
"$BUILD_TOOLS/aapt2" link \
  -I "$PLATFORM_JAR" \
  --manifest AndroidManifest.xml \
  --java build/gen \
  -o build/unaligned.apk \
  build/compiled_res/resources.zip

echo "[3/6] Compiling Java source files (CanonUsbPtpEngine, LocalCanonHttpServer, MainActivity)..."
find src build/gen -name "*.java" > build/sources.txt
"$JAVAC" \
  -source 11 -target 11 \
  -classpath "$PLATFORM_JAR" \
  -d build/classes \
  @build/sources.txt

echo "[4/6] Converting JVM bytecode to Dalvik Executable (classes.dex) with d8..."
"$BUILD_TOOLS/d8" \
  --lib "$PLATFORM_JAR" \
  --min-api 24 \
  --output build/dex \
  build/classes/com/mafaza/photobooth/kiosk/*.class

echo "[5/6] Packaging classes.dex & zipaligning APK..."
(
  cd build/dex
  zip -q -r ../unaligned.apk classes.dex
)
"$BUILD_TOOLS/zipalign" -f 4 build/unaligned.apk build/aligned.apk

KEYSTORE="$SCRIPT_DIR/mafaza-kiosk-release.jks"
if [ ! -f "$KEYSTORE" ]; then
  echo "Generating signing keystore..."
  "$KEYTOOL" -genkeypair \
    -v \
    -keystore "$KEYSTORE" \
    -alias mafazakiosk \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -storepass mafaza123 \
    -keypass mafaza123 \
    -dname "CN=Mafaza Photobooth, OU=Kiosk, O=GalipatSistem, L=Indonesia, ST=ID, C=ID"
fi

echo "[6/6] Signing APK with apksigner (v1 + v2 + v3 signatures)..."
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias mafazakiosk \
  --ks-pass pass:mafaza123 \
  --key-pass pass:mafaza123 \
  --out "$OUTPUT_APK" \
  build/aligned.apk

"$BUILD_TOOLS/apksigner" verify --verbose "$OUTPUT_APK"

rm -rf build
ls -lh "$OUTPUT_APK"
echo "=== APK Build Complete: $OUTPUT_APK ==="

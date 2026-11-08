package com.mafaza.photobooth.kiosk;

import android.util.Log;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Local Embedded HTTP Bridge Server on 127.0.0.1:19898
 *
 * Emulates the exact same HTTP API that public/js/kiosk.js already expects
 * from the desktop Canon USB LiveView bridge:
 *   - GET /status           -> JSON camera status & exposure settings
 *   - GET /frame.jpg        -> Latest JPEG frame from Canon EOS 1300D LiveView
 *   - GET /control?...      -> ISO, Shutter Speed (Tv), Aperture (Av), WB, AF, Manual Focus
 *   - GET/POST /capture     -> Triggers physical Canon EOS 1300D shutter + Hotshoe Flash (Godox CT-16)
 *   - GET /captured_pose.jpg-> Serves the high-res JPEG captured by the DSLR shutter
 */
public class LocalCanonHttpServer {
    private static final String TAG = "LocalCanonHttpServer";
    public static final int PORT = 19898;

    private final CanonUsbPtpEngine canonEngine;
    private ServerSocket serverSocket;
    private volatile boolean running = false;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private volatile byte[] lastCapturedPhotoBytes = null;

    public LocalCanonHttpServer(CanonUsbPtpEngine engine) {
        this.canonEngine = engine;
    }

    public void start() {
        if (running) return;
        running = true;
        executor.execute(() -> {
            try {
                serverSocket = new ServerSocket(PORT, 32, InetAddress.getByName("127.0.0.1"));
                Log.i(TAG, "Canon USB HTTP Bridge listening on http://127.0.0.1:" + PORT);
                while (running && !serverSocket.isClosed()) {
                    try {
                        final Socket client = serverSocket.accept();
                        client.setSoTimeout(8000);
                        client.setTcpNoDelay(true);
                        executor.execute(() -> handleClient(client));
                    } catch (IOException acceptErr) {
                        if (running) {
                            Log.w(TAG, "Accept error: " + acceptErr.getMessage());
                        }
                    }
                }
            } catch (IOException e) {
                Log.e(TAG, "Failed to bind 127.0.0.1:" + PORT + " - " + e.getMessage());
            }
        });
    }

    public void stop() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {}
        }
    }

    private void handleClient(Socket client) {
        try (Socket sock = client;
             BufferedReader reader = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
             OutputStream out = sock.getOutputStream()) {

            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.isEmpty()) return;

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0].toUpperCase();
            String fullUri = parts[1];

            // Drain HTTP headers
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                // ignore headers
            }

            if ("OPTIONS".equals(method)) {
                sendCorsPreflight(out);
                return;
            }

            String path = fullUri;
            String query = "";
            int qIdx = fullUri.indexOf('?');
            if (qIdx >= 0) {
                path = fullUri.substring(0, qIdx);
                query = fullUri.substring(qIdx + 1);
            }

            if ("/status".equals(path)) {
                sendJson(out, 200, buildStatusJson());
            } else if ("/frame.jpg".equals(path)) {
                byte[] jpeg = canonEngine.getLatestLiveViewJpeg();
                if (jpeg != null && jpeg.length > 0) {
                    sendBinary(out, 200, "image/jpeg", jpeg);
                } else {
                    sendJson(out, 503, "{\"ok\":false,\"error\":\"Waiting for LiveView frame\"}");
                }
            } else if ("/control".equals(path)) {
                Map<String, String> params = parseQueryParams(query);
                handleControlParams(params);
                sendJson(out, 200, buildStatusJson());
            } else if ("/capture".equals(path) || "/api/camera/trigger-capture".equals(path)) {
                handlePhysicalShutterCapture(out);
            } else if ("/captured_pose.jpg".equals(path)) {
                byte[] photo = lastCapturedPhotoBytes;
                if (photo == null || photo.length == 0) {
                    photo = canonEngine.getLatestLiveViewJpeg();
                }
                if (photo != null && photo.length > 0) {
                    sendBinary(out, 200, "image/jpeg", photo);
                } else {
                    sendJson(out, 404, "{\"ok\":false,\"error\":\"No captured photo available\"}");
                }
            } else {
                sendJson(out, 404, "{\"ok\":false,\"error\":\"Not found\"}");
            }

        } catch (Exception e) {
            // Ignore client disconnect or socket timeout
        }
    }

    private void handleControlParams(Map<String, String> params) {
        if (!canonEngine.isActive()) {
            canonEngine.scanAndConnectIfAvailable();
            return;
        }
        if (params.containsKey("iso")) {
            canonEngine.setIso(params.get("iso"));
        }
        if (params.containsKey("tv")) {
            canonEngine.setShutterSpeed(params.get("tv"));
        }
        if (params.containsKey("av")) {
            canonEngine.setAperture(params.get("av"));
        }
        if (params.containsKey("wb")) {
            canonEngine.setWhiteBalance(params.get("wb"));
        }
        if (params.containsKey("af")) {
            canonEngine.triggerAutoFocus();
        }
        if (params.containsKey("focus")) {
            try {
                int step = Integer.parseInt(params.get("focus"));
                canonEngine.driveLensFocus(step);
            } catch (NumberFormatException ignored) {}
        }
    }

    private void handlePhysicalShutterCapture(OutputStream out) throws IOException {
        if (!canonEngine.isActive()) {
            sendJson(out, 200, "{\"ok\":false,\"error\":\"Canon USB belum aktif\"}");
            return;
        }
        byte[] capturedJpeg = canonEngine.capturePhotoWithFlash();
        if (capturedJpeg != null && capturedJpeg.length > 1024) {
            lastCapturedPhotoBytes = capturedJpeg;
            long ts = System.currentTimeMillis();
            String json = "{\"ok\":true,\"source\":\"canon-usb-ptp-apk\",\"imageUrl\":\"http://127.0.0.1:"
                    + PORT + "/captured_pose.jpg?t=" + ts + "\"}";
            sendJson(out, 200, json);
        } else {
            sendJson(out, 200, "{\"ok\":false,\"error\":\"Shutter triggered, using LiveView fallback\"}");
        }
    }

    private String buildStatusJson() {
        boolean active = canonEngine.isActive();
        boolean hasFrame = canonEngine.hasLiveFrame();
        long frames = canonEngine.getTotalFramesReceived();
        String camName = escapeJson(canonEngine.getCameraModelName());
        int iso = canonEngine.getCurrentIso();
        int tv = canonEngine.getCurrentTv();
        int av = canonEngine.getCurrentAv();
        int wb = canonEngine.getCurrentWb();
        int ae = canonEngine.getCurrentAeMode();
        int err = canonEngine.getLastCmdError();

        return "{"
                + "\"ok\":true,"
                + "\"active\":" + active + ","
                + "\"hasFrame\":" + hasFrame + ","
                + "\"frames\":" + frames + ","
                + "\"camera\":\"" + camName + "\","
                + "\"width\":1056,"
                + "\"height\":704,"
                + "\"iso\":" + iso + ","
                + "\"tv\":" + tv + ","
                + "\"av\":" + av + ","
                + "\"wb\":" + wb + ","
                + "\"aeMode\":" + ae + ","
                + "\"cmdError\":" + err + ","
                + "\"platform\":\"android-apk\""
                + "}";
    }

    private Map<String, String> parseQueryParams(String query) {
        Map<String, String> map = new HashMap<>();
        if (query == null || query.isEmpty()) return map;
        String[] pairs = query.split("&");
        for (String pair : pairs) {
            int idx = pair.indexOf('=');
            if (idx > 0) {
                try {
                    String k = URLDecoder.decode(pair.substring(0, idx), "UTF-8");
                    String v = URLDecoder.decode(pair.substring(idx + 1), "UTF-8");
                    map.put(k, v);
                } catch (Exception ignored) {}
            } else if (!pair.isEmpty()) {
                map.put(pair, "1");
            }
        }
        return map;
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private void sendCorsPreflight(OutputStream out) throws IOException {
        String headers = "HTTP/1.1 204 No Content\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: *\r\n"
                + "Access-Control-Allow-Private-Network: true\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private void sendJson(OutputStream out, int statusCode, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        String statusText = statusCode == 200 ? "OK" : (statusCode == 503 ? "Service Unavailable" : "Not Found");
        String headers = "HTTP/1.1 " + statusCode + " " + statusText + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Private-Network: true\r\n"
                + "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n"
                + "Connection: close\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private void sendBinary(OutputStream out, int statusCode, String contentType, byte[] data) throws IOException {
        String headers = "HTTP/1.1 " + statusCode + " OK\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + data.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Private-Network: true\r\n"
                + "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n"
                + "Connection: close\r\n\r\n";
        out.write(headers.getBytes(StandardCharsets.UTF_8));
        out.write(data);
        out.flush();
    }
}

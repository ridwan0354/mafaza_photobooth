package com.mafaza.photobooth.kiosk;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "MafazaKioskPrefs";
    private static final String KEY_KIOSK_URL = "kiosk_url";
    private static final String DEFAULT_KIOSK_URL = "https://mafaza.galipatsistem.com/kiosk";
    private static final int REQ_PERMISSIONS = 1001;

    private WebView webView;
    private TextView usbBadgeView;
    private CanonUsbPtpEngine canonEngine;
    private LocalCanonHttpServer localHttpServer;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        enableImmersiveFullscreen();

        // Initialize Native Canon USB PTP Engine & Local HTTP Bridge (127.0.0.1:19898)
        canonEngine = new CanonUsbPtpEngine(this, new CanonUsbPtpEngine.Listener() {
            @Override
            public void onCameraConnected(String modelName) {
                mainHandler.post(() -> {
                    updateUsbBadge(true, modelName);
                    Toast.makeText(MainActivity.this,
                            "Kamera USB Terhubung: " + modelName, Toast.LENGTH_SHORT).show();
                    if (webView != null) {
                        webView.evaluateJavascript(
                                "if (typeof pollCanonUsbBridge === 'function') { pollCanonUsbBridge(); }",
                                null);
                    }
                });
            }

            @Override
            public void onCameraDisconnected() {
                mainHandler.post(() -> {
                    updateUsbBadge(false, "USB Kamera Terputus");
                });
            }

            @Override
            public void onStatusMessage(String message) {
                mainHandler.post(() -> {
                    if (!canonEngine.isActive()) {
                        updateUsbBadge(false, message);
                    }
                });
            }
        });

        localHttpServer = new LocalCanonHttpServer(canonEngine);
        localHttpServer.start();
        canonEngine.start();

        // Build UI Layout
        FrameLayout rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.parseColor("#1A120E"));

        webView = new WebView(this);
        configureWebView(webView);
        rootLayout.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        // Floating small USB indicator badge at bottom-left corner (tap to rescan / long-press to change URL)
        usbBadgeView = new TextView(this);
        usbBadgeView.setText("📷 USB EOS: Siap Colok OTG");
        usbBadgeView.setTextColor(Color.WHITE);
        usbBadgeView.setTextSize(11f);
        usbBadgeView.setPadding(22, 10, 22, 10);
        usbBadgeView.setBackgroundColor(Color.argb(175, 28, 22, 18));
        usbBadgeView.setAlpha(0.75f);
        FrameLayout.LayoutParams badgeParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.START);
        badgeParams.setMargins(20, 20, 20, 16);

        usbBadgeView.setOnClickListener(v -> {
            Toast.makeText(this, "Memindai ulang USB Canon EOS...", Toast.LENGTH_SHORT).show();
            canonEngine.scanAndConnectIfAvailable();
            if (webView != null) {
                webView.evaluateJavascript(
                        "if (typeof pollCanonUsbBridge === 'function') { pollCanonUsbBridge(); }",
                        null);
            }
        });

        usbBadgeView.setOnLongClickListener(v -> {
            showOperatorConfigDialog();
            return true;
        });

        rootLayout.addView(usbBadgeView, badgeParams);
        setContentView(rootLayout);

        requestRuntimeCameraPermissions();
        webView.loadUrl(getSavedKioskUrl());
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void configureWebView(WebView wv) {
        WebSettings settings = wv.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Allow HTTPS page (mafaza.galipatsistem.com) to fetch HTTP localhost bridge (http://127.0.0.1:19898)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // Set Desktop User-Agent so public/js/kiosk.js automatically enables Canon USB 127.0.0.1:19898 polling
        // without modifying a single line of public/js/kiosk.js!
        settings.setUserAgentString(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 MafazaKioskAPK/2.0");

        wv.addJavascriptInterface(new MafazaAndroidBridge(), "MafazaAndroidBridge");

        wv.setWebChromeClient(new WebChromeClient() {
            private Bitmap transparentPoster = null;

            @Override
            public Bitmap getDefaultVideoPoster() {
                if (transparentPoster == null) {
                    transparentPoster = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
                }
                return transparentPoster;
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                mainHandler.post(() -> {
                    try {
                        request.grant(request.getResources());
                    } catch (Exception ignored) {}
                });
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                return super.onConsoleMessage(consoleMessage);
            }
        });

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectAndroidKioskBridge(view);
            }
        });
    }

    /**
     * Injects a lightweight runtime hook into the loaded page so that:
     * 1) When Canon USB is active on 127.0.0.1:19898, fetch('/api/camera/trigger-capture')
     *    automatically routes to http://127.0.0.1:19898/capture to fire the physical Canon EOS 1300D
     *    shutter + Godox CT-16 hotshoe flash and return the captured DSLR photo.
     * 2) window.print() invokes Android's native PrintManager so thermal/photo printers connected
     *    to Redmi Pad 2 work seamlessly.
     */
    private void injectAndroidKioskBridge(WebView view) {
        String js = "(function() {\n"
                + "  if (window.__mafazaApkBridgeInjected) return;\n"
                + "  window.__mafazaApkBridgeInjected = true;\n"
                + "  console.log('[MafazaKioskAPK v2.1] Native USB PTP & Direct Canvas LiveView Bridge Active');\n"
                + "  const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';\n"
                + "  const origFetch = window.fetch.bind(window);\n"
                + "  window.fetch = async function(input, init) {\n"
                + "    try {\n"
                + "      const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');\n"
                + "      const isCanonActive = Boolean((typeof canonUsbActive !== 'undefined' && canonUsbActive) || (window.kiosk && window.kiosk.canonUsbStreamActive));\n"
                + "      if (urlStr.indexOf('/api/camera/trigger-capture') !== -1 && isCanonActive) {\n"
                + "        return await origFetch('http://127.0.0.1:19898/capture', { method: 'POST', cache: 'no-store' });\n"
                + "      }\n"
                + "    } catch (e) {}\n"
                + "    return origFetch(input, init);\n"
                + "  };\n"
                + "  window.print = function() {\n"
                + "    if (window.MafazaAndroidBridge && typeof window.MafazaAndroidBridge.printPage === 'function') {\n"
                + "      window.MafazaAndroidBridge.printPage();\n"
                + "    }\n"
                + "  };\n"
                + "  // Direct Canvas LiveView Overlay & Poster Suppressor for Android WebView\n"
                + "  setInterval(function() {\n"
                + "    const v = document.getElementById('videoFeed');\n"
                + "    const qv = document.getElementById('qrVideoFeed');\n"
                + "    if (v && v.getAttribute('poster') !== TRANSPARENT_GIF) v.setAttribute('poster', TRANSPARENT_GIF);\n"
                + "    if (qv && qv.getAttribute('poster') !== TRANSPARENT_GIF) qv.setAttribute('poster', TRANSPARENT_GIF);\n"
                + "    if (v && v.srcObject && v.paused) {\n"
                + "      v.play().catch(function(){});\n"
                + "    }\n"
                + "    const k = window.kiosk;\n"
                + "    const frame = document.getElementById('cameraRetroFrame');\n"
                + "    if (k && k.canonUsbCanvas && frame) {\n"
                + "      const c = k.canonUsbCanvas;\n"
                + "      if (k.canonUsbStreamActive) {\n"
                + "        if (c.parentElement !== frame) {\n"
                + "          c.id = 'canonUsbDirectCanvas';\n"
                + "          c.style.position = 'absolute';\n"
                + "          c.style.inset = '0';\n"
                + "          c.style.width = '100%';\n"
                + "          c.style.height = '100%';\n"
                + "          c.style.pointerEvents = 'none';\n"
                + "          c.style.zIndex = '2';\n"
                + "          frame.insertBefore(c, frame.firstChild);\n"
                + "        }\n"
                + "        c.style.display = 'block';\n"
                + "        if (v) {\n"
                + "          c.style.objectFit = v.style.objectFit || 'contain';\n"
                + "          c.style.transform = v.style.transform || 'scaleX(-1)';\n"
                + "          c.style.filter = v.style.filter || 'none';\n"
                + "        }\n"
                + "      } else if (c.parentElement) {\n"
                + "        c.style.display = 'none';\n"
                + "      }\n"
                + "    }\n"
                + "  }, 250);\n"
                + "})();";
        view.evaluateJavascript(js, null);
    }

    public class MafazaAndroidBridge {
        @JavascriptInterface
        public void printPage() {
            mainHandler.post(() -> {
                if (webView == null) return;
                PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                if (printManager != null) {
                    String jobName = "Mafaza_Photobooth_" + System.currentTimeMillis();
                    PrintDocumentAdapter printAdapter = webView.createPrintDocumentAdapter(jobName);
                    PrintAttributes.Builder builder = new PrintAttributes.Builder();
                    builder.setMediaSize(PrintAttributes.MediaSize.ISO_A4);
                    printManager.print(jobName, printAdapter, builder.build());
                }
            });
        }

        @JavascriptInterface
        public void rescanCanonUsb() {
            if (canonEngine != null) {
                canonEngine.scanAndConnectIfAvailable();
            }
        }
    }

    private void updateUsbBadge(boolean connected, String label) {
        if (usbBadgeView == null) return;
        if (connected) {
            usbBadgeView.setText("🟢 USB DSLR: " + label);
            usbBadgeView.setBackgroundColor(Color.argb(200, 22, 101, 52));
        } else {
            usbBadgeView.setText("📷 " + label);
            usbBadgeView.setBackgroundColor(Color.argb(175, 28, 22, 18));
        }
    }

    private void showOperatorConfigDialog() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(getSavedKioskUrl());

        new AlertDialog.Builder(this)
                .setTitle("Pengaturan APK Kiosk (Redmi Pad 2)")
                .setMessage("URL Server Kiosk Photobooth:")
                .setView(input)
                .setPositiveButton("Simpan & Muat Ulang", (dialog, which) -> {
                    String newUrl = input.getText().toString().trim();
                    if (!newUrl.isEmpty()) {
                        saveKioskUrl(newUrl);
                        webView.clearCache(true);
                        webView.loadUrl(newUrl);
                    }
                })
                .setNeutralButton("Scan Ulang USB Canon", (dialog, which) -> {
                    canonEngine.scanAndConnectIfAvailable();
                })
                .setNegativeButton("Batal", null)
                .show();
    }

    private String getSavedKioskUrl() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        return prefs.getString(KEY_KIOSK_URL, DEFAULT_KIOSK_URL);
    }

    private void saveKioskUrl(String url) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit().putString(KEY_KIOSK_URL, url).apply();
    }

    private void requestRuntimeCameraPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String[] perms = new String[]{
                    Manifest.permission.CAMERA,
                    Manifest.permission.RECORD_AUDIO
            };
            boolean needReq = false;
            for (String p : perms) {
                if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                    needReq = true;
                    break;
                }
            }
            if (needReq) {
                requestPermissions(perms, REQ_PERMISSIONS);
            }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(intent.getAction())) {
            if (canonEngine != null) {
                canonEngine.scanAndConnectIfAvailable();
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        enableImmersiveFullscreen();
        if (canonEngine != null && !canonEngine.isActive()) {
            canonEngine.scanAndConnectIfAvailable();
        }
    }

    private void enableImmersiveFullscreen() {
        View decorView = getWindow().getDecorView();
        decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
                return true;
            }
            return true; // Lock back button in Kiosk mode
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (localHttpServer != null) {
            localHttpServer.stop();
        }
        if (canonEngine != null) {
            canonEngine.stop();
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}

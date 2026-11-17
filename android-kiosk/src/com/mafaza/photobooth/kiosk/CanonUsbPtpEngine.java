package com.mafaza.photobooth.kiosk;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;

/**
 * Native Android USB Host PTP Driver for:
 *  1) Canon EOS Cameras via Canon EOS Vendor Extensions (0x91xx)
 *  2) Sony Alpha Cameras (e.g. Sony A7 III / ILCE-7M3) via Sony SDIO Remote Control Extensions (0x92xx)
 *  3) Nikon DSLR / Z Mirrorless Cameras via Nikon PTP Extensions (0x9201/0x9203/0x100E)
 *  4) Fujifilm / Generic ISO-15740 Still Image (Class 6) PTP Cameras
 *
 * Also cooperates cleanly with built-in tablet cameras and Android UVC (Class 14) webcams/capture cards
 * without claiming Class 14 Video interfaces away from the OS driver.
 */
public class CanonUsbPtpEngine {
    private static final String TAG = "CanonUsbPtpEngine";
    public static final String ACTION_USB_PERMISSION = "com.mafaza.photobooth.kiosk.USB_PERMISSION";

    public static final int CANON_VENDOR_ID    = 0x04A9; // 1193 (Canon Inc.)
    public static final int SONY_VENDOR_ID     = 0x054C; // 1356 (Sony Corp.)
    public static final int NIKON_VENDOR_ID    = 0x04B0; // 1200 (Nikon Corp.)
    public static final int FUJIFILM_VENDOR_ID = 0x04CB; // 1227 (Fujifilm)
    private static final int USB_CLASS_VIDEO   = 14;     // UsbConstants.USB_CLASS_VIDEO

    public enum DriverType { NONE, CANON, SONY, NIKON, GENERIC_PTP }

    // Standard PTP Operation Codes
    private static final int PTP_OC_GET_DEVICE_INFO = 0x1001;
    private static final int PTP_OC_OPEN_SESSION = 0x1002;
    private static final int PTP_OC_CLOSE_SESSION = 0x1003;
    private static final int PTP_OC_GET_STORAGE_IDS = 0x1004;
    private static final int PTP_OC_GET_OBJECT_HANDLES = 0x1007;
    private static final int PTP_OC_GET_OBJECT_INFO = 0x1008;
    private static final int PTP_OC_GET_OBJECT = 0x1009;
    private static final int PTP_OC_INITIATE_CAPTURE = 0x100E;
    private static final int PTP_OC_SET_DEVICE_PROP_VALUE = 0x1016;

    // Canon EOS Vendor PTP Operation Codes (0x91xx)
    private static final int PTP_OC_CANON_CAPTURE = 0x910F;
    private static final int PTP_OC_CANON_SET_PROP_EX = 0x9110;
    private static final int PTP_OC_CANON_SET_REMOTE_MODE = 0x9114;
    private static final int PTP_OC_CANON_SET_EVENT_MODE = 0x9115;
    private static final int PTP_OC_CANON_GET_EVENT = 0x9116;
    private static final int PTP_OC_CANON_TRANSFER_COMPLETE = 0x9117;
    private static final int PTP_OC_CANON_KEEP_DEVICE_ON = 0x911D;
    private static final int PTP_OC_CANON_REMOTE_RELEASE_ON = 0x9128;
    private static final int PTP_OC_CANON_REMOTE_RELEASE_OFF = 0x9129;
    private static final int PTP_OC_CANON_INITIATE_VIEWFINDER = 0x9151;
    private static final int PTP_OC_CANON_TERMINATE_VIEWFINDER = 0x9152;
    private static final int PTP_OC_CANON_GET_VIEWFINDER_DATA = 0x9153;
    private static final int PTP_OC_CANON_DO_AF = 0x9154;
    private static final int PTP_OC_CANON_DRIVE_LENS = 0x9155;

    // Canon EOS Property Codes
    public static final int PROP_APERTURE = 0xD101;
    public static final int PROP_SHUTTER_SPEED = 0xD102;
    public static final int PROP_ISO = 0xD103;
    public static final int PROP_WHITE_BALANCE = 0xD105;
    public static final int PROP_CAPTURE_DESTINATION = 0xD11C;
    public static final int PROP_EVF_OUTPUT_DEVICE = 0xD1B0;
    public static final int PROP_EVF_MODE = 0xD1B1;

    // Sony Alpha Remote Control PTP Operation Codes (0x92xx)
    private static final int PTP_OC_SONY_SDIO_CONNECT = 0x9201;
    private static final int PTP_OC_SONY_SDIO_GET_EXT_DEVICE_INFO = 0x9202;
    private static final int PTP_OC_SONY_SET_EXT_DEVICE_PROP_VALUE = 0x9205;
    private static final int PTP_OC_SONY_CONTROL_DEVICE = 0x9207;
    private static final int PTP_OC_SONY_GET_ALL_EXT_DEVICE_PROP_INFO = 0x9209;

    // Sony Alpha Property & Control Codes
    private static final int SONY_PROP_WHITE_BALANCE = 0x5005;      // UINT16
    private static final int SONY_PROP_APERTURE = 0x5007;           // UINT16 (F * 100)
    private static final int SONY_PROP_FOCUS_MODE = 0x500A;         // UINT16 (1=MF, 2=AF-S, 0x8004=AF-C)
    private static final int SONY_PROP_SHUTTER_SPEED = 0xD20D;      // UINT32 ((num << 16) | den)
    private static final int SONY_PROP_OBJECT_IN_MEMORY = 0xD215;   // UINT16 (>= 0x8000 when photo is in RAM)
    private static final int SONY_PROP_ISO = 0xD21E;                // UINT32
    private static final int SONY_PROP_LIVEVIEW_STATUS = 0xD221;    // UINT8
    private static final int SONY_CTRL_HALF_PRESS_SHUTTER = 0xD2C1; // UINT16 (2=Down, 1=Up)
    private static final int SONY_CTRL_CAPTURE_SHUTTER = 0xD2C2;    // UINT16 (2=Down, 1=Up)
    private static final int SONY_CTRL_NEAR_FAR_FOCUS = 0xD2C7;     // INT16  (-7..+7)
    private static final int SONY_HANDLE_IN_MEMORY_IMAGE = 0xFFFFC001;
    private static final int SONY_HANDLE_LIVEVIEW_FRAME  = 0xFFFFC002;
    private static final int PTP_EC_OBJECT_ADDED         = 0x4002;
    private static final int PTP_EC_CAPTURE_COMPLETE     = 0x400D;
    private static final int PTP_EC_SONY_OBJECT_ADDED    = 0xC201;
    private static final int PTP_EC_SONY_OBJECT_REMOVED  = 0xC202;
    private static final int PTP_EC_SONY_PROP_CHANGED    = 0xC203;

    // Nikon DSLR / Z Mirrorless Vendor PTP Operation Codes
    private static final int PTP_OC_NIKON_CAPTURE_SDRAM = 0x90C0;
    private static final int PTP_OC_NIKON_CHECK_EVENT = 0x90C7;
    private static final int PTP_OC_NIKON_START_LIVEVIEW = 0x9201;
    private static final int PTP_OC_NIKON_END_LIVEVIEW = 0x9202;
    private static final int PTP_OC_NIKON_GET_LIVEVIEW_IMG = 0x9203;

    // Fujifilm X/GFX Virtual LiveView Object Handle
    private static final int FUJI_HANDLE_LIVEVIEW_FRAME = 0x80000001;

    // PTP Container Types
    private static final short PTP_CNT_COMMAND = 1;
    private static final short PTP_CNT_DATA = 2;
    private static final short PTP_CNT_RESPONSE = 3;

    // PTP Response Codes
    private static final int PTP_RC_OK = 0x2001;
    private static final int PTP_RC_INVALID_TRANSACTION_ID = 0x2004;
    private static final int PTP_RC_OPERATION_NOT_SUPPORTED = 0x2005;
    private static final int PTP_RC_PARAMETER_NOT_SUPPORTED = 0x2006;
    private static final int PTP_RC_DEVICE_BUSY = 0x2019;
    private static final int PTP_RC_SESSION_ALREADY_OPEN = 0x201E;

    public interface Listener {
        void onCameraConnected(String modelName);
        void onCameraDisconnected();
        void onStatusMessage(String message);
        default void onUsbUvcChanged(boolean attached, String deviceName) {}
    }

    private final Context context;
    private final Context activityContext;
    private final Listener listener;
    private final UsbManager usbManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object usbLock = new Object();

    private UsbDevice activeDevice;
    private UsbDeviceConnection connection;
    private UsbInterface ptpInterface;
    private UsbEndpoint epOut;
    private UsbEndpoint epIn;
    private UsbEndpoint epInt;

    private volatile boolean isRunning = false;
    private volatile boolean isConnected = false;
    private volatile boolean isSonyCamera = false;
    private volatile DriverType driverType = DriverType.NONE;
    private volatile boolean usbPtpAttached = false;
    private volatile boolean usbUvcAttached = false;
    private volatile String usbUvcDeviceName = "";
    private volatile boolean supportsUsbLiveView = true;
    private volatile String cameraModelName = "Canon EOS 1300D";
    private volatile byte[] latestLiveViewJpeg = null;
    private volatile long latestFrameTimeMs = 0;
    private volatile long totalFramesReceived = 0;
    private volatile byte[] lastCapturedFullJpeg = null;
    private volatile String lastSonyDiag = "Belum dimulai";
    private volatile String lastCaptureError = "";
    private volatile String lastConnectionError = "";
    private volatile String lastTransportDiagnostic = "";
    private volatile String lastConnectionDiagnostic = "";
    private volatile boolean isConnecting = false;
    private volatile boolean isCapturingPhoto = false;
    private volatile long lastKeepAliveMs = 0;
    private int transactionId = 0;
    private int canonEvfParamIndex = 0;

    // Cached Camera Hardware State (using Canon UI code representation for seamless kiosk.html sync)
    private volatile int currentIso = 96; // ISO 800
    private volatile int currentTv = 112; // 1/125
    private volatile int currentAv = 48;  // f/5.6
    private volatile int currentWb = 0;   // AWB
    private volatile int currentAeMode = 3; // Manual
    private volatile int lastCmdError = 0;

    private Thread workerThread;
    private volatile long lastPermissionRequestMs = 0;

    private final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            String action = intent.getAction();
            if (ACTION_USB_PERMISSION.equals(action)) {
                lastPermissionRequestMs = 0;
                UsbDevice dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                if (granted && dev != null) {
                    showToast("📸 Izin USB Kamera diberikan! Menghubungkan Live View...");
                    connectToDeviceAsync(dev);
                } else if (dev != null && usbManager != null && usbManager.hasPermission(dev)) {
                    connectToDeviceAsync(dev);
                } else {
                    notifyStatus("Izin USB ditolak. Ketuk untuk izin ulang");
                }
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                lastPermissionRequestMs = 0;
                UsbDevice dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                if (dev != null && isSupportedCameraDevice(dev)) {
                    usbPtpAttached = true;
                    showToast("🔌 Kamera USB terdeteksi di OTG!");
                    checkAndConnectDevice(dev);
                } else if (dev != null && isUvcVideoDevice(dev)) {
                    refreshUvcPresence();
                    showToast("📹 Kamera UVC/HDMI terdeteksi: " + usbUvcDeviceName);
                    notifyStatus("📹 USB Video terdeteksi: " + usbUvcDeviceName);
                    if (listener != null) listener.onUsbUvcChanged(true, usbUvcDeviceName);
                }
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                UsbDevice dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                if (dev != null && activeDevice != null && dev.getDeviceId() == activeDevice.getDeviceId()) {
                    showToast("⚠️ Kamera USB terputus.");
                    clearUsbErrorState();
                    usbPtpAttached = false;
                    closeCurrentConnection();
                    refreshUvcPresence();
                    notifyStatus("📱 Mode Kamera Bawaan (Siap USB OTG)");
                } else if (dev != null && isSupportedCameraDevice(dev)) {
                    clearUsbErrorState();
                    usbPtpAttached = false;
                    notifyStatus("📱 Mode Kamera Bawaan (Siap USB OTG)");
                } else if (dev != null && isUvcVideoDevice(dev)) {
                    refreshUvcPresence();
                    if (listener != null) listener.onUsbUvcChanged(usbUvcAttached, usbUvcDeviceName);
                }
            }
        }
    };

    public CanonUsbPtpEngine(Context context) {
        this(context, null);
    }

    public CanonUsbPtpEngine(Context context, Listener listener) {
        this.activityContext = context;
        this.context = context.getApplicationContext();
        this.listener = listener;
        this.usbManager = (UsbManager) this.context.getSystemService(Context.USB_SERVICE);
    }

    public void start() {
        if (isRunning) return;
        isRunning = true;

        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_USB_PERMISSION);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        // IMPORTANT: Must use RECEIVER_EXPORTED (0x00000002) on Android 13/14+ (Xiaomi HyperOS / OneUI)
        // so SystemUI's UsbPermissionActivity can deliver ACTION_USB_PERMISSION broadcasts!
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(usbReceiver, filter, 0x00000002 /* Context.RECEIVER_EXPORTED */);
        } else {
            context.registerReceiver(usbReceiver, filter);
        }

        workerThread = new Thread(this::runMainLoop, "CanonSonyUsbPtpWorker");
        workerThread.setPriority(Thread.MAX_PRIORITY);
        workerThread.start();
    }

    public void stop() {
        isRunning = false;
        try {
            context.unregisterReceiver(usbReceiver);
        } catch (Exception ignored) {}
        closeCurrentConnection();
    }

    public boolean isCameraActive() {
        return hasLiveFrame();
    }

    public boolean isActive() {
        return isConnected;
    }

    public boolean hasLiveFrame() {
        return isConnected && latestLiveViewJpeg != null && latestLiveViewJpeg.length > 256
                && System.currentTimeMillis() - latestFrameTimeMs < 5000;
    }

    public String getLastCaptureError() { return lastCaptureError; }
    public String getLastConnectionError() { return lastConnectionError; }
    public boolean isSonyCamera() { return isSonyCamera; }
    public boolean isUsbPtpAttached() { return usbPtpAttached; }
    public boolean isUsbUvcAttached() { return usbUvcAttached; }
    public String getUsbUvcDeviceName() { return usbUvcDeviceName; }
    public boolean supportsLiveView() { return supportsUsbLiveView; }
    public String getDriverTypeName() {
        switch (driverType) {
            case SONY: return "sony";
            case CANON: return "canon";
            case NIKON: return "nikon";
            case GENERIC_PTP: return "generic_ptp";
            default: return "none";
        }
    }
    public String getLiveViewDiagnostic() {
        if (driverType == DriverType.SONY) return lastSonyDiag;
        if (!supportsUsbLiveView) return "Mode USB Shutter PTP (" + getDriverTypeName() + ")";
        return "Frame: " + totalFramesReceived;
    }

    public long getTotalFramesReceived() {
        return totalFramesReceived;
    }

    public void scanAndConnectIfAvailable() {
        lastPermissionRequestMs = 0; // Reset cooldown on manual tap
        new Thread(() -> {
            synchronized (usbLock) {
                if (isConnected && !hasLiveFrame() && !isCapturingPhoto) closeCurrentConnection();
            }
            clearUsbErrorState();
            scanForCameraDevices();
        }, "UsbCameraScan").start();
    }

    private void clearUsbErrorState() {
        lastConnectionError = "";
        lastConnectionDiagnostic = "";
        lastCaptureError = "";
    }

    public void setIso(String valStr) {
        try { setHardwareProperty("iso", Integer.parseInt(valStr.trim())); } catch (Exception ignored) {}
    }

    public void setShutterSpeed(String valStr) {
        try { setHardwareProperty("tv", Integer.parseInt(valStr.trim())); } catch (Exception ignored) {}
    }

    public void setAperture(String valStr) {
        try { setHardwareProperty("av", Integer.parseInt(valStr.trim())); } catch (Exception ignored) {}
    }

    public void setWhiteBalance(String valStr) {
        try { setHardwareProperty("wb", Integer.parseInt(valStr.trim())); } catch (Exception ignored) {}
    }

    public void driveLensFocus(int stepCode) {
        stepManualFocus(stepCode);
    }

    public String getCameraModelName() {
        return cameraModelName;
    }

    public byte[] getLatestLiveViewJpeg() {
        return latestLiveViewJpeg;
    }

    public int getCurrentIso() { return currentIso; }
    public int getCurrentTv() { return currentTv; }
    public int getCurrentAv() { return currentAv; }
    public int getCurrentWb() { return currentWb; }
    public int getCurrentAeMode() { return currentAeMode; }
    public int getLastCmdError() { return lastCmdError; }

    private void showToast(final String msg) {
        mainHandler.post(() -> Toast.makeText(context, msg, Toast.LENGTH_SHORT).show());
    }

    private void notifyStatus(final String msg) {
        if (listener != null) {
            listener.onStatusMessage(msg);
        }
    }

    private volatile int lastFailedDeviceId = -1;
    private volatile long lastFailureAtMs = 0;

    private boolean isUvcVideoDevice(UsbDevice dev) {
        if (dev == null) return false;
        boolean hasVideo = false;
        for (int i = 0; i < dev.getInterfaceCount(); i++) {
            int cls = dev.getInterface(i).getInterfaceClass();
            if (cls == UsbConstants.USB_CLASS_STILL_IMAGE) return false;
            if (cls == USB_CLASS_VIDEO) hasVideo = true;
        }
        return hasVideo;
    }

    private boolean isSupportedCameraDevice(UsbDevice dev) {
        if (dev == null || isUvcVideoDevice(dev)) return false;
        int vid = dev.getVendorId();
        if (vid == CANON_VENDOR_ID || vid == SONY_VENDOR_ID || vid == NIKON_VENDOR_ID || vid == FUJIFILM_VENDOR_ID) {
            return true;
        }
        for (int i = 0; i < dev.getInterfaceCount(); i++) {
            int cls = dev.getInterface(i).getInterfaceClass();
            if (cls == UsbConstants.USB_CLASS_STILL_IMAGE) {
                return true;
            }
        }
        return false;
    }

    private void refreshUvcPresence() {
        if (usbManager == null) {
            usbUvcAttached = false;
            usbUvcDeviceName = "";
            return;
        }
        HashMap<String, UsbDevice> map = usbManager.getDeviceList();
        if (map != null) {
            for (UsbDevice d : map.values()) {
                if (isUvcVideoDevice(d)) {
                    usbUvcAttached = true;
                    String pName = (Build.VERSION.SDK_INT >= 21 && d.getProductName() != null)
                            ? d.getProductName().trim() : d.getDeviceName();
                    usbUvcDeviceName = pName.isEmpty() ? "USB Video Camera" : pName;
                    return;
                }
            }
        }
        usbUvcAttached = false;
        usbUvcDeviceName = "";
    }

    private void checkAndConnectDevice(final UsbDevice dev) {
        if (dev == null || usbManager == null) return;
        if (usbManager.hasPermission(dev)) {
            if (dev.getDeviceId() == lastFailedDeviceId && System.currentTimeMillis() - lastFailureAtMs < 6000) {
                return;
            }
            connectToDeviceAsync(dev);
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastPermissionRequestMs > 4500) {
            lastPermissionRequestMs = now;
            notifyStatus("🟡 USB Kamera Terdeteksi: Ketuk 'Izinkan/OK' di layar");
            // Execute requestPermission on the Main UI Thread using Activity context so Xiaomi HyperOS / Android 14
            // displays the system USB permission pop-up reliably on Redmi Pad 2!
            mainHandler.post(() -> {
                try {
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                    if (Build.VERSION.SDK_INT >= 31) {
                        flags |= 0x02000000; // PendingIntent.FLAG_MUTABLE
                    }
                    Intent permIntent = new Intent(ACTION_USB_PERMISSION);
                    permIntent.setPackage(context.getPackageName());
                    PendingIntent pi = PendingIntent.getBroadcast(activityContext, 0, permIntent, flags);
                    usbManager.requestPermission(dev, pi);
                } catch (Exception e) {
                    Log.w(TAG, "requestPermission fallback: " + e.getMessage());
                    try {
                        Intent permIntent = new Intent(ACTION_USB_PERMISSION);
                        PendingIntent pi = PendingIntent.getBroadcast(activityContext, 0, permIntent, 0);
                        usbManager.requestPermission(dev, pi);
                    } catch (Exception ignored) {}
                }
            });
        }
    }

    private String getCamera2InventorySummary() {
        try {
            Object mgr = context.getSystemService("camera");
            if (mgr == null) return "";
            Class<?> camMgrCls = Class.forName("android.hardware.camera2.CameraManager");
            String[] ids = (String[]) camMgrCls.getMethod("getCameraIdList").invoke(mgr);
            if (ids == null || ids.length == 0) return "Camera2: 0 kamera terdeteksi";
            Class<?> charsCls = Class.forName("android.hardware.camera2.CameraCharacteristics");
            Object lensFacingKey = charsCls.getField("LENS_FACING").get(null);
            Class<?> keyCls = lensFacingKey.getClass();
            StringBuilder csb = new StringBuilder();
            csb.append("Kamera Android (Camera2: ").append(ids.length).append("): ");
            for (int i = 0; i < ids.length; i++) {
                if (i > 0) csb.append(", ");
                Object chars = camMgrCls.getMethod("getCameraCharacteristics", String.class).invoke(mgr, ids[i]);
                Integer facing = (Integer) charsCls.getMethod("get", keyCls).invoke(chars, lensFacingKey);
                String role = (facing == null) ? "?" : (facing == 0 ? "Depan" : (facing == 1 ? "Belakang" : "Eksternal USB"));
                csb.append("#").append(ids[i]).append("(").append(role).append(")");
            }
            return csb.toString();
        } catch (Throwable ignored) {
            return "";
        }
    }

    public String getUsbDiagnosticsReport() {
        StringBuilder sb = new StringBuilder();
        String cam2Summary = getCamera2InventorySummary();
        if (usbManager == null) return "UsbManager tidak tersedia di perangkat ini.";
        HashMap<String, UsbDevice> map = usbManager.getDeviceList();
        if (map == null || map.isEmpty()) {
            sb.append("📱 Kamera Bawaan: Siap digunakan.\n");
            if (!cam2Summary.isEmpty()) sb.append(cam2Summary).append("\n");
            sb.append("\n🔌 Status Port USB OTG: TIDAK ADA kamera eksternal terpasang (0 perangkat).\n\n")
              .append("Tips menghubungkan kamera eksternal:\n")
              .append("1. Gunakan kabel/adaptor USB-C data (bukan hanya kabel cas).\n")
              .append("2. Sony Alpha (A7 III, dll): Menu Setup -> USB Connection = PC Remote, Ctrl w/ Smartphone = Off.\n")
              .append("3. Canon EOS: nonaktifkan Wi-Fi/NFC sebelum menyambung USB.\n")
              .append("4. Nikon / Fujifilm / Webcam UVC / HDMI Capture: hubungkan langsung lalu tunggu 2 detik.");
            return sb.toString();
        }
        sb.append("🔌 Terdeteksi ").append(map.size()).append(" perangkat di port USB OTG:\n");
        for (UsbDevice d : map.values()) {
            String pName = (Build.VERSION.SDK_INT >= 21 && d.getProductName() != null) ? d.getProductName() : d.getDeviceName();
            boolean hasPerm = usbManager.hasPermission(d);
            boolean uvc = isUvcVideoDevice(d);
            sb.append("• ").append(pName)
              .append(uvc ? " [UVC Video]" : "")
              .append(" (VID: 0x").append(Integer.toHexString(d.getVendorId()).toUpperCase())
              .append(", PID: 0x").append(Integer.toHexString(d.getProductId()).toUpperCase())
              .append(", Izin: ").append(hasPerm ? "SUDAH" : "BELUM").append(")\n");
            for (int i = 0; i < d.getInterfaceCount(); i++) {
                UsbInterface intf = d.getInterface(i);
                sb.append("  Interface ").append(intf.getId()).append(" class=").append(intf.getInterfaceClass()).append(": ");
                for (int e = 0; e < intf.getEndpointCount(); e++) {
                    UsbEndpoint ep = intf.getEndpoint(e);
                    sb.append("ep0x").append(Integer.toHexString(ep.getAddress()))
                      .append(" type=").append(ep.getType()).append(" packet=").append(ep.getMaxPacketSize()).append(" ");
                }
                sb.append("\n");
            }
        }
        if (!cam2Summary.isEmpty()) sb.append("\n").append(cam2Summary);
        if (usbUvcAttached && !cam2Summary.contains("Eksternal USB")) {
            sb.append("\n⚠️ Perangkat USB Video (").append(usbUvcDeviceName)
              .append(") terdeteksi di OTG, namun firmware Android tablet tidak mendaftarkannya ke Camera2 WebView. Untuk kamera DSLR/Mirrorless disarankan kabel USB PTP langsung (PC Remote/Canon EOS).");
        }
        sb.append("\nStatus Sesi PTP: ").append(isConnected ? "TERHUBUNG (" + cameraModelName + ", driver=" + getDriverTypeName() + ")" : "BELUM TERHUBUNG");
        sb.append("\nFrame Live View diterima: ").append(totalFramesReceived);
        if (!lastConnectionError.isEmpty()) sb.append("\nKoneksi: ").append(lastConnectionError);
        if (!lastConnectionDiagnostic.isEmpty()) sb.append("\nDetail USB: ").append(lastConnectionDiagnostic);
        if (!lastCaptureError.isEmpty()) sb.append("\nFoto: ").append(lastCaptureError);
        if (driverType == DriverType.SONY) {
            sb.append("\nSony LiveView Diag: ").append(lastSonyDiag);
        }
        return sb.toString();
    }

    private synchronized void connectToDeviceAsync(final UsbDevice dev) {
        if (isConnecting || (isConnected && activeDevice != null && activeDevice.getDeviceId() == dev.getDeviceId())) return;
        isConnecting = true;
        new Thread(() -> {
            try {
                synchronized (usbLock) {
                    closeCurrentConnection();
                    openPtpConnection(dev);
                }
            } finally {
                isConnecting = false;
            }
        }).start();
    }

    private void runMainLoop() {
        int consecutiveFailures = 0;

        while (isRunning) {
            try {
                if (!isConnected) {
                    scanForCameraDevices();
                    Thread.sleep(1500);
                    continue;
                }

                if (isCapturingPhoto) {
                    Thread.sleep(80);
                    continue;
                }

                if (!supportsUsbLiveView) {
                    synchronized (usbLock) {
                        if (!isConnected || isCapturingPhoto) continue;
                        long now = System.currentTimeMillis();
                        if (now - lastKeepAliveMs > 4000) {
                            sendPtpCommandLocked(PTP_OC_GET_STORAGE_IDS, new int[0], null);
                            lastKeepAliveMs = now;
                        }
                    }
                    Thread.sleep(400);
                    continue;
                }

                byte[] frame = null;
                synchronized (usbLock) {
                    if (!isConnected || isCapturingPhoto) continue;

                    long now = System.currentTimeMillis();
                    if (now - lastKeepAliveMs > 3500) {
                        if (driverType == DriverType.SONY) {
                            executePtpTransactionLocked(PTP_OC_SONY_GET_ALL_EXT_DEVICE_PROP_INFO, new int[0], null, 1500);
                            drainSonyInterruptEventsLocked();
                        } else if (driverType == DriverType.CANON) {
                            sendPtpCommandLocked(PTP_OC_CANON_KEEP_DEVICE_ON, new int[0], null);
                            drainCanonEventsLocked();
                        } else if (driverType == DriverType.NIKON) {
                            sendPtpCommandLocked(PTP_OC_NIKON_CHECK_EVENT, new int[0], null);
                        }
                        lastKeepAliveMs = now;
                    }

                    if (driverType == DriverType.SONY) frame = fetchSonyLiveViewFrameLocked();
                    else if (driverType == DriverType.CANON) frame = fetchCanonLiveViewFrameLocked();
                    else if (driverType == DriverType.NIKON) frame = fetchNikonLiveViewFrameLocked();
                    else if (driverType == DriverType.GENERIC_PTP) frame = fetchFujiLiveViewFrameLocked();
                }

                if (frame != null && frame.length > 512) {
                    boolean wasFirstFrame = (totalFramesReceived == 0);
                    boolean recovered = consecutiveFailures > 0;
                    latestLiveViewJpeg = frame;
                    latestFrameTimeMs = System.currentTimeMillis();
                    totalFramesReceived++;
                    consecutiveFailures = 0;
                    if ((wasFirstFrame || recovered) && listener != null) {
                        listener.onCameraConnected(cameraModelName + " (LIVE)");
                    }
                    Thread.sleep(36); // ~25 FPS smooth Live View
                } else {
                    consecutiveFailures++;
                    if (!hasLiveFrame()) notifyStatus(cameraModelName + ": Live View belum siap. Periksa kabel dan mode USB kamera.");
                    if (consecutiveFailures % 15 == 0) {
                        synchronized (usbLock) {
                            if (isConnected && !isCapturingPhoto) {
                                if (driverType == DriverType.SONY) {
                                    drainBulkInEndpoint();
                                    setSonyExtPropUInt8Locked(SONY_PROP_LIVEVIEW_STATUS, 1);
                                    executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_LIVEVIEW_FRAME}, null, 400);
                                } else if (driverType == DriverType.CANON) {
                                    drainCanonEventsLocked();
                                    enableCanonLiveViewOutputLocked();
                                } else if (driverType == DriverType.NIKON) {
                                    sendPtpCommandLocked(PTP_OC_NIKON_START_LIVEVIEW, new int[0], null);
                                }
                            }
                        }
                    }
                    // Verify physical USB device is still attached before resetting
                    if (consecutiveFailures > 120) {
                        consecutiveFailures = 0;
                        if (activeDevice != null && usbManager != null) {
                            HashMap<String, UsbDevice> devMap = usbManager.getDeviceList();
                            boolean stillPlugged = false;
                            if (devMap != null) {
                                for (UsbDevice d : devMap.values()) {
                                    if (d.getDeviceId() == activeDevice.getDeviceId()) {
                                        stillPlugged = true;
                                        break;
                                    }
                                }
                            }
                            if (!stillPlugged) {
                                closeCurrentConnection();
                            }
                        }
                    }
                    Thread.sleep(80);
                }
            } catch (InterruptedException ie) {
                break;
            } catch (Exception e) {
                Log.e(TAG, "Loop error: " + e.getMessage());
                try { Thread.sleep(250); } catch (InterruptedException ignored) {}
            }
        }
    }

    private void scanForCameraDevices() {
        if (usbManager == null) return;
        HashMap<String, UsbDevice> map = usbManager.getDeviceList();
        boolean prevUvc = usbUvcAttached;
        refreshUvcPresence();
        if (prevUvc != usbUvcAttached && listener != null) {
            listener.onUsbUvcChanged(usbUvcAttached, usbUvcDeviceName);
        }
        if (map == null || map.isEmpty()) {
            usbPtpAttached = false;
            clearUsbErrorState();
            notifyStatus("📱 Kamera Bawaan (Siap USB OTG)");
            return;
        }
        for (UsbDevice dev : map.values()) {
            if (isSupportedCameraDevice(dev)) {
                usbPtpAttached = true;
                checkAndConnectDevice(dev);
                return;
            }
        }
        usbPtpAttached = false;
        clearUsbErrorState();
        if (usbUvcAttached) {
            notifyStatus("📹 USB Video: " + usbUvcDeviceName);
        } else {
            notifyStatus("USB OTG (" + map.size() + " alat, bukan kamera PTP)");
        }
    }

    private static final class BulkPtpInterface {
        UsbInterface iface;
        UsbEndpoint epOut;
        UsbEndpoint epIn;
        UsbEndpoint epInt;
    }

    private BulkPtpInterface findBulkPtpInterface(UsbDevice dev) {
        for (int pass = 0; pass < 2; pass++) {
            int wantClass = (pass == 0) ? UsbConstants.USB_CLASS_STILL_IMAGE : 255;
            for (int i = 0; i < dev.getInterfaceCount(); i++) {
                UsbInterface candidate = dev.getInterface(i);
                if (candidate.getInterfaceClass() != wantClass) continue;
                UsbEndpoint out = null;
                UsbEndpoint in = null;
                UsbEndpoint intr = null;
                for (int e = 0; e < candidate.getEndpointCount(); e++) {
                    UsbEndpoint ep = candidate.getEndpoint(e);
                    if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                        if (ep.getDirection() == UsbConstants.USB_DIR_OUT && out == null) out = ep;
                        else if (ep.getDirection() == UsbConstants.USB_DIR_IN && in == null) in = ep;
                    } else if (ep.getType() == 3 && ep.getDirection() == UsbConstants.USB_DIR_IN && intr == null) {
                        // Type 3 = USB_ENDPOINT_XFER_INT; Sony pushes 0xC201 ObjectAdded events here.
                        intr = ep;
                    }
                }
                if (out != null && in != null) {
                    BulkPtpInterface match = new BulkPtpInterface();
                    match.iface = candidate;
                    match.epOut = out;
                    match.epIn = in;
                    match.epInt = intr;
                    return match;
                }
            }
        }
        return null;
    }

    private void openPtpConnection(UsbDevice dev) {
        lastTransportDiagnostic = "";
        usbPtpAttached = true;
        try {
            BulkPtpInterface ptpIf = findBulkPtpInterface(dev);
            if (ptpIf == null) {
                throw new IOException("Mode USB kamera belum mendukung PTP. Sony: pilih PC Remote lalu sambungkan ulang kabel.");
            }
            UsbInterface targetIf = ptpIf.iface;
            UsbEndpoint bulkOut = ptpIf.epOut;
            UsbEndpoint bulkIn = ptpIf.epIn;

            UsbDeviceConnection conn = usbManager.openDevice(dev);
            if (conn == null) throw new IOException("Akses USB belum diberikan. Izinkan kamera USB di Android.");

            if (!conn.claimInterface(targetIf, true)) {
                conn.close();
                throw new IOException("Kamera sedang dipakai aplikasi lain. Tutup aplikasi kamera lain.");
            }

            this.activeDevice = dev;
            this.connection = conn;
            this.ptpInterface = targetIf;
            this.epOut = bulkOut;
            this.epIn = bulkIn;
            this.epInt = ptpIf.epInt;
            this.transactionId = 0;
            this.totalFramesReceived = 0;
            this.isSonyCamera = (dev.getVendorId() == SONY_VENDOR_ID);
            this.driverType = this.isSonyCamera ? DriverType.SONY
                    : (dev.getVendorId() == CANON_VENDOR_ID ? DriverType.CANON
                    : (dev.getVendorId() == NIKON_VENDOR_ID ? DriverType.NIKON : DriverType.GENERIC_PTP));
            this.supportsUsbLiveView = true;

            String prodName = (Build.VERSION.SDK_INT >= 21 && dev.getProductName() != null)
                    ? dev.getProductName().trim()
                    : "";
            if (prodName.isEmpty() || "Canon Digital Camera".equalsIgnoreCase(prodName)) {
                if (isSonyCamera) this.cameraModelName = "Sony Alpha A7 III";
                else if (dev.getVendorId() == CANON_VENDOR_ID) this.cameraModelName = "Canon EOS 1300D";
                else if (dev.getVendorId() == NIKON_VENDOR_ID) this.cameraModelName = "Nikon Camera (USB)";
                else if (dev.getVendorId() == FUJIFILM_VENDOR_ID) this.cameraModelName = "Fujifilm Camera (USB)";
                else this.cameraModelName = "Kamera USB (PTP)";
            } else {
                this.cameraModelName = prodName;
            }

            notifyStatus("Menghubungkan " + cameraModelName + " melalui USB...");
            // OpenSession first: ISO 15740 uses TransactionID = 0, with automatic fallback to TransactionID = 1
            // and USB PIMA Device Reset if an earlier host/MTP session left the camera pipe busy.
            int rc = openCameraSessionLocked();
            requirePtpOk(rc, "Membuka sesi kamera");

            if (isSonyCamera) {
                initSonyDriverLocked();
            } else if (dev.getVendorId() == CANON_VENDOR_ID) {
                initCanonDriverLocked();
            } else {
                initAutoDetectedPtpDriverLocked();
            }

            this.isConnected = true;
            this.lastFailedDeviceId = -1;
            this.lastFailureAtMs = 0;
            lastConnectionError = "";
            lastConnectionDiagnostic = "";
            if (!supportsUsbLiveView && listener != null) {
                listener.onCameraConnected(cameraModelName);
            }
            notifyStatus(this.cameraModelName + (supportsUsbLiveView ? ": Sesi USB siap, menunggu Live View..." : ": Siap memotret via USB PTP"));
            Log.i(TAG, "USB PTP Session Connected: " + this.cameraModelName + " (Driver=" + driverType + ", LiveView=" + supportsUsbLiveView + ")");
        } catch (Exception e) {
            Log.e(TAG, "Failed to open USB PTP connection", e);
            this.lastFailedDeviceId = dev.getDeviceId();
            this.lastFailureAtMs = System.currentTimeMillis();
            lastConnectionDiagnostic = lastTransportDiagnostic;
            closeCurrentConnection();
            lastConnectionError = e.getMessage() == null ? "Koneksi kamera gagal." : e.getMessage();
            notifyStatus(lastConnectionError);
        }
    }

    private void initSonyDriverLocked() throws IOException {
        driverType = DriverType.SONY;
        isSonyCamera = true;
        supportsUsbLiveView = true;
        drainBulkInEndpoint();
        int rc1 = sendPtpCommandLocked(PTP_OC_SONY_SDIO_CONNECT, new int[]{1, 0, 0}, null);
        if (rc1 == PTP_RC_OPERATION_NOT_SUPPORTED || rc1 == PTP_RC_PARAMETER_NOT_SUPPORTED) {
            throw new IOException("Kamera Sony belum di mode PC Remote (saat ini MTP/Auto). Buka Menu Kamera -> Setup -> USB Connection -> ubah ke 'PC Remote', lalu colok ulang USB.");
        }
        requirePtpOk(rc1, "Sony PC Remote tahap 1");
        requirePtpOk(sendPtpCommandLocked(PTP_OC_SONY_SDIO_CONNECT, new int[]{2, 0, 0}, null), "Sony PC Remote tahap 2");
        int extRc = sendPtpCommandLocked(PTP_OC_SONY_SDIO_GET_EXT_DEVICE_INFO, new int[]{0x00C8}, null);
        if (extRc != PTP_RC_OK) {
            extRc = sendPtpCommandLocked(PTP_OC_SONY_SDIO_GET_EXT_DEVICE_INFO, new int[]{0x012C}, null);
        }
        requirePtpOk(extRc, "Informasi Sony PC Remote");
        requirePtpOk(sendPtpCommandLocked(PTP_OC_SONY_SDIO_CONNECT, new int[]{3, 0, 0}, null), "Sony PC Remote tahap 3");
        requirePtpOk(sendPtpCommandLocked(PTP_OC_SONY_GET_ALL_EXT_DEVICE_PROP_INFO, new int[0], null), "Status Sony PC Remote");

        // Arm Sony Alpha LiveView virtual stream handle (0xFFFFC002)
        setSonyExtPropUInt8Locked(SONY_PROP_LIVEVIEW_STATUS, 1);
        executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_LIVEVIEW_FRAME}, null, 600);
    }

    private void initCanonDriverLocked() throws IOException {
        driverType = DriverType.CANON;
        isSonyCamera = false;
        supportsUsbLiveView = true;
        requirePtpOk(sendPtpCommandLocked(PTP_OC_CANON_SET_REMOTE_MODE, new int[]{1}, null), "Canon Remote Mode");
        requirePtpOk(sendPtpCommandLocked(PTP_OC_CANON_SET_EVENT_MODE, new int[]{1}, null), "Canon Event Mode");
        try { Thread.sleep(80); } catch (InterruptedException ignored) {}
        drainCanonEventsLocked();
        drainCanonEventsLocked();
        if (setCanonPropExLocked(PROP_CAPTURE_DESTINATION, 4) != PTP_RC_OK) {
            if (setCanonPropExLocked(PROP_CAPTURE_DESTINATION, 2) != PTP_RC_OK) {
                requirePtpOk(setCanonPropExLocked(PROP_CAPTURE_DESTINATION, 6), "Tujuan penyimpanan foto Canon");
            }
        }
        drainCanonEventsLocked();
        enableCanonLiveViewOutputLocked();
    }

    private void initAutoDetectedPtpDriverLocked() throws IOException {
        PtpDeviceInfo info = fetchDeviceInfoLocked();
        if (info != null && !info.model.isEmpty() && cameraModelName.endsWith("(PTP)")) {
            cameraModelName = info.model;
        }
        if (info != null && (info.ops.contains(PTP_OC_CANON_SET_REMOTE_MODE) || info.ops.contains(PTP_OC_CANON_GET_VIEWFINDER_DATA))) {
            initCanonDriverLocked();
            return;
        }
        if (info != null && (info.manufacturer.toLowerCase().contains("sony") || (info.ops.contains(PTP_OC_SONY_SDIO_CONNECT) && !info.ops.contains(PTP_OC_NIKON_CHECK_EVENT)))) {
            initSonyDriverLocked();
            return;
        }
        if (driverType == DriverType.NIKON || (info != null && info.ops.contains(PTP_OC_NIKON_GET_LIVEVIEW_IMG))) {
            driverType = DriverType.NIKON;
            isSonyCamera = false;
            int lvRc = sendPtpCommandLocked(PTP_OC_NIKON_START_LIVEVIEW, new int[0], null);
            supportsUsbLiveView = (lvRc == PTP_RC_OK);
            return;
        }
        driverType = DriverType.GENERIC_PTP;
        isSonyCamera = false;
        PtpTransactionResult fujiProbe = executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{FUJI_HANDLE_LIVEVIEW_FRAME}, null, 500);
        supportsUsbLiveView = (fujiProbe != null && fujiProbe.responseCode == PTP_RC_OK);
    }

    private int openCameraSessionLocked() {
        String firstOpenDiagnostic = "";
        int rc = attemptOpenSessionWithTidLocked(0, 1600);
        if (rc == PTP_RC_OK) return rc;
        firstOpenDiagnostic = lastTransportDiagnostic;

        if (rc == PTP_RC_SESSION_ALREADY_OPEN) {
            sendPtpCommandLocked(PTP_OC_CLOSE_SESSION, new int[0], null);
            rc = attemptOpenSessionWithTidLocked(0, 2000);
            if (rc == PTP_RC_OK) return rc;
        } else if (rc < 0) {
            try { Thread.sleep(200); } catch (InterruptedException ignored) {}
            drainBulkInEndpoint();
            rc = attemptOpenSessionWithTidLocked(0, 1800);
            if (rc == PTP_RC_OK) return rc;
            if (rc == PTP_RC_SESSION_ALREADY_OPEN) {
                sendPtpCommandLocked(PTP_OC_CLOSE_SESSION, new int[0], null);
                rc = attemptOpenSessionWithTidLocked(0, 2000);
                if (rc == PTP_RC_OK) return rc;
            }
        }

        // Fallback for Sony ILCE / camera firmware expecting TransactionID = 1 on OpenSession
        if (rc < 0 || rc == PTP_RC_INVALID_TRANSACTION_ID || rc == PTP_RC_OPERATION_NOT_SUPPORTED || rc == PTP_RC_PARAMETER_NOT_SUPPORTED) {
            drainBulkInEndpoint();
            int rc1 = attemptOpenSessionWithTidLocked(1, 2200);
            if (rc1 == PTP_RC_OK) return rc1;
            if (rc1 == PTP_RC_SESSION_ALREADY_OPEN) {
                sendPtpCommandLocked(PTP_OC_CLOSE_SESSION, new int[0], null);
                int reopened1 = attemptOpenSessionWithTidLocked(1, 2200);
                if (reopened1 == PTP_RC_OK) return reopened1;
                rc1 = reopened1;
            }
            if (rc1 > 0) rc = rc1;
        }

        // Final recovery: USB PIMA 15740 Device Reset + Clear Endpoint Halt for stuck Android MTP state
        if (rc < 0) {
            sendUsbPtpDeviceResetLocked();
            try { Thread.sleep(300); } catch (InterruptedException ignored) {}
            drainBulkInEndpoint();
            int rcReset0 = attemptOpenSessionWithTidLocked(0, 2200);
            if (rcReset0 == PTP_RC_OK) return rcReset0;
            if (rcReset0 < 0 || rcReset0 == PTP_RC_INVALID_TRANSACTION_ID) {
                int rcReset1 = attemptOpenSessionWithTidLocked(1, 2200);
                if (rcReset1 == PTP_RC_OK) return rcReset1;
                if (rcReset1 > 0) rc = rcReset1;
            } else {
                rc = rcReset0;
            }
        }

        if (!firstOpenDiagnostic.isEmpty() && !firstOpenDiagnostic.equals(lastTransportDiagnostic)) {
            lastTransportDiagnostic = firstOpenDiagnostic + " | retry: " + lastTransportDiagnostic;
        }
        return rc;
    }

    private int attemptOpenSessionWithTidLocked(int tid, int timeoutMs) {
        transactionId = tid;
        PtpTransactionResult result = executePtpTransactionLocked(PTP_OC_OPEN_SESSION, new int[]{1}, null, timeoutMs);
        return result == null ? -1 : result.responseCode;
    }

    private void sendUsbPtpDeviceResetLocked() {
        if (connection == null || ptpInterface == null) return;
        try {
            if (epIn != null) connection.controlTransfer(0x02, 0x01, 0, epIn.getAddress(), null, 0, 500);
            if (epOut != null) connection.controlTransfer(0x02, 0x01, 0, epOut.getAddress(), null, 0, 500);
            connection.controlTransfer(0x21, 0x66, 0, ptpInterface.getId(), null, 0, 1000);
        } catch (Throwable ignored) {}
    }

    private void requirePtpOk(int rc, String action) throws IOException {
        if (rc != PTP_RC_OK) {
            String detail = rc < 0
                    ? ("USB tidak merespons lengkap" + (lastTransportDiagnostic.isEmpty() ? "" : " [" + lastTransportDiagnostic + "]"))
                    : ("PTP 0x" + Integer.toHexString(rc));
            String tip;
            if (driverType == DriverType.SONY || isSonyCamera) {
                tip = "Sony: pastikan Menu -> Setup -> USB Connection = PC Remote, lalu sambungkan ulang USB.";
            } else if (driverType == DriverType.CANON) {
                tip = "Canon: nonaktifkan Wi-Fi/NFC lalu sambungkan ulang USB.";
            } else {
                tip = "Periksa mode USB kamera dan kabel OTG data.";
            }
            throw new IOException(action + " gagal (" + detail + "). " + tip);
        }
    }

    private void enableCanonLiveViewOutputLocked() {
        // 1. Enable EVF Mode = 1 and drain events so the mirror flips up cleanly on Canon EOS 1300D
        setCanonPropExLocked(PROP_EVF_MODE, 1);
        try { Thread.sleep(140); } catch (InterruptedException ignored) {}
        drainCanonEventsLocked();

        // 2. Enable EVF Output Device = 2 (PC) or 3 (PC + Camera LCD)
        int rcOut = setCanonPropExLocked(PROP_EVF_OUTPUT_DEVICE, 2);
        if (rcOut != PTP_RC_OK) {
            setCanonPropExLocked(PROP_EVF_OUTPUT_DEVICE, 3);
        }
        try { Thread.sleep(160); } catch (InterruptedException ignored) {}
        drainCanonEventsLocked();

        // 3. Also send InitiateViewfinder (0x9151) for EOS bodies that require explicit EVF start
        sendPtpCommandLocked(PTP_OC_CANON_INITIATE_VIEWFINDER, new int[0], null);
        drainCanonEventsLocked();
    }

    private void closeCurrentConnection() {
        synchronized (usbLock) {
            boolean wasConnected = isConnected;
            isConnected = false;
            driverType = DriverType.NONE;
            supportsUsbLiveView = true;
            latestLiveViewJpeg = null;
            latestFrameTimeMs = 0;
            lastCapturedFullJpeg = null;
            totalFramesReceived = 0;
            if (wasConnected && listener != null) {
                listener.onCameraDisconnected();
            }
            if (connection != null) {
                try {
                    if (ptpInterface != null) {
                        connection.releaseInterface(ptpInterface);
                    }
                } catch (Exception ignored) {}
                try {
                    connection.close();
                } catch (Exception ignored) {}
            }
            connection = null;
            ptpInterface = null;
            epOut = null;
            epIn = null;
            epInt = null;
            activeDevice = null;
        }
    }

    /**
     * Sets ISO, Shutter Speed (Tv), Aperture (Av), or White Balance (WB) from the Web Kiosk UI.
     * Works transparently for both Canon EOS 1300D and Sony Alpha A7 III!
     */
    public boolean setHardwareProperty(String propName, int val) {
        synchronized (usbLock) {
            if (!isConnected) return false;
            if (driverType != DriverType.SONY && driverType != DriverType.CANON) return false;

            if ("iso".equalsIgnoreCase(propName)) {
                currentIso = val;
                if (isSonyCamera) {
                    int sonyIso = mapCanonIsoToSony(val);
                    int rc = setSonyExtPropUInt32Locked(SONY_PROP_ISO, sonyIso);
                    lastCmdError = (rc == PTP_RC_OK) ? 0 : rc;
                    return rc == PTP_RC_OK;
                } else {
                    int rc = setCanonPropExLocked(PROP_ISO, val);
                    lastCmdError = (rc == PTP_RC_OK) ? 0 : rc;
                    drainCanonEventsLocked();
                    return rc == PTP_RC_OK;
                }
            } else if ("tv".equalsIgnoreCase(propName)) {
                currentTv = val;
                if (isSonyCamera) {
                    int sonyTv = mapCanonTvToSony(val);
                    int rc = setSonyExtPropUInt32Locked(SONY_PROP_SHUTTER_SPEED, sonyTv);
                    lastCmdError = (rc == PTP_RC_OK) ? 0 : rc;
                    return rc == PTP_RC_OK;
                } else {
                    int rc = setCanonPropExLocked(PROP_SHUTTER_SPEED, val);
                    lastCmdError = (rc == PTP_RC_OK) ? 0 : rc;
                    drainCanonEventsLocked();
                    return rc == PTP_RC_OK;
                }
            } else if ("av".equalsIgnoreCase(propName)) {
                currentAv = val;
                if (isSonyCamera) {
                    int sonyAv = mapCanonAvToSony(val);
                    int rc = setSonyExtPropUInt16Locked(SONY_PROP_APERTURE, sonyAv);
                    lastCmdError = (rc == PTP_RC_OK) ? 0 : rc;
                    return rc == PTP_RC_OK;
                } else {
                    int rc = setCanonPropExLocked(PROP_APERTURE, val);
                    lastCmdError = (rc == PTP_RC_OK) ? 0 : rc;
                    drainCanonEventsLocked();
                    return rc == PTP_RC_OK;
                }
            } else if ("wb".equalsIgnoreCase(propName)) {
                currentWb = val;
                if (isSonyCamera) {
                    int sonyWb = mapCanonWbToSony(val);
                    int rc = setSonyExtPropUInt16Locked(SONY_PROP_WHITE_BALANCE, sonyWb);
                    lastCmdError = (rc == PTP_RC_OK) ? 0 : rc;
                    return rc == PTP_RC_OK;
                } else {
                    int rc = setCanonPropExLocked(PROP_WHITE_BALANCE, val);
                    lastCmdError = (rc == PTP_RC_OK) ? 0 : rc;
                    drainCanonEventsLocked();
                    return rc == PTP_RC_OK;
                }
            }
            return false;
        }
    }

    public boolean triggerAutoFocus() {
        synchronized (usbLock) {
            if (!isConnected) return false;
            if (isSonyCamera) {
                sendSonyControlUInt16Locked(SONY_CTRL_HALF_PRESS_SHUTTER, 2);
                try { Thread.sleep(320); } catch (InterruptedException ignored) {}
                sendSonyControlUInt16Locked(SONY_CTRL_HALF_PRESS_SHUTTER, 1);
                return true;
            } else if (driverType == DriverType.CANON) {
                int rc = sendPtpCommandLocked(PTP_OC_CANON_DO_AF, new int[0], null);
                if (rc != PTP_RC_OK) {
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_ON, new int[]{1, 0}, null);
                    try { Thread.sleep(280); } catch (InterruptedException ignored) {}
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_OFF, new int[]{1}, null);
                }
                drainCanonEventsLocked();
                return true;
            }
            return false;
        }
    }

    public boolean stepManualFocus(int stepCode) {
        synchronized (usbLock) {
            if (!isConnected) return false;
            if (isSonyCamera) {
                short sonyStep = 1;
                if (stepCode == 1) sonyStep = -1;
                else if (stepCode == 3) sonyStep = -3;
                else if (stepCode == 32769) sonyStep = 1;
                else if (stepCode == 32771) sonyStep = 3;
                setSonyExtPropUInt16Locked(SONY_PROP_FOCUS_MODE, 1);
                int rc = sendSonyControlUInt16Locked(SONY_CTRL_NEAR_FAR_FOCUS, sonyStep & 0xFFFF);
                return rc == PTP_RC_OK;
            } else if (driverType == DriverType.CANON) {
                int rc = sendPtpCommandLocked(PTP_OC_CANON_DRIVE_LENS, new int[]{stepCode}, null);
                drainCanonEventsLocked();
                return rc == PTP_RC_OK;
            }
            return false;
        }
    }

    /**
     * Triggers the physical shutter over USB (Sony Alpha, Canon EOS, Nikon, or generic PTP camera).
     * Fires the Hotshoe X-Sync pin (Godox CT-16 Flash), downloads the captured JPEG, and resumes Live View.
     */
    public byte[] capturePhotoWithFlash() {
        synchronized (usbLock) {
            lastCaptureError = "";
            lastCapturedFullJpeg = null;
            if (!isConnected) {
                lastCaptureError = "Kamera USB belum siap. Periksa kabel atau ganti ke Kamera Bawaan.";
                return null;
            }
            isCapturingPhoto = true;
            try {
                if (driverType == DriverType.SONY || isSonyCamera) {
                    return captureSonyPhotoWithFlashLocked();
                } else if (driverType == DriverType.CANON) {
                    return captureCanonPhotoWithFlashLocked();
                } else {
                    return captureGenericOrNikonPhotoLocked();
                }
            } finally {
                isCapturingPhoto = false;
            }
        }
    }

    private byte[] captureCanonPhotoWithFlashLocked() {
        lastCapturedFullJpeg = null;

        try {
            // 1. Fully drop the reflex mirror into optical viewfinder mode:
            // On EOS 1300D (Rebel T6), Canon firmware forcibly disables the center hotshoe pin
            // (Godox CT-16) while Live View is active.
            // Setting EVF Output Device to 0 AND EVF Mode to 0 drops the mirror completely so
            // the hotshoe center sync contact connects directly to the mechanical shutter!
            setCanonPropExLocked(PROP_EVF_OUTPUT_DEVICE, 0);
            setCanonPropExLocked(PROP_EVF_MODE, 0);
            sendPtpCommandLocked(PTP_OC_CANON_TERMINATE_VIEWFINDER, new int[0], null);
            Thread.sleep(400); // 400ms ensures mechanical mirror drops completely into resting position
            drainCanonEventsLocked();

            // 2. Fire physical mechanical shutter with flash sync:
            // PTP_OC_CANON_CAPTURE (0x910F) is Canon's native remote release command (TakePicture).
            int rc = sendPtpCommandLocked(PTP_OC_CANON_CAPTURE, new int[0], null);
            if (rc != PTP_RC_OK) {
                // Fallback A: Immediate release with No-AF (3, 1)
                rc = sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_ON, new int[]{3, 1}, null);
                if (rc == PTP_RC_OK) {
                    Thread.sleep(150);
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_OFF, new int[]{3}, null);
                } else {
                    // Fallback B: Half-press (1, 1) + Full-press (2, 1) without AF wait
                    requirePtpOk(sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_ON, new int[]{1, 1}, null), "Fokus Canon");
                    Thread.sleep(100);
                    requirePtpOk(sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_ON, new int[]{2, 1}, null), "Shutter Canon");
                    Thread.sleep(180);
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_OFF, new int[]{2}, null);
                    Thread.sleep(50);
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_OFF, new int[]{1}, null);
                }
            }

            // 3. Poll Canon events for up to 2.5 seconds to download the newly captured JPEG object
            long deadline = System.currentTimeMillis() + 10000;
            while (System.currentTimeMillis() < deadline && lastCapturedFullJpeg == null) {
                int objHandle = pollCanonTransferObjectHandleLocked();
                if (objHandle != 0) {
                    byte[] fullJpeg = downloadCanonObjectJpegLocked(objHandle);
                    if (fullJpeg != null && fullJpeg.length > 2048) {
                        lastCapturedFullJpeg = fullJpeg;
                        break;
                    }
                }
                Thread.sleep(90);
            }
        } catch (Exception e) {
            Log.w(TAG, "Canon capture error: " + e.getMessage());
            lastCaptureError = "Foto Canon gagal: " + e.getMessage();
        } finally {
            // 4. Immediately resume Live View for the next pose
            try { Thread.sleep(300); } catch (InterruptedException ignored) {}
            enableCanonLiveViewOutputLocked();
            lastKeepAliveMs = System.currentTimeMillis();
        }

        if (lastCapturedFullJpeg != null && lastCapturedFullJpeg.length > 2048) {
            return lastCapturedFullJpeg;
        }
        if (lastCaptureError.isEmpty()) lastCaptureError = "Foto asli Canon belum diterima. Periksa format JPEG dan coba lagi.";
        return null;
    }

    private byte[] captureSonyPhotoWithFlashLocked() {
        lastCapturedFullJpeg = null;
        boolean shutterAttempted = false;
        boolean photoPending = false;

        try {
            // Drain only the Interrupt IN queue before shutter; avoid issuing Bulk IN drains on a clean LV pipe.
            drainSonyInterruptEventsLocked();

            // 1. Half-press to trigger AF/AE lock (2 = Down) with generous timeout for lens focusing.
            shutterAttempted = true;
            requirePtpOk(sendSonyControlUInt16Locked(SONY_CTRL_HALF_PRESS_SHUTTER, 2), "Fokus Sony");
            Thread.sleep(200);

            // 2. Full-press to release shutter and fire Godox flash via Hotshoe X-sync (2 = Down)
            requirePtpOk(sendSonyControlUInt16Locked(SONY_CTRL_CAPTURE_SHUTTER, 2), "Shutter Sony");
            photoPending = true;
            Thread.sleep(200);

            // 3. Release buttons cleanly with staggering (1 = Up)
            requirePtpOk(sendSonyControlUInt16Locked(SONY_CTRL_CAPTURE_SHUTTER, 1), "Melepas shutter Sony");
            Thread.sleep(100);
            requirePtpOk(sendSonyControlUInt16Locked(SONY_CTRL_HALF_PRESS_SHUTTER, 1), "Melepas fokus Sony");
            shutterAttempted = false;

            // 4. Passive post-shutter readout window (avoid Bulk IN/OUT storm while BIONZ writes 24MP JPEG):
            // listen passively on USB Interrupt IN for 0xC201 (ObjectAdded 0xFFFFC001) up to ~900ms.
            boolean eventReady = waitForSonyInterruptReadyLocked(900);

            // 5. Wait for readiness via Interrupt IN (0xC201), property 0xD215 (ObjectInMemory >= 0x8000),
            // or gentle GetObjectInfo(0xFFFFC001) fallback with generous 2500ms timeout.
            long pollStartMs = System.currentTimeMillis();
            long deadline = pollStartMs + 12000;
            boolean skippedNonJpeg = false;

            while (System.currentTimeMillis() < deadline) {
                if (!eventReady) {
                    int ev = pollSonyInterruptEventLocked(120);
                    if (ev == PTP_EC_SONY_OBJECT_ADDED || ev == PTP_EC_OBJECT_ADDED || ev == PTP_EC_CAPTURE_COMPLETE) {
                        eventReady = true;
                    }
                }

                int inMemoryFlag = -1;
                if (!eventReady) {
                    PtpTransactionResult propsRes = executePtpTransactionLocked(
                            PTP_OC_SONY_GET_ALL_EXT_DEVICE_PROP_INFO, new int[0], null, 2000);
                    if (propsRes != null && propsRes.responseCode == PTP_RC_OK && propsRes.dataPayload != null) {
                        inMemoryFlag = findSonyObjectInMemoryFlag(propsRes.dataPayload);
                        if (inMemoryFlag >= 0x8000) {
                            eventReady = true;
                        }
                    }
                }

                boolean allowObjectInfoProbe = eventReady
                        || inMemoryFlag < 0
                        || (System.currentTimeMillis() - pollStartMs) >= 3000;

                if (allowObjectInfoProbe) {
                    PtpTransactionResult infoRes = executePtpTransactionLocked(
                            PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_IN_MEMORY_IMAGE}, null, 2500);
                    if (infoRes != null && infoRes.responseCode == PTP_RC_OK) {
                        if (infoRes.dataPayload == null || infoRes.dataPayload.length < 12) {
                            throw new IOException("Informasi foto Sony tidak lengkap.");
                        }
                        int objectFormat = readShortLE(infoRes.dataPayload, 4) & 0xffff;
                        long compressedSize = readIntLE(infoRes.dataPayload, 8) & 0xffffffffL;
                        if (compressedSize == 0xffffffffL) compressedSize = 0;
                        if (compressedSize > 64L * 1024 * 1024) {
                            throw new IOException("Ukuran foto Sony melebihi 64 MB. Pilih format JPEG.");
                        }

                        PtpTransactionResult imgRes = executePtpTransactionLocked(
                                PTP_OC_GET_OBJECT, new int[]{SONY_HANDLE_IN_MEMORY_IMAGE}, null, 25000);
                        requirePtpOk(imgRes == null ? -1 : imgRes.responseCode, "Mengunduh foto Sony");

                        if (objectFormat != 0x3801) {
                            // If Sony was left in RAW+JPEG, consume the non-JPEG object once so JPEG follows without stalling FIFO.
                            if (!skippedNonJpeg) {
                                skippedNonJpeg = true;
                                eventReady = false;
                                Thread.sleep(250);
                                continue;
                            }
                            throw new IOException("Foto bukan JPEG. Pilih JPEG atau RAW+JPEG dengan transfer JPEG Only.");
                        }
                        if (imgRes.dataPayload == null || (compressedSize > 0 && imgRes.dataPayload.length != compressedSize)) {
                            throw new IOException("Unduhan foto Sony tidak lengkap. Periksa kabel USB-C data.");
                        }
                        lastCapturedFullJpeg = extractJpegFromBuffer(imgRes.dataPayload);
                        if (lastCapturedFullJpeg == null || lastCapturedFullJpeg.length <= 2048) {
                            throw new IOException("Foto JPEG Sony tidak lengkap. Coba ambil ulang.");
                        }
                        photoPending = false;
                        break;
                    }
                }
                eventReady = false;
                Thread.sleep(350);
            }
            drainSonyInterruptEventsLocked();

        } catch (Exception e) {
            Log.w(TAG, "Sony capture error: " + e.getMessage());
            lastCaptureError = "Foto Sony gagal: " + e.getMessage();
            lastCapturedFullJpeg = null;
        } finally {
            // Release even if AF, shutter or USB transfer failed midway.
            if (shutterAttempted) {
                sendSonyControlUInt16Locked(SONY_CTRL_CAPTURE_SHUTTER, 1);
                sendSonyControlUInt16Locked(SONY_CTRL_HALF_PRESS_SHUTTER, 1);
            }
            if (photoPending) {
                // Polite CloseSession before dropping USB prevents Sony firmware panic/reboot on aborted transfer.
                try {
                    sendPtpCommandLocked(PTP_OC_CLOSE_SESSION, new int[0], null);
                    Thread.sleep(80);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                }
                closeCurrentConnection();
            } else {
                try { Thread.sleep(200); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
                setSonyExtPropUInt8Locked(SONY_PROP_LIVEVIEW_STATUS, 1);
                executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_LIVEVIEW_FRAME}, null, 800);
            }
            lastKeepAliveMs = System.currentTimeMillis();
        }

        if (lastCapturedFullJpeg != null && lastCapturedFullJpeg.length > 2048) {
            return lastCapturedFullJpeg;
        }
        if (lastCaptureError.isEmpty()) lastCaptureError = "Foto asli Sony belum diterima. Periksa JPEG, PC Remote, lalu ambil ulang pose ini.";
        return null;
    }

    private int pollSonyInterruptEventLocked(int timeoutMs) {
        if (connection == null || epInt == null) return 0;
        int maxPacket = Math.max(64, Math.min(epInt.getMaxPacketSize(), 512));
        byte[] buf = new byte[maxPacket];
        int n = connection.bulkTransfer(epInt, buf, buf.length, Math.max(1, timeoutMs));
        if (n < 8) return 0;
        int containerType = readShortLE(buf, 4) & 0xFFFF;
        if (containerType != 4) return 0;
        return readShortLE(buf, 6) & 0xFFFF;
    }

    private void drainSonyInterruptEventsLocked() {
        if (connection == null || epInt == null) return;
        for (int i = 0; i < 8; i++) {
            if (pollSonyInterruptEventLocked(5) == 0) break;
        }
    }

    private boolean waitForSonyInterruptReadyLocked(int totalMs) throws InterruptedException {
        if (connection == null || epInt == null) {
            Thread.sleep(totalMs);
            return false;
        }
        long endMs = System.currentTimeMillis() + totalMs;
        while (true) {
            long rem = endMs - System.currentTimeMillis();
            if (rem <= 0) return false;
            long t0 = System.currentTimeMillis();
            int ev = pollSonyInterruptEventLocked((int) Math.min(150L, rem));
            if (ev == PTP_EC_SONY_OBJECT_ADDED || ev == PTP_EC_OBJECT_ADDED || ev == PTP_EC_CAPTURE_COMPLETE) {
                return true;
            }
            long elapsed = System.currentTimeMillis() - t0;
            if (elapsed < 40) {
                long nap = Math.min(rem, 150L) - elapsed;
                if (nap > 0) Thread.sleep(nap);
            }
        }
    }

    /** Returns Sony 0xD215 (ObjectInMemory) flag from 0x9209 payload, or -1 if absent/unrecognized. */
    private static int findSonyObjectInMemoryFlag(byte[] data) {
        if (data == null || data.length < 16) return -1;
        int propCount = readIntLE(data, 0);
        if (propCount <= 0 || propCount > 512) return -1;
        int pos = 8; // Sony 0x9209 prefixes properties with UINT64 count
        for (int i = 0; i < propCount && pos + 6 <= data.length; i++) {
            int propCode = readShortLE(data, pos) & 0xFFFF;
            int dataType = readShortLE(data, pos + 2) & 0xFFFF;
            pos += 6; // propCode(2) + dataType(2) + getSet(1) + isEnable(1)
            int afterDef = skipSonyPropValue(data, pos, dataType);
            if (afterDef < 0 || afterDef > data.length) return -1;
            int valStart = afterDef;
            int afterCur = skipSonyPropValue(data, valStart, dataType);
            if (afterCur < 0 || afterCur >= data.length) return -1;
            if (propCode == SONY_PROP_OBJECT_IN_MEMORY) {
                if (dataType == 0x0003 || dataType == 0x0004) return readShortLE(data, valStart) & 0xFFFF;
                if (dataType == 0x0001 || dataType == 0x0002) return data[valStart] & 0xFF;
                if (dataType == 0x0005 || dataType == 0x0006) return readIntLE(data, valStart);
            }
            int formFlag = data[afterCur] & 0xFF;
            pos = afterCur + 1;
            if (formFlag == 1) {
                for (int r = 0; r < 3; r++) {
                    pos = skipSonyPropValue(data, pos, dataType);
                    if (pos < 0 || pos > data.length) return -1;
                }
            } else if (formFlag == 2) {
                if (pos + 2 > data.length) return -1;
                int enumCount = readShortLE(data, pos) & 0xFFFF;
                pos += 2;
                for (int e = 0; e < enumCount; e++) {
                    pos = skipSonyPropValue(data, pos, dataType);
                    if (pos < 0 || pos > data.length) return -1;
                }
            } else if (formFlag != 0) {
                return -1;
            }
        }
        return -1;
    }

    private static int scalarSizeForPtpType(int dataType) {
        switch (dataType) {
            case 0x0001: case 0x0002: return 1;
            case 0x0003: case 0x0004: return 2;
            case 0x0005: case 0x0006: return 4;
            case 0x0007: case 0x0008: return 8;
            case 0x0009: case 0x000A: return 16;
            default: return -1;
        }
    }

    private static int skipSonyPropValue(byte[] data, int pos, int dataType) {
        if (data == null || pos < 0 || pos > data.length) return -1;
        int fixed = scalarSizeForPtpType(dataType);
        if (fixed > 0) return (pos + fixed <= data.length) ? pos + fixed : -1;
        if (dataType == 0xFFFF) {
            if (pos + 1 > data.length) return -1;
            int chars = data[pos] & 0xFF;
            int end = pos + 1 + chars * 2;
            return (end <= data.length) ? end : -1;
        }
        if ((dataType & 0xFF00) == 0x4000) {
            if (pos + 4 > data.length) return -1;
            int count = readIntLE(data, pos);
            int elemSize = scalarSizeForPtpType(dataType & 0x00FF);
            if (count < 0 || count > 4096 || elemSize <= 0) return -1;
            long next = pos + 4L + (long) count * elemSize;
            return (next <= data.length) ? (int) next : -1;
        }
        return -1;
    }

    // --- Sony Alpha Property Helpers & Value Mappers ---

    private int setSonyExtPropUInt8Locked(int propCode, int val) {
        byte[] value = new byte[]{(byte) val};
        int rc = sendPtpCommandLocked(PTP_OC_SONY_SET_EXT_DEVICE_PROP_VALUE, new int[]{propCode}, value);
        if (rc != PTP_RC_OK) rc = sendPtpCommandLocked(PTP_OC_SET_DEVICE_PROP_VALUE, new int[]{propCode}, value);
        return rc;
    }

    private int setSonyExtPropUInt16Locked(int propCode, int val) {
        ByteBuffer bb = ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN);
        bb.putShort((short) (val & 0xFFFF));
        int rc = sendPtpCommandLocked(PTP_OC_SONY_SET_EXT_DEVICE_PROP_VALUE, new int[]{propCode}, bb.array());
        if (rc != PTP_RC_OK) {
            rc = sendPtpCommandLocked(PTP_OC_SET_DEVICE_PROP_VALUE, new int[]{propCode}, bb.array());
        }
        return rc;
    }

    private int setSonyExtPropUInt32Locked(int propCode, int val) {
        ByteBuffer bb = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN);
        bb.putInt(val);
        int rc = sendPtpCommandLocked(PTP_OC_SONY_SET_EXT_DEVICE_PROP_VALUE, new int[]{propCode}, bb.array());
        if (rc != PTP_RC_OK) {
            rc = sendPtpCommandLocked(PTP_OC_SET_DEVICE_PROP_VALUE, new int[]{propCode}, bb.array());
        }
        return rc;
    }

    private int sendSonyControlUInt16Locked(int ctrlCode, int val) {
        ByteBuffer bb = ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN);
        bb.putShort((short) (val & 0xFFFF));
        PtpTransactionResult res = executePtpTransactionLocked(
                PTP_OC_SONY_CONTROL_DEVICE, new int[]{ctrlCode}, bb.array(), 2500);
        return (res != null) ? res.responseCode : -1;
    }

    private int mapCanonIsoToSony(int canonCode) {
        switch (canonCode) {
            case 0:   return 0x00FFFFFF; // ISO Auto on Sony Alpha
            case 72:  return 100;
            case 80:  return 200;
            case 88:  return 400;
            case 96:  return 800;
            case 104: return 1600;
            case 112: return 3200;
            case 120: return 6400;
            default:  return (canonCode >= 100) ? canonCode : 800;
        }
    }

    private int mapCanonTvToSony(int canonCode) {
        int denom = 125;
        switch (canonCode) {
            case 88:  denom = 15; break;
            case 96:  denom = 30; break;
            case 101: denom = 50; break;
            case 104: denom = 60; break;
            case 109: denom = 100; break;
            case 112: denom = 125; break;
            case 115: denom = 160; break;
            case 117: denom = 200; break;
            case 120: denom = 250; break;
            case 128: denom = 500; break;
            case 136: denom = 1000; break;
        }
        return (1 << 16) | (denom & 0xFFFF);
    }

    private int mapCanonAvToSony(int canonCode) {
        switch (canonCode) {
            case 37: return 350;  // f/3.5
            case 40: return 400;  // f/4.0
            case 43: return 450;  // f/4.5
            case 45: return 500;  // f/5.0
            case 48: return 560;  // f/5.6
            case 53: return 630;  // f/6.3
            case 56: return 710;  // f/7.1
            case 59: return 800;  // f/8.0
            case 64: return 900;  // f/9.0
            case 69: return 1100; // f/11
            case 77: return 1600; // f/16
            default: return 560;
        }
    }

    private int mapCanonWbToSony(int canonCode) {
        switch (canonCode) {
            case 0: return 0x0002; // AWB
            case 1: return 0x0004; // Daylight
            case 2: return 0x8010; // Cloudy
            case 3: return 0x0006; // Tungsten / Incandescent
            case 4: return 0x8001; // Fluorescent Warm White
            case 5: return 0x0007; // Flash
            case 8: return 0x8011; // Shade
            default: return 0x0002;
        }
    }

    // --- Canon EOS Property & Event Helpers ---

    private int setCanonPropExLocked(int propCode, int value) {
        ByteBuffer payload = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN);
        payload.putInt(12);
        payload.putInt(propCode);
        payload.putInt(value);
        int rc = sendPtpCommandLocked(PTP_OC_CANON_SET_PROP_EX, new int[0], payload.array());
        if (rc != PTP_RC_OK) {
            ByteBuffer stdPayload = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN);
            stdPayload.putInt(value);
            rc = sendPtpCommandLocked(PTP_OC_SET_DEVICE_PROP_VALUE, new int[]{propCode}, stdPayload.array());
        }
        return rc;
    }

    private void drainCanonEventsLocked() {
        PtpTransactionResult res = executePtpTransactionLocked(PTP_OC_CANON_GET_EVENT, new int[0], null, 600);
        if (res != null && res.dataPayload != null && res.dataPayload.length >= 8) {
            parseCanonEventsForPropertiesLocked(res.dataPayload);
        }
    }

    private int pollCanonTransferObjectHandleLocked() {
        PtpTransactionResult res = executePtpTransactionLocked(PTP_OC_CANON_GET_EVENT, new int[0], null, 600);
        if (res == null || res.dataPayload == null || res.dataPayload.length < 8) return 0;

        byte[] buf = res.dataPayload;
        int offset = 0;
        while (offset + 8 <= buf.length) {
            int recordSize = readIntLE(buf, offset);
            int eventCode = readIntLE(buf, offset + 4);
            if (recordSize < 8 || offset + recordSize > buf.length) break;

            if ((eventCode == 0xC186 || eventCode == 0xC1A7 || eventCode == 0x4002) && recordSize >= 12) {
                int objectHandle = readIntLE(buf, offset + 8);
                if (objectHandle != 0) return objectHandle;
            }
            offset += recordSize;
        }
        return 0;
    }

    private void parseCanonEventsForPropertiesLocked(byte[] buf) {
        try {
            int offset = 0;
            while (offset + 8 <= buf.length) {
                int recordSize = readIntLE(buf, offset);
                int eventCode = readIntLE(buf, offset + 4);
                if (recordSize < 8 || offset + recordSize > buf.length) break;

                if (eventCode == 0xC189 && recordSize >= 16) {
                    int propCode = readIntLE(buf, offset + 8);
                    int propVal = readIntLE(buf, offset + 12);
                    if (propCode == PROP_ISO) currentIso = propVal;
                    else if (propCode == PROP_SHUTTER_SPEED) currentTv = propVal;
                    else if (propCode == PROP_APERTURE) currentAv = propVal;
                    else if (propCode == PROP_WHITE_BALANCE) currentWb = propVal;
                }
                offset += recordSize;
            }
        } catch (Exception ignored) {}
    }

    private byte[] downloadCanonObjectJpegLocked(int objectHandle) {
        PtpTransactionResult res = executePtpTransactionLocked(PTP_OC_GET_OBJECT, new int[]{objectHandle}, null, 20000);
        if (res != null && res.responseCode == PTP_RC_OK && res.dataPayload != null && res.dataPayload.length > 1024) {
            byte[] extracted = extractJpegFromBuffer(res.dataPayload);
            if (extracted != null) sendPtpCommandLocked(PTP_OC_CANON_TRANSFER_COMPLETE, new int[]{objectHandle}, null);
            return extracted;
        }
        return null;
    }

    private byte[] fetchCanonLiveViewFrameLocked() {
        // Canon EOS bodies use 0x00100000 (standard EOS), 0x00200000 (EOS Utility), or no params
        int[][] paramVariants = new int[][]{
                new int[]{0x00100000},
                new int[]{0x00200000},
                new int[0]
        };
        int idx = canonEvfParamIndex % paramVariants.length;
        PtpTransactionResult res = executePtpTransactionLocked(
                PTP_OC_CANON_GET_VIEWFINDER_DATA,
                paramVariants[idx],
                null,
                850
        );
        if (res != null && res.dataPayload != null && res.dataPayload.length >= 256) {
            byte[] jpg = extractJpegFromBuffer(res.dataPayload);
            if (jpg != null && jpg.length >= 256) {
                return jpg;
            }
        }
        // If current param variant returned an error other than 0xA102 (OBJECT_NOTREADY), try next variant on next poll
        if (res == null || (res.responseCode != PTP_RC_OK && res.responseCode != 0xA102)) {
            canonEvfParamIndex = (canonEvfParamIndex + 1) % paramVariants.length;
        }
        return null;
    }

    private void drainBulkInEndpoint() {
        if (connection == null || epIn == null) return;
        byte[] drainBuf = new byte[8192];
        int drained;
        int attempts = 0;
        while (attempts++ < 64 && (drained = connection.bulkTransfer(epIn, drainBuf, drainBuf.length, 25)) > 0) {
            // clear out leftover unread bytes
        }
    }

    private byte[] fetchSonyLiveViewFrameLocked() {
        // Sony virtual preview objects must be queried before each frame. If the
        // object is not ready, wait for the next poll instead of issuing GetObject.
        PtpTransactionResult info = executePtpTransactionLocked(
                    PTP_OC_GET_OBJECT_INFO,
                    new int[]{SONY_HANDLE_LIVEVIEW_FRAME},
                    null,
                    450
            );
        if (info == null || info.responseCode != PTP_RC_OK) {
            lastSonyDiag = "GetObjectInfo: " + (info == null ? "timeout" : "0x" + Integer.toHexString(info.responseCode));
            return null;
        }

        PtpTransactionResult res = executePtpTransactionLocked(
                PTP_OC_GET_OBJECT,
                new int[]{SONY_HANDLE_LIVEVIEW_FRAME},
                null,
                1200
        );
        if (res == null) {
            lastSonyDiag = "res=null (timeout)";
            drainBulkInEndpoint();
            return null;
        }
        if (res.responseCode != PTP_RC_OK || res.dataPayload == null || res.dataPayload.length < 256) {
            lastSonyDiag = "resp=0x" + Integer.toHexString(res.responseCode) + ",len=" + (res.dataPayload != null ? res.dataPayload.length : 0);
            if (res.responseCode != PTP_RC_OK) {
                // Re-arm virtual handle if camera rejected command
                executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_LIVEVIEW_FRAME}, null, 400);
            }
            return null;
        }

        byte[] extracted = extractSonyLiveViewJpeg(res.dataPayload);
        if (extracted != null) {
            lastSonyDiag = "OK (" + extracted.length + "B)";
        } else {
            lastSonyDiag = "parseErr (raw " + res.dataPayload.length + "B)";
        }
        return extracted;
    }

    private byte[] fetchNikonLiveViewFrameLocked() {
        PtpTransactionResult res = executePtpTransactionLocked(PTP_OC_NIKON_GET_LIVEVIEW_IMG, new int[0], null, 900);
        if (res != null && res.responseCode == PTP_RC_OK && res.dataPayload != null && res.dataPayload.length >= 256) {
            byte[] p = res.dataPayload;
            for (int off : new int[]{384, 128, 64}) {
                if (p.length > off + 64 && (p[off] & 0xff) == 0xff && (p[off + 1] & 0xff) == 0xd8) {
                    byte[] sliced = new byte[p.length - off];
                    System.arraycopy(p, off, sliced, 0, sliced.length);
                    byte[] jpg = extractJpegFromBuffer(sliced);
                    if (jpg != null) return jpg;
                }
            }
            return extractJpegFromBuffer(p);
        }
        return null;
    }

    private byte[] fetchFujiLiveViewFrameLocked() {
        PtpTransactionResult info = executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{FUJI_HANDLE_LIVEVIEW_FRAME}, null, 450);
        if (info == null || info.responseCode != PTP_RC_OK) return null;
        PtpTransactionResult res = executePtpTransactionLocked(PTP_OC_GET_OBJECT, new int[]{FUJI_HANDLE_LIVEVIEW_FRAME}, null, 900);
        if (res != null && res.responseCode == PTP_RC_OK && res.dataPayload != null && res.dataPayload.length >= 256) {
            return extractJpegFromBuffer(res.dataPayload);
        }
        return null;
    }

    private byte[] captureGenericOrNikonPhotoLocked() {
        lastCapturedFullJpeg = null;
        boolean pausedNikonLv = false;
        try {
            if (driverType == DriverType.NIKON && supportsUsbLiveView) {
                sendPtpCommandLocked(PTP_OC_NIKON_END_LIVEVIEW, new int[0], null);
                pausedNikonLv = true;
                Thread.sleep(150);
            }
            Set<Integer> before = queryAllJpegObjectHandlesLocked();
            int rc = sendPtpCommandLocked(PTP_OC_INITIATE_CAPTURE, new int[]{0, 0}, null);
            if (rc != PTP_RC_OK && driverType == DriverType.NIKON) {
                rc = sendPtpCommandLocked(PTP_OC_NIKON_CAPTURE_SDRAM, new int[]{-1}, null);
            }
            requirePtpOk(rc, "Shutter kamera USB");

            long deadline = System.currentTimeMillis() + 10000;
            while (System.currentTimeMillis() < deadline && lastCapturedFullJpeg == null) {
                if (driverType == DriverType.NIKON) {
                    sendPtpCommandLocked(PTP_OC_NIKON_CHECK_EVENT, new int[0], null);
                }
                Set<Integer> nowHandles = queryAllJpegObjectHandlesLocked();
                for (int handle : nowHandles) {
                    if (!before.contains(handle)) {
                        PtpTransactionResult infoRes = executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{handle}, null, 600);
                        if (infoRes != null && infoRes.responseCode == PTP_RC_OK
                                && infoRes.dataPayload != null && infoRes.dataPayload.length >= 12
                                && (readShortLE(infoRes.dataPayload, 4) & 0xffff) == 0x3801) {
                            PtpTransactionResult imgRes = executePtpTransactionLocked(PTP_OC_GET_OBJECT, new int[]{handle}, null, 20000);
                            if (imgRes != null && imgRes.responseCode == PTP_RC_OK && imgRes.dataPayload != null) {
                                byte[] jpg = extractJpegFromBuffer(imgRes.dataPayload);
                                if (jpg != null && jpg.length > 2048) {
                                    lastCapturedFullJpeg = jpg;
                                    break;
                                }
                            }
                        }
                    }
                }
                if (lastCapturedFullJpeg != null) break;
                Thread.sleep(220);
            }
        } catch (Exception e) {
            Log.w(TAG, "Generic/Nikon PTP capture error: " + e.getMessage());
            lastCaptureError = "Foto kamera gagal: " + e.getMessage();
        } finally {
            if (pausedNikonLv) {
                try { Thread.sleep(200); } catch (InterruptedException ignored) {}
                sendPtpCommandLocked(PTP_OC_NIKON_START_LIVEVIEW, new int[0], null);
            }
            lastKeepAliveMs = System.currentTimeMillis();
        }
        if (lastCapturedFullJpeg != null && lastCapturedFullJpeg.length > 2048) {
            return lastCapturedFullJpeg;
        }
        if (lastCaptureError.isEmpty()) lastCaptureError = "Foto JPEG kamera belum diterima. Periksa format JPEG & kartu memori kamera.";
        return null;
    }

    private Set<Integer> queryAllJpegObjectHandlesLocked() {
        Set<Integer> handles = new HashSet<>();
        PtpTransactionResult res = executePtpTransactionLocked(PTP_OC_GET_OBJECT_HANDLES, new int[]{0xFFFFFFFF, 0x3801, 0}, null, 1200);
        if (res == null || res.responseCode != PTP_RC_OK || res.dataPayload == null) {
            res = executePtpTransactionLocked(PTP_OC_GET_OBJECT_HANDLES, new int[]{0xFFFFFFFF, 0, 0}, null, 1200);
        }
        if (res != null && res.responseCode == PTP_RC_OK && res.dataPayload != null && res.dataPayload.length >= 4) {
            int count = readIntLE(res.dataPayload, 0);
            int max = Math.min(Math.max(0, count), (res.dataPayload.length - 4) / 4);
            for (int i = 0; i < max; i++) {
                handles.add(readIntLE(res.dataPayload, 4 + i * 4));
            }
        }
        return handles;
    }

    private static final class PtpDeviceInfo {
        String manufacturer = "";
        String model = "";
        final Set<Integer> ops = new HashSet<>();
    }

    private PtpDeviceInfo fetchDeviceInfoLocked() {
        PtpTransactionResult res = executePtpTransactionLocked(PTP_OC_GET_DEVICE_INFO, new int[0], null, 1500);
        if (res == null || res.responseCode != PTP_RC_OK || res.dataPayload == null || res.dataPayload.length < 16) {
            return null;
        }
        try {
            byte[] d = res.dataPayload;
            PtpDeviceInfo info = new PtpDeviceInfo();
            int pos = 8; // StandardVersion(2) + VendorExtensionID(4) + VendorExtensionVersion(2)
            pos = skipPtpString(d, pos); // VendorExtensionDesc
            pos += 2; // FunctionalMode
            if (pos + 4 <= d.length) {
                int opCount = readIntLE(d, pos);
                pos += 4;
                int safeOps = Math.min(Math.max(0, opCount), (d.length - pos) / 2);
                for (int i = 0; i < safeOps; i++) {
                    info.ops.add(readShortLE(d, pos) & 0xFFFF);
                    pos += 2;
                }
            }
            // Skip EventsSupported, DevicePropertiesSupported, CaptureFormats, ImageFormats
            for (int arr = 0; arr < 4; arr++) {
                if (pos + 4 > d.length) return info;
                int n = readIntLE(d, pos);
                pos += 4 + Math.max(0, Math.min(n, (d.length - pos - 4) / 2)) * 2;
            }
            info.manufacturer = readPtpString(d, pos);
            pos = skipPtpString(d, pos);
            info.model = readPtpString(d, pos);
            return info;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static int skipPtpString(byte[] b, int pos) {
        if (b == null || pos < 0 || pos >= b.length) return b == null ? 0 : b.length;
        int numChars = b[pos] & 0xFF;
        return Math.min(b.length, pos + 1 + numChars * 2);
    }

    private static String readPtpString(byte[] b, int pos) {
        if (b == null || pos < 0 || pos >= b.length) return "";
        int numChars = b[pos] & 0xFF;
        if (numChars <= 1 || pos + 1 + numChars * 2 > b.length) return "";
        byte[] utf16 = new byte[(numChars - 1) * 2];
        System.arraycopy(b, pos + 1, utf16, 0, utf16.length);
        return new String(utf16, StandardCharsets.UTF_16LE).trim();
    }

    private byte[] extractSonyLiveViewJpeg(byte[] payload) {
        // The Sony header may contain FF D8 as metadata. Its first UINT32 points
        // at the actual JPEG; scanning the header first can produce an invalid image.
        if (payload != null && payload.length >= 4) {
            long offset = readIntLE(payload, 0) & 0xffffffffL;
            if (offset >= 4 && offset < payload.length - 2
                    && (payload[(int) offset] & 0xff) == 0xff
                    && (payload[(int) offset + 1] & 0xff) == 0xd8) {
                byte[] image = new byte[payload.length - (int) offset];
                System.arraycopy(payload, (int) offset, image, 0, image.length);
                return extractJpegFromBuffer(image);
            }
        }
        return extractJpegFromBuffer(payload);
    }

    private byte[] extractJpegFromBuffer(byte[] data) {
        if (data == null || data.length < 128) return null;
        int startIdx = -1;
        for (int i = 0; i < data.length - 1; i++) {
            if ((data[i] & 0xFF) == 0xFF && (data[i + 1] & 0xFF) == 0xD8) {
                startIdx = i;
                break;
            }
        }
        if (startIdx == -1) return null;

        int endIdx = -1;
        for (int i = data.length - 2; i > startIdx + 32; i--) {
            if ((data[i] & 0xFF) == 0xFF && (data[i + 1] & 0xFF) == 0xD9) {
                endIdx = i + 2;
                break;
            }
        }
        if (endIdx == -1 || endIdx <= startIdx) return null;

        if (startIdx == 0 && endIdx == data.length) return data;
        int len = endIdx - startIdx;
        byte[] jpeg = new byte[len];
        System.arraycopy(data, startIdx, jpeg, 0, len);
        return jpeg;
    }

    private static boolean hasJpegEoi(byte[] b, int len) {
        if (b == null || len < 2) return false;
        int checkStart = Math.max(0, len - 256);
        for (int i = len - 1; i > checkStart; i--) {
            if ((b[i - 1] & 0xFF) == 0xFF && (b[i] & 0xFF) == 0xD9) {
                return true;
            }
        }
        return false;
    }

    private int sendPtpCommandLocked(int opCode, int[] params, byte[] dataOut) {
        PtpTransactionResult res = executePtpTransactionLocked(opCode, params, dataOut, 1000);
        return (res != null) ? res.responseCode : -1;
    }

    private static int readIntLE(byte[] b, int offset) {
        if (b == null || offset < 0 || offset + 4 > b.length) return 0;
        return (b[offset] & 0xFF)
                | ((b[offset + 1] & 0xFF) << 8)
                | ((b[offset + 2] & 0xFF) << 16)
                | ((b[offset + 3] & 0xFF) << 24);
    }

    private static short readShortLE(byte[] b, int offset) {
        if (b == null || offset < 0 || offset + 2 > b.length) return 0;
        return (short) ((b[offset] & 0xFF) | ((b[offset + 1] & 0xFF) << 8));
    }

    private static class PtpTransactionResult {
        int responseCode;
        byte[] dataPayload;
    }

    private PtpTransactionResult executePtpTransactionLocked(int opCode, int[] params, byte[] dataOut, int timeoutMs) {
        if (connection == null || epOut == null || epIn == null) return null;
        PtpUsbTransport.Result received = PtpUsbTransport.transact(new PtpUsbTransport.PacketIO() {
            @Override public int write(byte[] bytes, int timeout) {
                return connection.bulkTransfer(epOut, bytes, bytes.length, timeout);
            }
            @Override public int read(byte[] bytes, int timeout) {
                return connection.bulkTransfer(epIn, bytes, bytes.length, timeout);
            }
        }, transactionId++, opCode, params, dataOut, timeoutMs);
        PtpTransactionResult result = new PtpTransactionResult();
        result.responseCode = received.responseCode;
        result.dataPayload = received.dataPayload;
        lastTransportDiagnostic = received.diagnostic.isEmpty()
                ? "op=0x" + Integer.toHexString(opCode) + ", response=0x" + Integer.toHexString(received.responseCode)
                : received.diagnostic;
        if (result.responseCode < 0) drainBulkInEndpoint();
        return result;
    }
}

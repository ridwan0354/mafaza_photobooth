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

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.HashMap;

/**
 * Native Android USB Host PTP Driver for:
 *  1) Canon EOS Cameras (e.g. Canon EOS 1300D) via Canon EOS Vendor Extensions (0x91xx)
 *  2) Sony Alpha Cameras (e.g. Sony A7 III / ILCE-7M3) via Sony SDIO Remote Control Extensions (0x92xx)
 *
 * Supports Live View streaming, ISO, Shutter Speed (Tv), Aperture (Av), White Balance (WB),
 * Auto Focus (AF), Manual Focus Step, and Physical Shutter + Hotshoe Flash (Godox CT-16) over USB OTG.
 */
public class CanonUsbPtpEngine {
    private static final String TAG = "CanonUsbPtpEngine";
    public static final String ACTION_USB_PERMISSION = "com.mafaza.photobooth.kiosk.USB_PERMISSION";

    public static final int CANON_VENDOR_ID = 0x04A9; // 1193 (Canon Inc.)
    public static final int SONY_VENDOR_ID  = 0x054C; // 1356 (Sony Corp.)

    // Standard PTP Operation Codes
    private static final int PTP_OC_OPEN_SESSION = 0x1002;
    private static final int PTP_OC_CLOSE_SESSION = 0x1003;
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
    private static final int SONY_PROP_ISO = 0xD21E;                // UINT32
    private static final int SONY_PROP_LIVEVIEW_STATUS = 0xD221;    // UINT8
    private static final int SONY_CTRL_HALF_PRESS_SHUTTER = 0xD2C1; // UINT16 (2=Down, 1=Up)
    private static final int SONY_CTRL_CAPTURE_SHUTTER = 0xD2C2;    // UINT16 (2=Down, 1=Up)
    private static final int SONY_CTRL_NEAR_FAR_FOCUS = 0xD2C7;     // INT16  (-7..+7)
    private static final int SONY_HANDLE_IN_MEMORY_IMAGE = 0xFFFFC001;
    private static final int SONY_HANDLE_LIVEVIEW_FRAME  = 0xFFFFC002;

    // PTP Container Types
    private static final short PTP_CNT_COMMAND = 1;
    private static final short PTP_CNT_DATA = 2;
    private static final short PTP_CNT_RESPONSE = 3;

    // PTP Response Codes
    private static final int PTP_RC_OK = 0x2001;
    private static final int PTP_RC_SESSION_ALREADY_OPEN = 0x201E;

    public interface Listener {
        void onCameraConnected(String modelName);
        void onCameraDisconnected();
        void onStatusMessage(String message);
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

    private volatile boolean isRunning = false;
    private volatile boolean isConnected = false;
    private volatile boolean isSonyCamera = false;
    private volatile String cameraModelName = "Canon EOS 1300D";
    private volatile byte[] latestLiveViewJpeg = null;
    private volatile long latestFrameTimeMs = 0;
    private volatile long totalFramesReceived = 0;
    private volatile byte[] lastCapturedFullJpeg = null;
    private volatile String lastSonyDiag = "Belum dimulai";
    private volatile boolean isCapturingPhoto = false;
    private volatile long lastKeepAliveMs = 0;
    private int transactionId = 1;
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
                    showToast("🔌 Kamera USB terdeteksi di OTG!");
                    checkAndConnectDevice(dev);
                }
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                UsbDevice dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                if (dev != null && activeDevice != null && dev.getDeviceId() == activeDevice.getDeviceId()) {
                    showToast("⚠️ Kamera USB terputus.");
                    closeCurrentConnection();
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
        return isConnected && latestLiveViewJpeg != null && latestLiveViewJpeg.length > 200;
    }

    public boolean isActive() {
        return isConnected;
    }

    public boolean hasLiveFrame() {
        return latestLiveViewJpeg != null && latestLiveViewJpeg.length > 256;
    }

    public long getTotalFramesReceived() {
        return totalFramesReceived;
    }

    public void scanAndConnectIfAvailable() {
        lastPermissionRequestMs = 0; // Reset cooldown on manual tap
        new Thread(this::scanForCameraDevices, "UsbCameraScan").start();
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

    private boolean isSupportedCameraDevice(UsbDevice dev) {
        if (dev == null) return false;
        int vid = dev.getVendorId();
        if (vid == CANON_VENDOR_ID || vid == SONY_VENDOR_ID) return true;
        for (int i = 0; i < dev.getInterfaceCount(); i++) {
            int cls = dev.getInterface(i).getInterfaceClass();
            if (cls == UsbConstants.USB_CLASS_STILL_IMAGE) {
                return true;
            }
        }
        return false;
    }

    private void checkAndConnectDevice(final UsbDevice dev) {
        if (dev == null || usbManager == null) return;
        if (usbManager.hasPermission(dev)) {
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

    public String getUsbDiagnosticsReport() {
        if (usbManager == null) return "UsbManager tidak tersedia di perangkat ini.";
        HashMap<String, UsbDevice> map = usbManager.getDeviceList();
        if (map == null || map.isEmpty()) {
            return "🔌 Status Port USB OTG: TIDAK ADA perangkat USB yang terbaca (0 perangkat).\n\n"
                    + "Tips untuk Redmi Pad 2:\n"
                    + "1. Pastikan adaptor/kabel OTG Type-C mendukung transfer data (bukan hanya kabel cas).\n"
                    + "2. Pastikan kamera Canon EOS 1300D dalam keadaan ON dan tekan setengah tombol shutter kamera agar tidak Sleep.\n"
                    + "3. Pastikan menu Wi-Fi/NFC di kamera Canon posisi Disable.";
        }
        StringBuilder sb = new StringBuilder();
        sb.append("🔌 Terdeteksi ").append(map.size()).append(" perangkat di port USB OTG:\n");
        for (UsbDevice d : map.values()) {
            String pName = (Build.VERSION.SDK_INT >= 21 && d.getProductName() != null) ? d.getProductName() : d.getDeviceName();
            boolean hasPerm = usbManager.hasPermission(d);
            sb.append("• ").append(pName)
              .append(" (VID: 0x").append(Integer.toHexString(d.getVendorId()).toUpperCase())
              .append(", Izin: ").append(hasPerm ? "SUDAH" : "BELUM").append(")\n");
        }
        sb.append("\nStatus Sesi PTP: ").append(isConnected ? "TERHUBUNG (" + cameraModelName + ")" : "BELUM TERHUBUNG");
        sb.append("\nFrame Live View diterima: ").append(totalFramesReceived);
        if (isSonyCamera) {
            sb.append("\nSony LiveView Diag: ").append(lastSonyDiag);
        }
        return sb.toString();
    }

    private void connectToDeviceAsync(final UsbDevice dev) {
        new Thread(() -> {
            synchronized (usbLock) {
                if (isConnected && activeDevice != null && activeDevice.getDeviceId() == dev.getDeviceId()) {
                    return;
                }
                closeCurrentConnection();
                openPtpConnection(dev);
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

                byte[] frame = null;
                synchronized (usbLock) {
                    if (!isConnected || isCapturingPhoto) continue;

                    long now = System.currentTimeMillis();
                    if (now - lastKeepAliveMs > 3500) {
                        if (isSonyCamera) {
                            executePtpTransactionLocked(PTP_OC_SONY_GET_ALL_EXT_DEVICE_PROP_INFO, new int[0], null, 450);
                        } else {
                            sendPtpCommandLocked(PTP_OC_CANON_KEEP_DEVICE_ON, new int[0], null);
                            drainCanonEventsLocked();
                        }
                        lastKeepAliveMs = now;
                    }

                    frame = isSonyCamera ? fetchSonyLiveViewFrameLocked() : fetchCanonLiveViewFrameLocked();
                }

                if (frame != null && frame.length > 512) {
                    boolean wasFirstFrame = (totalFramesReceived == 0);
                    latestLiveViewJpeg = frame;
                    latestFrameTimeMs = System.currentTimeMillis();
                    totalFramesReceived++;
                    consecutiveFailures = 0;
                    if (wasFirstFrame && listener != null) {
                        listener.onCameraConnected(cameraModelName + " (LIVE)");
                    }
                    Thread.sleep(36); // ~25 FPS smooth Live View
                } else {
                    consecutiveFailures++;
                    if (consecutiveFailures % 15 == 0) {
                        synchronized (usbLock) {
                            if (isConnected && !isCapturingPhoto) {
                                if (isSonyCamera) {
                                    drainBulkInEndpoint();
                                    setSonyExtPropUInt16Locked(SONY_PROP_LIVEVIEW_STATUS, 1);
                                    executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_LIVEVIEW_FRAME}, null, 400);
                                } else {
                                    drainCanonEventsLocked();
                                    enableCanonLiveViewOutputLocked();
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
        if (map == null || map.isEmpty()) {
            notifyStatus("USB EOS: Siap Colok OTG (Pastikan Wi-Fi Kamera OFF)");
            return;
        }
        for (UsbDevice dev : map.values()) {
            if (isSupportedCameraDevice(dev)) {
                checkAndConnectDevice(dev);
                return;
            }
        }
        notifyStatus("USB OTG (" + map.size() + " alat, bukan DSLR PTP)");
    }

    private void openPtpConnection(UsbDevice dev) {
        try {
            UsbInterface targetIf = null;
            for (int i = 0; i < dev.getInterfaceCount(); i++) {
                UsbInterface uif = dev.getInterface(i);
                if (uif.getInterfaceClass() == UsbConstants.USB_CLASS_STILL_IMAGE) {
                    targetIf = uif;
                    break;
                }
            }
            if (targetIf == null && dev.getInterfaceCount() > 0) {
                targetIf = dev.getInterface(0);
            }
            if (targetIf == null) return;

            UsbEndpoint bulkOut = null;
            UsbEndpoint bulkIn = null;
            for (int i = 0; i < targetIf.getEndpointCount(); i++) {
                UsbEndpoint ep = targetIf.getEndpoint(i);
                if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                    if (ep.getDirection() == UsbConstants.USB_DIR_OUT) {
                        bulkOut = ep;
                    } else if (ep.getDirection() == UsbConstants.USB_DIR_IN) {
                        bulkIn = ep;
                    }
                }
            }
            if (bulkOut == null || bulkIn == null) return;

            UsbDeviceConnection conn = usbManager.openDevice(dev);
            if (conn == null) return;

            if (!conn.claimInterface(targetIf, true)) {
                conn.close();
                return;
            }

            this.activeDevice = dev;
            this.connection = conn;
            this.ptpInterface = targetIf;
            this.epOut = bulkOut;
            this.epIn = bulkIn;
            this.transactionId = 1;
            this.totalFramesReceived = 0;
            this.isSonyCamera = (dev.getVendorId() == SONY_VENDOR_ID);

            String prodName = (Build.VERSION.SDK_INT >= 21 && dev.getProductName() != null)
                    ? dev.getProductName().trim()
                    : "";
            if (prodName.isEmpty() || "Canon Digital Camera".equalsIgnoreCase(prodName)) {
                this.cameraModelName = isSonyCamera ? "Sony Alpha A7 III" : "Canon EOS 1300D";
            } else {
                this.cameraModelName = prodName;
            }

            // 1. Open PTP Session
            int rc = sendPtpCommandLocked(PTP_OC_OPEN_SESSION, new int[]{1}, null);
            if (rc == PTP_RC_SESSION_ALREADY_OPEN || rc != PTP_RC_OK) {
                sendPtpCommandLocked(PTP_OC_CLOSE_SESSION, new int[0], null);
                this.transactionId = 1;
                sendPtpCommandLocked(PTP_OC_OPEN_SESSION, new int[]{1}, null);
            }

            if (isSonyCamera) {
                // Sony Alpha (A7 III / ILCE-7M3) PC Remote Handshake Sequence
                drainBulkInEndpoint();
                sendPtpCommandLocked(PTP_OC_SONY_SDIO_CONNECT, new int[]{1, 0, 0}, null);
                sendPtpCommandLocked(PTP_OC_SONY_SDIO_CONNECT, new int[]{2, 0, 0}, null);
                executePtpTransactionLocked(PTP_OC_SONY_SDIO_GET_EXT_DEVICE_INFO, new int[]{0x00C8}, null, 800);
                sendPtpCommandLocked(PTP_OC_SONY_SDIO_CONNECT, new int[]{3, 0, 0}, null);
                executePtpTransactionLocked(PTP_OC_SONY_GET_ALL_EXT_DEVICE_PROP_INFO, new int[0], null, 800);

                // Arm Sony Alpha LiveView virtual stream handle (0xFFFFC002)
                setSonyExtPropUInt16Locked(SONY_PROP_LIVEVIEW_STATUS, 1);
                executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_LIVEVIEW_FRAME}, null, 600);
            } else {
                // Canon EOS (1300D / Rebel T6, etc.) Remote Mode + LiveView Handshake Sequence
                sendPtpCommandLocked(PTP_OC_CANON_SET_REMOTE_MODE, new int[]{1}, null);
                sendPtpCommandLocked(PTP_OC_CANON_SET_EVENT_MODE, new int[]{1}, null);
                try { Thread.sleep(80); } catch (InterruptedException ignored) {}
                drainCanonEventsLocked();
                drainCanonEventsLocked();
                // Set Capture Destination: 4 = RAM/Host on Canon EOS PTP (fallback 2 = Host)
                if (setCanonPropExLocked(PROP_CAPTURE_DESTINATION, 4) != PTP_RC_OK) {
                    setCanonPropExLocked(PROP_CAPTURE_DESTINATION, 2);
                }
                drainCanonEventsLocked();
                enableCanonLiveViewOutputLocked();
            }

            this.isConnected = true;
            if (listener != null) {
                listener.onCameraConnected(this.cameraModelName);
            }
            showToast("✅ " + this.cameraModelName + " Terhubung! Memulai Live View...");
            Log.i(TAG, "USB PTP Session Connected: " + this.cameraModelName + " (Sony=" + isSonyCamera + ")");
        } catch (Exception e) {
            Log.e(TAG, "Failed to open USB PTP connection", e);
            closeCurrentConnection();
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
            latestLiveViewJpeg = null;
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
            } else {
                int rc = sendPtpCommandLocked(PTP_OC_CANON_DO_AF, new int[0], null);
                if (rc != PTP_RC_OK) {
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_ON, new int[]{1, 0}, null);
                    try { Thread.sleep(280); } catch (InterruptedException ignored) {}
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_OFF, new int[]{1}, null);
                }
                drainCanonEventsLocked();
                return true;
            }
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
            } else {
                int rc = sendPtpCommandLocked(PTP_OC_CANON_DRIVE_LENS, new int[]{stepCode}, null);
                drainCanonEventsLocked();
                return rc == PTP_RC_OK;
            }
        }
    }

    /**
     * Triggers the physical shutter over USB (Canon EOS 1300D or Sony Alpha A7 III).
     * Fires the Hotshoe X-Sync pin (Godox CT-16 Flash), downloads the captured JPEG, and resumes Live View.
     */
    public byte[] capturePhotoWithFlash() {
        synchronized (usbLock) {
            if (!isConnected) return latestLiveViewJpeg;
            isCapturingPhoto = true;
            try {
                if (isSonyCamera) {
                    return captureSonyPhotoWithFlashLocked();
                } else {
                    return captureCanonPhotoWithFlashLocked();
                }
            } finally {
                isCapturingPhoto = false;
            }
        }
    }

    private byte[] captureCanonPhotoWithFlashLocked() {
        byte[] backupFrame = latestLiveViewJpeg;
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
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_ON, new int[]{1, 1}, null);
                    Thread.sleep(100);
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_ON, new int[]{2, 1}, null);
                    Thread.sleep(180);
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_OFF, new int[]{2}, null);
                    Thread.sleep(50);
                    sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_OFF, new int[]{1}, null);
                }
            }

            // 3. Poll Canon events for up to 2.5 seconds to download the newly captured JPEG object
            long deadline = System.currentTimeMillis() + 2500;
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
        } finally {
            // 4. Immediately resume Live View for the next pose
            try { Thread.sleep(300); } catch (InterruptedException ignored) {}
            enableCanonLiveViewOutputLocked();
            lastKeepAliveMs = System.currentTimeMillis();
        }

        if (lastCapturedFullJpeg != null && lastCapturedFullJpeg.length > 2048) {
            latestLiveViewJpeg = lastCapturedFullJpeg;
            return lastCapturedFullJpeg;
        }
        return (latestLiveViewJpeg != null) ? latestLiveViewJpeg : backupFrame;
    }

    private byte[] captureSonyPhotoWithFlashLocked() {
        byte[] backupFrame = latestLiveViewJpeg;
        lastCapturedFullJpeg = null;

        try {
            // 1. Drain bulk endpoint to ensure clean USB pipe before shutter
            drainBulkInEndpoint();

            // 2. Half-press to trigger AF/AE lock (2 = Down)
            sendSonyControlUInt16Locked(SONY_CTRL_HALF_PRESS_SHUTTER, 2);
            Thread.sleep(200);

            // 3. Full-press to release shutter and fire Godox flash via Hotshoe X-sync (2 = Down)
            sendSonyControlUInt16Locked(SONY_CTRL_CAPTURE_SHUTTER, 2);
            Thread.sleep(200);

            // 4. Release buttons cleanly with staggering (1 = Up)
            sendSonyControlUInt16Locked(SONY_CTRL_CAPTURE_SHUTTER, 1);
            Thread.sleep(100);
            sendSonyControlUInt16Locked(SONY_CTRL_HALF_PRESS_SHUTTER, 1);

            // 5. Post-shutter quiet grace period:
            // Sony Alpha A7 III internal DSP needs 600ms to complete mechanical shutter,
            // sensor readout, and write image data to the internal SD card / buffer.
            Thread.sleep(600);
            drainBulkInEndpoint();

            // 6. Actively drain in-memory object (0xFFFFC001) to keep the Sony PC Remote FIFO buffer empty.
            // Because Sony A7 III only has "PC+Camera" or "PC Only" (no "Camera Only"), every single shot
            // is queued in volatile RAM until fetched by the host via PTP.
            // If not retrieved, after 5-7 shots the FIFO fills and the camera reboots.
            long deadline = System.currentTimeMillis() + 3000;
            while (System.currentTimeMillis() < deadline) {
                PtpTransactionResult infoRes = executePtpTransactionLocked(
                        PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_IN_MEMORY_IMAGE}, null, 400);
                if (infoRes != null && infoRes.responseCode == PTP_RC_OK) {
                    int compressedSize = 0;
                    if (infoRes.dataPayload != null && infoRes.dataPayload.length >= 12) {
                        compressedSize = readIntLE(infoRes.dataPayload, 8);
                    }
                    if (compressedSize <= 0 || compressedSize <= 40 * 1024 * 1024) {
                        PtpTransactionResult imgRes = executePtpTransactionLocked(
                                PTP_OC_GET_OBJECT, new int[]{SONY_HANDLE_IN_MEMORY_IMAGE}, null, 4500);
                        if (imgRes != null && imgRes.dataPayload != null && imgRes.dataPayload.length > 2048) {
                            byte[] jpeg = extractJpegFromBuffer(imgRes.dataPayload);
                            if (jpeg != null && jpeg.length > 2048) {
                                lastCapturedFullJpeg = jpeg;
                            }
                        }
                    }
                    break; // Successfully fetched and cleared Sony RAM slot!
                }
                Thread.sleep(100);
            }
            drainBulkInEndpoint();

            // 7. Re-arm Sony Live View cleanly for the next pose
            Thread.sleep(150);
            setSonyExtPropUInt16Locked(SONY_PROP_LIVEVIEW_STATUS, 1);
            executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_LIVEVIEW_FRAME}, null, 500);
            lastKeepAliveMs = System.currentTimeMillis();
            Thread.sleep(200);

        } catch (Exception e) {
            Log.w(TAG, "Sony capture error: " + e.getMessage());
            drainBulkInEndpoint();
        }

        if (lastCapturedFullJpeg != null && lastCapturedFullJpeg.length > 2048) {
            latestLiveViewJpeg = lastCapturedFullJpeg;
            return lastCapturedFullJpeg;
        }
        return (latestLiveViewJpeg != null) ? latestLiveViewJpeg : backupFrame;
    }

    // --- Sony Alpha Property Helpers & Value Mappers ---

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
        return sendPtpCommandLocked(PTP_OC_SONY_CONTROL_DEVICE, new int[]{ctrlCode}, bb.array());
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
        PtpTransactionResult res = executePtpTransactionLocked(PTP_OC_GET_OBJECT, new int[]{objectHandle}, null, 3500);
        sendPtpCommandLocked(PTP_OC_CANON_TRANSFER_COMPLETE, new int[]{objectHandle}, null);
        if (res != null && res.dataPayload != null && res.dataPayload.length > 1024) {
            byte[] extracted = extractJpegFromBuffer(res.dataPayload);
            return (extracted != null) ? extracted : res.dataPayload;
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
        while ((drained = connection.bulkTransfer(epIn, drainBuf, drainBuf.length, 25)) > 0) {
            // clear out leftover unread bytes
        }
    }

    private byte[] fetchSonyLiveViewFrameLocked() {
        // Send GetObjectInfo first on initial connection or periodically every 45 frames to keep virtual object armed
        if (totalFramesReceived == 0 || (totalFramesReceived % 45 == 0)) {
            executePtpTransactionLocked(
                    PTP_OC_GET_OBJECT_INFO,
                    new int[]{SONY_HANDLE_LIVEVIEW_FRAME},
                    null,
                    450
            );
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
        if (res.dataPayload == null || res.dataPayload.length < 256) {
            lastSonyDiag = "resp=0x" + Integer.toHexString(res.responseCode) + ",len=" + (res.dataPayload != null ? res.dataPayload.length : 0);
            if (res.responseCode != PTP_RC_OK) {
                // Re-arm virtual handle if camera rejected command
                executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_LIVEVIEW_FRAME}, null, 400);
            }
            return null;
        }

        byte[] extracted = extractJpegFromBuffer(res.dataPayload);
        if (extracted == null && res.dataPayload.length > 1024) {
            if ((res.dataPayload[0] & 0xFF) == 0xFF && (res.dataPayload[1] & 0xFF) == 0xD8) {
                extracted = res.dataPayload;
            }
        }
        if (extracted != null) {
            lastSonyDiag = "OK (" + extracted.length + "B)";
        } else {
            lastSonyDiag = "parseErr (raw " + res.dataPayload.length + "B)";
        }
        return extracted;
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
        // Fallback: if SOI was found and buffer has sufficient size, return from startIdx to end
        if (endIdx == -1 || endIdx <= startIdx) {
            if (data.length - startIdx >= 1024) {
                endIdx = data.length;
            } else {
                return null;
            }
        }

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

        int tid = this.transactionId++;
        int paramCount = (params != null) ? params.length : 0;
        int cmdLen = 12 + (paramCount * 4);

        ByteBuffer cmdBuf = ByteBuffer.allocate(cmdLen).order(ByteOrder.LITTLE_ENDIAN);
        cmdBuf.putInt(cmdLen);
        cmdBuf.putShort(PTP_CNT_COMMAND);
        cmdBuf.putShort((short) opCode);
        cmdBuf.putInt(tid);
        for (int i = 0; i < paramCount; i++) {
            cmdBuf.putInt(params[i]);
        }

        byte[] cmdBytes = cmdBuf.array();
        int sent = connection.bulkTransfer(epOut, cmdBytes, cmdBytes.length, timeoutMs);
        if (sent < 0) return null;

        if (dataOut != null && dataOut.length > 0) {
            int dataLen = 12 + dataOut.length;
            ByteBuffer dataBuf = ByteBuffer.allocate(dataLen).order(ByteOrder.LITTLE_ENDIAN);
            dataBuf.putInt(dataLen);
            dataBuf.putShort(PTP_CNT_DATA);
            dataBuf.putShort((short) opCode);
            dataBuf.putInt(tid);
            dataBuf.put(dataOut);
            byte[] dataBytes = dataBuf.array();
            int dataSent = connection.bulkTransfer(epOut, dataBytes, dataBytes.length, timeoutMs);
            if (dataSent < 0) return null;
        }

        PtpTransactionResult result = new PtpTransactionResult();
        byte[] readChunk = new byte[32768];

        int r1 = connection.bulkTransfer(epIn, readChunk, readChunk.length, timeoutMs);
        if (r1 < 12) return null;

        int totalContainerLen = readIntLE(readChunk, 0);
        short containerType = readShortLE(readChunk, 4);
        int containerCode = readShortLE(readChunk, 6) & 0xFFFF;

        if (containerType == PTP_CNT_RESPONSE) {
            result.responseCode = containerCode;
            return result;
        }

        if (containerType == PTP_CNT_DATA) {
            long unsignedLen = totalContainerLen & 0xFFFFFFFFL;
            boolean isUnbounded = (unsignedLen == 0xFFFFFFFFL || totalContainerLen <= 12);
            int expectedDataBytes = isUnbounded ? -1 : (int) (unsignedLen - 12);

            ByteArrayOutputStream bos = new ByteArrayOutputStream(isUnbounded ? 131072 : Math.min(expectedDataBytes, 1048576));

            int firstPayloadBytes = isUnbounded ? (r1 - 12) : Math.min(r1 - 12, expectedDataBytes);
            if (firstPayloadBytes > 0) {
                bos.write(readChunk, 12, firstPayloadBytes);
            }

            // Check if trailing PTP_CNT_RESPONSE was already coalesced into r1
            int remInFirst = r1 - (12 + firstPayloadBytes);
            if (remInFirst >= 12) {
                int respOffset = 12 + firstPayloadBytes;
                if (readShortLE(readChunk, respOffset + 4) == PTP_CNT_RESPONSE) {
                    result.responseCode = readShortLE(readChunk, respOffset + 6) & 0xFFFF;
                    result.dataPayload = bos.toByteArray();
                    return result;
                }
            }

            if (!isUnbounded) {
                // Known length
                while (bos.size() < expectedDataBytes) {
                    int nr = connection.bulkTransfer(epIn, readChunk, readChunk.length, timeoutMs);
                    if (nr <= 0) break;

                    int needed = expectedDataBytes - bos.size();
                    int toCopy = Math.min(nr, needed);
                    if (toCopy > 0) {
                        bos.write(readChunk, 0, toCopy);
                    }

                    int rem = nr - toCopy;
                    if (rem >= 12) {
                        if (readShortLE(readChunk, toCopy + 4) == PTP_CNT_RESPONSE) {
                            result.responseCode = readShortLE(readChunk, toCopy + 6) & 0xFFFF;
                            result.dataPayload = bos.toByteArray();
                            return result;
                        }
                    }
                }
                if (bos.size() < expectedDataBytes) {
                    Log.w(TAG, "PTP data transfer incomplete: read " + bos.size() + "/" + expectedDataBytes + " bytes");
                    drainBulkInEndpoint();
                }
            } else {
                // Unbounded / Streaming length (Sony LiveView 0xFFFFC002)
                int epMaxPacket = epIn.getMaxPacketSize();
                if (epMaxPacket <= 0) epMaxPacket = 512;

                while (bos.size() < 1048576) {
                    int nr = connection.bulkTransfer(epIn, readChunk, readChunk.length, 500);
                    if (nr <= 0) break;

                    // Check if this packet is a standalone PTP_CNT_RESPONSE (12 bytes)
                    if (nr == 12 && readShortLE(readChunk, 4) == PTP_CNT_RESPONSE) {
                        result.responseCode = readShortLE(readChunk, 6) & 0xFFFF;
                        result.dataPayload = bos.toByteArray();
                        return result;
                    }

                    // Check if PTP_CNT_RESPONSE is at the end of this packet
                    if (nr > 12 && readShortLE(readChunk, nr - 8) == PTP_CNT_RESPONSE) {
                        result.responseCode = readShortLE(readChunk, nr - 6) & 0xFFFF;
                        bos.write(readChunk, 0, nr - 12);
                        result.dataPayload = bos.toByteArray();
                        return result;
                    }

                    bos.write(readChunk, 0, nr);

                    // If short packet and JPEG end marker seen, break
                    if (nr < readChunk.length && hasJpegEoi(readChunk, nr)) {
                        break;
                    }
                }
            }

            result.dataPayload = bos.toByteArray();

            // Read the trailing 12-byte PTP_CNT_RESPONSE packet if not yet captured
            int r2 = connection.bulkTransfer(epIn, readChunk, readChunk.length, 450);
            if (r2 >= 12 && readShortLE(readChunk, 4) == PTP_CNT_RESPONSE) {
                result.responseCode = readShortLE(readChunk, 6) & 0xFFFF;
            } else {
                result.responseCode = PTP_RC_OK;
            }
        }

        return result;
    }
}

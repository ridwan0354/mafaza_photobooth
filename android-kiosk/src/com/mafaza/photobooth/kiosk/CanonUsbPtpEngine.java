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
    public String getLiveViewDiagnostic() { return isSonyCamera ? lastSonyDiag : "Frame: " + totalFramesReceived; }

    public long getTotalFramesReceived() {
        return totalFramesReceived;
    }

    public void scanAndConnectIfAvailable() {
        lastPermissionRequestMs = 0; // Reset cooldown on manual tap
        new Thread(() -> {
            synchronized (usbLock) {
                if (isConnected && !hasLiveFrame() && !isCapturingPhoto) closeCurrentConnection();
            }
            scanForCameraDevices();
        }, "UsbCameraScan").start();
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
                    + "2. Nyalakan kamera dan pastikan baterainya cukup.\n"
                    + "3. Sony A7 III: USB Connection = PC Remote, Ctrl w/ Smartphone = Off.\n"
                    + "4. Untuk flash hot shoe: Silent Shooting = Off, pilih format JPEG.";
        }
        StringBuilder sb = new StringBuilder();
        sb.append("🔌 Terdeteksi ").append(map.size()).append(" perangkat di port USB OTG:\n");
        for (UsbDevice d : map.values()) {
            String pName = (Build.VERSION.SDK_INT >= 21 && d.getProductName() != null) ? d.getProductName() : d.getDeviceName();
            boolean hasPerm = usbManager.hasPermission(d);
            sb.append("• ").append(pName)
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
        sb.append("\nStatus Sesi PTP: ").append(isConnected ? "TERHUBUNG (" + cameraModelName + ")" : "BELUM TERHUBUNG");
        sb.append("\nFrame Live View diterima: ").append(totalFramesReceived);
        if (!lastConnectionError.isEmpty()) sb.append("\nKoneksi: ").append(lastConnectionError);
        if (!lastConnectionDiagnostic.isEmpty()) sb.append("\nDetail USB: ").append(lastConnectionDiagnostic);
        if (!lastCaptureError.isEmpty()) sb.append("\nFoto: ").append(lastCaptureError);
        if (isSonyCamera) {
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
                                if (isSonyCamera) {
                                    drainBulkInEndpoint();
                                    setSonyExtPropUInt8Locked(SONY_PROP_LIVEVIEW_STATUS, 1);
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
            notifyStatus("USB kamera: Sambungkan kabel USB-C data");
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
        lastTransportDiagnostic = "";
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
                // Some PC Remote interfaces are vendor-specific. Never send PTP
                // commands to a storage, audio or video interface as a fallback.
                for (int i = 0; i < dev.getInterfaceCount(); i++) {
                    UsbInterface candidate = dev.getInterface(i);
                    if (candidate.getInterfaceClass() == 255) { targetIf = candidate; break; }
                }
            }
            if (targetIf == null) throw new IOException("Mode USB kamera belum mendukung PTP. Sony: pilih PC Remote lalu sambungkan ulang kabel.");

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
            if (bulkOut == null || bulkIn == null) throw new IOException("Mode USB kamera belum mendukung remote. Sony: pilih PC Remote.");

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
            this.transactionId = 0;
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

            notifyStatus("Menghubungkan " + cameraModelName + " melalui USB...");
            // OpenSession is outside a session: TransactionID MUST be zero.
            // Subsequent requests begin at one. Do not relax response validation.
            // See AOSP media/mtp/MtpDevice.cpp::openSession.
            drainBulkInEndpoint();
            int rc = openCameraSessionLocked();
            if (rc == PTP_RC_SESSION_ALREADY_OPEN) {
                sendPtpCommandLocked(PTP_OC_CLOSE_SESSION, new int[0], null);
                rc = openCameraSessionLocked();
            } else if (rc < 0) {
                // One bounded retry for a slow USB initialization. A timeout does
                // not establish a session, so do not send CloseSession here.
                Thread.sleep(200);
                drainBulkInEndpoint();
                rc = openCameraSessionLocked();
            }
            requirePtpOk(rc, "Membuka sesi kamera");

            if (isSonyCamera) {
                // Sony Alpha (A7 III / ILCE-7M3) PC Remote Handshake Sequence
                drainBulkInEndpoint();
                requirePtpOk(sendPtpCommandLocked(PTP_OC_SONY_SDIO_CONNECT, new int[]{1, 0, 0}, null), "Sony PC Remote tahap 1");
                requirePtpOk(sendPtpCommandLocked(PTP_OC_SONY_SDIO_CONNECT, new int[]{2, 0, 0}, null), "Sony PC Remote tahap 2");
                requirePtpOk(sendPtpCommandLocked(PTP_OC_SONY_SDIO_GET_EXT_DEVICE_INFO, new int[]{0x00C8}, null), "Informasi Sony PC Remote");
                requirePtpOk(sendPtpCommandLocked(PTP_OC_SONY_SDIO_CONNECT, new int[]{3, 0, 0}, null), "Sony PC Remote tahap 3");
                requirePtpOk(sendPtpCommandLocked(PTP_OC_SONY_GET_ALL_EXT_DEVICE_PROP_INFO, new int[0], null), "Status Sony PC Remote");

                // Arm Sony Alpha LiveView virtual stream handle (0xFFFFC002)
                setSonyExtPropUInt8Locked(SONY_PROP_LIVEVIEW_STATUS, 1);
                executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_LIVEVIEW_FRAME}, null, 600);
            } else {
                // Canon EOS (1300D / Rebel T6, etc.) Remote Mode + LiveView Handshake Sequence
                requirePtpOk(sendPtpCommandLocked(PTP_OC_CANON_SET_REMOTE_MODE, new int[]{1}, null), "Canon Remote Mode");
                requirePtpOk(sendPtpCommandLocked(PTP_OC_CANON_SET_EVENT_MODE, new int[]{1}, null), "Canon Event Mode");
                try { Thread.sleep(80); } catch (InterruptedException ignored) {}
                drainCanonEventsLocked();
                drainCanonEventsLocked();
                // Set Capture Destination: 4 = RAM/Host on Canon EOS PTP (fallback 2 = Host)
                if (setCanonPropExLocked(PROP_CAPTURE_DESTINATION, 4) != PTP_RC_OK) {
                    requirePtpOk(setCanonPropExLocked(PROP_CAPTURE_DESTINATION, 2), "Tujuan penyimpanan foto Canon");
                }
                drainCanonEventsLocked();
                enableCanonLiveViewOutputLocked();
            }

            this.isConnected = true;
            lastConnectionError = "";
            lastConnectionDiagnostic = "";
            notifyStatus(this.cameraModelName + ": Sesi USB siap, menunggu Live View...");
            Log.i(TAG, "USB PTP Session Connected: " + this.cameraModelName + " (Sony=" + isSonyCamera + ")");
        } catch (Exception e) {
            Log.e(TAG, "Failed to open USB PTP connection", e);
            lastConnectionDiagnostic = lastTransportDiagnostic;
            closeCurrentConnection();
            lastConnectionError = e.getMessage() == null ? "Koneksi kamera gagal." : e.getMessage();
            notifyStatus(lastConnectionError);
        }
    }

    private int openCameraSessionLocked() {
        transactionId = 0;
        PtpTransactionResult result = executePtpTransactionLocked(PTP_OC_OPEN_SESSION, new int[]{1}, null, 8000);
        return result == null ? -1 : result.responseCode;
    }

    private void requirePtpOk(int rc, String action) throws IOException {
        if (rc != PTP_RC_OK) {
            String detail = rc < 0 ? "USB tidak merespons lengkap" : "PTP 0x" + Integer.toHexString(rc);
            String tip = isSonyCamera ? "Sony: periksa USB Connection = PC Remote." : "Canon: nonaktifkan Wi-Fi/NFC lalu sambungkan ulang USB.";
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
            lastCaptureError = "";
            lastCapturedFullJpeg = null;
            if (!isConnected) {
                lastCaptureError = "Kamera USB belum siap. Periksa kabel dan pilih PC Remote pada Sony.";
                return null;
            }
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
            // 1. Drain bulk endpoint to ensure clean USB pipe before shutter
            drainBulkInEndpoint();

            // 2. Half-press to trigger AF/AE lock (2 = Down)
            shutterAttempted = true;
            requirePtpOk(sendSonyControlUInt16Locked(SONY_CTRL_HALF_PRESS_SHUTTER, 2), "Fokus Sony");
            Thread.sleep(200);

            // 3. Full-press to release shutter and fire Godox flash via Hotshoe X-sync (2 = Down)
            requirePtpOk(sendSonyControlUInt16Locked(SONY_CTRL_CAPTURE_SHUTTER, 2), "Shutter Sony");
            photoPending = true;
            Thread.sleep(200);

            // 4. Release buttons cleanly with staggering (1 = Up)
            requirePtpOk(sendSonyControlUInt16Locked(SONY_CTRL_CAPTURE_SHUTTER, 1), "Melepas shutter Sony");
            Thread.sleep(100);
            requirePtpOk(sendSonyControlUInt16Locked(SONY_CTRL_HALF_PRESS_SHUTTER, 1), "Melepas fokus Sony");
            shutterAttempted = false;

            // 5. Post-shutter quiet grace period:
            // Allow time for sensor readout before polling the camera's image buffer.
            Thread.sleep(600);
            drainBulkInEndpoint();

            // Fetch the actual still image. A preview is never a substitute for this object.
            long deadline = System.currentTimeMillis() + 12000;
            while (System.currentTimeMillis() < deadline) {
                PtpTransactionResult infoRes = executePtpTransactionLocked(
                        PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_IN_MEMORY_IMAGE}, null, 400);
                if (infoRes != null && infoRes.responseCode == PTP_RC_OK) {
                    if (infoRes.dataPayload == null || infoRes.dataPayload.length < 12) {
                        throw new IOException("Informasi foto Sony tidak lengkap.");
                    }
                    int compressedSize = readIntLE(infoRes.dataPayload, 8);
                    if (compressedSize < 0 || compressedSize > 64 * 1024 * 1024) {
                        throw new IOException("Ukuran foto Sony tidak valid. Pilih format JPEG.");
                    }
                    PtpTransactionResult imgRes = executePtpTransactionLocked(
                            PTP_OC_GET_OBJECT, new int[]{SONY_HANDLE_IN_MEMORY_IMAGE}, null, 20000);
                    requirePtpOk(imgRes == null ? -1 : imgRes.responseCode, "Mengunduh foto Sony");
                    if ((readShortLE(infoRes.dataPayload, 4) & 0xffff) != 0x3801) {
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
                Thread.sleep(100);
            }
            drainBulkInEndpoint();

        } catch (Exception e) {
            Log.w(TAG, "Sony capture error: " + e.getMessage());
            lastCaptureError = "Foto Sony gagal: " + e.getMessage();
            lastCapturedFullJpeg = null;
            drainBulkInEndpoint();
        } finally {
            // Release even if AF, shutter or USB transfer failed midway.
            if (shutterAttempted) {
                sendSonyControlUInt16Locked(SONY_CTRL_CAPTURE_SHUTTER, 1);
                sendSonyControlUInt16Locked(SONY_CTRL_HALF_PRESS_SHUTTER, 1);
            }
            setSonyExtPropUInt8Locked(SONY_PROP_LIVEVIEW_STATUS, 1);
            executePtpTransactionLocked(PTP_OC_GET_OBJECT_INFO, new int[]{SONY_HANDLE_LIVEVIEW_FRAME}, null, 500);
            lastKeepAliveMs = System.currentTimeMillis();
            // A failed download must not leave an old image queued for the next
            // pose. The next scan establishes a fresh remote session.
            if (photoPending) closeCurrentConnection();
        }

        if (lastCapturedFullJpeg != null && lastCapturedFullJpeg.length > 2048) {
            return lastCapturedFullJpeg;
        }
        if (lastCaptureError.isEmpty()) lastCaptureError = "Foto asli Sony belum diterima. Periksa JPEG, PC Remote, lalu ambil ulang pose ini.";
        return null;
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

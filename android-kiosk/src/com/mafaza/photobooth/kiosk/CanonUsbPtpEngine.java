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
 * Native Android USB Host PTP Driver for Canon EOS Cameras (e.g. Canon EOS 1300D) on Redmi Pad 2.
 * Communicates directly over USB OTG using ISO 15740 PTP + Canon EOS Vendor Extensions (0x91xx).
 */
public class CanonUsbPtpEngine {
    private static final String TAG = "CanonUsbPtpEngine";
    public static final String ACTION_USB_PERMISSION = "com.mafaza.photobooth.kiosk.USB_PERMISSION";
    public static final int CANON_VENDOR_ID = 0x04A9; // 1193

    // Standard PTP Operation Codes
    private static final int PTP_OC_OPEN_SESSION = 0x1002;
    private static final int PTP_OC_CLOSE_SESSION = 0x1003;
    private static final int PTP_OC_GET_OBJECT = 0x1009;
    private static final int PTP_OC_INITIATE_CAPTURE = 0x100E;
    private static final int PTP_OC_SET_DEVICE_PROP_VALUE = 0x1016;

    // Canon EOS Vendor PTP Operation Codes
    private static final int PTP_OC_CANON_GET_PARTIAL_OBJECT = 0x9107;
    private static final int PTP_OC_CANON_CAPTURE = 0x910F;
    private static final int PTP_OC_CANON_SET_PROP_EX = 0x9110;
    private static final int PTP_OC_CANON_SET_REMOTE_MODE = 0x9114;
    private static final int PTP_OC_CANON_SET_EVENT_MODE = 0x9115;
    private static final int PTP_OC_CANON_GET_EVENT = 0x9116;
    private static final int PTP_OC_CANON_TRANSFER_COMPLETE = 0x9117;
    private static final int PTP_OC_CANON_KEEP_DEVICE_ON = 0x911D;
    private static final int PTP_OC_CANON_REMOTE_RELEASE_ON = 0x9128;
    private static final int PTP_OC_CANON_REMOTE_RELEASE_OFF = 0x9129;
    private static final int PTP_OC_CANON_GET_VIEWFINDER_DATA = 0x9153;
    private static final int PTP_OC_CANON_DO_AF = 0x9154;
    private static final int PTP_OC_CANON_DRIVE_LENS = 0x9155;
    private static final int PTP_OC_CANON_AF_CANCEL = 0x9160;

    // Canon EOS Property Codes
    public static final int PROP_APERTURE = 0xD101;
    public static final int PROP_SHUTTER_SPEED = 0xD102;
    public static final int PROP_ISO = 0xD103;
    public static final int PROP_WHITE_BALANCE = 0xD105;
    public static final int PROP_AUTO_EXPOSURE_MODE = 0xD105;
    public static final int PROP_CAPTURE_DESTINATION = 0xD11C;
    public static final int PROP_EVF_OUTPUT_DEVICE = 0xD1B0;
    public static final int PROP_EVF_MODE = 0xD1B1;

    // PTP Container Types
    private static final short PTP_CNT_COMMAND = 1;
    private static final short PTP_CNT_DATA = 2;
    private static final short PTP_CNT_RESPONSE = 3;

    // PTP Response Codes
    private static final int PTP_RC_OK = 0x2001;
    private static final int PTP_RC_DEVICE_BUSY = 0x2019;
    private static final int PTP_RC_SESSION_ALREADY_OPEN = 0x201E;

    public interface Listener {
        void onCameraConnected(String modelName);
        void onCameraDisconnected();
        void onStatusMessage(String message);
    }

    private final Context context;
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
    private volatile String cameraModelName = "Canon EOS 1300D";
    private volatile byte[] latestLiveViewJpeg = null;
    private volatile byte[] lastCapturedFullJpeg = null;
    private int transactionId = 1;

    // Cached Camera Hardware State
    private volatile int currentIso = 96; // ISO 800
    private volatile int currentTv = 112; // 1/125
    private volatile int currentAv = 48;  // f/5.6
    private volatile int currentWb = 0;   // AWB
    private volatile int currentAeMode = 3; // Manual
    private volatile int lastCmdError = 0;

    private Thread workerThread;
    private boolean permissionRequestPending = false;

    private final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            String action = intent.getAction();
            if (ACTION_USB_PERMISSION.equals(action)) {
                permissionRequestPending = false;
                UsbDevice dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                if (granted && dev != null) {
                    showToast("📸 Izin USB Canon diberikan! Menghubungkan Live View...");
                    connectToDeviceAsync(dev);
                }
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                UsbDevice dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                if (dev != null && isCanonOrPtpDevice(dev)) {
                    showToast("🔌 Kamera Canon EOS terdeteksi di USB OTG!");
                    checkAndConnectDevice(dev);
                }
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                UsbDevice dev = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                if (dev != null && activeDevice != null && dev.getDeviceId() == activeDevice.getDeviceId()) {
                    showToast("⚠️ Kamera Canon EOS terputus dari USB.");
                    closeCurrentConnection();
                }
            }
        }
    };

    public CanonUsbPtpEngine(Context context) {
        this(context, null);
    }

    public CanonUsbPtpEngine(Context context, Listener listener) {
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
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            context.registerReceiver(usbReceiver, filter);
        }

        workerThread = new Thread(this::runMainLoop, "CanonUsbPtpWorker");
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

    public void scanAndConnectIfAvailable() {
        new Thread(this::scanForCanonDevices, "CanonUsbScan").start();
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

    public boolean isUsbSessionConnected() {
        return isConnected;
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

    private boolean isCanonOrPtpDevice(UsbDevice dev) {
        if (dev == null) return false;
        if (dev.getVendorId() == CANON_VENDOR_ID) return true;
        for (int i = 0; i < dev.getInterfaceCount(); i++) {
            if (dev.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_STILL_IMAGE) {
                return true;
            }
        }
        return false;
    }

    private void checkAndConnectDevice(UsbDevice dev) {
        if (dev == null || usbManager == null) return;
        if (usbManager.hasPermission(dev)) {
            connectToDeviceAsync(dev);
        } else if (!permissionRequestPending) {
            permissionRequestPending = true;
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) {
                flags |= 0x02000000; // PendingIntent.FLAG_MUTABLE
            }
            Intent permIntent = new Intent(ACTION_USB_PERMISSION);
            permIntent.setPackage(context.getPackageName());
            PendingIntent pi = PendingIntent.getBroadcast(context, 0, permIntent, flags);
            usbManager.requestPermission(dev, pi);
        }
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
        long lastKeepAlive = 0;
        int consecutiveFailures = 0;

        while (isRunning) {
            try {
                if (!isConnected) {
                    scanForCanonDevices();
                    Thread.sleep(1500);
                    continue;
                }

                byte[] frame = null;
                synchronized (usbLock) {
                    if (!isConnected) continue;

                    long now = System.currentTimeMillis();
                    if (now - lastKeepAlive > 4000) {
                        sendPtpCommandLocked(PTP_OC_CANON_KEEP_DEVICE_ON, new int[0], null);
                        drainCanonEventsLocked();
                        lastKeepAlive = now;
                    }

                    frame = fetchLiveViewFrameLocked();
                }

                if (frame != null && frame.length > 512) {
                    latestLiveViewJpeg = frame;
                    consecutiveFailures = 0;
                    Thread.sleep(36); // ~25 FPS smooth Live View
                } else {
                    consecutiveFailures++;
                    if (consecutiveFailures % 12 == 0) {
                        synchronized (usbLock) {
                            enableCanonLiveViewOutputLocked();
                        }
                    }
                    if (consecutiveFailures > 80) {
                        Log.w(TAG, "Too many empty EVF frames, resetting Canon PTP session...");
                        closeCurrentConnection();
                        consecutiveFailures = 0;
                    }
                    Thread.sleep(90);
                }
            } catch (InterruptedException ie) {
                break;
            } catch (Exception e) {
                Log.e(TAG, "Loop error: " + e.getMessage());
                try { Thread.sleep(250); } catch (InterruptedException ignored) {}
            }
        }
    }

    private void scanForCanonDevices() {
        if (usbManager == null) return;
        HashMap<String, UsbDevice> map = usbManager.getDeviceList();
        if (map == null || map.isEmpty()) return;
        for (UsbDevice dev : map.values()) {
            if (isCanonOrPtpDevice(dev)) {
                checkAndConnectDevice(dev);
                return;
            }
        }
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

            String prodName = (Build.VERSION.SDK_INT >= 21 && dev.getProductName() != null)
                    ? dev.getProductName().trim()
                    : "";
            this.cameraModelName = prodName.isEmpty() ? "Canon EOS 1300D" : prodName;

            // 1. Open PTP Session
            int rc = sendPtpCommandLocked(PTP_OC_OPEN_SESSION, new int[]{1}, null);
            if (rc == PTP_RC_SESSION_ALREADY_OPEN || rc != PTP_RC_OK) {
                sendPtpCommandLocked(PTP_OC_CLOSE_SESSION, new int[0], null);
                this.transactionId = 1;
                sendPtpCommandLocked(PTP_OC_OPEN_SESSION, new int[]{1}, null);
            }

            // 2. Enable Canon EOS Remote Mode & Extended Event Mode
            sendPtpCommandLocked(PTP_OC_CANON_SET_REMOTE_MODE, new int[]{1}, null);
            sendPtpCommandLocked(PTP_OC_CANON_SET_EVENT_MODE, new int[]{1}, null);
            drainCanonEventsLocked();

            // 3. Set Capture Destination to RAM + SD Card (4 = PC/RAM, 2 = SD Card, 6 = Both)
            setCanonPropExLocked(PROP_CAPTURE_DESTINATION, 6);

            // 4. Enable Live View (EVF Mode = 1, EVF Output Device = 2 [PC] / 3 [TFT+PC])
            enableCanonLiveViewOutputLocked();

            this.isConnected = true;
            if (listener != null) {
                listener.onCameraConnected(this.cameraModelName);
            }
            showToast("✅ " + this.cameraModelName + " Terhubung! Live View & Flash Hotshoe Aktif.");
            Log.i(TAG, "Canon PTP Session Connected: " + this.cameraModelName);
        } catch (Exception e) {
            Log.e(TAG, "Failed to open Canon PTP connection", e);
            closeCurrentConnection();
        }
    }

    private void enableCanonLiveViewOutputLocked() {
        setCanonPropExLocked(PROP_EVF_MODE, 1);
        try { Thread.sleep(60); } catch (InterruptedException ignored) {}
        // Value 2 = PC/USB stream, Value 3 = Camera LCD + PC/USB stream
        setCanonPropExLocked(PROP_EVF_OUTPUT_DEVICE, 2);
        try { Thread.sleep(150); } catch (InterruptedException ignored) {}
        drainCanonEventsLocked();
    }

    private void closeCurrentConnection() {
        synchronized (usbLock) {
            boolean wasConnected = isConnected;
            isConnected = false;
            latestLiveViewJpeg = null;
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

    public boolean setHardwareProperty(String propName, int val) {
        synchronized (usbLock) {
            if (!isConnected) return false;
            int propCode = 0;
            if ("iso".equalsIgnoreCase(propName)) {
                propCode = PROP_ISO;
                currentIso = val;
            } else if ("tv".equalsIgnoreCase(propName)) {
                propCode = PROP_SHUTTER_SPEED;
                currentTv = val;
            } else if ("av".equalsIgnoreCase(propName)) {
                propCode = PROP_APERTURE;
                currentAv = val;
            } else if ("wb".equalsIgnoreCase(propName)) {
                propCode = PROP_WHITE_BALANCE;
                currentWb = val;
            }
            if (propCode == 0) return false;

            int rc = setCanonPropExLocked(propCode, val);
            lastCmdError = (rc == PTP_RC_OK) ? 0 : rc;
            drainCanonEventsLocked();
            return rc == PTP_RC_OK;
        }
    }

    public boolean triggerAutoFocus() {
        synchronized (usbLock) {
            if (!isConnected) return false;
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

    public boolean stepManualFocus(int stepCode) {
        synchronized (usbLock) {
            if (!isConnected) return false;
            int rc = sendPtpCommandLocked(PTP_OC_CANON_DRIVE_LENS, new int[]{stepCode}, null);
            drainCanonEventsLocked();
            return rc == PTP_RC_OK;
        }
    }

    /**
     * Triggers the physical Canon EOS 1300D shutter over USB.
     * Drops Live View mirror momentarily so the hotshoe X-Sync pin fires the Godox CT-16 Flash 100%,
     * downloads the captured JPEG from the camera, and resumes Live View.
     */
    public byte[] capturePhotoWithFlash() {
        synchronized (usbLock) {
            if (!isConnected) return latestLiveViewJpeg;

            byte[] backupFrame = latestLiveViewJpeg;
            lastCapturedFullJpeg = null;

            try {
                // 1. Set EVF Output to 0 briefly so mechanical shutter & hotshoe X-sync (Godox CT-16) fire reliably on EOS 1300D
                setCanonPropExLocked(PROP_EVF_OUTPUT_DEVICE, 0);
                Thread.sleep(160);
                drainCanonEventsLocked();

                // 2. Fire Full Shutter Release (Half-press 1 -> Full-press 2 -> Release)
                int rc1 = sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_ON, new int[]{1, 0}, null);
                int rc2 = sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_ON, new int[]{2, 0}, null);
                Thread.sleep(140);
                sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_OFF, new int[]{2}, null);
                sendPtpCommandLocked(PTP_OC_CANON_REMOTE_RELEASE_OFF, new int[]{1}, null);

                if (rc1 != PTP_RC_OK && rc2 != PTP_RC_OK) {
                    int rcCap = sendPtpCommandLocked(PTP_OC_CANON_CAPTURE, new int[0], null);
                    if (rcCap != PTP_RC_OK) {
                        sendPtpCommandLocked(PTP_OC_INITIATE_CAPTURE, new int[]{0, 0}, null);
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
                Log.w(TAG, "Capture error: " + e.getMessage());
            } finally {
                // 4. Immediately resume Live View for the next pose!
                enableCanonLiveViewOutputLocked();
            }

            if (lastCapturedFullJpeg != null && lastCapturedFullJpeg.length > 2048) {
                latestLiveViewJpeg = lastCapturedFullJpeg;
                return lastCapturedFullJpeg;
            }
            return (latestLiveViewJpeg != null) ? latestLiveViewJpeg : backupFrame;
        }
    }

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
        PtpTransactionResult res = executePtpTransactionLocked(PTP_OC_CANON_GET_EVENT, new int[0], null, 450);
        if (res != null && res.dataPayload != null && res.dataPayload.length >= 8) {
            parseCanonEventsForPropertiesLocked(res.dataPayload);
        }
    }

    private int pollCanonTransferObjectHandleLocked() {
        PtpTransactionResult res = executePtpTransactionLocked(PTP_OC_CANON_GET_EVENT, new int[0], null, 600);
        if (res == null || res.dataPayload == null || res.dataPayload.length < 8) return 0;

        byte[] buf = res.dataPayload;
        ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
        int offset = 0;
        while (offset + 8 <= buf.length) {
            int recordSize = bb.getInt(offset);
            int eventCode = bb.getInt(offset + 4);
            if (recordSize < 8 || offset + recordSize > buf.length) break;

            // 0xC186 = RequestObjectTransfer, 0xC1A7 = RequestObjectTransferEx, 0x4002 = ObjectAdded
            if ((eventCode == 0xC186 || eventCode == 0xC1A7 || eventCode == 0x4002) && recordSize >= 12) {
                int objectHandle = bb.getInt(offset + 8);
                if (objectHandle != 0) return objectHandle;
            }
            offset += recordSize;
        }
        return 0;
    }

    private void parseCanonEventsForPropertiesLocked(byte[] buf) {
        try {
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
            int offset = 0;
            while (offset + 8 <= buf.length) {
                int recordSize = bb.getInt(offset);
                int eventCode = bb.getInt(offset + 4);
                if (recordSize < 8 || offset + recordSize > buf.length) break;

                // 0xC189 = PropValueChanged
                if (eventCode == 0xC189 && recordSize >= 16) {
                    int propCode = bb.getInt(offset + 8);
                    int propVal = bb.getInt(offset + 12);
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

    private byte[] fetchLiveViewFrameLocked() {
        PtpTransactionResult res = executePtpTransactionLocked(
                PTP_OC_CANON_GET_VIEWFINDER_DATA,
                new int[]{0x00100000},
                null,
                600
        );
        if (res == null || res.dataPayload == null || res.dataPayload.length < 256) {
            return null;
        }
        return extractJpegFromBuffer(res.dataPayload);
    }

    private byte[] extractJpegFromBuffer(byte[] data) {
        if (data == null || data.length < 128) return null;
        int startIdx = -1;
        for (int i = 0; i < data.length - 3; i++) {
            if ((data[i] & 0xFF) == 0xFF && (data[i + 1] & 0xFF) == 0xD8 && (data[i + 2] & 0xFF) == 0xFF) {
                startIdx = i;
                break;
            }
        }
        if (startIdx == -1) return null;

        int endIdx = -1;
        for (int i = data.length - 2; i > startIdx + 64; i--) {
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

    private int sendPtpCommandLocked(int opCode, int[] params, byte[] dataOut) {
        PtpTransactionResult res = executePtpTransactionLocked(opCode, params, dataOut, 900);
        return (res != null) ? res.responseCode : -1;
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
        byte[] readChunk = new byte[65536];

        // Read first incoming container (either DATA or RESPONSE)
        int r1 = connection.bulkTransfer(epIn, readChunk, readChunk.length, timeoutMs);
        if (r1 < 12) return null;

        ByteBuffer header1 = ByteBuffer.wrap(readChunk, 0, r1).order(ByteOrder.LITTLE_ENDIAN);
        int totalContainerLen = header1.getInt(0);
        short containerType = header1.getShort(4);
        int containerCode = header1.getShort(6) & 0xFFFF;

        if (containerType == PTP_CNT_RESPONSE) {
            result.responseCode = containerCode;
            return result;
        }

        if (containerType == PTP_CNT_DATA) {
            int expectedDataBytes = Math.max(0, totalContainerLen - 12);
            ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.min(expectedDataBytes, 524288));
            bos.write(readChunk, 12, r1 - 12);

            while (bos.size() < expectedDataBytes) {
                int nr = connection.bulkTransfer(epIn, readChunk, readChunk.length, timeoutMs);
                if (nr <= 0) break;
                // Check if the tail of a transfer already includes the 12-byte PTP response container
                if (bos.size() + nr > expectedDataBytes) {
                    int needed = expectedDataBytes - bos.size();
                    if (needed > 0 && needed <= nr) {
                        bos.write(readChunk, 0, needed);
                    }
                    int rem = nr - needed;
                    if (rem >= 12) {
                        ByteBuffer respTail = ByteBuffer.wrap(readChunk, needed, rem).order(ByteOrder.LITTLE_ENDIAN);
                        if (respTail.getShort(4) == PTP_CNT_RESPONSE) {
                            result.responseCode = respTail.getShort(6) & 0xFFFF;
                            result.dataPayload = bos.toByteArray();
                            return result;
                        }
                    }
                    break;
                } else {
                    bos.write(readChunk, 0, nr);
                }
            }
            result.dataPayload = bos.toByteArray();

            // Read the trailing RESPONSE container
            int r2 = connection.bulkTransfer(epIn, readChunk, readChunk.length, timeoutMs);
            if (r2 >= 12) {
                ByteBuffer header2 = ByteBuffer.wrap(readChunk, 0, r2).order(ByteOrder.LITTLE_ENDIAN);
                result.responseCode = header2.getShort(6) & 0xFFFF;
            } else {
                result.responseCode = PTP_RC_OK;
            }
        }

        return result;
    }
}

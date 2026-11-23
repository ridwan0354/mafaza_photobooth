package com.mafaza.photobooth.kiosk;

import android.content.Context;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Queue;

public class CanonUsbPtpEngineTest {
    static int passed;
    static final byte[] JPEG = new byte[4096];
    static {
        Arrays.fill(JPEG, (byte) 0x55);
        JPEG[0] = (byte) 0xff; JPEG[1] = (byte) 0xd8;
        JPEG[JPEG.length - 2] = (byte) 0xff; JPEG[JPEG.length - 1] = (byte) 0xd9;
    }
    static class Device extends UsbDevice {
        final int vid;
        final String name;
        final int usbClass;
        Device(boolean sony) { this(sony ? 0x054c : 0x04a9, sony ? "ILCE-7M3" : "Canon EOS 1300D", 6); }
        Device(boolean sony, int usbClass) { this(sony ? 0x054c : 0x04a9, sony ? "ILCE-7M3" : "Canon EOS 1300D", usbClass); }
        Device(int vid, String name, int usbClass) { this.vid = vid; this.name = name; this.usbClass = usbClass; }
        @Override public int getVendorId() { return vid; }
        @Override public String getProductName() { return name; }
        @Override public UsbInterface getInterface(int i) {
            return new UsbInterface() { @Override public int getInterfaceClass() { return usbClass; } };
        }
    }
    static class Listener implements CanonUsbPtpEngine.Listener {
        int live;
        long physicalSeq;
        String physicalSource = "";
        public void onCameraConnected(String s) { live++; }
        public void onCameraDisconnected() {}
        public void onStatusMessage(String s) {}
        @Override public void onPhysicalShutterCaptured(long seq, String source) {
            physicalSeq = seq;
            physicalSource = source;
        }
    }
    static class USB extends UsbDeviceConnection {
        final Queue<byte[]> replies = new ArrayDeque<>();
        final List<String> controls = new ArrayList<>();
        final List<Integer> operations = new ArrayList<>();
        final List<String> transactions = new ArrayList<>();
        int rejectOp = -1;
        int pendingProperty;
        boolean rejectShutter;
        boolean omitPhotoResponse;
        boolean canonShot;
        boolean canonAddedEx;
        boolean canonPartialOnly;
        boolean canonRawAndJpeg;
        boolean timeoutFirstOpen;
        boolean noOpenResponse;
        boolean alreadyOpenOnce;
        boolean requireTid1ForOpen;
        boolean requireResetBeforeOpen;
        boolean genericShotCaptured;
        boolean useGenericHandlesList;
        final List<Integer> genericHandles = new ArrayList<>();
        int mtpRejectOp = -1;
        int livePropertySize;
        byte[] customSonyPropsData = null;
        @Override public int bulkTransfer(UsbEndpoint ep, byte[] bytes, int length, int timeout) {
            if (ep.getDirection() == 128) {
                byte[] reply = replies.poll();
                if (reply == null) return -1;
                System.arraycopy(reply, 0, bytes, 0, reply.length);
                return reply.length;
            }
            ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
            int type = b.getShort(4) & 0xffff;
            int op = b.getShort(6) & 0xffff;
            int tid = b.getInt(8);
            if (type == 2) {
                if (pendingProperty == 0xd221) livePropertySize = length - 12;
                if (length >= 14 && op == 0x9207) controls.add(Integer.toHexString(pendingProperty) + ":" + (b.getShort(12) & 0xffff));
                return length;
            }
            operations.add(op);
            transactions.add(Integer.toHexString(op) + ":" + tid);
            if (op == 0x1002 && requireResetBeforeOpen && resetCount == 0) return length;
            if (op == 0x1002 && requireTid1ForOpen && tid != 1) return length;
            // PTP OpenSession normally opens on transaction 0.
            // Simulate a camera that ignores the non-compliant opening request unless requireTid1ForOpen is set.
            if (op == 0x1002 && !requireTid1ForOpen && tid != 0) return length;
            if (op == 0x1002 && noOpenResponse) return length;
            if (op == 0x1002 && timeoutFirstOpen) { timeoutFirstOpen = false; return length; }
            int param = length >= 16 ? b.getInt(12) : 0;
            pendingProperty = param;
            int rc = op == rejectOp || (rejectShutter && (op == 0x910f || op == 0x9128 || (op == 0x9207 && param == 0xd2c2))) ? 0x2019 : 0x2001;
            if (op == mtpRejectOp) rc = 0x2005;
            if (op == 0x1002 && alreadyOpenOnce) { rc = 0x201e; alreadyOpenOnce = false; }
            byte[] data = null;
            if (rc == 0x2001 && op == 0x1001) {
                ByteBuffer di = ByteBuffer.allocate(32).order(ByteOrder.LITTLE_ENDIAN);
                di.putShort(8, (short) 100);
                data = di.array();
            }
            if (rc == 0x2001 && (op == 0x9202 || op == 0x9209)) {
                data = (op == 0x9209 && customSonyPropsData != null) ? customSonyPropsData : new byte[16];
            }
            if (rc == 0x2001 && op == 0x1007) {
                if (useGenericHandlesList) {
                    ByteBuffer hbuf = ByteBuffer.allocate(4 + genericHandles.size() * 4).order(ByteOrder.LITTLE_ENDIAN);
                    hbuf.putInt(genericHandles.size());
                    for (int h : genericHandles) hbuf.putInt(h);
                    data = hbuf.array();
                } else {
                    data = genericShotCaptured
                            ? ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putInt(1).putInt(777).array()
                            : ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(0).array();
                }
            }
            if (op == 0x100e && rc == 0x2001) genericShotCaptured = true;
            if (rc == 0x2001 && op == 0x1008) {
                data = new byte[52];
                short fmt = (canonRawAndJpeg && param == 111) ? (short) 0xB101 : (short) 0x3801;
                ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).putShort(4, fmt).putInt(8, JPEG.length);
                if (canonPartialOnly) rc = 0x2005;
            }
            if (rc == 0x2001 && op == 0x1009) {
                if (canonPartialOnly) rc = 0x2005;
                else data = JPEG;
            }
            if (rc == 0x2001 && op == 0x9107 && canonPartialOnly) data = JPEG;
            if (op == 0x910f && rc == 0x2001) canonShot = true;
            if (op == 0x9116 && canonShot) {
                if (canonRawAndJpeg) {
                    ByteBuffer ev = ByteBuffer.allocate(32).order(ByteOrder.LITTLE_ENDIAN);
                    ev.putInt(12).putInt(0xc186).putInt(111); // RAW handle first
                    ev.putInt(20).putInt(0xc181).putInt(123).putInt(1).putShort((short) 0x3801).putShort((short) 0); // JPEG second
                    data = ev.array();
                } else if (canonAddedEx) {
                    data = ByteBuffer.allocate(20).order(ByteOrder.LITTLE_ENDIAN)
                            .putInt(20).putInt(0xc181).putInt(123).putInt(1).putShort((short) 0x3801).putShort((short) 0).array();
                } else {
                    data = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN).putInt(12).putInt(0xc186).putInt(123).array();
                }
                canonShot = false;
            }
            if (data != null) replies.add(PtpUsbTransportTest.packet(12 + data.length, 2, op, tid, data));
            if (!(omitPhotoResponse && op == 0x1009 && param == 0xffffc001)) {
                replies.add(PtpUsbTransportTest.packet(12, 3, rc, tid, new byte[0]));
            }
            return length;
        }
    }
    static CanonUsbPtpEngine connect(USB usb, boolean sony, Listener listener) throws Exception {
        return connect(usb, new Device(sony), listener);
    }
    static CanonUsbPtpEngine connect(USB usb, Device device, Listener listener) throws Exception {
        Context context = new Context();
        context.manager.connection = usb;
        context.manager.devices.put("camera", device);
        CanonUsbPtpEngine engine = new CanonUsbPtpEngine(context, listener);
        Method open = CanonUsbPtpEngine.class.getDeclaredMethod("openPtpConnection", UsbDevice.class);
        open.setAccessible(true);
        open.invoke(engine, device);
        return engine;
    }
    static void set(Object instance, String name, Object value) throws Exception {
        Field field = CanonUsbPtpEngine.class.getDeclaredField(name);
        field.setAccessible(true); field.set(instance, value);
    }
    static void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label);
        passed++;
    }
    public static void main(String[] args) throws Exception {
        CanonUsbPtpEngine disconnected = new CanonUsbPtpEngine(new Context());
        set(disconnected, "latestLiveViewJpeg", JPEG.clone());
        check(disconnected.capturePhotoWithFlash() == null, "disconnected capture cannot use preview");

        USB usb = new USB(); usb.rejectOp = 0x1002;
        Listener listener = new Listener();
        CanonUsbPtpEngine engine = connect(usb, true, listener);
        check(!engine.isActive() && listener.live == 0 && usb.closed, "failed session is not connected");
        check(!engine.getLastConnectionError().isEmpty(), "session failure has actionable diagnostics");

        usb = new USB(); usb.noOpenResponse = true;
        engine = connect(usb, true, new Listener());
        check(!engine.isActive() && !usb.operations.contains(0x1003), "OpenSession timeout is not treated as an opened session");
        check(engine.getUsbDiagnosticsReport().contains("op=0x1002, tx=0: USB IN 0/12"), "diagnostics identify the failed request and USB direction");

        usb = new USB(); usb.timeoutFirstOpen = true;
        engine = connect(usb, true, new Listener());
        check(engine.isActive() && usb.transactions.get(0).equals("1002:0") && usb.transactions.get(1).equals("1002:0"), "bounded retry opens again with transaction zero");
        check(!usb.operations.contains(0x1003), "slow initialization does not send a close for a nonexistent session");

        usb = new USB(); usb.alreadyOpenOnce = true;
        engine = connect(usb, true, new Listener());
        check(engine.isActive() && usb.transactions.subList(0, 4).equals(Arrays.asList("1002:0", "1003:1", "1002:0", "9201:1")), "existing session is closed and reopened with correct counters");

        usb = new USB(); engine = connect(usb, new Device(true, 8), new Listener());
        check(!engine.isActive() && usb.operations.isEmpty(), "mass storage interface never receives PTP commands");
        check(engine.getLastConnectionError().contains("PC Remote"), "wrong USB mode explains the camera setting");

        usb = new USB(); usb.rejectOp = 0x9201;
        engine = connect(usb, true, new Listener());
        check(!engine.isActive() && !usb.operations.contains(0x9202), "rejected Sony handshake stops initialization");

        usb = new USB(); listener = new Listener();
        engine = connect(usb, true, listener);
        check(engine.isActive() && listener.live == 0 && !engine.hasLiveFrame(), "session alone is not a live preview");
        check(usb.transactions.get(0).equals("1002:0") && usb.transactions.get(1).equals("9201:1"), "Sony opens at transaction zero, then starts remote transactions at one");
        check(usb.livePropertySize == 1, "Sony LiveView status uses UINT8 payload");
        set(engine, "latestLiveViewJpeg", JPEG.clone());
        set(engine, "latestFrameTimeMs", System.currentTimeMillis() - 6000);
        check(!engine.hasLiveFrame(), "stale preview cannot be reported as live");

        usb.rejectShutter = true;
        byte[] preview = engine.getLatestLiveViewJpeg();
        check(engine.capturePhotoWithFlash() == null, "rejected Sony shutter cannot return preview");
        check(engine.getLastCaptureError().contains("Shutter Sony"), "rejected shutter is explained");
        check(usb.controls.contains("d2c1:1") && usb.controls.contains("d2c2:1"), "shutter buttons released after failure");
        check(engine.getLatestLiveViewJpeg() == preview, "capture failure preserves preview separately");

        usb = new USB(); usb.omitPhotoResponse = true;
        engine = connect(usb, true, new Listener());
        set(engine, "latestLiveViewJpeg", JPEG.clone());
        check(engine.capturePhotoWithFlash() == null, "interrupted Sony JPEG download cannot return preview");
        check(usb.operations.contains(0x1003), "aborted Sony transfer sends polite CloseSession before disconnect");

        Method inMemParser = CanonUsbPtpEngine.class.getDeclaredMethod("findSonyObjectInMemoryFlag", byte[].class);
        inMemParser.setAccessible(true);
        // Sony 0x9209 payload: uint64 count=2; prop0=0x5005 (15B); prop1=0xD215 (11B, cur@+8=0x8001)
        byte[] propReady = ByteBuffer.allocate(8 + 15 + 11).order(ByteOrder.LITTLE_ENDIAN)
                .putLong(2L)
                .putShort((short) 0x5005).putShort((short) 0x0004).put((byte) 1).put((byte) 1)
                .putShort((short) 2).putShort((short) 2).put((byte) 2).putShort((short) 1).putShort((short) 2)
                .putShort((short) 0xD215).putShort((short) 0x0004).put((byte) 0).put((byte) 1)
                .putShort((short) 0).putShort((short) 0x8001).put((byte) 0)
                .array();
        check(((Integer) inMemParser.invoke(null, (Object) propReady)) == 0x8001,
                "Sony 0x9209 parser reads 0xD215 ObjectInMemory=0x8001 readiness flag");
        byte[] propZero = Arrays.copyOf(propReady, propReady.length);
        ByteBuffer.wrap(propZero).order(ByteOrder.LITTLE_ENDIAN).putShort(8 + 15 + 8, (short) 0);
        check(((Integer) inMemParser.invoke(null, (Object) propZero)) == 0,
                "Sony 0x9209 parser reads 0xD215 ObjectInMemory=0 pending flag");

        usb = new USB(); engine = connect(usb, true, new Listener());
        preview = JPEG.clone(); set(engine, "latestLiveViewJpeg", preview);
        check(Arrays.equals(JPEG, engine.capturePhotoWithFlash()), "Sony still image download succeeds");
        check(engine.getLatestLiveViewJpeg() == preview, "Sony still image does not replace the live frame");

        Method parse = CanonUsbPtpEngine.class.getDeclaredMethod("extractSonyLiveViewJpeg", byte[].class);
        parse.setAccessible(true);
        byte[] sonyFrame = new byte[128 + JPEG.length];
        ByteBuffer.wrap(sonyFrame).order(ByteOrder.LITTLE_ENDIAN).putInt(128);
        sonyFrame[16] = (byte) 0xff; sonyFrame[17] = (byte) 0xd8;
        System.arraycopy(JPEG, 0, sonyFrame, 128, JPEG.length);
        check(Arrays.equals(JPEG, (byte[]) parse.invoke(engine, (Object) sonyFrame)), "Sony preview follows the header offset, ignoring false JPEG marker");

        usb = new USB(); usb.rejectShutter = true;
        engine = connect(usb, false, new Listener());
        check(usb.transactions.get(0).equals("1002:0"), "Canon also opens at transaction zero");
        set(engine, "latestLiveViewJpeg", JPEG.clone());
        check(engine.isActive() && !engine.isSonyCamera(), "Canon uses its own driver");
        check(engine.capturePhotoWithFlash() == null, "rejected Canon shutter cannot return preview");
        usb = new USB(); engine = connect(usb, false, new Listener());
        check(Arrays.equals(JPEG, engine.capturePhotoWithFlash()), "Canon event and JPEG download still work");

        // Sony camera expecting TransactionID = 1 on OpenSession (like ILCE-7M3 firmware)
        usb = new USB(); usb.requireTid1ForOpen = true;
        engine = connect(usb, true, new Listener());
        check(engine.isActive() && usb.transactions.contains("1002:1") && usb.transactions.contains("9201:2"),
                "Sony requiring tid=1 OpenSession falls back cleanly and advances tid to 2");

        // Hung Android MTP pipe recovered by USB PIMA Device Reset (0x21, 0x66)
        usb = new USB(); usb.requireResetBeforeOpen = true;
        engine = connect(usb, true, new Listener());
        check(engine.isActive() && usb.resetCount == 1, "PIMA USB Device Reset recovers stuck OpenSession pipe");

        // Sony in MTP/Auto mode explains switching to PC Remote clearly
        usb = new USB(); usb.mtpRejectOp = 0x9201;
        engine = connect(usb, true, new Listener());
        check(!engine.isActive() && engine.getLastConnectionError().contains("MTP"),
                "Sony returning 0x2005 on SDIOConnect tells user to switch from MTP to PC Remote");

        // Generic Class 6 PTP camera (e.g. Fujifilm / Standard PTP) connects & captures without failing Canon opcodes
        usb = new USB();
        engine = connect(usb, new Device(0x04cb, "X-T4", 6), new Listener());
        check(engine.isActive() && engine.getDriverTypeName().equals("generic_ptp"),
                "Generic/Fujifilm Class 6 camera connects with generic_ptp driver");
        check(Arrays.equals(JPEG, engine.capturePhotoWithFlash()),
                "Generic PTP InitiateCapture and GetObjectHandles download succeed");

        // UVC Class 14 device is never claimed by PTP engine
        usb = new USB();
        engine = connect(usb, new Device(0x1234, "USB Video Capture", 14), new Listener());
        check(!engine.isActive() && usb.operations.isEmpty(), "UVC Video interface never claimed as PTP");

        LocalCanonHttpServer server = new LocalCanonHttpServer(disconnected);
        ByteArrayOutputStream http = new ByteArrayOutputStream();
        Method capture = LocalCanonHttpServer.class.getDeclaredMethod("handlePhysicalShutterCapture", java.io.OutputStream.class);
        capture.setAccessible(true); capture.invoke(server, http);
        String response = http.toString("UTF-8");
        check(response.contains("\"ok\":false") && !response.contains("imageUrl"), "HTTP bridge returns failure without a fake photo URL");

        // Mingle physical shutter capture for Canon EOS (drops mirror to OVF & picks up 0xC186 event)
        Listener canonMingleListener = new Listener();
        USB canonMingleUsb = new USB();
        CanonUsbPtpEngine canonMingle = connect(canonMingleUsb, false, canonMingleListener);
        canonMingle.setMingleListenMode(true, false);
        check(!canonMingle.supportsLiveView() && canonMingle.isMingleListenMode(), "Canon Mingle drops LiveView mirror for OVF + flash");
        canonMingleUsb.canonShot = true; // Simulate photographer pressing physical Canon shutter button
        Method pollMingle = CanonUsbPtpEngine.class.getDeclaredMethod("pollPhysicalShutterEventsLocked");
        pollMingle.setAccessible(true);
        pollMingle.invoke(canonMingle);
        check(canonMingle.getPhysicalCaptureSeq() == 1 && canonMingleListener.physicalSeq == 1
                && Arrays.equals(JPEG, canonMingle.getLastPhysicalCapturedJpeg()),
                "Canon physical shutter event downloads full JPEG and notifies Mingle listener");

        // Mingle physical shutter capture for Sony A7 III (0x9209 0xD215=0x8001 readiness)
        Listener sonyMingleListener = new Listener();
        USB sonyMingleUsb = new USB();
        CanonUsbPtpEngine sonyMingle = connect(sonyMingleUsb, true, sonyMingleListener);
        sonyMingle.setMingleListenMode(true, false);
        sonyMingleUsb.customSonyPropsData = propReady;
        set(sonyMingle, "lastKeepAliveMs", 0L);
        pollMingle.invoke(sonyMingle);
        check(sonyMingle.getPhysicalCaptureSeq() == 1 && sonyMingleListener.physicalSeq == 1
                && Arrays.equals(JPEG, sonyMingle.getLastPhysicalCapturedJpeg()),
                "Sony physical shutter readiness (0xD215) downloads full JPEG and notifies Mingle listener");

        // Canon EOS 1300D: PCHDDCapacity (0x911A), ObjectAddedEx (0xC181), and GetPartialObject (0x9107) chunk download
        USB canon1300Usb = new USB();
        canon1300Usb.canonAddedEx = true;
        canon1300Usb.canonPartialOnly = true;
        CanonUsbPtpEngine canon1300 = connect(canon1300Usb, false, new Listener());
        check(canon1300Usb.operations.contains(0x911A), "Canon init sends PCHDDCapacity (0x911A) for host transfer");
        check(Arrays.equals(JPEG, canon1300.capturePhotoWithFlash()),
                "Canon ObjectAddedEx (0xC181) + GetPartialObject (0x9107) succeeds even when 0x1009 is rejected");

        // Canon EOS RAW+JPEG event burst skips RAW handle and downloads the JPEG handle
        USB canonBurstUsb = new USB();
        canonBurstUsb.canonRawAndJpeg = true;
        CanonUsbPtpEngine canonBurst = connect(canonBurstUsb, false, new Listener());
        check(Arrays.equals(JPEG, canonBurst.capturePhotoWithFlash()),
                "Canon multi-handle burst skips RAW (0xB101) and downloads JPEG object cleanly");

        // Pre-existing SD card photos from last night must NOT be imported when Mingle turns on before USB connects
        Listener sdGuardListener = new Listener();
        USB sdGuardUsb = new USB();
        sdGuardUsb.useGenericHandlesList = true;
        sdGuardUsb.genericHandles.add(101);
        sdGuardUsb.genericHandles.add(102);
        CanonUsbPtpEngine sdGuard = new CanonUsbPtpEngine(new Context(), sdGuardListener);
        sdGuard.setMingleListenMode(true, false); // enabled BEFORE camera connects
        Method sdOpen = CanonUsbPtpEngine.class.getDeclaredMethod("openPtpConnection", UsbDevice.class);
        sdOpen.setAccessible(true);
        Context sdCtx = new Context();
        sdCtx.manager.connection = sdGuardUsb;
        sdCtx.manager.devices.put("camera", new Device(0x04cb, "X-T4", 6));
        set(sdGuard, "usbManager", sdCtx.manager);
        sdOpen.invoke(sdGuard, new Device(0x04cb, "X-T4", 6));
        pollMingle.invoke(sdGuard); // Baseline seed pass on first poll
        check(sdGuard.getPhysicalCaptureSeq() == 0 && sdGuardListener.physicalSeq == 0,
                "Pre-existing SD card photos from last night are seeded as baseline, never treated as new captures");
        sdGuardUsb.genericHandles.add(103); // New photo taken AFTER seeding
        pollMingle.invoke(sdGuard);
        check(sdGuard.getPhysicalCaptureSeq() == 1 && sdGuardListener.physicalSeq == 1
                && Arrays.equals(JPEG, sdGuard.getLastPhysicalCapturedJpeg()),
                "Only genuinely new SD card handle after seeding fires Mingle physical capture");

        // Canon pre-Mingle queued shutter event is drained when entering Mingle mode
        Listener canonDrainListener = new Listener();
        USB canonDrainUsb = new USB();
        canonDrainUsb.canonShot = true; // Queued BEFORE entering Mingle
        CanonUsbPtpEngine canonDrain = connect(canonDrainUsb, false, canonDrainListener);
        canonDrain.setMingleListenMode(true, false);
        pollMingle.invoke(canonDrain);
        check(canonDrain.getPhysicalCaptureSeq() == 0 && canonDrainListener.physicalSeq == 0,
                "Stale pre-Mingle Canon event is drained when entering Mingle listen mode");

        // LocalCanonHttpServer enforces ?seq= match on /physical_capture.jpg
        LocalCanonHttpServer mingleHttp = new LocalCanonHttpServer(sdGuard);
        Method handleClient = LocalCanonHttpServer.class.getDeclaredMethod("handleClient", java.net.Socket.class);
        handleClient.setAccessible(true);
        ByteArrayOutputStream mismatchOut = new ByteArrayOutputStream();
        java.net.Socket mismatchSock = new java.net.Socket() {
            @Override public java.io.InputStream getInputStream() {
                return new java.io.ByteArrayInputStream("GET /physical_capture.jpg?seq=999 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            @Override public java.io.OutputStream getOutputStream() { return mismatchOut; }
        };
        handleClient.invoke(mingleHttp, mismatchSock);
        check(mismatchOut.toString("UTF-8").contains("404 Not Found"),
                "Mismatched ?seq= on /physical_capture.jpg returns 404 instead of stale photo");

        ByteArrayOutputStream matchOut = new ByteArrayOutputStream();
        java.net.Socket matchSock = new java.net.Socket() {
            @Override public java.io.InputStream getInputStream() {
                return new java.io.ByteArrayInputStream("GET /physical_capture.jpg?seq=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            @Override public java.io.OutputStream getOutputStream() { return matchOut; }
        };
        handleClient.invoke(mingleHttp, matchSock);
        check(matchOut.toString("UTF-8").contains("200 OK"),
                "Matching ?seq=1 on /physical_capture.jpg serves captured JPEG");

        System.out.println("Sony/Canon camera failures and JPEG paths: " + passed + " checks passed");
    }
}

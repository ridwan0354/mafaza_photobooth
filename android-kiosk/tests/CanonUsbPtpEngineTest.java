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
        final boolean sony;
        final int usbClass;
        Device(boolean sony) { this(sony, 6); }
        Device(boolean sony, int usbClass) { this.sony = sony; this.usbClass = usbClass; }
        @Override public int getVendorId() { return sony ? 0x054c : 0x04a9; }
        @Override public String getProductName() { return sony ? "ILCE-7M3" : "Canon EOS 1300D"; }
        @Override public UsbInterface getInterface(int i) {
            return new UsbInterface() { @Override public int getInterfaceClass() { return usbClass; } };
        }
    }
    static class Listener implements CanonUsbPtpEngine.Listener {
        int live;
        public void onCameraConnected(String s) { live++; }
        public void onCameraDisconnected() {}
        public void onStatusMessage(String s) {}
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
        boolean timeoutFirstOpen;
        boolean noOpenResponse;
        boolean alreadyOpenOnce;
        int livePropertySize;
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
            // PTP OpenSession is outside a session and must use transaction 0.
            // Simulate a camera that ignores the non-compliant opening request.
            if (op == 0x1002 && tid != 0) return length;
            if (op == 0x1002 && noOpenResponse) return length;
            if (op == 0x1002 && timeoutFirstOpen) { timeoutFirstOpen = false; return length; }
            int param = length >= 16 ? b.getInt(12) : 0;
            pendingProperty = param;
            int rc = op == rejectOp || (rejectShutter && (op == 0x910f || op == 0x9128 || (op == 0x9207 && param == 0xd2c2))) ? 0x2019 : 0x2001;
            if (op == 0x1002 && alreadyOpenOnce) { rc = 0x201e; alreadyOpenOnce = false; }
            byte[] data = null;
            if (rc == 0x2001 && (op == 0x9202 || op == 0x9209)) data = new byte[16];
            if (rc == 0x2001 && op == 0x1008) {
                data = new byte[52];
                ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).putShort(4, (short) 0x3801).putInt(8, JPEG.length);
            }
            if (rc == 0x2001 && op == 0x1009) data = JPEG;
            if (op == 0x910f && rc == 0x2001) canonShot = true;
            if (op == 0x9116 && canonShot) {
                data = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN).putInt(12).putInt(0xc186).putInt(123).array();
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

        LocalCanonHttpServer server = new LocalCanonHttpServer(disconnected);
        ByteArrayOutputStream http = new ByteArrayOutputStream();
        Method capture = LocalCanonHttpServer.class.getDeclaredMethod("handlePhysicalShutterCapture", java.io.OutputStream.class);
        capture.setAccessible(true); capture.invoke(server, http);
        String response = http.toString("UTF-8");
        check(response.contains("\"ok\":false") && !response.contains("imageUrl"), "HTTP bridge returns failure without a fake photo URL");
        System.out.println("Sony/Canon camera failures and JPEG paths: " + passed + " checks passed");
    }
}

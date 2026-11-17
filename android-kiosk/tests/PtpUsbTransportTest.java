package com.mafaza.photobooth.kiosk;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Queue;

public class PtpUsbTransportTest {
    static final int TID = 7;
    static final int OP = 0x1009;
    static int passed;

    static class IO implements PtpUsbTransport.PacketIO {
        final Queue<byte[]> packets = new ArrayDeque<>();
        boolean shortWrite;
        IO(byte[]... packets) { this.packets.addAll(Arrays.asList(packets)); }
        public int write(byte[] bytes, int timeout) { return shortWrite ? bytes.length - 1 : bytes.length; }
        public int read(byte[] bytes, int timeout) {
            byte[] packet = packets.poll();
            if (packet == null) return -1;
            System.arraycopy(packet, 0, bytes, 0, packet.length);
            return packet.length;
        }
    }

    static byte[] packet(int length, int type, int code, int tid, byte[] payload) {
        return ByteBuffer.allocate(12 + payload.length).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(length).putShort((short) type).putShort((short) code).putInt(tid).put(payload).array();
    }
    static byte[] response(int code) { return packet(12, 3, code, TID, new byte[0]); }
    static byte[] join(byte[] a, byte[] b) {
        byte[] bytes = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, bytes, a.length, b.length);
        return bytes;
    }
    static PtpUsbTransport.Result run(IO io) { return PtpUsbTransport.transact(io, TID, OP, new int[]{1}, null, 1000); }
    static void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label);
        passed++;
    }

    public static void main(String[] args) {
        byte[] jpeg = new byte[3000];
        Arrays.fill(jpeg, (byte) 0x55);
        jpeg[0] = (byte) 0xff; jpeg[1] = (byte) 0xd8;
        jpeg[2998] = (byte) 0xff; jpeg[2999] = (byte) 0xd9;
        byte[] data = packet(12 + jpeg.length, 2, OP, TID, jpeg);
        PtpUsbTransport.Result result = run(new IO(data, response(0x2001)));
        check(result.responseCode == 0x2001 && Arrays.equals(jpeg, result.dataPayload), "full JPEG plus matching response");
        result = run(new IO(join(data, response(0x2001))));
        check(Arrays.equals(jpeg, result.dataPayload), "coalesced data and response");
        result = run(new IO(data, new byte[0], response(0x2001)));
        check(Arrays.equals(jpeg, result.dataPayload), "USB zero-length boundary before response");
        byte[] combined = join(data, response(0x2001));
        result = run(new IO(Arrays.copyOfRange(combined, 0, 5), Arrays.copyOfRange(combined, 5, 100), Arrays.copyOfRange(combined, 100, combined.length - 4), Arrays.copyOfRange(combined, combined.length - 4, combined.length)));
        check(Arrays.equals(jpeg, result.dataPayload), "fragmented header, data and response");
        result = run(new IO(data));
        check(result.responseCode != 0x2001 && result.dataPayload == null, "JPEG without final response fails");
        check(result.diagnostic.contains("op=0x1009") && result.diagnostic.contains("USB IN 0/12"), "missing response exposes the failed read stage");
        result = run(new IO(Arrays.copyOf(data, 200)));
        check(result.responseCode != 0x2001 && result.dataPayload == null, "truncated JPEG fails");
        result = run(new IO(data, response(0x2019)));
        check(result.responseCode == 0x2019 && result.dataPayload == null, "camera busy discards payload");
        result = run(new IO(data, packet(12, 3, 0x2001, TID - 1, new byte[0])));
        check(result.responseCode != 0x2001 && result.dataPayload == null, "stale transaction is rejected");
        result = run(new IO(packet(12 + jpeg.length, 2, OP + 1, TID, jpeg), response(0x2001)));
        check(result.responseCode != 0x2001, "wrong operation is rejected");
        IO shortIO = new IO(response(0x2001)); shortIO.shortWrite = true;
        result = run(shortIO);
        check(result.responseCode != 0x2001, "partial command write fails");
        check(result.diagnostic.contains("USB OUT 15/16"), "partial write includes the byte counts");
        result = run(new IO(packet(0x7fffffff, 2, OP, TID, new byte[0])));
        check(result.responseCode != 0x2001, "oversize object fails before allocation");
        result = run(new IO(packet(-1, 2, OP, TID, jpeg), response(0x2001)));
        check(Arrays.equals(jpeg, result.dataPayload), "Sony unbounded object waits for final response");
        result = run(new IO(packet(-1, 2, OP, TID, jpeg)));
        check(result.responseCode != 0x2001 && result.dataPayload == null, "Sony JPEG end alone is not success");
        result = run(new IO(join(packet(-1, 2, OP, TID, jpeg), response(0x2001))));
        check(Arrays.equals(jpeg, result.dataPayload), "Sony coalesced stream response is removed from JPEG");
        result = run(new IO(packet(12, 3, 0x2001, TID, new byte[0])));
        check(result.responseCode == 0x2001 && result.dataPayload == null, "response-only command");
        System.out.println("PTP framing: " + passed + " checks passed");
    }
}

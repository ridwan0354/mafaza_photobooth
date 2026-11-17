package com.mafaza.photobooth.kiosk;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

/** PTP framing shared by all cameras. Success requires the matching final response. */
final class PtpUsbTransport {
    static final int OK = 0x2001;
    private static final int MAX_DATA_BYTES = 64 * 1024 * 1024;
    private static final int MAX_STREAM_BYTES = 64 * 1024 * 1024;

    interface PacketIO {
        int write(byte[] bytes, int timeoutMs);
        int read(byte[] bytes, int timeoutMs);
    }

    static final class Result {
        int responseCode = -1;
        byte[] dataPayload;
        String diagnostic = "";
    }

    static Result transact(PacketIO io, int tid, int opCode, int[] params, byte[] dataOut, int timeoutMs) {
        Result result = new Result();
        long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
        try {
            int count = params == null ? 0 : params.length;
            ByteBuffer cmd = container(12 + count * 4, 1, opCode, tid);
            if (params != null) for (int param : params) cmd.putInt(param);
            write(io, cmd.array(), deadline);
            if (dataOut != null && dataOut.length > 0) {
                ByteBuffer data = container(12 + dataOut.length, 2, opCode, tid);
                data.put(dataOut);
                write(io, data.array(), deadline);
            }

            Reader reader = new Reader(io, deadline);
            byte[] header = reader.exact(12);
            if (integer(header, 8) != tid) throw new IOException("Transaction mismatch: received=" + integer(header, 8) + ", expected=" + tid);
            int type = word(header, 4);
            int code = word(header, 6);
            if (type == 3) {
                readResponse(reader, header, result);
                return result;
            }
            if (type != 2 || code != opCode) throw new IOException("Unexpected data container");
            long length = integer(header, 0) & 0xffffffffL;
            if (length == 0xffffffffL) {
                // Sony virtual LiveView objects may omit their data length. The actual
                // PTP response still has to arrive; a JPEG end marker alone is insufficient.
                StreamPayload stream = new StreamPayload();
                while (stream.size() <= MAX_STREAM_BYTES) {
                    stream.write(reader.chunk());
                    int responseOffset = stream.responseAtEnd(tid);
                    if (responseOffset >= 0) {
                        result.responseCode = stream.responseCode(responseOffset);
                        if (result.responseCode == OK) result.dataPayload = stream.payload(responseOffset);
                        return result;
                    }
                }
                throw new IOException("Streaming object too large");
            }
            if (length < 12 || length - 12 > MAX_DATA_BYTES) throw new IOException("Invalid object size");
            byte[] payload = reader.exact((int) length - 12);
            header = reader.exact(12);
            if (word(header, 4) != 3 || integer(header, 8) != tid) {
                throw new IOException("Missing matching response");
            }
            readResponse(reader, header, result);
            if (result.responseCode == OK) result.dataPayload = payload;
        } catch (IOException error) {
            result.responseCode = -1;
            result.dataPayload = null;
            result.diagnostic = "op=0x" + Integer.toHexString(opCode) + ", tx=" + tid + ": " + error.getMessage();
        }
        return result;
    }

    private static void readResponse(Reader reader, byte[] header, Result result) throws IOException {
        int length = integer(header, 0);
        if (length < 12 || length > 32 || (length - 12) % 4 != 0) throw new IOException("Invalid response");
        reader.exact(length - 12);
        result.responseCode = word(header, 6);
    }

    private static void write(PacketIO io, byte[] bytes, long deadline) throws IOException {
        // A short command/data write leaves the transaction unusable. Never report it as sent.
        int written = io.write(bytes, remaining(deadline));
        if (written != bytes.length) throw new IOException("USB OUT " + written + "/" + bytes.length + " bytes");
    }

    private static int remaining(long deadline) throws IOException {
        long nanos = deadline - System.nanoTime();
        if (nanos <= 0) throw new IOException("PTP transaction timed out");
        return (int) Math.max(1, Math.min(Integer.MAX_VALUE, nanos / 1_000_000L));
    }

    private static ByteBuffer container(int length, int type, int code, int tid) {
        return ByteBuffer.allocate(length).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(length).putShort((short) type).putShort((short) code).putInt(tid);
    }

    private static int integer(byte[] b, int offset) {
        return ByteBuffer.wrap(b, offset, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
    }

    private static int word(byte[] b, int offset) {
        return ByteBuffer.wrap(b, offset, 2).order(ByteOrder.LITTLE_ENDIAN).getShort() & 0xffff;
    }

    private static final class Reader {
        final PacketIO io;
        final long deadline;
        // Linux usbfs bulk URB limit on many Android kernels is 16 KB (MAX_USBFS_BUFFER_SIZE).
        final byte[] buffer = new byte[16384];
        int offset;
        int length;

        Reader(PacketIO io, long deadline) { this.io = io; this.deadline = deadline; }

        byte[] exact(int size) throws IOException {
            byte[] bytes = new byte[size];
            int copied = 0;
            while (copied < size) {
                try {
                    fill();
                } catch (IOException error) {
                    throw new IOException("USB IN " + copied + "/" + size + " bytes: " + error.getMessage());
                }
                int n = Math.min(size - copied, length - offset);
                System.arraycopy(buffer, offset, bytes, copied, n);
                copied += n;
                offset += n;
            }
            return bytes;
        }

        byte[] chunk() throws IOException {
            fill();
            byte[] bytes = Arrays.copyOfRange(buffer, offset, length);
            offset = length;
            return bytes;
        }

        void fill() throws IOException {
            if (offset < length) return;
            offset = 0;
            // USB bulk data can end with a zero-length packet before the PTP response.
            // It is a boundary marker, not a missing response.
            int emptyPackets = 0;
            do {
                length = io.read(buffer, remaining(deadline));
            } while (length == 0 && ++emptyPackets < 8);
            if (length <= 0) throw new IOException("Incomplete USB read (rc=" + length + ")");
        }
    }

    private static final class StreamPayload extends ByteArrayOutputStream {
        int responseAtEnd(int tid) {
            for (int length = 12; length <= 32 && length <= count; length += 4) {
                int p = count - length;
                if (integer(buf, p) == length && word(buf, p + 4) == 3 && integer(buf, p + 8) == tid) return p;
            }
            return -1;
        }
        int responseCode(int offset) { return word(buf, offset + 6); }
        byte[] payload(int end) { return Arrays.copyOf(buf, end); }
    }
}

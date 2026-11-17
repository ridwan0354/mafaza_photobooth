#!/usr/bin/env python3
"""Run native protocol/failure tests on the JVM, without a camera or an emulator."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
java_home = Path(os.environ.get('JAVA_HOME', '/Users/ikhwan_rid1/Library/Java/JavaVirtualMachines/jbr-17.0.14/Contents/Home'))

# Minimal Android boundaries only; the real PTP engine and HTTP bridge run unchanged.
STUBS = {
    'app/PendingIntent': '''public class PendingIntent { public static final int FLAG_UPDATE_CURRENT=1; public static PendingIntent getBroadcast(android.content.Context c,int n,android.content.Intent i,int f){return new PendingIntent();} }''',
    'content/Context': '''public class Context { public static final String USB_SERVICE="usb"; public final android.hardware.usb.UsbManager manager=new android.hardware.usb.UsbManager(); public Context getApplicationContext(){return this;} public Object getSystemService(String s){return manager;} public String getPackageName(){return "test";} public void registerReceiver(BroadcastReceiver r,IntentFilter f){} public void registerReceiver(BroadcastReceiver r,IntentFilter f,int x){} public void unregisterReceiver(BroadcastReceiver r){} }''',
    'content/BroadcastReceiver': '''public abstract class BroadcastReceiver { public abstract void onReceive(Context c,Intent i); }''',
    'content/Intent': '''public class Intent { public Intent(){} public Intent(String s){} public String getAction(){return "";} public <T>T getParcelableExtra(String s){return null;} public boolean getBooleanExtra(String s,boolean b){return b;} public Intent setPackage(String s){return this;} }''',
    'content/IntentFilter': '''public class IntentFilter { public void addAction(String s){} }''',
    'hardware/usb/UsbConstants': '''public class UsbConstants { public static final int USB_CLASS_STILL_IMAGE=6,USB_ENDPOINT_XFER_BULK=2,USB_DIR_OUT=0,USB_DIR_IN=128; }''',
    'hardware/usb/UsbEndpoint': '''public class UsbEndpoint { private final int dir; public UsbEndpoint(int d){dir=d;} public int getType(){return 2;} public int getDirection(){return dir;} public int getAddress(){return dir|1;} public int getMaxPacketSize(){return 512;} }''',
    'hardware/usb/UsbInterface': '''public class UsbInterface { public int getId(){return 0;} public int getInterfaceClass(){return 6;} public int getEndpointCount(){return 2;} public UsbEndpoint getEndpoint(int i){return new UsbEndpoint(i==0?0:128);} }''',
    'hardware/usb/UsbDevice': '''public class UsbDevice { public int getProductId(){return 0x0c00;} public int getVendorId(){return 0x054c;} public int getInterfaceCount(){return 1;} public UsbInterface getInterface(int i){return new UsbInterface();} public int getDeviceId(){return 1;} public String getProductName(){return "ILCE-7M3";} public String getDeviceName(){return "sony";} }''',
    'hardware/usb/UsbDeviceConnection': '''public class UsbDeviceConnection { public boolean closed; public int resetCount; public boolean claimInterface(UsbInterface i,boolean f){return true;} public void releaseInterface(UsbInterface i){} public void close(){closed=true;} public int bulkTransfer(UsbEndpoint e,byte[] b,int n,int t){return -1;} public int controlTransfer(int rt,int req,int val,int idx,byte[] b,int len,int t){ if(rt==0x21 && req==0x66) resetCount++; return 0; } }''',
    'hardware/usb/UsbManager': '''public class UsbManager { public static final String EXTRA_DEVICE="device",EXTRA_PERMISSION_GRANTED="permission",ACTION_USB_DEVICE_ATTACHED="attached",ACTION_USB_DEVICE_DETACHED="detached"; public UsbDeviceConnection connection; public final java.util.HashMap<String,UsbDevice> devices=new java.util.HashMap<>(); public java.util.HashMap<String,UsbDevice> getDeviceList(){return devices;} public boolean hasPermission(UsbDevice d){return true;} public UsbDeviceConnection openDevice(UsbDevice d){return connection;} public void requestPermission(UsbDevice d,android.app.PendingIntent i){} }''',
    'os/Build': '''public class Build { public static class VERSION { public static int SDK_INT=34; } }''',
    'os/Looper': '''public class Looper { public static Looper getMainLooper(){return new Looper();} }''',
    'os/Handler': '''public class Handler { public Handler(Looper l){} public void post(Runnable r){r.run();} }''',
    'util/Log': '''public class Log { public static int i(String t,String m){return 0;} public static int w(String t,String m){return 0;} public static int e(String t,String m){return 0;} public static int e(String t,String m,Throwable e){return 0;} }''',
    'widget/Toast': '''public class Toast { public static final int LENGTH_SHORT=0; public static Toast makeText(android.content.Context c,String s,int n){return new Toast();} public void show(){} }''',
}

with tempfile.TemporaryDirectory(prefix='mafaza-usb-tests-') as directory:
    tmp = Path(directory)
    sources = []
    for name, body in STUBS.items():
        path = tmp / 'android' / (name + '.java')
        path.parent.mkdir(parents=True, exist_ok=True)
        package = 'android.' + str(Path(name).parent).replace('/', '.')
        path.write_text('package ' + package + ';\n' + body)
        sources.append(str(path))
    for name in ('PtpUsbTransport', 'CanonUsbPtpEngine', 'LocalCanonHttpServer'):
        sources.append(str(ROOT / 'src/com/mafaza/photobooth/kiosk' / (name + '.java')))
    sources.extend(str(p) for p in sorted((ROOT / 'tests').glob('*Test.java')))
    subprocess.run([str(java_home / 'bin/javac'), '-encoding', 'UTF-8', '-d', str(tmp / 'classes'), *sources], check=True)
    for test in sorted((ROOT / 'tests').glob('*Test.java')):
        subprocess.run([str(java_home / 'bin/java'), '-cp', str(tmp / 'classes'), 'com.mafaza.photobooth.kiosk.' + test.stem], check=True)

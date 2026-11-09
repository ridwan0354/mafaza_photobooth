using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Collections.Generic;

namespace MafazaCanonBridge
{
    class Program
    {
        private static HttpListener _listener;
        private static bool _running = true;
        private static byte[] _latestJpeg = null;
        private static readonly object _frameLock = new object();
        private static long _lastFrameTime = 0;
        private static string _cameraName = "Canon EOS Camera";
        private static bool _isConnected = false;
        private static string _activeMode = "idle";
        private static string _lastCmdStatus = "ready";
        private static int _lastCmdError = 0;

        // Camera settings cache
        private static uint _currentIso = 0x68; // Auto/800
        private static uint _currentTv = 0x68;  // 1/125
        private static uint _currentAv = 0x30;  // f/4.0
        private static uint _currentWb = 0;     // Auto
        private static int _currentEv = 0;
        private static uint _aeMode = 3;

        // EDSDK handles (if EDSDK.dll is found)
        private static IntPtr _cameraHandle = IntPtr.Zero;
        private static bool _edsdkLoaded = false;
        private static Thread _workerThread;

        private static byte[] _capturedPhoto = null;
        private static long _capturedPhotoTime = 0;
        private static readonly object _captureLock = new object();
        private static EdsObjectEventHandler _objectEventHandler = null;

        private static readonly DateTime UnixEpoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        private static long GetCurrentUnixTimeMs()
        {
            return (long)(DateTime.UtcNow - UnixEpoch).TotalMilliseconds;
        }

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetConsoleWindow();

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        private const int SW_HIDE = 0;

        static void Main(string[] args)
        {
            if (args != null && Array.Exists(args, delegate(string a) {
                return string.Equals(a, "-silent", StringComparison.OrdinalIgnoreCase) ||
                       string.Equals(a, "/silent", StringComparison.OrdinalIgnoreCase) ||
                       string.Equals(a, "-background", StringComparison.OrdinalIgnoreCase);
            }))
            {
                IntPtr hWnd = GetConsoleWindow();
                if (hWnd != IntPtr.Zero)
                {
                    ShowWindow(hWnd, SW_HIDE);
                }
            }

            Console.Title = "Mafaza Canon USB Bridge (Windows) - Port 19898";
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine("==============================================================");
            Console.WriteLine("  MAFAZA PHOTOBOOTH - CANON USB BRIDGE FOR WINDOWS 10 / 11    ");
            Console.WriteLine("==============================================================");
            Console.ResetColor();

            // Try initializing EDSDK if available
            TryInitEdsdk();

            // Start background worker for Live View (EDSDK or digiCamControl)
            _workerThread = new Thread(WorkerLoop) { IsBackground = true };
            _workerThread.Start();

            // Start HTTP Server
            StartHttpServer();

            Console.WriteLine("\n[INFO] Tekan [Ctrl+C] atau tutup jendela ini untuk mematikan bridge.");
            while (_running)
            {
                Thread.Sleep(1000);
            }
        }

        private static void StartHttpServer()
        {
            try
            {
                _listener = new HttpListener();
                _listener.Prefixes.Add("http://127.0.0.1:19898/");
                _listener.Start();

                Console.ForegroundColor = ConsoleColor.Green;
                Console.WriteLine("[HTTP] Server berhasil berjalan di http://127.0.0.1:19898/");
                Console.WriteLine("[HTTP] Endpoint aktif: /status, /frame.jpg, /control");
                Console.ResetColor();

                _listener.BeginGetContext(OnHttpRequest, null);
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("[ERROR] Gagal menyalakan HttpListener: " + ex.Message);
                Console.WriteLine("        Tips: Jalankan ulang script 'Pasang-dan-Jalankan-Canon-USB-Bridge.bat'.");
                Console.ResetColor();
            }
        }

        private static void OnHttpRequest(IAsyncResult ar)
        {
            if (!_listener.IsListening) return;

            HttpListenerContext ctx = null;
            try
            {
                ctx = _listener.EndGetContext(ar);
            }
            catch { }

            // Accept next request
            try
            {
                _listener.BeginGetContext(OnHttpRequest, null);
            }
            catch { }

            if (ctx == null) return;

            try
            {
                HttpListenerRequest req = ctx.Request;
                HttpListenerResponse res = ctx.Response;

                // Add CORS headers for Private Network Access (Chrome / Edge compatibility)
                res.Headers.Add("Access-Control-Allow-Origin", "*");
                res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                res.Headers.Add("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
                res.Headers.Add("Access-Control-Allow-Private-Network", "true");

                if (req.HttpMethod == "OPTIONS")
                {
                    res.StatusCode = 200;
                    res.Close();
                    return;
                }

                string path = req.Url.AbsolutePath.ToLowerInvariant();

                if (path == "/" || path == "/status")
                {
                    HandleStatus(res);
                }
                else if (path == "/frame.jpg" || path == "/liveview.jpg")
                {
                    HandleFrame(res);
                }
                else if (path == "/control")
                {
                    HandleControl(req, res);
                }
                else if (path == "/capture" || path == "/api/camera/trigger-capture")
                {
                    HandleCapture(req, res);
                }
                else if (path == "/captured_pose.jpg")
                {
                    HandleCapturedPose(res);
                }
                else
                {
                    res.StatusCode = 404;
                    byte[] notFound = Encoding.UTF8.GetBytes("Not Found");
                    res.OutputStream.Write(notFound, 0, notFound.Length);
                    res.Close();
                }
            }
            catch (Exception ex)
            {
                try
                {
                    ctx.Response.StatusCode = 500;
                    byte[] err = Encoding.UTF8.GetBytes("Error: " + ex.Message);
                    ctx.Response.OutputStream.Write(err, 0, err.Length);
                    ctx.Response.Close();
                }
                catch { }
            }
        }

        private static void HandleStatus(HttpListenerResponse res)
        {
            long now = GetCurrentUnixTimeMs();
            long age = (_lastFrameTime > 0) ? (now - _lastFrameTime) : 999999;
            bool active = _isConnected && (age < 3500);

            string json = string.Format(
                "{{\"active\":{0},\"camera\":\"{1}\",\"mode\":\"{2}\",\"width\":1056,\"height\":704,\"ageMs\":{3},\"iso\":{4},\"tv\":{5},\"av\":{6},\"wb\":{7},\"ev\":{8},\"aeMode\":{9},\"cmdStatus\":\"{10}\",\"cmdError\":{11}}}",
                active ? "true" : "false",
                _cameraName.Replace("\"", "'"),
                _activeMode,
                age,
                _currentIso,
                _currentTv,
                _currentAv,
                _currentWb,
                _currentEv,
                _aeMode,
                _lastCmdStatus,
                _lastCmdError
            );

            res.ContentType = "application/json; charset=utf-8";
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            res.ContentLength64 = bytes.Length;
            res.OutputStream.Write(bytes, 0, bytes.Length);
            res.Close();
        }

        private static void HandleFrame(HttpListenerResponse res)
        {
            byte[] frameCopy = null;
            lock (_frameLock)
            {
                if (_latestJpeg != null)
                {
                    frameCopy = (byte[])_latestJpeg.Clone();
                }
            }

            if (frameCopy != null && frameCopy.Length > 100)
            {
                res.ContentType = "image/jpeg";
                res.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate");
                res.ContentLength64 = frameCopy.Length;
                res.OutputStream.Write(frameCopy, 0, frameCopy.Length);
                res.Close();
            }
            else
            {
                // Fallback 1x1 black pixel or 204
                res.StatusCode = 503;
                byte[] msg = Encoding.UTF8.GetBytes("No live view frame available yet.");
                res.OutputStream.Write(msg, 0, msg.Length);
                res.Close();
            }
        }

        private static void HandleControl(HttpListenerRequest req, HttpListenerResponse res)
        {
            var q = req.QueryString;
            string iso = q["iso"];
            string tv = q["tv"];
            string av = q["av"];
            string wb = q["wb"];
            string ev = q["ev"];
            string af = q["af"];
            string focus = q["focus"];

            Console.WriteLine(string.Format("[CONTROL] iso={0} tv={1} av={2} wb={3} af={4} focus={5}", iso, tv, av, wb, af, focus));

            bool handled = false;

            // If EDSDK is active, apply via EDSDK
            if (_edsdkLoaded && _cameraHandle != IntPtr.Zero)
            {
                handled = ApplyEdsdkControl(iso, tv, av, wb, ev, af, focus);
            }

            // If digiCamControl is active, forward
            if (!handled && _activeMode == "digicamcontrol")
            {
                handled = ApplyDigiCamControl(iso, tv, av, wb, af, focus);
            }

            _lastCmdStatus = handled ? "ok" : "received";
            _lastCmdError = handled ? 0 : 1;

            HandleStatus(res);
        }

        private static void HandleCapture(HttpListenerRequest req, HttpListenerResponse res)
        {
            try
            {
                long captureStart = GetCurrentUnixTimeMs();

                if (_edsdkLoaded && _cameraHandle != IntPtr.Zero)
                {
                    // 1. Drop reflex mirror / exit Live View EVF so hotshoe sync contact fires
                    uint dev0 = 0;
                    EdsSetPropertyData(_cameraHandle, 0x500 /* kEdsPropID_Evf_OutputDevice */, 0, 4, ref dev0);
                    uint mode0 = 0;
                    EdsSetPropertyData(_cameraHandle, 0x501 /* kEdsPropID_Evf_Mode */, 0, 4, ref mode0);
                    Thread.Sleep(250);

                    // 2. Fire physical shutter with Completely_NonAF (0x00010003) -> instant zero lag, clicks exactly once!
                    EdsSendCommand(_cameraHandle, 0x04 /* kEdsCameraCommand_PressShutterButton */, 0x00010003);
                    Thread.Sleep(120);
                    EdsSendCommand(_cameraHandle, 0x04 /* kEdsCameraCommand_PressShutterButton */, 0x00000000);

                    // 3. Pump EdsGetEvent while waiting for the camera to transfer the captured high-res flash photo
                    for (int i = 0; i < 50; i++)
                    {
                        EdsGetEvent();
                        Thread.Sleep(50);
                        lock (_captureLock)
                        {
                            if (_capturedPhotoTime >= captureStart && _capturedPhoto != null && _capturedPhoto.Length > 1000)
                            {
                                break;
                            }
                        }
                    }

                    // 4. Restore EVF Live View for PC
                    uint evfMode = 1;
                    EdsSetPropertyData(_cameraHandle, 0x501 /* kEdsPropID_Evf_Mode */, 0, 4, ref evfMode);
                    Thread.Sleep(80);
                    uint outDev = 2; // PC
                    EdsSetPropertyData(_cameraHandle, 0x500 /* kEdsPropID_Evf_OutputDevice */, 0, 4, ref outDev);
                    Thread.Sleep(150);
                }
                else if (_activeMode == "digicamcontrol")
                {
                    SendDccCommand("http://127.0.0.1:5513/?CMD=Capture");
                    Thread.Sleep(600);
                }

                long ts = GetCurrentUnixTimeMs();
                string json = string.Format("{{\"ok\":true,\"source\":\"canon-usb-windows\",\"captured\":true,\"imageUrl\":\"http://127.0.0.1:19898/captured_pose.jpg?t={0}\"}}", ts);
                byte[] body = Encoding.UTF8.GetBytes(json);
                res.ContentType = "application/json";
                res.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate");
                res.ContentLength64 = body.Length;
                res.OutputStream.Write(body, 0, body.Length);
                res.Close();
            }
            catch (Exception ex)
            {
                res.StatusCode = 500;
                byte[] err = Encoding.UTF8.GetBytes("Capture Error: " + ex.Message);
                res.OutputStream.Write(err, 0, err.Length);
                res.Close();
            }
        }

        private static void HandleCapturedPose(HttpListenerResponse res)
        {
            byte[] photoCopy = null;
            lock (_captureLock)
            {
                // Prefer newly captured high-res photo if less than 60s old
                if (_capturedPhoto != null && _capturedPhoto.Length > 1000 && (GetCurrentUnixTimeMs() - _capturedPhotoTime) < 60000)
                {
                    photoCopy = (byte[])_capturedPhoto.Clone();
                }
            }

            if (photoCopy == null)
            {
                lock (_frameLock)
                {
                    if (_latestJpeg != null && _latestJpeg.Length > 0)
                    {
                        photoCopy = (byte[])_latestJpeg.Clone();
                    }
                }
            }

            if (photoCopy != null && photoCopy.Length > 0)
            {
                res.ContentType = "image/jpeg";
                res.Headers.Add("Cache-Control", "no-cache, no-store, must-revalidate");
                res.ContentLength64 = photoCopy.Length;
                res.OutputStream.Write(photoCopy, 0, photoCopy.Length);
                res.Close();
            }
            else
            {
                res.StatusCode = 404;
                byte[] msg = Encoding.UTF8.GetBytes("No captured photo available.");
                res.OutputStream.Write(msg, 0, msg.Length);
                res.Close();
            }
        }

        // ==========================================
        // WORKER LOOP (Live View acquisition)
        // ==========================================
        private static void WorkerLoop()
        {
            while (_running)
            {
                try
                {
                    // 1. Try EDSDK Live View if EDSDK loaded & camera connected
                    if (_edsdkLoaded && _cameraHandle != IntPtr.Zero)
                    {
                        DownloadEdsdkLiveViewFrame();
                        Thread.Sleep(33); // ~30 FPS
                        continue;
                    }

                    // 2. Try digiCamControl WebServer (http://127.0.0.1:5513/)
                    if (CheckAndPullDigiCamControl())
                    {
                        Thread.Sleep(33);
                        continue;
                    }

                    // 3. If neither is connected, try discovering camera every 2 seconds
                    _isConnected = false;
                    _activeMode = "searching";
                    if (_edsdkLoaded)
                    {
                        TryConnectEdsdkCamera();
                    }
                    Thread.Sleep(1500);
                }
                catch
                {
                    Thread.Sleep(1000);
                }
            }
        }

        // ==========================================
        // digiCamControl INTEGRATION
        // ==========================================
        private static bool CheckAndPullDigiCamControl()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:5513/liveview.jpg");
                req.Timeout = 400;
                req.ReadWriteTimeout = 400;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    if (resp.StatusCode == HttpStatusCode.OK && resp.ContentLength > 100)
                    {
                        using (MemoryStream ms = new MemoryStream())
                        {
                            resp.GetResponseStream().CopyTo(ms);
                            byte[] data = ms.ToArray();
                            lock (_frameLock)
                            {
                                _latestJpeg = data;
                                _lastFrameTime = GetCurrentUnixTimeMs();
                            }
                            _isConnected = true;
                            _activeMode = "digicamcontrol";
                            _cameraName = "Canon EOS (digiCamControl)";
                            return true;
                        }
                    }
                }
            }
            catch { }
            return false;
        }

        private static bool ApplyDigiCamControl(string iso, string tv, string av, string wb, string af, string focus)
        {
            try
            {
                if (!string.IsNullOrEmpty(af) && af == "1")
                {
                    SendDccCommand("http://127.0.0.1:5513/?CMD=AutoFocus");
                }
                if (!string.IsNullOrEmpty(focus))
                {
                    int f = int.Parse(focus);
                    string cmd = f > 0 ? "FocusStepNear" : "FocusStepFar";
                    SendDccCommand("http://127.0.0.1:5513/?CMD=" + cmd);
                }
                if (!string.IsNullOrEmpty(iso))
                {
                    SendDccCommand("http://127.0.0.1:5513/?CMD=SetIso&param1=" + iso);
                }
                return true;
            }
            catch { return false; }
        }

        private static void SendDccCommand(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 1000;
                req.ReadWriteTimeout = 1000;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse()) { }
            }
            catch { }
        }

        // ==========================================
        // CANON EDSDK P/INVOKE WRAPPERS
        // ==========================================
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LoadLibrary(string dllToLoad);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsInitializeSDK();

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsTerminateSDK();

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsGetCameraList(out IntPtr outCameraListRef);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsGetChildCount(IntPtr inRef, out int outCount);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsGetChildAtIndex(IntPtr inRef, int inIndex, out IntPtr outCameraRef);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsOpenSession(IntPtr inCameraRef);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsCloseSession(IntPtr inCameraRef);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsSetPropertyData(IntPtr inRef, uint inPropertyID, int inParam, int inSize, ref uint inData);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsGetPropertyData(IntPtr inRef, uint inPropertyID, int inParam, int inSize, out uint outData);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsSendCommand(IntPtr inCameraRef, uint inCommand, int inParam);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsCreateMemoryStream(ulong inBufferSize, out IntPtr outStreamRef);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsCreateEvfImageRef(IntPtr inStreamRef, out IntPtr outEvfImageRef);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsDownloadEvfImage(IntPtr inCameraRef, IntPtr inEvfImageRef);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsGetPointer(IntPtr inStreamRef, out IntPtr outPointer);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsGetLength(IntPtr inStreamRef, out ulong outLength);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsGetEvent();

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsRelease(IntPtr inRef);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
        public struct EdsDirectoryItemInfo
        {
            public ulong size;
            public uint isFolder;
            public uint groupID;
            public uint option;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
            public string szFileName;
            public uint format;
            public uint dateTime;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct EdsCapacity
        {
            public int numberOfFreeClusters;
            public int bytesPerSector;
            public int reset;
        }

        public delegate uint EdsObjectEventHandler(uint inEvent, IntPtr inRef, IntPtr inContext);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsSetObjectEventHandler(IntPtr inCameraRef, uint inEvent, EdsObjectEventHandler inHandler, IntPtr inContext);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsGetDirectoryItemInfo(IntPtr inRef, out EdsDirectoryItemInfo outDirItemInfo);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsDownload(IntPtr inRef, ulong inSize, IntPtr outStream);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsDownloadComplete(IntPtr inRef);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsDownloadCancel(IntPtr inRef);

        [DllImport("EDSDK.dll", CallingConvention = CallingConvention.Cdecl)]
        private static extern uint EdsSetCapacity(IntPtr inCameraRef, EdsCapacity inCapacity);

        private static void TryInitEdsdk()
        {
            try
            {
                // Check if EDSDK.dll exists in local folder or standard program files
                List<string> possiblePaths = new List<string> {
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "EDSDK.dll"),
                    @"C:\Program Files (x86)\Canon\EOS Utility\EU3\EDSDK.dll",
                    @"C:\Program Files\Canon\EOS Utility\EU3\EDSDK.dll",
                    @"C:\Program Files (x86)\Canon\EOS Utility\EU2\EDSDK.dll",
                    @"C:\Program Files\Canon\EOS Utility\EU2\EDSDK.dll",
                    @"C:\Program Files (x86)\Canon\EOS Utility\EDSDK.dll",
                    @"C:\Program Files\Canon\EOS Utility\EDSDK.dll",
                    @"C:\Program Files\Canon\EOS Webcam Utility\EDSDK.dll",
                    @"C:\Program Files (x86)\Canon\EOS Webcam Utility\EDSDK.dll",
                    @"C:\Program Files\Canon\EOS Webcam Utility Pro\EDSDK.dll",
                    @"C:\Program Files (x86)\Canon\EOS Webcam Utility Pro\EDSDK.dll",
                    @"C:\Program Files (x86)\digiCamControl\EDSDK.dll",
                    @"C:\Program Files\digiCamControl\EDSDK.dll"
                };

                string foundDll = null;
                foreach (var p in possiblePaths)
                {
                    if (File.Exists(p))
                    {
                        foundDll = p;
                        break;
                    }
                }

                // If not found in known paths, scan Canon program directories
                if (foundDll == null)
                {
                    string[] scanRoots = new string[] {
                        @"C:\Program Files\Canon",
                        @"C:\Program Files (x86)\Canon",
                        @"C:\Program Files\digiCamControl",
                        @"C:\Program Files (x86)\digiCamControl"
                    };
                    foreach (var root in scanRoots)
                    {
                        if (Directory.Exists(root))
                        {
                            try
                            {
                                string[] matches = Directory.GetFiles(root, "EDSDK.dll", SearchOption.AllDirectories);
                                if (matches != null && matches.Length > 0)
                                {
                                    foundDll = matches[0];
                                    break;
                                }
                            }
                            catch { }
                        }
                    }
                }

                if (foundDll != null)
                {
                    Console.WriteLine("[EDSDK] Menemukan EDSDK.dll di: " + foundDll);
                    string dllDir = Path.GetDirectoryName(foundDll);
                    try { SetDllDirectory(dllDir); } catch { }

                    IntPtr hLib = LoadLibrary(foundDll);
                    if (hLib != IntPtr.Zero)
                    {
                        uint err = EdsInitializeSDK();
                        if (err == 0)
                        {
                            _edsdkLoaded = true;
                            Console.ForegroundColor = ConsoleColor.Green;
                            Console.WriteLine("[EDSDK] Canon EDSDK berhasil diinisialisasi.");
                            Console.ResetColor();
                            TryConnectEdsdkCamera();
                        }
                        else
                        {
                            Console.WriteLine("[EDSDK] EdsInitializeSDK error: 0x" + err.ToString("X"));
                        }
                    }
                    else
                    {
                        int winErr = Marshal.GetLastWin32Error();
                        Console.WriteLine("[EDSDK] LoadLibrary gagal (Win32 Error: " + winErr + ").");
                    }
                }
                else
                {
                    Console.WriteLine("[INFO] EDSDK.dll belum ditemukan di folder Canon / digiCamControl.");
                    Console.WriteLine("       Tips: Instal Canon EOS Utility atau digiCamControl jika ingin");
                    Console.WriteLine("       menggunakan kontrol ISO & Fokus secara langsung.");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("[EDSDK] Catatan: Driver EDSDK belum dimuat: " + ex.Message);
            }
        }

        private static void TryConnectEdsdkCamera()
        {
            if (!_edsdkLoaded) return;
            try
            {
                IntPtr cameraList;
                uint err = EdsGetCameraList(out cameraList);
                if (err == 0 && cameraList != IntPtr.Zero)
                {
                    int count = 0;
                    EdsGetChildCount(cameraList, out count);
                    if (count > 0)
                    {
                        IntPtr cam;
                        err = EdsGetChildAtIndex(cameraList, 0, out cam);
                        if (err == 0 && cam != IntPtr.Zero)
                        {
                            err = EdsOpenSession(cam);
                            if (err == 0)
                            {
                                _cameraHandle = cam;
                                _isConnected = true;
                                _activeMode = "edsdk";
                                _cameraName = "Canon EOS Camera (EDSDK USB)";

                                // Enable EVF (Live View)
                                uint evfMode = 1;
                                EdsSetPropertyData(cam, 0x501 /* kEdsPropID_Evf_Mode */, 0, 4, ref evfMode);
                                Thread.Sleep(150);
                                uint outDev = 2; // PC
                                EdsSetPropertyData(cam, 0x500 /* kEdsPropID_Evf_OutputDevice */, 0, 4, ref outDev);
                                Thread.Sleep(200);

                                // Register Object Event Handler for high-res photo transfer
                                _objectEventHandler = new EdsObjectEventHandler(OnObjectEvent);
                                EdsSetObjectEventHandler(cam, 0x00000200 /* kEdsObjectEvent_All */, _objectEventHandler, IntPtr.Zero);

                                // Set SaveTo = Both (SD Card + PC) and notify large capacity
                                uint saveTo = 3; // kEdsSaveTo_Both
                                EdsSetPropertyData(cam, 0x0b /* kEdsPropID_SaveTo */, 0, 4, ref saveTo);
                                EdsCapacity cap = new EdsCapacity { numberOfFreeClusters = 0x7FFFFFFF, bytesPerSector = 0x1000, reset = 1 };
                                EdsSetCapacity(cam, cap);

                                Console.ForegroundColor = ConsoleColor.Green;
                                Console.WriteLine("[EDSDK] Kamera Canon EOS terhubung via USB! Live view aktif.");
                                Console.ResetColor();
                            }
                        }
                    }
                    EdsRelease(cameraList);
                }
            }
            catch { }
        }

        private static uint OnObjectEvent(uint inEvent, IntPtr inRef, IntPtr inContext)
        {
            if (inEvent == 0x00000208 /* kEdsObjectEvent_DirItemRequestTransfer */)
            {
                try
                {
                    EdsDirectoryItemInfo info;
                    if (EdsGetDirectoryItemInfo(inRef, out info) == 0 && info.isFolder == 0 && info.size > 2000)
                    {
                        IntPtr stream;
                        if (EdsCreateMemoryStream(info.size, out stream) == 0)
                        {
                            if (EdsDownload(inRef, info.size, stream) == 0)
                            {
                                EdsDownloadComplete(inRef);
                                IntPtr ptr;
                                ulong len;
                                if (EdsGetPointer(stream, out ptr) == 0 && EdsGetLength(stream, out len) == 0 && len > 1000)
                                {
                                    byte[] photoData = new byte[len];
                                    Marshal.Copy(ptr, photoData, 0, (int)len);
                                    lock (_captureLock)
                                    {
                                        _capturedPhoto = photoData;
                                        _capturedPhotoTime = GetCurrentUnixTimeMs();
                                    }
                                    Console.WriteLine(string.Format("[PHOTO] Berhasil mengunduh foto flash: {0} ({1} bytes)!", info.szFileName, len));
                                }
                            }
                            else
                            {
                                EdsDownloadCancel(inRef);
                            }
                            EdsRelease(stream);
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine("[PHOTO] Error download: " + ex.Message);
                }
            }
            if (inRef != IntPtr.Zero)
            {
                EdsRelease(inRef);
            }
            return 0;
        }

        private static IntPtr _evfStreamRef = IntPtr.Zero;

        private static void DownloadEdsdkLiveViewFrame()
        {
            if (_cameraHandle == IntPtr.Zero) return;
            try
            {
                EdsGetEvent();

                if (_evfStreamRef == IntPtr.Zero)
                {
                    if (EdsCreateMemoryStream(0, out _evfStreamRef) != 0) return;
                }

                IntPtr evfImageRef;
                if (EdsCreateEvfImageRef(_evfStreamRef, out evfImageRef) == 0)
                {
                    uint err = EdsDownloadEvfImage(_cameraHandle, evfImageRef);
                    if (err == 0)
                    {
                        IntPtr ptr;
                        ulong len;
                        if (EdsGetPointer(_evfStreamRef, out ptr) == 0 && EdsGetLength(_evfStreamRef, out len) == 0 && len > 100)
                        {
                            byte[] frameData = new byte[len];
                            Marshal.Copy(ptr, frameData, 0, (int)len);
                            lock (_frameLock)
                            {
                                _latestJpeg = frameData;
                                _lastFrameTime = GetCurrentUnixTimeMs();
                            }
                            _isConnected = true;
                            _activeMode = "edsdk";
                        }
                    }
                    else if (err != 0xA102 /* OBJECT_NOTREADY */)
                    {
                        uint outDev = 2;
                        EdsSetPropertyData(_cameraHandle, 0x500 /* kEdsPropID_Evf_OutputDevice */, 0, 4, ref outDev);
                    }
                    EdsRelease(evfImageRef);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("[EVF] Error: " + ex.Message);
            }
        }

        private static bool ApplyEdsdkControl(string iso, string tv, string av, string wb, string ev, string af, string focus)
        {
            if (_cameraHandle == IntPtr.Zero) return false;
            try
            {
                // Extend shutdown timer
                EdsSendCommand(_cameraHandle, 0x01 /* kEdsCameraCommand_ExtendShutDownTimer */, 0);

                if (!string.IsNullOrEmpty(af) && af == "1")
                {
                    EdsSendCommand(_cameraHandle, 0x102 /* kEdsCameraCommand_DoEvfAf */, 1);
                }
                if (!string.IsNullOrEmpty(focus))
                {
                    int step = int.Parse(focus);
                    int edParam = 0;
                    if (step > 0) edParam = (step >= 3) ? 3 : ((step == 2) ? 2 : 1);
                    else edParam = (step <= -3) ? 0x8003 : ((step == -2) ? 0x8002 : 0x8001);
                    EdsSendCommand(_cameraHandle, 0x103 /* kEdsCameraCommand_DriveLensEvf */, edParam);
                }
                if (!string.IsNullOrEmpty(iso))
                {
                    uint isoVal = uint.Parse(iso);
                    EdsSetPropertyData(_cameraHandle, 0x402 /* kEdsPropID_ISOSpeed */, 0, 4, ref isoVal);
                    _currentIso = isoVal;
                }
                if (!string.IsNullOrEmpty(tv))
                {
                    uint tvVal = uint.Parse(tv);
                    EdsSetPropertyData(_cameraHandle, 0x406 /* kEdsPropID_Tv */, 0, 4, ref tvVal);
                    _currentTv = tvVal;
                }
                if (!string.IsNullOrEmpty(av))
                {
                    uint avVal = uint.Parse(av);
                    EdsSetPropertyData(_cameraHandle, 0x405 /* kEdsPropID_Av */, 0, 4, ref avVal);
                    _currentAv = avVal;
                }
                if (!string.IsNullOrEmpty(wb))
                {
                    uint wbVal = uint.Parse(wb);
                    EdsSetPropertyData(_cameraHandle, 0x106 /* kEdsPropID_WhiteBalance */, 0, 4, ref wbVal);
                    _currentWb = wbVal;
                }
                return true;
            }
            catch { return false; }
        }
    }
}

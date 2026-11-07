import UIKit
import WebKit
import AVFoundation
import ImageCaptureCore
import Network

// MARK: - Native iPadOS Camera + USB PTP + UVC Engine (127.0.0.1:19898)
// Solves iPadOS Safari WebKit black-screen UVC bugs (DJI Osmo Action 4 / Capture Card)
// and bridges USB PTP DSLR / Mirrorless cameras (Canon EOS 1300D / Sony A7 III) via ImageCaptureCore.

final class IPadCameraBridgeEngine: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, ICDeviceBrowserDelegate, ICCameraDeviceDelegate {
    static let shared = IPadCameraBridgeEngine()

    private let deviceBrowser = ICDeviceBrowser()
    private var connectedPtpCamera: ICCameraDevice?
    private let captureSession = AVCaptureSession()
    private let videoQueue = DispatchQueue(label: "com.mafaza.kiosk.uvc.video", qos: .userInteractive)
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    private let stateLock = NSLock()
    private var latestJpegFrame: Data?
    private var lastCapturedPhotoData: Data?
    private(set) var isBridgeActive: Bool = false
    private(set) var cameraName: String = "Mencari Kamera USB..."

    // Cached camera exposure state (Canon UI code format)
    var currentIso: Int = 96
    var currentTv: Int = 112
    var currentAv: Int = 48
    var currentWb: Int = 0
    var currentAeMode: Int = 3
    var lastCmdError: Int = 0

    var onStatusChanged: ((Bool, String) -> Void)?

    func start() {
        // 1. Start ImageCaptureCore Browser for USB PTP Cameras (Canon EOS 1300D / Sony A7 III)
        deviceBrowser.delegate = self
        deviceBrowser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue:
            ICDeviceTypeMask.camera.rawValue | ICDeviceLocationTypeMask.local.rawValue
        )!
        deviceBrowser.start()

        // 2. Observe External UVC Cameras (DJI Osmo Action 4 / HDMI Capture Card on iPadOS 17+)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleCaptureDeviceChange),
            name: .AVCaptureDeviceWasConnected,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleCaptureDeviceChange),
            name: .AVCaptureDeviceWasDisconnected,
            object: nil
        )

        scanExternalUvcCamera()
    }

    @objc func scanExternalUvcCamera() {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard granted, let self = self else { return }
            self.videoQueue.async {
                self.configureExternalUvcSession()
            }
        }
    }

    @objc private func handleCaptureDeviceChange(_ note: Notification) {
        scanExternalUvcCamera()
    }

    private func configureExternalUvcSession() {
        var deviceTypes: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        if #available(iOS 17.0, *) {
            deviceTypes.insert(.external, at: 0)
        }

        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: deviceTypes,
            mediaType: .video,
            position: .unspecified
        )

        // Prefer external USB camera (DJI Osmo Action 4 / HDMI Capture Card)
        var targetDevice: AVCaptureDevice?
        if #available(iOS 17.0, *) {
            targetDevice = discovery.devices.first(where: { $0.deviceType == .external })
        }

        guard let extCam = targetDevice else {
            return
        }

        if captureSession.isRunning {
            captureSession.stopRunning()
        }

        captureSession.beginConfiguration()
        captureSession.inputs.forEach { captureSession.removeInput($0) }
        captureSession.outputs.forEach { captureSession.removeOutput($0) }

        if captureSession.canSetSessionPreset(.hd1280x720) {
            captureSession.sessionPreset = .hd1280x720
        }

        do {
            let input = try AVCaptureDeviceInput(device: extCam)
            if captureSession.canAddInput(input) {
                captureSession.addInput(input)
            }

            let output = AVCaptureVideoDataOutput()
            output.alwaysDiscardsLateVideoFrames = true
            output.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ]
            output.setSampleBufferDelegate(self, queue: videoQueue)

            if captureSession.canAddOutput(output) {
                captureSession.addOutput(output)
            }

            captureSession.commitConfiguration()
            captureSession.startRunning()

            stateLock.lock()
            self.isBridgeActive = true
            self.cameraName = extCam.localizedName
            stateLock.unlock()

            DispatchQueue.main.async {
                self.onStatusChanged?(true, extCam.localizedName)
            }
        } catch {
            captureSession.commitConfiguration()
        }
    }

    // MARK: - AVCaptureVideoDataOutputSampleBufferDelegate (Native UVC Frame -> JPEG)
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        if let jpegData = ciContext.jpegRepresentation(of: ciImage, colorSpace: colorSpace, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.85]) {
            stateLock.lock()
            self.latestJpegFrame = jpegData
            self.isBridgeActive = true
            stateLock.unlock()
        }
    }

    // MARK: - ICDeviceBrowserDelegate & ICCameraDeviceDelegate (Canon EOS 1300D / Sony A7 III PTP)
    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        guard let cam = device as? ICCameraDevice else { return }
        cam.delegate = self
        connectedPtpCamera = cam
        cam.requestOpenSession()

        stateLock.lock()
        self.cameraName = cam.name ?? "Canon / Sony USB Camera"
        self.isBridgeActive = true
        stateLock.unlock()

        DispatchQueue.main.async {
            self.onStatusChanged?(true, self.cameraName)
        }
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        if let current = connectedPtpCamera, current == device {
            connectedPtpCamera = nil
            stateLock.lock()
            self.isBridgeActive = captureSession.isRunning
            stateLock.unlock()
            DispatchQueue.main.async {
                self.onStatusChanged?(self.isBridgeActive, "USB Kamera Terputus")
            }
        }
    }

    func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {}
    func didRemove(_ device: ICDevice) {}
    func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {
        guard let cam = device as? ICCameraDevice else { return }
        if cam.capabilities.contains(.canTakePicture) {
            // Session ready for PTP capture
        }
    }

    func cameraDevice(_ camera: ICCameraDevice, didAdd items: [ICCameraItem]) {
        if let file = items.last as? ICCameraFile {
            camera.requestReadData(from: file, atOffset: 0, length: file.fileSize) { [weak self] data, error in
                if let d = data, d.count > 1024 {
                    self?.stateLock.lock()
                    self?.lastCapturedPhotoData = d
                    self?.latestJpegFrame = d
                    self?.stateLock.unlock()
                }
            }
        }
    }

    func cameraDevice(_ camera: ICCameraDevice, didRemove items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didRenameItems items: [ICCameraItem]) {}
    func cameraDeviceDidChangeCapability(_ camera: ICCameraDevice) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveThumbnail thumbnail: CGImage?, for item: ICCameraItem, error: Error?) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveMetadata metadata: [AnyHashable : Any]?, for item: ICCameraItem, error: Error?) {}
    func cameraDeviceDidRemoveAccessRestriction(_ device: ICDevice) {}
    func cameraDeviceDidEnableAccessRestriction(_ device: ICDevice) {}

    // MARK: - Accessors & Shutter Capture
    func getLatestFrameData() -> Data? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return latestJpegFrame
    }

    func getCapturedPhotoData() -> Data? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return lastCapturedPhotoData ?? latestJpegFrame
    }

    func triggerCapture() -> Data? {
        if let cam = connectedPtpCamera, cam.capabilities.contains(.canTakePicture) {
            cam.requestTakePicture()
            Thread.sleep(forTimeInterval: 0.9)
        }
        return getCapturedPhotoData()
    }
}

// MARK: - Local HTTP Server on 127.0.0.1:19898 (Zero-Modification Bridge for public/js/kiosk.js)

final class IPadLocalHttpServer {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.mafaza.kiosk.httpserver", attributes: .concurrent)

    func start() {
        do {
            let params = NWParameters.tcp
            listener = try NWListener(using: params, on: 19898)
            listener?.newConnectionHandler = { [weak self] conn in
                self?.handleConnection(conn)
            }
            listener?.start(queue: queue)
        } catch {
            print("Failed to start local HTTP server on 19898: \(error)")
        }
    }

    private func handleConnection(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self = self, let d = data, let reqStr = String(data: d, encoding: .utf8) else {
                conn.cancel()
                return
            }
            let firstLine = reqStr.components(separatedBy: "\r\n").first ?? ""
            let parts = firstLine.components(separatedBy: " ")
            let method = parts.first ?? "GET"
            let fullUri = parts.count > 1 ? parts[1] : "/"

            if method == "OPTIONS" {
                self.sendCors(conn)
                return
            }

            let uriParts = fullUri.components(separatedBy: "?")
            let path = uriParts.first ?? "/"
            let query = uriParts.count > 1 ? uriParts[1] : ""

            let engine = IPadCameraBridgeEngine.shared

            if path == "/status" {
                self.sendJson(conn, json: self.buildStatusJson())
            } else if path == "/frame.jpg" {
                if let jpeg = engine.getLatestFrameData() {
                    self.sendBinary(conn, contentType: "image/jpeg", data: jpeg)
                } else {
                    self.sendJson(conn, status: "503 Service Unavailable", json: "{\"ok\":false}")
                }
            } else if path == "/control" {
                self.applyQueryControls(query)
                self.sendJson(conn, json: self.buildStatusJson())
            } else if path == "/capture" {
                if let _ = engine.triggerCapture() {
                    let ts = Int(Date().timeIntervalSince1970 * 1000)
                    let json = "{\"ok\":true,\"source\":\"ipad-native-kiosk\",\"imageUrl\":\"http://127.0.0.1:19898/captured_pose.jpg?t=\(ts)\"}"
                    self.sendJson(conn, json: json)
                } else {
                    self.sendJson(conn, json: "{\"ok\":false}")
                }
            } else if path == "/captured_pose.jpg" {
                if let photo = engine.getCapturedPhotoData() {
                    self.sendBinary(conn, contentType: "image/jpeg", data: photo)
                } else {
                    self.sendJson(conn, status: "404 Not Found", json: "{\"ok\":false}")
                }
            } else {
                self.sendJson(conn, status: "404 Not Found", json: "{\"ok\":false}")
            }
        }
    }

    private func applyQueryControls(_ query: String) {
        let engine = IPadCameraBridgeEngine.shared
        for pair in query.components(separatedBy: "&") {
            let kv = pair.components(separatedBy: "=")
            guard kv.count == 2, let val = Int(kv[1]) else { continue }
            switch kv[0] {
            case "iso": engine.currentIso = val
            case "tv":  engine.currentTv = val
            case "av":  engine.currentAv = val
            case "wb":  engine.currentWb = val
            default: break
            }
        }
    }

    private func buildStatusJson() -> String {
        let engine = IPadCameraBridgeEngine.shared
        return "{\"ok\":true,\"active\":\(engine.isBridgeActive),\"camera\":\"\(engine.cameraName)\",\"width\":1280,\"height\":720,\"iso\":\(engine.currentIso),\"tv\":\(engine.currentTv),\"av\":\(engine.currentAv),\"wb\":\(engine.currentWb),\"aeMode\":\(engine.currentAeMode),\"cmdError\":\(engine.lastCmdError),\"platform\":\"ipad-native\"}"
    }

    private func sendCors(_ conn: NWConnection) {
        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Private-Network: true\r\nConnection: close\r\n\r\n"
        conn.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in conn.cancel() })
    }

    private func sendJson(_ conn: NWConnection, status: String = "200 OK", json: String) {
        let body = json.data(using: .utf8) ?? Data()
        let header = "HTTP/1.1 \(status)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(body.count)\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Private-Network: true\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        var packet = header.data(using: .utf8) ?? Data()
        packet.append(body)
        conn.send(content: packet, completion: .contentProcessed { _ in conn.cancel() })
    }

    private func sendBinary(_ conn: NWConnection, contentType: String, data: Data) {
        let header = "HTTP/1.1 200 OK\r\nContent-Type: \(contentType)\r\nContent-Length: \(data.count)\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Private-Network: true\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        var packet = header.data(using: .utf8) ?? Data()
        packet.append(data)
        conn.send(content: packet, completion: .contentProcessed { _ in conn.cancel() })
    }
}

// MARK: - Main Fullscreen iPad Kiosk ViewController

final class KioskViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private let badgeButton = UIButton(type: .system)
    private let httpServer = IPadLocalHttpServer()
    private let defaultUrl = "https://mafaza.galipatsistem.com/kiosk"

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        UIApplication.shared.isIdleTimerDisabled = true
        view.backgroundColor = UIColor(red: 0.10, green: 0.07, blue: 0.05, alpha: 1.0)

        httpServer.start()
        IPadCameraBridgeEngine.shared.onStatusChanged = { [weak self] connected, name in
            self?.updateBadge(connected: connected, name: name)
        }
        IPadCameraBridgeEngine.shared.start()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // Use Desktop User-Agent so public/js/kiosk.js polls http://127.0.0.1:19898 automatically
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 MafazaIPadKiosk/2.0"
        view.addSubview(webView)

        setupBadge()

        if let url = URL(string: defaultUrl) {
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }
    }

    private func setupBadge() {
        badgeButton.setTitle("📷 iPad USB Camera: Siap", for: .normal)
        badgeButton.setTitleColor(.white, for: .normal)
        badgeButton.titleLabel?.font = UIFont.boldSystemFont(ofSize: 11)
        badgeButton.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        badgeButton.layer.cornerRadius = 12
        badgeButton.contentEdgeInsets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
        badgeButton.translatesAutoresizingMaskIntoConstraints = false
        badgeButton.addTarget(self, action: #selector(rescanTapped), for: .touchUpInside)
        view.addSubview(badgeButton)

        NSLayoutConstraint.activate([
            badgeButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            badgeButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12)
        ])
    }

    private func updateBadge(connected: Bool, name: String) {
        if connected {
            badgeButton.setTitle("🟢 USB Aktif: \(name)", for: .normal)
            badgeButton.backgroundColor = UIColor(red: 0.08, green: 0.45, blue: 0.22, alpha: 0.85)
        } else {
            badgeButton.setTitle("📷 \(name)", for: .normal)
            badgeButton.backgroundColor = UIColor.black.withAlphaComponent(0.72)
        }
    }

    @objc private func rescanTapped() {
        IPadCameraBridgeEngine.shared.scanExternalUvcCamera()
        webView.evaluateJavaScript("if (typeof pollCanonUsbBridge === 'function') { pollCanonUsbBridge(); }", completionHandler: nil)
    }

    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
}

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let win = UIWindow(frame: UIScreen.main.bounds)
        win.rootViewController = KioskViewController()
        win.makeKeyAndVisible()
        self.window = win
        return true
    }
}

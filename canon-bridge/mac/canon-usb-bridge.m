#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl.h>
#import <Syphon/Syphon.h>
#import <objc/runtime.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <arpa/inet.h>
#import <unistd.h>
#import <pthread.h>

// --- Canon EDSDK Types & Functions ---
typedef uint32_t EdsError;
typedef uint32_t EdsPropertyID;
typedef int32_t  EdsInt32;
typedef uint32_t EdsUInt32;
typedef uint64_t EdsUInt64;
typedef void*    EdsBaseRef;
typedef void*    EdsCameraListRef;
typedef void*    EdsCameraRef;
typedef void*    EdsStreamRef;
typedef void*    EdsEvfImageRef;
typedef uint32_t EdsCameraCommand;
typedef uint32_t EdsStateEvent;
typedef uint32_t EdsObjectEvent;
typedef uint32_t EdsBool;

typedef struct tagEdsDeviceInfo {
    char szPortName[256];
    char szDeviceDescription[256];
    EdsUInt32 deviceSubType;
    EdsUInt32 reserved;
} EdsDeviceInfo;

typedef struct tagEdsDirectoryItemInfo {
    EdsUInt64 size;
    EdsUInt32 isFolder;
    EdsUInt32 groupID;
    EdsUInt32 option;
    char szFileName[256];
    EdsUInt32 format;
    EdsUInt32 dateTime;
} EdsDirectoryItemInfo;

typedef struct tagEdsCapacity {
    EdsInt32 numberOfFreeClusters;
    EdsInt32 bytesPerSector;
    EdsBool  reset;
} EdsCapacity;

typedef EdsError (*EdsCameraAddedHandler)(void *inContext);
typedef EdsError (*EdsStateEventHandler)(EdsStateEvent inEvent, EdsUInt32 inEventData, void *inContext);
typedef EdsError (*EdsObjectEventHandler)(EdsObjectEvent inEvent, EdsBaseRef inRef, void *inContext);

extern EdsError EdsInitializeSDK(void);
extern EdsError EdsTerminateSDK(void);
extern EdsError EdsSetCameraAddedHandler(EdsCameraAddedHandler inCameraAddedHandler, void *inContext);
extern EdsError EdsGetCameraList(EdsCameraListRef *outCameraListRef);
extern EdsError EdsGetChildCount(EdsBaseRef inRef, EdsUInt32 *outCount);
extern EdsError EdsGetChildAtIndex(EdsBaseRef inRef, EdsInt32 inIndex, EdsBaseRef *outRef);
extern EdsError EdsGetDeviceInfo(EdsCameraRef inCameraRef, EdsDeviceInfo *outDeviceInfo);
extern EdsError EdsOpenSession(EdsCameraRef inCameraRef);
extern EdsError EdsCloseSession(EdsCameraRef inCameraRef);
extern EdsError EdsGetPropertyData(EdsBaseRef inRef, EdsPropertyID inPropertyID, EdsInt32 inParam, EdsUInt32 inPropertySize, void *outPropertyData);
extern EdsError EdsSetPropertyData(EdsBaseRef inRef, EdsPropertyID inPropertyID, EdsInt32 inParam, EdsUInt32 inPropertySize, const void *inPropertyData);
extern EdsError EdsSendCommand(EdsCameraRef inCameraRef, EdsCameraCommand inCommand, EdsInt32 inParam);
extern EdsError EdsCreateMemoryStream(EdsUInt64 inBufferSize, EdsStreamRef *outStream);
extern EdsError EdsCreateEvfImageRef(EdsStreamRef inStreamRef, EdsEvfImageRef *outEvfImageRef);
extern EdsError EdsDownloadEvfImage(EdsCameraRef inCameraRef, EdsEvfImageRef inEvfImageRef);
extern EdsError EdsGetPointer(EdsStreamRef inStream, void **outPointer);
extern EdsError EdsGetLength(EdsStreamRef inStream, EdsUInt64 *outLength);
extern EdsError EdsRelease(EdsBaseRef inRef);
extern EdsError EdsRetain(EdsBaseRef inRef);

extern EdsError EdsSetObjectEventHandler(EdsCameraRef inCameraRef, EdsObjectEvent inEvent, EdsObjectEventHandler inHandler, void *inContext);
extern EdsError EdsGetDirectoryItemInfo(EdsBaseRef inRef, EdsDirectoryItemInfo *outDirItemInfo);
extern EdsError EdsDownload(EdsBaseRef inRef, EdsUInt64 inSize, EdsStreamRef outStream);
extern EdsError EdsDownloadComplete(EdsBaseRef inRef);
extern EdsError EdsDownloadCancel(EdsBaseRef inRef);
extern EdsError EdsSetCapacity(EdsCameraRef inCameraRef, EdsCapacity inCapacity);
extern EdsError EdsGetEvent(void);

#define kEdsPropID_SaveTo               0x0000000b
#define kEdsSaveTo_Camera               1
#define kEdsSaveTo_Host                 2
#define kEdsSaveTo_Both                 3

#define kEdsPropID_AEMode               0x00000400
#define kEdsPropID_ISOSpeed             0x00000402
#define kEdsPropID_Av                   0x00000405
#define kEdsPropID_Tv                   0x00000406
#define kEdsPropID_ExposureCompensation 0x00000407
#define kEdsPropID_WhiteBalance         0x00000106
#define kEdsPropID_Evf_OutputDevice     0x00000500
#define kEdsPropID_Evf_Mode             0x00000501
#define kEdsPropID_Evf_AFMode           0x0000050E

#define kEdsCameraCommand_TakePicture         0x00000000
#define kEdsCameraCommand_ExtendShutDownTimer 0x00000001
#define kEdsCameraCommand_PressShutterButton  0x00000004
#define kEdsCameraCommand_DoEvfAf             0x00000102
#define kEdsCameraCommand_DriveLensEvf        0x00000103

#define kEdsCameraCommand_ShutterButton_OFF                 0x00000000
#define kEdsCameraCommand_ShutterButton_Halfway             0x00000001
#define kEdsCameraCommand_ShutterButton_Completely          0x00000003
#define kEdsCameraCommand_ShutterButton_Halfway_NonAF       0x00010001
#define kEdsCameraCommand_ShutterButton_Completely_NonAF    0x00010003

#define kEdsObjectEvent_All                     0x00000200
#define kEdsObjectEvent_DirItemCreated          0x00000204
#define kEdsObjectEvent_DirItemRequestTransfer  0x00000208

// --- Global Thread-Safe State ---
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static unsigned char *g_jpegBuf = NULL;
static size_t g_jpegLen = 0;
static int g_width = 0;
static int g_height = 0;
static long long g_lastFrameTimeMs = 0;
static char g_cameraName[128] = "Canon EOS 1300D";
static char g_sourceMode[32] = "idle";
static char g_lastCmdStatus[64] = "ready";
static uint32_t g_lastCmdError = 0;

static unsigned char *g_capturedPhotoBuf = NULL;
static size_t g_capturedPhotoLen = 0;
static long long g_capturedPhotoTimeMs = 0;

static uint32_t g_curIso = 0;
static uint32_t g_curTv = 0;
static uint32_t g_curAv = 0;
static uint32_t g_curWb = 0;
static int32_t  g_curEv = 0;
static uint32_t g_curAeMode = 0;

// Pending control requests from HTTP
static pthread_mutex_t g_cmdLock = PTHREAD_MUTEX_INITIALIZER;
static BOOL g_hasPendingCmd = NO;
static int g_cmdIso = -1;
static int g_cmdTv = -1;
static int g_cmdAv = -1;
static int g_cmdWb = -1;
static int g_cmdEv = -9999;
static int g_cmdAf = 0;
static int g_cmdFocusStep = 0;
static BOOL g_cmdCapture = NO;
static BOOL g_forceDirectEdsdk = YES;

static long long nowMs(void) {
    return (long long)([[NSDate date] timeIntervalSince1970] * 1000.0);
}

static EdsError handleObjectEvent(EdsObjectEvent inEvent, EdsBaseRef inRef, void *inContext) {
    NSLog(@"[CanonBridge] >>> handleObjectEvent event: 0x%04x, ref: %p", inEvent, inRef);
    if (inEvent == kEdsObjectEvent_DirItemRequestTransfer) {
        EdsDirectoryItemInfo info;
        memset(&info, 0, sizeof(info));
        EdsError err = EdsGetDirectoryItemInfo(inRef, &info);
        NSLog(@"[CanonBridge] DirItemInfo err: 0x%x, size: %llu, file: %s, isFolder: %u", err, info.size, info.szFileName, info.isFolder);
        if (err == 0 && !info.isFolder && info.size > 2000) {
            EdsStreamRef stream = NULL;
            err = EdsCreateMemoryStream(info.size, &stream);
            if (err == 0 && stream) {
                err = EdsDownload(inRef, info.size, stream);
                if (err == 0) {
                    EdsDownloadComplete(inRef);
                    void *ptr = NULL;
                    EdsUInt64 len = 0;
                    if (EdsGetPointer(stream, &ptr) == 0 && EdsGetLength(stream, &len) == 0 && ptr && len > 1000) {
                        pthread_mutex_lock(&g_lock);
                        if (g_capturedPhotoBuf) free(g_capturedPhotoBuf);
                        g_capturedPhotoBuf = (unsigned char *)malloc((size_t)len);
                        if (g_capturedPhotoBuf) {
                            memcpy(g_capturedPhotoBuf, ptr, (size_t)len);
                            g_capturedPhotoLen = (size_t)len;
                            g_capturedPhotoTimeMs = nowMs();
                            NSLog(@"[CanonBridge] *** Successfully downloaded high-res captured photo (%s, %zu bytes) ***", info.szFileName, (size_t)len);
                        }
                        pthread_mutex_unlock(&g_lock);
                    }
                } else {
                    NSLog(@"[CanonBridge] EdsDownload failed with err: 0x%x", err);
                    EdsDownloadCancel(inRef);
                }
                EdsRelease(stream);
            }
        }
    }
    if (inRef) {
        EdsRelease(inRef);
    }
    return 0;
}

static void noopICMethod(id self, SEL _cmd, id arg) {}

static NSOperatingSystemVersion fakeCatalinaOSVersion(id self, SEL _cmd) {
    NSOperatingSystemVersion v = { 10, 15, 5 };
    return v;
}

static void disableICCameraDeviceHijack(void) {
    Class piCls = objc_getClass("NSProcessInfo");
    if (piCls) {
        Method mVer = class_getInstanceMethod(piCls, @selector(operatingSystemVersion));
        if (mVer) {
            method_setImplementation(mVer, (IMP)fakeCatalinaOSVersion);
        }
    }
    Class cls = objc_getClass("ICCameraDevice");
    if (cls) {
        SEL s1 = NSSelectorFromString(@"registerForImageCaptureEventNotifications:");
        Method m1 = class_getInstanceMethod(cls, s1);
        if (m1) method_setImplementation(m1, (IMP)noopICMethod);
        else class_addMethod(cls, s1, (IMP)noopICMethod, "v@:@");

        SEL s2 = NSSelectorFromString(@"handleContent:");
        Method m2 = class_getInstanceMethod(cls, s2);
        if (m2) method_setImplementation(m2, (IMP)noopICMethod);
        else class_addMethod(cls, s2, (IMP)noopICMethod, "v@:@");
    }
}

@interface CanonBridgeEngine : NSObject <NSApplicationDelegate> {
    NSOpenGLContext *_glCtx;
    SyphonClient *_syphonClient;
    EdsCameraRef _edsCamera;
    EdsStreamRef _edsStream;
    BOOL _edsInitialized;
    BOOL _edsSessionOpen;
    int _tickCount;
}
- (void)tick;
@end

@implementation CanonBridgeEngine

+ (void)load {
    disableICCameraDeviceHijack();
}

- (instancetype)init {
    if ((self = [super init])) {
        disableICCameraDeviceHijack();
        NSOpenGLPixelFormatAttribute attrs[] = {
            NSOpenGLPFAAccelerated,
            NSOpenGLPFAColorSize, 24,
            NSOpenGLPFAAlphaSize, 8,
            0
        };
        NSOpenGLPixelFormat *pf = [[NSOpenGLPixelFormat alloc] initWithAttributes:attrs];
        if (!pf) {
            NSOpenGLPixelFormatAttribute softAttrs[] = { NSOpenGLPFAColorSize, 24, 0 };
            pf = [[NSOpenGLPixelFormat alloc] initWithAttributes:softAttrs];
        }
        _glCtx = [[NSOpenGLContext alloc] initWithFormat:pf shareContext:nil];
        _edsCamera = NULL;
        _edsStream = NULL;
        _edsInitialized = NO;
        _edsSessionOpen = NO;
        _tickCount = 0;
    }
    return self;
}

- (void)closeEdsSession {
    if (_edsStream) {
        EdsRelease(_edsStream);
        _edsStream = NULL;
    }
    if (_edsCamera) {
        if (_edsSessionOpen) {
            EdsCloseSession(_edsCamera);
            _edsSessionOpen = NO;
        }
        EdsRelease(_edsCamera);
        _edsCamera = NULL;
    }
}

- (BOOL)tryOpenDirectEdsSession {
    if (_edsSessionOpen && _edsCamera) return YES;

    [self closeEdsSession];

    if (!_edsInitialized) {
        system("killall -9 ptpcamerad 2>/dev/null");
        usleep(100000);
        EdsError initErr = EdsInitializeSDK();
        if (initErr != 0) {
            pthread_mutex_lock(&g_lock);
            snprintf(g_lastCmdStatus, sizeof(g_lastCmdStatus), "eds_init_0x%x", initErr);
            pthread_mutex_unlock(&g_lock);
            return NO;
        }
        _edsInitialized = YES;
    }
    system("killall -9 ptpcamerad 2>/dev/null");
    usleep(80000);

    EdsCameraListRef camList = NULL;
    EdsError err = EdsGetCameraList(&camList);
    if (err != 0 || !camList) {
        pthread_mutex_lock(&g_lock);
        snprintf(g_lastCmdStatus, sizeof(g_lastCmdStatus), "eds_list_0x%x", err);
        pthread_mutex_unlock(&g_lock);
        return NO;
    }

    EdsUInt32 count = 0;
    err = EdsGetChildCount(camList, &count);
    if (err != 0 || count == 0) {
        pthread_mutex_lock(&g_lock);
        snprintf(g_lastCmdStatus, sizeof(g_lastCmdStatus), "eds_count_%u_0x%x", count, err);
        pthread_mutex_unlock(&g_lock);
        EdsRelease(camList);
        return NO;
    }

    EdsCameraRef cam = NULL;
    err = EdsGetChildAtIndex(camList, 0, &cam);
    EdsRelease(camList);
    if (err != 0 || !cam) {
        pthread_mutex_lock(&g_lock);
        snprintf(g_lastCmdStatus, sizeof(g_lastCmdStatus), "eds_child_0x%x", err);
        pthread_mutex_unlock(&g_lock);
        [self closeEdsSession];
        return NO;
    }
    _edsCamera = cam;

    EdsDeviceInfo info;
    memset(&info, 0, sizeof(info));
    if (EdsGetDeviceInfo(_edsCamera, &info) == 0 && strlen(info.szDeviceDescription) > 0) {
        pthread_mutex_lock(&g_lock);
        strncpy(g_cameraName, info.szDeviceDescription, sizeof(g_cameraName) - 1);
        pthread_mutex_unlock(&g_lock);
    }

    err = EdsOpenSession(_edsCamera);
    if (err != 0) {
        pthread_mutex_lock(&g_lock);
        snprintf(g_lastCmdStatus, sizeof(g_lastCmdStatus), "eds_open_0x%x", err);
        pthread_mutex_unlock(&g_lock);
        [self closeEdsSession];
        return NO;
    }
    _edsSessionOpen = YES;

    // Register object event handler for automatic image transfer
    EdsSetObjectEventHandler(_edsCamera, kEdsObjectEvent_All, handleObjectEvent, NULL);

    // Set save destination to Both (Camera SD card + Host PC) and report high capacity
    EdsUInt32 saveTo = kEdsSaveTo_Both;
    EdsSetPropertyData(_edsCamera, kEdsPropID_SaveTo, 0, sizeof(saveTo), &saveTo);
    EdsCapacity capacity = { 0x7FFFFFFF, 0x1000, 1 };
    EdsSetCapacity(_edsCamera, capacity);

    // Enable Live View output to PC
    EdsUInt32 evfMode = 1;
    EdsSetPropertyData(_edsCamera, kEdsPropID_Evf_Mode, 0, sizeof(evfMode), &evfMode);
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.15]];

    EdsUInt32 device = 0;
    EdsGetPropertyData(_edsCamera, kEdsPropID_Evf_OutputDevice, 0, sizeof(device), &device);
    device |= 2; // kEdsEvfOutputDevice_PC
    EdsSetPropertyData(_edsCamera, kEdsPropID_Evf_OutputDevice, 0, sizeof(device), &device);
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.20]];

    EdsCreateMemoryStream(0, &_edsStream);
    pthread_mutex_lock(&g_lock);
    snprintf(g_lastCmdStatus, sizeof(g_lastCmdStatus), "eds_connected");
    pthread_mutex_unlock(&g_lock);
    [self refreshCameraProperties];
    return YES;
}

- (void)executePhysicalCapture {
    if (!_edsSessionOpen || !_edsCamera) {
        pthread_mutex_lock(&g_lock);
        snprintf(g_lastCmdStatus, sizeof(g_lastCmdStatus), "err_capture_no_session");
        pthread_mutex_unlock(&g_lock);
        return;
    }

    NSLog(@"[CanonBridge] >>> Triggering physical capture with external hotshoe flash sync...");
    long long captureStart = nowMs();

    // 1. Drop reflex mirror / exit Live View EVF:
    // On EOS 1300D / Rebel T6, Canon firmware forcibly disables the center hotshoe pin
    // (Godox CT-16) while Live View is active.
    // Setting EVF Output Device to 0 AND EVF Mode to 0 drops the mirror completely so
    // the hotshoe center sync contact connects directly to the mechanical shutter!
    EdsUInt32 dev0 = 0;
    EdsSetPropertyData(_edsCamera, kEdsPropID_Evf_OutputDevice, 0, sizeof(dev0), &dev0);
    EdsUInt32 mode0 = 0;
    EdsSetPropertyData(_edsCamera, kEdsPropID_Evf_Mode, 0, sizeof(mode0), &mode0);

    // 250ms gives the mechanical reflex mirror time to fully flip down
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.25]];

    // 2. Fire physical mechanical shutter with flash sync:
    // Use Completely_NonAF directly: fires INSTANTLY without autofocus lag, and clicks strictly ONCE!
    EdsError err = EdsSendCommand(_edsCamera, kEdsCameraCommand_PressShutterButton, kEdsCameraCommand_ShutterButton_Completely_NonAF);
    NSLog(@"[CanonBridge] PressShutterButton Completely_NonAF returned: 0x%x", err);

    if (err != 0) {
        // Fallback for bodies that require standard Completely
        NSLog(@"[CanonBridge] NonAF err 0x%x, trying ShutterButton_Completely...", err);
        err = EdsSendCommand(_edsCamera, kEdsCameraCommand_PressShutterButton, kEdsCameraCommand_ShutterButton_Completely);
        NSLog(@"[CanonBridge] PressShutterButton Completely returned: 0x%x", err);
    }

    // Hold briefly, then release shutter button back to OFF
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.12]];
    EdsSendCommand(_edsCamera, kEdsCameraCommand_PressShutterButton, kEdsCameraCommand_ShutterButton_OFF);

    // 3. Pump EdsGetEvent while waiting for the camera to transfer the captured high-res flash photo
    NSLog(@"[CanonBridge] Waiting for captured photo transfer from camera...");
    for (int i = 0; i < 60; i++) {
        EdsGetEvent();
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        pthread_mutex_lock(&g_lock);
        BOOL gotPhoto = (g_capturedPhotoTimeMs >= captureStart && g_capturedPhotoLen > 1000);
        pthread_mutex_unlock(&g_lock);
        if (gotPhoto) {
            NSLog(@"[CanonBridge] Captured photo acquired in %lld ms (%zu bytes)", nowMs() - captureStart, g_capturedPhotoLen);
            break;
        }
    }

    // 4. Re-enable EVF Live View for PC
    EdsUInt32 evfMode = 1;
    EdsSetPropertyData(_edsCamera, kEdsPropID_Evf_Mode, 0, sizeof(evfMode), &evfMode);
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.08]];

    EdsUInt32 devPC = 2; // kEdsEvfOutputDevice_PC
    EdsSetPropertyData(_edsCamera, kEdsPropID_Evf_OutputDevice, 0, sizeof(devPC), &devPC);
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.15]];

    pthread_mutex_lock(&g_lock);
    snprintf(g_lastCmdStatus, sizeof(g_lastCmdStatus), "capture_ok");
    g_lastCmdError = err;
    pthread_mutex_unlock(&g_lock);

    NSLog(@"[CanonBridge] Capture complete, Live View resumed successfully.");
}

- (void)refreshCameraProperties {
    if (!_edsSessionOpen || !_edsCamera) return;
    EdsUInt32 iso = 0, tv = 0, av = 0, wb = 0, aeMode = 0;
    EdsInt32 ev = 0;
    EdsGetPropertyData(_edsCamera, kEdsPropID_ISOSpeed, 0, sizeof(iso), &iso);
    EdsGetPropertyData(_edsCamera, kEdsPropID_Tv, 0, sizeof(tv), &tv);
    EdsGetPropertyData(_edsCamera, kEdsPropID_Av, 0, sizeof(av), &av);
    EdsGetPropertyData(_edsCamera, kEdsPropID_WhiteBalance, 0, sizeof(wb), &wb);
    EdsGetPropertyData(_edsCamera, kEdsPropID_ExposureCompensation, 0, sizeof(ev), &ev);
    EdsGetPropertyData(_edsCamera, kEdsPropID_AEMode, 0, sizeof(aeMode), &aeMode);

    pthread_mutex_lock(&g_lock);
    g_curIso = iso;
    g_curTv = tv;
    g_curAv = av;
    g_curWb = wb;
    g_curEv = ev;
    g_curAeMode = aeMode;
    pthread_mutex_unlock(&g_lock);
}

- (void)processPendingCommands {
    pthread_mutex_lock(&g_cmdLock);
    BOOL hasCmd = g_hasPendingCmd;
    int iso = g_cmdIso;
    int tv = g_cmdTv;
    int av = g_cmdAv;
    int wb = g_cmdWb;
    int ev = g_cmdEv;
    int af = g_cmdAf;
    int focusStep = g_cmdFocusStep;
    BOOL doCapture = g_cmdCapture;

    g_hasPendingCmd = NO;
    g_cmdIso = -1;
    g_cmdTv = -1;
    g_cmdAv = -1;
    g_cmdWb = -1;
    g_cmdEv = -9999;
    g_cmdAf = 0;
    g_cmdFocusStep = 0;
    // Keep g_cmdCapture = YES until capture finishes so handleClient waits for completion!
    pthread_mutex_unlock(&g_cmdLock);

    if (!hasCmd) return;

    // If Camera Live is currently holding the USB session, quit it so we can control hardware directly!
    if (!_edsSessionOpen) {
        system("killall 'Camera Live' 2>/dev/null");
        usleep(450000);
        [self tryOpenDirectEdsSession];
    }

    if (doCapture) {
        [self executePhysicalCapture];
        pthread_mutex_lock(&g_cmdLock);
        g_cmdCapture = NO;
        pthread_mutex_unlock(&g_cmdLock);
        return;
    }

    if (!_edsSessionOpen || !_edsCamera) {
        pthread_mutex_lock(&g_lock);
        snprintf(g_lastCmdStatus, sizeof(g_lastCmdStatus), "err_no_session");
        pthread_mutex_unlock(&g_lock);
        return;
    }

    EdsError lastErr = 0;
    char statusMsg[64] = "ok";

    if (iso >= 0) {
        EdsUInt32 val = (EdsUInt32)iso;
        lastErr = EdsSetPropertyData(_edsCamera, kEdsPropID_ISOSpeed, 0, sizeof(val), &val);
        snprintf(statusMsg, sizeof(statusMsg), lastErr == 0 ? "iso_ok" : "iso_err_0x%x", lastErr);
    }
    if (tv >= 0) {
        EdsUInt32 val = (EdsUInt32)tv;
        lastErr = EdsSetPropertyData(_edsCamera, kEdsPropID_Tv, 0, sizeof(val), &val);
        snprintf(statusMsg, sizeof(statusMsg), lastErr == 0 ? "tv_ok" : "tv_err_0x%x", lastErr);
    }
    if (av >= 0) {
        EdsUInt32 val = (EdsUInt32)av;
        lastErr = EdsSetPropertyData(_edsCamera, kEdsPropID_Av, 0, sizeof(val), &val);
        snprintf(statusMsg, sizeof(statusMsg), lastErr == 0 ? "av_ok" : "av_err_0x%x", lastErr);
    }
    if (wb >= 0) {
        EdsUInt32 val = (EdsUInt32)wb;
        lastErr = EdsSetPropertyData(_edsCamera, kEdsPropID_WhiteBalance, 0, sizeof(val), &val);
        snprintf(statusMsg, sizeof(statusMsg), lastErr == 0 ? "wb_ok" : "wb_err_0x%x", lastErr);
    }
    if (ev != -9999) {
        EdsInt32 val = (EdsInt32)ev;
        lastErr = EdsSetPropertyData(_edsCamera, kEdsPropID_ExposureCompensation, 0, sizeof(val), &val);
        snprintf(statusMsg, sizeof(statusMsg), lastErr == 0 ? "ev_ok" : "ev_err_0x%x", lastErr);
    }
    if (focusStep != 0) {
        // Ensure EVF output is active before driving lens focus motor
        EdsUInt32 device = 0;
        EdsGetPropertyData(_edsCamera, kEdsPropID_Evf_OutputDevice, 0, sizeof(device), &device);
        if ((device & 2) == 0) {
            device |= 2;
            EdsSetPropertyData(_edsCamera, kEdsPropID_Evf_OutputDevice, 0, sizeof(device), &device);
        }
        lastErr = EdsSendCommand(_edsCamera, kEdsCameraCommand_DriveLensEvf, (EdsInt32)focusStep);
        snprintf(statusMsg, sizeof(statusMsg), lastErr == 0 ? "focus_step_ok" : "focus_step_err_0x%x", lastErr);
    }
    if (af > 0) {
        EdsSendCommand(_edsCamera, kEdsCameraCommand_DoEvfAf, 0);
        lastErr = EdsSendCommand(_edsCamera, kEdsCameraCommand_DoEvfAf, 1);
        snprintf(statusMsg, sizeof(statusMsg), lastErr == 0 ? "af_ok" : "af_err_0x%x", lastErr);
        // Release AF after 650ms on main runloop
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(650 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
            if (self->_edsSessionOpen && self->_edsCamera) {
                EdsSendCommand(self->_edsCamera, kEdsCameraCommand_DoEvfAf, 0);
            }
        });
    }

    pthread_mutex_lock(&g_lock);
    g_lastCmdError = lastErr;
    strncpy(g_lastCmdStatus, statusMsg, sizeof(g_lastCmdStatus) - 1);
    pthread_mutex_unlock(&g_lock);

    [self refreshCameraProperties];
}

- (BOOL)pollDirectEdsFrame {
    if (!_edsSessionOpen || !_edsCamera) return NO;
    if (!_edsStream) {
        EdsCreateMemoryStream(0, &_edsStream);
        if (!_edsStream) return NO;
    }

    // Re-ensure EVF PC output periodically if needed
    if (_tickCount % 60 == 0) {
        EdsUInt32 device = 0;
        if (EdsGetPropertyData(_edsCamera, kEdsPropID_Evf_OutputDevice, 0, sizeof(device), &device) == 0) {
            if ((device & 2) == 0) {
                device |= 2;
                EdsSetPropertyData(_edsCamera, kEdsPropID_Evf_OutputDevice, 0, sizeof(device), &device);
            }
        }
    }

    // Keep camera awake every ~60s
    if (_tickCount % 1800 == 0) {
        EdsSendCommand(_edsCamera, kEdsCameraCommand_ExtendShutDownTimer, 0);
    }

    // Refresh ISO/Tv/Av/WB state every ~1.5s
    if (_tickCount % 45 == 0) {
        [self refreshCameraProperties];
    }

    EdsEvfImageRef evfImage = NULL;
    EdsError err = EdsCreateEvfImageRef(_edsStream, &evfImage);
    if (err != 0 || !evfImage) return NO;

    err = EdsDownloadEvfImage(_edsCamera, evfImage);
    EdsRelease(evfImage);

    if (err != 0) {
        if (err == 0xA102 /* OBJECT_NOTREADY */) {
            return YES; // Normal between EVF frames
        }
        // Session lost or camera power cycled
        if (err == 0x00000081 || err == 0x0000201E || err == 0x00000002) {
            [self closeEdsSession];
        }
        return NO;
    }

    void *ptr = NULL;
    EdsUInt64 len = 0;
    if (EdsGetPointer(_edsStream, &ptr) == 0 && EdsGetLength(_edsStream, &len) == 0 && ptr && len > 1000) {
        pthread_mutex_lock(&g_lock);
        if (g_jpegBuf) free(g_jpegBuf);
        g_jpegBuf = (unsigned char *)malloc((size_t)len);
        if (g_jpegBuf) {
            memcpy(g_jpegBuf, ptr, (size_t)len);
            g_jpegLen = (size_t)len;
            if (g_width == 0) g_width = 1056;
            if (g_height == 0) g_height = 704;
            g_lastFrameTimeMs = nowMs();
            strcpy(g_sourceMode, "edsdk");
        }
        pthread_mutex_unlock(&g_lock);
        return YES;
    }
    return NO;
}

- (void)ensureSyphonClient {
    if (_syphonClient && [_syphonClient isValid]) return;
    _syphonClient = nil;
    NSArray *servers = [[SyphonServerDirectory sharedDirectory] servers];
    if (servers.count == 0) return;

    NSDictionary *chosen = servers.firstObject;
    for (NSDictionary *desc in servers) {
        NSString *appName = [desc objectForKey:SyphonServerDescriptionAppNameKey] ?: @"";
        if ([appName rangeOfString:@"Camera Live" options:NSCaseInsensitiveSearch].location != NSNotFound) {
            chosen = desc;
            break;
        }
    }
    NSString *camName = [chosen objectForKey:SyphonServerDescriptionNameKey] ?: @"Canon EOS 1300D";
    pthread_mutex_lock(&g_lock);
    strncpy(g_cameraName, [camName UTF8String], sizeof(g_cameraName) - 1);
    pthread_mutex_unlock(&g_lock);

    [_glCtx makeCurrentContext];
    _syphonClient = [[SyphonClient alloc] initWithServerDescription:chosen context:[_glCtx CGLContextObj] options:nil newFrameHandler:nil];
}

- (BOOL)pollSyphonFrame {
    [self ensureSyphonClient];
    if (!_syphonClient || ![_syphonClient isValid]) return NO;

    [_glCtx makeCurrentContext];
    SyphonImage *img = [_syphonClient newFrameImage];
    if (!img) return NO;

    NSSize sz = [img textureSize];
    int w = (int)sz.width;
    int h = (int)sz.height;
    GLuint tex = [img textureName];
    if (w > 0 && h > 0 && tex != 0) {
        glBindTexture(GL_TEXTURE_RECTANGLE_ARB, tex);
        size_t rowBytes = (size_t)w * 4;
        unsigned char *raw = (unsigned char *)malloc(rowBytes * (size_t)h);
        unsigned char *flipped = (unsigned char *)malloc(rowBytes * (size_t)h);
        if (raw && flipped) {
            glPixelStorei(GL_PACK_ALIGNMENT, 1);
            glGetTexImage(GL_TEXTURE_RECTANGLE_ARB, 0, GL_RGBA, GL_UNSIGNED_BYTE, raw);
            for (int y = 0; y < h; y++) {
                memcpy(flipped + (size_t)y * rowBytes, raw + (size_t)(h - 1 - y) * rowBytes, rowBytes);
            }
            unsigned char *planes[1] = { flipped };
            NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
                initWithBitmapDataPlanes:planes
                              pixelsWide:w
                              pixelsHigh:h
                           bitsPerSample:8
                         samplesPerPixel:4
                                hasAlpha:YES
                                isPlanar:NO
                          colorSpaceName:NSDeviceRGBColorSpace
                             bytesPerRow:rowBytes
                            bitsPerPixel:32];
            NSData *jpg = [rep representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor: @(0.90)}];
            if (jpg && jpg.length > 1000) {
                pthread_mutex_lock(&g_lock);
                if (g_jpegBuf) free(g_jpegBuf);
                g_jpegBuf = (unsigned char *)malloc(jpg.length);
                if (g_jpegBuf) {
                    memcpy(g_jpegBuf, jpg.bytes, jpg.length);
                    g_jpegLen = jpg.length;
                    g_width = w;
                    g_height = h;
                    g_lastFrameTimeMs = nowMs();
                    strcpy(g_sourceMode, "syphon");
                }
                pthread_mutex_unlock(&g_lock);
            }
        }
        if (raw) free(raw);
        if (flipped) free(flipped);
        glBindTexture(GL_TEXTURE_RECTANGLE_ARB, 0);
    }
    return YES;
}

- (void)tick {
    @autoreleasepool {
        _tickCount++;
        if (_edsSessionOpen && _edsCamera) {
            EdsGetEvent();
        }
        [self processPendingCommands];

        // Try direct EDSDK session first if open
        if (_edsSessionOpen) {
            if ([self pollDirectEdsFrame]) return;
        }

        // If Syphon from Camera Live is available and we haven't switched to direct EDSDK:
        NSArray *servers = [[SyphonServerDirectory sharedDirectory] servers];
        if (servers.count > 0) {
            if ([self pollSyphonFrame]) return;
        }

        // Otherwise try opening direct EDSDK session after 10 ticks (~0.3s) every ~1.5s
        if (_tickCount > 10 && (_tickCount % 45 == 1)) {
            [self tryOpenDirectEdsSession];
        }
    }
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    disableICCameraDeviceHijack();
    NSTimer *timer = [NSTimer timerWithTimeInterval:0.030
                                             target:self
                                           selector:@selector(tick)
                                           userInfo:nil
                                            repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSRunLoopCommonModes];
}

@end

static int parseQueryInt(const char *query, const char *key, int defaultVal) {
    if (!query || !key) return defaultVal;
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "%s=", key);
    const char *p = strstr(query, pattern);
    if (!p) return defaultVal;
    p += strlen(pattern);
    if (strncmp(p, "0x", 2) == 0 || strncmp(p, "0X", 2) == 0) {
        return (int)strtol(p, NULL, 16);
    }
    return atoi(p);
}

static void handleClient(int fd) {
    char req[2048];
    ssize_t n = recv(fd, req, sizeof(req) - 1, 0);
    if (n <= 0) { close(fd); return; }
    req[n] = '\0';

    if (strncmp(req, "OPTIONS ", 8) == 0) {
        const char *hdr =
            "HTTP/1.1 204 No Content\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            "Access-Control-Allow-Headers: *\r\n"
            "Access-Control-Allow-Private-Network: true\r\n"
            "Connection: close\r\n\r\n";
        send(fd, hdr, strlen(hdr), 0);
        close(fd);
        return;
    }

    // Handle /captured_pose.jpg (MUST be checked before /capture!)
    if (strncmp(req, "GET /captured_pose.jpg", 22) == 0) {
        pthread_mutex_lock(&g_lock);
        unsigned char *copyBuf = NULL;
        size_t copyLen = 0;
        // Prefer newly captured high-res photo if less than 60s old
        if (g_capturedPhotoBuf && g_capturedPhotoLen > 1000 && (nowMs() - g_capturedPhotoTimeMs) < 60000) {
            copyBuf = (unsigned char *)malloc(g_capturedPhotoLen);
            if (copyBuf) {
                memcpy(copyBuf, g_capturedPhotoBuf, g_capturedPhotoLen);
                copyLen = g_capturedPhotoLen;
            }
        } else if (g_jpegBuf && g_jpegLen > 0) {
            copyBuf = (unsigned char *)malloc(g_jpegLen);
            if (copyBuf) {
                memcpy(copyBuf, g_jpegBuf, g_jpegLen);
                copyLen = g_jpegLen;
            }
        }
        pthread_mutex_unlock(&g_lock);

        if (!copyBuf || copyLen == 0) {
            const char *hdr =
                "HTTP/1.1 404 Not Found\r\n"
                "Access-Control-Allow-Origin: *\r\n"
                "Access-Control-Allow-Private-Network: true\r\n"
                "Connection: close\r\n\r\n";
            send(fd, hdr, strlen(hdr), 0);
            if (copyBuf) free(copyBuf);
            close(fd);
            return;
        }

        char hdr[512];
        snprintf(hdr, sizeof(hdr),
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: image/jpeg\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Private-Network: true\r\n"
            "Cache-Control: no-store, no-cache, must-revalidate\r\n"
            "Content-Length: %zu\r\n"
            "Connection: close\r\n\r\n", copyLen);
        send(fd, hdr, strlen(hdr), 0);
        send(fd, copyBuf, copyLen, 0);
        free(copyBuf);
        close(fd);
        return;
    }

    // Handle /capture or /api/camera/trigger-capture
    BOOL isCaptureReq = NO;
    if (strncmp(req, "POST /capture", 13) == 0 && (req[13] == ' ' || req[13] == '?' || req[13] == '\r')) isCaptureReq = YES;
    if (strncmp(req, "GET /capture", 12) == 0 && (req[12] == ' ' || req[12] == '?' || req[12] == '\r')) isCaptureReq = YES;
    if (strncmp(req, "POST /api/camera/trigger-capture", 32) == 0) isCaptureReq = YES;
    if (strncmp(req, "GET /api/camera/trigger-capture", 31) == 0) isCaptureReq = YES;

    if (isCaptureReq) {
        pthread_mutex_lock(&g_cmdLock);
        g_cmdCapture = YES;
        g_hasPendingCmd = YES;
        pthread_mutex_unlock(&g_cmdLock);

        // Wait up to 3.5s for physical shutter release & flash photo download to complete
        for (int i = 0; i < 70; i++) {
            usleep(50000);
            pthread_mutex_lock(&g_cmdLock);
            BOOL pending = g_cmdCapture;
            pthread_mutex_unlock(&g_cmdLock);
            if (!pending) break;
        }

        long long ts = nowMs();
        char body[512];
        snprintf(body, sizeof(body),
            "{\"ok\":true,\"source\":\"canon-usb-edsdk\",\"captured\":true,"
            "\"imageUrl\":\"http://127.0.0.1:19898/captured_pose.jpg?t=%lld\"}", ts);

        char hdr[512];
        snprintf(hdr, sizeof(hdr),
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            "Access-Control-Allow-Headers: *\r\n"
            "Access-Control-Allow-Private-Network: true\r\n"
            "Cache-Control: no-store, no-cache, must-revalidate\r\n"
            "Content-Length: %zu\r\n"
            "Connection: close\r\n\r\n", strlen(body));
        send(fd, hdr, strlen(hdr), 0);
        send(fd, body, strlen(body), 0);
        close(fd);
        return;
    }

    // Handle /control?iso=...&tv=...&av=...&wb=...&ev=...&af=...&focus=...
    if (strncmp(req, "GET /control", 12) == 0 || strncmp(req, "POST /control", 13) == 0) {
        const char *q = strchr(req, '?');
        if (q) {
            pthread_mutex_lock(&g_cmdLock);
            int iso = parseQueryInt(q, "iso", -1);
            int tv  = parseQueryInt(q, "tv", -1);
            int av  = parseQueryInt(q, "av", -1);
            int wb  = parseQueryInt(q, "wb", -1);
            int ev  = parseQueryInt(q, "ev", -9999);
            int af  = parseQueryInt(q, "af", 0);
            int focus = parseQueryInt(q, "focus", 0);

            if (iso >= 0) g_cmdIso = iso;
            if (tv >= 0)  g_cmdTv = tv;
            if (av >= 0)  g_cmdAv = av;
            if (wb >= 0)  g_cmdWb = wb;
            if (ev != -9999) g_cmdEv = ev;
            if (af > 0)   g_cmdAf = af;
            if (focus != 0) g_cmdFocusStep = focus;
            g_hasPendingCmd = YES;
            pthread_mutex_unlock(&g_cmdLock);

            // Wait up to 750ms for main runloop to execute the EDSDK command
            for (int i = 0; i < 15; i++) {
                usleep(50000);
                pthread_mutex_lock(&g_cmdLock);
                BOOL pending = g_hasPendingCmd;
                pthread_mutex_unlock(&g_cmdLock);
                if (!pending) break;
            }
        }
    }

    if (strncmp(req, "GET /status", 11) == 0 || strncmp(req, "GET /control", 12) == 0 || strncmp(req, "POST /control", 13) == 0) {
        pthread_mutex_lock(&g_lock);
        long long age = nowMs() - g_lastFrameTimeMs;
        int active = (g_jpegBuf != NULL && g_jpegLen > 1000 && age < 6000) ? 1 : 0;
        int w = g_width;
        int h = g_height;
        char cam[128];
        strncpy(cam, g_cameraName, sizeof(cam));
        char mode[32];
        strncpy(mode, g_sourceMode, sizeof(mode));
        char cmdStat[64];
        strncpy(cmdStat, g_lastCmdStatus, sizeof(cmdStat));
        uint32_t iso = g_curIso, tv = g_curTv, av = g_curAv, wb = g_curWb, aeMode = g_curAeMode, cmdErr = g_lastCmdError;
        int32_t ev = g_curEv;
        pthread_mutex_unlock(&g_lock);

        char body[1024];
        snprintf(body, sizeof(body),
            "{\"active\":%s,\"camera\":\"%s\",\"mode\":\"%s\",\"width\":%d,\"height\":%d,\"ageMs\":%lld,"
            "\"iso\":%u,\"tv\":%u,\"av\":%u,\"wb\":%u,\"ev\":%d,\"aeMode\":%u,"
            "\"cmdStatus\":\"%s\",\"cmdError\":%u}",
            active ? "true" : "false", cam, mode, w, h, age,
            iso, tv, av, wb, ev, aeMode, cmdStat, cmdErr);

        char hdr[512];
        snprintf(hdr, sizeof(hdr),
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Private-Network: true\r\n"
            "Cache-Control: no-store, no-cache, must-revalidate\r\n"
            "Content-Length: %zu\r\n"
            "Connection: close\r\n\r\n", strlen(body));
        send(fd, hdr, strlen(hdr), 0);
        send(fd, body, strlen(body), 0);
        close(fd);
        return;
    }

    // Serve JPEG frame
    pthread_mutex_lock(&g_lock);
    unsigned char *copyBuf = NULL;
    size_t copyLen = 0;
    if (g_jpegBuf && g_jpegLen > 0) {
        copyBuf = (unsigned char *)malloc(g_jpegLen);
        if (copyBuf) {
            memcpy(copyBuf, g_jpegBuf, g_jpegLen);
            copyLen = g_jpegLen;
        }
    }
    pthread_mutex_unlock(&g_lock);

    if (!copyBuf || copyLen == 0) {
        const char *hdr =
            "HTTP/1.1 503 Service Unavailable\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Private-Network: true\r\n"
            "Connection: close\r\n\r\n";
        send(fd, hdr, strlen(hdr), 0);
        if (copyBuf) free(copyBuf);
        close(fd);
        return;
    }

    char hdr[512];
    snprintf(hdr, sizeof(hdr),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: image/jpeg\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Private-Network: true\r\n"
        "Cache-Control: no-store, no-cache, must-revalidate\r\n"
        "Content-Length: %zu\r\n"
        "Connection: close\r\n\r\n", copyLen);
    send(fd, hdr, strlen(hdr), 0);
    send(fd, copyBuf, copyLen, 0);
    free(copyBuf);
    close(fd);
}

static void *httpServerThread(void *arg) {
    int srv = socket(AF_INET, SOCK_STREAM, 0);
    int opt = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(19898);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");
    while (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        usleep(150000);
    }
    listen(srv, 32);
    while (1) {
        int client = accept(srv, NULL, NULL);
        if (client >= 0) {
            handleClient(client);
        }
    }
    return NULL;
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        signal(SIGPIPE, SIG_IGN);
        disableICCameraDeviceHijack();
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        [app finishLaunching];

        CanonBridgeEngine *engine = [[CanonBridgeEngine alloc] init];

        pthread_t tid;
        pthread_create(&tid, NULL, httpServerThread, NULL);
        pthread_detach(tid);

        while (1) {
            @autoreleasepool {
                [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.033]];
                [engine tick];
            }
        }
    }
    return 0;
}

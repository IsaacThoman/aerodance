// aerodance for iPhone and iPad: the production web build in WKWebView, shown on a TV through
// AirPlay or an HDMI adapter while the phone becomes the remote. See ../README.md.
//
// Public API only (WebKit, AVKit, Network, CoreMotion, UniformTypeIdentifiers), so this can go to the App Store.
// The built game is bundled under www/ and served from 127.0.0.1 so the page is a secure context
// (song bundles are verified with crypto.subtle, and getUserMedia needs one). The port is fixed
// so saved scores and settings, which belong to the page's origin, survive relaunches.
//
// Development builds (AERODANCE_DEV, scripts/ios.ts without --release) take launch options and
// are inspectable in Safari's Web Inspector; App Store builds ignore both.
//
// One WKWebView runs the game. With no TV it fills the phone's screen and is played by touch.
// When a display connects, iOS gives the app an external-display scene; the web view moves into
// that scene's window (the page keeps running, nothing reloads) and the phone shows the remote,
// a second page of the game's own (/remote/), drawn in-engine like the game.
//
// The phone can also be another game's camera: the phone camera page (/pair/), in a third web view
// over the game, opened from the game's main menu or by a game's QR code (a universal link).
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <CoreMotion/CoreMotion.h>
#import <Network/Network.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#ifdef AERODANCE_DEV
#import <notify.h>
#endif

static NSString *const GameHostChanged = @"GameHostChanged";
// The game's camera bubble was tapped: the phone shows the phone camera page.
static NSString *const OpenPhoneCamera = @"OpenPhoneCamera";

static NSString *LaunchArg(NSString *name, NSString *fallback) {
#ifdef AERODANCE_DEV
  NSArray *args = NSProcessInfo.processInfo.arguments;
  NSUInteger i = [args indexOfObject:name];
  return i != NSNotFound && i + 1 < args.count ? args[i + 1] : fallback;
#else
  return fallback;
#endif
}

static BOOL LaunchFlag(NSString *name) {
#ifdef AERODANCE_DEV
  return [NSProcessInfo.processInfo.arguments containsObject:name];
#else
  return NO;
#endif
}

// The game's loopback port. --port lets simulators, which share the Mac's loopback, run side by side.
static NSString *Port(void) {
  static NSString *port;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ port = LaunchArg(@"--port", @"8417"); });
  return port;
}

// Which way up a screen or the device is, as WebKit counts it for the camera (and
// window.orientation): 0 upright, 90 turned counterclockwise (sideways with the bottom on the
// right), -90 clockwise, 180 upside down. An unknown one counts as upright, as in WebKit.
static NSInteger ScreenDegrees(UIWindowScene *scene) {
  switch (scene.effectiveGeometry.interfaceOrientation) {
    case UIInterfaceOrientationLandscapeRight: return 90;
    case UIInterfaceOrientationLandscapeLeft: return -90;
    case UIInterfaceOrientationPortraitUpsideDown: return 180;
    default: return 0;
  }
}

// The device's own orientation is the screen's mirror image: held sideways with the bottom on the
// right is UIDeviceOrientationLandscapeLeft and UIInterfaceOrientationLandscapeRight.
static NSInteger DeviceDegrees(UIDeviceOrientation orientation) {
  switch (orientation) {
    case UIDeviceOrientationLandscapeLeft: return 90;
    case UIDeviceOrientationLandscapeRight: return -90;
    case UIDeviceOrientationPortraitUpsideDown: return 180;
    default: return 0;
  }
}

// Which way up the device is from gravity (the accelerometer's x and y, in g): down along -y is
// upright, along -x it's turned counterclockwise. Leaning back on a stand counts; near flat, or
// near halfway between two ways, it's neither (nil), so it takes a clear turn to change.
static NSNumber *GravityDegrees(CMAcceleration a) {
  double x = fabs(a.x), y = fabs(a.y);
  if (hypot(a.x, a.y) < 0.35) return nil;
  if (y > x * 1.5) return a.y < 0 ? @0 : @180;
  if (x > y * 1.5) return a.x < 0 ? @90 : @-90;
  return nil;
}

static NSString *JSON(id object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingFragmentsAllowed error:nil];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"null";
}

#pragma mark - Saved scores and settings

// A copy of the page's aerodance* localStorage keys, in case WebKit clears the page's website
// data; inject.js puts back keys the page has lost. Per port, like the page's own storage.
static NSString *SavedStorageKey(void) { return [@"localStorage 127.0.0.1:" stringByAppendingString:Port()]; }

static NSDictionary<NSString *, NSString *> *SavedStorage(void) {
  NSDictionary *saved = [NSUserDefaults.standardUserDefaults dictionaryForKey:SavedStorageKey()];
  return saved ?: @{};
}

// Applies changes from the page: a string sets a key, null removes it. Returns whether anything changed.
static BOOL SaveStorage(NSDictionary *changes) {
  NSMutableDictionary *saved = [SavedStorage() mutableCopy];
  for (NSString *key in changes) {
    if (![key isKindOfClass:NSString.class] || ![key hasPrefix:@"aerodance"]) continue;
    id value = changes[key];
    if ([value isKindOfClass:NSString.class]) saved[key] = value;
    else if (value == NSNull.null) [saved removeObjectForKey:key];
  }
  if ([saved isEqualToDictionary:SavedStorage()]) return NO;
  [NSUserDefaults.standardUserDefaults setObject:saved forKey:SavedStorageKey()];
  return YES;
}

#pragma mark - Local file server

static NSString *MimeType(NSString *ext) {
  static NSDictionary *types;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    types = @{ @"html": @"text/html; charset=utf-8", @"js": @"text/javascript", @"mjs": @"text/javascript",
               @"css": @"text/css", @"json": @"application/json", @"webmanifest": @"application/manifest+json",
               @"wasm": @"application/wasm", @"png": @"image/png", @"jpg": @"image/jpeg", @"svg": @"image/svg+xml",
               @"webp": @"image/webp", @"ktx2": @"image/ktx2", @"glb": @"model/gltf-binary", @"mp3": @"audio/mpeg",
               @"m4a": @"audio/mp4", @"ogg": @"audio/ogg", @"wav": @"audio/wav", @"woff2": @"font/woff2", @"woff": @"font/woff",
               @"task": @"application/octet-stream" };
  });
  return types[ext.lowercaseString] ?: @"application/octet-stream";
}

// length is the Content-Length; body is what follows the headers, nil for HEAD, whose headers
// describe the GET response.
static void Respond(nw_connection_t c, int status, NSString *reason, NSString *headers, NSUInteger length, NSData *body) {
  NSString *head = [NSString stringWithFormat:@"HTTP/1.1 %d %@\r\n%@Content-Length: %lu\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                    status, reason, headers, (unsigned long)length];
  NSData *prefix = [head dataUsingEncoding:NSUTF8StringEncoding];
  dispatch_data_t d = dispatch_data_create(prefix.bytes, prefix.length, nil, ^{ (void)prefix; });
  // The body goes out as it is (files are memory-mapped), without being copied after the headers.
  if (body.length) d = dispatch_data_create_concat(d, dispatch_data_create(body.bytes, body.length, nil, ^{ (void)body; }));
  nw_connection_send(c, d, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, true, ^(nw_error_t error) { nw_connection_cancel(c); });
}

// A file, or the one byte range ("bytes=a-b") asked for, which WebKit's media loading asks for.
static void SendFile(nw_connection_t c, NSString *file, NSArray<NSString *> *lines, BOOL isHead) {
  void (^reply)(int, NSString *, NSString *, NSData *) = ^(int status, NSString *reason, NSString *headers, NSData *body) {
    Respond(c, status, reason, headers, body.length, isHead ? nil : body);
  };
  NSData *body = [NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:nil] ?: [NSData data];
  NSString *type = [NSString stringWithFormat:@"Content-Type: %@\r\nAccept-Ranges: bytes\r\n", MimeType(file.pathExtension)];
  for (NSString *line in lines) {
    if (![line.lowercaseString hasPrefix:@"range: bytes="]) continue;
    NSArray<NSString *> *ab = [[line substringFromIndex:13] componentsSeparatedByString:@"-"];
    NSUInteger len = body.length, a = ab[0].length ? (NSUInteger)ab[0].longLongValue : 0;
    NSUInteger b = ab.count > 1 && ab[1].length ? MIN((NSUInteger)ab[1].longLongValue, len - 1) : len - 1;
    if (!ab[0].length && ab.count > 1) { a = len - MIN((NSUInteger)ab[1].longLongValue, len); b = len - 1; }  // "bytes=-n"
    if (len == 0 || a > b || a >= len) {
      reply(416, @"Range Not Satisfiable", [NSString stringWithFormat:@"Content-Range: bytes */%lu\r\n", (unsigned long)len], [NSData data]); return;
    }
    NSString *range = [NSString stringWithFormat:@"%@Content-Range: bytes %lu-%lu/%lu\r\n", type, (unsigned long)a, (unsigned long)b, (unsigned long)len];
    Respond(c, 206, @"Partial Content", range, b - a + 1, isHead ? nil : [body subdataWithRange:NSMakeRange(a, b - a + 1)]);
    return;
  }
  reply(200, @"OK", type, body);
}

static NSString *Header(NSArray<NSString *> *lines, NSString *name) {
  NSString *prefix = [name.lowercaseString stringByAppendingString:@":"];
  for (NSString *line in lines) {
    if ([line.lowercaseString hasPrefix:prefix]) return [[line substringFromIndex:prefix.length] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  }
  return nil;
}

#pragma mark Imported songs

// The page's imported songs (apps/web/src/songs/appSongs.ts) are Dance Studio export ZIPs in
// Documents, which the Files app shows as On My iPhone › aerodance (UIFileSharingEnabled), so a
// ZIP saved there from Files, AirDrop or a Mac is one too. The page checks them; the app only
// keeps the files, under /app/ on the local server:
//
//   GET    /app/songs/          { files: [{ name, size, modified }] }, modified in Unix ms
//   GET    /app/songs/<name>    the ZIP (HEAD and byte ranges too)
//   PUT    /app/songs/<name>    saves the body as that ZIP, in place of one by that name, all at once
//   DELETE /app/songs/<name>
//   GET    /app/incoming/<name> a ZIP from the file picker (pickSong), and DELETE when it's read
//
// Other apps on the device can reach 127.0.0.1 too, so every /app/ request needs this launch's
// key (X-Aerodance-Key), which only the game's page is given (inject.js __aerodanceSongs).
static NSString *SongsKey(void) {
  static NSString *key;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    uint8_t bytes[32];
    arc4random_buf(bytes, sizeof bytes);
    NSMutableString *hex = [NSMutableString string];
    for (size_t i = 0; i < sizeof bytes; i++) [hex appendFormat:@"%02x", bytes[i]];
    // --songs-key sets it, for tests that call the routes themselves.
    key = LaunchArg(@"--songs-key", nil) ?: hex;
  });
  return key;
}
static NSString *SongsFolder(void) { return NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject; }
static NSString *IncomingFolder(void) { return [NSTemporaryDirectory() stringByAppendingPathComponent:@"incoming"]; }
static NSString *UploadsFolder(void) { return [NSTemporaryDirectory() stringByAppendingPathComponent:@"uploads"]; }
// A bundle can be 192 MiB (apps/web/src/songs/loadBundle.ts); its ZIP a little more.
static const unsigned long long MaxSongBytes = 200ull * 1024 * 1024;

// A ZIP's name in the folder: no paths, no hidden files.
static BOOL SongName(NSString *name) {
  return name.length > 0 && name.length <= 255 && ![name containsString:@"/"] && ![name hasPrefix:@"."] &&
    [name rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location == NSNotFound &&
    [name.pathExtension.lowercaseString isEqual:@"zip"];
}

static NSDictionary *SongFile(NSString *folder, NSString *name) {
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:[folder stringByAppendingPathComponent:name] error:nil];
  if (![attributes.fileType isEqual:NSFileTypeRegular]) return nil;
  return @{ @"name": name, @"size": @(attributes.fileSize), @"modified": @(llround(attributes.fileModificationDate.timeIntervalSince1970 * 1000)) };
}

static NSData *SongList(void) {
  NSMutableArray *files = [NSMutableArray array];
  for (NSString *name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:SongsFolder() error:nil]) {
    NSDictionary *file = SongName(name) ? SongFile(SongsFolder(), name) : nil;
    if (file) [files addObject:file];
  }
  return [NSJSONSerialization dataWithJSONObject:@{ @"files": files } options:0 error:nil];
}

typedef NS_ENUM(NSInteger, BodyResult) { BodyDone, BodyCut, BodyNoSpace, BodyUnwritable };
static BodyResult WriteFailed(NSError *error) {
  NSError *posix = [error.domain isEqual:NSPOSIXErrorDomain] ? error : error.userInfo[NSUnderlyingErrorKey];
  BOOL full = error.code == NSFileWriteOutOfSpaceError || ([posix.domain isEqual:NSPOSIXErrorDomain] && posix.code == ENOSPC);
  return full ? BodyNoSpace : BodyUnwritable;
}

// Writes the next `left` bytes of a request's body to `out`.
static void ReceiveBody(nw_connection_t c, NSFileHandle *out, unsigned long long left, void (^done)(BodyResult)) {
  if (left == 0) { done(BodyDone); return; }
  nw_connection_receive(c, 1, (uint32_t)MIN(left, 1024 * 1024), ^(dispatch_data_t content, nw_content_context_t ctx, bool complete, nw_error_t error) {
    __block unsigned long long got = 0;
    __block NSError *failed;
    if (content) dispatch_data_apply(content, ^bool(dispatch_data_t region, size_t offset, const void *bytes, size_t size) {
      size = (size_t)MIN((unsigned long long)size, left - got);
      if (![out writeData:[NSData dataWithBytesNoCopy:(void *)bytes length:size freeWhenDone:NO] error:&failed]) return false;
      got += size;
      return got < left;
    });
    if (failed) done(WriteFailed(failed));
    else if (got == left) done(BodyDone);
    else if (error || complete) done(BodyCut);
    else ReceiveBody(c, out, left - got, done);
  });
}

// PUT /app/songs/<name>: the body goes to a file of its own, which then takes the name at once
// (rename), so the folder never holds half a ZIP.
static void SaveSong(nw_connection_t c, NSString *name, NSArray<NSString *> *lines, NSData *start) {
  NSString *length = Header(lines, @"content-length");
  unsigned long long size = length.longLongValue;
  if (!length.length || length.longLongValue < 0) { Respond(c, 411, @"Length Required", @"", 0, nil); return; }
  if (size > MaxSongBytes) { Respond(c, 413, @"Content Too Large", @"", 0, nil); return; }
  NSFileManager *files = NSFileManager.defaultManager;
  [files createDirectoryAtPath:UploadsFolder() withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *upload = [UploadsFolder() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
  [files createFileAtPath:upload contents:nil attributes:nil];
  NSFileHandle *out = [NSFileHandle fileHandleForWritingAtPath:upload];
  if (!out) { Respond(c, 500, @"Internal Server Error", @"", 0, nil); return; }
  void (^done)(BodyResult) = ^(BodyResult result) {
    [out closeFile];
    NSString *path = [SongsFolder() stringByAppendingPathComponent:name];
    if (result == BodyDone && rename(upload.fileSystemRepresentation, path.fileSystemRepresentation) == 0) {
      NSData *body = [NSJSONSerialization dataWithJSONObject:SongFile(SongsFolder(), name) ?: @{} options:0 error:nil];
      Respond(c, 200, @"OK", @"Content-Type: application/json\r\n", body.length, body);
      return;
    }
    [files removeItemAtPath:upload error:nil];
    if (result == BodyCut) nw_connection_cancel(c);
    else if (result == BodyNoSpace) Respond(c, 507, @"Insufficient Storage", @"", 0, nil);
    else Respond(c, 500, @"Internal Server Error", @"", 0, nil);
  };
  // What came with the headers first.
  NSData *first = [start subdataWithRange:NSMakeRange(0, (NSUInteger)MIN((unsigned long long)start.length, size))];
  NSError *error;
  if (first.length && ![out writeData:first error:&error]) { done(WriteFailed(error)); return; }
  ReceiveBody(c, out, size - first.length, done);
}

// /app/: the imported songs, above.
static void ServeApp(nw_connection_t c, NSString *method, NSString *path, NSArray<NSString *> *lines, NSData *body) {
  void (^status)(int, NSString *) = ^(int code, NSString *reason) { Respond(c, code, reason, @"", 0, nil); };
  if (![Header(lines, @"x-aerodance-key") isEqual:SongsKey()]) { status(403, @"Forbidden"); return; }
  BOOL get = [method isEqual:@"GET"] || [method isEqual:@"HEAD"], head = [method isEqual:@"HEAD"];
  if ([path isEqual:@"/app/songs/"]) {
    if (!get) { status(405, @"Method Not Allowed"); return; }
    NSData *list = SongList();
    Respond(c, 200, @"OK", @"Content-Type: application/json\r\n", list.length, head ? nil : list);
    return;
  }
  NSString *prefix = [path hasPrefix:@"/app/songs/"] ? @"/app/songs/" : [path hasPrefix:@"/app/incoming/"] ? @"/app/incoming/" : nil;
  NSString *folder = [prefix isEqual:@"/app/songs/"] ? SongsFolder() : IncomingFolder(), *name = [path substringFromIndex:prefix.length];
  if (!prefix || !SongName(name)) { status(404, @"Not Found"); return; }
  NSString *file = [folder stringByAppendingPathComponent:name];
  if ([method isEqual:@"PUT"] && [prefix isEqual:@"/app/songs/"]) { SaveSong(c, name, lines, body); return; }
  if ([method isEqual:@"DELETE"]) {
    BOOL removed = SongFile(folder, name) && [NSFileManager.defaultManager removeItemAtPath:file error:nil];
    removed ? status(204, @"No Content") : status(404, @"Not Found");
    return;
  }
  if (!get) { status(405, @"Method Not Allowed"); return; }
  if (!SongFile(folder, name)) { status(404, @"Not Found"); return; }
  SendFile(c, file, lines, head);
}

static void Serve(nw_connection_t c, NSString *root, NSMutableData *buffer) {
  nw_connection_receive(c, 1, 64 * 1024, ^(dispatch_data_t content, nw_content_context_t ctx, bool complete, nw_error_t error) {
    if (content) dispatch_data_apply(content, ^bool(dispatch_data_t region, size_t offset, const void *bytes, size_t size) {
      [buffer appendBytes:bytes length:size]; return true;
    });
    NSRange end = [buffer rangeOfData:[NSData dataWithBytes:"\r\n\r\n" length:4] options:0 range:NSMakeRange(0, buffer.length)];
    if (end.location == NSNotFound) {
      if (error || complete || buffer.length > 64 * 1024) nw_connection_cancel(c); else Serve(c, root, buffer);
      return;
    }
    NSString *head = [[NSString alloc] initWithData:[buffer subdataWithRange:NSMakeRange(0, end.location)] encoding:NSUTF8StringEncoding];
    NSArray<NSString *> *lines = [head componentsSeparatedByString:@"\r\n"];
    NSArray *parts = [lines.firstObject componentsSeparatedByString:@" "];
    BOOL isHead = parts.count >= 2 && [parts[0] isEqual:@"HEAD"];
    void (^reply)(int, NSString *, NSString *, NSData *) = ^(int status, NSString *reason, NSString *headers, NSData *body) {
      Respond(c, status, reason, headers, body.length, isHead ? nil : body);
    };
    if (parts.count < 2) { reply(405, @"Method Not Allowed", @"Content-Type: text/plain\r\n", [NSData data]); return; }
    NSString *path = [[parts[1] componentsSeparatedByString:@"?"].firstObject stringByRemovingPercentEncoding] ?: @"/";
    if ([path hasPrefix:@"/app/"]) {
      NSUInteger after = end.location + 4;
      ServeApp(c, parts[0], path, lines, [buffer subdataWithRange:NSMakeRange(after, buffer.length - after)]);
      return;
    }
    if (!([parts[0] isEqual:@"GET"] || isHead)) {
      reply(405, @"Method Not Allowed", @"Content-Type: text/plain\r\n", [NSData data]); return;
    }
    if ([path hasSuffix:@"/"]) path = [path stringByAppendingString:@"index.html"];
    NSString *file = [[root stringByAppendingPathComponent:path] stringByStandardizingPath];
    // Inside www/ only: with the "/", a sibling such as www2/ doesn't count.
    BOOL inside = [file isEqual:root] || [file hasPrefix:[root stringByAppendingString:@"/"]];
    BOOL dir = NO;
    if (!inside || ![NSFileManager.defaultManager fileExistsAtPath:file isDirectory:&dir] || dir) {
      reply(404, @"Not Found", @"Content-Type: text/plain\r\n", [@"not found" dataUsingEncoding:NSUTF8StringEncoding]); return;
    }
    SendFile(c, file, lines, isHead);
  });
}

// Listens on 127.0.0.1 itself, not every address on the loopback interface. Each state change is
// handed to `changed` on the main queue.
static nw_listener_t StartServer(NSString *root, void (^changed)(nw_listener_t, nw_listener_state_t)) {
  nw_parameters_t params = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
  nw_parameters_set_required_interface_type(params, nw_interface_type_loopback);
  nw_parameters_set_local_endpoint(params, nw_endpoint_create_host("127.0.0.1", Port().UTF8String));
  nw_parameters_set_reuse_local_address(params, true);
  nw_listener_t listener = nw_listener_create(params);
  dispatch_queue_t queue = dispatch_queue_create("aerodance.http", DISPATCH_QUEUE_CONCURRENT);
  nw_listener_set_queue(listener, queue);
  nw_listener_set_new_connection_handler(listener, ^(nw_connection_t c) {
    nw_connection_set_queue(c, queue);
    nw_connection_start(c);
    Serve(c, root, [NSMutableData data]);
  });
  nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
    NSLog(@"aerodance: server state %d error %@", state, error);
    dispatch_async(dispatch_get_main_queue(), ^{ changed(listener, state); });
  });
  nw_listener_start(listener);
  return listener;
}

#pragma mark - The game's web view, shared by both screens

// Owns the one web view and puts it on the TV when there is one, else on the phone.
@interface GameHost : NSObject <WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate, UIDocumentPickerDelegate>
@property (class, readonly) GameHost *shared;
@property (nonatomic, strong) WKWebView *web;
@property (nonatomic, strong) nw_listener_t server;
@property (nonatomic, copy) NSString *root;              // the bundled www/
@property (nonatomic) nw_listener_state_t serverState;  // invalid while starting
@property (nonatomic) NSUInteger serverFailures;        // restarts since the server was last ready, for the backoff
@property (nonatomic, strong) NSURL *pendingURL;        // a page to load once the server is ready
@property (nonatomic) NSUInteger loadFailures;          // since a page last loaded, for the backoff
@property (nonatomic) BOOL retrying;                     // a retryPage load is scheduled
@property (nonatomic) BOOL reloadWanted;                 // the page was loaded before the server restarted
@property (nonatomic, strong) nw_listener_t loadServer;  // the server when the page started loading
@property (nonatomic, weak) UIView *phoneView;
@property (nonatomic, weak) UIView *tvView;
@property (nonatomic, copy) NSString *tvDescription;  // e.g. "1920×1080 @ 60 Hz", while a TV is connected
@property (nonatomic, copy) NSDictionary *page;        // the canvas's data-* state, from inject.js
@property (nonatomic) BOOL shownOnTV;                  // where the page was last told the game is (hostState's screen)
@property (nonatomic) CGRect airplayRect;              // the game's AirPlay bubble in the web view's points; null while it's away
// What the page is told about the app (inject.js __aerodanceHost).
@property (nonatomic) BOOL tv;            // the game is on an external display (AirPlay mirroring, HDMI); kept in step with onTV
@property (nonatomic) BOOL interrupted;   // between an audio interruption's start and end (a call, Siri, an alarm)
@property (nonatomic) NSInteger held;          // which way up the device is held (ScreenDegrees' terms), as last seen upright or sideways
@property (nonatomic) BOOL heldKnown;          // held has been seen (not only flat, or before the first reading)
@property (nonatomic) NSInteger gameScreen;    // which way up the game's screen is: the TV's (always upright) or the phone's
@property (nonatomic) NSInteger phoneScreen;   // which way up the phone's screen is
@property (nonatomic, strong) CMMotionManager *motion;  // gravity, for held, while the game is on a TV
@property (nonatomic, strong) WKUserContentController *scripts;
@property (nonatomic, copy) NSString *injectSource;
@property (nonatomic, strong) id drive;  // --drive's steps
@property (nonatomic, copy, readonly) NSString *site;    // the deployed site phones pair through (scripts/ios.ts --site)
@property (nonatomic, copy) NSDictionary *cameraState;  // the phone camera page's, for inject.js's reports
@property (nonatomic) BOOL covered;                     // the phone camera page is over the game on the phone
@property (nonatomic) BOOL suspended;                   // the game's sound is stopped while it's out of every window
@property (nonatomic, weak) UIDocumentPickerViewController *songPicker;  // open for the page's Import song
@end

@implementation GameHost

+ (GameHost *)shared {
  static GameHost *host;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ host = [GameHost new]; });
  return host;
}

- (WKWebView *)web {
  if (_web) return _web;
  self.root = [[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"www"] stringByStandardizingPath];
  [self startServer];
#ifdef AERODANCE_DEV
  // `xcrun simctl spawn <udid> notifyutil -p aerodance.drop-server` cancels the server, as if iOS
  // had taken its socket, to check that it comes back. It's down for 4 s (the backoff after four
  // failures), long enough to see a page load fail meanwhile and come back.
  int token;
  notify_register_dispatch("aerodance.drop-server", &token, dispatch_get_main_queue(), ^(int t) {
    NSLog(@"aerodance: dropping the server for 4 s (test)");
    self.serverFailures = 4;
    if (self.server) nw_listener_cancel(self.server);
  });
  // And `notifyutil -p aerodance.reload` reloads the page then, as the page itself might.
  notify_register_dispatch("aerodance.reload", &token, dispatch_get_main_queue(), ^(int t) { [self.web reload]; });
#endif

  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  config.allowsInlineMediaPlayback = YES;
  config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;  // lets Web Audio start without a tap
  config.allowsAirPlayForMediaPlayback = YES;
  config.preferences.elementFullscreenEnabled = NO;  // the app is already full screen (the game dims its fullscreen button)
  // inject.js gives the app the page's state and, with --report, sends frame stats to a Mac.
  NSString *script = [NSString stringWithContentsOfFile:[NSBundle.mainBundle pathForResource:@"inject" ofType:@"js"] encoding:NSUTF8StringEncoding error:nil];
  NSString *report = LaunchArg(@"--report", @"");
  script = [script stringByReplacingOccurrencesOfString:@"__REPORT_URL__" withString:report];
  script = [script stringByReplacingOccurrencesOfString:@"__FLOW__" withString:LaunchFlag(@"--flow") ? @"1" : @""];
  // The deployed site phones pair through, as globalThis.__aerodanceSite.
  script = [script stringByReplacingOccurrencesOfString:@"__SITE__" withString:self.site];
  // The key for the imported songs' routes, which only this page gets (SongsKey).
  script = [script stringByReplacingOccurrencesOfString:@"__SONGS_KEY__" withString:SongsKey()];
  // Files the picker and unfinished saves left behind last time.
  [NSFileManager.defaultManager removeItemAtPath:IncomingFolder() error:nil];
  [NSFileManager.defaultManager removeItemAtPath:UploadsFolder() error:nil];
  self.injectSource = script;
  // --drive '<json>': steps for inject.js to play, as the Apple TV app's launch config takes them.
  NSString *drive = LaunchArg(@"--drive", nil);
  if (drive) {
    self.drive = [NSJSONSerialization JSONObjectWithData:[drive dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![self.drive isKindOfClass:NSArray.class]) { NSLog(@"aerodance: --drive isn't a JSON array; ignoring it"); self.drive = nil; }
  }
  self.scripts = config.userContentController;
  [self.scripts addScriptMessageHandler:self name:@"aerodance"];
  [self installScripts];

  WKWebView *web = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
#ifdef AERODANCE_DEV
  web.inspectable = YES;
#endif
  web.UIDelegate = self;
  web.navigationDelegate = self;
  web.opaque = NO;
  web.backgroundColor = UIColor.blackColor;
  web.scrollView.backgroundColor = UIColor.blackColor;
  web.scrollView.scrollEnabled = NO;
  web.scrollView.bounces = NO;
  web.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;  // edge to edge; the page letterboxes itself
  web.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  _web = web;

  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%@%@", Port(), LaunchArg(@"--path", @"/")]];
  NSLog(@"aerodance loading %@ (report: %@)", url, report.length ? report : @"off");
  // --clear-website-data starts as if WebKit had cleared the page's storage, to test the saved copy.
  if (LaunchFlag(@"--clear-website-data")) {
    [WKWebsiteDataStore.defaultDataStore removeDataOfTypes:WKWebsiteDataStore.allWebsiteDataTypes modifiedSince:NSDate.distantPast completionHandler:^{
      NSLog(@"aerodance: cleared website data");
      [self loadWhenServerReady:url];
    }];
  } else {
    [self loadWhenServerReady:url];
  }
  return web;
}

// From www/app.json, which scripts/ios.ts writes; "" without one.
- (NSString *)site {
  static NSString *site;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSString *file = [[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"www"] stringByAppendingPathComponent:@"app.json"];
    NSData *json = [NSData dataWithContentsOfFile:file];
    NSDictionary *app = json ? [NSJSONSerialization JSONObjectWithData:json options:0 error:nil] : nil;
    site = [app isKindOfClass:NSDictionary.class] && [app[@"site"] isKindOfClass:NSString.class] ? app[@"site"] : @"";
  });
  return site;
}

#pragma mark Keeping the local server up

// iOS can take a suspended app's listening socket back (TN2277), and another app can hold the port
// at launch. So whenever the listener fails or is cancelled a new one starts, after 0.25 s, doubling
// with each failure up to 8 s, until one is ready.
- (void)startServer {
  // While the server was gone another app could have taken the port and answered the loaded
  // page's later requests (lazy scripts) as this origin, which may use the camera. Load the page
  // afresh from our own server once it's back (reloadIfWanted), unless a load is on its way.
  if (_web && [self isOurs:_web.URL] && !self.pendingURL && !self.retrying) self.reloadWanted = YES;
  self.serverState = nw_listener_state_invalid;
  self.server = StartServer(self.root, ^(nw_listener_t listener, nw_listener_state_t state) { [self server:listener changed:state]; });
}

- (void)server:(nw_listener_t)listener changed:(nw_listener_state_t)state {
  if (listener != self.server) return;  // an old one, already replaced
  self.serverState = state;
  if (state == nw_listener_state_ready) {
    self.serverFailures = 0;
    [self loadPending];
    [self reloadIfWanted];
    [NSNotificationCenter.defaultCenter postNotificationName:GameHostChanged object:self];  // the remote waits for it too
  } else if (state == nw_listener_state_failed || state == nw_listener_state_waiting) {
    nw_listener_cancel(listener);
  } else if (state == nw_listener_state_cancelled) {
    NSTimeInterval delay = MIN(0.25 * pow(2, self.serverFailures++), 8);
    NSLog(@"aerodance: restarting the server in %.2f s", delay);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      if (self.server == listener) [self startServer];
    });
  }
}

// Back in the foreground the server should be ready; if not, it starts again now rather than
// after the rest of its backoff.
- (void)checkServer {
  if (!self.server || self.serverState == nw_listener_state_ready || self.serverState == nw_listener_state_invalid) return;
  NSLog(@"aerodance: the server isn't ready (state %d); restarting it", self.serverState);
  self.serverFailures = 0;
  if (self.serverState == nw_listener_state_cancelled) [self startServer];
  else nw_listener_cancel(self.server);
}

// Pages load only from a ready server: before that, the port may be someone else's.
- (void)loadWhenServerReady:(NSURL *)url {
  self.pendingURL = url;
  if (self.serverState == nw_listener_state_ready) [self loadPending];
}

- (void)loadPending {
  NSURL *url = self.pendingURL;
  if (!url || !_web) return;
  self.pendingURL = nil;
  // WebKit's memory cache keeps the failures of a load while the server was down (the page's
  // scripts), which would leave the next load black too. Every file is local, so it's cheap to lose.
  [WKWebsiteDataStore.defaultDataStore removeDataOfTypes:[NSSet setWithObject:WKWebsiteDataTypeMemoryCache] modifiedSince:NSDate.distantPast completionHandler:^{
    [self.web loadRequest:[NSURLRequest requestWithURL:url]];
  }];
}

// The reload after a server restart waits until the player isn't in a song (loading, calibrating,
// the countdown, playing or paused), which it would throw away.
- (void)reloadIfWanted {
  if (!self.reloadWanted || !_web || self.serverState != nw_listener_state_ready) return;
  NSString *phase = self.page[@"gamePhase"];
  if (phase && ![@[@"results", @"error"] containsObject:phase]) return;
  self.reloadWanted = NO;
  NSLog(@"aerodance: reloading the page from the restarted server");
  [self loadWhenServerReady:_web.URL];
}

- (BOOL)isOurs:(NSURL *)url { return [url.host isEqual:@"127.0.0.1"] && url.port.integerValue == Port().integerValue; }

// A page of the game that couldn't load (the server went while the app was suspended, say) loads
// again once the server is back, rather than leaving a blank screen. Retries back off from 0.5 s
// to 10 s.
- (void)retryPage:(NSURL *)url because:(NSString *)reason {
  NSTimeInterval delay = MIN(0.5 * pow(2, self.loadFailures++), 10);
  NSLog(@"aerodance: %@ %@; loading it again in %.1f s", url, reason, delay);
  self.retrying = YES;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    self.retrying = NO;
    [self loadWhenServerReady:url];
  });
}

// A page of ours couldn't load from the server: a listener can look ready with its socket gone, so
// a ready one is replaced too (the remote's loads count as well).
- (void)serverFailedToServe {
  if (self.serverState == nw_listener_state_ready) nw_listener_cancel(self.server);
}

- (void)pageFailed:(NSError *)error {
  NSURL *url = error.userInfo[NSURLErrorFailingURLErrorKey];
  // Cancelled loads (a newer navigation; a link opened in Safari is WebKit's domain) aren't failures.
  if (![error.domain isEqual:NSURLErrorDomain] || error.code == NSURLErrorCancelled || ![self isOurs:url]) return;
  [self serverFailedToServe];
  [self retryPage:url because:[NSString stringWithFormat:@"couldn't load (%@)", error.localizedDescription]];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self pageFailed:error]; }
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self pageFailed:error]; }

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation { self.loadServer = self.server; }

// A new page has replaced the old one, and says where its AirPlay bubble is once it shows it.
- (void)webView:(WKWebView *)webView didCommitNavigation:(WKNavigation *)navigation {
  self.airplayRect = CGRectNull;
  [NSNotificationCenter.defaultCenter postNotificationName:GameHostChanged object:self];
}

// WebKit can finish a page from its cache while the server is down, without the scripts it needs
// (a black screen), so a page that finished while the server was down or being replaced loads again.
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  if ([self isOurs:webView.URL] && (self.serverState != nw_listener_state_ready || self.server != self.loadServer)) {
    [self retryPage:webView.URL because:@"loaded while the server was down"];
    return;
  }
  self.loadFailures = 0;
  self.reloadWanted = NO;  // fresh from our own server
  [self tellPage];
  [self tellPageHost];  // in case it changed while the page was loading
}

#pragma mark What the page is told

// The page's start state goes in first, as its own script (host state, the saved copy of its
// storage, --drive), so a page that loads or reloads later starts from what the app knows now;
// then inject.js. Rebuilt whenever that state changes.
- (void)installScripts {
  NSDictionary *start = @{ @"host": self.hostState, @"saved": SavedStorage(), @"drive": self.drive ?: NSNull.null };
  NSString *source = [NSString stringWithFormat:@"globalThis.__aerodanceStart = %@;", JSON(start)];
  [self.scripts removeAllUserScripts];
  [self.scripts addUserScript:[[WKUserScript alloc] initWithSource:source injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
  [self.scripts addUserScript:[[WKUserScript alloc] initWithSource:self.injectSource injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
}

- (NSDictionary *)hostState {
  return @{ @"interrupted": @(self.interrupted), @"tv": @(self.tv), @"screen": self.onTV ? @"tv" : @"phone",
            @"held": @(self.held), @"screens": @{ @"game": @(self.gameScreen), @"phone": @(self.phoneScreen) } };
}

- (void)setTv:(BOOL)tv {
  if (_tv == tv) return;
  _tv = tv;
  [self hostChanged];
}

- (void)setInterrupted:(BOOL)interrupted {
  if (_interrupted == interrupted) return;
  _interrupted = interrupted;
  [self hostChanged];
}

// WebKit turns the camera's picture upright for the screen the web view is on, and on a TV that's
// upright however the phone is held. So the page is told how the device is held and which way up
// each screen is, and turns the picture itself (cameraTurner in apps/web/src/host.ts). While the
// game is on a TV, how the device is held comes from gravity, as Orientation Lock leaves UIDevice
// upright; otherwise (and in the simulator, which has no accelerometer), from UIDevice. Flat on a
// table, the device is still held the way it last was. A turn is only told to the page: the start script
// (installScripts) isn't rebuilt for one, as that mid-load (an iPhone turning sideways at launch) can
// leave the page without inject.js, and a page that loads later is told when it finishes.
- (void)updateOrientation { [self updateOrientationHeld:nil]; }

- (void)updateOrientationHeld:(NSNumber *)gravity {
  NSDictionary *was = self.hostState;
  NSInteger phone = ScreenDegrees(self.phoneView.window.windowScene);
  NSInteger game = _web.window ? ScreenDegrees(_web.window.windowScene) : phone;
  self.gameScreen = game;
  self.phoneScreen = phone;
  UIDeviceOrientation device = UIDevice.currentDevice.orientation;
  if (gravity) {
    self.held = gravity.integerValue;
    self.heldKnown = YES;
  } else if (!self.motion.accelerometerActive && (UIDeviceOrientationIsPortrait(device) || UIDeviceOrientationIsLandscape(device))) {
    self.held = DeviceDegrees(device);
    self.heldKnown = YES;
  } else if (!self.heldKnown) {
    self.held = phone;
  }
  if ([was isEqual:self.hostState]) return;
  NSLog(@"aerodance: host %@", JSON(self.hostState));
  [self tellPageHost];
}

// Gravity is only needed while the game is on a TV.
- (void)watchGravity {
  if (!self.motion.accelerometerAvailable || self.onTV == self.motion.accelerometerActive) return;
  if (!self.onTV) { [self.motion stopAccelerometerUpdates]; return; }
  [self.motion startAccelerometerUpdatesToQueue:NSOperationQueue.mainQueue withHandler:^(CMAccelerometerData *data, NSError *error) {
    NSNumber *held = data ? GravityDegrees(data.acceleration) : nil;
    if (held && (!self.heldKnown || held.integerValue != self.held)) [self updateOrientationHeld:held];
  }];
}

- (void)hostChanged {
  NSLog(@"aerodance: host %@", JSON(self.hostState));
  if (!_web) return;  // the page starts with it
  [self installScripts];
  [self tellPageHost];
}

- (void)tellPageHost {
  [_web evaluateJavaScript:[NSString stringWithFormat:@"window.__aerodanceSetHost && window.__aerodanceSetHost(%@)", JSON(self.hostState)] completionHandler:nil];
}

- (BOOL)onTV { return self.tvView != nil; }

// Moves the web view to the TV's window if there is one, else the phone's. The page keeps
// running across the move; WebKit re-attaches its layers to the new window. Under the phone camera
// page it leaves the phone's window: out of every window its page is hidden and stops drawing
// (hiding the view doesn't tell it), and its sound stops too.
- (void)place {
  UIView *target = self.tvView ?: self.phoneView;
  if (!target) return;
  WKWebView *web = self.web;
  if (self.covered && !self.tvView) target = nil;
  if (web.superview != target) {
    [web removeFromSuperview];
    // (Away, it keeps its size: the page isn't to lay itself out for nothing.)
    if (target) {
      web.frame = target.bounds;
      [target addSubview:web];
    }
  }
  BOOL away = !web.superview;
  if (away != self.suspended) {
    self.suspended = away;
    [web setAllMediaPlaybackSuspended:away completionHandler:nil];
  }
  [self updateTV];
  [self updateOrientation];
  [self watchGravity];
  if (self.onTV != self.shownOnTV) {
    self.shownOnTV = self.onTV;
    [self hostChanged];
  }
  [self tellPage];
  [NSNotificationCenter.defaultCenter postNotificationName:GameHostChanged object:self];
}

// tv tells the page (songPlayer.ts) to draw its clock without taking the output latency off: true
// while the game is on the TV and the sound goes there too, so the picture is as late as the
// sound. An HDMI picture with the sound on AirPods isn't.
- (void)updateTV {
  BOOL soundOnTV = NO;
  for (AVAudioSessionPortDescription *port in AVAudioSession.sharedInstance.currentRoute.outputs) {
    if ([port.portType isEqual:AVAudioSessionPortAirPlay] || [port.portType isEqual:AVAudioSessionPortHDMI]) soundOnTV = YES;
  }
  self.tv = self.onTV && soundOnTV;
}

// For inject.js's reports: which screen the game is on, how hot the device is, and the phone
// camera page's state while it's open.
- (void)tellPage {
  if (!_web) return;
  NSString *display = self.onTV ? [NSString stringWithFormat:@"tv %@", self.tvDescription] : @"phone";
  NSProcessInfo *info = NSProcessInfo.processInfo;
  NSArray *thermal = @[@"nominal", @"fair", @"serious", @"critical"];
  NSDictionary *device = @{ @"thermal": info.thermalState < thermal.count ? thermal[info.thermalState] : @"unknown", @"lowPower": @(info.lowPowerModeEnabled) };
  [_web evaluateJavaScript:[NSString stringWithFormat:@"window.__aerodanceDisplay = %@; window.__aerodanceDevice = %@; window.__aerodanceCamera = %@",
                            JSON(display), JSON(device), JSON(self.cameraState ?: NSNull.null)] completionHandler:nil];
}

- (void)setCovered:(BOOL)covered {
  if (_covered == covered) return;
  _covered = covered;
  [self place];
}

- (void)setCameraState:(NSDictionary *)state {
  if ([state isEqual:_cameraState] || (!state && !_cameraState)) return;
  _cameraState = [state copy];
  [self tellPage];
}

- (instancetype)init {
  if (!(self = [super init])) return nil;
  _airplayRect = CGRectNull;
  _motion = [CMMotionManager new];
  _motion.accelerometerUpdateInterval = 0.2;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserver:self selector:@selector(audioInterrupted:) name:AVAudioSessionInterruptionNotification object:nil];
  [center addObserverForName:AVAudioSessionRouteChangeNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { [self updateTV]; }];
  [center addObserver:self selector:@selector(sceneActivated) name:UISceneDidActivateNotification object:nil];
  [center addObserver:self selector:@selector(checkServer) name:UIApplicationWillEnterForegroundNotification object:nil];
  [UIDevice.currentDevice beginGeneratingDeviceOrientationNotifications];
  [center addObserver:self selector:@selector(updateOrientation) name:UIDeviceOrientationDidChangeNotification object:nil];
  for (NSNotificationName name in @[NSProcessInfoThermalStateDidChangeNotification, NSProcessInfoPowerStateDidChangeNotification]) {
    [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { [self tellPage]; }];
  }
  return self;
}

// A phone call, Siri or an alarm takes the audio. The game pauses and says so while interrupted;
// afterwards the session is made active again if iOS says to (not if the player started music
// elsewhere), and the song waits for the player to tap Resume either way.
// Every interruption counts: iOS 16 and later no longer report one for the app having been
// suspended (AVAudioSessionInterruptionReasonAppWasSuspended, before that WasSuspendedKey).
- (void)audioInterrupted:(NSNotification *)note {
  BOOL began = [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan;
  BOOL resume = [note.userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue] & AVAudioSessionInterruptionOptionShouldResume;
  dispatch_async(dispatch_get_main_queue(), ^{
    NSLog(@"aerodance: audio interruption %@", began ? @"began" : resume ? @"ended" : @"ended (not resuming)");
    if (began) { self.interrupted = YES; return; }
    if (resume) [self activateAudio];
    self.interrupted = NO;
  });
}

- (BOOL)activateAudio {
  NSError *error;
  if ([AVAudioSession.sharedInstance setActive:YES error:&error]) return YES;
  NSLog(@"aerodance: couldn't activate the audio session: %@", error);
  return NO;
}

// Not every interruption ends with a notification (another app's music can keep the audio), so
// coming back to the foreground ends it: the audio is taken back if nothing more important (a
// call) has it, except from music the player started meanwhile, which the next tap stops instead.
- (void)sceneActivated {
  if (!self.interrupted) return;
  if (AVAudioSession.sharedInstance.otherAudioPlaying || [self activateAudio]) self.interrupted = NO;
}

- (BOOL)serverReady { return self.serverState == nw_listener_state_ready; }

// The keys the remote sends (the arrows, OK and Back), as the canvas UI knows them.
- (void)sendKey:(NSString *)key {
  if (![@[@"ArrowUp", @"ArrowDown", @"ArrowLeft", @"ArrowRight", @"Enter", @"Escape"] containsObject:key]) return;
  [self.web evaluateJavaScript:[NSString stringWithFormat:@"window.__aerodanceKey && window.__aerodanceKey('%@')", key] completionHandler:nil];
}

// Only the game's own pages (the main frame, from the app's own server) talk to the app, not a
// frame one embeds.
static BOOL FromOurPage(WKScriptMessage *message) {
  WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
  return message.frameInfo.isMainFrame && [origin.protocol isEqual:@"http"] && [origin.host isEqual:@"127.0.0.1"] && origin.port == Port().integerValue;
}

// A rect from a page ({ x, y, w, h } in CSS pixels, which are the web view's points), or CGRectNull.
static CGRect PageRect(id value) {
  if (![value isKindOfClass:NSDictionary.class]) return CGRectNull;
  NSNumber *x = value[@"x"], *y = value[@"y"], *w = value[@"w"], *h = value[@"h"];
  for (NSNumber *n in @[x ?: NSNull.null, y ?: NSNull.null, w ?: NSNull.null, h ?: NSNull.null]) if (![n isKindOfClass:NSNumber.class]) return CGRectNull;
  return CGRectMake(x.doubleValue, y.doubleValue, w.doubleValue, h.doubleValue);
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  if (!FromOurPage(message)) return;
  NSDictionary *body = message.body;
  if (![body isKindOfClass:NSDictionary.class]) return;
  if ([body[@"page"] isKindOfClass:NSDictionary.class]) { self.page = body[@"page"]; [self reloadIfWanted]; }
  // The game's AirPlay bubble moved, came or went (menu/AirPlayButton.tsx).
  if (body[@"airplay"]) self.airplayRect = PageRect(body[@"airplay"]);
  if ([body[@"storage"] isKindOfClass:NSDictionary.class] && SaveStorage(body[@"storage"])) [self installScripts];
  if ([body[@"pickSong"] isEqual:@YES]) [self pickSong];
  if ([body[@"restored"] isKindOfClass:NSArray.class] && [body[@"restored"] count]) {
    NSLog(@"aerodance: restored %@ from the saved copy", [body[@"restored"] componentsJoinedByString:@", "]);
  }
  if (body[@"page"] || body[@"airplay"]) [NSNotificationCenter.defaultCenter postNotificationName:GameHostChanged object:self];
  // The camera bubble (menu/PhoneCameraButton.tsx), drawn only while the game is on the phone.
  if ([body[@"camera"] isEqual:@YES] && !self.onTV) [NSNotificationCenter.defaultCenter postNotificationName:OpenPhoneCamera object:self];
}

#pragma mark Importing songs and the page's dialogs

// What the phone's screen shows on top, for the file picker and the page's dialogs: they go on
// the phone even while the game is on the TV (whose screen can't be touched), over the remote.
- (UIViewController *)phoneController {
  UIViewController *controller = self.phoneView.window.rootViewController;
  while (controller.presentedViewController && !controller.presentedViewController.isBeingDismissed) controller = controller.presentedViewController;
  return controller;
}

// Import song (apps/web/src/songs/appSongs.ts pickAppSong): a ZIP from the Files app, copied
// for the page to read under /app/incoming/ and answered with { url, name }, or null.
- (void)pickSong {
  if (self.songPicker) return;
  UIViewController *controller = self.phoneController;
  if (!controller) { [self songPicked:nil name:nil]; return; }
  UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypeZIP] asCopy:YES];
  picker.delegate = self;
  picker.allowsMultipleSelection = NO;
  self.songPicker = picker;
  [controller presentViewController:picker animated:YES completion:nil];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  NSURL *url = urls.firstObject;
  NSString *name = [NSUUID.UUID.UUIDString stringByAppendingPathExtension:@"zip"];
  NSString *incoming = [IncomingFolder() stringByAppendingPathComponent:name];
  NSError *error;
  [NSFileManager.defaultManager createDirectoryAtPath:IncomingFolder() withIntermediateDirectories:YES attributes:nil error:nil];
  if (!url || ![NSFileManager.defaultManager moveItemAtPath:url.path toPath:incoming error:&error]) {
    NSLog(@"aerodance: couldn't take the picked file %@: %@", url, error);
    [self songPicked:nil name:nil];
    return;
  }
  [self songPicked:[@"/app/incoming/" stringByAppendingString:name] name:url.lastPathComponent];
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller { [self songPicked:nil name:nil]; }

- (void)songPicked:(NSString *)url name:(NSString *)name {
  id file = url ? @{ @"url": url, @"name": name ?: @"song.zip" } : NSNull.null;
  [self.web evaluateJavaScript:[NSString stringWithFormat:@"window.__aerodanceSongPicked && window.__aerodanceSongPicked(%@)", JSON(file)] completionHandler:nil];
}

// The page's alert() and confirm() (Settings → Songs asks before replacing or removing a song),
// which WebKit only shows through the app.
- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
  UIViewController *controller = self.phoneController;
  if (!controller) { completionHandler(); return; }
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:nil message:message preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) { completionHandler(); }]];
  [controller presentViewController:alert animated:YES completion:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
  UIViewController *controller = self.phoneController;
  if (!controller) { completionHandler(NO); return; }
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:nil message:message preferredStyle:UIAlertControllerStyleAlert];
  [alert addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:^(UIAlertAction *action) { completionHandler(NO); }]];
  [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) { completionHandler(YES); }]];
  [controller presentViewController:alert animated:YES completion:nil];
}

// The game's own camera tracking (MediaPipe in the page) may use the phone's camera; only the
// bundled game can ask, and only for video.
- (void)webView:(WKWebView *)webView requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
    initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision))decisionHandler {
  BOOL ours = [origin.host isEqual:@"127.0.0.1"] && origin.port == Port().integerValue;
  decisionHandler(ours && type == WKMediaCaptureTypeCamera ? WKPermissionDecisionGrant : WKPermissionDecisionDeny);
}

// Links that leave the game open in Safari.
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  NSURL *url = action.request.URL;
  if (action.targetFrame.isMainFrame && url.host && ![url.host isEqual:@"127.0.0.1"] && [@[@"http", @"https"] containsObject:url.scheme]) {
    [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
    decisionHandler(WKNavigationActionPolicyCancel);
    return;
  }
  decisionHandler(WKNavigationActionPolicyAllow);
}

- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
    forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
  if (action.request.URL) [UIApplication.sharedApplication openURL:action.request.URL options:@{} completionHandler:nil];
  return nil;
}

// iOS ends the page's process under memory pressure; start the game again (once the server is
// ready) rather than show a blank screen. The start script (installScripts) gives the new page the
// current host state and storage.
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  NSLog(@"aerodance: web content process ended; reloading");
  self.airplayRect = CGRectNull;  // the page, and its bubble, are gone
  [NSNotificationCenter.defaultCenter postNotificationName:GameHostChanged object:self];
  NSURL *url = webView.URL;
  [self loadWhenServerReady:[self isOurs:url] ? url : [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%@/", Port()]]];
}

@end

#pragma mark - TV screen

@interface TVViewController : UIViewController
@end

@implementation TVViewController
- (void)viewDidLoad { [super viewDidLoad]; self.view.backgroundColor = UIColor.blackColor; }
@end

@interface TVSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation TVSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  UIWindowScene *windowScene = (UIWindowScene *)scene;
  self.window = [[UIWindow alloc] initWithWindowScene:windowScene];
  self.window.rootViewController = [TVViewController new];
  self.window.hidden = NO;  // not key: touches and keys stay on the phone
  UIScreen *screen = windowScene.screen;
  CGSize px = screen.nativeBounds.size;
  GameHost *host = GameHost.shared;
  host.tvDescription = [NSString stringWithFormat:@"%.0f×%.0f @ %ld Hz", px.width, px.height, (long)screen.maximumFramesPerSecond];
  NSLog(@"aerodance: TV connected, %@ (%@, scale %.1f)", host.tvDescription, NSStringFromCGRect(screen.bounds), screen.scale);
  host.tvView = self.window.rootViewController.view;
  [host place];
}

- (void)sceneDidDisconnect:(UIScene *)scene {
  NSLog(@"aerodance: TV disconnected");
  GameHost *host = GameHost.shared;
  // A quick reconnect can bring the new TV scene before the old one leaves.
  if (host.tvView == self.window.rootViewController.view) {
    host.tvView = nil;
    host.tvDescription = nil;
    [host place];
  }
  self.window = nil;
}
@end

#pragma mark - Phone screen: the game, the remote while the game is on the TV, or the phone camera

// A page's messages, passed on without the web view's configuration keeping the view controller
// alive.
@interface PageMessages : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) id<WKScriptMessageHandler> target;
@end

@implementation PageMessages
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  [self.target userContentController:controller didReceiveScriptMessage:message];
}
@end

// An AirPlay picker with nothing to see: the page draws the button, and this takes its taps.
static AVRoutePickerView *InvisiblePicker(void) {
  AVRoutePickerView *picker = [AVRoutePickerView new];
  picker.prioritizesVideoDevices = YES;
  picker.tintColor = UIColor.clearColor;
  picker.activeTintColor = UIColor.clearColor;
  picker.hidden = YES;
  return picker;
}

// The phone pages' background (apps/web/src/phone/pageCanvas.tsx), around them too.
static UIColor *PageBackground(void) { return [UIColor colorWithRed:0x1f / 255.0 green:0x6f / 255.0 blue:0xd6 / 255.0 alpha:1]; }

// One of the game's own pages beside the game, in a web view of its own on the phone's screen: the
// remote (/remote/) while the game is on a TV, and the phone camera (/pair/). It loads from the
// game's server once that's ready, and again if it couldn't, as the game does (GameHost): a failed
// request to our own server replaces a server that only looks ready (anything else, such as the
// page's process ending, just loads it again), and retries back off from 0.5 s to 8 s. WebKit's
// memory cache would keep the failed loads, so it goes first. It stays on the game's own pages.
@interface LocalPage : NSObject <WKNavigationDelegate, WKUIDelegate>
@property (nonatomic, strong, readonly) WKWebView *web;
@property (nonatomic, copy, readonly) NSString *name;  // for the log
@property (nonatomic, copy) NSString *path;            // the page on the game's server
@property (nonatomic, copy) BOOL (^wanted)(void);       // whether it may load now (nil: whenever)
@property (nonatomic, copy) void (^lost)(void);         // its page's process ended (it loads again)
@property (nonatomic) BOOL usesCamera;                  // the page may use the camera, video only
@property (nonatomic) BOOL loading;                     // asked for the page (a failed load clears it)
@property (nonatomic) BOOL closed;                      // put away: it loads nothing more
@property (nonatomic) NSUInteger failures;              // since the page last loaded, for the backoff
@property (nonatomic) NSUInteger loads;                 // loads asked for, so a retry for an older one does nothing
@property (nonatomic, strong) nw_listener_t server;     // the server when the page started loading
@end

@implementation LocalPage

- (instancetype)initWithName:(NSString *)name path:(NSString *)path configuration:(WKWebViewConfiguration *)config {
  if (!(self = [super init])) return nil;
  _name = [name copy];
  _path = [path copy];
  WKWebView *web = _web = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
#ifdef AERODANCE_DEV
  web.inspectable = YES;
#endif
  web.navigationDelegate = self;
  web.UIDelegate = self;
  // The view it's in shows around it, and before it has drawn.
  web.opaque = NO;
  web.backgroundColor = UIColor.clearColor;
  web.scrollView.backgroundColor = UIColor.clearColor;
  web.scrollView.scrollEnabled = NO;
  web.scrollView.bounces = NO;
  web.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
  web.translatesAutoresizingMaskIntoConstraints = NO;
  return self;
}

// Puts the page in `view`, filling its safe area.
- (void)placeIn:(UIView *)view {
  [view addSubview:self.web];
  UILayoutGuide *safe = view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [self.web.topAnchor constraintEqualToAnchor:safe.topAnchor], [self.web.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor],
    [self.web.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor], [self.web.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor],
  ]];
}

// Loads the page, unless it's loading or loaded already, or can't yet (the server isn't ready, or
// it isn't wanted now).
- (void)load {
  if (self.closed || self.loading || !GameHost.shared.serverReady || (self.wanted && !self.wanted())) return;
  self.loading = YES;
  self.loads++;
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%@%@", Port(), self.path]];
  [WKWebsiteDataStore.defaultDataStore removeDataOfTypes:[NSSet setWithObject:WKWebsiteDataTypeMemoryCache] modifiedSince:NSDate.distantPast completionHandler:^{
    if (!self.closed) [self.web loadRequest:[NSURLRequest requestWithURL:url]];
  }];
}

// Loads this page afresh, whatever is loading or loaded.
- (void)loadPath:(NSString *)path {
  self.path = path;
  self.loading = NO;
  [self load];
}

// Puts the page away for good: it stops, and nothing loads into it again.
- (void)close {
  self.closed = YES;
  [self.web stopLoading];
  [self.web removeFromSuperview];
}

- (void)retry:(NSString *)reason {
  NSTimeInterval delay = MIN(0.5 * pow(2, self.failures++), 8);
  NSLog(@"aerodance: the %@ %@; loading it again in %.1f s", self.name, reason, delay);
  NSUInteger load = self.loads;
  __weak LocalPage *weak = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    LocalPage *page = weak;
    if (!page || load != page.loads) return;  // put away, or another load has started since
    page.loading = NO;
    [page load];
  });
}

- (void)failed:(NSError *)error {
  BOOL network = [error.domain isEqual:NSURLErrorDomain];
  if (network && error.code == NSURLErrorCancelled) return;
  if (network && [GameHost.shared isOurs:error.userInfo[NSURLErrorFailingURLErrorKey]]) [GameHost.shared serverFailedToServe];
  [self retry:[NSString stringWithFormat:@"couldn't load (%@)", error.localizedDescription]];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self failed:error]; }
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self failed:error]; }
- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation { self.server = GameHost.shared.server; }

// A page that finished while the server was down or being replaced may lack its scripts.
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  GameHost *host = GameHost.shared;
  if (!host.serverReady || host.server != self.server) { [self retry:@"loaded while the server was down"]; return; }
  self.failures = 0;
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  NSLog(@"aerodance: the %@'s web content process ended; reloading", self.name);
  self.loading = NO;
  if (self.lost) self.lost();
  [self load];
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  decisionHandler([GameHost.shared isOurs:action.request.URL] ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

// The phone camera page tracks with the phone's camera; only the game's own page may ask.
- (void)webView:(WKWebView *)webView requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
    initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type decisionHandler:(void (^)(WKPermissionDecision))decisionHandler {
  BOOL ours = [origin.host isEqual:@"127.0.0.1"] && origin.port == Port().integerValue;
  decisionHandler(self.usesCamera && ours && type == WKMediaCaptureTypeCamera ? WKPermissionDecisionGrant : WKPermissionDecisionDeny);
}

@end

// The code a game's QR code carries, /pair/#123456 (or ?code=123456), as the phone page reads it
// (apps/web/src/phone/PhoneLink.ts linkCode); nil without one.
static NSString *LinkCode(NSURL *url) {
  NSURLComponents *parts = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
  NSString *code = parts.fragment.length ? parts.fragment : nil;
  for (NSURLQueryItem *item in parts.queryItems) if (!code && [item.name isEqual:@"code"]) code = item.value;
  NSRegularExpression *six = [NSRegularExpression regularExpressionWithPattern:@"^[0-9]{6}$" options:0 error:nil];
  return code && [six numberOfMatchesInString:code options:0 range:NSMakeRange(0, code.length)] ? code : nil;
}

// What the phone's screen shows: the game, the remote (the game is on a TV), or the phone camera
// page (over either).
typedef NS_ENUM(NSInteger, PhoneShows) { PhoneShowsGame, PhoneShowsRemote, PhoneShowsCamera };

@interface PhoneViewController : UIViewController <WKScriptMessageHandler>
@property (nonatomic, strong) UIView *gameView;
@property (nonatomic, strong) AVRoutePickerView *gamePicker;    // over the game's AirPlay bubble (main menu)
@property (nonatomic, strong) UIView *remote;
@property (nonatomic, strong) LocalPage *remotePage;             // /remote/, made the first time the game goes to a TV
@property (nonatomic, strong) AVRoutePickerView *remotePicker;  // over the remote's AirPlay button
@property (nonatomic) CGRect remotePickerRect;                  // where the remote page says it goes; null: nowhere
@property (nonatomic, copy) NSString *remoteSent;               // the last state the remote page was given
@property (nonatomic, strong) UIView *camera;
@property (nonatomic, strong) LocalPage *cameraPage;            // /pair/, while the phone camera page is open
@property (nonatomic, copy) NSString *cameraStage;              // its PhoneLink stage (code, joining, linking, linked, ended)
@property (nonatomic) BOOL cameraDim;                           // it's dimmed while the phone tracks
@property (nonatomic, strong) UIImpactFeedbackGenerator *haptics;
@property (nonatomic, strong) UISceneAccessoryRegistration *tvAccessory API_AVAILABLE(ios(27.0));
@property (nonatomic) PhoneShows shown;  // what the phone showed at the last refresh
@end

@implementation PhoneViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.blackColor;
  self.overrideUserInterfaceStyle = UIUserInterfaceStyleDark;
  self.haptics = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];

  self.gameView = [[UIView alloc] initWithFrame:self.view.bounds];
  self.gameView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  self.gameView.backgroundColor = UIColor.blackColor;
  [self.view addSubview:self.gameView];
  [self.view addSubview:self.gamePicker = InvisiblePicker()];

  // While the game is on the TV: the remote page, inside the safe area, on its own background.
  self.remote = [[UIView alloc] initWithFrame:self.view.bounds];
  self.remote.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  self.remote.backgroundColor = PageBackground();
  self.remote.hidden = YES;
  [self.view addSubview:self.remote];
  self.remotePickerRect = CGRectNull;

  // While it's open: the phone camera page over everything, inside the safe area, on its own
  // background (black while the page is dimmed).
  self.camera = [[UIView alloc] initWithFrame:self.view.bounds];
  self.camera.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  self.camera.backgroundColor = PageBackground();
  self.camera.hidden = YES;
  [self.view addSubview:self.camera];

  GameHost *host = GameHost.shared;
  host.phoneView = self.gameView;
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(refresh) name:GameHostChanged object:host];
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(openCameraFromGame) name:OpenPhoneCamera object:host];
  [host place];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  // iOS 27 only shows an app on an external display when a view controller registers the
  // display's scene as an accessory; iOS 16-26 offer it to every app that declares the role.
  if (@available(iOS 27.0, *)) {
    if (self.tvAccessory) return;
    UISceneConfiguration *tv = [[UISceneConfiguration alloc] initWithName:@"TV" sessionRole:UIWindowSceneSessionRoleExternalDisplayNonInteractive];
    tv.delegateClass = TVSceneDelegate.class;
    self.tvAccessory = [self registerSceneAccessory:[UISceneAccessory externalNonInteractiveSceneAccessoryWithConfiguration:tv]];
    self.tvAccessory.enabled = YES;
    NSLog(@"aerodance: registered the TV scene accessory (available: %d)", self.tvAccessory.isAvailable);
  }
}

// The pickers follow their buttons when the views move (a turn of the iPad, the status bar
// coming or going); the pages say when the buttons themselves move.
- (void)viewDidLayoutSubviews {
  [super viewDidLayoutSubviews];
  [self placeGamePicker];
  [self placeRemotePicker];
  [GameHost.shared updateOrientation];  // the phone's screen may have turned
}

// (And once it has turned, in case the layout came first.)
- (void)viewWillTransitionToSize:(CGSize)size withTransitionCoordinator:(id<UIViewControllerTransitionCoordinator>)coordinator {
  [super viewWillTransitionToSize:size withTransitionCoordinator:coordinator];
  [coordinator animateAlongsideTransition:nil completion:^(id<UIViewControllerTransitionCoordinatorContext> context) { [GameHost.shared updateOrientation]; }];
}

- (PhoneShows)shows { return self.cameraPage ? PhoneShowsCamera : GameHost.shared.onTV ? PhoneShowsRemote : PhoneShowsGame; }

- (void)refresh {
  GameHost *host = GameHost.shared;
  BOOL tv = host.onTV;
  PhoneShows shows = self.shows;
  if (shows != self.shown) {
    self.shown = shows;
    [self setNeedsUpdateOfSupportedInterfaceOrientations];
    // An iPhone held sideways stays sideways until it's turned unless asked to turn now.
    UIWindowScene *scene = self.view.window.windowScene;
    if (scene && UIDevice.currentDevice.userInterfaceIdiom != UIUserInterfaceIdiomPad) {
      UIWindowSceneGeometryPreferencesIOS *turn = [[UIWindowSceneGeometryPreferencesIOS alloc] initWithInterfaceOrientations:self.supportedInterfaceOrientations];
      [scene requestGeometryUpdateWithPreferences:turn errorHandler:^(NSError *error) { NSLog(@"aerodance: couldn't turn the phone's screen: %@", error); }];
    }
  }
  if (tv) [self makeRemote];
  self.remote.hidden = shows != PhoneShowsRemote;
  self.remotePage.web.hidden = shows != PhoneShowsRemote;  // so the page knows it's away, and lets go of a held arrow
  self.gameView.hidden = shows != PhoneShowsGame;
  self.camera.hidden = shows != PhoneShowsCamera;
  self.camera.backgroundColor = self.cameraDim ? UIColor.blackColor : PageBackground();
  // Under the camera page the game stops (GameHost place); on a TV it carries on.
  host.covered = shows == PhoneShowsCamera;
  host.cameraState = self.cameraPage ? @{ @"stage": self.cameraStage ?: @"", @"dim": @(self.cameraDim) } : nil;
  [self.remotePage load];
  [self.cameraPage load];
  [self tellRemote:NO];
  [self placeGamePicker];
  NSDictionary *page = host.page ?: @{};
  BOOL inSong = page[@"gamePhase"] != nil;
  // The phone mustn't lock while players get ready and dance (nobody touches it), while it's the
  // TV's remote, nor while it's another game's camera; paused, on the results and on the menus it may.
  NSArray *awake = @[@"loading", @"calibrating", @"ready", @"countdown", @"playing", @"finishing"];
  BOOL camera = self.cameraPage && [@[@"joining", @"linking", @"linked"] containsObject:self.cameraStage ?: @""];
  UIApplication.sharedApplication.idleTimerDisabled = tv || camera || (inSong && [awake containsObject:page[@"gamePhase"]]);
  [self setNeedsStatusBarAppearanceUpdate];
  [self setNeedsUpdateOfHomeIndicatorAutoHidden];
  [self setNeedsUpdateOfScreenEdgesDeferringSystemGestures];
}

// The game's AirPlay bubble shows on its main menu while the game is on the phone; the page says
// where (GameHost airplayRect), in the web view's points.
- (void)placeGamePicker {
  GameHost *host = GameHost.shared;
  WKWebView *web = host.web;
  BOOL shown = self.shows == PhoneShowsGame && !CGRectIsNull(host.airplayRect) && web.superview == self.gameView;
  self.gamePicker.hidden = !shown;
  if (shown) self.gamePicker.frame = [web convertRect:host.airplayRect toView:self.view];
}

#pragma mark The remote

- (void)makeRemote {
  if (self.remotePage) return;
  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  PageMessages *messages = [PageMessages new];
  messages.target = self;
  [config.userContentController addScriptMessageHandler:messages name:@"aerodanceRemote"];
  LocalPage *page = self.remotePage = [[LocalPage alloc] initWithName:@"remote" path:@"/remote/" configuration:config];
  // (Only while the game is on a TV: the remote waits for the next one otherwise.)
  page.wanted = ^{ return GameHost.shared.onTV; };
  __weak PhoneViewController *weak = self;
  page.lost = ^{
    weak.remotePickerRect = CGRectNull;
    [weak placeRemotePicker];
  };
  [page placeIn:self.remote];
  [self.remote addSubview:self.remotePicker = InvisiblePicker()];
}

// Over the remote's AirPlay button, where the page says it is (in the remote web view's points).
- (void)placeRemotePicker {
  BOOL shown = self.remotePage && !CGRectIsNull(self.remotePickerRect);
  self.remotePicker.hidden = !shown;
  if (!shown) return;
  [self.remote layoutIfNeeded];
  self.remotePicker.frame = [self.remotePage.web convertRect:self.remotePickerRect toView:self.remote];
}

// The remote shows what the game is showing (the game's reported state), whenever it changes.
- (void)tellRemote:(BOOL)always {
  if (!self.remotePage) return;
  NSString *state = JSON(@{ @"page": GameHost.shared.page ?: @{}, @"shown": @(self.shows == PhoneShowsRemote) });
  if (!always && [state isEqual:self.remoteSent]) return;
  self.remoteSent = state;
  [self.remotePage.web evaluateJavaScript:[NSString stringWithFormat:@"window.__aerodanceRemote && window.__aerodanceRemote(%@)", state] completionHandler:nil];
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  if (!FromOurPage(message)) return;
  NSDictionary *body = message.body;
  if (![body isKindOfClass:NSDictionary.class]) return;
  if ([message.name isEqual:@"aerodanceCamera"]) {
    if (self.cameraPage && message.webView == self.cameraPage.web) [self cameraSaid:body];
    return;
  }
  // The remote's buttons (bridge.ts): a key for the game, where the AirPlay picker goes, and ready.
  // (Keys only while the remote shows: a held arrow can outlast it.)
  if ([body[@"key"] isKindOfClass:NSString.class] && self.shows == PhoneShowsRemote) {
    // A tap on the glass, not each repeat of a held arrow.
    if (![body[@"repeat"] isEqual:@YES]) [self.haptics impactOccurred];
    [GameHost.shared sendKey:body[@"key"]];
  }
  if (body[@"airplay"]) {
    self.remotePickerRect = PageRect(body[@"airplay"]);
    [self placeRemotePicker];
  }
  if ([body[@"ready"] isEqual:@YES]) [self tellRemote:YES];
}

#pragma mark The phone camera

// The phone as another game's camera: the phone camera page (apps/web/src/phone/), as a phone's
// browser opens it from the game's QR code, but served by the app over its own game (on the phone,
// or on a TV, which keeps showing it). The page pairs through the deployed site the game pairs
// through (scripts/ios.ts --site), and its code screen's close button comes back.
- (void)openCameraFromGame { [self openCamera:nil]; }

// Opens the page with this game's code (it joins at once), or for one to be typed (nil). With the
// page already open, a code joins that game instead; without one it stays as it is.
- (void)openCamera:(NSString *)code {
  [self loadViewIfNeeded];
  BOOL open = self.cameraPage != nil;
  if (!open) [self makeCamera];
  if (!open || code) [self.cameraPage loadPath:code ? [NSString stringWithFormat:@"/pair/?code=%@", code] : @"/pair/"];
  NSLog(@"aerodance: phone camera %@", code ? [@"joining " stringByAppendingString:code] : @"open");
  [self refresh];
}

- (void)makeCamera {
  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  config.allowsInlineMediaPlayback = YES;  // the camera's picture plays in the page, not full screen
  config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
  PageMessages *messages = [PageMessages new];
  messages.target = self;
  [config.userContentController addScriptMessageHandler:messages name:@"aerodanceCamera"];
  // Where it pairs, as the game's own page has it (inject.js).
  NSString *site = [NSString stringWithFormat:@"globalThis.__aerodanceSite = %@;", JSON(GameHost.shared.site)];
  [config.userContentController addUserScript:[[WKUserScript alloc] initWithSource:site injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
  LocalPage *page = self.cameraPage = [[LocalPage alloc] initWithName:@"camera page" path:@"/pair/" configuration:config];
  page.usesCamera = YES;
  [page placeIn:self.camera];
}

// Back to the game: the page goes, and its camera stops.
- (void)closeCamera {
  if (!self.cameraPage) return;
  [self.cameraPage close];
  self.cameraPage = nil;
  self.cameraStage = nil;
  self.cameraDim = NO;
  NSLog(@"aerodance: phone camera closed");
  [self refresh];
}

// The page (apps/web/src/phone/bridge.ts): its stage and whether it's dimmed, or close.
- (void)cameraSaid:(NSDictionary *)body {
  if ([body[@"close"] isEqual:@YES]) { [self closeCamera]; return; }
  if ([body[@"stage"] isKindOfClass:NSString.class]) self.cameraStage = body[@"stage"];
  if ([body[@"dim"] isKindOfClass:NSNumber.class]) self.cameraDim = [body[@"dim"] boolValue];
  [self refresh];
}

// A game's QR code, scanned with the app installed (a universal link to the deployed site's
// /pair/#<code>, apps/web/public/.well-known/apple-app-site-association): the phone becomes that
// game's camera.
- (void)openLink:(NSURL *)url {
  NSString *path = url.path.length ? url.path : @"/";
  if (![@[@"/pair", @"/phone"] containsObject:path]) { NSLog(@"aerodance: not a link the app opens: %@", url); return; }
  [self openCamera:LinkCode(url)];
}

// iPhone: the 16:9 game only fits sideways, and the remote's column only fits upright, so it's
// portrait only while the game is on the TV; the phone camera page fits either way, as in a browser.
// iPad: any way up, in any window size (Split View, Stage Manager); the pages fit either way. The
// app and scene allow the most any of them needs (AppDelegate, PhoneSceneDelegate).
- (UIInterfaceOrientationMask)supportedInterfaceOrientations {
  if (UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad) return UIInterfaceOrientationMaskAll;
  switch (self.shows) {
    case PhoneShowsCamera: return UIInterfaceOrientationMaskAllButUpsideDown;
    case PhoneShowsRemote: return UIInterfaceOrientationMaskPortrait;
    case PhoneShowsGame: return UIInterfaceOrientationMaskLandscape;
  }
}

// The game hides the status bar and home indicator; the remote and the camera page show them, as
// a browser would, except while the camera page is dimmed (as dark as it goes).
- (BOOL)prefersStatusBarHidden { return self.shows == PhoneShowsGame || (self.shows == PhoneShowsCamera && self.cameraDim); }
- (BOOL)prefersHomeIndicatorAutoHidden { return self.prefersStatusBarHidden; }
- (UIRectEdge)preferredScreenEdgesDeferringSystemGestures { return self.shows == PhoneShowsGame ? UIRectEdgeAll : UIRectEdgeNone; }

@end

#pragma mark - App

// Everything the app may use: Info.plist only lists landscape for the iPhone, so it launches
// sideways from a portrait home screen, but the remote and the phone camera page can be upright.
static UIInterfaceOrientationMask AllowedOrientations(void) {
  return UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad ? UIInterfaceOrientationMaskAll : UIInterfaceOrientationMaskAllButUpsideDown;
}

@interface PhoneSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation PhoneSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  PhoneViewController *phone = [PhoneViewController new];
  self.window.rootViewController = phone;
  [self.window makeKeyAndVisible];
  // Launched by a game's QR code (a universal link).
  for (NSUserActivity *activity in options.userActivities) [self scene:scene continueUserActivity:activity];
  // --link <url>: as if launched by that link.
  NSString *link = LaunchArg(@"--link", nil);
  if (link) [phone openLink:[NSURL URLWithString:link]];
}

// A game's QR code scanned while the app is open (or launched by one).
- (void)scene:(UIScene *)scene continueUserActivity:(NSUserActivity *)activity {
  if (![activity.activityType isEqual:NSUserActivityTypeBrowsingWeb] || !activity.webpageURL) return;
  NSLog(@"aerodance: opened by %@", activity.webpageURL);
  [(PhoneViewController *)self.window.rootViewController openLink:activity.webpageURL];
}

// iOS 27 asks the scene; PhoneViewController narrows it to what the game needs now.
- (UIInterfaceOrientationMask)supportedInterfaceOrientationsForWindowScene:(UIWindowScene *)windowScene API_AVAILABLE(ios(27.0)) {
  return AllowedOrientations();
}
@end

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation AppDelegate
- (BOOL)application:(UIApplication *)app didFinishLaunchingWithOptions:(NSDictionary *)options {
  // Playback: the music plays with the ring switch on silent, and follows the AirPlay route.
  [AVAudioSession.sharedInstance setCategory:AVAudioSessionCategoryPlayback error:nil];
  return YES;
}

// iOS 17-26 ask the app (iOS 27 asks PhoneSceneDelegate).
- (UIInterfaceOrientationMask)application:(UIApplication *)app supportedInterfaceOrientationsForWindow:(UIWindow *)window {
  return AllowedOrientations();
}

- (UISceneConfiguration *)application:(UIApplication *)app configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  BOOL tv = [session.role isEqual:UIWindowSceneSessionRoleExternalDisplayNonInteractive];
  UISceneConfiguration *config = [[UISceneConfiguration alloc] initWithName:tv ? @"TV" : @"Phone" sessionRole:session.role];
  config.delegateClass = tv ? TVSceneDelegate.class : PhoneSceneDelegate.class;
  return config;
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(AppDelegate.class)); }
}

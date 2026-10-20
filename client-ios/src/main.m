// aerodance for iPhone and iPad: the production web build in WKWebView, shown on a TV through
// AirPlay or an HDMI adapter while the phone becomes the remote. See ../README.md.
//
// Public API only (WebKit, AVKit, MediaPlayer, Network), so this can go to the App Store.
// The built game is bundled under www/ and served from 127.0.0.1 so the page is a secure context
// (song bundles are verified with crypto.subtle, and getUserMedia needs one). The port is fixed
// so saved scores and settings, which belong to the page's origin, survive relaunches.
//
// Development builds (AERODANCE_DEV, scripts/ios.ts without --release) take launch options and
// are inspectable in Safari's Web Inspector; App Store builds ignore both.
//
// One WKWebView runs the game. With no TV it fills the phone's screen and is played by touch.
// When a display connects, iOS gives the app an external-display scene; the web view moves into
// that scene's window (the page keeps running, nothing reloads) and the phone shows a remote.
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <MediaPlayer/MediaPlayer.h>
#import <Network/Network.h>
#ifdef AERODANCE_DEV
#import <notify.h>
#endif

static NSString *const GameHostChanged = @"GameHostChanged";

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
  NSMutableData *out = [[head dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
  if (body) [out appendData:body];
  NSData *keep = out;
  dispatch_data_t d = dispatch_data_create(keep.bytes, keep.length, nil, ^{ (void)keep; });
  nw_connection_send(c, d, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, true, ^(nw_error_t error) { nw_connection_cancel(c); });
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
    if (parts.count < 2 || !([parts[0] isEqual:@"GET"] || isHead)) {
      reply(405, @"Method Not Allowed", @"Content-Type: text/plain\r\n", [NSData data]); return;
    }
    NSString *path = [[parts[1] componentsSeparatedByString:@"?"].firstObject stringByRemovingPercentEncoding] ?: @"/";
    if ([path hasSuffix:@"/"]) path = [path stringByAppendingString:@"index.html"];
    NSString *file = [[root stringByAppendingPathComponent:path] stringByStandardizingPath];
    // Inside www/ only: with the "/", a sibling such as www2/ doesn't count.
    BOOL inside = [file isEqual:root] || [file hasPrefix:[root stringByAppendingString:@"/"]];
    BOOL dir = NO;
    if (!inside || ![NSFileManager.defaultManager fileExistsAtPath:file isDirectory:&dir] || dir) {
      reply(404, @"Not Found", @"Content-Type: text/plain\r\n", [@"not found" dataUsingEncoding:NSUTF8StringEncoding]); return;
    }
    NSData *body = [NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:nil] ?: [NSData data];
    NSString *type = [NSString stringWithFormat:@"Content-Type: %@\r\nAccept-Ranges: bytes\r\n", MimeType(file.pathExtension)];
    // One byte range ("bytes=a-b"), which WebKit's media loading asks for.
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
@interface GameHost : NSObject <WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate>
@property (class, readonly) GameHost *shared;
@property (nonatomic, strong) WKWebView *web;
@property (nonatomic, strong) nw_listener_t server;
@property (nonatomic, copy) NSString *root;              // the bundled www/
@property (nonatomic) nw_listener_state_t serverState;  // invalid while starting
@property (nonatomic) NSUInteger serverFailures;        // restarts since the server was last ready, for the backoff
@property (nonatomic, strong) NSURL *pendingURL;        // a page to load once the server is ready
@property (nonatomic) NSUInteger loadFailures;          // since a page last loaded, for the backoff
@property (nonatomic, strong) nw_listener_t loadServer;  // the server when the page started loading
@property (nonatomic, weak) UIView *phoneView;
@property (nonatomic, weak) UIView *tvView;
@property (nonatomic, copy) NSString *tvDescription;  // e.g. "1920×1080 @ 60 Hz", while a TV is connected
@property (nonatomic, copy) NSDictionary *page;        // the canvas's data-* state, from inject.js
@property (nonatomic) double fps;
// What the page is told about the app (inject.js __aerodanceHost).
@property (nonatomic) BOOL tv;            // the game is on an external display (AirPlay mirroring, HDMI); kept in step with onTV
@property (nonatomic) BOOL interrupted;   // between an audio interruption's start and end (a call, Siri, an alarm)
@property (nonatomic, strong) WKUserContentController *scripts;
@property (nonatomic, copy) NSString *injectSource;
@property (nonatomic, strong) id drive;  // --drive's steps
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
  NSString *root = self.root = [[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"www"] stringByStandardizingPath];
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
  // The deployed site phones pair through (scripts/ios.ts --site), as globalThis.__aerodanceSite.
  NSData *appJSON = [NSData dataWithContentsOfFile:[root stringByAppendingPathComponent:@"app.json"]];
  NSDictionary *app = appJSON ? [NSJSONSerialization JSONObjectWithData:appJSON options:0 error:nil] : nil;
  NSString *site = [app isKindOfClass:NSDictionary.class] && [app[@"site"] isKindOfClass:NSString.class] ? app[@"site"] : @"";
  script = [script stringByReplacingOccurrencesOfString:@"__SITE__" withString:site];
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

#pragma mark Keeping the local server up

// iOS can take a suspended app's listening socket back (TN2277), and another app can hold the port
// at launch. So whenever the listener fails or is cancelled a new one starts, after 0.25 s, doubling
// with each failure up to 8 s, until one is ready.
- (void)startServer {
  self.serverState = nw_listener_state_invalid;
  self.server = StartServer(self.root, ^(nw_listener_t listener, nw_listener_state_t state) { [self server:listener changed:state]; });
}

- (void)server:(nw_listener_t)listener changed:(nw_listener_state_t)state {
  if (listener != self.server) return;  // an old one, already replaced
  self.serverState = state;
  if (state == nw_listener_state_ready) {
    self.serverFailures = 0;
    [self loadPending];
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

- (BOOL)isOurs:(NSURL *)url { return [url.host isEqual:@"127.0.0.1"] && url.port.integerValue == Port().integerValue; }

// A page of the game that couldn't load (the server went while the app was suspended, say) loads
// again once the server is back, rather than leaving a blank screen. Retries back off from 0.5 s
// to 10 s.
- (void)retryPage:(NSURL *)url because:(NSString *)reason {
  NSTimeInterval delay = MIN(0.5 * pow(2, self.loadFailures++), 10);
  NSLog(@"aerodance: %@ %@; loading it again in %.1f s", url, reason, delay);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [self loadWhenServerReady:url]; });
}

- (void)pageFailed:(NSError *)error {
  NSURL *url = error.userInfo[NSURLErrorFailingURLErrorKey];
  // Cancelled loads (a newer navigation; a link opened in Safari is WebKit's domain) aren't failures.
  if (![error.domain isEqual:NSURLErrorDomain] || error.code == NSURLErrorCancelled || ![self isOurs:url]) return;
  // A listener can look ready with its socket gone, so a ready one is replaced too.
  if (self.serverState == nw_listener_state_ready) nw_listener_cancel(self.server);
  [self retryPage:url because:[NSString stringWithFormat:@"couldn't load (%@)", error.localizedDescription]];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self pageFailed:error]; }
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self pageFailed:error]; }

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation { self.loadServer = self.server; }

// WebKit can finish a page from its cache while the server is down, without the scripts it needs
// (a black screen), so a page that finished while the server was down or being replaced loads again.
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  if ([self isOurs:webView.URL] && (self.serverState != nw_listener_state_ready || self.server != self.loadServer)) {
    [self retryPage:webView.URL because:@"loaded while the server was down"];
    return;
  }
  self.loadFailures = 0;
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

- (NSDictionary *)hostState { return @{ @"interrupted": @(self.interrupted), @"tv": @(self.tv) }; }

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
// running across the move; WebKit re-attaches its layers to the new window.
- (void)place {
  UIView *target = self.tvView ?: self.phoneView;
  if (!target) return;
  WKWebView *web = self.web;
  if (web.superview != target) {
    [web removeFromSuperview];
    web.frame = target.bounds;
    [target addSubview:web];
  }
  self.tv = self.onTV;  // the page draws its clock without the TV's audio delay (songPlayer.ts)
  [self tellPage];
  [NSNotificationCenter.defaultCenter postNotificationName:GameHostChanged object:self];
}

// For inject.js's reports: which screen the game is on, and how hot the device is.
- (void)tellPage {
  if (!_web) return;
  NSString *display = self.onTV ? [NSString stringWithFormat:@"tv %@", self.tvDescription] : @"phone";
  NSProcessInfo *info = NSProcessInfo.processInfo;
  NSArray *thermal = @[@"nominal", @"fair", @"serious", @"critical"];
  NSDictionary *device = @{ @"thermal": info.thermalState < thermal.count ? thermal[info.thermalState] : @"unknown", @"lowPower": @(info.lowPowerModeEnabled) };
  [_web evaluateJavaScript:[NSString stringWithFormat:@"window.__aerodanceDisplay = %@; window.__aerodanceDevice = %@", JSON(display), JSON(device)] completionHandler:nil];
}

- (instancetype)init {
  if (!(self = [super init])) return nil;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserver:self selector:@selector(audioInterrupted:) name:AVAudioSessionInterruptionNotification object:nil];
  [center addObserver:self selector:@selector(sceneActivated) name:UISceneDidActivateNotification object:nil];
  [center addObserver:self selector:@selector(checkServer) name:UIApplicationWillEnterForegroundNotification object:nil];
  for (NSNotificationName name in @[NSProcessInfoThermalStateDidChangeNotification, NSProcessInfoPowerStateDidChangeNotification]) {
    [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { [self tellPage]; }];
  }
  return self;
}

// A phone call, Siri or an alarm takes the audio. The game pauses and says so while interrupted;
// afterwards the session is made active again, but the song waits for the player to tap Resume.
// Every interruption counts: iOS 16 and later no longer report one for the app having been
// suspended (AVAudioSessionInterruptionReasonAppWasSuspended, before that WasSuspendedKey).
- (void)audioInterrupted:(NSNotification *)note {
  BOOL began = [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan;
  dispatch_async(dispatch_get_main_queue(), ^{
    NSLog(@"aerodance: audio interruption %@", began ? @"began" : @"ended");
    if (began) { self.interrupted = YES; return; }
    [self activateAudio];
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
// coming back to the foreground takes the audio back if nothing more important (a call) has it.
- (void)sceneActivated {
  if (self.interrupted && [self activateAudio]) self.interrupted = NO;
}

- (void)sendKey:(NSString *)key {
  [self.web evaluateJavaScript:[NSString stringWithFormat:@"window.__aerodanceKey && window.__aerodanceKey('%@')", key] completionHandler:nil];
}

// Only the game itself (the main frame, from the app's own server) talks to the app, not a frame
// it embeds.
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
  if (!message.frameInfo.isMainFrame || ![origin.protocol isEqual:@"http"] || ![origin.host isEqual:@"127.0.0.1"] || origin.port != Port().integerValue) return;
  NSDictionary *body = message.body;
  if (![body isKindOfClass:NSDictionary.class]) return;
  if ([body[@"page"] isKindOfClass:NSDictionary.class]) self.page = body[@"page"];
  if ([body[@"fps"] isKindOfClass:NSNumber.class]) self.fps = [body[@"fps"] doubleValue];
  if ([body[@"storage"] isKindOfClass:NSDictionary.class] && SaveStorage(body[@"storage"])) [self installScripts];
  if ([body[@"restored"] isKindOfClass:NSArray.class] && [body[@"restored"] count]) {
    NSLog(@"aerodance: restored %@ from the saved copy", [body[@"restored"] componentsJoinedByString:@", "]);
  }
  if (body[@"page"] || body[@"fps"]) [NSNotificationCenter.defaultCenter postNotificationName:GameHostChanged object:self];
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

#pragma mark - Phone screen: the game, or a remote while the game is on the TV

@interface PhoneViewController : UIViewController
@property (nonatomic, strong) UIView *gameView;
@property (nonatomic, strong) UIView *remote;
@property (nonatomic, strong) UILabel *status;
@property (nonatomic, strong) UIButton *backButton;
@property (nonatomic, strong) AVRoutePickerView *floatingPicker;
@property (nonatomic, strong) NSTimer *repeat;
@property (nonatomic, strong) UIImpactFeedbackGenerator *haptics;
@property (nonatomic, strong) UISceneAccessoryRegistration *tvAccessory API_AVAILABLE(ios(27.0));
@property (nonatomic) BOOL shownOnTV;  // where the game was at the last refresh
@end

@implementation PhoneViewController

static NSDictionary<NSNumber *, NSString *> *ButtonKeys(void) {
  return @{ @1: @"ArrowUp", @2: @"ArrowDown", @3: @"ArrowLeft", @4: @"ArrowRight", @5: @"Enter", @6: @"Escape" };
}

- (UIButton *)button:(NSString *)symbol title:(NSString *)title tag:(NSInteger)tag size:(CGSize)size {
  UIButtonConfiguration *c = tag == 5 ? [UIButtonConfiguration filledButtonConfiguration] : [UIButtonConfiguration grayButtonConfiguration];
  c.cornerStyle = tag == 5 ? UIButtonConfigurationCornerStyleCapsule : UIButtonConfigurationCornerStyleLarge;
  if (symbol) c.image = [UIImage systemImageNamed:symbol withConfiguration:[UIImageSymbolConfiguration configurationWithPointSize:size.height * 0.32 weight:UIImageSymbolWeightBold]];
  if (title) c.attributedTitle = [[NSAttributedString alloc] initWithString:title attributes:@{ NSFontAttributeName: [UIFont systemFontOfSize:tag == 5 ? 26 : 20 weight:UIFontWeightBold] }];
  c.imagePadding = 6;
  c.baseBackgroundColor = tag == 5 ? [UIColor colorWithRed:0.37 green:0.78 blue:0.95 alpha:1] : nil;
  c.baseForegroundColor = tag == 5 ? UIColor.blackColor : UIColor.whiteColor;
  UIButton *b = [UIButton buttonWithConfiguration:c primaryAction:nil];
  b.tag = tag;
  b.accessibilityLabel = title ?: ButtonKeys()[@(tag)];
  [b addTarget:self action:@selector(pressDown:) forControlEvents:UIControlEventTouchDown];
  [b addTarget:self action:@selector(pressUp:) forControlEvents:UIControlEventTouchUpInside | UIControlEventTouchUpOutside | UIControlEventTouchCancel];
  b.translatesAutoresizingMaskIntoConstraints = NO;
  [NSLayoutConstraint activateConstraints:@[[b.widthAnchor constraintEqualToConstant:size.width], [b.heightAnchor constraintEqualToConstant:size.height]]];
  return b;
}

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.blackColor;
  self.overrideUserInterfaceStyle = UIUserInterfaceStyleDark;
  self.haptics = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];

  self.gameView = [[UIView alloc] initWithFrame:self.view.bounds];
  self.gameView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  self.gameView.backgroundColor = UIColor.blackColor;
  [self.view addSubview:self.gameView];

  // While the game is on the phone: a small AirPlay button in the corner.
  self.floatingPicker = [AVRoutePickerView new];
  self.floatingPicker.prioritizesVideoDevices = YES;
  self.floatingPicker.tintColor = [UIColor colorWithWhite:1 alpha:0.6];
  self.floatingPicker.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:self.floatingPicker];

  // While the game is on the TV: the remote.
  UIView *remote = self.remote = [UIView new];
  remote.translatesAutoresizingMaskIntoConstraints = NO;
  remote.backgroundColor = [UIColor colorWithRed:0.05 green:0.07 blue:0.1 alpha:1];
  [self.view addSubview:remote];

  UILabel *title = [UILabel new];
  title.text = @"aerodance";
  title.font = [UIFont systemFontOfSize:28 weight:UIFontWeightHeavy];
  title.textColor = UIColor.whiteColor;
  UILabel *status = self.status = [UILabel new];
  status.numberOfLines = 0;
  status.textAlignment = NSTextAlignmentCenter;
  status.font = [UIFont monospacedDigitSystemFontOfSize:14 weight:UIFontWeightRegular];
  status.textColor = [UIColor colorWithWhite:1 alpha:0.7];

  CGFloat s = 92;
  CGSize key = CGSizeMake(s, s);
  UIButton *up = [self button:@"chevron.up" title:nil tag:1 size:key], *down = [self button:@"chevron.down" title:nil tag:2 size:key];
  UIButton *left = [self button:@"chevron.left" title:nil tag:3 size:key], *right = [self button:@"chevron.right" title:nil tag:4 size:key];
  UIButton *ok = [self button:nil title:@"OK" tag:5 size:key];
  UIStackView *middle = [[UIStackView alloc] initWithArrangedSubviews:@[left, ok, right]];
  middle.spacing = 10;
  UIStackView *pad = [[UIStackView alloc] initWithArrangedSubviews:@[up, middle, down]];
  pad.axis = UILayoutConstraintAxisVertical;
  pad.alignment = UIStackViewAlignmentCenter;
  pad.spacing = 10;

  UIButton *back = self.backButton = [self button:@"arrow.uturn.backward" title:@"Back" tag:6 size:CGSizeMake(3 * s + 20, 56)];

  // The system volume, which is the TV's while AirPlaying, and the AirPlay picker.
  MPVolumeView *volume = [MPVolumeView new];
  volume.translatesAutoresizingMaskIntoConstraints = NO;
  [volume.heightAnchor constraintEqualToConstant:34].active = YES;
  AVRoutePickerView *picker = [AVRoutePickerView new];
  picker.prioritizesVideoDevices = YES;
  picker.tintColor = UIColor.whiteColor;
  picker.translatesAutoresizingMaskIntoConstraints = NO;
  [NSLayoutConstraint activateConstraints:@[[picker.widthAnchor constraintEqualToConstant:44], [picker.heightAnchor constraintEqualToConstant:44]]];
  UIStackView *audio = [[UIStackView alloc] initWithArrangedSubviews:@[[[UIImageView alloc] initWithImage:[UIImage systemImageNamed:@"speaker.wave.2.fill"]], volume, picker]];
  audio.spacing = 12;
  audio.alignment = UIStackViewAlignmentCenter;
  audio.tintColor = [UIColor colorWithWhite:1 alpha:0.7];
  [audio.widthAnchor constraintEqualToConstant:3 * s + 20].active = YES;

  UIStackView *column = [[UIStackView alloc] initWithArrangedSubviews:@[title, status, pad, back, audio]];
  column.axis = UILayoutConstraintAxisVertical;
  column.alignment = UIStackViewAlignmentCenter;
  column.spacing = 24;
  [column setCustomSpacing:8 afterView:title];
  [column setCustomSpacing:36 afterView:status];
  column.translatesAutoresizingMaskIntoConstraints = NO;
  [remote addSubview:column];

  UILayoutGuide *safe = self.view.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [remote.topAnchor constraintEqualToAnchor:self.view.topAnchor], [remote.bottomAnchor constraintEqualToAnchor:self.view.bottomAnchor],
    [remote.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor], [remote.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor],
    [column.centerXAnchor constraintEqualToAnchor:safe.centerXAnchor], [column.centerYAnchor constraintEqualToAnchor:safe.centerYAnchor],
    [column.topAnchor constraintGreaterThanOrEqualToAnchor:safe.topAnchor constant:8],
    [status.widthAnchor constraintLessThanOrEqualToAnchor:safe.widthAnchor constant:-32],
    [self.floatingPicker.topAnchor constraintEqualToAnchor:safe.topAnchor constant:4],
    [self.floatingPicker.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-4],
    [self.floatingPicker.widthAnchor constraintEqualToConstant:36], [self.floatingPicker.heightAnchor constraintEqualToConstant:36],
  ]];

  GameHost *host = GameHost.shared;
  host.phoneView = self.gameView;
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(refresh) name:GameHostChanged object:host];
  [host place];
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  UIApplication.sharedApplication.idleTimerDisabled = YES;  // the phone mustn't lock mid-song
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

- (void)refresh {
  GameHost *host = GameHost.shared;
  BOOL tv = host.onTV;
  if (tv != self.shownOnTV) {
    self.shownOnTV = tv;
    [self setNeedsUpdateOfSupportedInterfaceOrientations];
    // An iPhone held sideways stays sideways until it's turned unless asked to turn now.
    UIWindowScene *scene = self.view.window.windowScene;
    if (scene && UIDevice.currentDevice.userInterfaceIdiom != UIUserInterfaceIdiomPad) {
      UIWindowSceneGeometryPreferencesIOS *turn = [[UIWindowSceneGeometryPreferencesIOS alloc] initWithInterfaceOrientations:self.supportedInterfaceOrientations];
      [scene requestGeometryUpdateWithPreferences:turn errorHandler:^(NSError *error) { NSLog(@"aerodance: couldn't turn the phone's screen: %@", error); }];
    }
  }
  self.remote.hidden = !tv;
  self.gameView.hidden = tv;
  // Over the game the AirPlay button only shows on the main menu, where it doesn't cover play.
  NSDictionary *page = host.page ?: @{};
  BOOL inSong = page[@"gamePhase"] != nil;
  self.floatingPicker.hidden = tv || inSong || ![page[@"menuScreen"] isEqual:@"main"];
  NSString *screen = page[@"resultsScreen"] ? @"Results"
    : inSong ? [NSString stringWithFormat:@"Song: %@", page[@"gamePhase"]]
    : [page[@"songReady"] isEqual:@"true"] ? [NSString stringWithFormat:@"Songs: %@", page[@"songScreen"]]
    : [NSString stringWithFormat:@"Menu: %@", page[@"menuScreen"] ?: @"loading"];
  self.status.text = tv ? [NSString stringWithFormat:@"Playing on the TV (%@)\n%@ · %.0f fps", host.tvDescription, screen, host.fps] : @"";
  UIButtonConfiguration *c = self.backButton.configuration;
  c.attributedTitle = [[NSAttributedString alloc] initWithString:[page[@"gamePhase"] isEqual:@"playing"] ? @"Pause" : @"Back"
    attributes:@{ NSFontAttributeName: [UIFont systemFontOfSize:20 weight:UIFontWeightBold] }];
  self.backButton.configuration = c;
  [self setNeedsStatusBarAppearanceUpdate];
  [self setNeedsUpdateOfHomeIndicatorAutoHidden];
}

// iPhone: the 16:9 game only fits sideways, and the remote's column only fits upright, so it's
// portrait only while the game is on the TV. iPad: any way up, in any window size (Split View,
// Stage Manager); the page letterboxes itself and the remote fits either way. The app and scene
// allow the most either needs (AppDelegate, PhoneSceneDelegate).
- (UIInterfaceOrientationMask)supportedInterfaceOrientations {
  if (UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad) return UIInterfaceOrientationMaskAll;
  return GameHost.shared.onTV ? UIInterfaceOrientationMaskPortrait : UIInterfaceOrientationMaskLandscape;
}

- (BOOL)prefersStatusBarHidden { return !GameHost.shared.onTV; }
- (BOOL)prefersHomeIndicatorAutoHidden { return !GameHost.shared.onTV; }
- (UIRectEdge)preferredScreenEdgesDeferringSystemGestures { return GameHost.shared.onTV ? UIRectEdgeNone : UIRectEdgeAll; }

// Arrows repeat while held, like a keyboard.
- (void)pressDown:(UIButton *)b {
  [self.haptics impactOccurred];
  NSString *key = ButtonKeys()[@(b.tag)];
  [GameHost.shared sendKey:key];
  [self.repeat invalidate];
  if (b.tag > 4) return;
  self.repeat = [NSTimer scheduledTimerWithTimeInterval:0.4 repeats:NO block:^(NSTimer *t) {
    self.repeat = [NSTimer scheduledTimerWithTimeInterval:0.12 repeats:YES block:^(NSTimer *t) { [GameHost.shared sendKey:key]; }];
  }];
}

- (void)pressUp:(UIButton *)b { [self.repeat invalidate]; self.repeat = nil; }

@end

#pragma mark - App

// Everything the app may use: Info.plist only lists landscape for the iPhone, so it launches
// sideways from a portrait home screen, but the remote can be upright.
static UIInterfaceOrientationMask AllowedOrientations(void) {
  return UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad ? UIInterfaceOrientationMaskAll : UIInterfaceOrientationMaskAllButUpsideDown;
}

@interface PhoneSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation PhoneSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [PhoneViewController new];
  [self.window makeKeyAndVisible];
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

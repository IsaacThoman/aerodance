// aerodance for iPhone and iPad: the production web build in WKWebView, shown on a TV through
// AirPlay or an HDMI adapter while the phone becomes the remote. See ../README.md.
//
// Public API only (WebKit, AVKit, Network), so this can go to the App Store.
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
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
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
  NSData *prefix = [head dataUsingEncoding:NSUTF8StringEncoding];
  dispatch_data_t d = dispatch_data_create(prefix.bytes, prefix.length, nil, ^{ (void)prefix; });
  // The body goes out as it is (files are memory-mapped), without being copied after the headers.
  if (body.length) d = dispatch_data_create_concat(d, dispatch_data_create(body.bytes, body.length, nil, ^{ (void)body; }));
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
@property (nonatomic) BOOL retrying;                     // a retryPage load is scheduled
@property (nonatomic) BOOL reloadWanted;                 // the page was loaded before the server restarted
@property (nonatomic, strong) nw_listener_t loadServer;  // the server when the page started loading
@property (nonatomic, weak) UIView *phoneView;
@property (nonatomic, weak) UIView *tvView;
@property (nonatomic, copy) NSString *tvDescription;  // e.g. "1920×1080 @ 60 Hz", while a TV is connected
@property (nonatomic, copy) NSDictionary *page;        // the canvas's data-* state, from inject.js
@property (nonatomic) double fps;
@property (nonatomic) BOOL shownOnTV;                  // where the page was last told the game is (hostState's screen)
@property (nonatomic) CGRect airplayRect;              // the game's AirPlay bubble in the web view's points; null while it's away
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

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation {
  self.loadServer = self.server;
  // The new page says where its AirPlay bubble is once it shows it.
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

- (NSDictionary *)hostState { return @{ @"interrupted": @(self.interrupted), @"tv": @(self.tv), @"screen": self.onTV ? @"tv" : @"phone" }; }

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
  [self updateTV];
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
  _airplayRect = CGRectNull;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  [center addObserver:self selector:@selector(audioInterrupted:) name:AVAudioSessionInterruptionNotification object:nil];
  [center addObserverForName:AVAudioSessionRouteChangeNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { [self updateTV]; }];
  [center addObserver:self selector:@selector(sceneActivated) name:UISceneDidActivateNotification object:nil];
  [center addObserver:self selector:@selector(checkServer) name:UIApplicationWillEnterForegroundNotification object:nil];
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
  if ([body[@"fps"] isKindOfClass:NSNumber.class]) self.fps = [body[@"fps"] doubleValue];
  // The game's AirPlay bubble moved, came or went (menu/AirPlayButton.tsx).
  if (body[@"airplay"]) self.airplayRect = PageRect(body[@"airplay"]);
  if ([body[@"storage"] isKindOfClass:NSDictionary.class] && SaveStorage(body[@"storage"])) [self installScripts];
  if ([body[@"restored"] isKindOfClass:NSArray.class] && [body[@"restored"] count]) {
    NSLog(@"aerodance: restored %@ from the saved copy", [body[@"restored"] componentsJoinedByString:@", "]);
  }
  if (body[@"page"] || body[@"fps"] || body[@"airplay"]) [NSNotificationCenter.defaultCenter postNotificationName:GameHostChanged object:self];
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

#pragma mark - Phone screen: the game, or the remote while the game is on the TV

// The remote page's messages, passed on without the web view's configuration keeping the view
// controller alive.
@interface RemoteMessages : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) id<WKScriptMessageHandler> target;
@end

@implementation RemoteMessages
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

// The remote page's background (apps/web/src/phone/pageCanvas.tsx), around it too.
static UIColor *RemoteBackground(void) { return [UIColor colorWithRed:0x1f / 255.0 green:0x6f / 255.0 blue:0xd6 / 255.0 alpha:1]; }

@interface PhoneViewController : UIViewController <WKScriptMessageHandler, WKNavigationDelegate>
@property (nonatomic, strong) UIView *gameView;
@property (nonatomic, strong) AVRoutePickerView *gamePicker;    // over the game's AirPlay bubble (main menu)
@property (nonatomic, strong) UIView *remote;
@property (nonatomic, strong) WKWebView *remoteWeb;              // /remote/, made the first time the game goes to a TV
@property (nonatomic, strong) AVRoutePickerView *remotePicker;  // over the remote's AirPlay button
@property (nonatomic) BOOL remoteLoading;                       // asked for /remote/ (a failed load clears it)
@property (nonatomic, copy) NSString *remoteSent;               // the last state the remote page was given
@property (nonatomic, strong) UIImpactFeedbackGenerator *haptics;
@property (nonatomic, strong) UISceneAccessoryRegistration *tvAccessory API_AVAILABLE(ios(27.0));
@property (nonatomic) BOOL shownOnTV;  // where the game was at the last refresh
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
  self.remote.backgroundColor = RemoteBackground();
  self.remote.hidden = YES;
  [self.view addSubview:self.remote];

  GameHost *host = GameHost.shared;
  host.phoneView = self.gameView;
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(refresh) name:GameHostChanged object:host];
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

// The game's bubble moves with the page (a turn of the iPad), which says so; the picker follows.
- (void)viewDidLayoutSubviews {
  [super viewDidLayoutSubviews];
  [self placeGamePicker];
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
  if (tv) [self makeRemote];
  self.remote.hidden = !tv;
  self.gameView.hidden = tv;
  [self loadRemote];
  [self tellRemote:NO];
  [self placeGamePicker];
  NSDictionary *page = host.page ?: @{};
  BOOL inSong = page[@"gamePhase"] != nil;
  // The phone mustn't lock while players get ready and dance (nobody touches it), nor while it's
  // the TV's remote; paused, on the results and on the menus it may.
  NSArray *awake = @[@"loading", @"calibrating", @"ready", @"countdown", @"playing", @"finishing"];
  UIApplication.sharedApplication.idleTimerDisabled = tv || (inSong && [awake containsObject:page[@"gamePhase"]]);
  [self setNeedsStatusBarAppearanceUpdate];
  [self setNeedsUpdateOfHomeIndicatorAutoHidden];
}

// The game's AirPlay bubble shows on its main menu while the game is on the phone; the page says
// where (GameHost airplayRect), in the web view's points.
- (void)placeGamePicker {
  GameHost *host = GameHost.shared;
  WKWebView *web = host.web;
  BOOL shown = !host.onTV && !CGRectIsNull(host.airplayRect) && web.superview == self.gameView;
  self.gamePicker.hidden = !shown;
  if (shown) self.gamePicker.frame = [web convertRect:host.airplayRect toView:self.view];
}

#pragma mark The remote

- (void)makeRemote {
  if (self.remoteWeb) return;
  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  RemoteMessages *messages = [RemoteMessages new];
  messages.target = self;
  [config.userContentController addScriptMessageHandler:messages name:@"aerodanceRemote"];
  WKWebView *web = self.remoteWeb = [[WKWebView alloc] initWithFrame:CGRectZero configuration:config];
#ifdef AERODANCE_DEV
  web.inspectable = YES;
#endif
  web.navigationDelegate = self;
  web.opaque = NO;
  web.backgroundColor = RemoteBackground();
  web.scrollView.backgroundColor = RemoteBackground();
  web.scrollView.scrollEnabled = NO;
  web.scrollView.bounces = NO;
  web.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
  web.translatesAutoresizingMaskIntoConstraints = NO;
  [self.remote addSubview:web];
  UILayoutGuide *safe = self.remote.safeAreaLayoutGuide;
  [NSLayoutConstraint activateConstraints:@[
    [web.topAnchor constraintEqualToAnchor:safe.topAnchor], [web.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor],
    [web.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor], [web.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor],
  ]];
  [self.remote addSubview:self.remotePicker = InvisiblePicker()];
}

// The remote loads from the game's own server once it's ready, and again if it couldn't.
- (void)loadRemote {
  if (!self.remoteWeb || self.remoteLoading || !GameHost.shared.serverReady) return;
  self.remoteLoading = YES;
  self.remoteSent = nil;
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%@/remote/", Port()]];
  [self.remoteWeb loadRequest:[NSURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:10]];
}

- (void)remoteFailed:(NSError *)error {
  if ([error.domain isEqual:NSURLErrorDomain] && error.code == NSURLErrorCancelled) return;
  NSLog(@"aerodance: the remote couldn't load (%@); trying again", error.localizedDescription);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    self.remoteLoading = NO;
    [self loadRemote];
  });
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self remoteFailed:error]; }
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self remoteFailed:error]; }

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  NSLog(@"aerodance: the remote's web content process ended; reloading");
  self.remoteLoading = NO;
  self.remotePicker.hidden = YES;
  [self loadRemote];
}

// The remote stays on its own page.
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  decisionHandler([action.request.URL.host isEqual:@"127.0.0.1"] ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

// The remote shows what the game is showing (the game's reported state), whenever it changes.
- (void)tellRemote:(BOOL)always {
  if (!self.remoteWeb) return;
  NSString *state = JSON(@{ @"page": GameHost.shared.page ?: @{} });
  if (!always && [state isEqual:self.remoteSent]) return;
  self.remoteSent = state;
  [self.remoteWeb evaluateJavaScript:[NSString stringWithFormat:@"window.__aerodanceRemote && window.__aerodanceRemote(%@)", state] completionHandler:nil];
}

// The remote's buttons (bridge.ts): a key for the game, where the AirPlay picker goes, and ready.
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  if (!FromOurPage(message)) return;
  NSDictionary *body = message.body;
  if (![body isKindOfClass:NSDictionary.class]) return;
  // (Only while the game is on the TV: a held arrow can outlast it.)
  if ([body[@"key"] isKindOfClass:NSString.class] && GameHost.shared.onTV) {
    // A tap on the glass, not each repeat of a held arrow.
    if (![body[@"repeat"] boolValue]) [self.haptics impactOccurred];
    [GameHost.shared sendKey:body[@"key"]];
  }
  if (body[@"airplay"]) {
    CGRect rect = PageRect(body[@"airplay"]);
    self.remotePicker.hidden = CGRectIsNull(rect);
    if (!CGRectIsNull(rect)) self.remotePicker.frame = [self.remoteWeb convertRect:rect toView:self.remote];
  }
  if ([body[@"ready"] boolValue]) [self tellRemote:YES];
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

// aerodance for Apple TV: the production web build in WebKit's WKWebView. See ../README.md.
//
// WebKit isn't in the public tvOS SDK, but tvOS ships it, so it's loaded with dlopen and driven
// through the Objective-C runtime. That is private API: fine for development installs on your own
// Apple TVs, never allowed on the App Store or TestFlight.
// The built game is bundled under www/ and served from 127.0.0.1 so the page is a secure context
// (song bundles are verified with crypto.subtle). The port is fixed so saved scores and settings,
// which belong to the page's origin, survive relaunches.
#import <UIKit/UIKit.h>
#import <Network/Network.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

// The page's port: Info.plist's AerodancePort (TVOS_PORT when built), else 8417. Apps that share
// the Apple TV need their own, or one app's page can be served by another app's server.
static const char *ServerPort(void) {
  static char port[8] = "8417";
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSInteger p = [[NSBundle.mainBundle objectForInfoDictionaryKey:@"AerodancePort"] integerValue];
    if (p > 0 && p < 65536) snprintf(port, sizeof port, "%ld", (long)p);
  });
  return port;
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
               @"m4a": @"audio/mp4", @"ogg": @"audio/ogg", @"wav": @"audio/wav", @"woff2": @"font/woff2", @"woff": @"font/woff" };
  });
  return types[ext.lowercaseString] ?: @"application/octet-stream";
}

static void Respond(nw_connection_t c, int status, NSString *reason, NSString *type, NSData *body) {
  NSString *head = [NSString stringWithFormat:@"HTTP/1.1 %d %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                    status, reason, type, (unsigned long)body.length];
  NSMutableData *out = [[head dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
  [out appendData:body];
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
    NSArray *parts = [[head componentsSeparatedByString:@"\r\n"].firstObject componentsSeparatedByString:@" "];
    if (parts.count < 2 || !([parts[0] isEqual:@"GET"] || [parts[0] isEqual:@"HEAD"])) {
      Respond(c, 405, @"Method Not Allowed", @"text/plain", [NSData data]); return;
    }
    NSString *path = [[parts[1] componentsSeparatedByString:@"?"].firstObject stringByRemovingPercentEncoding] ?: @"/";
    if ([path hasSuffix:@"/"]) path = [path stringByAppendingString:@"index.html"];
    NSString *file = [[root stringByAppendingPathComponent:path] stringByStandardizingPath];
    BOOL dir = NO;
    if (![file hasPrefix:root] || ![NSFileManager.defaultManager fileExistsAtPath:file isDirectory:&dir] || dir) {
      Respond(c, 404, @"Not Found", @"text/plain", [@"not found" dataUsingEncoding:NSUTF8StringEncoding]); return;
    }
    NSData *body = [parts[0] isEqual:@"HEAD"] ? [NSData data] : [NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:nil];
    Respond(c, 200, @"OK", MimeType(file.pathExtension), body ?: [NSData data]);
  });
}

static nw_listener_t StartServer(NSString *root) {
  nw_parameters_t params = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
  nw_parameters_set_required_interface_type(params, nw_interface_type_loopback);
  nw_parameters_set_reuse_local_address(params, true);
  nw_listener_t listener = nw_listener_create_with_port(ServerPort(), params);
  dispatch_queue_t queue = dispatch_queue_create("aerodance.http", DISPATCH_QUEUE_CONCURRENT);
  nw_listener_set_queue(listener, queue);
  nw_listener_set_new_connection_handler(listener, ^(nw_connection_t c) {
    nw_connection_set_queue(c, queue);
    nw_connection_start(c);
    Serve(c, root, [NSMutableData data]);
  });
  nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
    NSLog(@"aerodance server state %d error %@", state, error);
  });
  nw_listener_start(listener);
  return listener;
}

#pragma mark - Game view

@interface GameViewController : UIViewController
@property (nonatomic, strong) UIView *web;
@property (nonatomic, strong) nw_listener_t server;
@property (nonatomic) BOOL atRoot;
@end

@implementation GameViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.blackColor;
  NSString *root = [[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"www"] stringByStandardizingPath];
  self.server = StartServer(root);

  dlopen("/System/Library/Frameworks/WebKit.framework/WebKit", RTLD_NOW);
  Class configClass = NSClassFromString(@"WKWebViewConfiguration"), webClass = NSClassFromString(@"WKWebView");
  if (!configClass || !webClass) { NSLog(@"aerodance: WebKit unavailable"); return; }
  id config = [configClass new];
  [config setValue:@YES forKey:@"allowsInlineMediaPlayback"];
  [config setValue:@0 forKey:@"mediaTypesRequiringUserActionForPlayback"];  // lets Web Audio start without a tap

  // The page reports whether it's on the main menu (so Menu can leave the app there) and, when a
  // --report URL is given, its frame stats to that address.
  id content = [config valueForKey:@"userContentController"];
  Protocol *handler = objc_getProtocol("WKScriptMessageHandler");
  if (handler) class_addProtocol(GameViewController.class, handler);
  ((void (*)(id, SEL, id, id))objc_msgSend)(content, sel_registerName("addScriptMessageHandler:name:"), self, @"aerodance");
  NSString *script = [NSString stringWithContentsOfFile:[NSBundle.mainBundle pathForResource:@"inject" ofType:@"js"] encoding:NSUTF8StringEncoding error:nil];
  NSArray *args = NSProcessInfo.processInfo.arguments;
  NSUInteger r = [args indexOfObject:@"--report"];
  NSString *report = r != NSNotFound && r + 1 < args.count ? args[r + 1] : @"";
  script = [script stringByReplacingOccurrencesOfString:@"__REPORT_URL__" withString:report];
  id userScript = ((id (*)(id, SEL, id, NSInteger, BOOL))objc_msgSend)([NSClassFromString(@"WKUserScript") alloc],
      sel_registerName("initWithSource:injectionTime:forMainFrameOnly:"), script, 0, YES);
  ((void (*)(id, SEL, id))objc_msgSend)(content, sel_registerName("addUserScript:"), userScript);

  id web = ((id (*)(id, SEL, CGRect, id))objc_msgSend)([webClass alloc], sel_registerName("initWithFrame:configuration:"), self.view.bounds, config);
  [web setValue:@YES forKey:@"inspectable"];
  UIScrollView *scroll = [web valueForKey:@"scrollView"];
  scroll.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;  // full-bleed, ignore the TV safe area
  scroll.scrollEnabled = NO;
  ((UIView *)web).autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  ((UIView *)web).opaque = NO;
  ((UIView *)web).backgroundColor = UIColor.blackColor;
  [self.view addSubview:web];
  self.web = web;

  // Swipes on the remote's touch surface move the menu focus like the arrow keys do.
  for (NSNumber *dir in @[@(UISwipeGestureRecognizerDirectionUp), @(UISwipeGestureRecognizerDirectionDown),
                          @(UISwipeGestureRecognizerDirectionLeft), @(UISwipeGestureRecognizerDirectionRight)]) {
    UISwipeGestureRecognizer *swipe = [[UISwipeGestureRecognizer alloc] initWithTarget:self action:@selector(swiped:)];
    swipe.direction = dir.unsignedIntegerValue;
    [self.view addGestureRecognizer:swipe];
  }

  NSUInteger p = [args indexOfObject:@"--path"];
  NSString *path = p != NSNotFound && p + 1 < args.count ? args[p + 1] : @"/?input=ghost";
  NSString *url = [NSString stringWithFormat:@"http://127.0.0.1:%s%@", ServerPort(), path];
  NSLog(@"aerodance loading %@ (report: %@)", url, report.length ? report : @"off");
  ((id (*)(id, SEL, id))objc_msgSend)(web, sel_registerName("loadRequest:"), [NSURLRequest requestWithURL:[NSURL URLWithString:url]]);
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  UIApplication.sharedApplication.idleTimerDisabled = YES;  // no screen saver mid-song
}

- (void)userContentController:(id)controller didReceiveScriptMessage:(id)message {
  NSDictionary *body = [message valueForKey:@"body"];
  if ([body isKindOfClass:NSDictionary.class] && body[@"atRoot"]) self.atRoot = [body[@"atRoot"] boolValue];
}

- (void)sendKey:(NSString *)key {
  NSString *js = [NSString stringWithFormat:@"window.__aerodanceKey && window.__aerodanceKey('%@')", key];
  ((void (*)(id, SEL, id, id))objc_msgSend)(self.web, sel_registerName("evaluateJavaScript:completionHandler:"), js, nil);
}

- (void)swiped:(UISwipeGestureRecognizer *)swipe {
  switch (swipe.direction) {
    case UISwipeGestureRecognizerDirectionUp: [self sendKey:@"ArrowUp"]; break;
    case UISwipeGestureRecognizerDirectionDown: [self sendKey:@"ArrowDown"]; break;
    case UISwipeGestureRecognizerDirectionLeft: [self sendKey:@"ArrowLeft"]; break;
    default: [self sendKey:@"ArrowRight"]; break;
  }
}

static NSString *KeyForPress(UIPressType type) {
  switch (type) {
    case UIPressTypeUpArrow: return @"ArrowUp";
    case UIPressTypeDownArrow: return @"ArrowDown";
    case UIPressTypeLeftArrow: return @"ArrowLeft";
    case UIPressTypeRightArrow: return @"ArrowRight";
    case UIPressTypeSelect: return @"Enter";
    case UIPressTypeMenu: return @"Escape";
    case UIPressTypePlayPause: return @"Escape";  // pauses a song, backs out of menus
    default: return nil;
  }
}

// Remote buttons become the game's keyboard controls. Menu on the main menu is left to the
// system, which returns to the Apple TV home screen.
- (BOOL)handles:(UIPress *)press {
  NSString *key = KeyForPress(press.type);
  return key && !(press.type == UIPressTypeMenu && self.atRoot);
}

- (void)pressesBegan:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  BOOL passOn = NO;
  for (UIPress *press in presses) { if ([self handles:press]) [self sendKey:KeyForPress(press.type)]; else passOn = YES; }
  if (passOn) [super pressesBegan:presses withEvent:event];
}

- (void)pressesEnded:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  for (UIPress *press in presses) if (![self handles:press]) { [super pressesEnded:presses withEvent:event]; return; }
}

- (void)pressesCancelled:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  for (UIPress *press in presses) if (![self handles:press]) { [super pressesCancelled:presses withEvent:event]; return; }
}

@end

#pragma mark - App

@interface SceneDelegate : UIResponder <UIWindowSceneDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation SceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [GameViewController new];
  [self.window makeKeyAndVisible];
}
@end

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation AppDelegate
- (UISceneConfiguration *)application:(UIApplication *)app configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  UISceneConfiguration *config = [[UISceneConfiguration alloc] initWithName:@"Default" sessionRole:session.role];
  config.delegateClass = SceneDelegate.class;
  return config;
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(AppDelegate.class)); }
}

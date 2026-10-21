// aerodance for Apple TV on JavaScriptCore and OpenGL ES: public APIs only. See ../README.md.
//
// The game's own JavaScript runs in JavaScriptCore (JSHost) with a small browser runtime
// (../runtime/) whose WebGL 2 and 2D canvas calls become a command stream that the executor
// (Executor, Canvas2D) runs on OpenGL ES 3.0 and CoreGraphics. This file is the app around it:
// the scene, the layer frames are shown in, and the Siri Remote.
#import <UIKit/UIKit.h>
#import "JSHost.h"

static NSDictionary *LaunchConfig() {
  NSArray *args = NSProcessInfo.processInfo.arguments;
  NSUInteger i = [args indexOfObject:@"--config"];
  NSString *json = i != NSNotFound && i + 1 < args.count ? args[i + 1] : nil;
  if (!json) json = [NSString stringWithContentsOfFile:[NSBundle.mainBundle pathForResource:@"www/config" ofType:@"json"] encoding:NSUTF8StringEncoding error:nil];
  NSDictionary *config = json ? [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil] : nil;
  return [config isKindOfClass:NSDictionary.class] ? config : @{ @"script": @"index.js" };
}

@interface GameViewController : UIViewController
@property(nonatomic, strong) JSHost *host;
/** Presses the game took when they began (Menu on the main menu goes to the system instead). */
@property(nonatomic, strong) NSMutableSet<UIPress *> *taken;
@property(nonatomic, strong) DisplayTarget *display;
@end

@implementation GameViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.blackColor;
  NSDictionary *config = LaunchConfig();
  CAEAGLLayer *layer = [CAEAGLLayer layer];
  layer.opaque = YES;
  layer.drawableProperties = @{ kEAGLDrawablePropertyRetainedBacking: @NO, kEAGLDrawablePropertyColorFormat: kEAGLColorFormatRGBA8 };
  [self.view.layer addSublayer:layer];
  self.display = [DisplayTarget new];
  self.display.layer = layer;
  self.display.screenSize = UIScreen.mainScreen.bounds.size;
  self.display.fill = [config[@"fit"] isEqual:@"fill"];
  self.display.pixelated = [config[@"pixelated"] boolValue];
  [self.display layoutForCanvasWidth:640 height:480];

  // The launch image (UILaunchScreen) stays up while the game loads, then fades out.
  UIImageView *splash = [[UIImageView alloc] initWithImage:[UIImage imageNamed:@"Launch Image"]];
  splash.frame = self.view.bounds;
  splash.contentMode = UIViewContentModeScaleAspectFill;
  [self.view addSubview:splash];
  void (^hideSplash)(void) = ^{
    [UIView animateWithDuration:0.4 animations:^{ splash.alpha = 0; } completion:^(BOOL) { [splash removeFromSuperview]; }];
  };

  self.host = [[JSHost alloc] initWithConfig:config display:self.display];
  self.host.onReady = hideSplash;
  [self.host start];
  // A page that never says it's ready (a script error while loading) isn't hidden for good.
  __weak JSHost *host = self.host;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    void (^onReady)(void) = host.onReady;
    host.onReady = nil;
    if (onReady) onReady();
  });

  // Swipes on the remote's touch surface move the menu focus like the arrow keys do.
  for (NSNumber *dir in @[ @(UISwipeGestureRecognizerDirectionUp), @(UISwipeGestureRecognizerDirectionDown),
                           @(UISwipeGestureRecognizerDirectionLeft), @(UISwipeGestureRecognizerDirectionRight) ]) {
    UISwipeGestureRecognizer *swipe = [[UISwipeGestureRecognizer alloc] initWithTarget:self action:@selector(swiped:)];
    swipe.direction = dir.unsignedIntegerValue;
    [self.view addGestureRecognizer:swipe];
  }
}

- (void)viewDidAppear:(BOOL)animated {
  [super viewDidAppear:animated];
  UIApplication.sharedApplication.idleTimerDisabled = YES;  // no screen saver mid-song
}

- (void)tap:(NSString *)key {
  [self.host sendKey:key code:key type:@"keydown" repeat:NO];
  [self.host sendKey:key code:key type:@"keyup" repeat:NO];
}

- (void)swiped:(UISwipeGestureRecognizer *)swipe {
  switch (swipe.direction) {
    case UISwipeGestureRecognizerDirectionUp: [self tap:@"ArrowUp"]; break;
    case UISwipeGestureRecognizerDirectionDown: [self tap:@"ArrowDown"]; break;
    case UISwipeGestureRecognizerDirectionLeft: [self tap:@"ArrowLeft"]; break;
    default: [self tap:@"ArrowRight"]; break;
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
  return key && !(press.type == UIPressTypeMenu && self.host.atRoot);
}

// Whether the game takes a press is decided once, when it begins, so a press that started on the
// main menu goes to the system to the end even if the menu changes meanwhile.
- (void)pressesBegan:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  if (!self.taken) self.taken = [NSMutableSet set];
  NSMutableSet *others = [NSMutableSet set];
  for (UIPress *press in presses) {
    if ([self handles:press]) {
      [self.taken addObject:press];
      [self.host sendKey:KeyForPress(press.type) code:KeyForPress(press.type) type:@"keydown" repeat:NO];
    } else [others addObject:press];
  }
  if (others.count) [super pressesBegan:others withEvent:event];
}

- (void)pressesEnded:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  NSMutableSet *others = [NSMutableSet set];
  for (UIPress *press in presses) {
    if ([self.taken containsObject:press]) {
      [self.taken removeObject:press];
      [self.host sendKey:KeyForPress(press.type) code:KeyForPress(press.type) type:@"keyup" repeat:NO];
    } else [others addObject:press];
  }
  if (others.count) [super pressesEnded:others withEvent:event];
}

- (void)pressesCancelled:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  NSMutableSet *others = [NSMutableSet set];
  for (UIPress *press in presses) {
    if ([self.taken containsObject:press]) {
      [self.taken removeObject:press];
      [self.host sendKey:KeyForPress(press.type) code:KeyForPress(press.type) type:@"keyup" repeat:NO];
    } else [others addObject:press];
  }
  if (others.count) [super pressesCancelled:others withEvent:event];
}

@end

@interface SceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation SceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [GameViewController new];
  [self.window makeKeyAndVisible];
}
- (void)sceneWillResignActive:(UIScene *)scene {
  [((GameViewController *)self.window.rootViewController).host setActive:NO];
}
- (void)sceneDidBecomeActive:(UIScene *)scene {
  [((GameViewController *)self.window.rootViewController).host setActive:YES];
}
- (void)sceneDidEnterBackground:(UIScene *)scene {
  [((GameViewController *)self.window.rootViewController).host setHidden:YES];
}
- (void)sceneWillEnterForeground:(UIScene *)scene {
  [((GameViewController *)self.window.rootViewController).host setHidden:NO];
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

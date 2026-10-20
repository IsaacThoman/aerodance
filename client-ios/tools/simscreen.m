// Mac-side test tool: lists a simulator's screens, and turns its TV-out screen on at a size,
// like Simulator.app's I/O > External Displays menu. Uses CoreSimulator private API (dev only).
// Usage: simscreen <udid> list | on <w> <h> | off
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>

static id call(id o, const char *sel) { return ((id (*)(id, SEL))objc_msgSend)(o, sel_registerName(sel)); }

static void describe(id props) {
  CGSize px = ((CGSize (*)(id, SEL))objc_msgSend)(props, sel_registerName("pixelSize"));
  unsigned sid = ((unsigned (*)(id, SEL))objc_msgSend)(props, sel_registerName("screenID"));
  int power = ((int (*)(id, SEL))objc_msgSend)(props, sel_registerName("powerState"));
  unsigned long long type = ((unsigned long long (*)(id, SEL))objc_msgSend)(props, sel_registerName("screenType"));
  printf("screen %u %s type=%llu power=%d %.0fx%.0f class=%s\n", sid, [[call(props, "name") description] UTF8String], type, power, px.width, px.height, object_getClassName(props));
  id modes = call(props, "supportedScreenModes");
  for (id m in modes) {
    unsigned long long rule = ((unsigned long long (*)(id, SEL))objc_msgSend)(m, sel_registerName("sizeRule"));
    CGSize ex = ((CGSize (*)(id, SEL))objc_msgSend)(m, sel_registerName("exactSize"));
    CGSize mn = ((CGSize (*)(id, SEL))objc_msgSend)(m, sel_registerName("minSize"));
    CGSize mx = ((CGSize (*)(id, SEL))objc_msgSend)(m, sel_registerName("maxSize"));
    printf("   mode rule=%llu exact=%.0fx%.0f min=%.0fx%.0f max=%.0fx%.0f allowed=%s\n", rule, ex.width, ex.height, mn.width, mn.height, mx.width, mx.height, [[call(m, "allowedSizes") description] UTF8String]);
  }
}

int main(int argc, char **argv) { @autoreleasepool {
  if (argc < 3) { fprintf(stderr, "usage: simscreen <udid> list|on <w> <h>|off\n"); return 2; }
  dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW);
  dlopen("/Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW);
  NSError *err = nil;
  id ctx = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(NSClassFromString(@"SimServiceContext"), sel_registerName("sharedServiceContextForDeveloperDir:error:"), @"/Applications/Xcode.app/Contents/Developer", &err);
  id set = ((id (*)(id, SEL, NSError **))objc_msgSend)(ctx, sel_registerName("defaultDeviceSetWithError:"), &err);
  id device = [call(set, "devicesByUDID") objectForKey:[[NSUUID alloc] initWithUUIDString:@(argv[1])]];
  if (!device) { fprintf(stderr, "no device %s (%s)\n", argv[1], err.description.UTF8String); return 1; }
  id adapter = nil;
  for (id port in call(call(device, "io"), "ioPorts")) {
    id d = call(port, "descriptor");
    if ([d respondsToSelector:sel_registerName("creatableScreenProperties")]) adapter = d;
  }
  if (!adapter) { fprintf(stderr, "no screen adapter\n"); return 1; }
  dispatch_queue_t q = dispatch_queue_create("simscreen", 0);
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSArray *screens = nil;
  ((void (*)(id, SEL, id, id))objc_msgSend)(adapter, sel_registerName("enumerateScreensWithCompletionQueue:completionHandler:"), q, ^(id list, NSError *e) {
    screens = list; if (e) printf("enumerate error %s\n", e.description.UTF8String); dispatch_semaphore_signal(done);
  });
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  printf("creatable: %s\n", [[call(adapter, "creatableScreenProperties") description] UTF8String]);
  NSString *cmd = @(argv[2]);
  for (id screen in screens) {
    id props = call(screen, "screenProperties");
    describe(props);
    if ([cmd isEqual:@"list"] || ![[call(props, "name") description] isEqual:@"TVOut"]) continue;
    if ([cmd isEqual:@"on"] && argc >= 5) {
      CGSize size = CGSizeMake(atof(argv[3]), atof(argv[4]));
      id mode = [call(props, "supportedScreenModes") firstObject] ?: call(props, "currentMode");
      for (id m in call(props, "supportedScreenModes")) {
        CGSize ex = ((CGSize (*)(id, SEL))objc_msgSend)(m, sel_registerName("exactSize"));
        BOOL allowed = NO;
        for (NSValue *v in call(m, "allowedSizes")) if (CGSizeEqualToSize(NSSizeToCGSize(v.sizeValue), size)) allowed = YES;
        if (allowed || CGSizeEqualToSize(ex, size)) mode = m;
      }
      ((void (*)(id, SEL, id, CGSize, id, id, id))objc_msgSend)(screen, sel_registerName("setCurrentMode:pixelSize:carPlayProperties:completionQueue:completionHandler:"), mode, size, nil, q, ^(NSError *e) {
        printf("setCurrentMode: %s\n", e ? e.description.UTF8String : "ok"); dispatch_semaphore_signal(done);
      });
      dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    }
    int power = [cmd isEqual:@"off"] ? 0 : 1;
    ((void (*)(id, SEL, int, id, id))objc_msgSend)(screen, sel_registerName("setPowerState:completionQueue:completionHandler:"), power, q, ^(NSError *e) {
      printf("setPowerState %d: %s\n", power, e ? e.description.UTF8String : "ok"); dispatch_semaphore_signal(done);
    });
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
    describe(call(screen, "screenProperties"));
  }
}}

// The JavaScript side of the host: a thread with its own run loop that owns a JavaScriptCore
// context, evaluates the runtime (../runtime/) and the app's script, and drives them from a
// CADisplayLink. Natives are plain JSC C API callbacks on globalThis.__native.
#import "JSHost.h"
#import "Renderer.h"
#import "Audio.h"
#import <JavaScriptCore/JavaScriptCore.h>
#import <CommonCrypto/CommonDigest.h>
#import <ImageIO/ImageIO.h>
#import <Security/Security.h>
#include <mach/mach_time.h>
#include <pthread.h>

// ---------------------------------------------------------------------------------------------
// Shared state

Payloads gPayloads;
FrameStats gFrameStats;

double NowMs() {
  static mach_timebase_info_data_t tb;
  static uint64_t start;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ mach_timebase_info(&tb); start = mach_absolute_time(); });
  return (double)(mach_absolute_time() - start) * tb.numer / tb.denom / 1e6;
}

static NSString *gLogUrl;
static NSMutableArray<NSString *> *gLogLines;
static std::mutex gLogLock;
void HostLog(int level, NSString *text) {
  static const char *tags[] = { "", "warn: ", "error: " };
  fprintf(stderr, "[js %.0f] %s%s\n", NowMs(), tags[std::clamp(level, 0, 2)], text.UTF8String);
  if (!gLogUrl) return;
  std::lock_guard<std::mutex> g(gLogLock);
  if (!gLogLines) gLogLines = [NSMutableArray array];
  [gLogLines addObject:[NSString stringWithFormat:@"%.0f %s%@", NowMs(), tags[std::clamp(level, 0, 2)], text]];
}
// Device logs go to the Mac (config.logUrl) twice a second.
static void FlushLogs() {
  NSArray *lines;
  {
    std::lock_guard<std::mutex> g(gLogLock);
    if (!gLogLines.count) return;
    lines = gLogLines;
    gLogLines = [NSMutableArray array];
  }
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:gLogUrl]];
  req.HTTPMethod = @"POST";
  req.HTTPBody = [[lines componentsJoinedByString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
  [[NSURLSession.sharedSession dataTaskWithRequest:req] resume];
}

int Payloads::putString(std::string s) { std::lock_guard<std::mutex> g(lock_); int h = next_++; strings_[h] = std::move(s); return h; }
std::string Payloads::takeString(int h) {
  std::lock_guard<std::mutex> g(lock_);
  auto it = strings_.find(h);
  if (it == strings_.end()) return "";
  std::string s = std::move(it->second);
  strings_.erase(it);
  return s;
}
int Payloads::putBlock(const void *bytes, size_t length) {
  std::lock_guard<std::mutex> g(lock_);
  int h = next_++;
  blocks_[h].assign((const uint8_t *)bytes, (const uint8_t *)bytes + length);
  return h;
}
std::vector<uint8_t> Payloads::takeBlock(int h) {
  std::lock_guard<std::mutex> g(lock_);
  auto it = blocks_.find(h);
  if (it == blocks_.end()) return {};
  std::vector<uint8_t> b = std::move(it->second);
  blocks_.erase(it);
  return b;
}
int Payloads::putImage(std::shared_ptr<DecodedImage> image) { std::lock_guard<std::mutex> g(lock_); int h = next_++; images_[h] = std::move(image); return h; }
std::shared_ptr<DecodedImage> Payloads::image(int h) {
  std::lock_guard<std::mutex> g(lock_);
  auto it = images_.find(h);
  return it == images_.end() ? nullptr : it->second;
}
void Payloads::releaseImage(int h) { std::lock_guard<std::mutex> g(lock_); images_.erase(h); }

static constexpr size_t kFrameRing = 4096;
void FrameStats::beginFrame(double start) {
  std::lock_guard<std::mutex> g(lock_);
  if (records_.empty()) records_.resize(kFrameRing);
  frame_++;
  records_[frame_ % kFrameRing] = FrameRecord();
  records_[frame_ % kFrameRing].start = start;
}
void FrameStats::js(double ms) { std::lock_guard<std::mutex> g(lock_); if (!records_.empty()) records_[frame_ % kFrameRing].jsMs = ms; }
void FrameStats::submitted(double ms) { std::lock_guard<std::mutex> g(lock_); if (!records_.empty()) records_[frame_ % kFrameRing].submitMs = ms; }
void FrameStats::executed(uint64_t frame, double ms, double gpuMs, int words) {
  std::lock_guard<std::mutex> g(lock_);
  if (records_.empty() || frame + kFrameRing <= frame_) return;
  FrameRecord &r = records_[frame % kFrameRing];
  r.execMs += ms; r.commands += words;
  if (gpuMs >= 0) r.gpuMs = gpuMs;
}
static NSDictionary *Stat(std::vector<double> v) {
  if (v.empty()) return @{ @"mean": [NSNull null], @"p95": [NSNull null] };
  std::sort(v.begin(), v.end());
  double sum = 0;
  for (double x : v) sum += x;
  auto r = [](double x) { return @(std::round(x * 100) / 100); };
  return @{ @"mean": r(sum / v.size()), @"p50": r(v[v.size() / 2]), @"p95": r(v[std::min(v.size() - 1, (size_t)(v.size() * 0.95))]) };
}
NSString *FrameStats::summary(double fromMs, double toMs) {
  std::lock_guard<std::mutex> g(lock_);
  std::vector<double> js, submit, exec, gpu, words, interval;
  double last = -1;
  for (uint64_t f = frame_ > kFrameRing ? frame_ - kFrameRing + 1 : 1; f <= frame_; f++) {
    const FrameRecord &r = records_[f % kFrameRing];
    if (r.start < fromMs || r.start > toMs) continue;
    js.push_back(r.jsMs); submit.push_back(r.submitMs); exec.push_back(r.execMs); words.push_back(r.commands);
    if (r.gpuMs >= 0) gpu.push_back(r.gpuMs);
    if (last >= 0) interval.push_back(r.start - last);
    last = r.start;
  }
  NSDictionary *d = @{ @"frames": @(js.size()), @"jsMs": Stat(js), @"submitMs": Stat(submit), @"execMs": Stat(exec),
                       @"gpuFinishMs": gpu.empty() ? [NSNull null] : Stat(gpu), @"wordsPerFrame": Stat(words), @"intervalMs": Stat(interval) };
  NSData *data = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

// ---------------------------------------------------------------------------------------------
// JSC helpers

static JSHost *gHost;
static bool gTypedArrayPointerIncludesOffset = false;

static NSString *ToNS(JSContextRef ctx, JSValueRef v) {
  JSStringRef s = JSValueToStringCopy(ctx, v, nullptr);
  if (!s) return @"";
  NSString *r = (__bridge_transfer NSString *)JSStringCopyCFString(kCFAllocatorDefault, s);
  JSStringRelease(s);
  return r;
}
static std::string ToUTF8(JSContextRef ctx, JSValueRef v) {
  JSStringRef s = JSValueToStringCopy(ctx, v, nullptr);
  if (!s) return "";
  size_t max = JSStringGetMaximumUTF8CStringSize(s);
  std::string out(max, '\0');
  size_t n = JSStringGetUTF8CString(s, out.data(), max);
  out.resize(n > 0 ? n - 1 : 0);
  JSStringRelease(s);
  return out;
}
static JSValueRef MakeString(JSContextRef ctx, NSString *s) {
  JSStringRef js = JSStringCreateWithCFString((__bridge CFStringRef)(s ?: @""));
  JSValueRef v = JSValueMakeString(ctx, js);
  JSStringRelease(js);
  return v;
}
/** A typed array's or ArrayBuffer's bytes. */
static uint8_t *BytesOf(JSContextRef ctx, JSValueRef v, size_t *length) {
  *length = 0;
  if (!v || !JSValueIsObject(ctx, v)) return nullptr;
  JSObjectRef o = JSValueToObject(ctx, v, nullptr);
  JSTypedArrayType t = JSValueGetTypedArrayType(ctx, v, nullptr);
  if (t == kJSTypedArrayTypeNone) return nullptr;
  if (t == kJSTypedArrayTypeArrayBuffer) {
    *length = JSObjectGetArrayBufferByteLength(ctx, o, nullptr);
    return (uint8_t *)JSObjectGetArrayBufferBytesPtr(ctx, o, nullptr);
  }
  *length = JSObjectGetTypedArrayByteLength(ctx, o, nullptr);
  uint8_t *base = (uint8_t *)JSObjectGetTypedArrayBytesPtr(ctx, o, nullptr);
  return base ? base + (gTypedArrayPointerIncludesOffset ? 0 : JSObjectGetTypedArrayByteOffset(ctx, o, nullptr)) : nullptr;
}
JSHost *CurrentHost() { return gHost; }
uint8_t *JSBytesOf(JSContextRef ctx, JSValueRef v, size_t *length) { return BytesOf(ctx, v, length); }
JSValueRef JSStringValue(JSContextRef ctx, NSString *s) { return MakeString(ctx, s); }

static JSValueRef ToJS(JSContextRef ctx, id value) {
  if (!value || value == [NSNull null]) return JSValueMakeNull(ctx);
  if ([value isKindOfClass:NSString.class]) return MakeString(ctx, value);
  if ([value isKindOfClass:NSNumber.class]) {
    if (strcmp([value objCType], @encode(BOOL)) == 0 || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return JSValueMakeBoolean(ctx, [value boolValue]);
    return JSValueMakeNumber(ctx, [value doubleValue]);
  }
  if ([value isKindOfClass:NSArray.class]) {
    // Filled in place: values held only in a C++ vector aren't seen by the garbage collector.
    JSObjectRef array = JSObjectMakeArray(ctx, 0, nullptr, nullptr);
    unsigned i = 0;
    for (id x in (NSArray *)value) JSObjectSetPropertyAtIndex(ctx, array, i++, ToJS(ctx, x), nullptr);
    return array;
  }
  return JSValueMakeUndefined(ctx);
}
static void ArrayBufferFree(void *bytes, void *context) {
  if (context) CFRelease(context); else free(bytes);
}
static JSObjectRef MakeArrayBuffer(JSContextRef ctx, NSData *data) {
  void *bytes = (void *)data.bytes;
  if (!data.length) return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, calloc(1, 1), 0, ArrayBufferFree, nullptr, nullptr);
  return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, bytes, data.length, ArrayBufferFree, (void *)CFBridgingRetain(data), nullptr);
}
static double Num(JSContextRef ctx, size_t argc, const JSValueRef argv[], size_t i, double fallback = 0) {
  if (i >= argc || JSValueIsUndefined(ctx, argv[i])) return fallback;
  return JSValueToNumber(ctx, argv[i], nullptr);
}

#define NATIVE(name) static JSValueRef name(JSContextRef ctx, JSObjectRef, JSObjectRef, size_t argc, const JSValueRef argv[], JSValueRef *exc)

// ---------------------------------------------------------------------------------------------
// Natives

NATIVE(N_submit) {
  int next = gHost.renderer->submit((int)Num(ctx, argc, argv, 0), argc > 1 && JSValueToBoolean(ctx, argv[1]));
  return JSValueMakeNumber(ctx, next);
}
NATIVE(N_block) {
  size_t len;
  uint8_t *b = BytesOf(ctx, argc ? argv[0] : nullptr, &len);
  return JSValueMakeNumber(ctx, gPayloads.putBlock(b, b ? len : 0));
}
NATIVE(N_str) { return JSValueMakeNumber(ctx, gPayloads.putString(ToUTF8(ctx, argv[0]))); }
NATIVE(N_query) {
  int kind = (int)Num(ctx, argc, argv, 0);
  double args[6];
  for (int i = 0; i < 6; i++) args[i] = Num(ctx, argc, argv, i + 1);
  if (kind == 15) {  // frame stats over the last args[0] ms
    double now = NowMs();
    return MakeString(ctx, gFrameStats.summary(now - args[0], now));
  }
  size_t outLength = 0;
  uint8_t *out = argc > 7 ? BytesOf(ctx, argv[7], &outLength) : nullptr;
  id result = nil;
  gHost.renderer->sync([&](Executor &e) { result = e.query(kind, args, out, outLength); });
  return ToJS(ctx, result);
}
NATIVE(N_font) { return JSValueMakeNumber(ctx, FontForCSS(ToUTF8(ctx, argv[0]))); }
NATIVE(N_measureText) {
  double m[8] = {};
  MeasureText((int)Num(ctx, argc, argv, 0), ToNS(ctx, argv[1]), Num(ctx, argc, argv, 2), m);
  size_t len;
  double *out = (double *)BytesOf(ctx, argv[3], &len);
  if (out && len >= 7 * sizeof(double)) memcpy(out, m, 7 * sizeof(double));
  return JSValueMakeUndefined(ctx);
}

static std::shared_ptr<DecodedImage> Decode(NSData *data, NSString **error) {
  CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)data, nullptr);
  CGImageRef img = src ? CGImageSourceCreateImageAtIndex(src, 0, (__bridge CFDictionaryRef) @{ (id)kCGImageSourceShouldCacheImmediately: @YES }) : nullptr;
  if (src) CFRelease(src);
  if (!img) { *error = @"not a decodable image"; return nullptr; }
  auto d = std::make_shared<DecodedImage>();
  d->width = (int)CGImageGetWidth(img); d->height = (int)CGImageGetHeight(img);
  d->pixels.resize((size_t)d->width * d->height * 4);
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  CGContextRef c = CGBitmapContextCreate(d->pixels.data(), d->width, d->height, 8, (size_t)d->width * 4, cs, (CGBitmapInfo)kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
  CGContextSetBlendMode(c, kCGBlendModeCopy);
  CGContextDrawImage(c, CGRectMake(0, 0, d->width, d->height), img);
  CGContextRelease(c);
  CGColorSpaceRelease(cs);
  CGImageRelease(img);
  return d;
}
NATIVE(N_decodeImage) {
  NSData *data = nil;
  NSString *path = nil;
  size_t len;
  uint8_t *b = BytesOf(ctx, argv[0], &len);
  if (b) data = [NSData dataWithBytes:b length:len];
  else path = [gHost.wwwRoot stringByAppendingPathComponent:ToNS(ctx, argv[0])];
  JSValueRef done = argv[1];
  JSValueProtect(ctx, done);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSData *bytes = data ?: [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:nil];
    NSString *error = bytes ? nil : [NSString stringWithFormat:@"no file %@", path.lastPathComponent];
    auto img = bytes ? Decode(bytes, &error) : nullptr;
    int w = img ? img->width : 0, h = img ? img->height : 0;
    int idn = img ? gPayloads.putImage(img) : 0;
    [gHost perform:^(JSGlobalContextRef c) {
      JSValueRef args[] = { JSValueMakeNumber(c, idn), JSValueMakeNumber(c, w), JSValueMakeNumber(c, h), MakeString(c, error ?: @"") };
      [gHost call:(JSObjectRef)done args:args count:4];
      JSValueUnprotect(c, done);
    }];
  });
  return JSValueMakeUndefined(ctx);
}
NATIVE(N_releaseImage) { gPayloads.releaseImage((int)Num(ctx, argc, argv, 0)); return JSValueMakeUndefined(ctx); }
NATIVE(N_readFile) {
  NSString *rel = ToNS(ctx, argv[0]);
  NSString *path = [[gHost.wwwRoot stringByAppendingPathComponent:rel] stringByStandardizingPath];
  if (![path hasPrefix:gHost.wwwRoot]) return JSValueMakeNull(ctx);
  NSData *data = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:nil];
  if (!data) return JSValueMakeNull(ctx);
  return MakeArrayBuffer(ctx, data);
}
NATIVE(N_http) {
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:ToNS(ctx, argv[1])]];
  req.HTTPMethod = ToNS(ctx, argv[0]);
  if (argc > 2 && !JSValueIsNull(ctx, argv[2])) {
    size_t len;
    uint8_t *b = BytesOf(ctx, argv[2], &len);
    req.HTTPBody = b ? [NSData dataWithBytes:b length:len] : [ToNS(ctx, argv[2]) dataUsingEncoding:NSUTF8StringEncoding];
  }
  NSDictionary *headers = [NSJSONSerialization JSONObjectWithData:[ToNS(ctx, argv[3]) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  for (NSString *k in headers) [req setValue:headers[k] forHTTPHeaderField:k];
  req.timeoutInterval = 30;
  JSValueRef done = argv[4];
  JSValueProtect(ctx, done);
  [[NSURLSession.sharedSession dataTaskWithRequest:req completionHandler:^(NSData *body, NSURLResponse *resp, NSError *error) {
    NSInteger status = error ? 0 : ((NSHTTPURLResponse *)resp).statusCode;
    NSString *meta = error ? error.localizedDescription : nil;
    if (!error) {
      NSMutableDictionary *h = [NSMutableDictionary dictionary];
      [((NSHTTPURLResponse *)resp).allHeaderFields enumerateKeysAndObjectsUsingBlock:^(id k, id v, BOOL *) { h[[k lowercaseString]] = v; }];
      meta = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:h options:0 error:nil] encoding:NSUTF8StringEncoding];
    }
    [gHost perform:^(JSGlobalContextRef c) {
      JSValueRef args[] = { JSValueMakeNumber(c, status), body && !error ? MakeArrayBuffer(c, body) : JSValueMakeNull(c), MakeString(c, meta) };
      [gHost call:(JSObjectRef)done args:args count:3];
      JSValueUnprotect(c, done);
    }];
  }] resume];
  return JSValueMakeUndefined(ctx);
}
NATIVE(N_wake) { [gHost wakeAfter:Num(ctx, argc, argv, 0)]; return JSValueMakeUndefined(ctx); }
NATIVE(N_now) { return JSValueMakeNumber(ctx, NowMs()); }
NATIVE(N_log) { HostLog((int)Num(ctx, argc, argv, 0), ToNS(ctx, argv[1])); return JSValueMakeUndefined(ctx); }

static NSString *const kStorageKey = @"aerodance.localStorage";
NATIVE(N_storageGet) {
  NSString *v = [NSUserDefaults.standardUserDefaults dictionaryForKey:kStorageKey][ToNS(ctx, argv[0])];
  return v ? MakeString(ctx, v) : JSValueMakeNull(ctx);
}
NATIVE(N_storageSet) {
  NSMutableDictionary *d = [[NSUserDefaults.standardUserDefaults dictionaryForKey:kStorageKey] mutableCopy] ?: [NSMutableDictionary dictionary];
  NSString *k = ToNS(ctx, argv[0]);
  if (argc < 2 || JSValueIsNull(ctx, argv[1])) [d removeObjectForKey:k]; else d[k] = ToNS(ctx, argv[1]);
  [NSUserDefaults.standardUserDefaults setObject:d forKey:kStorageKey];
  return JSValueMakeUndefined(ctx);
}
NATIVE(N_storageKeys) {
  NSArray *keys = [NSUserDefaults.standardUserDefaults dictionaryForKey:kStorageKey].allKeys ?: @[];
  return MakeString(ctx, [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:keys options:0 error:nil] encoding:NSUTF8StringEncoding]);
}
NATIVE(N_digest) {
  int alg = (int)Num(ctx, argc, argv, 0);
  size_t len;
  uint8_t *b = BytesOf(ctx, argv[1], &len);
  NSMutableData *out = [NSMutableData dataWithLength:alg == 1 ? CC_SHA1_DIGEST_LENGTH : alg == 384 ? CC_SHA384_DIGEST_LENGTH : alg == 512 ? CC_SHA512_DIGEST_LENGTH : CC_SHA256_DIGEST_LENGTH];
  const void *data = b ? (const void *)b : (const void *)"";
  CC_LONG n = (CC_LONG)(b ? len : 0);
  if (alg == 1) CC_SHA1(data, n, (unsigned char *)out.mutableBytes);
  else if (alg == 384) CC_SHA384(data, n, (unsigned char *)out.mutableBytes);
  else if (alg == 512) CC_SHA512(data, n, (unsigned char *)out.mutableBytes);
  else CC_SHA256(data, n, (unsigned char *)out.mutableBytes);
  return MakeArrayBuffer(ctx, out);
}
NATIVE(N_randomBytes) {
  size_t len;
  uint8_t *b = BytesOf(ctx, argv[0], &len);
  if (b) arc4random_buf(b, len);
  return JSValueMakeUndefined(ctx);
}
NATIVE(N_setAtRoot) {
  BOOL atRoot = argc && JSValueToBoolean(ctx, argv[0]);
  dispatch_async(dispatch_get_main_queue(), ^{ gHost.atRoot = atRoot; });
  return JSValueMakeUndefined(ctx);
}
NATIVE(N_audio) { return AudioNative(ctx, argc, argv); }
// For the bridge microbenchmark (client-tvos/jsc/bench/bridgeBench.ts).
NATIVE(N_noop) { return JSValueMakeUndefined(ctx); }
NATIVE(N_noop4) {
  double s = 0;
  for (size_t i = 0; i < argc && i < 4; i++) s += JSValueToNumber(ctx, argv[i], nullptr);
  (void)s;
  return JSValueMakeUndefined(ctx);
}

// ---------------------------------------------------------------------------------------------
// The host

@interface JSHost ()
@property(nonatomic) JSGlobalContextRef context;
@property(nonatomic) JSObjectRef hostObject;
@property(nonatomic) CFRunLoopRef runLoop;
@property(nonatomic) CFRunLoopTimerRef timer;
@property(nonatomic, strong) CADisplayLink *displayLink;
@property(nonatomic, strong) NSDictionary *config;
@property(nonatomic, strong) DisplayTarget *display;
@end

@implementation JSHost {
  std::unique_ptr<Renderer> _renderer;
}

- (Renderer *)renderer { return _renderer.get(); }

- (instancetype)initWithConfig:(NSDictionary *)config display:(DisplayTarget *)display {
  if ((self = [super init])) {
    _config = config;
    _display = display;
    _wwwRoot = [[NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"www"] stringByStandardizingPath];
    gHost = self;
    if ([config[@"logUrl"] length]) gLogUrl = config[@"logUrl"];
  }
  return self;
}

- (void)start {
  NSThread *t = [[NSThread alloc] initWithTarget:self selector:@selector(threadMain) object:nil];
  t.name = @"aerodance.js";
  t.qualityOfService = NSQualityOfServiceUserInteractive;
  t.stackSize = 16 << 20;
  [t start];
}

- (void)perform:(void (^)(JSGlobalContextRef ctx))block {
  CFRunLoopPerformBlock(self.runLoop, kCFRunLoopCommonModes, ^{ @autoreleasepool { block(self.context); } });
  CFRunLoopWakeUp(self.runLoop);
}

- (JSValueRef)call:(JSObjectRef)fn args:(const JSValueRef *)args count:(size_t)count {
  if (!fn) return nullptr;
  JSValueRef exc = nullptr;
  JSValueRef r = JSObjectCallAsFunction(self.context, fn, nullptr, count, args, &exc);
  if (exc) [self reportException:exc];
  return r;
}

- (JSObjectRef)hostFunction:(const char *)name {
  JSStringRef s = JSStringCreateWithUTF8CString(name);
  JSValueRef v = JSObjectGetProperty(self.context, self.hostObject, s, nullptr);
  JSStringRelease(s);
  return v && JSValueIsObject(self.context, v) ? (JSObjectRef)v : nullptr;
}

- (void)callHost:(const char *)name args:(const JSValueRef *)args count:(size_t)count {
  [self call:[self hostFunction:name] args:args count:count];
}

- (void)reportException:(JSValueRef)exc {
  JSContextRef ctx = self.context;
  NSString *msg = ToNS(ctx, exc);
  if (JSValueIsObject(ctx, exc)) {
    JSStringRef s = JSStringCreateWithUTF8CString("stack");
    JSValueRef stack = JSObjectGetProperty(ctx, (JSObjectRef)exc, s, nullptr);
    JSStringRelease(s);
    if (stack && !JSValueIsUndefined(ctx, stack)) msg = [msg stringByAppendingFormat:@"\n%@", ToNS(ctx, stack)];
  }
  HostLog(2, [@"Uncaught " stringByAppendingString:msg]);
}

- (BOOL)evaluateFile:(NSString *)rel {
  NSString *path = [self.wwwRoot stringByAppendingPathComponent:rel];
  NSString *source = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
  if (!source) { HostLog(2, [NSString stringWithFormat:@"can't read %@", rel]); return NO; }
  return [self evaluate:source url:rel];
}

- (BOOL)evaluate:(NSString *)source url:(NSString *)url {
  JSStringRef js = JSStringCreateWithCFString((__bridge CFStringRef)source);
  JSStringRef jsUrl = JSStringCreateWithCFString((__bridge CFStringRef)url);
  JSValueRef exc = nullptr;
  double t = NowMs();
  JSEvaluateScript(self.context, js, nullptr, jsUrl, 1, &exc);
  JSStringRelease(js);
  JSStringRelease(jsUrl);
  HostLog(0, [NSString stringWithFormat:@"evaluated %@ in %.0f ms", url, NowMs() - t]);
  if (exc) { [self reportException:exc]; return NO; }
  return YES;
}

static void Define(JSContextRef ctx, JSObjectRef obj, const char *name, JSValueRef value) {
  JSStringRef s = JSStringCreateWithUTF8CString(name);
  JSObjectSetProperty(ctx, obj, s, value, kJSPropertyAttributeNone, nullptr);
  JSStringRelease(s);
}

- (void)installNatives {
  JSGlobalContextRef ctx = self.context;
  JSObjectRef native = JSObjectMake(ctx, nullptr, nullptr);
  struct { const char *name; JSObjectCallAsFunctionCallback fn; } fns[] = {
    { "submit", N_submit }, { "block", N_block }, { "str", N_str }, { "query", N_query }, { "font", N_font },
    { "measureText", N_measureText }, { "decodeImage", N_decodeImage }, { "releaseImage", N_releaseImage },
    { "readFile", N_readFile }, { "http", N_http }, { "wake", N_wake }, { "now", N_now }, { "log", N_log },
    { "storageGet", N_storageGet }, { "storageSet", N_storageSet }, { "storageKeys", N_storageKeys },
    { "digest", N_digest }, { "randomBytes", N_randomBytes }, { "setAtRoot", N_setAtRoot }, { "audio", N_audio },
    { "noop", N_noop }, { "noop4", N_noop4 },
  };
  for (auto &f : fns) {
    JSStringRef s = JSStringCreateWithUTF8CString(f.name);
    Define(ctx, native, f.name, JSObjectMakeFunctionWithCallback(ctx, s, f.fn));
    JSStringRelease(s);
  }
  Define(ctx, native, "mode", JSValueMakeNumber(ctx, _renderer->mode()));
  // The renderer owns this memory for the app's lifetime. Each buffer goes into the array as
  // it's made: creating the next one can collect garbage, and a buffer held only here would go.
  JSObjectRef buffers = JSObjectMakeArray(ctx, 0, nullptr, nullptr);
  Define(ctx, native, "buffers", buffers);
  for (int i = 0; i < Renderer::kBuffers; i++) {
    JSObjectRef b = JSObjectMakeArrayBufferWithBytesNoCopy(ctx, _renderer->buffer(i), Renderer::kBufferBytes, nullptr, nullptr, nullptr);
    JSObjectSetPropertyAtIndex(ctx, buffers, i, b, nullptr);
  }
  NSData *json = [NSJSONSerialization dataWithJSONObject:self.config options:0 error:nil];
  Define(ctx, native, "config", MakeString(ctx, [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]));
  Define(ctx, JSContextGetGlobalObject(ctx), "__native", native);

  // Does JSObjectGetTypedArrayBytesPtr point at the view or at its buffer?
  JSValueRef exc = nullptr;
  JSStringRef probe = JSStringCreateWithUTF8CString("(() => { const b = new Uint8Array(8); b[3] = 77; return new Uint8Array(b.buffer, 3, 2); })()");
  JSValueRef view = JSEvaluateScript(ctx, probe, nullptr, nullptr, 1, &exc);
  JSStringRelease(probe);
  uint8_t *p = (uint8_t *)JSObjectGetTypedArrayBytesPtr(ctx, (JSObjectRef)view, nullptr);
  gTypedArrayPointerIncludesOffset = p && p[0] == 77;
}

- (void)threadMain {
  pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
  self.runLoop = CFRunLoopGetCurrent();
  NSDictionary *c = self.config;
  int mode = c[@"mode"] ? [c[@"mode"] intValue] : 2;
  _renderer = std::make_unique<Renderer>(mode, self.display, [c[@"gpuTiming"] boolValue], [c[@"glDebug"] boolValue]);
  RegisterBundledFonts([self.wwwRoot stringByAppendingPathComponent:@"fonts"]);
  JSContextGroupRef group = JSContextGroupCreate();
  self.context = JSGlobalContextCreateInGroup(group, nullptr);
  [self installNatives];
  HostLog(0, [NSString stringWithFormat:@"mode %d (%@), script %@", mode, mode == 0 ? @"direct" : mode == 1 ? @"batched" : @"threaded", c[@"script"]]);

  if ([self evaluateFile:@"runtime.js"]) {
    JSStringRef s = JSStringCreateWithUTF8CString("__host");
    self.hostObject = (JSObjectRef)JSObjectGetProperty(self.context, JSContextGetGlobalObject(self.context), s, nullptr);
    JSStringRelease(s);
    JSValueProtect(self.context, self.hostObject);
    [self evaluateFile:c[@"script"] ?: @"index.js"];
  }

  self.displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(tick:)];
  self.displayLink.preferredFrameRateRange = CAFrameRateRangeMake(60, 60, 60);
  [self.displayLink addToRunLoop:NSRunLoop.currentRunLoop forMode:NSRunLoopCommonModes];
  if (gLogUrl) [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *) { FlushLogs(); }];
  for (;;) @autoreleasepool { [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:NSDate.distantFuture]; }
}

- (void)tick:(CADisplayLink *)link {
  if (!self.hostObject) return;
  // Like a browser that's GPU-bound: no new frame while two are still on their way to the screen.
  if (_renderer->framesInFlight() >= 2) return;
  JSGlobalContextRef ctx = self.context;
  JSValueRef has = [self call:[self hostFunction:"hasFrameCallbacks"] args:nullptr count:0];
  bool frame = has && JSValueToBoolean(ctx, has);
  double t0 = NowMs();
  if (frame) {
    gFrameStats.beginFrame(t0);
    JSValueRef ts = JSValueMakeNumber(ctx, t0);
    [self callHost:"frame" args:&ts count:1];
  }
  double t1 = NowMs();
  [self callHost:"endFrame" args:nullptr count:0];
  if (frame) { gFrameStats.js(t1 - t0); gFrameStats.submitted(NowMs() - t1); }
}

- (void)wakeAfter:(double)ms {
  if (self.timer) { CFRunLoopTimerInvalidate(self.timer); CFRelease(self.timer); }
  __weak JSHost *weakSelf = self;
  self.timer = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + ms / 1000.0, 0, 0, 0, ^(CFRunLoopTimerRef) {
    JSHost *host = weakSelf;
    if (!host) return;
    CFRelease(host.timer);
    host.timer = nullptr;
    @autoreleasepool { [host callHost:"timers" args:nullptr count:0]; }
  });
  CFRunLoopAddTimer(self.runLoop, self.timer, kCFRunLoopCommonModes);
}

- (void)sendKey:(NSString *)key code:(NSString *)code type:(NSString *)type repeat:(BOOL)repeat {
  [self perform:^(JSGlobalContextRef ctx) {
    JSValueRef args[] = { MakeString(ctx, type), MakeString(ctx, key), MakeString(ctx, code), JSValueMakeBoolean(ctx, repeat) };
    [self callHost:"key" args:args count:4];
  }];
}

- (void)setHidden:(BOOL)hidden {
  [self perform:^(JSGlobalContextRef ctx) {
    JSValueRef arg = JSValueMakeBoolean(ctx, hidden);
    [self callHost:"visibility" args:&arg count:1];
  }];
}

@end

// ---------------------------------------------------------------------------------------------
// Display

@implementation DisplayTarget
- (void)layoutForCanvasWidth:(int)w height:(int)h {
  CGSize screen = self.screenSize;
  CGFloat sx = screen.width / w, sy = screen.height / h;
  if (!self.fill) sx = sy = std::min(sx, sy);
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  self.layer.contentsScale = 1;
  self.layer.bounds = CGRectMake(0, 0, w, h);
  self.layer.position = CGPointMake(screen.width / 2, screen.height / 2);
  self.layer.transform = CATransform3DMakeScale(sx, sy, 1);
  self.layer.magnificationFilter = self.pixelated ? kCAFilterNearest : kCAFilterLinear;
  [CATransaction commit];
}
@end

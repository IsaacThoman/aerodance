// WebSocket and EventSource for the runtime (../runtime/net.ts), on URLSession: a WebSocket is a
// URLSessionWebSocketTask, an event stream a data task whose bytes are handed over as they
// arrive. Every event goes to the connection's JavaScript callback on the JavaScript thread:
//
//   socket  'open' · 'text' (string) · 'binary' (ArrayBuffer) · 'sent' (bytes) · 'close' (code, reason)
//   stream  'response' (status, content type) · 'data' (ArrayBuffer) · 'end' (error message, or '')
#import "Net.h"
#import "JSHost.h"
#import <Foundation/Foundation.h>

namespace {
enum Command { kSocketOpen = 1, kSocketSend = 2, kSocketClose = 3, kStreamOpen = 4, kStreamClose = 5 };
}

@interface NetConnection : NSObject
@property(nonatomic) int ident;
@property(nonatomic, strong) NSURLSessionTask *task;
/** The JavaScript callback, protected while the connection lives (released on the JS thread). */
@property(nonatomic) JSObjectRef callback;
@property(nonatomic) BOOL socket;
/** No more events: closed from JavaScript, or ended. */
@property(atomic) BOOL finished;
@end
@implementation NetConnection
@end

@interface NetDelegate : NSObject <NSURLSessionDataDelegate, NSURLSessionWebSocketDelegate>
@end

static NSURLSession *gSession;
static NSMutableDictionary<NSNumber *, NetConnection *> *gConnections;  // by id; touched on the JS thread
static NSMapTable<NSURLSessionTask *, NetConnection *> *gByTask;      // guarded by @synchronized(gByTask)
static int gNextId = 1;

static NSString *ToNSString(JSContextRef ctx, JSValueRef v) {
  JSStringRef s = JSValueToStringCopy(ctx, v, nullptr);
  if (!s) return @"";
  NSString *out = (__bridge_transfer NSString *)JSStringCopyCFString(kCFAllocatorDefault, s);
  JSStringRelease(s);
  return out;
}
static void FreeData(void *bytes, void *context) { if (context) CFRelease(context); else free(bytes); }
static JSValueRef ArrayBufferOf(JSContextRef ctx, NSData *data) {
  if (!data.length) return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, calloc(1, 1), 0, FreeData, nullptr, nullptr);
  return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, (void *)data.bytes, data.length, FreeData, (void *)CFBridgingRetain(data), nullptr);
}
static NetConnection *ConnectionFor(NSURLSessionTask *task) {
  @synchronized(gByTask) { return [gByTask objectForKey:task]; }
}

/** Calls the connection's callback with an event on the JavaScript thread (unless it has finished). */
static void Emit(NetConnection *c, NSString *kind, id a = nil, id b = nil, BOOL last = NO) {
  if (!c || c.finished) return;
  if (last) c.finished = YES;
  [CurrentHost() perform:^(JSGlobalContextRef ctx) {
    if (!c.callback) return;
    auto value = [&](id v) -> JSValueRef {
      if (!v) return JSValueMakeUndefined(ctx);
      if ([v isKindOfClass:NSData.class]) return ArrayBufferOf(ctx, v);
      if ([v isKindOfClass:NSNumber.class]) return JSValueMakeNumber(ctx, [v doubleValue]);
      return JSStringValue(ctx, v);
    };
    JSValueRef args[] = { JSStringValue(ctx, kind), value(a), value(b) };
    [CurrentHost() call:c.callback args:args count:3];
    if (last) {
      JSValueUnprotect(ctx, c.callback);
      c.callback = nullptr;
      [gConnections removeObjectForKey:@(c.ident)];
      @synchronized(gByTask) { [gByTask removeObjectForKey:c.task]; }
    }
  }];
}

static void Receive(NetConnection *c) {
  NSURLSessionWebSocketTask *ws = (NSURLSessionWebSocketTask *)c.task;
  [ws receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
    if (error || !message) return;  // The close comes through the delegate.
    if (message.type == NSURLSessionWebSocketMessageTypeString) Emit(c, @"text", message.string);
    else Emit(c, @"binary", message.data);
    Receive(c);
  }];
}

@implementation NetDelegate
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)task didOpenWithProtocol:(NSString *)protocol {
  NetConnection *c = ConnectionFor(task);
  Emit(c, @"open");
  if (c) Receive(c);
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)task didCloseWithCode:(NSURLSessionWebSocketCloseCode)code reason:(NSData *)reason {
  NSString *text = reason ? [[NSString alloc] initWithData:reason encoding:NSUTF8StringEncoding] : @"";
  Emit(ConnectionFor(task), @"close", @(code), text ?: @"", YES);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveResponse:(NSURLResponse *)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
  NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
  Emit(ConnectionFor(task), @"response", @(http.statusCode), http.allHeaderFields[@"Content-Type"] ?: @"");
  completionHandler(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  Emit(ConnectionFor(task), @"data", [data copy]);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  NetConnection *c = ConnectionFor(task);
  if (!c) return;
  // A socket that never opened (refused) or dropped without a close frame: 1006, as in a browser.
  if (c.socket) Emit(c, @"close", @(1006), error.localizedDescription ?: @"", YES);
  else Emit(c, @"end", error ? (error.localizedDescription ?: @"failed") : @"", nil, YES);
}
@end

static NetConnection *Open(JSContextRef ctx, NSURLSessionTask *task, JSValueRef callback, BOOL socket) {
  NetConnection *c = [NetConnection new];
  c.ident = gNextId++;
  c.task = task;
  c.socket = socket;
  c.callback = JSValueToObject(ctx, callback, nullptr);
  JSValueProtect(ctx, c.callback);
  gConnections[@(c.ident)] = c;
  @synchronized(gByTask) { [gByTask setObject:c forKey:task]; }
  [task resume];
  return c;
}

JSValueRef NetNative(JSContextRef ctx, size_t argc, const JSValueRef argv[]) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSURLSessionConfiguration *config = NSURLSessionConfiguration.defaultSessionConfiguration;
    // Event streams stay open for hours; the server's heartbeats keep them from idling out.
    config.timeoutIntervalForRequest = 120;
    config.timeoutIntervalForResource = 24 * 60 * 60;
    config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    NSOperationQueue *queue = [NSOperationQueue new];
    queue.maxConcurrentOperationCount = 1;
    gSession = [NSURLSession sessionWithConfiguration:config delegate:[NetDelegate new] delegateQueue:queue];
    gConnections = [NSMutableDictionary dictionary];
    gByTask = [NSMapTable strongToStrongObjectsMapTable];
  });
  if (argc < 1) return JSValueMakeUndefined(ctx);
  int command = (int)JSValueToNumber(ctx, argv[0], nullptr);
  auto arg = [&](size_t i) { return i < argc ? argv[i] : JSValueMakeUndefined(ctx); };
  NetConnection *c = command == kSocketOpen || command == kStreamOpen ? nil : gConnections[@((int)JSValueToNumber(ctx, arg(1), nullptr))];
  switch (command) {
    case kSocketOpen: {
      NSURL *url = [NSURL URLWithString:ToNSString(ctx, arg(1))];
      if (!url) return JSValueMakeNumber(ctx, 0);
      NSURLSessionWebSocketTask *task = [gSession webSocketTaskWithURL:url];
      task.maximumMessageSize = 1 << 20;
      return JSValueMakeNumber(ctx, Open(ctx, task, arg(2), YES).ident);
    }
    case kSocketSend: {
      if (!c || c.finished) break;
      size_t length = 0;
      uint8_t *bytes = JSBytesOf(ctx, arg(2), &length);
      NSURLSessionWebSocketMessage *message = bytes ? [[NSURLSessionWebSocketMessage alloc] initWithData:[NSData dataWithBytes:bytes length:length]]
                                                    : [[NSURLSessionWebSocketMessage alloc] initWithString:ToNSString(ctx, arg(2))];
      NSUInteger size = bytes ? length : [message.string lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
      [(NSURLSessionWebSocketTask *)c.task sendMessage:message completionHandler:^(NSError *) { Emit(c, @"sent", @(size)); }];
      break;
    }
    case kSocketClose: {
      if (!c || c.finished) break;
      int code = (int)JSValueToNumber(ctx, arg(2), nullptr);
      NSData *reason = [ToNSString(ctx, arg(3)) dataUsingEncoding:NSUTF8StringEncoding];
      [(NSURLSessionWebSocketTask *)c.task cancelWithCloseCode:(NSURLSessionWebSocketCloseCode)(code ?: 1000) reason:reason.length ? reason : nil];
      break;
    }
    case kStreamOpen: {
      NSURL *url = [NSURL URLWithString:ToNSString(ctx, arg(1))];
      if (!url) return JSValueMakeNumber(ctx, 0);
      NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
      NSDictionary *headers = [NSJSONSerialization JSONObjectWithData:[ToNSString(ctx, arg(2)) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
      for (NSString *k in headers) [request setValue:[headers[k] description] forHTTPHeaderField:k];
      return JSValueMakeNumber(ctx, Open(ctx, [gSession dataTaskWithRequest:request], arg(3), NO).ident);
    }
    case kStreamClose: {
      if (!c) break;
      // Closed from JavaScript: no more events, and the callback goes once the task has ended.
      [c.task cancel];
      break;
    }
  }
  return JSValueMakeUndefined(ctx);
}

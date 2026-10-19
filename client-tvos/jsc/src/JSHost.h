// The JavaScript thread: JavaScriptCore context, natives, display link and timers.
#pragma once
#import "Host.h"
#import <JavaScriptCore/JavaScriptCore.h>

class Renderer;

@interface JSHost : NSObject
@property(nonatomic, readonly) NSString *wwwRoot;
@property(nonatomic, readonly) Renderer *renderer;
/** The page is on its top-level menu (the Menu button then leaves the app). Main thread. */
@property(atomic) BOOL atRoot;
- (instancetype)initWithConfig:(NSDictionary *)config display:(DisplayTarget *)display;
- (void)start;
/** Runs a block on the JavaScript thread. Any thread. */
- (void)perform:(void (^)(JSGlobalContextRef ctx))block;
- (JSValueRef)call:(JSObjectRef)fn args:(const JSValueRef *)args count:(size_t)count;
- (void)wakeAfter:(double)ms;
- (void)sendKey:(NSString *)key code:(NSString *)code type:(NSString *)type repeat:(BOOL)repeat;
- (void)setHidden:(BOOL)hidden;
@end

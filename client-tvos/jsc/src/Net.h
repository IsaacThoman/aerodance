// WebSocket and EventSource's native half: URLSession tasks (../runtime/net.ts).
#pragma once
#import <JavaScriptCore/JavaScriptCore.h>

/** net(command, ...args): see NetCommand in ../runtime/net.ts. */
JSValueRef NetNative(JSContextRef ctx, size_t argc, const JSValueRef argv[]);

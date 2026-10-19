#import "Audio.h"
#import "Host.h"

JSValueRef AudioNative(JSContextRef ctx, size_t argc, const JSValueRef argv[]) {
  (void)argc; (void)argv;
  return JSValueMakeUndefined(ctx);
}

// Web Audio's native half: a mixer graph rendered by AVAudioEngine (../runtime/audio.ts).
#pragma once
#import <JavaScriptCore/JavaScriptCore.h>

JSValueRef AudioNative(JSContextRef ctx, size_t argc, const JSValueRef argv[]);

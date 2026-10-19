// Web Audio's native half (../runtime/audio.ts): a small mixer graph of gain nodes, buffer
// sources and a pass-through compressor, rendered by an AVAudioSourceNode. Parameter automation
// is evaluated per sample with the same rules as AudioParam.value in the runtime.
#import "Audio.h"
#import "JSHost.h"
#import <AVFAudio/AVFAudio.h>
#include <cmath>
#include <os/lock.h>
#include <mach/mach_time.h>

namespace {
enum { C_INIT = 1, C_TIME, C_CREATE, C_CONNECT, C_DISCONNECT, C_PARAM, C_START, C_STOP, C_DECODE, C_TIMESTAMP, C_LATENCY, C_SUSPEND, C_RESUME, C_CREATE_BUFFER, C_RELEASE };
enum { N_DESTINATION = 0, N_GAIN, N_SOURCE, N_COMPRESSOR };
enum { E_VALUE = 0, E_SET, E_LINEAR, E_EXPONENTIAL, E_TARGET, E_CANCEL };

struct ABuffer {
  int channels = 0;
  int64_t frames = 0;
  double rate = 48000;
  std::vector<float *> data;
  ~ABuffer() { for (float *p : data) free(p); }
};
struct Event { int type; double value, time, tc; };
struct Param {
  double intrinsic = 1;
  std::vector<Event> events;
  double valueAt(double t) const {
    double v = intrinsic, vt = 0;
    for (size_t i = 0; i < events.size(); i++) {
      const Event &e = events[i];
      if (e.time > t) {
        if (e.type == E_LINEAR) return v + (e.value - v) * (t - vt) / std::max(1e-9, e.time - vt);
        if (e.type == E_EXPONENTIAL && v * e.value > 0) return v * pow(e.value / v, (t - vt) / std::max(1e-9, e.time - vt));
        return v;
      }
      if (e.type == E_TARGET) {
        double until = i + 1 < events.size() && events[i + 1].time <= t ? events[i + 1].time : t;
        v = e.value + (v - e.value) * exp(-(until - e.time) / std::max(1e-9, e.tc));
      } else v = e.value;
      vt = e.time;
    }
    return v;
  }
};
struct Node {
  int type = N_GAIN;
  std::vector<int> inputs;
  Param params[5];
  std::shared_ptr<ABuffer> buffer;
  double when = 0, offset = 0, duration = -1, stopAt = -1, pos = 0, played = 0;
  bool loop = false, started = false, playing = false, done = false;
  std::vector<float> L, R;
  uint64_t block = 0;
};

os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;
std::unordered_map<int, Node> gNodes;
std::unordered_map<int, std::weak_ptr<ABuffer>> gBuffers;
int gNextBuffer = 1;
double gRate = 48000;
int64_t gFrames = 0;
uint64_t gBlock = 0;
bool gRunning = true;
double gStampContext = 0, gStampPerf = 0, gLatency = 0;
AVAudioEngine *gEngine;
AVAudioSourceNode *gSourceNode;
dispatch_queue_t gEvents;

double HostMs(uint64_t host) {
  static mach_timebase_info_data_t tb;
  if (!tb.denom) mach_timebase_info(&tb);
  // NowMs() is mach time since launch; convert host ticks the same way.
  double nowTicks = (double)mach_absolute_time();
  return NowMs() - (nowTicks - (double)host) * tb.numer / tb.denom / 1e6;
}

void Render(int id, int n, double t0, std::vector<int> &ended);
void Mix(Node &node, int n, double t0, std::vector<int> &ended) {
  for (int in : node.inputs) {
    auto it = gNodes.find(in);
    if (it == gNodes.end()) continue;
    Render(in, n, t0, ended);
    Node &src = it->second;
    for (int i = 0; i < n; i++) { node.L[i] += src.L[i]; node.R[i] += src.R[i]; }
  }
}

void Render(int id, int n, double t0, std::vector<int> &ended) {
  Node &node = gNodes[id];
  if (node.block == gBlock) return;
  node.block = gBlock;
  node.L.assign(n, 0); node.R.assign(n, 0);
  const double dt = 1 / gRate;
  switch (node.type) {
    case N_DESTINATION: case N_COMPRESSOR: Mix(node, n, t0, ended); break;
    case N_GAIN: {
      Mix(node, n, t0, ended);
      const Param &g = node.params[0];
      if (g.events.empty()) { float k = g.intrinsic; for (int i = 0; i < n; i++) { node.L[i] *= k; node.R[i] *= k; } }
      else for (int i = 0; i < n; i++) { float k = g.valueAt(t0 + i * dt); node.L[i] *= k; node.R[i] *= k; }
      break;
    }
    case N_SOURCE: {
      ABuffer *b = node.buffer.get();
      if (!node.started || node.done || !b || !b->frames) break;
      double step = b->rate / gRate * node.params[0].valueAt(t0);
      for (int i = 0; i < n; i++) {
        double t = t0 + i * dt;
        if (t < node.when) continue;
        if (node.stopAt >= 0 && t >= node.stopAt) { node.done = true; break; }
        if (!node.playing) { node.playing = true; node.pos = node.offset * b->rate; }
        if (node.duration >= 0 && node.played >= node.duration * b->rate) { node.done = true; break; }
        if (node.pos >= b->frames) {
          if (node.loop) node.pos = fmod(node.pos, (double)b->frames);
          else { node.done = true; break; }
        }
        int64_t k = (int64_t)node.pos;
        float f = (float)(node.pos - k);
        int64_t k1 = std::min(k + 1, b->frames - 1);
        const float *c0 = b->data[0], *c1 = b->data[b->channels > 1 ? 1 : 0];
        node.L[i] = c0[k] + (c0[k1] - c0[k]) * f;
        node.R[i] = c1[k] + (c1[k1] - c1[k]) * f;
        node.pos += step;
        node.played += step;
      }
      if (node.done) { ended.push_back(id); node.buffer.reset(); }
      break;
    }
  }
}

OSStatus RenderBlock(BOOL *silence, const AudioTimeStamp *ts, AVAudioFrameCount frames, AudioBufferList *out) {
  float *L = (float *)out->mBuffers[0].mData, *R = out->mNumberBuffers > 1 ? (float *)out->mBuffers[1].mData : nullptr;
  std::vector<int> ended;
  os_unfair_lock_lock(&gLock);
  if (!gRunning || !gNodes.count(0)) {
    os_unfair_lock_unlock(&gLock);
    memset(L, 0, frames * sizeof(float));
    if (R) memset(R, 0, frames * sizeof(float));
    *silence = YES;
    return noErr;
  }
  double t0 = gFrames / gRate;
  if (ts->mFlags & kAudioTimeStampHostTimeValid) { gStampContext = t0; gStampPerf = HostMs(ts->mHostTime) + gLatency * 1000; }
  gBlock++;
  Render(0, (int)frames, t0, ended);
  Node &dest = gNodes[0];
  for (AVAudioFrameCount i = 0; i < frames; i++) {
    // The mixer's limiter stands in for the compressor: hard clip at full scale.
    L[i] = std::clamp(dest.L[i], -1.f, 1.f);
    if (R) R[i] = std::clamp(dest.R[i], -1.f, 1.f);
  }
  gFrames += frames;
  os_unfair_lock_unlock(&gLock);
  if (!ended.empty()) {
    dispatch_async(gEvents, ^{
      [CurrentHost() perform:^(JSGlobalContextRef ctx) {
        for (int id : ended) {
          JSValueRef arg = JSValueMakeNumber(ctx, id);
          [CurrentHost() callHost:"audioEnded" args:&arg count:1];
        }
      }];
    });
  }
  return noErr;
}

void Start() {
  if (gEngine) return;
  gEvents = dispatch_queue_create("aerodance.audio.events", DISPATCH_QUEUE_SERIAL);
  AVAudioSession *session = AVAudioSession.sharedInstance;
  [session setCategory:AVAudioSessionCategoryPlayback error:nil];
  [session setActive:YES error:nil];
  gRate = session.sampleRate > 0 ? session.sampleRate : 48000;
  gLatency = session.outputLatency + session.IOBufferDuration;
  gEngine = [AVAudioEngine new];
  AVAudioFormat *format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:gRate channels:2];
  gSourceNode = [[AVAudioSourceNode alloc] initWithFormat:format renderBlock:^OSStatus(BOOL *silence, const AudioTimeStamp *ts, AVAudioFrameCount frames, AudioBufferList *out) {
    return RenderBlock(silence, ts, frames, out);
  }];
  [gEngine attachNode:gSourceNode];
  [gEngine connect:gSourceNode to:gEngine.mainMixerNode format:format];
  NSError *error = nil;
  if (![gEngine startAndReturnError:&error]) HostLog(2, [NSString stringWithFormat:@"audio engine: %@", error]);
  os_unfair_lock_lock(&gLock);
  gNodes[0].type = N_DESTINATION;
  os_unfair_lock_unlock(&gLock);
  HostLog(0, [NSString stringWithFormat:@"audio %.0f Hz, output latency %.0f ms", gRate, gLatency * 1000]);
}

void FreeChannel(void *, void *context) { delete (std::shared_ptr<ABuffer> *)context; }

/** [id, channel ArrayBuffers...]: the JavaScript arrays share the mixer's memory. */
JSObjectRef BufferArrays(JSContextRef ctx, const std::shared_ptr<ABuffer> &b, int id, bool withId) {
  JSObjectRef array = JSObjectMakeArray(ctx, 0, nullptr, nullptr);
  unsigned i = 0;
  if (withId) JSObjectSetPropertyAtIndex(ctx, array, i++, JSValueMakeNumber(ctx, id), nullptr);
  for (int c = 0; c < b->channels; c++) {
    JSObjectRef ab = JSObjectMakeArrayBufferWithBytesNoCopy(ctx, b->data[c], b->frames * sizeof(float), FreeChannel, new std::shared_ptr<ABuffer>(b), nullptr);
    JSObjectSetPropertyAtIndex(ctx, array, i++, ab, nullptr);
  }
  return array;
}

int Register(const std::shared_ptr<ABuffer> &b) {
  os_unfair_lock_lock(&gLock);
  int id = gNextBuffer++;
  gBuffers[id] = b;
  os_unfair_lock_unlock(&gLock);
  return id;
}

std::shared_ptr<ABuffer> Decode(NSData *data, NSString **error) {
  NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSUUID UUID].UUIDString];
  [data writeToFile:path atomically:NO];
  NSURL *url = [NSURL fileURLWithPath:path];
  NSError *err = nil;
  AVAudioFile *file = [[AVAudioFile alloc] initForReading:url commonFormat:AVAudioPCMFormatFloat32 interleaved:NO error:&err];
  std::shared_ptr<ABuffer> result;
  if (file) {
    AVAudioFormat *inFormat = file.processingFormat;
    AVAudioPCMBuffer *pcm = [[AVAudioPCMBuffer alloc] initWithPCMFormat:inFormat frameCapacity:(AVAudioFrameCount)file.length];
    if ([file readIntoBuffer:pcm error:&err]) {
      // Resample to the context's rate, as decodeAudioData does.
      AVAudioPCMBuffer *outPcm = pcm;
      if (fabs(inFormat.sampleRate - gRate) > 0.5) {
        AVAudioFormat *outFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:gRate channels:inFormat.channelCount interleaved:NO];
        AVAudioConverter *conv = [[AVAudioConverter alloc] initFromFormat:inFormat toFormat:outFormat];
        outPcm = [[AVAudioPCMBuffer alloc] initWithPCMFormat:outFormat frameCapacity:(AVAudioFrameCount)(pcm.frameLength * gRate / inFormat.sampleRate + 16)];
        __block BOOL fed = NO;
        [conv convertToBuffer:outPcm error:&err withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount, AVAudioConverterInputStatus *status) {
          if (fed) { *status = AVAudioConverterInputStatus_EndOfStream; return nil; }
          fed = YES; *status = AVAudioConverterInputStatus_HaveData; return pcm;
        }];
      }
      result = std::make_shared<ABuffer>();
      result->channels = outPcm.format.channelCount;
      result->frames = outPcm.frameLength;
      result->rate = outPcm.format.sampleRate;
      for (int c = 0; c < result->channels; c++) {
        float *d = (float *)malloc(std::max<int64_t>(1, result->frames) * sizeof(float));
        memcpy(d, outPcm.floatChannelData[c], result->frames * sizeof(float));
        result->data.push_back(d);
      }
    }
  }
  [NSFileManager.defaultManager removeItemAtPath:path error:nil];
  if (!result) *error = err.localizedDescription ?: @"unsupported audio";
  return result;
}

double Arg(JSContextRef ctx, size_t argc, const JSValueRef argv[], size_t i, double fallback = 0) {
  return i < argc && !JSValueIsUndefined(ctx, argv[i]) ? JSValueToNumber(ctx, argv[i], nullptr) : fallback;
}
}  // namespace

JSValueRef AudioNative(JSContextRef ctx, size_t argc, const JSValueRef argv[]) {
  int cmd = (int)Arg(ctx, argc, argv, 0);
  auto a = [&](size_t i, double d = 0) { return Arg(ctx, argc, argv, i + 1, d); };
  switch (cmd) {
    case C_INIT: Start(); return JSValueMakeNumber(ctx, gRate);
    case C_TIME: { os_unfair_lock_lock(&gLock); double t = gFrames / gRate; os_unfair_lock_unlock(&gLock); return JSValueMakeNumber(ctx, t); }
    case C_LATENCY: return JSValueMakeNumber(ctx, gLatency);
    case C_TIMESTAMP: {
      os_unfair_lock_lock(&gLock);
      JSValueRef v[] = { JSValueMakeNumber(ctx, gStampContext), JSValueMakeNumber(ctx, gStampPerf) };
      os_unfair_lock_unlock(&gLock);
      return JSObjectMakeArray(ctx, 2, v, nullptr);
    }
    case C_SUSPEND: os_unfair_lock_lock(&gLock); gRunning = false; os_unfair_lock_unlock(&gLock); break;
    case C_RESUME: os_unfair_lock_lock(&gLock); gRunning = true; os_unfair_lock_unlock(&gLock); break;
    case C_DECODE: {
      size_t len = 0;
      uint8_t *bytes = JSBytesOf(ctx, argv[1], &len);
      NSData *data = [NSData dataWithBytes:bytes length:bytes ? len : 0];
      JSValueRef done = argv[2];
      JSValueProtect(ctx, done);
      dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSString *error = nil;
        double t = NowMs();
        auto b = Decode(data, &error);
        int id = b ? Register(b) : 0;
        HostLog(0, [NSString stringWithFormat:@"decoded audio in %.0f ms: %@", NowMs() - t, b ? [NSString stringWithFormat:@"%d ch, %.1f s", b->channels, b->frames / b->rate] : error]);
        [CurrentHost() perform:^(JSGlobalContextRef c) {
          JSValueRef args[] = { JSValueMakeNumber(c, id), JSValueMakeNumber(c, b ? b->rate : 0), b ? BufferArrays(c, b, id, false) : JSValueMakeNull(c), JSStringValue(c, error ?: @"") };
          [CurrentHost() call:(JSObjectRef)done args:args count:4];
          JSValueUnprotect(c, done);
        }];
      });
      break;
    }
    case C_CREATE_BUFFER: {
      auto b = std::make_shared<ABuffer>();
      b->channels = std::max(1, (int)a(0)); b->frames = std::max<int64_t>(1, (int64_t)a(1)); b->rate = a(2, gRate);
      for (int c = 0; c < b->channels; c++) b->data.push_back((float *)calloc(b->frames, sizeof(float)));
      return BufferArrays(ctx, b, Register(b), true);
    }
    default: break;
  }
  // Graph edits.
  os_unfair_lock_lock(&gLock);
  switch (cmd) {
    case C_CREATE: {
      Node &n = gNodes[(int)a(0)];
      n = Node();
      n.type = (int)a(1);
      if (n.type == N_SOURCE) { n.params[0].intrinsic = 1; n.params[1].intrinsic = 0; }
      break;
    }
    case C_CONNECT: gNodes[(int)a(1)].inputs.push_back((int)a(0)); break;
    case C_DISCONNECT: {
      int src = (int)a(0), dst = (int)a(1);
      for (auto &[id, n] : gNodes) if (dst < 0 || id == dst) n.inputs.erase(std::remove(n.inputs.begin(), n.inputs.end(), src), n.inputs.end());
      break;
    }
    case C_PARAM: {
      auto it = gNodes.find((int)a(0));
      int index = (int)a(1);
      if (it == gNodes.end() || index < 0 || index >= 5) break;
      Param &p = it->second.params[index];
      int type = (int)a(2);
      double value = a(3), time = a(4), tc = a(5);
      if (type == E_VALUE) { p.intrinsic = value; p.events.clear(); }
      else if (type == E_CANCEL) p.events.erase(std::remove_if(p.events.begin(), p.events.end(), [&](const Event &e) { return e.time >= time; }), p.events.end());
      else {
        auto pos = std::upper_bound(p.events.begin(), p.events.end(), time, [](double t, const Event &e) { return t < e.time; });
        p.events.insert(pos, { type, value, time, tc });
      }
      break;
    }
    case C_START: {
      Node &n = gNodes[(int)a(0)];
      auto it = gBuffers.find((int)a(1));
      n.buffer = it == gBuffers.end() ? nullptr : it->second.lock();
      n.when = a(2); n.offset = std::max(0.0, a(3)); n.duration = a(4, -1); n.loop = a(5) != 0;
      n.started = true; n.playing = false; n.done = false; n.played = 0;
      break;
    }
    case C_STOP: { Node &n = gNodes[(int)a(0)]; n.stopAt = std::max(a(1), gFrames / gRate); break; }
    case C_RELEASE: gNodes.erase((int)a(0)); break;
  }
  os_unfair_lock_unlock(&gLock);
  return JSValueMakeUndefined(ctx);
}

// Shared declarations for the aerodance JavaScriptCore host. See ../README.md.
#pragma once
#import <Foundation/Foundation.h>
#import <QuartzCore/QuartzCore.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreText/CoreText.h>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

double NowMs();  // performance.now() time base: ms since launch
void HostLog(int level, NSString *text);

/** A decoded image: premultiplied RGBA8, rows top to bottom. */
struct DecodedImage {
  int width = 0, height = 0;
  std::vector<uint8_t> pixels;
  CGImageRef image = nullptr;  // created on first drawImage
  ~DecodedImage() { if (image) CGImageRelease(image); }
  CGImageRef cgImage();
};

/** Payloads the JavaScript thread hands to the executor: interned strings, large data blocks and
 *  decoded images. Strings and blocks are freed when a command consumes them. */
class Payloads {
 public:
  int putString(std::string s);
  std::string takeString(int handle);
  int putBlock(const void *bytes, size_t length);
  std::vector<uint8_t> takeBlock(int handle);
  int putImage(std::shared_ptr<DecodedImage> image);
  std::shared_ptr<DecodedImage> image(int handle);
  void releaseImage(int handle);

 private:
  std::mutex lock_;
  int next_ = 1;
  std::unordered_map<int, std::string> strings_;
  std::unordered_map<int, std::vector<uint8_t>> blocks_;
  std::unordered_map<int, std::shared_ptr<DecodedImage>> images_;
};
extern Payloads gPayloads;

/** CSS fonts, shared by text measuring (JavaScript thread) and drawing (executor). */
struct FontFace;
int FontForCSS(const std::string &css);
CTFontRef FontRef(int font);  // not retained
void RegisterBundledFonts(NSString *directory);
void MeasureText(int font, NSString *text, double letterSpacing, double *out);

/** Per-frame timings, for reports. */
struct FrameRecord {
  double start = 0;     // ms, when the frame's JavaScript began
  double jsMs = 0;      // animation frame callbacks and their promise jobs
  double submitMs = 0;  // encoding the end of frame and handing it over (includes waiting for a free buffer)
  double execMs = 0;    // executing the frame's commands (GL and 2D)
  double gpuMs = -1;    // glFinish after the frame, when GPU timing is on
  int commands = 0;     // command words executed
};
class FrameStats {
 public:
  void beginFrame(double start);
  void js(double ms);
  void submitted(double ms);
  void executed(uint64_t frame, double ms, double gpuMs, int words);
  uint64_t current() const { return frame_; }
  /** JSON summary of frames that began in [fromMs, toMs]. */
  NSString *summary(double fromMs, double toMs);

 private:
  std::mutex lock_;
  uint64_t frame_ = 0;
  std::vector<FrameRecord> records_;  // ring, indexed by frame % size
};
extern FrameStats gFrameStats;

/** The layer frames are presented in; owned by the view controller. */
@interface DisplayTarget : NSObject
@property(nonatomic, strong) CAEAGLLayer *layer;
@property(nonatomic) CGSize screenSize;  // points
@property(nonatomic) BOOL fill;          // stretch to the screen (the game) or fit (the benchmark)
@property(nonatomic) BOOL pixelated;
/** Sizes the layer for a canvas of w x h pixels. Main thread. */
- (void)layoutForCanvasWidth:(int)w height:(int)h;
@end

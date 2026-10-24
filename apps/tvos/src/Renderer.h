// Hands command buffers from the JavaScript thread to the executor: inline on the JavaScript
// thread (modes 0 and 1) or on a render thread a frame behind (mode 2).
#pragma once
#import "Executor.h"
#include <condition_variable>
#include <deque>
#include <functional>
#include <thread>

class Renderer {
 public:
  static constexpr int kBuffers = 4;
  static constexpr size_t kBufferBytes = 4 << 20;

  Renderer(int mode, DisplayTarget *display, bool gpuTiming, bool checkErrors, bool copyBlit);
  ~Renderer();
  int mode() const { return mode_; }
  uint8_t *buffer(int i) { return buffers_[i]; }
  /** Executes (or queues) words [0, n) of the current buffer; returns the next buffer to fill. */
  int submit(int words, bool endOfFrame);
  /** Runs fn on the executor's thread after everything submitted so far, and waits. */
  void sync(const std::function<void(Executor &)> &fn);
  /** Frames submitted and not yet presented (mode 2). */
  int framesInFlight() const { return inFlight_.load(); }
  /** Milliseconds the JavaScript thread has waited for free buffers. */
  double waitedMs() const { return waitedMs_; }

 private:
  struct Item { int buffer = -1; int words = 0; bool endOfFrame = false; uint64_t frame = 0; std::function<void(Executor &)> fn; };
  void loop();

  int mode_;
  Executor executor_;
  uint8_t *buffers_[kBuffers];
  int current_ = 0;
  bool busy_[kBuffers] = {};
  std::atomic<int> inFlight_{0};
  double waitedMs_ = 0;
  std::mutex lock_;
  std::condition_variable work_, done_;
  std::deque<Item> queue_;
  bool stop_ = false;
  std::thread thread_;
};

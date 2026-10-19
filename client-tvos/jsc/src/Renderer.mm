#import "Renderer.h"
#include <pthread.h>

Renderer::Renderer(int mode, DisplayTarget *display, bool gpuTiming, bool checkErrors)
    : mode_(mode), executor_(display, gpuTiming, checkErrors) {
  for (auto &b : buffers_) b = (uint8_t *)calloc(kBufferBytes, 1);
  if (mode_ == 2) {
    thread_ = std::thread([this] {
      pthread_setname_np("aerodance.render");
      pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
      executor_.makeCurrent();
      loop();
    });
  } else {
    executor_.makeCurrent();
  }
}

Renderer::~Renderer() {
  { std::lock_guard<std::mutex> g(lock_); stop_ = true; }
  work_.notify_all();
  if (thread_.joinable()) thread_.join();
}

void Renderer::loop() {
  for (;;) {
    Item item;
    {
      std::unique_lock<std::mutex> g(lock_);
      work_.wait(g, [this] { return stop_ || !queue_.empty(); });
      if (stop_) return;
      item = std::move(queue_.front());
      queue_.pop_front();
    }
    @autoreleasepool {
      if (item.fn) item.fn(executor_);
      else {
        executor_.run((const int32_t *)buffers_[item.buffer], item.words);
        if (item.endOfFrame) executor_.endFrame(item.frame);
      }
    }
    {
      std::lock_guard<std::mutex> g(lock_);
      if (item.buffer >= 0) busy_[item.buffer] = false;
      if (item.endOfFrame) inFlight_--;
      if (item.fn) item.fn = nullptr;
    }
    done_.notify_all();
  }
}

int Renderer::submit(int words, bool endOfFrame) {
  uint64_t frame = gFrameStats.current();
  if (mode_ != 2) {
    @autoreleasepool {
      if (words > 0) executor_.run((const int32_t *)buffers_[current_], words);
      if (endOfFrame) executor_.endFrame(frame);
    }
    return current_;
  }
  if (words <= 0 && !endOfFrame) return current_;
  std::unique_lock<std::mutex> g(lock_);
  busy_[current_] = true;
  if (endOfFrame) inFlight_++;
  queue_.push_back({ current_, words, endOfFrame, frame, nullptr });
  work_.notify_one();
  int next = (current_ + 1) % kBuffers;
  if (busy_[next]) {
    double t = NowMs();
    done_.wait(g, [&] { return !busy_[next]; });
    waitedMs_ += NowMs() - t;
  }
  current_ = next;
  return next;
}

void Renderer::sync(const std::function<void(Executor &)> &fn) {
  if (mode_ != 2) { @autoreleasepool { fn(executor_); } return; }
  std::unique_lock<std::mutex> g(lock_);
  bool finished = false;
  queue_.push_back({ -1, 0, false, 0, [&](Executor &e) { fn(e); finished = true; } });
  work_.notify_one();
  done_.wait(g, [&] { return finished; });
}

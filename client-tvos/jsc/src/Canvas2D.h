// 2D canvases on CoreGraphics and CoreText, driven by the C_* commands (../runtime/canvas2d.ts).
#pragma once
#import "Executor.h"

struct CanvasState;
struct CanvasSurface;
struct Paint;

class Canvas2D {
 public:
  Canvas2D();
  ~Canvas2D();
  /** Runs one C_* command. */
  void run(int op, const int32_t *w, int words);
  bool bitmap(int canvas, CanvasBitmap *out);
  /** Copies un-premultiplied RGBA pixels of a rectangle into out (w * h * 4 bytes). */
  void getImageData(int canvas, int x, int y, int w, int h, uint8_t *out);

 private:
  CanvasSurface *current_ = nullptr;
  std::unordered_map<int, CanvasSurface *> surfaces_;
  std::unordered_map<int, Paint *> paints_;
  int selected_ = 0;
  int pathTarget_ = 0;
};

// Runs the command stream (../runtime/ops.ts): WebGL 2 on OpenGL ES 3.0, and 2D canvases on
// CoreGraphics. Everything here happens on one thread, the one that owns the GL context.
#pragma once
#import "Host.h"
#import <OpenGLES/EAGL.h>
#import <OpenGLES/ES3/gl.h>
#import <OpenGLES/ES3/glext.h>

/** A 2D canvas's pixels: premultiplied RGBA8, rows top to bottom. */
struct CanvasBitmap {
  int width = 0, height = 0;
  size_t stride = 0;
  const uint8_t *data = nullptr;
};

class Canvas2D;

class Executor {
 public:
  Executor(DisplayTarget *display, bool gpuTiming, bool checkErrors);
  ~Executor();
  /** Creates the GL context on first use and makes it current on this thread. */
  void makeCurrent();
  /** Runs `count` command words; `frame` is the JavaScript frame they belong to. */
  void run(const int32_t *words, int count);
  /** Ends a frame's commands: records its timing (the PRESENT command presents). */
  void endFrame(uint64_t frame);
  /** A sync query (../runtime/native.ts Q): returns an NSNumber, NSString or NSArray. */
  id query(int kind, const double *args, void *out, size_t outLength);

  bool canvasBitmap(int canvas, CanvasBitmap *out);

 private:
  void runGL(int op, const int32_t *w, int words);
  void resizeDefault(int w, int h, bool antialias, bool depth, bool stencil, bool alpha);
  void present();
  void texImage(const int32_t *w);
  const uint8_t *payload(const int32_t *p, std::vector<uint8_t> &holder, size_t *length);
  GLuint name(int jsId) const { return jsId > 0 && (size_t)jsId < names_.size() ? names_[jsId] : 0; }
  GLuint framebuffer(int jsId) const { return jsId ? name(jsId) : defaultFBO_; }
  void setName(int jsId, GLuint glName);
  id getParameter(GLenum pname);
  NSString *programInfo(GLuint program);
  NSString *glInfo();

  DisplayTarget *display_;
  EAGLContext *context_ = nil;
  bool gpuTiming_, checkErrors_;
  std::vector<GLuint> names_;
  std::unordered_map<int, GLuint> shaderTypes_;
  // The default framebuffer: multisampled (when antialiased) and resolved into the layer's.
  GLuint displayFBO_ = 0, displayRB_ = 0, displayDepthRB_ = 0;
  GLuint msaaFBO_ = 0, msaaColorRB_ = 0, msaaDepthRB_ = 0;
  GLuint defaultFBO_ = 0;
  int width_ = 0, height_ = 0;
  bool firstResize_ = true;
  bool hasDepth_ = true, hasStencil_ = false;
  // Bindings, restored after presenting.
  int drawFB_ = 0, readFB_ = 0, renderbuffer_ = 0;
  bool scissorTest_ = false;
  // WebGL pixel unpacking.
  bool flipY_ = false, premultiply_ = false;
  int unpackAlignment_ = 4, unpackRowLength_ = 0, unpackImageHeight_ = 0, unpackSkipPixels_ = 0, unpackSkipRows_ = 0, unpackSkipImages_ = 0;
  int boundPixelUnpack_ = 0;
  // Frame timing.
  double frameExecMs_ = 0;
  int frameWords_ = 0;
  Canvas2D *canvas_;
};

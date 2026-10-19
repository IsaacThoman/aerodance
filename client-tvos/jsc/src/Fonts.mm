// CSS fonts for canvas text: parses font shorthands ("800 64px Inter, sans-serif"), matches them
// against the bundled faces (Inter, Exo 2, Nunito) by family and nearest weight, and falls back to
// the system font. Bundled files are named <Family>__<weight>[i].<ext> by scripts/tvos-jsc.ts.
#import "Host.h"
#import <UIKit/UIKit.h>
#include <cmath>
#include <regex>

namespace {
struct Face { std::string family; int weight; bool italic; CTFontDescriptorRef descriptor; };
struct Font { std::string css; std::vector<std::string> families; int weight = 400; bool italic = false; double size = 10; CTFontRef ref = nullptr; };

std::mutex gLock;
std::vector<Face> gFaces;
std::vector<Font> gFonts;
std::unordered_map<std::string, int> gIds;

std::string Lower(std::string s) { for (auto &c : s) c = (char)tolower(c); return s; }
std::string Trim(const std::string &s) {
  size_t a = s.find_first_not_of(" \t\"'"), b = s.find_last_not_of(" \t\"'");
  return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

bool Parse(const std::string &css, Font &f) {
  static const std::regex sizeRe("(^|\\s)(\\d*\\.?\\d+)(px|pt|em|rem|%)(/\\S+)?\\s+(.+)$");
  std::smatch m;
  if (!std::regex_search(css, m, sizeRe)) return false;
  double size = std::stod(m[2].str());
  std::string unit = m[3].str();
  if (unit == "pt") size *= 4.0 / 3.0;
  else if (unit == "em" || unit == "rem") size *= 16;
  else if (unit == "%") size *= 0.16;
  f.size = size;
  std::string before = css.substr(0, m.position(0));
  std::regex ws("\\s+");
  for (std::sregex_token_iterator it(before.begin(), before.end(), ws, -1), end; it != end; ++it) {
    std::string t = Lower(it->str());
    if (t.empty() || t == "normal" || t == "small-caps") continue;
    if (t == "italic" || t == "oblique") f.italic = true;
    else if (t == "bold" || t == "bolder") f.weight = 700;
    else if (t == "lighter") f.weight = 300;
    else if (isdigit(t[0])) f.weight = std::stoi(t);
  }
  std::string families = m[5].str();
  size_t start = 0;
  while (start <= families.size()) {
    size_t comma = families.find(',', start);
    std::string fam = Lower(Trim(families.substr(start, comma == std::string::npos ? std::string::npos : comma - start)));
    if (!fam.empty()) f.families.push_back(fam);
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return true;
}

// CSS font matching: the nearest weight, preferring heavier faces for weights above 500.
const Face *Match(const std::string &family, int weight, bool italic) {
  const Face *best = nullptr;
  int bestScore = INT_MAX;
  for (const Face &face : gFaces) {
    if (face.family != family) continue;
    int d = face.weight - weight;
    int score = std::abs(d) * 2 + (face.italic != italic ? 10000 : 0);
    if (weight > 500 && d < 0) score += 1000;
    if (weight < 400 && d > 0) score += 1000;
    if (score < bestScore) { bestScore = score; best = &face; }
  }
  return best;
}

UIFontWeight SystemWeight(int w) {
  if (w <= 100) return UIFontWeightUltraLight;
  if (w <= 200) return UIFontWeightThin;
  if (w <= 300) return UIFontWeightLight;
  if (w <= 400) return UIFontWeightRegular;
  if (w <= 500) return UIFontWeightMedium;
  if (w <= 600) return UIFontWeightSemibold;
  if (w <= 700) return UIFontWeightBold;
  if (w <= 800) return UIFontWeightHeavy;
  return UIFontWeightBlack;
}

CTFontRef Create(const Font &f) {
  for (const std::string &family : f.families) {
    if (const Face *face = Match(family, f.weight, f.italic)) return CTFontCreateWithFontDescriptor(face->descriptor, f.size, nullptr);
  }
  UIFont *font = [UIFont systemFontOfSize:f.size weight:SystemWeight(f.weight)];
  for (const std::string &family : f.families) {
    if (family == "monospace") { font = [UIFont monospacedSystemFontOfSize:f.size weight:SystemWeight(f.weight)]; break; }
  }
  if (f.italic) {
    UIFontDescriptor *d = [font.fontDescriptor fontDescriptorWithSymbolicTraits:UIFontDescriptorTraitItalic];
    if (d) font = [UIFont fontWithDescriptor:d size:f.size];
  }
  return (CTFontRef)CFBridgingRetain(font);
}
}  // namespace

void RegisterBundledFonts(NSString *directory) {
  std::lock_guard<std::mutex> g(gLock);
  for (NSString *file in [NSFileManager.defaultManager contentsOfDirectoryAtPath:directory error:nil]) {
    NSString *base = file.stringByDeletingPathExtension;
    NSRange sep = [base rangeOfString:@"__"];
    if (sep.location == NSNotFound) continue;
    NSData *data = [NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:file]];
    CFArrayRef descriptors = data ? CTFontManagerCreateFontDescriptorsFromData((__bridge CFDataRef)data) : nullptr;
    if (!descriptors || !CFArrayGetCount(descriptors)) { HostLog(1, [NSString stringWithFormat:@"font %@ didn't load", file]); continue; }
    NSString *spec = [base substringFromIndex:sep.location + 2];
    Face face;
    face.family = Lower([[base substringToIndex:sep.location] stringByReplacingOccurrencesOfString:@"_" withString:@" "].UTF8String);
    face.weight = spec.intValue;
    face.italic = [spec hasSuffix:@"i"];
    face.descriptor = (CTFontDescriptorRef)CFRetain(CFArrayGetValueAtIndex(descriptors, 0));
    CFRelease(descriptors);
    gFaces.push_back(face);
  }
  HostLog(0, [NSString stringWithFormat:@"%lu bundled font faces", gFaces.size()]);
}

int FontForCSS(const std::string &css) {
  std::lock_guard<std::mutex> g(gLock);
  auto it = gIds.find(css);
  if (it != gIds.end()) return it->second;
  Font f;
  f.css = css;
  if (!Parse(css, f)) { gIds[css] = -1; return -1; }
  int id = (int)gFonts.size();
  gFonts.push_back(f);
  gIds[css] = id;
  return id;
}

CTFontRef FontRef(int font) {
  std::lock_guard<std::mutex> g(gLock);
  if (font < 0 || font >= (int)gFonts.size()) {
    static CTFontRef fallback = CTFontCreateWithName(CFSTR("Helvetica"), 10, nullptr);
    return fallback;
  }
  Font &f = gFonts[font];
  if (!f.ref) f.ref = Create(f);
  return f.ref;
}

/** width, actual bounding box left/right/ascent/descent, font ascent/descent. */
void MeasureText(int font, NSString *text, double letterSpacing, double *out) {
  CTFontRef ref = FontRef(font);
  NSMutableDictionary *attrs = [NSMutableDictionary dictionaryWithObject:(__bridge id)ref forKey:(id)kCTFontAttributeName];
  if (letterSpacing != 0) attrs[(id)kCTKernAttributeName] = @(letterSpacing);
  NSAttributedString *s = [[NSAttributedString alloc] initWithString:text attributes:attrs];
  CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)s);
  double width = CTLineGetTypographicBounds(line, nullptr, nullptr, nullptr);
  CGRect ink = CTLineGetBoundsWithOptions(line, kCTLineBoundsUseGlyphPathBounds);
  CFRelease(line);
  out[0] = width;
  out[1] = -ink.origin.x;
  out[2] = ink.origin.x + ink.size.width;
  out[3] = ink.origin.y + ink.size.height;
  out[4] = -ink.origin.y;
  out[5] = CTFontGetAscent(ref);
  out[6] = CTFontGetDescent(ref);
}

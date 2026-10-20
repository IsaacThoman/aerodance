import UIKit
import XCTest

// The iPhone/iPad app as a player meets it, in a simulator: launched by its bundle ID and tapped
// through the menu at the game's own layout coordinates. ui.ios.ts runs these and hands them, as
// TEST_RUNNER_ variables:
//
//   AERODANCE_BUNDLE_ID   the installed app
//   AERODANCE_PORT        its loopback port (--port)
//   AERODANCE_PATH        the page it opens (--path, /?input=ghost)
//   AERODANCE_RUNNER      ui.ios.ts's address: the app reports the game's canvas data-* state there
//                         (--report), GET /state returns the latest (POST /reset forgets it), and
//                         POST /shot?name= keeps a screenshot
//   AERODANCE_LAYOUT      JSON from the game's layout.ts: the design size and the rects tapped
//
// The game draws its UI on a canvas, so there are no elements to find: taps go to design units
// converted to points inside the game's 16:9 frame, and waits are on the reported state.
final class AerodanceUITests: XCTestCase {
  struct Layout: Decodable {
    struct Rect: Decodable { let x, y, w, h: Double }
    let design: [Double]
    let start, onePlayer, firstSong: Rect
  }

  let env = ProcessInfo.processInfo.environment
  var app: XCUIApplication!
  var runner: String { env["AERODANCE_RUNNER"] ?? "http://127.0.0.1:8767" }
  var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication(bundleIdentifier: env["AERODANCE_BUNDLE_ID"] ?? "com.isaacthoman.aerodance")
    app.launchArguments = ["--port", env["AERODANCE_PORT"] ?? "8417", "--path", env["AERODANCE_PATH"] ?? "/?input=ghost", "--report", "\(runner)/report"]
  }

  override func tearDown() {
    app.terminate()
    XCUIDevice.shared.orientation = .portrait
  }

  func test1LaunchReachesMainMenu() throws {
    launch()
    waitFor(["menuScreen": "main", "menuReady": "true"])
    shot("1-main-menu")
  }

  // The iPhone app plays in landscape only, whichever way the phone is held.
  func test2PhoneIsLandscape() throws {
    if isPad { throw XCTSkip("iPads turn both ways") }
    XCUIDevice.shared.orientation = .portrait
    launch()
    waitFor(["menuScreen": "main", "menuReady": "true"])
    shot("2-phone-held-upright")
    let size = app.windows.firstMatch.frame.size
    XCTAssertGreaterThan(size.width, size.height, "the app's window is \(size.width)x\(size.height) with the phone upright: not landscape")
  }

  // Real touches: One Player, then the first song, at their layout positions.
  func test3TapsThroughToSongPreview() throws {
    let layout = try JSONDecoder().decode(Layout.self, from: Data((env["AERODANCE_LAYOUT"] ?? "").utf8))
    XCUIDevice.shared.orientation = .landscapeLeft
    launch()
    waitFor(["menuScreen": "main", "menuReady": "true"])
    // Measured once the window has turned.
    let window = app.windows.firstMatch
    XCTAssertTrue(waitUntil { window.frame.width > window.frame.height }, "the app didn't turn to landscape")
    sleep(1)
    let frame = gameFrame(design: layout.design)
    tap(layout.start, in: frame, design: layout.design)
    waitFor(["menuScreen": "players", "menuReady": "true"])
    shot("3-players")
    tap(layout.onePlayer, in: frame, design: layout.design)
    waitFor(["songScreen": "list", "songReady": "true", "catalog": "ready"])
    shot("3-song-list")
    tap(layout.firstSong, in: frame, design: layout.design)
    waitFor(["songScreen": "preview"])
    shot("3-song-preview")
  }

  // The iPad game follows the iPad round: a screenshot each way up.
  func test4PadRotates() throws {
    if !isPad { throw XCTSkip("iPhones stay in landscape") }
    XCUIDevice.shared.orientation = .portrait
    launch()
    waitFor(["menuScreen": "main", "menuReady": "true"])
    for (name, orientation) in [("portrait", UIDeviceOrientation.portrait), ("landscape", .landscapeLeft), ("portrait-again", .portrait)] {
      XCUIDevice.shared.orientation = orientation
      sleep(2)
      let size = app.windows.firstMatch.frame.size
      XCTAssertEqual(size.width > size.height, orientation.isLandscape, "\(name): the window is \(size.width)x\(size.height)")
      shot("4-ipad-\(name)")
    }
  }

  // MARK: - Helpers

  func launch() {
    // The last launch's state is out of date.
    send("reset")
    app.launch()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "the app didn't start")
  }

  /// The game's latest reported state (the canvas's data-* attributes), every two seconds.
  func state() -> [String: String] {
    guard let url = URL(string: "\(runner)/state") else { return [:] }
    let done = DispatchSemaphore(value: 0)
    var result: [String: String] = [:]
    URLSession.shared.dataTask(with: url) { data, _, _ in
      if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: String] { result = json }
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 5)
    return result
  }

  func waitFor(_ want: [String: String], timeout: TimeInterval = 120, file: StaticString = #filePath, line: UInt = #line) {
    let until = Date().addingTimeInterval(timeout)
    var now: [String: String] = [:]
    while Date() < until {
      now = state()
      if want.allSatisfy({ now[$0.key] == $0.value }) { return }
      usleep(250_000)
    }
    shot("timeout")
    XCTFail("Timed out waiting for \(want); the game reported \(now)", file: file, line: line)
  }

  func waitUntil(timeout: TimeInterval = 10, _ check: () -> Bool) -> Bool {
    let until = Date().addingTimeInterval(timeout)
    while Date() < until {
      if check() { return true }
      usleep(250_000)
    }
    return false
  }

  /// The game's 16:9 frame in the app's points: the picture inside the black bars of a screenshot,
  /// or the largest 16:9 rectangle centred in the window if that can't be told.
  func gameFrame(design: [Double]) -> CGRect {
    let window = app.windows.firstMatch.frame
    let aspect = design[0] / design[1]
    let fit = min(window.width, window.height * aspect)
    let centred = CGRect(x: window.midX - fit / 2, y: window.midY - fit / aspect / 2, width: fit, height: fit / aspect)
    let w = Int(window.width), h = Int(window.height)
    // The screen redrawn upright, a pixel per point, to read. (The app's own screenshot leaves the
    // web view's layer out.)
    let image = XCUIScreen.main.screenshot().image
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let upright = UIGraphicsImageRenderer(size: window.size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: window.size)) }
    var pixels = [UInt8](repeating: 0, count: w * h * 4)
    pixels.withUnsafeMutableBytes { buffer in
      guard let cg = upright.cgImage, let context = CGContext(data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
      context.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    let lit = { (x: Int, y: Int) -> Bool in
      let i = (y * w + x) * 4
      return Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) > 60
    }
    let row = (0..<w).filter { lit($0, h / 2) }, column = (0..<h).filter { lit(w / 2, $0) }
    guard let left = row.first, let right = row.last, let top = column.first, let bottom = column.last else { return centred }
    let found = CGRect(x: window.minX + CGFloat(left), y: window.minY + CGFloat(top), width: CGFloat(right - left + 1), height: CGFloat(bottom - top + 1))
    // Anything but a 16:9 picture (a dark scene at an edge) isn't the frame.
    let frame = abs(found.width / found.height - aspect) < 0.03 ? found : centred
    NSLog("aerodance: the game's frame is \(frame) in a \(window.size) window (lit: \(found))")
    return frame
  }

  /// A tap in the middle of a rect given in design units.
  func tap(_ rect: Layout.Rect, in frame: CGRect, design: [Double]) {
    let x = frame.minX + (rect.x + rect.w / 2) / design[0] * frame.width
    let y = frame.minY + (rect.y + rect.h / 2) / design[1] * frame.height
    app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
  }

  /// Sends a screenshot to ui.ios.ts, which saves it outside the repo.
  func shot(_ name: String) {
    send("shot?name=\(name)", XCUIScreen.main.screenshot().pngRepresentation)
  }

  func send(_ path: String, _ body: Data = Data()) {
    guard let url = URL(string: "\(runner)/\(path)") else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.uploadTask(with: request, from: body) { _, _, _ in done.signal() }.resume()
    _ = done.wait(timeout: .now() + 10)
  }
}

import Foundation
import Vision
import ImageIO

// One process per sequence: model warmup is not charged on every frame.
let args = CommandLine.arguments
let paths = try String(contentsOfFile: args[1], encoding: .utf8).split(separator: "\n").map(String.init)
let output = URL(fileURLWithPath: args[2])
let fps = Double(args[3])!, start = Int(args[4])!, use3D = args[5] == "3d"
let names: [(VNHumanBodyPoseObservation.JointName, Int)] = [(.nose,0),(.leftEye,2),(.rightEye,5),(.leftEar,7),(.rightEar,8),(.leftShoulder,11),(.rightShoulder,12),(.leftElbow,13),(.rightElbow,14),(.leftWrist,15),(.rightWrist,16),(.leftHip,23),(.rightHip,24),(.leftKnee,25),(.rightKnee,26),(.leftAnkle,27),(.rightAnkle,28)]
var times: [Double] = [], errors: [String] = [], lines: [String] = []
let request = VNDetectHumanBodyPoseRequest()
for (i, path) in paths.enumerated() {
    try autoreleasepool {
        let frame = Int(URL(fileURLWithPath:path).deletingPathExtension().lastPathComponent) ?? (start+i)
        let handler = VNImageRequestHandler(url: URL(fileURLWithPath:path), orientation: .up)
        let t = CFAbsoluteTimeGetCurrent()
        var people: [[String:Any]] = []
        if use3D {
            if #available(macOS 14.0, *) {
                let req = VNDetectHumanBodyPose3DRequest()
                do {
                    try handler.perform([req])
                    for body in req.results ?? [] {
                        let mapping: [(VNHumanBodyPose3DObservation.JointName, Int)] = [(.leftShoulder,11),(.rightShoulder,12),(.leftElbow,13),(.rightElbow,14),(.leftWrist,15),(.rightWrist,16),(.leftHip,23),(.rightHip,24),(.leftKnee,25),(.rightKnee,26),(.leftAnkle,27),(.rightAnkle,28)]
                        var kp: [Any] = Array(repeating:NSNull(), count:33)
                        let root = try body.recognizedPoint(.root).position.columns.3.z
                        for (name, index) in mapping {
                            let p = try body.pointInImage(name)
                            let xyz = try body.recognizedPoint(name).position.columns.3
                            // Vision's metres are NOT MediaPipe width-normalized depth.
                            kp[index] = [Double(p.x), 1-Double(p.y), Double(xyz.z-root), Double(body.confidence)]
                        }
                        people.append(["kp":kp,"score":Double(body.confidence)])
                    }
                } catch { errors.append(String(describing:error)) }
            } else { errors.append("3D requires macOS 14+") }
        } else {
            try handler.perform([request])
            for body in request.results ?? [] {
                var kp: [Any] = Array(repeating:NSNull(), count:33)
                let points = try body.recognizedPoints(.all)
                for (name,index) in names {
                    // (Vision reports joints it didn't find as (0, 0) with confidence 0: those are missing, not at the corner.)
                    if let p = points[name], p.confidence > 0 { kp[index] = [Double(p.x),1-Double(p.y),0,Double(p.confidence)] }
                }
                people.append(["kp":kp,"score":Double(body.confidence)])
            }
        }
        let ms = (CFAbsoluteTimeGetCurrent()-t)*1000; times.append(ms)
        let row: [String:Any] = ["frame":frame,"t_ms":Double(frame-1)*1000/fps,"inference_ms":ms,"people":people]
        lines.append(String(data:try JSONSerialization.data(withJSONObject:row, options:[.sortedKeys]),encoding:.utf8)!)
    }
}
try (lines.joined(separator:"\n")+"\n").write(to:output.appendingPathComponent("detections.jsonl"),atomically:true,encoding:.utf8)
let info: [String:Any] = ["estimator":use3D ? "apple-vision-3d" : "apple-vision", "runtime":"Apple Vision automatic compute selection", "machine":ProcessInfo.processInfo.operatingSystemVersionString, "request_revision":request.revision, "frames":paths.count,"mean_ms":times.reduce(0,+)/Double(times.count),"errors":Array(Set(errors)), "confidence":use3D ? "observation confidence (no per-joint confidence in 3D API)" : "recognized point confidence", "z_units":use3D ? "root-relative metres in Vision coordinates, NOT MediaPipe-compatible" : "none", "weights":"OS bundled, not exportable; version tied to OS", "timing":"VNImageRequestHandler perform + decode/map; URL image decode may be lazy and included"]
try JSONSerialization.data(withJSONObject:info,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("run.json"))
print(String(data:try JSONSerialization.data(withJSONObject:info),encoding:.utf8)!)

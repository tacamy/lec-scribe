// 画像同士の「見た目の距離」を macOS の Vision（VNGenerateImageFeaturePrintRequest）で測る。
// 標準入力に画像のパスを 1 行ずつ受け取り、全組み合わせの距離を JSON で返す。
// サーバー（server/src/vision.ts）が初回に swiftc でビルドして ~/.lec-scribe/bin に置く。
// トークンを使わず Mac の中だけで動く（SPEC §13.4b）。
import Foundation
import Vision

var paths: [String] = []
while let line = readLine(strippingNewline: true) {
    if !line.isEmpty { paths.append(line) }
}

var prints: [VNFeaturePrintObservation?] = []
for p in paths {
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: p), options: [:])
    let request = VNGenerateImageFeaturePrintRequest()
    do {
        try handler.perform([request])
        prints.append(request.results?.first as? VNFeaturePrintObservation)
    } catch {
        prints.append(nil)
    }
}

// 距離の行列。測れない組（読めない画像）は null
var rows: [[Any]] = []
for i in 0..<prints.count {
    var row: [Any] = []
    for j in 0..<prints.count {
        if i == j { row.append(0); continue }
        var d: Float = 0
        if let a = prints[i], let b = prints[j], (try? a.computeDistance(&d, to: b)) != nil {
            row.append(Double(d))
        } else {
            row.append(NSNull())
        }
    }
    rows.append(row)
}
let data = try JSONSerialization.data(withJSONObject: ["distances": rows], options: [])
FileHandle.standardOutput.write(data)

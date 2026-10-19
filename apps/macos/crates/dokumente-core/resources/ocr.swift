// On-device text recognition via the macOS Vision framework.
// Usage: swift ocr.swift <file> [maxPages]
// Prints recognized text to stdout; page breaks are blank lines.

import AppKit
import Foundation
import PDFKit
import Vision

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: ocr <file> [maxPages]\n".utf8))
    exit(2)
}
let inputPath = args[1]
let maxPages = args.count >= 3 ? (Int(args[2]) ?? 20) : 20

func recognize(cgImage: CGImage) -> String? {
    let request = VNRecognizeTextRequest()
    request.recognitionLanguages = ["de-DE", "en-US"]
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return nil
    }
    guard let results = request.results else { return nil }
    let lines = results.compactMap { $0.topCandidates(1).first?.string }
    return lines.isEmpty ? nil : lines.joined(separator: "\n")
}

if inputPath.lowercased().hasSuffix(".pdf"),
   let doc = PDFDocument(url: URL(fileURLWithPath: inputPath)) {
    let count = min(doc.pageCount, maxPages)
    var any = false
    for i in 0..<count {
        guard let page = doc.page(at: i) else { continue }
        // ~200 DPI render — good OCR quality, bounded memory.
        let scaled = CGSize(width: 1654, height: 2339)
        let nsImg = page.thumbnail(of: scaled, for: .mediaBox)
        guard let cgImg = nsImg.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let text = recognize(cgImage: cgImg) else { continue }
        if any { print("") ; print("") }
        print(text)
        any = true
    }
    exit(any ? 0 : 3)
} else {
    guard let imageSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: inputPath) as CFURL, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil),
          let text = recognize(cgImage: cgImage) else {
        exit(3)
    }
    print(text)
    exit(0)
}

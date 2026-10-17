// Draws assets/icon.png (1024×1024): a glass sphere with a sunset panorama inside.
// Run: swift scripts/make-icon.swift
import AppKit

let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let context = NSGraphicsContext.current!.cgContext
let space = CGColorSpaceCreateDeviceRGB()
func color(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor { CGColor(red: r, green: g, blue: b, alpha: a) }

// Rounded-square tile on the macOS icon grid.
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)
context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: color(0, 0, 0, 0.35))
context.addPath(tilePath)
context.setFillColor(color(0.07, 0.08, 0.16))
context.fillPath()
context.restoreGState()
context.saveGState()
context.addPath(tilePath)
context.clip()
context.drawLinearGradient(CGGradient(colorsSpace: space, colors: [color(0.10, 0.12, 0.30), color(0.04, 0.04, 0.10)] as CFArray, locations: [0, 1])!,
                           start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])

// The sphere: sky to sunset to dark ground.
let center = CGPoint(x: 512, y: 512), radius = 300.0
let sphere = CGPath(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2), transform: nil)
context.saveGState()
context.addPath(sphere)
context.clip()
context.drawLinearGradient(CGGradient(colorsSpace: space, colors: [
    color(0.16, 0.30, 0.75), color(0.55, 0.45, 0.85), color(1.0, 0.55, 0.35), color(1.0, 0.80, 0.45), color(0.12, 0.10, 0.20), color(0.05, 0.05, 0.10),
] as CFArray, locations: [0, 0.35, 0.5, 0.53, 0.55, 1])!, start: CGPoint(x: 512, y: 812), end: CGPoint(x: 512, y: 212), options: [])

// Latitude and longitude lines, so it reads as a globe you are inside.
context.setStrokeColor(color(1, 1, 1, 0.28))
context.setLineWidth(5)
for latitude in [-0.6, -0.3, 0.3, 0.6] {
    let y = center.y + radius * latitude, half = radius * sqrt(1 - latitude * latitude)
    context.strokeEllipse(in: CGRect(x: center.x - half, y: y - half * 0.16, width: half * 2, height: half * 0.32))
}
for squash in [0.3, 0.7] {
    context.strokeEllipse(in: CGRect(x: center.x - radius * squash, y: center.y - radius, width: radius * 2 * squash, height: radius * 2))
}
context.setStrokeColor(color(1, 0.9, 0.7, 0.55))
context.strokeEllipse(in: CGRect(x: center.x - radius, y: center.y - radius * 0.1, width: radius * 2, height: radius * 0.2))

// Glass shading and highlight.
context.drawRadialGradient(CGGradient(colorsSpace: space, colors: [color(0, 0, 0, 0), color(0, 0, 0, 0.45)] as CFArray, locations: [0.6, 1])!,
                           startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
context.drawRadialGradient(CGGradient(colorsSpace: space, colors: [color(1, 1, 1, 0.55), color(1, 1, 1, 0)] as CFArray, locations: [0, 1])!,
                           startCenter: CGPoint(x: 420, y: 680), startRadius: 0, endCenter: CGPoint(x: 420, y: 680), endRadius: 170, options: [])
context.restoreGState()
context.addPath(sphere)
context.setStrokeColor(color(1, 1, 1, 0.35))
context.setLineWidth(4)
context.strokePath()
context.restoreGState()

image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "assets/icon.png"))
